/**
 * agent/pre-step 注入控制:在每次模型推理前,
 * 1) 用会话末尾消息构建召回查询;
 * 2) 只读检索记忆库;
 * 3) LLM 重建为回忆片段;
 * 4) 以 user 消息形式注入(prime-memory 同款范式:prepend + kind:'enter')。
 *
 * 与 dsh-prime-memory 的错开策略:
 * - source.kind 用 v4 语义 'plugin:recall-rebuild'(vs prime 的 'plugin:memory');
 * - strategy=replace 时,若本轮消息里已存在其它插件的原文召回(source.kind==='plugin:memory'
 *   && form==='recall',或旧版 kind==='plugin' && plugin==='memory'),
 *   用本插件的重建片段原位替换它,避免重复注入;
 * - strategy=append 时,保留对方的原文召回,追加本插件的重建片段。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { RecallRebuildConfig } from './config.js';
import { rebuildMemory } from './rebuild.js';
import type { LoggerLike, MemoryRecord, MemoryStore } from './store.js';
import { extractUserKey, type NamespaceStore } from './namespace.js';
import type { RebuildLogger } from './observability.js';
import type { ConsolidatedStore } from './consolidated.js';

interface MsgLike {
  source?: { kind?: string; plugin?: string; form?: string };
  content?: unknown;
}

interface PreStepDecision {
  kind: string;
  messages: MsgLike[];
}

interface PreStepPayload {
  agent?: { id?: string };
  messages?: MsgLike[];
  signal?: AbortSignal;
}

/** 消息文本提取(text 块拼接),用于召回查询。 */
function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    const blk = b as { type?: string; text?: unknown } | null;
    if (blk && blk.type === 'text' && typeof blk.text === 'string') {
      if (out) out += ' ';
      out += blk.text;
    }
  }
  return out;
}

/** 判断一条消息是否为其它插件(prime-memory 等)注入的原文召回。 */
export function isOtherPluginRecall(m: MsgLike): boolean {
  const s = m.source;
  if (!s) return false;
  if (s.kind === 'plugin:memory' && s.form === 'recall') return true;
  if (s.kind === 'plugin' && s.plugin === 'memory') return true;
  return false;
}

/** 用会话末尾消息构建召回查询(去重、截断预算)。 */
function buildRecallQuery(messages: MsgLike[] | undefined, cfg: RecallRebuildConfig): string {
  if (!Array.isArray(messages)) return '';
  const tail = messages.slice(-cfg.query.tailMessages);
  const texts: string[] = [];
  let total = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = blocksToText(tail[i]).trim();
    if (!t) continue;
    const take = t.slice(0, 500);
    if (total + take.length > cfg.query.maxChars) {
      const remain = cfg.query.maxChars - total;
      if (remain > 40) texts.unshift(take.slice(0, remain));
      break;
    }
    texts.unshift(take);
    total += take.length;
  }
  return texts.join(' ').trim();
}

/** 构造重建片段注入消息(source.kind 用 v4 语义,避免被当作"用户消息"捕获/再次蒸馏)。 */
function buildInjectionMessage(
  text: string,
  sourceIds: string[],
  cfg: RecallRebuildConfig,
): MsgLike {
  let body = `<reconstructed-memory>\n${text.slice(0, cfg.inject.maxChars)}\n</reconstructed-memory>`;
  if (cfg.inject.includeSources && sourceIds.length > 0) {
    body += `\n(记忆依据: ${sourceIds.slice(0, 8).join(', ')})`;
  }
  // createUserMessage 的 source.kind 类型是宿主枚举,但运行时接受插件语义
  // (v4:'plugin:<子系统名>'),与 prime-memory 的 'plugin:memory' 同款做法。
  const source = { kind: 'plugin:recall-rebuild', form: 'recall' } as never;
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source,
  }) as unknown as MsgLike;
}

/**
 * 睡眠巩固层召回:把 active 巩固条目并入检索结果(高置信稳定记忆),
 * 命中条目 → touch(越用越稳)+ 联想扩散(附加强关联主题片段)。
 * 受用户隔离约束:userKey 为空(null)的条目共享可见;strict 模式只收当前用户。
 */
function mergeConsolidated(
  memories: MemoryRecord[],
  consolidated: ConsolidatedStore,
  userKey: string | null,
  cfg: RecallRebuildConfig,
  logger: LoggerLike,
): MemoryRecord[] {
  try {
    const now = Date.now();
    const forgetOpts = {
      confidenceThreshold: cfg.consolidate.confidenceThreshold,
      dormantDays: cfg.consolidate.dormantDays,
    };
    const extra: MemoryRecord[] = [];
    for (const m of consolidated.list()) {
      if (m.status !== 'active') continue;
      if (m.userKey !== null && m.userKey !== userKey) continue; // 归属他人(当前用户存在时)
      if (cfg.user.isolation === 'strict' && m.userKey === null && userKey !== null) continue;
      consolidated.touch(m.id, now, forgetOpts);
      extra.push({
        id: m.id,
        content: m.content,
        type: m.type,
        sceneName: '巩固记忆',
        family: '',
        priority: 10, // 高置信稳定记忆优先于细节碎片
        timestampStr: new Date(m.updatedAt).toISOString().slice(0, 10),
      });
      // 联想扩散:强关联(weight ≥ 2)的其他主题最多带 2 条
      const linked = consolidated.strongLinks(m.id, 2, 2);
      for (const l of linked) {
        const lm = consolidated.get(l.id);
        if (!lm || lm.status !== 'active') continue;
        extra.push({
          id: lm.id,
          content: lm.content,
          type: lm.type,
          sceneName: `联想:${l.weight}`,
          family: '',
          priority: 6,
          timestampStr: new Date(lm.updatedAt).toISOString().slice(0, 10),
        });
      }
    }
    // 高置信优先:排序后取合并预算(底层碎片 + 巩固层 ≤ maxResults * 2)
    return [...memories, ...extra]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, cfg.rebuild.maxResults * 2);
  } catch (err) {
    logger.warn(
      `[recall-rebuild] 巩固层召回失败(仅用底层碎片): ${err instanceof Error ? err.message : String(err)}`,
    );
    return memories;
  }
}

