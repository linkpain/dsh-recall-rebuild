/**
 * 重建式回忆引擎:把检索到的记忆碎片交给 LLM「生成式重建」为
 * 带语境/情绪/时间感的回忆片段,替代原文或摘要注入。
 *
 * 与"蒸馏"的区别:这里不做压缩、不做归纳入库,只做"回忆"——
 * 每轮按当前对话现场重建一段叙述,输出即用即弃,不写回任何存储。
 */
import type { Context } from '@deepseek-ai/cordis';
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
/** 从宿主解析默认模型路由(agentDefaultModel 是可选服务,缺失时返回 undefined)。 */
export declare function resolveModelRoute(ctx: Context): ModelRoute | undefined;
/**
 * 执行一次重建式回忆。任何失败(无路由/超时/流中断/空输出)返回 undefined,
 * 由调用方安全跳过本轮——重建是增强,绝不能阻塞对话。
 */
export declare function rebuildMemory(ctx: Context, memories: MemoryRecord[], query: string, opts: RebuildOptions, signal: AbortSignal | undefined, logger: LoggerLike): Promise<RebuildResult | undefined>;
