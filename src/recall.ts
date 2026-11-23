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
import { decayFactor } from './store.js';
import type { LoggerLike, MemoryRecord, MemoryStore } from './store.js';
import { extractUserKey, type NamespaceStore } from './namespace.js';
import type { RebuildLogger } from './observability.js';
import { decideInjection, type ConsolidatedStore } from './consolidated.js';

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

/* ── 跨轮去重(退化实现) ───────────────────────────────────
 * 理想做法是「同一会话内,上一轮注入过的记忆片段下一轮不再重复注入」。
 * 但 agent/pre-step 的 payload 里没有 sessionId(只有 agent.id),拿不到会话边界。
 * 于是退化为「同一 agent.id 内、TTL 窗口内注入过的记忆降权」:
 * 不丢弃(它可能仍是本轮最相关的),只是让位给新候选 —— 重复注入的本质伤害是
 * 每轮都刷同一段回忆,把上下文预算烧在已经说过的话上。 */

/** 去重窗口:超过这个时长的注入记录视为过期(记忆本身没变,但场景大概率变了)。 */
export const DEDUPE_TTL_MS = 30 * 60_000;

/** agent.id → (记忆 id → 注入时间)。无 sessionId 可用时的最小作用域。 */
const recentInjected = new Map<string, Map<string, number>>();

/** 清空去重状态(仅测试用)。 */
export function resetRecentInjection(): void {
  recentInjected.clear();
}

/** 记录本轮真正注入的记忆 id。 */
export function rememberInjected(agentKey: string, ids: string[], now: number): void {
  if (!agentKey || ids.length === 0) return;
  let bucket = recentInjected.get(agentKey);
  if (!bucket) {
    bucket = new Map<string, number>();
    recentInjected.set(agentKey, bucket);
  }
  for (const id of ids) if (id) bucket.set(id, now);
  // 顺手清理过期项,避免长时间运行后无界增长
  for (const [id, at] of bucket) if (now - at > DEDUPE_TTL_MS) bucket.delete(id);
  if (bucket.size === 0) recentInjected.delete(agentKey);
}

/**
 * 把「窗口内已注入过」的候选降到末尾(稳定排序,其余相对顺序不变)。
 * 不删除:若本轮只有这些候选,仍然要注入,只是不再抢占头部位置。
 */
