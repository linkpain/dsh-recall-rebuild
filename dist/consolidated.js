/**
 * 睡眠巩固层(长期记忆子系统):本插件自己的「二次长期记忆」。
 *
 * 类比人脑睡眠巩固:白天碎片(海马体)夜间回放、迁移到新皮层成为稳定记忆,
 * 同时修剪弱记忆、建立联想。对应到本插件:
 * - 底层记忆插件 = 海马体(即时捕获碎片);
 * - 本插件 consolidate 层 = 新皮层(把碎片聚类 → LLM 抽象为稳定记忆 → 联想扩散 → 低频遗忘);
 * - 产出只存自己的目录(<DSH_HOME>/recall-rebuild/consolidated/),绝不写底层记忆库。
 *
 * 本文件:巩固层存储(记忆条目/联想图/meta)+ 纯逻辑(聚类/相似度/遗忘判定)。
 * 引擎(LLM 抽象、触发调度)在 consolidate.ts。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 中文 2-gram + 空白词的 token 集合(用于轻量相似度聚类,无需 LLM)。 */
const STOP = new Set([
    '用户', '喜欢', '一个', '这个', '那个', '什么', '怎么', '我们', '你们', '他们',
    '因为', '所以', '但是', '如果', '就是', '还是', '已经', '可以', '没有',
    '的', '了', '我', '你', '他', '她', '它', '在', '是', '和', '与', '及', '都',
    '很', '也', '就', '不', '吗', '呢', '啊', '呀', '吧', '哦', '哈', '嗯', '哎',
]);
export function tokenize(s) {
    const t = (s ?? '').toLowerCase().trim();
    if (!t)
        return [];
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) {
        const g = t.slice(i, i + 2);
        if (g.trim() && !STOP.has(g))
            out.add(g);
    }
    for (const w of t.split(/\s+/)) {
        if (w.length > 1 && !STOP.has(w))
            out.add(w);
    }
    return [...out];
}
/** Jaccard 相似度。 */
export function similarity(a, b) {
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (ta.length === 0 || tb.length === 0)
        return 0;
    const setB = new Set(tb);
    let inter = 0;
    for (const x of ta)
        if (setB.has(x))
            inter += 1;
    const union = new Set([...ta, ...tb]).size;
    return union === 0 ? 0 : inter / union;
}
/**
 * 包含度(overlap coefficient):较短一侧的 token 有多大比例被较长一侧覆盖。
 *
 * 为什么改口检测不用 Jaccard:两句话只差一个「值」时(「用户住在杭州」vs
 * 「用户住在成都」),Jaccard 只有 0.43 —— 被差异本身稀释;而包含度是 0.6,
 * 因为两句的主体结构完全一致,差异只在那个槽位上。矛盾覆盖要抓的正是这种
 * 「同一句话换了个值」,不是「话题接近」。
 */
