/**
 * 记忆库适配器:只读 dsh-prime-memory 的 SQLite 记忆库($DSH_HOME/memory/memory.db)。
 *
 * 设计铁律:
 * - 只读(readOnly 打开),绝不写库——增强插件零污染现有记忆数据。
 * - 零运行时依赖:用 Node 22+ 内置 node:sqlite 读库。
 * - 降级:node:sqlite 不可用 / 库打不开 / FTS 查询失败 → 空结果或 LIKE 兜底,
 *   绝不抛错拖垮宿主启动。
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const require = createRequire(import.meta.url);
function errDetail(err) {
    return err instanceof Error ? err.message : String(err);
}
/** 构建降级空 store(不吞日志,便于诊断)。 */
function disabledStore(label) {
    return {
        ok: false,
        label,
        search: () => [],
        close: () => { },
    };
}
/** 拉丁停用词(与 FTS5 的 AND/OR/NOT 保留字重叠,必须过滤)。 */
const LATIN_STOP = new Set([
    // FTS5 的布尔运算符与 NEAR:进 MATCH 表达式会被当语法,必须剔除
    'and', 'or', 'not', 'near',
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for',
    'with', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
    'this', 'that', 'what', 'how', 'why', 'when', 'where', 'who', 'do',
    'does', 'did', 'can', 'could', 'will', 'would', 'should', 'have', 'has',
    'you', 'your', 'me', 'my', 'i', 'we', 'our', 'they', 'them', 'he', 'she',
]);
/**
 * 中文高频虚词二元组:检索时若展开成这些二元组几乎命中所有中文记录,
 * 只会把真正相关的碎片挤出预算,因此与拉丁停用词同等对待。
 */
const CJK_STOP = new Set([
    '用户', '我们', '你们', '他们', '她们', '它们', '什么', '怎么', '这个',
    '那个', '这些', '那些', '因为', '所以', '但是', '如果', '就是', '还是',
    '已经', '可以', '没有', '一个', '一下', '一些', '这样', '那样', '时候',
    '现在', '今天', '明天', '昨天', '自己', '非常', '真的', '然后', '而且',
    '以及', '或者', '不是', '不能', '不会', '可能', '应该', '需要', '觉得',
    '知道', '喜欢', '记得', '告诉', '关于', '这个', '那个', '我的', '你的',
]);
/** CJK 区段:中日韩统一表意文字(含扩展 A/兼容区)、假名、谚文。 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
/**
 * 切分行 =「CJK 连续段」或「非 CJK 的字母/数字连续段」。
 *
 * 第二段必须显式排除 CJK:\p{L} 本身就包含汉字,若直接写成 [\p{L}\p{N}]+,
 * 中英混排的「咖啡Starbucks拿铁」会被整段吃进第二分支再被当成中文切 2-gram,
 * 英文单词碎成 st/ta/ar… 彻底失去检索价值。
 */
const RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\W_]+/gu;
/** 查询词元总量上限:防止长对话拼出的查询让 FTS 表达式与 LIKE 参数爆炸。 */
const MAX_QUERY_TOKENS = 64;
/** LIKE 兜底参与打分的最多词元数(每个词元占 3 个 SQL 参数,过多会拖慢查询)。 */
const MAX_LIKE_WORDS = 12;
/** 单字覆盖通道最多取几个汉字(每个字一个 LIKE 参数)。 */
const MAX_CHAR_WORDS = 14;
/** 全局 CJK 字符匹配(用于单字覆盖通道取字)。 */
const CJK_CHAR_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
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
export function tokenizeQuery(query) {
    const q = typeof query === 'string' ? query.toLowerCase() : '';
    if (!q)
        return [];
    const out = [];
    const seen = new Set();
    const push = (t) => {
        if (!t || seen.has(t) || out.length >= MAX_QUERY_TOKENS)
            return;
        seen.add(t);
        out.push(t);
    };
    for (const m of q.matchAll(RUN_RE)) {
        const run = m[0] ?? '';
        if (!run)
            continue;
        if (CJK_CHAR.test(run)) {
            if (run.length <= 2) {
                if (!CJK_STOP.has(run))
                    push(run);
            }
            else {
                for (let i = 0; i + 2 <= run.length; i++) {
                    const g = run.slice(i, i + 2);
                    if (!CJK_STOP.has(g))
                        push(g);
                }
            }
            continue;
        }
        if (!LATIN_STOP.has(run))
            push(run);
    }
    return out;
}
/**
 * FTS5 MATCH 表达式清洗:逐词加双引号、AND 连接,
 * 规避 FTS5 特殊字符(引号/AND/OR/NOT/括号等)导致的语法错误。
 *
 * 注意:AND 连接意味着「全部词元都要命中」。中文 2-gram 词元很多,AND 语义下
 * 命中门槛高、经常 0 命中并回落到 LIKE 打分兜底 —— 这正是设计意图:
 * FTS 负责拉丁词的高精度召回,LIKE 打分负责中文的召回,两者互补而非互斥。
 */
