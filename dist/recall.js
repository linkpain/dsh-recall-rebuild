import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { rebuildMemory } from './rebuild.js';
import { decayFactor } from './store.js';
import { extractUserKey } from './namespace.js';
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
/* ── 跨轮去重(退化实现) ───────────────────────────────────
 * 理想做法是「同一会话内,上一轮注入过的记忆片段下一轮不再重复注入」。
 * 但 agent/pre-step 的 payload 里没有 sessionId(只有 agent.id),拿不到会话边界。
 * 于是退化为「同一 agent.id 内、TTL 窗口内注入过的记忆降权」:
 * 不丢弃(它可能仍是本轮最相关的),只是让位给新候选 —— 重复注入的本质伤害是
 * 每轮都刷同一段回忆,把上下文预算烧在已经说过的话上。 */
/** 去重窗口:超过这个时长的注入记录视为过期(记忆本身没变,但场景大概率变了)。 */
export const DEDUPE_TTL_MS = 30 * 60_000;
/** agent.id → (记忆 id → 注入时间)。无 sessionId 可用时的最小作用域。 */
const recentInjected = new Map();
/** 清空去重状态(仅测试用)。 */
export function resetRecentInjection() {
    recentInjected.clear();
}
/** 记录本轮真正注入的记忆 id。 */
export function rememberInjected(agentKey, ids, now) {
    if (!agentKey || ids.length === 0)
        return;
    let bucket = recentInjected.get(agentKey);
    if (!bucket) {
        bucket = new Map();
        recentInjected.set(agentKey, bucket);
    }
    for (const id of ids)
        if (id)
            bucket.set(id, now);
    // 顺手清理过期项,避免长时间运行后无界增长
    for (const [id, at] of bucket)
        if (now - at > DEDUPE_TTL_MS)
            bucket.delete(id);
    if (bucket.size === 0)
        recentInjected.delete(agentKey);
}
/**
 * 把「窗口内已注入过」的候选降到末尾(稳定排序,其余相对顺序不变)。
 * 不删除:若本轮只有这些候选,仍然要注入,只是不再抢占头部位置。
 */
