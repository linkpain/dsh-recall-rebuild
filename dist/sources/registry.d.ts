import type { LoggerLike, MemoryStore } from '../store.js';
/** 打开源时已知的上下文。 */
export interface SourceContext {
    /** prime-memory 数据目录(配置项 dataDir;空 = $DSH_HOME/memory)。 */
    dataDir: string;
    /** 当前工作区(决定工作区级记忆去哪找)。 */
    cwd: string;
    logger: LoggerLike;
}
/** 一个可识别的记忆源。 */
export interface SourceSpec {
    /** 稳定 id(写进配置 source 字段)。 */
    id: string;
    /** 人读名字(日志/诊断输出)。 */
    label: string;
    /** 存储形态,便于文档归类。 */
    kind: 'sqlite' | 'markdown' | 'json' | 'jsonl';
    /** 打开该源。 */
    open(ctx: SourceContext): MemoryStore;
    /** 该源在这台机器上是否存在(用于 auto 探测)。 */
    probe(ctx: SourceContext): boolean;
}
/** 全量源清单。顺序 = auto 探测的优先级(数据越「正式」越靠前)。 */
export declare const SOURCES: SourceSpec[];
/** 全部可写进配置的源 id(含 auto)。 */
export declare const SOURCE_IDS: readonly ["auto", ...string[]];
export type SourceId = (typeof SOURCE_IDS)[number];
/** 按 id 找源(找不到返回 undefined)。 */
export declare function findSource(id: string): SourceSpec | undefined;
/** 探测这台机器上「装了且有数据」的源,按注册顺序返回。 */
export declare function detectSources(ctx: SourceContext): SourceSpec[];
/**
 * 按配置打开记忆源。
 *
 * - 显式指定 id:只打开它,失败即失败(便于用户排查);
 * - 'auto':按注册顺序探测,取第一个真正读到条目的源;
 *   全部落空时给出「检测到了什么」的诊断,而不是一句「没有记忆库」。
 */
export declare function openSource(id: string, ctx: SourceContext): MemoryStore;
/** 诊断信息:每种源是否存在、能否打开(供 /recall-status 之类命令展示)。 */
export declare function describeSources(ctx: SourceContext): Array<{
    id: string;
    label: string;
    present: boolean;
}>;
/** node:sqlite 是否可用(诊断用)。 */
export declare function sqliteAvailable(): boolean;