export function demoteRecentlyInjected(
  memories: MemoryRecord[],
  agentKey: string,
  now: number,
): MemoryRecord[] {
  const bucket = agentKey ? recentInjected.get(agentKey) : undefined;
  if (!bucket || bucket.size === 0) return memories;
  const fresh: MemoryRecord[] = [];
  const stale: MemoryRecord[] = [];
  for (const m of memories) {
    const at = bucket.get(m.id);
    (at !== undefined && now - at <= DEDUPE_TTL_MS ? stale : fresh).push(m);
  }
  return stale.length === 0 ? memories : [...fresh, ...stale];
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
    // 本轮命中的巩固条目 id:收集起来一次性落盘(见 ConsolidatedStore.touchMany)
    const touched: string[] = [];
    // 休眠条目的复活线索:与当前召回碎片足够相似 = 它「又被提起了」。
    // 缺了这一步,dormant 就是单向的 —— 召回侧只遍历 active,休眠条目永远拿不到
    // touch,也就永远醒不过来。相似度用零依赖的字符 2-gram Jaccard,与聚类同源。
    const evidence = memories.map((m) => m.content).filter(Boolean);
    // 休眠条目本轮最多附带注入几条:本轮已有真实召回结果,再塞一堆
    // "话题沾边"的旧条目只会稀释重建质量。唤醒本身不受这个上限限制。
    const REVIVE_MAX_INJECT = 2;
    const revivedIds: string[] = [];
    for (const m of consolidated.list()) {
      if (m.userKey !== null && m.userKey !== userKey) continue; // 归属他人(当前用户存在时)
      if (cfg.user.isolation === 'strict' && m.userKey === null && userKey !== null) continue;
      // 状态判定集中在 decideInjection:superseded 永不注入也永不唤醒,
      // dormant 要靠「又被提起」的证据复活,active 直接进。
      const decision = decideInjection(
        m,
        evidence,
        { reviveSimilarity: cfg.consolidate.reviveSimilarity, maxInject: REVIVE_MAX_INJECT },
        revivedIds.length,
      );
      if (decision.reason === 'superseded' || decision.reason === 'dormant') continue;
      if (decision.revived) revivedIds.push(m.id);
      // touch 只对「本轮真的被用上」的条目:它会抬 confidence 并刷新 lastRecalledAt,
      // 对沉睡条目就等于唤醒 —— 所以绝不能无差别 touch 整份列表。
      touched.push(m.id);
      if (!decision.inject) continue;
      extra.push({
        id: m.id,
        content: m.content,
        type: m.type,
        sceneName: '巩固记忆',
        family: '',
        priority: 10, // 高置信稳定记忆优先于细节碎片
        timestampStr: new Date(m.updatedAt).toISOString().slice(0, 10),
      });
      // 联想扩散:一跳(强共现)最多 2 条,二跳(强链的强链)最多 1 条。
      // 边权带半衰期衰减,陈旧联想不会长期霸占扩散名额。
      const linked = consolidated.diffuse(
        m.id,
        { hop1Min: 2, hop2Min: 2, minScore: 1, maxHop1: 2, maxHop2: 1 },
        now,
      );
      for (const l of linked) {
        const lm = consolidated.get(l.id);
        // 联想只带 active:被取代的旧事实不能借「联想」还魂
        if (!lm || lm.status !== 'active') continue;
        extra.push({
          id: lm.id,
          content: lm.content,
          type: lm.type,
          sceneName: l.hop === 1 ? `联想:${l.score.toFixed(1)}` : `二跳联想:${l.score.toFixed(1)}`,
          family: '',
          priority: l.hop === 1 ? 6 : 4,
          timestampStr: new Date(lm.updatedAt).toISOString().slice(0, 10),
        });
      }
    }
    // 一次写入代替「每条一次全量 JSON 重写」
    if (touched.length > 0) consolidated.touchMany(touched, now, forgetOpts);
    if (revivedIds.length > 0) {
      logger.info(`[recall-rebuild] 唤醒休眠记忆 ${revivedIds.length} 条(本轮碎片与其高度相关)`);
    }
    // 排序分 = 基础优先级 × 时效衰减系数(老记忆最多损失一半分,永不沉底)
    const score = (m: MemoryRecord): number => m.priority * decayFactor(m.timestampStr, now);
    return [...memories, ...extra]
      .sort((a, b) => score(b) - score(a))
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
        // 睡眠巩固层:累积本轮**通过隔离后**命中的碎片(供离线巩固)。
        // 必须在隔离过滤之后:否则 A 用户命中的碎片会以 userKey=null 落进 pending,
        // 巩固成条目后对所有用户可见 —— 跨用户记忆污染。
        if (consolidated) {
          consolidated.addPending(
            memories.map((m) => ({ id: m.id, content: m.content, userKey })),
            cfg.consolidate.maxFragmentsPerRun,
          );
        }
        // 睡眠巩固层召回:高置信稳定记忆优先,联想扩散附加强关联主题
        if (consolidated) {
          memories = mergeConsolidated(memories, consolidated, userKey, cfg, logger);
        }
        // 跨轮去重:刚注入过的候选让位(不丢弃),避免每轮都刷同一段回忆
        const agentKey = payload.agent?.id ?? '';
        memories = demoteRecentlyInjected(memories, agentKey, Date.now());
        const rebuilt = await rebuildMemory(ctx, memories, query, cfg.rebuild, payload.signal, logger);
        if (!rebuilt || !rebuilt.text) {
          if (obsLog) obsLog.log({ ...logBase(), error: '重建返回空,跳过注入' });
          return decision;
        }
        const injection = buildInjectionMessage(rebuilt.text, rebuilt.sourceIds, cfg);
        // 记下本轮真正被重建进提示词的记忆,下一轮(同 agent)降权
        rememberInjected(agentKey, rebuilt.sourceIds, Date.now());
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
