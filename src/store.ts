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
