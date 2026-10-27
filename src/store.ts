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

/** sqlite 行形状(只取需要的列,缺列容错)。 */
interface SqliteRow {
  record_id?: string;
  content?: string;
  type?: string;
  scene_name?: string;
  family?: string;
  priority?: number;
  timestamp_str?: string;
}

interface DatabaseSyncLike {
  prepare(sql: string): {
    all(...args: unknown[]): SqliteRow[];
  };
  close(): void;
}

/** node:sqlite DatabaseSync 构造器形状(动态 require 后手动收窄)。 */
type DatabaseSyncConstructor = new (file: string, options: { readOnly: boolean }) => DatabaseSyncLike;

function errDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 构建降级空 store(不吞日志,便于诊断)。 */
function disabledStore(label: string): MemoryStore {
  return {
    ok: false,
    label,
    search: () => [],
    close: () => { /* 无资源 */ },
  };
}

/** FTS5/LIKE 检索前的查询清洗:按词拆分(中文以标点/空白为界),过滤停用词。 */
function tokenizeQuery(query: string): string[] {
  const STOP = new Set([
    'and', 'or', 'not', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for',
    'with', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
    'this', 'that', 'what', 'how', 'why', 'when', 'where', 'who', 'do',
    'does', 'did', 'can', 'could', 'will', 'would', 'should', 'have', 'has',
    'you', 'your', 'me', 'my', 'i', 'we', 'our', 'they', 'them', 'he', 'she',
  ]);
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/**
 * FTS5 MATCH 表达式清洗:逐词加双引号、AND 连接,
 * 规避 FTS5 特殊字符(引号/AND/OR/NOT/括号等)导致的语法错误。
 */
export function sanitizeFts(query: string): string {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

function mapRow(r: SqliteRow): MemoryRecord {
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

/**
 * 打开 dsh-prime-memory 的只读记忆库。
 * @param dataDir prime-memory 的数据目录(默认 $DSH_HOME/memory)
 */
export function openPrimeMemoryStore(dataDir: string, logger: LoggerLike): MemoryStore {
  const dbPath = path.join(dataDir, 'memory.db');

  let DatabaseSyncCtor: DatabaseSyncConstructor | undefined;
  try {
    // 动态 require:Node <22.5 没有 node:sqlite,require 抛错 → 降级
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    DatabaseSyncCtor = mod?.DatabaseSync as DatabaseSyncConstructor | undefined;
  } catch {
    DatabaseSyncCtor = undefined;
  }
  if (!DatabaseSyncCtor) {
    logger.warn(`[recall-rebuild] node:sqlite 不可用(需要 Node >=22.5),记忆读取停用`);
    return disabledStore('node:sqlite 不可用');
  }

  let db: DatabaseSyncLike | null = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true }) as DatabaseSyncLike;
  } catch (err) {
    logger.warn(
      `[recall-rebuild] 无法以只读方式打开 prime-memory 记忆库 ${dbPath}: ${errDetail(err)}。` +
        `请先安装并运行 dsh-prime-memory 生成记忆库;若数据目录不同,请在 config.dataDir 指定`,
    );
    return disabledStore('记忆库打不开');
  }

  // 探测 l1_records / l1_fts 是否存在(旧版或损坏库:纯 LIKE 或空结果,不抛)
  let hasFts = false;
  try {
    const probe = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('l1_fts','l1_records')",
    ).all() as unknown as Array<{ name?: string }>;
    hasFts = probe.some((r) => r.name === 'l1_fts');
  } catch {
    hasFts = false;
  }

  return {
    ok: true,
    label: dbPath,
    search(query: string, limit: number): MemoryRecord[] {
      if (!db) return [];
      const out: MemoryRecord[] = [];
      const fts = sanitizeFts(query);
      // 优先 FTS5 BM25(l1_fts 与 prime-memory 检索同源)
      if (hasFts && fts) {
        try {
          const rows = db.prepare(
            `SELECT record_id, content_original AS content, type, scene_name, family, priority, timestamp_str
             FROM l1_fts
             WHERE l1_fts MATCH ?
             ORDER BY bm25(l1_fts) ASC
             LIMIT ?`,
          ).all(fts, limit);
          for (const r of rows) out.push(mapRow(r));
        } catch {
          /* FTS 失败 → 落到 LIKE 兜底 */
        }
      }
      if (out.length > 0) return out.slice(0, limit);
      // LIKE 兜底:主表 content/type/scene_name 模糊匹配(多词 OR,容忍 FTS 分词器
      // 对中文整句不拆分导致的零命中),按优先级+时间倒序
      try {
        const words = tokenizeQuery(query).slice(0, 3);
        if (words.length === 0) return [];
        const likeOrs = words
          .map((w) => {
            const esc = w.replace(/[%_]/g, ' ');
            return `content LIKE ? OR type LIKE ? OR scene_name LIKE ?`;
          })
          .join(' OR ');
        const params: string[] = [];
        for (const w of words) {
          const like = `%${w.replace(/[%_]/g, ' ')}%`;
          params.push(like, like, like);
        }
        const rows = db.prepare(
          `SELECT record_id, content, type, scene_name, family, priority, timestamp_str
           FROM l1_records
           WHERE ${likeOrs}
           ORDER BY priority DESC, timestamp_str DESC
           LIMIT ?`,
        ).all(...params, limit);
        for (const r of rows) out.push(mapRow(r));
      } catch {
        /* 忽略:无检索能力时本轮跳过 */
      }
      return out.slice(0, limit);
    },
    close(): void {
      try { db?.close(); } catch { /* 忽略 */ }
      db = null;
    },
  };
}

