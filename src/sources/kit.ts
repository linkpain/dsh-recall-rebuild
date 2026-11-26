/**
 * 通用记忆源读取原语(readers)。
 *
 * 设计意图:生态里 40+ 个记忆插件没有统一存储格式,但底层只有四种形态 ——
 * SQLite 库 / Markdown+frontmatter / JSON 单文件 / JSONL 追加日志。
 * 这里把这四种形态的「读取」与「插件特化」彻底分开:
 *   - 本文件只负责「把任意文件读成 Doc[]」,不认识任何具体插件;
 *   - 具体插件在 sqlite-sources.ts / file-sources.ts 里只用几行描述路径与过滤条件。
 *
 * 设计铁律(与 store.ts 一致):
 * - 只读:绝不写任何被读文件。
 * - 零运行时依赖:只用 node:fs / node:path / node:sqlite。
 * - 永不抛错:任何读取失败都退化为空结果,由调用方决定是否降级。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildCharNgramVector,
  cosineSimilarity,
  fuseRanked,
  lengthFactor,
  rankMemories,
  rerankBySemantic,
  queryCharTerms,
  SEMANTIC_MIN_SIM,
  tokenizeQuery,
} from '../store.js';
import type { LoggerLike, MemoryRecord, MemoryStore } from '../store.js';

const require = createRequire(import.meta.url);

/* ── 路径 ─────────────────────────────────────────────────── */

/** DSH 状态根:DSH_HOME 优先,否则 ~/.dsh。 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (env) return env;
  return path.join(os.homedir(), '.dsh');
}

export function userHome(): string {
  return os.homedir();
}

/** 文件存在且是普通文件。 */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 目录存在。 */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 安全读文本(带 BOM 剥离与体积上限)。 */
export function readText(file: string, maxBytes = 8 * 1024 * 1024): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

/* ── 统一文档模型 ─────────────────────────────────────────── */

/** 一条待索引的记忆条目(与 MemoryRecord 解耦,便于各读取器独立产出)。 */
export interface Doc {
  id: string;
  text: string;
  /** 标题/标签等「高价值字段」,命中时加权。 */
  hints: string[];
  /** 展示用场景名(章节、记忆层、类型)。 */
  scene: string;
  /** 来源族(文件相对路径或表名),用于展示与去重。 */
  family: string;
  type: string;
  /** YYYY-MM-DD;空串表示无时间线索(不参与衰减惩罚)。 */
  ts: string;
  /** 时间戳原值(毫秒),用于无日期时排序。 */
  rawTs?: number;
  /** 作用域标签(global / workspace / project / session),空 = 未知。 */
  scope?: string;
}

export const normText = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const DAY_MS = 86_400_000;

/** 任意时间值 → 毫秒时间戳(秒/毫秒自动判别);非法返回 0。 */
export function toEpochMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v > 1e11 ? v : v * 1000; // >1e11 视为毫秒,否则按秒
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return 0;
    if (/^\d+(\.\d+)?$/.test(s)) return toEpochMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** 毫秒时间戳 → 本地 YYYY-MM-DD;0 → 空串。 */
export function epochToDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return String(d.getFullYear()) + '-' + mm + '-' + dd;
}

/** 任意时间值 → YYYY-MM-DD。 */
export function toDateStr(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  return epochToDate(toEpochMs(v));
}

/** 文件 mtime → YYYY-MM-DD(读不到返回空串)。 */
export function mtimeDate(file: string): string {
  try {
    return epochToDate(fs.statSync(file).mtimeMs);
  } catch {
    return '';
  }
}

/* ── 文本记忆源(通用检索) ────────────────────────────────── */

/* 通用源通道权重。精度高的词元通道给满权;单字覆盖精度最低、只负责
 * 「二元组全落空时别漏」,给 0.6;语义通道能跨同义改写但会奖励词多的条目,
 * 给 0.7 —— 与 prime 适配器的 W_CHAR / W_SEMANTIC 同口径,便于两处对照。 */
const GENERIC_W_WORD = 1;
const GENERIC_W_CHAR = 0.6;
const GENERIC_W_SEMANTIC = 0.7;

