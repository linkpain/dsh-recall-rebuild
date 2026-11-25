import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { clusterize, findSupersedePairs, findTwin, isDormant, parseConsolidationOutput, } from './consolidated.js';
import { resolveModelRoute } from './rebuild.js';
const CONSOLIDATE_SYSTEM = `你是长期记忆巩固器,服务于一位用户的日常对话助手。

现在给你一批「同一主题」的真实记忆碎片(来自该用户多轮对话的检索命中)。
请把它们整合为稳定的长期记忆条目:提取跨时间的稳定事实、偏好、规律与关系,
忽略一次性噪音(具体某天的琐事、临时情绪波动)。

硬性要求:
1. 只使用碎片中确实出现的信息;严禁编造碎片中没有的事实、日期、人物或偏好。
2. 每条内容用一句稳定、自然的中文陈述,不要列点、不要解释。
3. type 取值:stable-fact(稳定事实)/ pattern(行为规律)/ preference(偏好)/
   relationship(人物关系)/ mood(情绪基调)。
4. 最多输出 3 条。
5. 只输出一个 JSON 对象,格式:{"memories":[{"type":"preference","content":"..."}]}
   不要输出任何其他文字。`;
/** 簇内全部碎片归属同一用户 → 条目归属该用户;混合/无主 → null(共享/桌面)。 */
function unifyUserKey(frags) {
    const keys = new Set(frags.map((f) => f.userKey).filter((k) => !!k));
    return keys.size === 1 ? (Array.from(keys)[0] ?? null) : null;
}
/**
 * 置信度:来源碎片越多越稳(0.25 起,每多 1 条 +0.1,封顶 0.9)。
 *
 * 起点必须低于默认 confidenceThreshold(0.4):否则「只被单次观察支撑」的条目
 * 一开始就 ≥0.6,isDormant 的第一条分支永远命中,遗忘扫描成为死代码。
 * 现在的语义是:1 条碎片 → 0.35(脆弱,长期不再被想起就会休眠),
 * 2 条 → 0.45(过线,稳定),碎片越多越稳。
 */
function calcConfidence(fragmentCount) {
    return Math.min(0.9, 0.25 + fragmentCount * 0.1);
}
async function consolidateText(ctx, route, frags, opts, signal) {
    const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: CONSOLIDATE_SYSTEM,
        messages: [
            createUserMessage({
                content: [{ type: 'text', text: frags.map((f, i) => `${i + 1}. ${f}`).join('\n') }],
                source: { kind: 'user' },
            }),
        ],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal,
    });
    let text = '';
    for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
        }
    }
    return text;
}
/**
 * 执行一次巩固。返回执行结果;任何失败都不抛错:
 * 无路由/超时/解析失败 → 保留 pending,由调用方继续调度。
 */