/* ── dsh-memory-palace(Markdown 文件)适配器 ─────────────────────
 * memory-palace 的长期记忆是"人类可读 Markdown":
 * - 用户级:~/.deepseek-harness/MEMORY.md
 * - 工作区:<cwd>/.deepseek-harness/MEMORY.md(旧嵌套 <cwd>/.deepseek-harness/memory/MEMORY.md 兼容)
 * - 每日日志:<cwd>/.deepseek-harness/memory/YYYY-MM-DD.md(记忆子代理维护)
 * 文件结构:`## 章节` + `- 条目` 列表行;`#`/`<!--` 为结构行;`~~text~~` 为墓碑(已删除)。
 * 检索语义与 palace 原版一致:按行归一化(trim+合空白+小写)子串包含匹配。
 * 只读,绝不写文件。 */

interface PalaceEntry {
  rel: string;      // 展示标签(~/.deepseek-harness/MEMORY.md 等)
  section: string;  // 所在 ## 章节标题
  lineNo: number;   // 源文件行号(用于 id)
  content: string;  // 条目正文(已剥列表符、合空白)
  ts: string;       // 时间线索(日志日期或文件 mtime 的 YYYY-MM-DD)
}

const palaceNorm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function palaceMtimeDate(file: string): string {
  try {
    const st = fs.statSync(file);
    const d = new Date(st.mtimeMs);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  } catch {
    return '';
  }
}

/** 长期记忆文件候选(存在才收集)。 */
function collectPalaceFiles(cwd: string): Array<{ file: string; rel: string }> {
  const home = os.homedir();
  const candidates: Array<{ file: string; rel: string }> = [
    { file: path.join(home, '.deepseek-harness', 'MEMORY.md'), rel: '~/.deepseek-harness/MEMORY.md' },
    { file: path.join(cwd, '.deepseek-harness', 'MEMORY.md'), rel: '<cwd>/.deepseek-harness/MEMORY.md' },
    { file: path.join(cwd, '.deepseek-harness', 'memory', 'MEMORY.md'), rel: '<cwd>/.deepseek-harness/memory/MEMORY.md' },
  ];
  return candidates.filter((c) => fs.existsSync(c.file));
}

/** 每日日志候选(最近 limit 份,按日期降序)。 */
function collectPalaceLogs(cwd: string, limit = 3): Array<{ file: string; rel: string; date: string }> {
  const dir = path.join(cwd, '.deepseek-harness', 'memory');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
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
function parsePalaceFile(file: string, rel: string, ts: string): PalaceEntry[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: PalaceEntry[] = [];
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (!t || t.startsWith('<!--')) continue;
    const sec = /^##\s+(.+?)\s*$/.exec(t);
    if (sec) {
      section = (sec[1] ?? '').trim();
      continue;
    }
    if (t.startsWith('#') || t.includes('~~')) continue; // 结构行与墓碑(已删除)不参与检索
    const content = t.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    out.push({ rel, section, lineNo: i + 1, content, ts });
  }
  return out;
}