/** 预建字符 n-gram 向量的条数上限:向量是每篇一份特征表,超量会成倍吃内存。 */
const VEC_MAX_DOCS = 4000;

/**
 * 把一批 Doc 变成 MemoryStore:
 * 命中词数 × 高价值字段加权 × 时效衰减,复用 store.ts 的统一排序出口。
 *
 * reload/refreshMs:通用源打开时一次性把条目读进内存(比每次检索都扫盘快两个数量级),
 * 代价是读一次就定住了 —— 插件启动后新写入的记忆要重启才看得见。传了 reload 就按
 * refreshMs 间隔在检索路径上重读(至多多付一次读盘,不额外起定时器),让「边聊边记」
 * 的记忆库跟上。重读失败或读到空时沿用旧快照:宁可旧一点,也不要检索突然全空。
 */
export function makeTextStore(
  label: string,
  docs: Doc[],
  logger: LoggerLike,
  opts: { reload?: () => Doc[]; refreshMs?: number } = {},
): MemoryStore {
  if (docs.length === 0) {
    logger.warn('[recall-rebuild] ' + label + ':未读到任何记忆条目,该源跳过');
    return { ok: false, label, search: () => [], close: () => { /* 无资源 */ } };
  }
  const prepare = (list: Doc[]): Array<{ doc: Doc; body: string; hints: string; vec: Map<string, number> }> =>
    list.map((d, i) => ({
      doc: d,
      body: normText(d.text),
      hints: normText(d.hints.join(' ')),
      // 语义通道的特征向量一次建好:检索时只算查询侧,不重复解析正文。
      // 但向量是「每篇一份特征表」,超大语料会成倍吃内存 —— 超过 VEC_MAX_DOCS
      // 就不再预建,该批条目只走词元与单字通道(有损,但不至于把内存吃穿)。
      vec: i < VEC_MAX_DOCS ? buildCharNgramVector(d.text + ' ' + d.hints.join(' ')) : new Map(),
    }));
  let prepared = prepare(docs);
  let loadedAt = Date.now();
  const refreshMs = opts.refreshMs ?? 0;
  const families = [...new Set(docs.map((d) => d.family))];
  return {
    ok: true,
    label: label + ' (' + families.length + ' 个文件/表,' + docs.length + ' 条)',
    search(query: string, limit: number): MemoryRecord[] {
      if (opts.reload && refreshMs > 0 && Date.now() - loadedAt >= refreshMs) {
        loadedAt = Date.now();
        try {
          const fresh = opts.reload();
          if (fresh.length > 0) prepared = prepare(fresh);
        } catch {
          /* 刷新失败:沿用旧快照,下个窗口再试 */
        }
      }
      const words = tokenizeQuery(query);
      if (words.length === 0) return [];
      const toRec = (p: { doc: Doc }): MemoryRecord => ({
        id: p.doc.id,
        content: p.doc.text,
        type: p.doc.type,
        sceneName: p.doc.scene,
        family: p.doc.family,
        priority: 0,
        timestampStr: p.doc.ts,
      });
      // 四路候选,末了 RRF 融合 —— 与 prime 适配器同一套方法论。
      // 旧实现只有「命中词数」一条路:二元组一个都不重合时全空,而多命中一个
      // 泛用二元组的流水账反倒压过直击要害的那条。分通道后各管一段:
      // 词元通道保精度、单字通道保召回、语义通道跨同义改写。
      const lists: MemoryRecord[][] = [];
      const weights: number[] = [];
      /** 各通道给出的真实相关度(取最大值),供末尾的时效衰减乘算。 */
      const baseScore = new Map<string, number>();
      const noteScore = (id: string, s: number): void => {
        if (s > (baseScore.get(id) ?? 0)) baseScore.set(id, s);
      };

      // 通道 1:词元覆盖(原打分,保留为主通道)
      const wordHits: Array<{ rec: MemoryRecord; score: number }> = [];
      for (const p of prepared) {
        let hits = 0;
        for (const w of words) {
          if (p.body.includes(w)) hits += 1;
          // 标题/标签命中比正文命中更精准:同一词命中标题说明这条记忆「就是讲这个的」
          if (p.hints.includes(w)) hits += 1.5;
        }
        if (hits <= 0) continue;
        // 命中词数按正文长度归一化:长文不白拿「顺带提到」的红利
        const score = hits * lengthFactor(p.body.length);
        noteScore(p.doc.id, score);
        wordHits.push({ rec: toRec(p), score });
      }
      wordHits.sort((a, b) => b.score - a.score);
      if (wordHits.length > 0) {
        lists.push(wordHits.map((x) => x.rec));
        weights.push(GENERIC_W_WORD);
      }

      // 通道 2:单字覆盖 —— 二元组全部落空时的兜底召回
      const chars = queryCharTerms(query);
      if (chars.length > 0) {
        const charHits: Array<{ rec: MemoryRecord; score: number }> = [];
        for (const p of prepared) {
          let hits = 0;
          for (const c of chars) {
            if (p.body.includes(c)) hits += 1;
            if (p.hints.includes(c)) hits += 0.5;
          }
          if (hits <= 0) continue;
          const score = hits * lengthFactor(p.body.length) * GENERIC_W_CHAR;
          noteScore(p.doc.id, score);
          charHits.push({ rec: toRec(p), score });
        }
        charHits.sort((a, b) => b.score - a.score);
        if (charHits.length > 0) {
          lists.push(charHits.map((x) => x.rec));
          weights.push(GENERIC_W_CHAR);
        }
      }

      // 通道 3:字符 n-gram 余弦 —— 唯一能跨过「零字面重叠」的通道
      const qv = buildCharNgramVector(query);
      if (qv.size > 0) {
        const sem: Array<{ rec: MemoryRecord; sim: number }> = [];
        for (const p of prepared) {
          const sim = cosineSimilarity(qv, p.vec);
          if (sim < SEMANTIC_MIN_SIM) continue;
          // 余弦(0–1)放大到与词元命中同一量级,避免语义独中时被衰减压没
          noteScore(p.doc.id, sim * 10 * GENERIC_W_SEMANTIC);
          sem.push({ rec: toRec(p), sim });
        }
        sem.sort((a, b) => b.sim - a.sim);
        if (sem.length > 0) {
          lists.push(sem.map((x) => x.rec));
          weights.push(GENERIC_W_SEMANTIC);
        }
      }

      if (lists.length === 0) return [];
      // 先放大融合池(精排要有候选可挑),再语义精排,最后截断到调用方要的条数。
      const fused = fuseRanked(lists, Math.max(limit * 4, 40), weights);
      const reranked = rerankBySemantic(fused, query);
      // 把各通道的真实相关度还原成 priority 再交给 rankMemories —— 那里算的是
      // priority × 时效衰减。若 priority 恒为 0(或改用名次序号),乘出来的衰减
      // 就退化成「名次决定一切」:同样相关的一老一新两条记忆,老的永远压住新的。
      const ranked = reranked.map((r, i) => ({
        ...r,
        priority: baseScore.get(r.id) ?? Math.max(0, reranked.length - i) * 1e-6,
      }));
      return rankMemories(ranked, limit, Date.now());
    },
    close(): void {
      /* 纯内存,无资源 */
    },
  };
}

