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
 * FTS5 MATCH 表达式清洗:逐词加双引号、AND 连接,
 * 规避 FTS5 特殊字符(引号/AND/OR/NOT/括号等)导致的语法错误。
 */
export declare function sanitizeFts(query: string): string;
/**
 * 打开 dsh-prime-memory 的只读记忆库。
 * @param dataDir prime-memory 的数据目录(默认 $DSH_HOME/memory)
 */
export declare function openPrimeMemoryStore(dataDir: string, logger: LoggerLike): MemoryStore;