/** 打开 dsh-memory-palace 的只读记忆源(cwd = DSH 工作目录,用于定位工作区记忆)。 */
export function openPalaceStore(cwd: string, logger: LoggerLike): MemoryStore {
  const files = collectPalaceFiles(cwd);
  const logs = collectPalaceLogs(cwd);
  const entries: PalaceEntry[] = [];
  for (const f of files) entries.push(...parsePalaceFile(f.file, f.rel, palaceMtimeDate(f.file)));
  for (const l of logs) entries.push(...parsePalaceFile(l.file, l.rel, l.date));
  if (entries.length === 0) {
    logger.warn(
      `[recall-rebuild] 未找到 memory-palace 记忆文件(检查 ~/.deepseek-harness/MEMORY.md 或 ` +
        `<cwd>/.deepseek-harness/MEMORY.md、每日日志),记忆读取停用`,
    );
    return disabledStore('未找到 memory-palace 记忆文件');
  }
  const sources = [...new Set(entries.map((e) => e.rel))];
  return {
    ok: true,
    label: `dsh-memory-palace (${sources.join(', ')})`,
    search(query: string, limit: number): MemoryRecord[] {
      const words = tokenizeQuery(query);
      if (words.length === 0) return [];
      const scored: Array<{ e: PalaceEntry; hits: number }> = [];
      for (const e of entries) {
        const nl = palaceNorm(e.content);
        let hits = 0;
        for (const w of words) if (nl.includes(w)) hits += 1;
        if (hits > 0) scored.push({ e, hits });
      }
      // 命中词数优先,其次时间倒序(最近优先)
      scored.sort((a, b) => b.hits - a.hits || (a.e.ts < b.e.ts ? 1 : a.e.ts > b.e.ts ? -1 : 0));
      return scored.slice(0, limit).map(({ e, hits }) => ({
        id: `${e.rel}#L${e.lineNo}`,
        content: e.content,
        type: 'palace',
        sceneName: e.section,
        family: e.rel,
        priority: hits,
        timestampStr: e.ts,
      }));
    },
    close(): void {
      /* 无资源 */
    },
  };
}

/* ── @max-null/dsh-memory(JSON 文件)适配器 ─────────────────────
 * dsh-memory 的存储是「人类可读 JSON 记忆库」(storage-hub 格式):
 * - global:<DSH_HOME>/storages/memory.json(缺省 ~/.dsh/storages/memory.json,跨项目)
 * - project:<cwd>/.dsh/storages/<backend>.json(跟随工作区,随 git 分享)
 * 文件顶层:{ "unit": { "name", "tables": { "blocks": [ ... ] } } }
 * 记录字段:id/namespace/status/injected/quarantined/content/keywords/createdAt/updatedAt/kind。
 * 生效规则(与 dsh-memory 一致):status==='approved' 且未隔离(quarantined!==true);
 * kind==='prompt' 是提示词模板索引,不是用户记忆,跳过。
 * 检索:content 归一化子串 + keywords 加权(keywords 命中权重更高)。
 * 只读,绝不写文件。 */

interface DshMemoryEntry {
  id: string;        // 记录 id(文件内唯一)
  content: string;
  namespace: 'global' | 'project';
  keywords: string[];
  updatedAt: number; // epoch ms
  rel: string;       // 文件展示标签
}