/**
 * 把多个已打开的源合成一个:检索时并行问每个源,再用 RRF 融合。
 *
 * 为什么需要:真实用户常同时装着两三个记忆插件(比如 palace 记长期偏好、
 * prime 记事实)。只挑「第一个能读的」会白白丢掉其它库里的记忆,
 * 而 RRF 只看排名不看分数,天然能融合量纲不同的多路结果。
 */
export function combineStores(label: string, stores: MemoryStore[], logger: LoggerLike): MemoryStore {
  const live = stores.filter((s) => s.ok);
  if (live.length === 0) {
    return { ok: false, label, search: () => [], close: () => { /* 无资源 */ } };
  }
  if (live.length === 1) {
    const only = live[0] as MemoryStore;
    return {
      ok: true,
      label: only.label,
      search: (q, n) => only.search(q, n),
      close: () => only.close(),
    };
  }
  return {
    ok: true,
    label: label + ': ' + live.map((s) => s.label).join(' + '),
    search(query: string, limit: number): MemoryRecord[] {
      // 每路多取一些:融合后仍要保证有足够候选供 RRF 排序
      const perSource = Math.max(limit * 3, 12);
      const lists = live.map((s) => {
        try {
          return s.search(query, perSource);
        } catch {
          return [];
        }
      });
      const fused = fuseRanked(lists, limit * 2);
      // 同一句话可能被两个插件各存一份:按正文归一化去重,保留排名靠前的那条
      const seen = new Set<string>();
      const out: MemoryRecord[] = [];
      for (const rec of fused) {
        const key = normText(rec.content).slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
        if (out.length >= limit) break;
      }
      if (out.length === 0) {
        logger.debug?.('[recall-rebuild] 多源融合无命中: ' + query);
      }
      return out;
    },
    close(): void {
      for (const s of live) {
        try {
          s.close();
        } catch {
          /* 单个源关闭失败不影响其它 */
        }
      }
    },
  };
}