export function containment(a, b) {
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (ta.length === 0 || tb.length === 0)
        return 0;
    const small = ta.length <= tb.length ? ta : tb;
    const big = new Set(ta.length <= tb.length ? tb : ta);
    let inter = 0;
    for (const x of small)
        if (big.has(x))
            inter += 1;
    return inter / small.length;
}
/** 字符级最长公共子序列长度(只需长度,不需要回溯路径)。 */
function lcsLength(a, b) {
    const s = a.slice(0, 200);
    const t = b.slice(0, 200);
    if (!s || !t)
        return 0;
    let prev = new Array(t.length + 1).fill(0);
    for (let i = 1; i <= s.length; i++) {
        const cur = new Array(t.length + 1).fill(0);
        for (let j = 1; j <= t.length; j++) {
            cur[j] = s[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[t.length];
}
/** 子序列匹配的对齐位置(用于把差异定位成「哪一段被换掉了」)。 */
function lcsMatch(a, b) {
    const s = a.slice(0, 200);
    const t = b.slice(0, 200);
    const n = s.length;
    const m = t.length;
    if (n === 0 || m === 0)
        return [];
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i * w + j] =
                s[i - 1] === t[j - 1]
                    ? dp[(i - 1) * w + (j - 1)] + 1
                    : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
        }
    }
    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (s[i - 1] === t[j - 1]) {
            pairs.push([i - 1, j - 1]);
            i -= 1;
            j -= 1;
        }
        else if (dp[(i - 1) * w + j] >= dp[i * w + (j - 1)]) {
            i -= 1;
        }
        else {
            j -= 1;
        }
    }
    return pairs.reverse();
}
const EMPTY_JUDGEMENT = { score: 0, sameTemplate: false, sameFact: false };
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
export function judgeSupersede(oldText, freshText, threshold) {
    const x = (oldText ?? '').trim().toLowerCase();
    const y = (freshText ?? '').trim().toLowerCase();
    if (!x || !y)
        return EMPTY_JUDGEMENT;
    const score = supersedeScore(x, y);
    if (score < threshold)
        return { score, sameTemplate: false, sameFact: false };
    const pairs = lcsMatch(x, y);
    const gaps = [];
    let oi = 0;
    let fi = 0;
    for (const [i, j] of pairs) {
        if (i > oi || j > fi)
            gaps.push({ removed: x.slice(oi, i), added: y.slice(fi, j) });
        oi = i + 1;
        fi = j + 1;
    }
    if (oi < x.length || fi < y.length)
        gaps.push({ removed: x.slice(oi), added: y.slice(fi) });
    // 同一件事:一字不差,或一方就是另一方的省略(补几个字、省几个字)。
    // 「补/省」必须整句成立——「iPhone 13」→「iPhone 15」也是 1 个字的差异,
    // 但那是换值,不是省略,所以不能靠「差异很短」来判断。
    // 且补上的不能是「的…」这类限定语:「用户的妈妈住在杭州」→「用户住在杭州」
    // 多出来的「的妈妈」换了主语,是两件事,不是同一件事说得更短。
    // 用「的」开头意味着补上的是一个限定语(我的妈妈 / 我的女朋友),换了主语;
    // 出现在句子中间的「的」只是修饰,不影响主语(「…,练的是指弹曲目」)。
    const extra = x === y ? '' : x.includes(y) ? x.replace(y, '') : y.includes(x) ? y.replace(x, '') : null;
    const sameFact = extra !== null && extra.length <= 10 && !extra.trimStart().startsWith('的');
    // 改口:至少有一处「槽位被换掉」(删一段又补一段),其余差异只能是补/省两个字。
    // 只删不补是省略(同一件事说得更短),不该把长的那条藏起来。
    // 「十月二十三号」→「十一月二十三号」在子序列对齐里只是插入了一个「一」,
    // 但那是把日期换了个值:纯插入的数字字符算换槽,不算补字。
    const NUMERAL = /^[零一二三四五六七八九十百千万两半]+$/;
    const swapped = gaps.some((g) => (g.removed && g.added) || (g.added && NUMERAL.test(g.added)));
    const sameTemplate = swapped &&
        gaps.every((g) => {
            if (g.removed && g.added)
                return Math.max(g.removed.length, g.added.length) <= 6;
            return Math.max(g.removed.length, g.added.length) <= 2;
        });
    return { score, sameTemplate, sameFact };
}
/**
 * 改口判定分:字符级最长公共子序列 / 较短一方的长度。
 *
 * 为什么不用 Jaccard 或二元组包含度:改口的典型形态是「同一句话换了个值」
 * (用户住在杭州 → 用户住在成都),差异被摊到每一个 2-gram 上,Jaccard 只有 0.25、
 * 包含度只有 0.5;而按字符看,两句话 6 个字里有 4 个字符按序相同 = 0.67。
 * 差异「只占一个槽位」这件事,只有子序列比例能表达。
 */
