import type { LoggerLike } from './store.js';
/** 巩固记忆条目。 */
export interface ConsolidatedMemory {
    id: string;
    /** 归属用户(参与 IM 命名空间隔离);null = 桌面/共享/无主。 */
    userKey: string | null;
    type: 'stable-fact' | 'pattern' | 'preference' | 'relationship' | 'mood';
    content: string;
    /** 蒸馏来源:底层记忆 id 列表。 */
    sourceIds: string[];
    /** 置信度 0-1:来源碎片数、一致性、命中频率共同决定。 */
    confidence: number;
    /** active = 参与召回;dormant = 被「遗忘」(召回降权),不删除、不写底层库。 */
    status: 'active' | 'dormant';
    createdAt: number;
    updatedAt: number;
    /** 被召回命中的次数(越用越稳)。 */
    touchCount: number;
    lastRecalledAt?: number;
}
export type ConsolidatedType = ConsolidatedMemory['type'];
/** 联想图:条目 id → 关联条目 id → {weight, label}。 */
export type LinkGraph = Record<string, Record<string, {
    weight: number;
    label: string;
}>>;
export interface ConsolidateMeta {
    lastRunAt: number;
    runCount: number;
}
export declare function tokenize(s: string): string[];
/** Jaccard 相似度。 */
export declare function similarity(a: string, b: string): number;
/**
 * 贪心聚类:按相似度阈值把碎片分组。
 * 返回下标分组数组,每个碎片最多进入一个簇。
 */
export declare function clusterize(items: {
    id: string;
    content: string;
}[], threshold: number, maxCluster: number): string[][];
/**
 * 遗忘判定:置信度过低 **且** 长期未命中 → dormant。
 *
 * 两个条件必须同时成立,顺序也就有讲究:
 * 1. 先看置信度 —— 高置信的稳定记忆永不遗忘(用户明确表达过的偏好不能说没就没);
 * 2. 再看活跃度 —— 最近 dormantDays 天内命中过就继续保留;
 * 3. 最后看使用强度 —— 命中过 PIN_TOUCH_COUNT 次以上的条目视为「用过」,不过期。
 *
 * 之前这套判定是死代码:consolidate.calcConfidence 的下限让 confidence 恒 ≥ 0.6,
 * 而默认 confidenceThreshold 是 0.4,第一条分支永远 return false,遗忘从未发生。
 * 修在源头(calcConfidence 允许落到阈值以下)而不是在这里放宽条件,这样
 * 「低置信」仍然真实反映「这条记忆只被单次观察支撑」。
 */
export declare function isDormant(m: ConsolidatedMemory, now: number, opts: {
    confidenceThreshold: number;
    dormantDays: number;
}): boolean;
/** 按快照读取的巩固层存储(内存态 + 原子落盘)。 */
export declare class ConsolidatedStore {
    private readonly dir;
    private readonly logger;
    private memories;
    private links;
    private meta;
    private readonly files;
    constructor(dir: string, logger: LoggerLike);
    ensureDir(): void;
    private readJson;
    private writeJson;
    /** 从磁盘加载(容错:文件缺失/损坏 → 空)。 */
    load(): void;
    saveAll(): void;
    list(): ConsolidatedMemory[];
    get(id: string): ConsolidatedMemory | undefined;
    /** 新增或合并条目(同 id 更新)。 */
    upsert(m: ConsolidatedMemory): void;
    /** 批量新增/合并:一次落盘(一轮巩固产出多条时避免逐条全量重写)。 */
    upsertMany(items: ConsolidatedMemory[]): void;
    /** 命中一次:计数 +1、更新 lastRecalledAt;同时按遗忘规则降权。 */
    touch(id: string, now: number, opts: {
        confidenceThreshold: number;
        dormantDays: number;
    }): void;
    /**
     * 批量命中:同一轮召回里命中的所有条目**只落盘一次**。
     *
     * 原先 mergeConsolidated 对每条 active 条目单独 touch,而 touch 每次都把整份
     * memories.json 重写一遍 —— 一轮召回 N 条记忆就写 N 次全量 JSON(写放大),
     * 在记忆库大的机器上是明显的 IO 抖动。批量写把 N 次降到 1 次,语义完全不变。
     */
    touchMany(ids: string[], now: number, opts: {
        confidenceThreshold: number;
        dormantDays: number;
    }): number;
    /** 用户主动删除:物理移除条目及全部联想边(与被动遗忘不同,这是显式操作)。 */
    remove(id: string): boolean;
    /** 联想扩散:给一对条目加关联边(weight 累加)。 */
    addLink(a: string, b: string, label: string): void;
    /** 批量加边:只落盘一次(同轮巩固的 n 条产出会形成 n²/2 对边)。 */
    addLinks(pairs: [string, string][], label: string): void;
    /** 取某条目的强关联(weight ≥ minWeight),按权重降序。 */
    strongLinks(id: string, minWeight: number, max: number): {
        id: string;
        weight: number;
    }[];
    /** 读 pending 碎片(容错)。 */
    pending(): {
        id: string;
        content: string;
        userKey: string | null;
        ts: number;
    }[];
    /** 追加 pending 碎片(去重,限量防膨胀)。 */
    addPending(items: {
        id: string;
        content: string;
        userKey: string | null;
    }[], max: number): void;
    /**
     * 清空 pending(巩固完成/放弃)。
     * @param doneIds 若给出,只移除这些 id(本轮实际处理过的碎片),其余保留待下次;
     *                省略则整份清空。
     */
    clearPending(doneIds?: string[]): void;
    /** 更新 meta(lastRunAt/runCount)。 */
    markRun(now: number): void;
    metaInfo(): ConsolidateMeta;
    /** 触发判定:pending 数量达标 且 距上次巩固超过最短间隔。 */
    shouldRun(opts: {
        minFragments: number;
        minIntervalMs: number;
    }, now: number): boolean;
}
/** 给 verify 用的纯函数:从 LLM 原始输出解析巩固 JSON。 */
export declare function parseConsolidationOutput(raw: string): {
    type: ConsolidatedType;
    content: string;
}[];
