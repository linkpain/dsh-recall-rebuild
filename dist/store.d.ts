export interface MemoryRecord {
    id: string;
    content: string;
    type: string;
    sceneName: string;
    family: string;
    priority: number;
    timestampStr: string;
}
export interface LoggerLike {
    debug?(m: string): void;
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
}
export interface MemoryStore {
    /** 是否成功挂载记忆库。false 时 search 恒空,插件按只观察模式运行。 */
    ok: boolean;
    label: string;
    search(query: string, limit: number): MemoryRecord[];
    close(): void;
}
/**
 * 查询分词(检索侧核心):
 * - 拉丁/数字:按非字母数字切分,过滤停用词;
 * - 中文:CJK 连续段切 2-gram(与 consolidated.ts 的聚类分词同源)。
 *
 * 为什么必须切 2-gram:SQLite FTS5 的 unicode61 分词器把一整串无边空格的中文
 * 当成 **一个** 词元,所以「冰美式咖啡」永远匹配不到「用户喜欢喝冰美式咖啡」。
 * 切 2-gram 后同一句话变成 冰美/美式/式咖/咖啡,检索侧(无论底层索引是整词
 * 还是分词)都能落到子串匹配上;这正是此前中文召回几乎必然 0 命中的根因。
 * 返回顺序 = 查询中出现顺序(调用方可按长度/预算自行取舍)。
 */
export declare function tokenizeQuery(query: string): string[];
/**
 * 宽松 MATCH 表达式:词元 OR 连接(召回优先)。
 *
 * 为什么 AND 之外还要一路 OR:中文 2-gram 词元一多,AND 几乎必然 0 命中,
 * 整条 FTS 通道就白跑了;OR 虽然精度低,但把它作为一个**排名列表**交给
 * RRF 融合,精度由严格通道和 LIKE 打分兜住,召回却实打实拿到了。
 */
export declare function sanitizeFtsRelaxed(query: string): string;
export declare function sanitizeFts(query: string): string;
export declare const DECAY_HALF_LIFE_DAYS = 30;
export declare const DECAY_FLOOR = 0.5;
/**
 * 记忆时间 → 排序权重系数(1 = 今天,最低 DECAY_FLOOR)。
 * 时间戳无法解析时返回 1(信息缺失不惩罚,与「无时间」同义)。
 */
export declare function decayFactor(timestampStr: string, now: number): number;
/**
 * 按「优先级 × 时效衰减」重排并截断:检索侧统一出口。
 * 无论底层是 FTS、LIKE 打分还是巩固层条目,进入重建前都过这一道,
 * 保证「昨天的好记忆」不会被「五年前的同等记忆」压住。
 */
export declare function rankMemories(list: MemoryRecord[], limit: number, now: number): MemoryRecord[];
export declare const RRF_K = 60;
/**
 * 把多路排好序的候选融合成一条序列(按 id 去重,保留首次出现的记录内容)。
 * @param lists 每路已按相关度排序的候选
 * @param limit 输出条数上限
 * @param weights 每路权重(缺省 1);精度高的通道给高权重,召回通道给低权重
 */
export declare function fuseRanked(lists: MemoryRecord[][], limit: number, weights?: number[]): MemoryRecord[];
/**
 * 打开 dsh-prime-memory 的只读记忆库。
 * @param dataDir prime-memory 的数据目录(默认 $DSH_HOME/memory)
 */
export declare function openPrimeMemoryStore(dataDir: string, logger: LoggerLike): MemoryStore;
/** 打开 dsh-memory-palace 的只读记忆源(cwd = DSH 工作目录,用于定位工作区记忆)。 */
export declare function openPalaceStore(cwd: string, logger: LoggerLike): MemoryStore;
/**
 * 打开 @max-null/dsh-memory 的只读记忆源。
 * @param cwd DSH 工作目录(用于定位 project 记忆)
 */
export declare function openDshMemoryStore(cwd: string, logger: LoggerLike): MemoryStore;
/** 记忆来源路由:auto 探测 prime → dsh-memory → palace,或按 source 显式指定。 */
export declare function openMemorySource(source: 'auto' | 'prime' | 'dsh-memory' | 'palace', opts: {
    dataDir: string;
    cwd: string;
    logger: LoggerLike;
}): MemoryStore;
