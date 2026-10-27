/**
 * 睡眠巩固引擎:把累积的待巩固碎片「聚类 → LLM 抽象 → 联想扩散 → 遗忘降权」。
 *
 * 触发与调度(index.ts 注册):
 * - 定时检查(checkIntervalMs)+ pending 达标(minFragments)且距上次巩固超过
 *   minIntervalMs 时才真正执行;
 * - 纯异步、绝不阻塞对话:失败(无模型路由/超时/解析失败)保留 pending 下次再试。
 *
 * 产出只写自己的巩固层目录(consolidated/),底层记忆库保持只读。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ConsolidateOptions } from './config.js';
import type { LoggerLike, MemoryStore } from './store.js';
import {
  clusterize,
  isDormant,
  parseConsolidationOutput,
  type ConsolidatedStore,
  type ConsolidatedType,
} from './consolidated.js';
import { resolveModelRoute } from './rebuild.js';

const CONSOLIDATE_SYSTEM = `你是长期记忆巩固器,服务于一位用户的日常对话助手。

现在给你一批「同一主题」的真实记忆碎片(来自该用户多轮对话的检索命中)。
请把它们整合为稳定的长期记忆条目:提取跨时间的稳定事实、偏好、规律与关系,
忽略一次性噪音(具体某天的琐事、临时情绪波动)。

硬性要求:
1. 只使用碎片中确实出现的信息;严禁编造碎片中没有的事实、日期、人物或偏好。
2. 每条内容用一句稳定、自然的中文陈述,不要列点、不要解释。
3. type 取值:stable-fact(稳定事实)/ pattern(行为规律)/ preference(偏好)/
   relationship(人物关系)/ mood(情绪基调)。
4. 最多输出 3 条。
5. 只输出一个 JSON 对象,格式:{"memories":[{"type":"preference","content":"..."}]}
   不要输出任何其他文字。`;

/** 簇内全部碎片归属同一用户 → 条目归属该用户;混合/无主 → null(共享/桌面)。 */
function unifyUserKey(frags: { userKey: string | null }[]): string | null {
  const keys = new Set(frags.map((f) => f.userKey).filter((k): k is string => !!k));
  return keys.size === 1 ? (Array.from(keys)[0] ?? null) : null;
}

/** 置信度:来源碎片越多越稳(0.5 起,每多 1 条 +0.1,封顶 0.9)。 */
function calcConfidence(fragmentCount: number): number {
  return Math.min(0.9, 0.5 + fragmentCount * 0.1);
}

async function consolidateText(
  ctx: Context,
  route: { provider: string; model: string },
  frags: string[],
  opts: ConsolidateOptions,
): Promise<string> {
  const stream = (ctx as unknown as { llm: { stream(o: Record<string, unknown>): unknown } }).llm.stream({
    provider: route.provider,
    model: route.model,
    system: CONSOLIDATE_SYSTEM,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: frags.map((f, i) => `${i + 1}. ${f}`).join('\n') }],
        source: { kind: 'user' },
      }),
    ],
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  });
  let text = '';
  for await (const chunk of stream as AsyncIterable<{ type?: string; text?: unknown }>) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    }
  }
  return text;
}

/**
 * 执行一次巩固。返回是否产生了新的巩固条目。
 * 任何失败都不抛错:无路由/超时/解析失败 → 保留 pending,由调用方继续调度。
 */
export async function runConsolidation(
  ctx: Context,
  _store: MemoryStore,
  consolidated: ConsolidatedStore,
  opts: ConsolidateOptions,
  logger: LoggerLike,
): Promise<boolean> {
  if (!opts.enabled) return false;
  const now = Date.now();
  const pending = consolidated.pending();
  if (pending.length === 0) return false;
  const route = resolveModelRoute(ctx);
  if (!route) {
    logger.debug?.('[recall-rebuild] 巩固:未解析到默认模型路由,保留 pending 下次再试');
    return false;
  }
  const items = pending.slice(-opts.maxFragmentsPerRun);
  const clusters = clusterize(
    items.map((p) => ({ id: p.id, content: p.content })),
    opts.clusterThreshold,
    opts.maxCluster,
  );
  let produced = false;
  const producedIds: string[] = [];
  for (const ids of clusters) {
    const frags = items.filter((p) => ids.includes(p.id));
    if (frags.length === 0) continue;
    let text: string;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
      try {
        text = await consolidateText(ctx, route, frags.map((f) => f.content), opts);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      logger.warn(
        `[recall-rebuild] 巩固:单簇抽象失败(跳过该簇): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseConsolidationOutput(text ?? '');
    if (parsed.length === 0) continue;
    const userKey = unifyUserKey(frags);
    const sourceIds = frags.map((f) => f.id);
    for (const p of parsed) {
      const id = `c_${now}_${Math.random().toString(36).slice(2, 8)}`;
      consolidated.upsert({
        id,
        userKey,
        type: p.type as ConsolidatedType,
        content: p.content,
        sourceIds,
        confidence: calcConfidence(frags.length),
        status: 'active',
        createdAt: now,
        updatedAt: now,
        touchCount: 0,
      });
      producedIds.push(id);
      produced = true;
    }
  }
  // 联想扩散:本轮产出的条目两两建立「同轮巩固」关联边(后续召回可顺带想起)
  for (let i = 0; i < producedIds.length; i++) {
    for (let j = i + 1; j < producedIds.length; j++) {
      const a = producedIds[i];
      const b = producedIds[j];
      if (!a || !b) continue;
      consolidated.addLink(a, b, '同轮巩固');
    }
  }
  // 遗忘扫描:低置信 + 长期未命中 → dormant(召回降权,不删除)
  const forgetOpts = { confidenceThreshold: opts.confidenceThreshold, dormantDays: opts.dormantDays };
  let decayed = 0;
  for (const m of consolidated.list()) {
    if (isDormant(m, now, forgetOpts)) {
      m.status = 'dormant';
      m.updatedAt = now;
      decayed += 1;
    }
  }
  consolidated.clearPending();
  consolidated.markRun(now);
  consolidated.saveAll();
  logger.info(
    `[recall-rebuild] 睡眠巩固完成: 簇 ${clusters.length}, 产出 ${producedIds.length} 条, 遗忘 ${decayed} 条`,
  );
  return produced;
}