/* ── Markdown + frontmatter ───────────────────────────────── */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

/** 解析 YAML-ish frontmatter(只处理 key: value 与 key: 换行 - item 两种形态,够用且零依赖)。 */
export function parseFrontmatter(text: string): Frontmatter {
  const data: Record<string, string | string[]> = {};
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data, body: text };
  const head = m[1] ?? '';
  const body = text.slice(m[0].length);
  let lastKey = '';
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && lastKey) {
      const v = stripQuotes((listItem[1] ?? '').trim());
      const prev = data[lastKey];
      data[lastKey] = Array.isArray(prev) ? [...prev, v] : prev ? [prev, v] : [v];
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? '';
    const val = (kv[2] ?? '').trim();
    lastKey = key;
    if (val === '') {
      data[key] = [];
      continue;
    }
    data[key] = stripQuotes(val);
  }
  return { data, body };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** frontmatter 值 → 字符串。 */
export function fmString(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return '';
}

/** frontmatter 值 → 字符串数组。 */
export function fmList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v) return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Markdown 正文 → 条目列表。
 * 列表型文档(每行 "- 事实")按行切;整段型文档(灵枢节点、Obsidian 笔记)整段保留。
 */
export function splitMarkdownBody(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let meaningful = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('<!--')) continue;
    meaningful += 1;
    if (/^#{1,6}\s/.test(t)) continue;      // 标题是结构行
    if (t.includes('~~')) continue;          // 墓碑(已删除)
    const m = /^[-*+]\s+(.*)$/.exec(t);
    if (m) items.push((m[1] ?? '').trim());
  }
  if (items.length >= 2 && items.length >= meaningful * 0.6) return items.filter(Boolean);
  const whole = body.trim();
  return whole ? [whole] : [];
}

/** 读一个 Markdown 文件为 Doc[](支持 frontmatter 与列表型正文)。 */
export function readMarkdownDocs(file: string, rel: string, type: string, fallbackTs?: string): Doc[] {
  const text = readText(file);
  if (!text) return [];
  const { data, body } = parseFrontmatter(text);
  const ts =
    toDateStr(fmString(data['updated_at'] ?? data['updatedAt'] ?? data['created_at'] ?? data['date'])) ||
    fallbackTs ||
    mtimeDate(file);
  const title = fmString(data['title'] ?? data['name'] ?? data['description']);
  const tags = fmList(data['tags'] ?? data['keywords']);
  const scene = fmString(data['layer'] ?? data['type'] ?? data['kind'] ?? data['status']) || type;
  const scope = fmString(data['scope'] ?? data['namespace'] ?? data['space']);
  const items = splitMarkdownBody(body);
  const out: Doc[] = [];
  items.forEach((item, i) => {
    const content = [title, item].filter(Boolean).join(' — ');
    out.push({
      id: rel + '#' + (i + 1),
      text: content.length > 4000 ? content.slice(0, 4000) : content,
      hints: [title, ...tags].filter(Boolean),
      scene,
      family: rel,
      type,
      ts,
      scope,
    });
  });
  return out;
}