export function registerRecallRebuild(
  ctx: Context,
  store: MemoryStore,
  cfg: RecallRebuildConfig,
  logger: LoggerLike,
  namespaces?: NamespaceStore,
  obsLog?: RebuildLogger,
  consolidated?: ConsolidatedStore,
): void {
  if (!cfg.enabled) return;
  // cordis 的事件键是插件可扩展的字符串;此处收窄为所需的最小监听器形状
  interface PreStepEmitter {
    on(
      event: string,
      listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => unknown,
      opts?: { prepend?: boolean },
    ): unknown;
  }
  const emitter = ctx as unknown as PreStepEmitter;
  emitter.on(
    'agent/pre-step',
    async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
      const decision = await next();
      if (decision.kind === 'reject' || payload.signal?.aborted) return decision;
      if (!store.ok || !cfg.rebuild.enabled) return decision;
      // 只在"这一轮真的有新用户消息"时才注入(与 prime-memory 同款闸门)
      const hasNewUser = decision.messages.some((m) => m.source?.kind === 'user');
      if (!hasNewUser) return decision;
      try {
        const startedAt = Date.now();
        const query = buildRecallQuery(payload.messages, cfg);
        if (!query) return decision;
        // 提取当前 IM 用户键(桌面/无法识别 → null → 不做隔离)
        const userKey = namespaces
          ? extractUserKey(decision.messages.map(blocksToText), cfg.user.sourceTagPattern)
          : null;
        let memories = store.search(query, cfg.rebuild.maxResults);
        const logBase = () => ({
          userKey,
          isolation: cfg.user.isolation,
          query,
          hitCount: memories.length,
          memoryIds: memories.map((m) => m.id),
          fragments: memories.map((m) => m.content),
          rebuilt: '',
          injection: 'none' as const,
          latencyMs: Date.now() - startedAt,
        });
        // 睡眠巩固层:累积本轮命中碎片(供离线巩固)
        if (consolidated) {
          consolidated.addPending(
            memories.map((m) => ({ id: m.id, content: m.content, userKey })),
            cfg.consolidate.maxFragmentsPerRun,
          );
        }
        if (memories.length === 0) {
          if (obsLog) obsLog.log({ ...logBase() });
          return decision;
        }
        // 用户级命名空间隔离:过滤"明确属于其他用户"的记忆
        if (namespaces) {
          memories = namespaces.filter(memories, userKey, cfg.user.isolation);
          if (memories.length === 0) {
            if (obsLog) obsLog.log({ ...logBase(), error: '隔离过滤后无可用记忆' });
            return decision;
          }
          // 只把"本轮实际保留"的候选记为当前用户归属(无主记忆随命中归位)
          namespaces.recordHits(userKey, memories);
        }
        // 睡眠巩固层召回:高置信稳定记忆优先,联想扩散附加强关联主题
        if (consolidated) {
          memories = mergeConsolidated(memories, consolidated, userKey, cfg, logger);
        }
        const rebuilt = await rebuildMemory(ctx, memories, query, cfg.rebuild, payload.signal, logger);
        if (!rebuilt || !rebuilt.text) {
          if (obsLog) obsLog.log({ ...logBase(), error: '重建返回空,跳过注入' });
          return decision;
        }
        const injection = buildInjectionMessage(rebuilt.text, rebuilt.sourceIds, cfg);
        let injectionKind: 'replaced' | 'appended' | 'none' = 'appended';
        if (cfg.inject.strategy === 'replace') {
          const idx = decision.messages.findIndex(isOtherPluginRecall);
          if (idx >= 0) {
            const msgs = [...decision.messages];
            msgs[idx] = injection;
            injectionKind = 'replaced';
            if (obsLog) obsLog.log({ ...logBase(), rebuilt: rebuilt.text, injection: injectionKind, latencyMs: Date.now() - startedAt });
            return { kind: 'enter', messages: msgs };
          }
        }
        if (obsLog) obsLog.log({ ...logBase(), rebuilt: rebuilt.text, injection: injectionKind, latencyMs: Date.now() - startedAt });
        return { kind: 'enter', messages: [injection, ...decision.messages] };
      } catch (err) {
        logger.warn(
          `[recall-rebuild] 本轮重建注入失败(跳过): ${err instanceof Error ? err.message : String(err)}`,
        );
        return decision;
      }
    },
    { prepend: true },
  );
}
