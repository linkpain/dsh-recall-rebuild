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
/** 不打折的正文长度(字)。 */
export declare const LENGTH_REF = 120;
/** 归一化系数下限:再长的正文也保留 40% 分,避免长文档被一刀切埋掉。 */
export declare const LENGTH_FLOOR = 0.4;
/** 正文长度 → 打分系数(≤1)。 */
export declare function lengthFactor(bodyLen: number): number;
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
export declare const NGRAM_LATIN_WEIGHT = 1;
export declare const NGRAM_CJK_BIGRAM_WEIGHT = 1;
export declare const NGRAM_CJK_CHAR_WEIGHT = 0.4;
/** 余弦低于此值的候选视为「毫不相干」,不进入语义通道(防止噪声污染 RRF)。
 * 阈值刻意压得极低:实测 0.03 会把同义改写挡在门外(65.0%),降到 0.005 后
 * 才拿到 70.0%。真正做过滤的是权重与精排,不是这道门槛。 */
export declare const SEMANTIC_MIN_SIM = 0.005;
/**
 * 文本 → 字符 n-gram 稀疏向量(维度即特征串,值即权重累加)。
 * 同时保留拉丁词、CJK 2-gram 与 CJK 单字三类特征:前两类保精度,单字保召回。
 */
export declare function buildCharNgramVector(text: string): Map<string, number>;
/** 稀疏向量余弦相似度;任一侧为空时返回 0(不惩罚,只是没有相似性)。 */
export declare function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number;
/** 精排混合系数:实测 0.8 最优(MRR 0.615),0.3 时语义信号太弱(0.600)。
 * 大于 1 会让余弦盖过名次,长尾里"字多"的记录反而上浮,故收敛在 0.8。 */
export declare const SEMANTIC_RERANK_ALPHA = 0.8;
/**
 * 对已按 RRF 排序的候选做语义精排。
 * 前 POOL 条用「RRF 名次分 + α × 余弦」重排,其余保持原序追加 ——
 * 既不丢候选,又不会让长尾的低相似度记录抢到前排。
 */
export declare function rerankBySemantic(list: MemoryRecord[], query: string, alpha?: number): MemoryRecord[];
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
