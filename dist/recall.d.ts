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
import type { RecallRebuildConfig } from './config.js';
import type { LoggerLike, MemoryRecord, MemoryStore } from './store.js';
import { type NamespaceStore } from './namespace.js';
import type { RebuildLogger } from './observability.js';
import { type ConsolidatedStore } from './consolidated.js';
/**
 * 联想扩散的生产参数(单一事实源:recall 注入与 verify 断言共用,避免两处漂移)。
 *
 * hop1Min/hop2Min 取 0.5 而非 1:生产链路(consolidate.ts:216)只在「本轮新产出」的条目间连边,
 * 而条目 id 每次巩固都新生成,同一对 id 不会出现第二次 —— 边权因此恒为 1、累加分支永不执行。
 * 门槛若取 >=1,就只有写入那一瞬间能过,衰减一开始就归零,扩散实际从不触发。
 * 取 0.5 让 weight=1 的边在半个半衰期(30 天)内可见、60 天后自然淡出,与 LINK_HALF_LIFE_DAYS 对齐。
 */
export declare const DIFFUSE_OPTS: {
    readonly hop1Min: 0.5;
    readonly hop2Min: 0.5;
    readonly minScore: 1;
    readonly maxHop1: 2;
    readonly maxHop2: 1;
};
interface MsgLike {
    source?: {
        kind?: string;
        plugin?: string;
        form?: string;
    };
    content?: unknown;
}
/** 判断一条消息是否为其它插件(prime-memory 等)注入的原文召回。 */
export declare function isOtherPluginRecall(m: MsgLike): boolean;
/** 去重窗口:超过这个时长的注入记录视为过期(记忆本身没变,但场景大概率变了)。 */
export declare const DEDUPE_TTL_MS: number;
/** 清空去重状态(仅测试用)。 */
export declare function resetRecentInjection(): void;
/** 记录本轮真正注入的记忆 id。 */
export declare function rememberInjected(agentKey: string, ids: string[], now: number): void;
/**
 * 把「窗口内已注入过」的候选降到末尾(稳定排序,其余相对顺序不变)。
 * 不删除:若本轮只有这些候选,仍然要注入,只是不再抢占头部位置。
 */
export declare function demoteRecentlyInjected(memories: MemoryRecord[], agentKey: string, now: number): MemoryRecord[];
export declare function registerRecallRebuild(ctx: Context, store: MemoryStore, cfg: RecallRebuildConfig, logger: LoggerLike, namespaces?: NamespaceStore, obsLog?: RebuildLogger, consolidated?: ConsolidatedStore): void;
export {};
