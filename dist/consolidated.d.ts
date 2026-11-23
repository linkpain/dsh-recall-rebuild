import type { LoggerLike } from './store.js';
/**
 * 条目状态:
 * - active —— 参与召回;
 * - dormant —— 被「遗忘」(召回降权),可被重新提起唤醒;
 * - superseded —— 被新记忆取代(用户改口/搬家/换工作),旧事实不再成立。
 * 三者都不删除、都不写底层记忆库。
 */
export type ConsolidatedStatus = 'active' | 'dormant' | 'superseded';
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
    status: ConsolidatedStatus;
    /** 被哪条新记忆取代(superseded 时的指针,便于溯源与翻案)。 */
    supersededBy?: string;
    /** 被取代的时间。 */
    supersededAt?: number;
    createdAt: number;
    updatedAt: number;
    /** 被召回命中的次数(越用越稳)。 */
    touchCount: number;
    lastRecalledAt?: number;
}
export type ConsolidatedType = ConsolidatedMemory['type'];
/**
 * 一条联想边:weight 是累计强化次数,at 是最后一次强化的时间(用于边权衰减)。
 * at 缺省(老数据)按「从未衰减」处理,不给历史库凭空扣分。
 */
export interface LinkEdge {
    weight: number;
    label: string;
    at?: number;
}
/** 联想图:条目 id → 关联条目 id → 边。 */
export type LinkGraph = Record<string, Record<string, LinkEdge>>;
export interface ConsolidateMeta {
    lastRunAt: number;
    runCount: number;
}
export declare function tokenize(s: string): string[];
/** Jaccard 相似度。 */
export declare function similarity(a: string, b: string): number;
/**
 * 包含度(overlap coefficient):较短一侧的 token 有多大比例被较长一侧覆盖。
 *
 * 为什么改口检测不用 Jaccard:两句话只差一个「值」时(「用户住在杭州」vs
 * 「用户住在成都」),Jaccard 只有 0.43 —— 被差异本身稀释;而包含度是 0.6,
 * 因为两句的主体结构完全一致,差异只在那个槽位上。矛盾覆盖要抓的正是这种
 * 「同一句话换了个值」,不是「话题接近」。
 */
export declare function containment(a: string, b: string): number;
/** 一次改口判定:分数 + 差异形态。 */
export interface SupersedeJudgement {
    /** 子序列比例(0~1)。 */
    score: number;
    /** 差异是否只是「同一模板换一个等长槽位」(或补/省两个字)。 */
    sameTemplate: boolean;
    /** 差异是否只是「同一句话的省略/补充」(用于识别重复观察)。 */
    sameFact: boolean;
}
/**
 * 判断新旧两句话的差异「长什么样」,而不只是「差多少」。
 *
 * 只用分数会同时犯两种错,而且方向相反:
 * - 「用户的妈妈住在杭州」vs「用户住在杭州」分数 1.0 —— 新句子整句都是旧句子的子序列,
 *   但那是**少了三个字**(换了主语),不是改口;
 * - 「用户的手机是 iPhone 13」vs「…iPhone 15」分数 0.9 以上 —— 差异只有 1 个字,
 *   但那是**换了一个值**,不是重复观察。
 * 所以这里把差异段按子序列对齐切出来,再看每一段是什么形状:
 * 等长的单槽替换(≤4 字)= 改口;纯补/纯省(≤2 字)= 省略或补充;
 * 其他(整块换掉、加了一长串、删了一长串)= 两条不同的事,谁也不该取代谁。
 */
export declare function judgeSupersede(oldText: string, freshText: string, threshold: number): SupersedeJudgement;
/**
 * 改口判定分:字符级最长公共子序列 / 较短一方的长度。
 *
 * 为什么不用 Jaccard 或二元组包含度:改口的典型形态是「同一句话换了个值」
 * (用户住在杭州 → 用户住在成都),差异被摊到每一个 2-gram 上,Jaccard 只有 0.25、
 * 包含度只有 0.5;而按字符看,两句话 6 个字里有 4 个字符按序相同 = 0.67。
 * 差异「只占一个槽位」这件事,只有子序列比例能表达。
 */
