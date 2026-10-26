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
import type { LoggerLike, MemoryStore } from './store.js';
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
export declare function registerRecallRebuild(ctx: Context, store: MemoryStore, cfg: RecallRebuildConfig, logger: LoggerLike): void;
export {};