/** epoch ms → 本地时区 YYYY-MM-DD;非法值返回空串。 */
function epochToDate(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 解析单个 dsh-memory JSON 库文件为生效记录(只读;跳过 suggested/隔离/prompt/结构异常)。 */
function parseDshMemoryFile(file: string, rel: string): DshMemoryEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const blocks = (doc as { unit?: { tables?: { blocks?: unknown } } } | null)?.unit?.tables?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: DshMemoryEntry[] = [];
  for (const raw of blocks) {
    const b = raw as {
      id?: unknown;
      namespace?: unknown;
      status?: unknown;
      quarantined?: unknown;
      kind?: unknown;
      content?: unknown;
      keywords?: unknown;
      updatedAt?: unknown;
    };
    if (!b || typeof b !== 'object') continue;
    if (b.status !== 'approved') continue; // suggested 未生效
    if (b.quarantined === true) continue;  // 隔离记录不进检索
    if (b.kind === 'prompt') continue;     // 模板索引非用户记忆
    const content = typeof b.content === 'string' ? b.content.trim() : '';
    if (!content) continue;
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
export function openDshMemoryStore(cwd: string, logger: LoggerLike): MemoryStore {
  // global:join(DSH_HOME ?? ~/.dsh, 'storages', 'memory.json')
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const globalFile = path.join(home, 'storages', 'memory.json');
  // project:<cwd>/.dsh/storages/*.json(每个 backend 一个文件)
  const projectDir = path.join(cwd, '.dsh', 'storages');

  const entries: DshMemoryEntry[] = [];
  if (fs.existsSync(globalFile)) {
    entries.push(...parseDshMemoryFile(globalFile, '<DSH_HOME>/storages/memory.json'));
  }
  let projectNames: string[] = [];
  try {
    projectNames = fs.readdirSync(projectDir).filter((n) => n.endsWith('.json'));
  } catch {
    /* 无 project 记忆 */
  }
  for (const n of projectNames) {
    if (n === 'query-log.json') continue; // 查询日志非记忆库
    const f = path.join(projectDir, n);
    entries.push(...parseDshMemoryFile(f, `<cwd>/.dsh/storages/${n}`));
  }
  if (entries.length === 0) {
    logger.warn(
      `[recall-rebuild] 未找到 dsh-memory 记忆文件(检查 <DSH_HOME>/storages/memory.json 或 ` +
        `<cwd>/.dsh/storages/*.json),记忆读取停用`,
    );
    return disabledStore('未找到 dsh-memory 记忆文件');
  }
  const sources = [...new Set(entries.map((e) => e.rel))];
  return {
    ok: true,
    label: `@max-null/dsh-memory (${sources.join(', ')})`,
    search(query: string, limit: number): MemoryRecord[] {
      const words = tokenizeQuery(query);
      if (words.length === 0) return [];
      const scored: Array<{ e: DshMemoryEntry; hits: number }> = [];
      for (const e of entries) {
        const cNorm = palaceNorm(e.content);
        let hits = 0;
        for (const w of words) {
          if (cNorm.includes(w)) hits += 1;
          // keywords 命中更精准,权重 ×2
          for (const k of e.keywords) if (palaceNorm(k).includes(w)) hits += 2;
        }
        if (hits > 0) scored.push({ e, hits });
      }
      // 命中权重优先,其次更新时间倒序(最近优先)
      scored.sort((a, b) => b.hits - a.hits || (a.e.updatedAt < b.e.updatedAt ? 1 : a.e.updatedAt > b.e.updatedAt ? -1 : 0));
      return scored.slice(0, limit).map(({ e, hits }) => ({
        id: `${e.rel}#${e.id}`,
        content: e.content,
        type: 'dsh-memory',
        sceneName: e.namespace === 'project' ? 'project 记忆' : 'global 记忆',
        family: e.rel,
        priority: hits,
        timestampStr: epochToDate(e.updatedAt),
      }));
    },
    close(): void {
      /* 无资源 */
    },
  };
}

/** 记忆来源路由:auto 探测 prime → dsh-memory → palace,或按 source 显式指定。 */
export function openMemorySource(
  source: 'auto' | 'prime' | 'dsh-memory' | 'palace',
  opts: { dataDir: string; cwd: string; logger: LoggerLike },
): MemoryStore {
  const { dataDir, cwd, logger } = opts;
  if (source === 'prime') return openPrimeMemoryStore(dataDir, logger);
  if (source === 'dsh-memory') return openDshMemoryStore(cwd, logger);
  if (source === 'palace') return openPalaceStore(cwd, logger);
  // auto:prime-memory 库存在则优先(打开失败依次落 dsh-memory / palace),否则尝试后两者
  const primeDb = path.join(dataDir, 'memory.db');
  if (fs.existsSync(primeDb)) {
    const s = openPrimeMemoryStore(dataDir, logger);
    if (s.ok) return s;
    logger.warn(`[recall-rebuild] prime-memory 库存在但打不开,尝试 dsh-memory / memory-palace 记忆源`);
  }
  const dm = openDshMemoryStore(cwd, logger);
  if (dm.ok) return dm;
  const p = openPalaceStore(cwd, logger);
  if (p.ok) return p;
  return disabledStore('未检测到 prime-memory / dsh-memory / memory-palace 记忆库');
}