/* ── 目录遍历 ─────────────────────────────────────────────── */

export interface WalkOptions {
  exts?: string[];
  maxFiles?: number;
  /** 跳过这些子目录名(node_modules 等永远跳过)。 */
  skipDirs?: string[];
}

const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

/** 递归收集文件(深度优先,按修改时间新→旧排序,受 maxFiles 限制)。 */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const exts = (opts.exts ?? ['.md']).map((e) => e.toLowerCase());
  const maxFiles = opts.maxFiles ?? 5000;
  const skip = new Set([...ALWAYS_SKIP, ...(opts.skipDirs ?? [])]);
  const out: Array<{ file: string; mtime: number }> = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles * 2) {
    const dir = stack.pop() as string;
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skip.has(ent.name)) stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!exts.includes(path.extname(ent.name).toLowerCase())) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      out.push({ file: full, mtime });
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxFiles)
    .map((x) => x.file);
}

/* ── JSON / JSONL 嗅探 ────────────────────────────────────── */

/** 文本字段候选名(按优先级)。 */
const TEXT_KEYS = [
  'content', 'text', 'body', 'summary', 'fact', 'memory', 'note', 'value',
  'description', 'detail', 'message', 'question', 'answer', 'title',
];
/** 时间字段候选名。 */
const TIME_KEYS = [
  'updated_at', 'updatedAt', 'last_access', 'lastAccess', 'created_at', 'createdAt',
  'recorded_at', 'valid_from', 'ts', 'time', 'timestamp', 'date', 'at',
];
/** 标签字段候选名。 */
const TAG_KEYS = ['tags', 'keywords', 'entities', 'labels'];
/** 作用域字段候选名。 */
const SCOPE_KEYS = [
  'scope', 'scope_key', 'scopeKey', 'workspace_id', 'workspaceId', 'workspace',
  'namespace', 'space', 'family', 'project',
];
/** 类型/层字段候选名。 */
const TYPE_KEYS = ['kind', 'type', 'category', 'layer', 'role', 'status', 'lifecycle_state'];
/** 删除/失效标记。 */
const DEAD_STATUS = new Set([
  'deleted', 'superseded', 'archived', 'forgotten', 'dormant', 'rejected', 'quarantined', 'invalid',
]);

function firstKey(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (k in obj && obj[k] !== null && obj[k] !== undefined) return k;
  return undefined;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** 对象是否像一条记忆(有可读正文且不是已删除态)。 */
function looksLikeDoc(obj: Record<string, unknown>): boolean {
  const tk = firstKey(obj, TEXT_KEYS);
  if (!tk) return false;
  if (!asText(obj[tk]).trim()) return false;
  const sk = firstKey(obj, ['status', 'lifecycle_state', 'state']);
  if (sk && DEAD_STATUS.has(asText(obj[sk]).toLowerCase())) return false;
  return true;
}

function tagsOf(obj: Record<string, unknown>): string[] {
  const k = firstKey(obj, TAG_KEYS);
  if (!k) return [];
  const v = obj[k];
  if (Array.isArray(v)) return v.map((t) => asText(t)).filter(Boolean);
  return asText(v)
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/)
    .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(Boolean);
}

/**
 * 从任意 JSON 结构里收割记忆条目。
 * 不假设固定 schema:先看对象本身是否像记忆,不像就递归子值。
 * 这样同一份代码能吃 entries:[]、[[{...}]]、{a:{b:[{...}]}} 等所有包装形态。
 */