export function supersedeScore(a, b) {
    const x = (a ?? '').trim().toLowerCase();
    const y = (b ?? '').trim().toLowerCase();
    if (!x || !y)
        return 0;
    return lcsLength(x, y) / Math.min(x.length, y.length);
}
/**
 * 找出「新条目取代旧条目」的对:同一用户、同一类型、内容不同,且改口判定分够高。
 *
 * 门槛(默认 0.6)刻意高于聚类阈值(0.25):聚类只要「话题沾边」,
 * 覆盖要求「几乎同一句话」——误判成取代会藏起一条仍然为真的记忆,
 * 代价比漏判高。二元组包含度(≥0.3)只作廉价预筛,挡住绝大多数无关对,
 * 免得对全库每条记忆都跑一遍 O(n·m) 的子序列计算。
 * 同一条旧记忆一轮最多被取代一次(取分最高的新条目)。
 */
export function findSupersedePairs(fresh, existing, threshold) {
    const pairs = [];
    const taken = new Set();
    for (const old of existing) {
        if (old.status === 'superseded')
            continue;
        let bestId = '';
        let bestScore = 0;
        for (const f of fresh) {
            if (f.id === old.id || f.type !== old.type || f.userKey !== old.userKey)
                continue;
            if (f.content.trim() === old.content.trim())
                continue;
            if (containment(f.content, old.content) < 0.3)
                continue; // 预筛:连话题都不沾边
            const j = judgeSupersede(old.content, f.content, threshold);
            // 分数够高还不够:必须是「同一模板换了一个值」。
            // 「用户的妈妈住在杭州」→「用户住在杭州」分数 1.0,但那是换了主语的两件事。
            if (!j.sameTemplate || j.sameFact)
                continue;
            if (j.score > bestScore) {
                bestScore = j.score;
                bestId = f.id;
            }
        }
        if (bestId && !taken.has(bestId)) {
            taken.add(bestId);
            pairs.push([bestId, old.id]);
        }
    }
    return pairs;
}
/**
 * 找出「同一件事又被观察了一次」的旧条目(用于强化置信度而不是再造一条重复记忆)。
 *
 * 与改口检测共用子序列分,但门槛更高:改口是「同一句话换个值」(0.6 即可),
 * 强化要求「几乎是同一句话」(默认 0.85),否则「用户住在杭州」会被当成
 * 「用户住在成都」的重复观察,新事实永远进不来。
 * 被取代(superseded)的条目不参与:旧话不能靠重复出现自己翻案。
 */
export function findTwin(content, type, userKey, existing, threshold) {
    let best;
    let bestScore = 0;
    for (const m of existing) {
        if (m.status === 'superseded')
            continue;
        if (m.type !== type || m.userKey !== userKey)
            continue;
        const j = judgeSupersede(m.content, content, threshold);
        // 「同一件事」= 一字不差 / 一方是另一方的省略(补几个字、省几个字),
        // 而不是「换个值的同一模板」——那正是改口,该由 supersede 处理。
        if (!j.sameFact || j.sameTemplate)
            continue;
        if (j.score > bestScore) {
            bestScore = j.score;
            best = m;
        }
    }
    return best;
}
/**
 * 贪心聚类:按相似度阈值把碎片分组。
 * 返回下标分组数组,每个碎片最多进入一个簇。
 */
export function clusterize(items, threshold, maxCluster) {
    const clusters = [];
    const used = new Set();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || used.has(item.id))
            continue;
        const group = [item.id];
        used.add(item.id);
        for (let j = 0; j < items.length && group.length < maxCluster; j++) {
            if (i === j)
                continue;
            const other = items[j];
            if (!other || used.has(other.id))
                continue;
            if (similarity(item.content, other.content) >= threshold) {
                group.push(other.id);
                used.add(other.id);
            }
        }
        if (group.length > 1 || item.content.length >= 12)
            clusters.push(group);
    }
    return clusters;
}
/** 边权半衰期:30 天掉一半,与 dormantDays 同量级(联想也该随记忆一起变淡)。 */
export const LINK_HALF_LIFE_DAYS = 30;
/**
 * 边的有效权重:weight × 0.5^(ageDays / 30)。
 * 没有 at 的老边视为「刚刚强化过」—— 升级不该凭空抹掉用户已有的联想。
 */
