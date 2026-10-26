import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { rebuildMemory } from './rebuild.js';
/** 消息文本提取(text 块拼接),用于召回查询。 */
function blocksToText(content) {
    if (!Array.isArray(content))
        return '';
    let out = '';
    for (const b of content) {
        const blk = b;
        if (blk && blk.type === 'text' && typeof blk.text === 'string') {
            if (out)
                out += ' ';
            out += blk.text;
        }
    }
    return out;
}
/** 判断一条消息是否为其它插件(prime-memory 等)注入的原文召回。 */
export function isOtherPluginRecall(m) {
    const s = m.source;
    if (!s)
        return false;
    if (s.kind === 'plugin:memory' && s.form === 'recall')
        return true;
    if (s.kind === 'plugin' && s.plugin === 'memory')
        return true;
    return false;
}
/** 用会话末尾消息构建召回查询(去重、截断预算)。 */
function buildRecallQuery(messages, cfg) {
    if (!Array.isArray(messages))
        return '';
    const tail = messages.slice(-cfg.query.tailMessages);
    const texts = [];
    let total = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
        const t = blocksToText(tail[i]).trim();
        if (!t)
            continue;
        const take = t.slice(0, 500);
        if (total + take.length > cfg.query.maxChars) {
            const remain = cfg.query.maxChars - total;
            if (remain > 40)
                texts.unshift(take.slice(0, remain));
            break;
        }
        texts.unshift(take);
        total += take.length;
    }
    return texts.join(' ').trim();
}
/** 构造重建片段注入消息(source.kind 用 v4 语义,避免被当作"用户消息"捕获/再次蒸馏)。 */
function buildInjectionMessage(text, sourceIds, cfg) {
    let body = `<reconstructed-memory>\n${text.slice(0, cfg.inject.maxChars)}\n</reconstructed-memory>`;
    if (cfg.inject.includeSources && sourceIds.length > 0) {
        body += `\n(记忆依据: ${sourceIds.slice(0, 8).join(', ')})`;
    }
    // createUserMessage 的 source.kind 类型是宿主枚举,但运行时接受插件语义
    // (v4:'plugin:<子系统名>'),与 prime-memory 的 'plugin:memory' 同款做法。
    const source = { kind: 'plugin:recall-rebuild', form: 'recall' };
    return createUserMessage({
        content: [{ type: 'text', text: body }],
        source,
    });
}
export function registerRecallRebuild(ctx, store, cfg, logger) {
    if (!cfg.enabled)
        return;
    const emitter = ctx;
    emitter.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || payload.signal?.aborted)
            return decision;
        if (!store.ok || !cfg.rebuild.enabled)
            return decision;
        // 只在"这一轮真的有新用户消息"时才注入(与 prime-memory 同款闸门)
        const hasNewUser = decision.messages.some((m) => m.source?.kind === 'user');
        if (!hasNewUser)
            return decision;
        try {
            const query = buildRecallQuery(payload.messages, cfg);
            if (!query)
                return decision;
            const memories = store.search(query, cfg.rebuild.maxResults);
            if (memories.length === 0)
                return decision;
            const rebuilt = await rebuildMemory(ctx, memories, query, cfg.rebuild, payload.signal, logger);
            if (!rebuilt || !rebuilt.text)
                return decision;
            const injection = buildInjectionMessage(rebuilt.text, rebuilt.sourceIds, cfg);
            if (cfg.inject.strategy === 'replace') {
                const idx = decision.messages.findIndex(isOtherPluginRecall);
                if (idx >= 0) {
                    const msgs = [...decision.messages];
                    msgs[idx] = injection;
                    return { kind: 'enter', messages: msgs };
                }
            }
            return { kind: 'enter', messages: [injection, ...decision.messages] };
        }
        catch (err) {
            logger.warn(`[recall-rebuild] 本轮重建注入失败(跳过): ${err instanceof Error ? err.message : String(err)}`);
            return decision;
        }
    }, { prepend: true });
}