export function harvestJson(
  value: unknown,
  rel: string,
  type: string,
  out: Doc[],
  depth = 0,
  budget = { left: 5000 },
): void {
  if (budget.left <= 0 || depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (budget.left <= 0) return;
      harvestJson(item, rel, type, out, depth + 1, budget);
    }
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (looksLikeDoc(obj)) {
      budget.left -= 1;
      const text = asText(obj[firstKey(obj, TEXT_KEYS) as string]).trim();
      if (!text) return;
      const title = asText(obj['title'] ?? obj['name']);
      const tags = tagsOf(obj);
      const tKey = firstKey(obj, TIME_KEYS);
      const tsRaw = tKey ? obj[tKey] : undefined;
      out.push({
        id: rel + '#' + (asText(obj['id'] ?? obj['uuid'] ?? obj['key']) || out.length + 1),
        text: [title, text].filter(Boolean).join(' — ').slice(0, 4000),
        hints: [title, ...tags].filter(Boolean),
        scene: asText(obj[firstKey(obj, TYPE_KEYS) as string]) || type,
        family: rel,
        type,
        ts: toDateStr(tsRaw),
        rawTs: toEpochMs(tsRaw),
        scope: asText(obj[firstKey(obj, SCOPE_KEYS) as string]),
      });
      return;
    }
    for (const v of Object.values(obj)) {
      if (budget.left <= 0) return;
      harvestJson(v, rel, type, out, depth + 1, budget);
    }
  }
}

/** 读一个 JSON 文件为 Doc[]。 */
export function readJsonDocs(file: string, rel: string, type: string): Doc[] {
  const text = readText(file);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Doc[] = [];
  harvestJson(parsed, rel, type, out);
  return out;
}

/** 读一个 JSONL 文件为 Doc[](逐行解析,坏行跳过;只读尾部 maxLines 行)。 */
export function readJsonlDocs(file: string, rel: string, type: string, maxLines = 5000): Doc[] {
  const text = readText(file);
  if (!text) return [];
  let lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  const out: Doc[] = [];
  const budget = { left: maxLines };
  for (const line of lines) {
    if (budget.left <= 0) break;
    try {
      harvestJson(JSON.parse(line), rel, type, out, 0, budget);
    } catch {
      /* 坏行跳过:追加日志写到一半是常态 */
    }
  }
  return out;
}

/* ── SQLite 只读 ──────────────────────────────────────────── */

export interface SqliteRow {
  [k: string]: unknown;
}

interface StatementLike {
  all(...args: unknown[]): SqliteRow[];
}

export interface DbLike {
  prepare(sql: string): StatementLike;
  close(): void;
}

type DbCtor = new (file: string, options: { readOnly: boolean }) => DbLike;

let cachedCtor: DbCtor | null | undefined;

/** 取 node:sqlite 的 DatabaseSync(Node <22.5 返回 null)。 */
export function sqliteCtor(): DbCtor | null {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    cachedCtor = (mod?.DatabaseSync as DbCtor | undefined) ?? null;
  } catch {
    cachedCtor = null;
  }
  return cachedCtor;
}

/** 只读打开 SQLite 库;失败返回 null(绝不抛错)。 */
export function openSqlite(file: string): DbLike | null {
  const Ctor = sqliteCtor();
  if (!Ctor) return null;
  try {
    return new Ctor(file, { readOnly: true });
  } catch {
    return null;
  }
}

/** 列出库里的表名(排除 FTS 影子表)。 */
export function listTables(db: DbLike): string[] {
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    return rows
      .map((r) => asText(r['name']))
      .filter((n) => n && !/_fts(_|$)/.test(n) && !/^sqlite_/.test(n));
  } catch {
    return [];
  }
}