export function effectiveWeight(edge, now) {
    if (!edge.at)
        return edge.weight;
    const ageDays = Math.max(0, (now - edge.at) / DAY_MS);
    return edge.weight * Math.pow(0.5, ageDays / LINK_HALF_LIFE_DAYS);
}
/** 反复被命中的条目不再遗忘(用过的记忆越用越稳)。 */
const PIN_TOUCH_COUNT = 3;
/**
 * 每次命中给置信度的增量:让「越用越稳」有真实梯度,而不是只靠 touchCount 硬扛。
 * 0.05 是权衡:一条 0.35 的脆弱条目被稳定命中 1 次就过默认阈值(0.40),
 * 但要 12 次才封顶(0.95),不会因为一次偶然命中就变成「铁证」。
 */
export const TOUCH_CONFIDENCE_GAIN = 0.05;
/**
 * 每次「重复观察」给置信度的增量。
 * 高于召回命中的 TOUCH_CONFIDENCE_GAIN(0.05):用户又亲口说了一遍同一件事,
 * 比「检索系统又匹配到它」是更强的证据;但仍需多次才能从脆弱(0.35)爬到 0.95 封顶。
 */
export const REINFORCE_CONFIDENCE_GAIN = 0.1;
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
export function isDormant(m, now, opts) {
    if (m.confidence >= opts.confidenceThreshold)
        return false;
    if (m.touchCount >= PIN_TOUCH_COUNT)
        return false;
    const last = m.lastRecalledAt ?? m.createdAt;
    return now - last > opts.dormantDays * DAY_MS;
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
export function decideInjection(m, evidence, opts, revivedSoFar) {
    if (m.status === 'superseded')
        return { inject: false, revived: false, reason: 'superseded' };
    if (m.status === 'active')
        return { inject: true, revived: false, reason: 'active' };
    let best = 0;
    for (const e of evidence)
        best = Math.max(best, similarity(m.content, e));
    if (best < opts.reviveSimilarity)
        return { inject: false, revived: false, reason: 'dormant' };
    const inject = revivedSoFar < opts.maxInject;
    return { inject, revived: true, reason: inject ? 'revived' : 'revived-capped' };
}
/** 按快照读取的巩固层存储(内存态 + 原子落盘)。 */
export class ConsolidatedStore {
    dir;
    logger;
    memories = new Map();
    links = {};
    meta = { lastRunAt: 0, runCount: 0 };
    files = {
        memories: 'memories.json',
        links: 'links.json',
        meta: 'meta.json',
        pending: 'pending.json',
    };
    constructor(dir, logger) {
        this.dir = dir;
        this.logger = logger;
    }
    ensureDir() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        }
        catch (err) {
            this.logger.warn(`[recall-rebuild] 巩固层目录创建失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    readJson(file, fallback) {
        try {
            const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return fallback;
        }
    }
    writeJson(file, data) {
        try {
            const p = path.join(this.dir, file);
            const tmp = `${p}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, p);
        }
        catch (err) {
            this.logger.warn(`[recall-rebuild] 巩固层写 ${file} 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 从磁盘加载(容错:文件缺失/损坏 → 空)。 */
    load() {
        this.ensureDir();
        const mems = this.readJson(this.files.memories, []);
        this.memories = new Map(mems.map((m) => [m.id, m]));
        this.links = this.readJson(this.files.links, {});
        this.meta = this.readJson(this.files.meta, { lastRunAt: 0, runCount: 0 });
    }
    saveAll() {
        this.writeJson(this.files.memories, [...this.memories.values()]);
        this.writeJson(this.files.links, this.links);
        this.writeJson(this.files.meta, this.meta);
    }
    list() {
        return [...this.memories.values()];
    }
    get(id) {
        return this.memories.get(id);
    }
    /** 新增或合并条目(同 id 更新)。 */
    upsert(m) {
        this.upsertMany([m]);
    }
    /** 批量新增/合并:一次落盘(一轮巩固产出多条时避免逐条全量重写)。 */
    upsertMany(items) {
        if (items.length === 0)
            return;
        for (const m of items)
            this.memories.set(m.id, m);
        this.writeJson(this.files.memories, [...this.memories.values()]);
    }
    /** 命中一次:计数 +1、更新 lastRecalledAt;同时按遗忘规则降权。 */
    touch(id, now, opts) {
        this.touchMany([id], now, opts);
    }
    /**
     * 批量命中:同一轮召回里命中的所有条目**只落盘一次**。
     *
     * 原先 mergeConsolidated 对每条 active 条目单独 touch,而 touch 每次都把整份
     * memories.json 重写一遍 —— 一轮召回 N 条记忆就写 N 次全量 JSON(写放大),
     * 在记忆库大的机器上是明显的 IO 抖动。批量写把 N 次降到 1 次,语义完全不变。
     */
    touchMany(ids, now, opts) {
        let changed = 0;
        for (const id of ids) {
            const m = this.memories.get(id);
            if (!m)
                continue;
            // 被取代的旧记忆不再参与召回,自然也不该被 touch 复活
            if (m.status === 'superseded')
                continue;
            m.touchCount += 1;
            m.lastRecalledAt = now;
            // 命中 = 这条记忆又「被用了一次」:置信度小幅上调,休眠条目由此复活
            m.confidence = Math.min(0.95, m.confidence + TOUCH_CONFIDENCE_GAIN);
            m.status = isDormant(m, now, opts) ? 'dormant' : 'active';
            changed += 1;
        }
        if (changed > 0)
            this.writeJson(this.files.memories, [...this.memories.values()]);
        return changed;
    }
    /**
     * 用户手动修正一条记忆:替换内容、把置信度抬到「用户亲口确认」档、状态回 active。
     *
     * 为什么单独一个方法:命中(touch)是「间接证据」——这条记忆又被检索到了,
     * 所以只给 TOUCH_CONFIDENCE_GAIN 的小幅上调;而 edit 是「直接证据」——
     * 用户看着这条记忆说「它应该这么记」。直接证据不该再因为「很久没被提起」
     * 被判休眠,否则用户越是想救回一条记错的记忆,它越可能在下一次扫描里睡着。
     */
    revise(id, content, opts) {
        const m = this.memories.get(id);
        if (!m)
            return undefined;
        const now = Date.now();
        m.content = content;
        m.confidence = Math.max(m.confidence, Math.min(0.95, opts.confidenceThreshold + 0.3));
        m.updatedAt = now;
        // 用户手改 = 重新主张这条记忆:曾被取代的也翻案,不再背 superseded 的包袱
        delete m.supersededBy;
        delete m.supersededAt;
        m.status = isDormant(m, now, opts) ? 'dormant' : 'active';
        this.writeJson(this.files.memories, [...this.memories.values()]);
        return m;
    }
    /**
     * 强化:同一件事又被观察到 n 次 → 置信度按次上调,条目回到 active。
     *
     * 这是「置信度动态化」的入口:confidence 不再只在创建时算一次、之后只靠召回
     * 命中微调;真实世界里的重复观察(用户又提了一次同一件事)本身就是证据。
     * 每次强化给 REINFORCE_CONFIDENCE_GAIN(0.1),高于召回命中的 0.05 ——
     * 又听用户说了一遍,比「检索系统又匹配到它」强得多。
     */
    reinforceMany(ids, now, opts) {
        let changed = 0;
        for (const id of ids) {
            const m = this.memories.get(id);
            if (!m || m.status === 'superseded')
                continue;
            m.confidence = Math.min(0.95, m.confidence + REINFORCE_CONFIDENCE_GAIN);
            m.updatedAt = now;
            m.status = isDormant(m, now, opts) ? 'dormant' : 'active';
            changed += 1;
        }
        if (changed > 0)
            this.writeJson(this.files.memories, [...this.memories.values()]);
        return changed;
    }
    /**
     * 新记忆取代旧记忆(用户改口/搬家/换工作):旧条目标记 superseded 并指向新条目。
     *
     * 为什么不直接删掉旧条目:记忆的价值不只在「当前为真」,还在「曾经这么记过」——
     * 用户后来说「我记错了」时,那条被取代的记忆就是证据。删了就不可翻案。
     * 联想边迁到新条目:被取代的是内容,不是它在联想图里的位置。
     */
    supersedeMany(pairs, now) {
        let changed = 0;
        for (const [newId, oldId] of pairs) {
            const fresh = this.memories.get(newId);
            const old = this.memories.get(oldId);
            if (!fresh || !old || newId === oldId)
                continue;
            if (old.status === 'superseded')
                continue; // 已被取代,不叠加指针
            old.status = 'superseded';
            old.supersededBy = newId;
            old.supersededAt = now;
            old.updatedAt = now;
            for (const [neighbor, edge] of Object.entries(this.links[oldId] ?? {})) {
                if (neighbor === newId)
                    continue;
                if (!this.links[newId])
                    this.links[newId] = {};
                const cur = this.links[newId][neighbor];
                if (!cur || cur.weight < edge.weight)
                    this.links[newId][neighbor] = { ...edge };
            }
            delete this.links[oldId];
            changed += 1;
        }
        if (changed > 0) {
            this.writeJson(this.files.memories, [...this.memories.values()]);
            this.writeJson(this.files.links, this.links);
        }
        return changed;
    }
    /** 用户主动删除:物理移除条目及全部联想边(与被动遗忘不同,这是显式操作)。 */
    remove(id) {
        if (!this.memories.has(id))
            return false;
        this.memories.delete(id);
        delete this.links[id];
        for (const k of Object.keys(this.links)) {
            delete this.links[k]?.[id];
            if (Object.keys(this.links[k] ?? {}).length === 0)
                delete this.links[k];
        }
        this.writeJson(this.files.memories, [...this.memories.values()]);
        this.writeJson(this.files.links, this.links);
        return true;
    }
    /** 联想扩散:给一对条目加关联边(weight 累加)。 */
    addLink(a, b, label) {
        this.addLinks([[a, b]], label);
    }
    /** 批量加边:只落盘一次(同轮巩固的 n 条产出会形成 n²/2 对边)。 */
    addLinks(pairs, label, now = Date.now()) {
        let changed = 0;
        for (const [a, b] of pairs) {
            if (!a || !b || a === b)
                continue;
            if (!this.links[a])
                this.links[a] = {};
            const edge = this.links[a][b];
            if (edge) {
                edge.weight += 1;
                edge.at = now;
            }
            else {
                this.links[a][b] = { weight: 1, label, at: now };
            }
            changed += 1;
        }
        if (changed > 0)
            this.writeJson(this.files.links, this.links);
    }
    /**
     * 取某条目的强关联(有效权重 ≥ minWeight),按有效权重降序。
     *
     * 「有效权重」= 累计权重 × 半衰期衰减。为什么要衰减:同轮巩固会给簇内
     * 所有条目两两连边,一次「同一批碎片」就能造出一堆 weight 很高的边;
     * 若权重只增不减,半年前一次偶然的共同出现会和昨天的反复共现一样强,
     * 联想扩散就会被陈旧边占满。
     */
    strongLinks(id, minWeight, max, now = Date.now()) {
        const edges = this.links[id] ?? {};
        return Object.entries(edges)
            .map(([tid, e]) => ({ id: tid, weight: e.weight, effective: effectiveWeight(e, now) }))
            // 留 1e-9 容差:刚写入的边 effective 是 1.9999999…,别被浮点误差挡在门槛外
            .filter((e) => e.effective >= minWeight - 1e-9)
            .sort((x, y) => y.effective - x.effective)
            .slice(0, max);
    }
    /**
     * 两跳联想扩散:从命中条目出发,一跳邻居 + 二跳邻居(按有效权重衰减)。
     *
     * 一跳是「同轮一起被巩固过」(强共现);二跳是「我联想到的人,又联想到的事」,
     * 只在两跳都很强时才带出来 —— 二跳分 = w1 × w2 / 阈值²,低于 minScore 的丢弃。
     * 这样「A 常和 B 一起出现、B 常和 C 一起出现」能带出 C,但弱链拼不出假联想。
     */
    diffuse(id, opts, now = Date.now()) {
        const out = [];
        const seen = new Set([id]);
        const hop1 = this.strongLinks(id, opts.hop1Min, opts.maxHop1, now);
        for (const e of hop1) {
            if (seen.has(e.id))
                continue;
            seen.add(e.id);
            out.push({ id: e.id, hop: 1, score: e.effective });
        }
        for (const e of hop1) {
            const second = this.strongLinks(e.id, opts.hop2Min, opts.maxHop2, now);
            for (const s of second) {
                if (seen.has(s.id))
                    continue;
                const score = (e.effective * s.effective) / (opts.hop2Min * opts.hop2Min);
                if (score < opts.minScore)
                    continue;
                seen.add(s.id);
                out.push({ id: s.id, hop: 2, score });
                if (out.filter((x) => x.hop === 2).length >= opts.maxHop2)
                    break;
            }
        }
        return out;
    }
    // ── 待巩固碎片缓冲(pending) ────────────────────────────────
    /** 读 pending 碎片(容错)。 */
    pending() {
        return this.readJson(this.files.pending, []);
    }
    /** 追加 pending 碎片(去重,限量防膨胀)。 */
    addPending(items, max) {
        const cur = this.pending();
        const seen = new Set(cur.map((p) => p.id));
        const now = Date.now();
        for (const it of items) {
            if (seen.has(it.id))
                continue;
            if (cur.length >= max)
                break;
            cur.push({ ...it, ts: now });
            seen.add(it.id);
        }
        this.writeJson(this.files.pending, cur);
    }
    /**
     * 清空 pending(巩固完成/放弃)。
     * @param doneIds 若给出,只移除这些 id(本轮实际处理过的碎片),其余保留待下次;
     *                省略则整份清空。
     */
    clearPending(doneIds) {
        if (!doneIds) {
            this.writeJson(this.files.pending, []);
            return;
        }
        const done = new Set(doneIds);
        const rest = this.pending().filter((p) => !done.has(p.id));
        this.writeJson(this.files.pending, rest);
    }
    /** 更新 meta(lastRunAt/runCount)。 */
    markRun(now) {
        this.meta.lastRunAt = now;
        this.meta.runCount += 1;
        this.writeJson(this.files.meta, this.meta);
    }
    metaInfo() {
        return { ...this.meta };
    }
    /** 触发判定:pending 数量达标 且 距上次巩固超过最短间隔。 */
    shouldRun(opts, now) {
        if (this.pending().length < opts.minFragments)
            return false;
        return now - this.meta.lastRunAt > opts.minIntervalMs;
    }
}
/** 给 verify 用的纯函数:从 LLM 原始输出解析巩固 JSON。 */
export function parseConsolidationOutput(raw) {
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m)
            return [];
        const obj = JSON.parse(m[0]);
        if (!Array.isArray(obj.memories))
            return [];
        const valid = ['stable-fact', 'pattern', 'preference', 'relationship', 'mood'];
        return obj.memories
            .filter((x) => x && typeof x.content === 'string' && x.content.trim())
            .map((x) => ({
            type: valid.includes(x.type) ? x.type : 'stable-fact',
            content: x.content.trim().slice(0, 400),
        }));
    }
    catch {
        return [];
    }
}