export async function runConsolidation(ctx, _store, consolidated, opts, logger, 
/**
 * 本次巩固的「当前时刻」,仅供测试注入。
 *
 * 生产不传、走 Date.now()。但联想边带半衰期衰减,断言要验证「反复观察 12 轮后
 * 55 天仍扩散得出来」就必须能推进时钟;若测试只能贴着真实时间跑,这类跨时间
 * 行为就永远测不到——上一版联想扩散失效正是这样漏过去的。
 */
nowOverride) {
    if (!opts.enabled) {
        return { produced: false, clusters: 0, entries: 0, decayed: 0, revived: 0, superseded: 0, reinforced: 0, pending: 0 };
    }
    const now = nowOverride ?? Date.now();
    const pending = consolidated.pending();
    if (pending.length === 0) {
        return { produced: false, clusters: 0, entries: 0, decayed: 0, revived: 0, superseded: 0, reinforced: 0, pending: 0 };
    }
    const route = resolveModelRoute(ctx);
    if (!route) {
        logger.debug?.('[recall-rebuild] 巩固:未解析到默认模型路由,保留 pending 下次再试');
        return { produced: false, clusters: 0, entries: 0, decayed: 0, revived: 0, superseded: 0, reinforced: 0, pending: pending.length };
    }
    const items = pending.slice(-opts.maxFragmentsPerRun);
    const clusters = clusterize(items.map((p) => ({ id: p.id, content: p.content })), opts.clusterThreshold, opts.maxCluster);
    let produced = false;
    const producedIds = [];
    // 本轮产出的条目(含 type/content/userKey),供改口/强化检测比对
    const freshEntries = [];
    // 与已有条目几乎重复的产出 → 不新建,改为强化那条已有记忆
    const reinforceIds = [];
    let reinforced = 0;
    for (const ids of clusters) {
        const frags = items.filter((p) => ids.includes(p.id));
        if (frags.length === 0)
            continue;
        let text;
        try {
            // 超时必须真的传到 llm.stream:此前 ac.abort() 没人监听,定时器形同虚设,
            // 一次卡住的巩固会一直挂到宿主退出。
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
            try {
                text = await consolidateText(ctx, route, frags.map((f) => f.content), opts, ac.signal);
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch (err) {
            logger.warn(`[recall-rebuild] 巩固:单簇抽象失败(跳过该簇): ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        const parsed = parseConsolidationOutput(text ?? '');
        if (parsed.length === 0)
            continue;
        const userKey = unifyUserKey(frags);
        const sourceIds = frags.map((f) => f.id);
        // 同一簇的多条产出先攒起来,循环后一次性落盘(避免逐条全量重写 memories.json)
        const fresh = [];
        // 本簇本轮「观察到的」条目 = 新产出的 + 被强化的旧条目。联想边只以它们为端点。
        const clusterObserved = new Set();
        for (const p of parsed) {
            // 同一件事又被观察了一次:强化旧条目(置信度上调),而不是再造一条近义重复
            const twin = findTwin(p.content, p.type, userKey, consolidated.list(), opts.reinforceThreshold);
            if (twin) {
                reinforceIds.push(twin.id);
                clusterObserved.add(twin.id);
                reinforced += 1;
                produced = true;
                continue;
            }
            const id = `c_${now}_${Math.random().toString(36).slice(2, 8)}`;
            fresh.push({
                id,
                userKey,
                type: p.type,
                content: p.content,
                sourceIds,
                confidence: calcConfidence(frags.length),
                status: 'active',
                createdAt: now,
                updatedAt: now,
                touchCount: 0,
            });
            producedIds.push(id);
            clusterObserved.add(id);
            freshEntries.push({ id, type: p.type, content: p.content, userKey });
            produced = true;
        }
        consolidated.upsertMany(fresh);
        // 联想扩散(按簇连边):只有「同一簇」的条目才互为联想,跨簇的两条只是同一轮里
        // 碰巧一起被巩固,并无语义关联,连上就是噪音。
        //
        // 端点必须包含「被强化的旧条目」而不只是新产出:条目 id 只在新建时生成,同一件事
        // 被反复观察走的是 findTwin → 强化旧条目,永远产不出新 id。若只用新产出连边,
        // 同一对条目的边就永远停在第一次共现那天、权重恒为 1,衰减照走 —— 联想会随时间
        // 彻底消失,且再怎么重复提起也重建不回来。
        const observed = [...clusterObserved];
        if (observed.length > 1) {
            const pairs = [];
            for (let i = 0; i < observed.length; i++) {
                for (let j = i + 1; j < observed.length; j++) {
                    const a = observed[i];
                    const b = observed[j];
                    if (!a || !b)
                        continue;
                    pairs.push([a, b]);
                }
            }
            // 传 now:边权累加的同时把 at 前移,衰减被这次共现抵消,联想「越用越牢」
            consolidated.addLinks(pairs, '同轮巩固', now);
        }
    }
    // 改口覆盖:新条目与旧条目「几乎同一句话、只差一个值」(同一用户同一类型)时,
    // 旧条目标记为 superseded —— 只降权不删除,用户日后想翻案还有据可查。
    // 检测必须在新条目落盘之后、遗忘扫描之前:被取代的条目不该再走休眠判定。
    const supersedePairs = findSupersedePairs(freshEntries, consolidated.list(), opts.supersedeThreshold);
    const superseded = consolidated.supersedeMany(supersedePairs, now);
    // 重复观察强化:与「改口覆盖」互斥 —— 同一条旧记忆要么被取代,要么被强化
    const forgetOptsForReinforce = {
        confidenceThreshold: opts.confidenceThreshold,
        dormantDays: opts.dormantDays,
    };
    if (reinforceIds.length > 0)
        consolidated.reinforceMany(reinforceIds, now, forgetOptsForReinforce);
    // 遗忘/唤醒扫描(双向):低置信 + 长期未命中 → dormant;
    // 休眠但重新攒够证据(命中抬了 confidence、或用户 edit 过)→ active。
    // 单向扫描会让 dormant 变成不可逆的死亡状态,这里必须两边都算。
    const forgetOpts = { confidenceThreshold: opts.confidenceThreshold, dormantDays: opts.dormantDays };
    let decayed = 0;
    let revived = 0;
    for (const m of consolidated.list()) {
        if (m.status === 'superseded')
            continue; // 已被取代:不参与遗忘/唤醒扫描
        const shouldSleep = isDormant(m, now, forgetOpts);
        if (shouldSleep && m.status !== 'dormant') {
            m.status = 'dormant';
            m.updatedAt = now;
            decayed += 1;
        }
        else if (!shouldSleep && m.status === 'dormant') {
            m.status = 'active';
            m.updatedAt = now;
            revived += 1;
        }
    }
    // 只清掉本轮真正处理过的碎片:原先无差别 clearPending 会把超出
    // maxFragmentsPerRun 的旧碎片一并丢掉(它们既没被巩固,也没机会重试)。
    consolidated.clearPending(items.map((p) => p.id));
    consolidated.markRun(now);
    consolidated.saveAll();
    logger.info(`[recall-rebuild] 睡眠巩固完成: 簇 ${clusters.length}, 产出 ${producedIds.length} 条, ` +
        `遗忘 ${decayed} 条, 唤醒 ${revived} 条, 取代 ${superseded} 条, 强化 ${reinforced} 次`);
    return {
        produced,
        clusters: clusters.length,
        entries: producedIds.length,
        decayed,
        revived,
        superseded,
        reinforced,
        pending: pending.length,
    };
}