/** 表是否含某列(用 PRAGMA 读列名,避免 SELECT * 撞上不存在的列)。 */
export function tableColumns(db: DbLike, table: string): string[] {
  try {
    const rows = db.prepare('PRAGMA table_info("' + table.replace(/"/g, '""') + '")').all();
    return rows.map((r) => asText(r['name'])).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 按候选列名把一行映射成 Doc。
 * 这是「格式嗅探」的核心:不写死某插件的列名,只要求它叫得像记忆。
 */
export function rowToDoc(
  row: SqliteRow,
  cols: string[],
  ctx: { rel: string; type: string; index: number },
): Doc | null {
  const pick = (keys: string[]): unknown => {
    for (const k of keys) {
      if (cols.includes(k)) {
        const v = row[k];
        if (v !== null && v !== undefined && v !== '') return v;
      }
    }
    return undefined;
  };
  const text = asText(pick(TEXT_KEYS)).trim();
  const title = asText(pick(['title', 'name', 'heading'])).trim();
  const body = text || title;
  if (!body) return null;
  const status = asText(pick(['status', 'lifecycle_state', 'state'])).toLowerCase();
  if (status && DEAD_STATUS.has(status)) return null;
  const tsRaw = pick(TIME_KEYS);
  const tagsRaw = pick(TAG_KEYS);
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => asText(t)).filter(Boolean)
    : asText(tagsRaw)
        .replace(/^\[|\]$/g, '')
        .split(/[,，]/)
        .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, ''))
        .filter(Boolean);
  const content = text && title && !text.startsWith(title) ? title + ' — ' + text : body;
  return {
    id: ctx.rel + '#' + (asText(pick(['id', 'record_id', 'uuid', 'key', 'ord'])) || ctx.index),
    text: content.slice(0, 4000),
    hints: [title, ...tags].filter(Boolean),
    scene: asText(pick(TYPE_KEYS)) || ctx.type,
    family: ctx.rel,
    type: ctx.type,
    ts: toDateStr(tsRaw),
    rawTs: toEpochMs(tsRaw),
    scope: asText(pick(SCOPE_KEYS)),
  };
}

/** 从库里的若干候选表中读行 → Doc[]。 */
export function readSqliteDocs(
  db: DbLike,
  dbLabel: string,
  tableNames: string[],
  type: string,
  limitPerTable = 5000,
): Doc[] {
  const out: Doc[] = [];
  for (const table of tableNames) {
    const cols = tableColumns(db, table);
    if (cols.length === 0) continue;
    const hasText =
      TEXT_KEYS.some((k) => cols.includes(k)) || cols.includes('title') || cols.includes('name');
    if (!hasText) continue;
    let rows: SqliteRow[] = [];
    try {
      rows = db.prepare('SELECT * FROM "' + table.replace(/"/g, '""') + '" LIMIT ' + limitPerTable).all();
    } catch {
      continue;
    }
    const rel = dbLabel + ':' + table;
    rows.forEach((row, i) => {
      const doc = rowToDoc(row, cols, { rel, type, index: i });
      if (doc) out.push(doc);
    });
  }
  return out;
}

/**
 * 通用 SQLite 记忆源:打开库 → 挑表 → 读行 → 映射。
 * 表名候选来自各插件实测;缺表时退化为「所有含正文列的表」。
 */
export function openSqliteSource(
  opts: { label: string; file: string; tables?: string[]; type: string; limitPerTable?: number },
  logger: LoggerLike,
  refreshMs = 0,
): MemoryStore {
  const { label, file, tables, type } = opts;
  if (!isFile(file)) {
    return {
      ok: false,
      label: label + '(未找到 ' + file + ')',
      search: () => [],
      close: () => { /* 无资源 */ },
    };
  }
  const db = openSqlite(file);
  if (!db) {
    logger.warn('[recall-rebuild] ' + label + ':无法以只读方式打开 ' + file + '(node:sqlite 不可用或文件被占用)');
    return { ok: false, label: label + '(库打不开)', search: () => [], close: () => { /* 无资源 */ } };
  }
  const all = listTables(db);
  const wanted = (tables ?? []).filter((t) => all.includes(t));
  const targets = wanted.length > 0 ? wanted : all;
  // 库句柄一直开着,重读只是再跑一遍 SELECT(不重新打开文件、不重建连接)
  const readAll = (): Doc[] => readSqliteDocs(db, label, targets, type, opts.limitPerTable ?? 5000);
  let docs: Doc[] = [];
  try {
    docs = readAll();
  } catch (err) {
    logger.warn('[recall-rebuild] ' + label + ':读取失败 ' + (err instanceof Error ? err.message : String(err)));
  }
  if (docs.length === 0) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    return { ok: false, label: label + '(无记忆行)', search: () => [], close: () => { /* 无资源 */ } };
  }
  const store = makeTextStore(label, docs, logger, { reload: readAll, refreshMs });
  return {
    ok: store.ok,
    label: store.label,
    search: store.search,
    close(): void {
      try {
        db.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 毫秒 → 天数(供源排序/调试用)。 */
export function daysSince(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - ms) / DAY_MS);
}