/** 中文单字级检索时丢弃的高频字(代词/助词/量词):它们几乎出现在每条记忆里。 */
const CJK_CHAR_STOP = new Set([
    '我', '你', '他', '她', '它', '们', '的', '了', '是', '在', '有', '和', '就',
    '不', '也', '都', '很', '还', '要', '会', '能', '把', '被', '给', '对', '从',
    '到', '这', '那', '个', '些', '吗', '呢', '吧', '啊', '呀', '什', '么', '怎',
    '样', '时', '候', '现', '已', '经', '可', '以', '但', '因', '为', '所', '如',
    '果', '或', '者', '与', '及', '着', '过', '来', '去', '上', '下', '里', '中',
    '得', '地', '之', '其', '一', '二', '三', '点', '做', '想', '说', '看',
]);
/** 宽松 MATCH 表达式的词元上限:OR 展开太多会让 FTS 退化成全表扫。 */
const MAX_RELAXED_TOKENS = 24;
/**
 * 宽松 MATCH 表达式:词元 OR 连接(召回优先)。
 *
 * 为什么 AND 之外还要一路 OR:中文 2-gram 词元一多,AND 几乎必然 0 命中,
 * 整条 FTS 通道就白跑了;OR 虽然精度低,但把它作为一个**排名列表**交给
 * RRF 融合,精度由严格通道和 LIKE 打分兜住,召回却实打实拿到了。
 */
export function sanitizeFtsRelaxed(query) {
    const tokens = tokenizeQuery(query).slice(0, MAX_RELAXED_TOKENS);
    if (tokens.length === 0)
        return '';
    if (tokens.length === 1)
        return `"${tokens[0]?.replace(/"/g, '""')}"`;
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
export function sanitizeFts(query) {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0)
        return '';
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
/* ── 时效衰减(排序分用) ─────────────────────────────────────
 * 五年不变的记忆和昨天的记忆不该同分。做法与第一梯队记忆项目一致:
 * score × max(FLOOR, 0.5^(Δ天 / 半衰期))。
 * FLOOR 必须存在 —— 纯指数衰减会让「很老但很重要」的记忆永远排到后面,
 * 那是另一种失真;这里让老记忆最多损失一半排序分,永不沉底。 */
export const DECAY_HALF_LIFE_DAYS = 30;
export const DECAY_FLOOR = 0.5;
const DAY_MS = 86_400_000;
/**
 * 记忆时间 → 排序权重系数(1 = 今天,最低 DECAY_FLOOR)。
 * 时间戳无法解析时返回 1(信息缺失不惩罚,与「无时间」同义)。
 */
export function decayFactor(timestampStr, now) {
    const t = Date.parse(timestampStr);
    if (!Number.isFinite(t))
        return 1;
    const days = Math.max(0, (now - t) / DAY_MS);
    return Math.max(DECAY_FLOOR, Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS));
}
/**
 * 按「优先级 × 时效衰减」重排并截断:检索侧统一出口。
 * 无论底层是 FTS、LIKE 打分还是巩固层条目,进入重建前都过这一道,
 * 保证「昨天的好记忆」不会被「五年前的同等记忆」压住。
 */
export function rankMemories(list, limit, now) {
    return [...list]
        .sort((a, b) => b.priority * decayFactor(b.timestampStr, now) - a.priority * decayFactor(a.timestampStr, now))
        .slice(0, Math.max(0, limit));
}
function mapRow(r) {
    return {
        id: typeof r.record_id === 'string' ? r.record_id : '',
        content: typeof r.content === 'string' ? r.content : '',
        type: typeof r.type === 'string' ? r.type : '',
        sceneName: typeof r.scene_name === 'string' ? r.scene_name : '',
        family: typeof r.family === 'string' ? r.family : '',
        priority: typeof r.priority === 'number' ? r.priority : 0,
        timestampStr: typeof r.timestamp_str === 'string' ? r.timestamp_str : '',
    };
}
/* ── 多路融合(RRF) ─────────────────────────────────────────
 * FTS 走 BM25,LIKE 走覆盖度打分,两者的分数量纲完全不同,直接相加没有意义。
 * Reciprocal Rank Fusion 只看排名不看分数:score = Σ 1/(K + rank),
 * 是检索领域公认「零调参也能稳定优于单路」的融合方式(RRF_K=60 是原论文取值)。 */
