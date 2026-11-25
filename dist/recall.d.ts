/**
 * agent/pre-step 注入控制:在每次模型推理前,
 * 1) 用会话末尾消息构建召回查询;
 * 2) 只读检索记忆库;
 * 3) LLM 重建为回忆片段;
 * 4) 以 user 消息形式注入,且**只追加在消息批次末尾**。
 *
 * 为什么必须是「末尾追加」而不是「头部插入」:
 * 提示词缓存按**逐字节前缀**命中。本 step 的批次(claimed + runtime-context)会被宿主原样
 * 追加进会话历史,于是下一次请求的前缀 = 上一次请求的 messages + 本次新消息。注入若插在
 * 头部(旧实现 `[injection, ...decision.messages]`),两个 step 的公共前缀长度直接归零,
 * 整段历史缓存每轮全废;插在中间(旧 replace 就地改写)则从改写点起截断前缀,代价同样巨大。
 * 追加到末尾时只有最后一条在变,前面所有历史逐字节不变 —— 这是唯一对缓存友好的位置。
 * 追加进去的注入本身会进入历史;下一轮注入的请求前缀仍以上一轮(含旧注入)开头,照样命中,
 * 只是回收不了「自己上一次注入」那一小段(约 1KB),属于可接受的固定成本。
 *
 * 与 dsh-prime-memory 的错开策略:
 * - source.kind 用 v4 语义 'plugin:recall-rebuild'(vs prime 的 'plugin:memory');
 * - strategy=replace:仅当本 step 批次里已存在**本插件自己**的注入(同 step 重试)时原位替换,
 *   位置不变、长度通常不变,前缀几乎无损;
 * - strategy=append:无条件追加新的一条。
 * 旧实现会去「原位替换其它插件的召回」,那等于改写历史中部的字节,是缓存杀手,已废弃。
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
/** 判断一条消息是否本插件自己注入过的召回(source.kind 由 buildInjectionMessage 产出)。 */
export declare function isOurInjection(m: MsgLike): boolean;
/**
 * 把注入消息追加到批次末尾 —— 唯一对提示词缓存友好的位置(理由见文件头注释)。
 * 绝不插头部、绝不改写历史中部:那会让逐字节前缀在注入点断开,整段历史缓存全废。
 */
export declare function appendInjection(messages: MsgLike[], injection: MsgLike): MsgLike[];
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