export declare function supersedeScore(a: string, b: string): number;
/**
 * 找出「新条目取代旧条目」的对:同一用户、同一类型、内容不同,且改口判定分够高。
 *
 * 门槛(默认 0.6)刻意高于聚类阈值(0.25):聚类只要「话题沾边」,
 * 覆盖要求「几乎同一句话」——误判成取代会藏起一条仍然为真的记忆,
 * 代价比漏判高。二元组包含度(≥0.3)只作廉价预筛,挡住绝大多数无关对,
 * 免得对全库每条记忆都跑一遍 O(n·m) 的子序列计算。
 * 同一条旧记忆一轮最多被取代一次(取分最高的新条目)。
 */
export declare function findSupersedePairs(fresh: {
    id: string;
    type: ConsolidatedType;
    content: string;
    userKey: string | null;
}[], existing: ConsolidatedMemory[], threshold: number): [string, string][];
/**
 * 找出「同一件事又被观察了一次」的旧条目(用于强化置信度而不是再造一条重复记忆)。
 *
 * 与改口检测共用子序列分,但门槛更高:改口是「同一句话换个值」(0.6 即可),
 * 强化要求「几乎是同一句话」(默认 0.85),否则「用户住在杭州」会被当成
 * 「用户住在成都」的重复观察,新事实永远进不来。
 * 被取代(superseded)的条目不参与:旧话不能靠重复出现自己翻案。
 */
export declare function findTwin(content: string, type: ConsolidatedType, userKey: string | null, existing: ConsolidatedMemory[], threshold: number): ConsolidatedMemory | undefined;
/**
 * 贪心聚类:按相似度阈值把碎片分组。
 * 返回下标分组数组,每个碎片最多进入一个簇。
 */
export declare function clusterize(items: {
    id: string;
    content: string;
}[], threshold: number, maxCluster: number): string[][];
/** 边权半衰期:30 天掉一半,与 dormantDays 同量级(联想也该随记忆一起变淡)。 */
export declare const LINK_HALF_LIFE_DAYS = 30;
/**
 * 边的有效权重:weight × 0.5^(ageDays / 30)。
 * 没有 at 的老边视为「刚刚强化过」—— 升级不该凭空抹掉用户已有的联想。
 */
export declare function effectiveWeight(edge: LinkEdge, now: number): number;
/**
 * 每次命中给置信度的增量:让「越用越稳」有真实梯度,而不是只靠 touchCount 硬扛。
 * 0.05 是权衡:一条 0.35 的脆弱条目被稳定命中 1 次就过默认阈值(0.40),
 * 但要 12 次才封顶(0.95),不会因为一次偶然命中就变成「铁证」。
 */
export declare const TOUCH_CONFIDENCE_GAIN = 0.05;
/**
 * 每次「重复观察」给置信度的增量。
 * 高于召回命中的 TOUCH_CONFIDENCE_GAIN(0.05):用户又亲口说了一遍同一件事,
 * 比「检索系统又匹配到它」是更强的证据;但仍需多次才能从脆弱(0.35)爬到 0.95 封顶。
 */
export declare const REINFORCE_CONFIDENCE_GAIN = 0.1;
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
 *
 * status 不参与判定。这里曾经第一行是 `if (m.status === 'dormant') return true;`,
 * 它把休眠变成单向的:睡着之后这里永远返回 true,而召回侧又只遍历 active 条目,
 * 休眠条目再也拿不到 touch —— 永远醒不过来,连用户手动 edit 都救不回来。
 * 现在 dormant 只是「上次扫描算出的缓存结论」,每次按当前证据重算,
 * 睡着之后被重新提起(命中 / 编辑)就能醒。
 */
export declare function isDormant(m: ConsolidatedMemory, now: number, opts: {
    confidenceThreshold: number;
    dormantDays: number;
}): boolean;
/** 单条巩固条目在本轮召回里的处置结论(纯函数,便于验证)。 */
export interface InjectionDecision {
    inject: boolean;
    /** 本轮因「又被提起」而唤醒(原为 dormant)。 */
    revived: boolean;
    reason: 'active' | 'revived' | 'revived-capped' | 'dormant' | 'superseded';
}
/**
 * 决定一条巩固条目本轮是否注入、是否需要唤醒。
 *
 * 三种状态的处理必须分开:
 * - superseded 永不注入,也绝不能被「话题相似」唤醒 —— 被取代的旧事实
 *   (「用户住在杭州」)与新事实(「用户搬到成都」)恰恰是高度相似的,
 *   用相似度复活它等于把刚纠正的错话重新说一遍;
 * - dormant 靠证据复活:本轮召回碎片与它足够相似 = 它又被提起了;
 * - active 直接注入。
 *
 * 唤醒的「生效」与「注入」是两件事:被提起的休眠条目都会 touch(于是醒),
 * 但一轮最多附带注入 maxInject 条,免得一堆沾边旧记忆稀释重建质量。
 */