export const RRF_K = 60;
/**
 * 把多路排好序的候选融合成一条序列(按 id 去重,保留首次出现的记录内容)。
 * @param lists 每路已按相关度排序的候选
 * @param limit 输出条数上限
 * @param weights 每路权重(缺省 1);精度高的通道给高权重,召回通道给低权重
 */
export function fuseRanked(lists, limit, weights) {
    const scores = new Map();
    const byId = new Map();
    for (let li = 0; li < lists.length; li++) {
        const list = lists[li];
        if (!list)
            continue;
        const w = weights?.[li] ?? 1;
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (!rec || !rec.id)
                continue;
            if (!byId.has(rec.id))
                byId.set(rec.id, rec);
            scores.set(rec.id, (scores.get(rec.id) ?? 0) + (w / (RRF_K + i + 1)));
        }
    }
    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(0, limit))
        .map(([id]) => byId.get(id))
        .filter((r) => r !== undefined);
}
/**
 * 打开 dsh-prime-memory 的只读记忆库。
 * @param dataDir prime-memory 的数据目录(默认 $DSH_HOME/memory)
 */
export function openPrimeMemoryStore(dataDir, logger) {
    const dbPath = path.join(dataDir, 'memory.db');
    let DatabaseSyncCtor;
    try {
        // 动态 require:Node <22.5 没有 node:sqlite,require 抛错 → 降级
        const mod = require('node:sqlite');
        DatabaseSyncCtor = mod?.DatabaseSync;
    }
    catch {
        DatabaseSyncCtor = undefined;
    }
    if (!DatabaseSyncCtor) {
        logger.warn(`[recall-rebuild] node:sqlite 不可用(需要 Node >=22.5),记忆读取停用`);
        return disabledStore('node:sqlite 不可用');
    }
    let db = null;
    try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    }
    catch (err) {
        logger.warn(`[recall-rebuild] 无法以只读方式打开 prime-memory 记忆库 ${dbPath}: ${errDetail(err)}。` +
            `请先安装并运行 dsh-prime-memory 生成记忆库;若数据目录不同,请在 config.dataDir 指定`);
        return disabledStore('记忆库打不开');
    }
    // 探测 l1_records / l1_fts 是否存在(旧版或损坏库:纯 LIKE 或空结果,不抛)
    let hasFts = false;
    try {
        const probe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('l1_fts','l1_records')").all();
        hasFts = probe.some((r) => r.name === 'l1_fts');
    }
    catch {
        hasFts = false;
    }
    return {
        ok: true,
        label: dbPath,
        search(query, limit) {
            if (!db)
                return [];
            // 两路召回:FTS(拉丁词高精度)与 LIKE 覆盖度打分(中文兜底),末了 RRF 融合。
            // 不能像旧版那样「FTS 有结果就直接返回」——中文查询下 FTS 偶尔命中一条弱相关,
            // 反而把 LIKE 里更相关的整句挤掉;两路都跑才谈得上召回率。
            const lists = [];
            const fts = sanitizeFts(query);
            // 优先 FTS5 BM25(l1_fts 与 prime-memory 检索同源)
            if (hasFts && fts) {
                try {
                    const rows = db.prepare(`SELECT record_id, content_original AS content, type, scene_name, family, priority, timestamp_str
             FROM l1_fts
             WHERE l1_fts MATCH ?
             ORDER BY bm25(l1_fts) ASC
             LIMIT ?`).all(fts, limit);
                    lists.push(rows.map(mapRow));
                }
                catch {
                    /* FTS 失败 → 落到 LIKE 兜底 */
                }
            }
            // 召回通道:宽松 OR 只负责「别漏」,排名靠后也无所谓 —— 交给 RRF 融合
            const relaxed = sanitizeFtsRelaxed(query);
            if (hasFts && relaxed && relaxed !== fts) {
                try {
                    const rows = db.prepare(`SELECT record_id, content_original AS content, type, scene_name, family, priority, timestamp_str
             FROM l1_fts
             WHERE l1_fts MATCH ?
             ORDER BY bm25(l1_fts) ASC
             LIMIT ?`).all(relaxed, Math.max(limit * 4, 20));
                    lists.push(rows.map(mapRow));
                }
                catch {
                    /* 宽松通道失败不影响主流程 */
                }
            }
            // LIKE 打分兜底:多词 OR 召回候选,再按「命中词数」在内存里重排。
            // 为什么需要这一步:FTS5 的 unicode61 把一整串中文当成单个词元,中文查询
            // 在 MATCH 上几乎必然 0 命中;而单纯按 priority/time 排序的多词 OR 会把
            // 只命中 1 个泛用二元组的长条目排在命中整句的前面。先宽召回、再按命中
            // 覆盖度打分,才能让最相关的那条稳定进前几名。
            try {
                const words = tokenizeQuery(query).slice(0, MAX_LIKE_WORDS);
                if (words.length === 0)
                    return [];
                const likeOrs = words.map(() => `content LIKE ? OR type LIKE ? OR scene_name LIKE ?`).join(' OR ');
                const params = [];
                for (const w of words) {
                    const like = `%${w.replace(/[%_]/g, ' ')}%`;
                    params.push(like, like, like);
                }
                // 宽召回:候选池放大,给打分留出区分空间(上限防爆内存)
                const pool = Math.max(limit * 8, 40);
                const rows = db.prepare(`SELECT record_id, content, type, scene_name, family, priority, timestamp_str
           FROM l1_records
           WHERE ${likeOrs}
           ORDER BY priority DESC, timestamp_str DESC
           LIMIT ?`).all(...params, pool);
                const scored = rows.map((r) => {
                    const rec = mapRow(r);
                    const hay = `${palaceNorm(rec.content)} ${palaceNorm(rec.type)} ${palaceNorm(rec.sceneName)}`;
                    let hits = 0;
                    for (const w of words)
                        if (hay.includes(w))
                            hits += 1;
                    return { rec, hits };
                });
                scored.sort((a, b) => b.hits - a.hits ||
                    b.rec.priority - a.rec.priority ||
                    (a.rec.timestampStr < b.rec.timestampStr ? 1 : a.rec.timestampStr > b.rec.timestampStr ? -1 : 0));
                lists.push(scored.map((s) => s.rec));
            }
            catch {
                /* 忽略:无检索能力时本轮跳过 */
            }
            // 单字覆盖通道(召回底线):unicode61 把整串中文当一个词元,单字 MATCH 永远
            // 匹配不到,只有 LIKE 子串能救。它精度很低,所以权重压到 0.6 —— 只负责把
            // 「换了说法的同一件事」捞进候选,排序仍由严格通道决定。
            try {
                const chars = [...new Set((query.match(CJK_CHAR_G) ?? []))].filter((c) => !CJK_CHAR_STOP.has(c)).slice(0, MAX_CHAR_WORDS);
                if (chars.length > 0) {
                    const charOrs = chars.map(() => 'content LIKE ?').join(' OR ');
                    const rows = db.prepare(`SELECT record_id, content, type, scene_name, family, priority, timestamp_str
             FROM l1_records
             WHERE ${charOrs}
             ORDER BY priority DESC, timestamp_str DESC
             LIMIT ?`).all(...chars.map((c) => `%${c}%`), Math.max(limit * 8, 40));
                    const charScored = rows.map((r) => {
                        const rec = mapRow(r);
                        const hay = palaceNorm(rec.content);
                        let hits = 0;
                        for (const c of chars)
                            if (hay.includes(c))
                                hits += 1;
                        return { rec, hits };
                    });
                    charScored.sort((a, b) => b.hits - a.hits);
                    if (charScored.length > 0)
                        lists.push(charScored.map((s) => s.rec));
                }
            }
            catch {
                /* 单字通道失败不影响其他通道 */
            }
            return fuseRanked(lists, limit, lists.length === 4 ? [1, 0.8, 1, 0.6] : undefined);
        },
        close() {
            try {
                db?.close();
            }
            catch { /* 忽略 */ }
            db = null;
        },
    };
}
const palaceNorm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
function palaceMtimeDate(file) {
    try {
        const st = fs.statSync(file);
        const d = new Date(st.mtimeMs);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    }
    catch {
        return '';
    }
}
/** 长期记忆文件候选(存在才收集)。 */
function collectPalaceFiles(cwd) {
    const home = os.homedir();
    const candidates = [
        { file: path.join(home, '.deepseek-harness', 'MEMORY.md'), rel: '~/.deepseek-harness/MEMORY.md' },
        { file: path.join(cwd, '.deepseek-harness', 'MEMORY.md'), rel: '<cwd>/.deepseek-harness/MEMORY.md' },
        { file: path.join(cwd, '.deepseek-harness', 'memory', 'MEMORY.md'), rel: '<cwd>/.deepseek-harness/memory/MEMORY.md' },
    ];
    return candidates.filter((c) => fs.existsSync(c.file));
}
/** 每日日志候选(最近 limit 份,按日期降序)。 */
function collectPalaceLogs(cwd, limit = 3) {
    const dir = path.join(cwd, '.deepseek-harness', 'memory');
    let names = [];
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    return names
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((n) => ({
        file: path.join(dir, n),
        rel: `<cwd>/.deepseek-harness/memory/${n}`,
        date: n.slice(0, 10),
    }));
}
/** 解析单个 palace Markdown 文件为条目列表(只读;结构行/墓碑跳过)。 */
function parsePalaceFile(file, rel, ts) {
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    let section = '';
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const t = (lines[i] ?? '').trim();
        if (!t || t.startsWith('<!--'))
            continue;
        const sec = /^##\s+(.+?)\s*$/.exec(t);
        if (sec) {
            section = (sec[1] ?? '').trim();
            continue;
        }
        if (t.startsWith('#') || t.includes('~~'))
            continue; // 结构行与墓碑(已删除)不参与检索
        const content = t.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
        if (!content)
            continue;
        out.push({ rel, section, lineNo: i + 1, content, ts });
    }
    return out;
}
/** 打开 dsh-memory-palace 的只读记忆源(cwd = DSH 工作目录,用于定位工作区记忆)。 */
export function openPalaceStore(cwd, logger) {
    const files = collectPalaceFiles(cwd);
    const logs = collectPalaceLogs(cwd);
    const entries = [];
    for (const f of files)
        entries.push(...parsePalaceFile(f.file, f.rel, palaceMtimeDate(f.file)));
    for (const l of logs)
        entries.push(...parsePalaceFile(l.file, l.rel, l.date));
    if (entries.length === 0) {
        logger.warn(`[recall-rebuild] 未找到 memory-palace 记忆文件(检查 ~/.deepseek-harness/MEMORY.md 或 ` +
            `<cwd>/.deepseek-harness/MEMORY.md、每日日志),记忆读取停用`);
        return disabledStore('未找到 memory-palace 记忆文件');
    }
    const sources = [...new Set(entries.map((e) => e.rel))];
    return {
        ok: true,
        label: `dsh-memory-palace (${sources.join(', ')})`,
        search(query, limit) {
            const words = tokenizeQuery(query);
            if (words.length === 0)
                return [];
            const scored = [];
            for (const e of entries) {
                const nl = palaceNorm(e.content);
                let hits = 0;
                for (const w of words)
                    if (nl.includes(w))
                        hits += 1;
                if (hits > 0)
                    scored.push({ e, hits });
            }
            // 命中词数 × 时效衰减(见 rankMemories):命中的都一样多时,不会永远让老条目占位
            const ranked = scored
                .slice(0, Math.max(limit * 8, 40))
                .map(({ e, hits }) => ({
                id: `${e.rel}#L${e.lineNo}`,
                content: e.content,
                type: 'palace',
                sceneName: e.section,
                family: e.rel,
                priority: hits,
                timestampStr: e.ts,
            }));
            return rankMemories(ranked, limit, Date.now());
        },
        close() {
            /* 无资源 */
        },
    };
}
/** epoch ms → 本地时区 YYYY-MM-DD;非法值返回空串。 */
function epochToDate(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
        return '';
    const d = new Date(ms);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}
