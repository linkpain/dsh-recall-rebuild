import type { MemoryRecord } from './store.js';
import type { LoggerLike } from './store.js';
export type IsolationMode = 'off' | 'auto' | 'strict';
/** 从消息文本中提取当前 IM 用户键;识别不到返回 null。pattern 可覆盖内置 <dsh_im_source> 正则。 */
export declare function extractUserKey(texts: string[], pattern?: string): string | null;
export declare class NamespaceStore {
    private readonly dir;
    private readonly logger;
    /** 目录缓存:userKey → memoryId 集;cacheTtlMs 内复用,避免每轮扫描磁盘。 */
    private cache;
    private cacheAt;
    private readonly cacheTtlMs;
    constructor(dir: string, logger: LoggerLike);
    /** 确保目录存在(只建本插件自己的目录)。 */
    ensureDir(): void;
    /** 重建缓存(遍历 namespaces 下所有归属文件)。 */
    private refresh;
    /** 全部用户归属集:memoryId → [userKey...](cache 内复用)。 */
    private ownersOf;
    /** 当前用户已归属的记忆 id 集。 */
    private userIds;
    /**
     * 按隔离模式过滤候选记忆。
     * @param memories 检索候选(已按相关性排序)
     * @param userKey  当前用户键;null = 桌面/无法识别 → 不过滤
     * @param mode     off / auto / strict
     */
    filter(memories: MemoryRecord[], userKey: string | null, mode: IsolationMode): MemoryRecord[];
    /** 把"本轮实际保留的候选"记为当前用户归属(增量、原子写)。 */
    recordHits(userKey: string | null, memories: MemoryRecord[]): void;
}
