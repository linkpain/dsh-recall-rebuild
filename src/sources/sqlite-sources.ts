/**
 * SQLite 系记忆插件的适配器。
 *
 * 生态里一大半记忆插件把数据落进一个 SQLite 库,表名与列名各不相同,但读取方式完全一样。
 * 这里每个插件只描述三件事:库在哪、优先读哪张表、算哪一类记忆 —— 剩下交给 kit.ts。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dshHome, isFile, openSqliteSource, readSqliteDocs, openSqlite, listTables, tableColumns } from './kit.js';
import type { LoggerLike, MemoryStore } from '../store.js';

/** 一个 SQLite 记忆源:候选库文件 + 优先表名。 */
export interface SqliteSourceSpec {
  /** 稳定 id,用于日志与 source 枚举。 */
  id: string;
  label: string;
  type: string;
  /** 候选库文件(按顺序尝试,取第一个能读到记忆行的)。 */
  files: string[];
  /** 优先读取的表名;空 = 所有含正文列的表。 */
  tables: string[];
}

/**
 * 依次尝试候选库,返回第一个成功读到记忆行的源。
 * 全部失败时返回 ok:false 的占位源 —— 调用方据此继续降级,绝不抛错。
 */
export function resolveSqliteSource(spec: SqliteSourceSpec, logger: LoggerLike, refreshMs = 0): MemoryStore {
  const tried: string[] = [];
  for (const file of spec.files) {
    if (!isFile(file)) continue;
    tried.push(file);
    const store = openSqliteSource(
      { label: spec.label, file, tables: spec.tables, type: spec.type },
      logger,
      refreshMs,
    );
    if (store.ok) return store;
    store.close();
  }
  const detail = tried.length > 0 ? '尝试过 ' + tried.join(', ') : '未找到库文件';
  return {
    ok: false,
    label: spec.label + '(' + detail + ')',
    search: () => [],
    close: () => { /* 无资源 */ },
  };
}

/** dsh-prime-memory:用户级 memory.db,单表 memories + FTS5。 */
export function openPrimeSqliteSource(dataDir: string, logger: LoggerLike, refreshMs = 0): MemoryStore {
  const dir = dataDir || path.join(dshHome(), 'memory');
  return resolveSqliteSource(
    {
      id: 'prime',
      label: 'dsh-prime-memory',
      type: 'prime',
      files: [path.join(dir, 'memory.db'), path.join(dir, 'prime.db')],
      tables: ['memories', 'memory', 'entries', 'facts'],
    },
    logger,
    refreshMs,
  );
}

/** dsh-loci:<DSH_HOME>/memory/loci/memory.db,主表 memory(修订行不可变,读全部历史版本)。 */
export function openLociSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  return resolveSqliteSource(
    {
      id: 'loci',
      label: 'dsh-loci',
      type: 'loci',
      files: [path.join(dshHome(), 'memory', 'loci', 'memory.db')],
      tables: ['memory'],
    },
    logger,
    refreshMs,
  );
}

/** dsh-living-memory:~/.dsh/dsh-living-memory/memory.sqlite3(MEMORY_DB_PATH 可覆盖)。 */
export function openLivingMemorySource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const override = process.env.MEMORY_DB_PATH?.trim();
  return resolveSqliteSource(
    {
      id: 'living',
      label: 'dsh-living-memory',
      type: 'living',
      files: override ? [override] : [path.join(dshHome(), 'dsh-living-memory', 'memory.sqlite3')],
      tables: ['memories'],
    },
    logger,
    refreshMs,
  );
}

/** @tr1v3r/dsh-ltm:工作区或用户级 memory/ltm.db。 */
export function openLtmSource(cwd: string, logger: LoggerLike, refreshMs = 0): MemoryStore {
  return resolveSqliteSource(
    {
      id: 'ltm',
      label: '@tr1v3r/dsh-ltm',
      type: 'ltm',
      files: [
        path.join(cwd, 'memory', 'ltm.db'),
        path.join(dshHome(), 'memory', 'ltm.db'),
        path.join(dshHome(), 'storages', 'ltm.db'),
      ],
      tables: ['memories'],
    },
    logger,
    refreshMs,
  );
}

/** dsh-memory(无 scope 的早期版本):memory/memory.db,表 memories。 */
export function openPlainDshMemorySource(cwd: string, logger: LoggerLike, refreshMs = 0): MemoryStore {
  return resolveSqliteSource(
    {
      id: 'dsh-memory-sqlite',
      label: 'dsh-memory(SQLite)',
      type: 'dsh-memory',
      files: [
        path.join(cwd, 'memory', 'memory.db'),
        path.join(dshHome(), 'memory', 'memory.db'),
      ],
      tables: ['memories'],
    },
    logger,
    refreshMs,
  );
}

/**
 * dsh-memory-nebula:本体库是各工作区的 .dsh-meow/memory.db(nebula.db 只存连边,不存正文)。
 * 因此同时探测当前工作区与 DSH_HOME 下的 meow 库。
 */
export function openNebulaSource(cwd: string, logger: LoggerLike, refreshMs = 0): MemoryStore {
  return resolveSqliteSource(
    {
      id: 'nebula',
      label: 'dsh-memory-nebula',
      type: 'nebula',
      files: [
        path.join(cwd, '.dsh-meow', 'memory.db'),
        path.join(dshHome(), '.dsh-meow', 'memory.db'),
        path.join(dshHome(), 'memory-nebula', 'nebula.db'),
      ],
      tables: ['memories', 'memory', 'entries'],
    },
    logger,
    refreshMs,
  );
}

/** 供 auto 探测:某个插件是否「看起来装了」(库文件存在)。 */
export function looksInstalled(spec: SqliteSourceSpec): boolean {
  return spec.files.some((f) => isFile(f));
}

/** 列出库里所有表名(调试/诊断用,失败返回空数组)。 */
export function inspectSqlite(file: string): Array<{ table: string; columns: string[] }> {
  if (!isFile(file)) return [];
  const db = openSqlite(file);
  if (!db) return [];
  try {
    return listTables(db).map((t) => ({ table: t, columns: tableColumns(db, t) }));
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 供 auto 探测:在若干候选库里数出记忆行数(不建索引,只看有没有)。 */
export function countDocsIn(file: string, tables: string[]): number {
  if (!isFile(file)) return 0;
  const db = openSqlite(file);
  if (!db) return 0;
  try {
    const all = listTables(db);
    const wanted = tables.filter((t) => all.includes(t));
    return readSqliteDocs(db, path.basename(file), wanted.length > 0 ? wanted : all, 'probe').length;
  } catch {
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 未使用的导入占位,保证 fs/os 在需要时可用(避免打包器裁剪误报)。 */
export const _fs = fs;
export const _os = os;