export function demoteRecentlyInjected(memories, agentKey, now) {
    const bucket = agentKey ? recentInjected.get(agentKey) : undefined;
    if (!bucket || bucket.size === 0)
        return memories;
    const fresh = [];
    const stale = [];
    for (const m of memories) {
        const at = bucket.get(m.id);
        (at !== undefined && now - at <= DEDUPE_TTL_MS ? stale : fresh).push(m);
    }
    return stale.length === 0 ? memories : [...fresh, ...stale];
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
/**
 * 睡眠巩固层召回:把 active 巩固条目并入检索结果(高置信稳定记忆),
 * 命中条目 → touch(越用越稳)+ 联想扩散(附加强关联主题片段)。
 * 受用户隔离约束:userKey 为空(null)的条目共享可见;strict 模式只收当前用户。
 */
function mergeConsolidated(memories, consolidated, userKey, cfg, logger) {
    try {
        const now = Date.now();
        const forgetOpts = {
            confidenceThreshold: cfg.consolidate.confidenceThreshold,
            dormantDays: cfg.consolidate.dormantDays,
        };
        const extra = [];
        // 本轮命中的巩固条目 id:收集起来一次性落盘(见 ConsolidatedStore.touchMany)
        const touched = [];
        for (const m of consolidated.list()) {
            if (m.status !== 'active')
                continue;
            if (m.userKey !== null && m.userKey !== userKey)
                continue; // 归属他人(当前用户存在时)
            if (cfg.user.isolation === 'strict' && m.userKey === null && userKey !== null)
                continue;
            touched.push(m.id);
            extra.push({
                id: m.id,
                content: m.content,
                type: m.type,
                sceneName: '巩固记忆',
                family: '',
                priority: 10, // 高置信稳定记忆优先于细节碎片
                timestampStr: new Date(m.updatedAt).toISOString().slice(0, 10),
            });
            // 联想扩散:强关联(weight ≥ 2)的其他主题最多带 2 条
            const linked = consolidated.strongLinks(m.id, 2, 2);
            for (const l of linked) {
                const lm = consolidated.get(l.id);
                if (!lm || lm.status !== 'active')
                    continue;
                extra.push({
                    id: lm.id,
                    content: lm.content,
                    type: lm.type,
                    sceneName: `联想:${l.weight}`,
                    family: '',
                    priority: 6,
                    timestampStr: new Date(lm.updatedAt).toISOString().slice(0, 10),
                });
            }
        }
        // 一次写入代替「每条一次全量 JSON 重写」
        if (touched.length > 0)
            consolidated.touchMany(touched, now, forgetOpts);
        // 排序分 = 基础优先级 × 时效衰减系数(老记忆最多损失一半分,永不沉底)
        const score = (m) => m.priority * decayFactor(m.timestampStr, now);
        return [...memories, ...extra]
            .sort((a, b) => score(b) - score(a))
            .slice(0, cfg.rebuild.maxResults * 2);
    }
    catch (err) {
        logger.warn(`[recall-rebuild] 巩固层召回失败(仅用底层碎片): ${err instanceof Error ? err.message : String(err)}`);
        return memories;
    }
}
export function registerRecallRebuild(ctx, store, cfg, logger, namespaces, obsLog, consolidated) {
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
            const startedAt = Date.now();
            const query = buildRecallQuery(payload.messages, cfg);
            if (!query)
                return decision;
            // 提取当前 IM 用户键(桌面/无法识别 → null → 不做隔离)
            const userKey = namespaces
                ? extractUserKey(decision.messages.map(blocksToText), cfg.user.sourceTagPattern)
                : null;
            let memories = store.search(query, cfg.rebuild.maxResults);
            const logBase = () => ({
                userKey,
                isolation: cfg.user.isolation,
                query,
                hitCount: memories.length,
                memoryIds: memories.map((m) => m.id),
                fragments: memories.map((m) => m.content),
                rebuilt: '',
                injection: 'none',
                latencyMs: Date.now() - startedAt,
            });
            if (memories.length === 0) {
                if (obsLog)
                    obsLog.log({ ...logBase() });
                return decision;
            }
            // 用户级命名空间隔离:过滤"明确属于其他用户"的记忆
            if (namespaces) {
                memories = namespaces.filter(memories, userKey, cfg.user.isolation);
                if (memories.length === 0) {
                    if (obsLog)
                        obsLog.log({ ...logBase(), error: '隔离过滤后无可用记忆' });
                    return decision;
                }
                // 只把"本轮实际保留"的候选记为当前用户归属(无主记忆随命中归位)
                namespaces.recordHits(userKey, memories);
            }
            // 睡眠巩固层:累积本轮**通过隔离后**命中的碎片(供离线巩固)。
            // 必须在隔离过滤之后:否则 A 用户命中的碎片会以 userKey=null 落进 pending,
            // 巩固成条目后对所有用户可见 —— 跨用户记忆污染。
            if (consolidated) {
                consolidated.addPending(memories.map((m) => ({ id: m.id, content: m.content, userKey })), cfg.consolidate.maxFragmentsPerRun);
            }
            // 睡眠巩固层召回:高置信稳定记忆优先,联想扩散附加强关联主题
            if (consolidated) {
                memories = mergeConsolidated(memories, consolidated, userKey, cfg, logger);
            }
            // 跨轮去重:刚注入过的候选让位(不丢弃),避免每轮都刷同一段回忆
            const agentKey = payload.agent?.id ?? '';
            memories = demoteRecentlyInjected(memories, agentKey, Date.now());
            const rebuilt = await rebuildMemory(ctx, memories, query, cfg.rebuild, payload.signal, logger);
            if (!rebuilt || !rebuilt.text) {
                if (obsLog)
                    obsLog.log({ ...logBase(), error: '重建返回空,跳过注入' });
                return decision;
            }
            const injection = buildInjectionMessage(rebuilt.text, rebuilt.sourceIds, cfg);
            // 记下本轮真正被重建进提示词的记忆,下一轮(同 agent)降权
            rememberInjected(agentKey, rebuilt.sourceIds, Date.now());
            let injectionKind = 'appended';
            if (cfg.inject.strategy === 'replace') {
                const idx = decision.messages.findIndex(isOtherPluginRecall);
                if (idx >= 0) {
                    const msgs = [...decision.messages];
                    msgs[idx] = injection;
                    injectionKind = 'replaced';
                    if (obsLog)
                        obsLog.log({ ...logBase(), rebuilt: rebuilt.text, injection: injectionKind, latencyMs: Date.now() - startedAt });
                    return { kind: 'enter', messages: msgs };
                }
            }
            if (obsLog)
                obsLog.log({ ...logBase(), rebuilt: rebuilt.text, injection: injectionKind, latencyMs: Date.now() - startedAt });
            return { kind: 'enter', messages: [injection, ...decision.messages] };
        }
        catch (err) {
            logger.warn(`[recall-rebuild] 本轮重建注入失败(跳过): ${err instanceof Error ? err.message : String(err)}`);
            return decision;
        }
    }, { prepend: true });
}