export declare function decideInjection(m: ConsolidatedMemory, evidence: string[], opts: {
    reviveSimilarity: number;
    maxInject: number;
}, revivedSoFar: number): InjectionDecision;
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
    /**
     * 用户手动修正一条记忆:替换内容、把置信度抬到「用户亲口确认」档、状态回 active。
     *
     * 为什么单独一个方法:命中(touch)是「间接证据」——这条记忆又被检索到了,
     * 所以只给 TOUCH_CONFIDENCE_GAIN 的小幅上调;而 edit 是「直接证据」——
     * 用户看着这条记忆说「它应该这么记」。直接证据不该再因为「很久没被提起」
     * 被判休眠,否则用户越是想救回一条记错的记忆,它越可能在下一次扫描里睡着。
     */
    revise(id: string, content: string, opts: {
        confidenceThreshold: number;
        dormantDays: number;
    }): ConsolidatedMemory | undefined;
    /**
     * 强化:同一件事又被观察到 n 次 → 置信度按次上调,条目回到 active。
     *
     * 这是「置信度动态化」的入口:confidence 不再只在创建时算一次、之后只靠召回
     * 命中微调;真实世界里的重复观察(用户又提了一次同一件事)本身就是证据。
     * 每次强化给 REINFORCE_CONFIDENCE_GAIN(0.1),高于召回命中的 0.05 ——
     * 又听用户说了一遍,比「检索系统又匹配到它」强得多。
     */
    reinforceMany(ids: string[], now: number, opts: {
        confidenceThreshold: number;
        dormantDays: number;
    }): number;
    /**
     * 新记忆取代旧记忆(用户改口/搬家/换工作):旧条目标记 superseded 并指向新条目。
     *
     * 为什么不直接删掉旧条目:记忆的价值不只在「当前为真」,还在「曾经这么记过」——
     * 用户后来说「我记错了」时,那条被取代的记忆就是证据。删了就不可翻案。
     * 联想边迁到新条目:被取代的是内容,不是它在联想图里的位置。
     */
    supersedeMany(pairs: [string, string][], now: number): number;
    /** 用户主动删除:物理移除条目及全部联想边(与被动遗忘不同,这是显式操作)。 */
    remove(id: string): boolean;
    /** 联想扩散:给一对条目加关联边(weight 累加)。 */
    addLink(a: string, b: string, label: string): void;
    /** 批量加边:只落盘一次(同轮巩固的 n 条产出会形成 n²/2 对边)。 */
    addLinks(pairs: [string, string][], label: string, now?: number): void;
    /**
     * 取某条目的强关联(有效权重 ≥ minWeight),按有效权重降序。
     *
     * 「有效权重」= 累计权重 × 半衰期衰减。为什么要衰减:同轮巩固会给簇内
     * 所有条目两两连边,一次「同一批碎片」就能造出一堆 weight 很高的边;
     * 若权重只增不减,半年前一次偶然的共同出现会和昨天的反复共现一样强,
     * 联想扩散就会被陈旧边占满。
     */
    strongLinks(id: string, minWeight: number, max: number, now?: number): {
        id: string;
        weight: number;
        effective: number;
    }[];
    /**
     * 两跳联想扩散:从命中条目出发,一跳邻居 + 二跳邻居(按有效权重衰减)。
     *
     * 一跳是「同轮一起被巩固过」(强共现);二跳是「我联想到的人,又联想到的事」,
     * 只在两跳都很强时才带出来 —— 二跳分 = w1 × w2 / 阈值²,低于 minScore 的丢弃。
     * 这样「A 常和 B 一起出现、B 常和 C 一起出现」能带出 C,但弱链拼不出假联想。
     */
    diffuse(id: string, opts: {
        hop1Min: number;
        hop2Min: number;
        minScore: number;
        maxHop1: number;
        maxHop2: number;
    }, now?: number): {
        id: string;
        hop: 1 | 2;
        score: number;
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
