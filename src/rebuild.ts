/**
 * 重建式回忆引擎:把检索到的记忆碎片交给 LLM「生成式重建」为
 * 带语境/情绪/时间感的回忆片段,替代原文或摘要注入。
 *
 * 与"蒸馏"的区别:这里不做压缩、不做归纳入库,只做"回忆"——
 * 每轮按当前对话现场重建一段叙述,输出即用即弃,不写回任何存储。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { RebuildOptions } from './config.js';
import type { LoggerLike, MemoryRecord } from './store.js';

export interface RebuildResult {
  /** 重建后的回忆片段正文。 */
  text: string;
  /** 依据的记忆来源 id(用于注入标注)。 */
  sourceIds: string[];
}

export interface ModelRoute {
  provider: string;
  model: string;
}

const REBUILD_SYSTEM = `你是长期记忆重建器,服务于一位用户的日常对话助手。

现在,当前对话触发了对过往记忆的回忆,下面给出一批从记忆库检索到的真实记忆碎片。
请把它们「重建」成一段自然连贯、带语境与情绪的回忆片段——就像当事人真的回忆起这段经历。

硬性要求:
1. 只使用碎片中确实存在的信息;严禁编造碎片中没有的事实、日期、人物、地点或情绪。
2. 保留时间感、场景感、人物关系与情绪基调;若碎片不含情绪,不要硬加。
3. 用自然口语陈述,像一段回忆,不要列条目、不要用"记忆碎片""检索结果""根据记录"等字眼。
4. 只输出回忆片段正文本身,不要解释、不要总结、不要开场白。`;

/** 从宿主解析默认模型路由(agentDefaultModel 是可选服务,缺失时返回 undefined)。 */
export function resolveModelRoute(ctx: Context): ModelRoute | undefined {
  try {
    const service = (ctx as unknown as { get?: (k: string) => unknown }).get?.('agentDefaultModel');
    const sel = (service as { currentSelection?: () => unknown } | undefined)?.currentSelection?.() as
      | { provider?: string; model?: string }
      | undefined;
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
  } catch {
    /* 忽略:无默认模型路由时本插件跳过重建 */
  }
  return undefined;
}

/** 组装碎片文本(遵守单条/总量字符预算,超预算截断)。 */
function buildFragments(memories: MemoryRecord[], opts: RebuildOptions): string[] {
  const frags: string[] = [];
  let total = 0;
  for (const m of memories) {
    const scene = m.sceneName ? `(${m.sceneName})` : '';
    const line = `- [${m.type || '记忆'}]${scene} ${m.content}`;
    const take = line.slice(0, opts.maxMemoryChars);
    if (total + take.length > opts.maxTotalChars) {
      const remain = opts.maxTotalChars - total;
      if (remain > 40) frags.push(take.slice(0, remain));
      break;
    }
    frags.push(take);
    total += take.length;
  }
  return frags;
}

async function streamText(
  ctx: Context,
  route: ModelRoute,
  system: string,
  user: string,
  opts: RebuildOptions,
  signal: AbortSignal,
): Promise<string> {
  const stream = (ctx as unknown as { llm: { stream(o: Record<string, unknown>): unknown } }).llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: user }],
        source: { kind: 'user' },
      }),
    ],
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    signal,
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
 * 执行一次重建式回忆。任何失败(无路由/超时/流中断/空输出)返回 undefined,
 * 由调用方安全跳过本轮——重建是增强,绝不能阻塞对话。
 */
export async function rebuildMemory(
  ctx: Context,
  memories: MemoryRecord[],
  query: string,
  opts: RebuildOptions,
  signal: AbortSignal | undefined,
  logger: LoggerLike,
): Promise<RebuildResult | undefined> {
  if (!opts.enabled || memories.length === 0) return undefined;
  const route = resolveModelRoute(ctx);
  if (!route) {
    logger.debug?.('[recall-rebuild] 未解析到默认模型路由,本轮跳过重建');
    return undefined;
  }
  const frags = buildFragments(memories, opts);
  if (frags.length === 0) return undefined;
  const user = `当前对话主题:\n${query}\n\n检索到的记忆碎片:\n${frags.join('\n')}`;

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const text = await streamText(ctx, route, REBUILD_SYSTEM, user, opts, ac.signal);
    const trimmed = (text ?? '').trim().slice(0, opts.maxOutputChars);
    if (!trimmed) return undefined;
    return { text: trimmed, sourceIds: memories.map((m) => m.id) };
  } catch (err) {
    logger.warn(`[recall-rebuild] 重建调用失败(跳过本轮): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
