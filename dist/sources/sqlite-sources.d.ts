/**
 * SQLite 系记忆插件的适配器。
 *
 * 生态里一大半记忆插件把数据落进一个 SQLite 库,表名与列名各不相同,但读取方式完全一样。
 * 这里每个插件只描述三件事:库在哪、优先读哪张表、算哪一类记忆 —— 剩下交给 kit.ts。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
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
export declare function resolveSqliteSource(spec: SqliteSourceSpec, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-prime-memory:用户级 memory.db,单表 memories + FTS5。 */
export declare function openPrimeSqliteSource(dataDir: string, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-loci:<DSH_HOME>/memory/loci/memory.db,主表 memory(修订行不可变,读全部历史版本)。 */
export declare function openLociSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-living-memory:~/.dsh/dsh-living-memory/memory.sqlite3(MEMORY_DB_PATH 可覆盖)。 */
export declare function openLivingMemorySource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** @tr1v3r/dsh-ltm:工作区或用户级 memory/ltm.db。 */
export declare function openLtmSource(cwd: string, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-memory(无 scope 的早期版本):memory/memory.db,表 memories。 */
export declare function openPlainDshMemorySource(cwd: string, logger: LoggerLike, refreshMs?: number): MemoryStore;
/**
 * dsh-memory-nebula:本体库是各工作区的 .dsh-meow/memory.db(nebula.db 只存连边,不存正文)。
 * 因此同时探测当前工作区与 DSH_HOME 下的 meow 库。
 */
export declare function openNebulaSource(cwd: string, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** 供 auto 探测:某个插件是否「看起来装了」(库文件存在)。 */
export declare function looksInstalled(spec: SqliteSourceSpec): boolean;
/** 列出库里所有表名(调试/诊断用,失败返回空数组)。 */
export declare function inspectSqlite(file: string): Array<{
    table: string;
    columns: string[];
}>;
/** 供 auto 探测:在若干候选库里数出记忆行数(不建索引,只看有没有)。 */
export declare function countDocsIn(file: string, tables: string[]): number;
/** 未使用的导入占位,保证 fs/os 在需要时可用(避免打包器裁剪误报)。 */
export declare const _fs: typeof fs;
export declare const _os: typeof os;
