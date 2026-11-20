import { runConsolidation } from './consolidate.js';
import { extractUserKey } from './namespace.js';
/** 纯函数:解析 /recall-rebuild <sub> 之后的输入。 */
export function parseCommandLine(rawInput) {
    const trimmed = (rawInput ?? '').trim();
    if (!trimmed)
        return { sub: 'help', args: [], all: false };
    const parts = trimmed.split(/\s+/);
    const head = (parts[0] ?? '').toLowerCase();
    const known = ['now', 'list', 'edit', 'forget', 'help'];
    const sub = known.includes(head) ? head : 'unknown';
    const rest = parts.slice(1);
    return { sub, args: rest, all: rest.includes('--all') };
}
/**
 * 可见性过滤(与召回隔离同一套规则,但命令是管理视图):
 * - userKey 为 null(桌面/识别不到)或 isolation=off → 全部可见;
 * - 否则只显示「当前用户 + 无主(null)」的条目;
 * - all=true 时忽略隔离显示全部(带归属标注由 formatList 处理)。
 */
export function visibleMemories(consolidated, userKey, isolation, all) {
    const allMems = consolidated.list();
    if (all || userKey === null || isolation === 'off')
        return allMems;
    return allMems.filter((m) => m.userKey === null || m.userKey === userKey);
}
const TYPE_LABEL = {
    'stable-fact': '事实',
    pattern: '规律',
    preference: '偏好',
    relationship: '关系',
    mood: '情绪',
};
/** 纯函数:把条目列表格式化为可读文本(命令输出)。 */
export function formatMemoryList(mems, opts) {
    const active = mems
        .filter((m) => m.status === 'active')
        .sort((a, b) => b.confidence - a.confidence || b.touchCount - a.touchCount);
    const dormant = mems.filter((m) => m.status === 'dormant');
    const lines = [];
    lines.push(`长期记忆(巩固层): active ${active.length} / dormant ${dormant.length}`);
    for (const m of active) {
        const owner = m.userKey ? ` [${m.userKey}]` : '';
        lines.push(`• ${m.id}${owner} [${TYPE_LABEL[m.type]}] 置信${(m.confidence * 100).toFixed(0)}% · 命中${m.touchCount} · 更新${new Date(m.updatedAt).toISOString().slice(0, 10)}`);
        lines.push(`  ${m.content}`);
    }
    for (const m of dormant) {
        const owner = m.userKey ? ` [${m.userKey}]` : '';
        lines.push(`[dormant 已降权] ${m.id}${owner} [${TYPE_LABEL[m.type]}] ${m.content}`);
    }
    if (mems.length === 0)
        lines.push('(巩固层还没有条目——多聊几轮后,碎片会在空闲时沉淀为长期记忆)');
    if (!opts.all && opts.userKey !== null) {
        lines.push(`(隔离视图:仅显示当前用户${opts.userKey}与共享记忆;--all 查看全部)`);
    }
    return lines.join('\n');
}
/** 从 agent 会话最近消息提取文本(用于识别当前 IM 用户;失败返回空数组)。 */
function recentUserTexts(agent, n) {
    const events = agent?.session?.events;
    if (!Array.isArray(events))
        return [];
    const out = [];
    for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
        const ev = events[i];
        if (!ev || ev.type !== 'user/message')
            continue;
        const blocks = ev.data?.content;
        if (!Array.isArray(blocks))
            continue;
        const text = blocks
            .filter((b) => {
            const blk = b;
            return !!blk && blk.type === 'text' && typeof blk.text === 'string';
        })
            .map((b) => b.text)
            .join(' ');
        if (text)
            out.push(text);
    }
    return out;
}
/** 注册巩固层交互命令;宿主没有 commands 服务时静默跳过。 */
export function registerRecallRebuildCommands(ctx, store, consolidated, cfg, logger) {
    if (!cfg.commands.enabled)
        return;
    const runtime = ctx.commands;
    if (!runtime?.register)
        return;
    const commandName = cfg.commands.name;
    const disposer = runtime.register({
        name: commandName,
        description: '管理长期记忆(巩固层): list / now / edit / forget / help',
        input: { hint: 'list [--all] | now | edit <id> <新内容> | forget <id> | help' },
        handler: async (invocation) => {
            try {
                // 当前会话 IM 用户:从最近 user 消息提取;桌面/识别不到 → null
                const userKey = extractUserKey(recentUserTexts(invocation.agent, 8), cfg.user.sourceTagPattern) ?? null;
                const { sub, args, all } = parseCommandLine(invocation.rawInput);
                switch (sub) {
                    case 'now': {
                        if (!cfg.consolidate.enabled) {
                            return { kind: 'error', text: '巩固已关闭(consolidate.enabled=false)。' };
                        }
                        const pending = consolidated.pending().length;
                        if (pending === 0) {
                            return { kind: 'success', text: '没有待巩固碎片(pending 为空)——多聊几轮后碎片会自动累积。' };
                        }
                        const result = await runConsolidation(ctx, store, consolidated, cfg.consolidate, logger);
                        return {
                            kind: 'success',
                            text: `睡眠巩固已执行:处理 pending ${result.pending} 条,` +
                                `产出 ${result.entries} 条新记忆,${result.decayed} 条进入 dormant。`,
                        };
                    }
                    case 'list': {
                        const mems = visibleMemories(consolidated, userKey, cfg.user.isolation, all);
                        return { kind: 'success', text: formatMemoryList(mems, { userKey, all, now: Date.now() }) };
                    }
                    case 'edit': {
                        const id = args[0];
                        const content = args.slice(1).join(' ').trim();
                        if (!id || !content) {
                            return { kind: 'error', text: `用法: /${commandName} edit <id> <新内容>` };
                        }
                        const m = consolidated.get(id);
                        if (!m)
                            return { kind: 'error', text: `找不到记忆 ${id}。` };
                        const visible = visibleMemories(consolidated, userKey, cfg.user.isolation, false).some((x) => x.id === id);
                        if (!visible)
                            return { kind: 'error', text: `记忆 ${id} 不在当前用户的可见范围内。` };
                        consolidated.upsert({
                            ...m,
                            content: content.slice(0, cfg.consolidate.maxOutputChars),
                            updatedAt: Date.now(),
                        });
                        return { kind: 'success', text: `已更新记忆 ${id}。` };
                    }
                    case 'forget': {
                        const id = args[0];
                        if (!id)
                            return { kind: 'error', text: `用法: /${commandName} forget <id>` };
                        const m = consolidated.get(id);
                        if (!m)
                            return { kind: 'error', text: `找不到记忆 ${id}。` };
                        const visible = visibleMemories(consolidated, userKey, cfg.user.isolation, false).some((x) => x.id === id);
                        if (!visible)
                            return { kind: 'error', text: `记忆 ${id} 不在当前用户的可见范围内。` };
                        consolidated.remove(id);
                        return { kind: 'success', text: `已删除记忆 ${id}(含其联想边)。` };
                    }
                    case 'help':
                        return {
                            kind: 'success',
                            text: `/${commandName} 用法:\n` +
                                `  /${commandName} list [--all]        查看长期记忆(默认仅当前用户视角)\n` +
                                `  /${commandName} now                 立即触发一次睡眠巩固\n` +
                                `  /${commandName} edit <id> <内容>    修正一条记忆\n` +
                                `  /${commandName} forget <id>         主动删除一条记忆\n` +
                                `  /${commandName} help                显示本帮助`,
                        };
                    default:
                        return {
                            kind: 'error',
                            text: `未知子命令 "${args.length > 0 ? args[0] : ''}"。输入 /${commandName} help 查看用法。`,
                        };
                }
            }
            catch (err) {
                logger.warn(`[recall-rebuild] 命令处理失败: ${err instanceof Error ? err.message : String(err)}`);
                return { kind: 'error', text: '命令处理失败,请查看日志。' };
            }
        },
    });
    ctx.effect(() => disposer, `recall-rebuild: command`);
    logger.info(`[recall-rebuild] 已注册命令 /${commandName}(list / now / edit / forget)`);
}