/** 解析单个 dsh-memory JSON 库文件为生效记录(只读;跳过 suggested/隔离/prompt/结构异常)。 */
function parseDshMemoryFile(file, rel) {
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return [];
    }
    const blocks = doc?.unit?.tables?.blocks;
    if (!Array.isArray(blocks))
        return [];
    const out = [];
    for (const raw of blocks) {
        const b = raw;
        if (!b || typeof b !== 'object')
            continue;
        if (b.status !== 'approved')
            continue; // suggested 未生效
        if (b.quarantined === true)
            continue; // 隔离记录不进检索
        if (b.kind === 'prompt')
            continue; // 模板索引非用户记忆
        const content = typeof b.content === 'string' ? b.content.trim() : '';
        if (!content)
            continue;
        out.push({
            id: typeof b.id === 'string' ? b.id : '',
            content,
            namespace: b.namespace === 'project' ? 'project' : 'global',
            keywords: Array.isArray(b.keywords) ? b.keywords.filter((k) => typeof k === 'string') : [],
            updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
            rel,
        });
    }
    return out;
}
/**
 * 打开 @max-null/dsh-memory 的只读记忆源。
 * @param cwd DSH 工作目录(用于定位 project 记忆)
 */
export function openDshMemoryStore(cwd, logger) {
    // global:join(DSH_HOME ?? ~/.dsh, 'storages', 'memory.json')
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const globalFile = path.join(home, 'storages', 'memory.json');
    // project:<cwd>/.dsh/storages/*.json(每个 backend 一个文件)
    const projectDir = path.join(cwd, '.dsh', 'storages');
    const entries = [];
    if (fs.existsSync(globalFile)) {
        entries.push(...parseDshMemoryFile(globalFile, '<DSH_HOME>/storages/memory.json'));
    }
    let projectNames = [];
    try {
        projectNames = fs.readdirSync(projectDir).filter((n) => n.endsWith('.json'));
    }
    catch {
        /* 无 project 记忆 */
    }
    for (const n of projectNames) {
        if (n === 'query-log.json')
            continue; // 查询日志非记忆库
        const f = path.join(projectDir, n);
        entries.push(...parseDshMemoryFile(f, `<cwd>/.dsh/storages/${n}`));
    }
    if (entries.length === 0) {
        logger.warn(`[recall-rebuild] 未找到 dsh-memory 记忆文件(检查 <DSH_HOME>/storages/memory.json 或 ` +
            `<cwd>/.dsh/storages/*.json),记忆读取停用`);
        return disabledStore('未找到 dsh-memory 记忆文件');
    }
    const sources = [...new Set(entries.map((e) => e.rel))];
    return {
        ok: true,
        label: `@max-null/dsh-memory (${sources.join(', ')})`,
        search(query, limit) {
            const words = tokenizeQuery(query);
            if (words.length === 0)
                return [];
            const scored = [];
            for (const e of entries) {
                const cNorm = palaceNorm(e.content);
                let hits = 0;
                for (const w of words) {
                    if (cNorm.includes(w))
                        hits += 1;
                    // keywords 命中更精准,权重 ×2
                    for (const k of e.keywords)
                        if (palaceNorm(k).includes(w))
                            hits += 2;
                }
                if (hits > 0)
                    scored.push({ e, hits });
            }
            // 命中权重 × 时效衰减(见 rankMemories)
            const ranked = scored.slice(0, Math.max(limit * 8, 40)).map(({ e, hits }) => ({
                id: `${e.rel}#${e.id}`,
                content: e.content,
                type: 'dsh-memory',
                sceneName: e.namespace === 'project' ? 'project 记忆' : 'global 记忆',
                family: e.rel,
                priority: hits,
                timestampStr: epochToDate(e.updatedAt),
            }));
            return rankMemories(ranked, limit, Date.now());
        },
        close() {
            /* 无资源 */
        },
    };
}
/** 记忆来源路由:auto 探测 prime → dsh-memory → palace,或按 source 显式指定。 */
export function openMemorySource(source, opts) {
    const { dataDir, cwd, logger } = opts;
    if (source === 'prime')
        return openPrimeMemoryStore(dataDir, logger);
    if (source === 'dsh-memory')
        return openDshMemoryStore(cwd, logger);
    if (source === 'palace')
        return openPalaceStore(cwd, logger);
    // auto:prime-memory 库存在则优先(打开失败依次落 dsh-memory / palace),否则尝试后两者
    const primeDb = path.join(dataDir, 'memory.db');
    if (fs.existsSync(primeDb)) {
        const s = openPrimeMemoryStore(dataDir, logger);
        if (s.ok)
            return s;
        logger.warn(`[recall-rebuild] prime-memory 库存在但打不开,尝试 dsh-memory / memory-palace 记忆源`);
    }
    const dm = openDshMemoryStore(cwd, logger);
    if (dm.ok)
        return dm;
    const p = openPalaceStore(cwd, logger);
    if (p.ok)
        return p;
    return disabledStore('未检测到 prime-memory / dsh-memory / memory-palace 记忆库');
}
