import type { LoggerLike } from './store.js';
export interface RebuildLogEntry {
    ts: string;
    round: number;
    userKey: string | null;
    isolation: string;
    query: string;
    hitCount: number;
    memoryIds: string[];
    fragments: string[];
    rebuilt: string;
    rebuiltChars: number;
    injection: 'replaced' | 'appended' | 'none';
    latencyMs: number;
    error?: string;
}
interface Stats {
    rounds: number;
    hits: number;
    rebuilt: number;
    injected: number;
    replaced: number;
    errors: number;
    lastRoundAt: string;
}
export declare class RebuildLogger {
    private readonly logDir;
    private readonly enabled;
    private readonly includeFragments;
    private readonly logger;
    private roundNo;
    private stats;
    private lastStatsWrite;
    private readonly statsIntervalMs;
    constructor(opts: {
        logDir: string;
        enabled: boolean;
        includeFragments: boolean;
        logger: LoggerLike;
    });
    /** 当前轮日志文件名(按天滚动)。 */
    private todayFile;
    /**
     * 记录一轮。
     * @param partial 必填字段之外的内容;fragments 仅 includeFragments 时保留
     */
    log(partial: {
        userKey: string | null;
        isolation: string;
        query: string;
        hitCount: number;
        memoryIds: string[];
        rebuilt: string;
        injection: 'replaced' | 'appended' | 'none';
        latencyMs: number;
        error?: string;
        fragments?: string[];
    }): void;
    /** 原子写 stats.json(节流外也可主动调用)。 */
    flushStats(): void;
    /** 当前累计统计(读给宿主用)。 */
    snapshot(): Stats;
}
/** 给 verify 用的纯函数:从日志条目提取碎片对比段(原文 vs 重建)。 */
export declare function fragmentSample(entry: RebuildLogEntry): {
    original: string[];
    rebuilt: string;
};
export {};
