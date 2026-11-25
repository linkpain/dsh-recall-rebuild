import type { LoggerLike, MemoryStore } from '../store.js';
/** DSH 状态根:DSH_HOME 优先,否则 ~/.dsh。 */
export declare function dshHome(): string;
export declare function userHome(): string;
/** 文件存在且是普通文件。 */
export declare function isFile(p: string): boolean;
/** 目录存在。 */
export declare function isDir(p: string): boolean;
/** 安全读文本(带 BOM 剥离与体积上限)。 */
export declare function readText(file: string, maxBytes?: number): string;
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
export declare const normText: (s: string) => string;
/** 任意时间值 → 毫秒时间戳(秒/毫秒自动判别);非法返回 0。 */
export declare function toEpochMs(v: unknown): number;
/** 毫秒时间戳 → 本地 YYYY-MM-DD;0 → 空串。 */
export declare function epochToDate(ms: number): string;
/** 任意时间值 → YYYY-MM-DD。 */
export declare function toDateStr(v: unknown): string;
/** 文件 mtime → YYYY-MM-DD(读不到返回空串)。 */
export declare function mtimeDate(file: string): string;
/**
 * 把一批 Doc 变成 MemoryStore:
 * 命中词数 × 高价值字段加权 × 时效衰减,复用 store.ts 的统一排序出口。
 *
 * reload/refreshMs:通用源打开时一次性把条目读进内存(比每次检索都扫盘快两个数量级),
 * 代价是读一次就定住了 —— 插件启动后新写入的记忆要重启才看得见。传了 reload 就按
 * refreshMs 间隔在检索路径上重读(至多多付一次读盘,不额外起定时器),让「边聊边记」
 * 的记忆库跟上。重读失败或读到空时沿用旧快照:宁可旧一点,也不要检索突然全空。
 */
export declare function makeTextStore(label: string, docs: Doc[], logger: LoggerLike, opts?: {
    reload?: () => Doc[];
    refreshMs?: number;
}): MemoryStore;
/**
 * 把多个已打开的源合成一个:检索时并行问每个源,再用 RRF 融合。
 *
 * 为什么需要:真实用户常同时装着两三个记忆插件(比如 palace 记长期偏好、
 * prime 记事实)。只挑「第一个能读的」会白白丢掉其它库里的记忆,
 * 而 RRF 只看排名不看分数,天然能融合量纲不同的多路结果。
 */
export declare function combineStores(label: string, stores: MemoryStore[], logger: LoggerLike): MemoryStore;
export interface Frontmatter {
    data: Record<string, string | string[]>;
    body: string;
}
/** 解析 YAML-ish frontmatter(只处理 key: value 与 key: 换行 - item 两种形态,够用且零依赖)。 */
export declare function parseFrontmatter(text: string): Frontmatter;
/** frontmatter 值 → 字符串。 */
export declare function fmString(v: string | string[] | undefined): string;
/** frontmatter 值 → 字符串数组。 */
export declare function fmList(v: string | string[] | undefined): string[];
/**
 * Markdown 正文 → 条目列表。
 * 列表型文档(每行 "- 事实")按行切;整段型文档(灵枢节点、Obsidian 笔记)整段保留。
 */
export declare function splitMarkdownBody(body: string): string[];
/** 读一个 Markdown 文件为 Doc[](支持 frontmatter 与列表型正文)。 */
export declare function readMarkdownDocs(file: string, rel: string, type: string, fallbackTs?: string): Doc[];
export interface WalkOptions {
    exts?: string[];
    maxFiles?: number;
    /** 跳过这些子目录名(node_modules 等永远跳过)。 */
    skipDirs?: string[];
}
/** 递归收集文件(深度优先,按修改时间新→旧排序,受 maxFiles 限制)。 */
export declare function walkFiles(root: string, opts?: WalkOptions): string[];
/**
 * 从任意 JSON 结构里收割记忆条目。
 * 不假设固定 schema:先看对象本身是否像记忆,不像就递归子值。
 * 这样同一份代码能吃 entries:[]、[[{...}]]、{a:{b:[{...}]}} 等所有包装形态。
 */
export declare function harvestJson(value: unknown, rel: string, type: string, out: Doc[], depth?: number, budget?: {
    left: number;
}): void;
/** 读一个 JSON 文件为 Doc[]。 */
export declare function readJsonDocs(file: string, rel: string, type: string): Doc[];
/** 读一个 JSONL 文件为 Doc[](逐行解析,坏行跳过;只读尾部 maxLines 行)。 */
export declare function readJsonlDocs(file: string, rel: string, type: string, maxLines?: number): Doc[];
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
type DbCtor = new (file: string, options: {
    readOnly: boolean;
}) => DbLike;
/** 取 node:sqlite 的 DatabaseSync(Node <22.5 返回 null)。 */
export declare function sqliteCtor(): DbCtor | null;
/** 只读打开 SQLite 库;失败返回 null(绝不抛错)。 */
export declare function openSqlite(file: string): DbLike | null;
/** 列出库里的表名(排除 FTS 影子表)。 */
export declare function listTables(db: DbLike): string[];
/** 表是否含某列(用 PRAGMA 读列名,避免 SELECT * 撞上不存在的列)。 */
export declare function tableColumns(db: DbLike, table: string): string[];
/**
 * 按候选列名把一行映射成 Doc。
 * 这是「格式嗅探」的核心:不写死某插件的列名,只要求它叫得像记忆。
 */
export declare function rowToDoc(row: SqliteRow, cols: string[], ctx: {
    rel: string;
    type: string;
    index: number;
}): Doc | null;
/** 从库里的若干候选表中读行 → Doc[]。 */
export declare function readSqliteDocs(db: DbLike, dbLabel: string, tableNames: string[], type: string, limitPerTable?: number): Doc[];
/**
 * 通用 SQLite 记忆源:打开库 → 挑表 → 读行 → 映射。
 * 表名候选来自各插件实测;缺表时退化为「所有含正文列的表」。
 */
export declare function openSqliteSource(opts: {
    label: string;
    file: string;
    tables?: string[];
    type: string;
    limitPerTable?: number;
}, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** 毫秒 → 天数(供源排序/调试用)。 */
export declare function daysSince(ms: number): number;
export {};
