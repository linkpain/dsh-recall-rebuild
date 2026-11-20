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
import type { ConsolidateOptions } from './config.js';
import type { LoggerLike, MemoryStore } from './store.js';
import { type ConsolidatedStore } from './consolidated.js';
/** 一次巩固的执行结果(供调度与命令输出)。 */
export interface ConsolidationResult {
    /** 是否产生了新的巩固条目。 */
    produced: boolean;
    /** 本次处理的簇数。 */
    clusters: number;
    /** 产出的新条目数。 */
    entries: number;
    /** 进入 dormant 的条目数。 */
    decayed: number;
    /** 处理前的 pending 碎片数。 */
    pending: number;
}
/**
 * 执行一次巩固。返回执行结果;任何失败都不抛错:
 * 无路由/超时/解析失败 → 保留 pending,由调用方继续调度。
 */
export declare function runConsolidation(ctx: Context, _store: MemoryStore, consolidated: ConsolidatedStore, opts: ConsolidateOptions, logger: LoggerLike): Promise<ConsolidationResult>;
