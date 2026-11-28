import type { LoggerLike, MemoryStore } from '../store.js';
/** 空源占位(统一构造,避免各处重复)。 */
export declare function emptyStore(label: string, logger: LoggerLike, why: string): MemoryStore;
/** @jipika/dsh-memory:~/.dsh/memory/topics/*.md 分片(每行 "- [日期] 事实")。 */
export declare function openJipikaSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** @furongjun1999/dsh-memory(灵枢):~/.dsh/.dsh-memory/data/mdcg 下的节点 Markdown。 */
export declare function openLingshuSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-mnemon:~/.mnemon/runtime/{MEMORY.md,USER.md} + ~/.mnemon/documents/active/*.md。 */
export declare function openMnemonSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-longterm-memory:Obsidian 兼容 vault(vaultPath 由用户配置,这里探测常见位置)。 */
export declare function openLongtermSource(cwd: string, logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-memory-hub:~/.dsh/memory-hub/{knowledge,records,pending} 下的 Markdown 记录。 */
export declare function openHubSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-memory-engine / @wilshi/dsh-memory-engine:<DSH_HOME>/memory-engine/memories.json。 */
export declare function openMemoryEngineSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-memory-tiers:<DSH_HOME>/storages/memory 的六层文件(L1/L2/L3/DL1/DL2/DL3)。 */
export declare function openMemoryTiersSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** dsh-auto-memory 的记忆根:默认 <DSH_HOME>/memory(上游可用 config.memoryDir 覆盖)。 */
export declare function autoMemoryRoot(): string;
/** 该目录下是否有 auto-memory 的作用域目录(`_user` 或 `--<slug>--`)。 */
export declare function hasAutoMemoryScopes(root: string): boolean;
/** dsh-auto-memory:<DSH_HOME>/memory 的 `_user/` 与 `--<slug>--/` 目录。 */
export declare function openAutoMemorySource(logger: LoggerLike, refreshMs?: number): MemoryStore;
/** @restregular/dsh-memory:~/.dsh/memory-vector/*.jsonl(按 scope 分文件)。 */
export declare function openVectorJsonlSource(logger: LoggerLike, refreshMs?: number): MemoryStore;
