/**
 * 巩固层交互命令(/recall-rebuild ...)。
 *
 * 让用户能像「管理自己的记忆」一样管理巩固层:
 * - list —— 查看长期记忆(受 IM 用户隔离约束,--all 显示全部);
 * - now —— 立即触发一次睡眠巩固(绕过最短间隔,离线任务语义);
 * - edit <id> <新内容> —— 修正一条记忆的内容(人也会记错、改口);
 * - forget <id> —— 主动删除一条记忆(与被动遗忘不同,这是显式操作);
 * - help —— 用法。
 *
 * 注册方式:DSH 官方 `ctx.commands.register`(inject 可选 'commands?',
 * 无 commands 服务时静默跳过,插件主体功能不受影响)。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RecallRebuildConfig } from './config.js';
import type { LoggerLike, MemoryStore } from './store.js';
import type { ConsolidatedMemory, ConsolidatedStore } from './consolidated.js';
export type CommandSub = 'now' | 'list' | 'edit' | 'forget' | 'help' | 'unknown';
/** 解析后的命令参数(纯函数,可测)。 */
export interface CommandArgs {
    sub: CommandSub;
    /** 子命令之后的剩余参数(token 化)。 */
    args: string[];
    /** 是否带 --all(仅 list 用)。 */
    all: boolean;
}
/** 纯函数:解析 /recall-rebuild <sub> 之后的输入。 */
export declare function parseCommandLine(rawInput: string): CommandArgs;
/**
 * 可见性过滤(与召回隔离同一套规则,但命令是管理视图):
 * - userKey 为 null(桌面/识别不到)或 isolation=off → 全部可见;
 * - 否则只显示「当前用户 + 无主(null)」的条目;
 * - all=true 时忽略隔离显示全部(带归属标注由 formatList 处理)。
 */
export declare function visibleMemories(consolidated: ConsolidatedStore, userKey: string | null, isolation: 'off' | 'auto' | 'strict', all: boolean): ConsolidatedMemory[];
/** 纯函数:把条目列表格式化为可读文本(命令输出)。 */
export declare function formatMemoryList(mems: ConsolidatedMemory[], opts: {
    userKey: string | null;
    all: boolean;
    now: number;
}): string;
/** 注册巩固层交互命令;宿主没有 commands 服务时静默跳过。 */
export declare function registerRecallRebuildCommands(ctx: Context, store: MemoryStore, consolidated: ConsolidatedStore, cfg: RecallRebuildConfig, logger: LoggerLike): void;
