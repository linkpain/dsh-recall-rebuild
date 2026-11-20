/**
 * 重建质量可观测:每轮重建的完整审计日志 + 轻量统计。
 *
 * 目的:让用户直接看到「同一批记忆,原文检索碎片 ↔ 重建后片段」的差异,
 * 自己判断重建式回忆是否真的更好(注入效果对比,零额外注入、零 token 成本)。
 *
 * 日志:按天滚动 JSON Lines(<logDir>/recall-YYYY-MM-DD.log),
 * 每轮 pre-step 写一条;目录自动创建,写失败静默(不阻塞对话)。
 * 统计:<logDir>/stats.json,内存累计 + 30s 节流原子写。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
function truncate(s, max) {
    if (!s)
        return '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
export class RebuildLogger {
    logDir;
    enabled;
    includeFragments;
    logger;
    roundNo = 0;
    stats = {
        rounds: 0,
        hits: 0,
        rebuilt: 0,
        injected: 0,
        replaced: 0,
        errors: 0,
        lastRoundAt: '',
    };
    lastStatsWrite = 0;
    statsIntervalMs = 30_000;
    constructor(opts) {
        this.logDir = opts.logDir;
        this.enabled = opts.enabled;
        this.includeFragments = opts.includeFragments;
        this.logger = opts.logger;
    }
    /** 当前轮日志文件名(按天滚动)。 */
    todayFile() {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `recall-${d.getFullYear()}-${mm}-${dd}.log`;
    }
    /**
     * 记录一轮。
     * @param partial 必填字段之外的内容;fragments 仅 includeFragments 时保留
     */
    log(partial) {
        this.roundNo += 1;
        this.stats.rounds += 1;
        if (partial.hitCount > 0)
            this.stats.hits += 1;
        // rebuilt = 实际发生重建流程且成功的轮数(零命中/报错不计)
        if (!partial.error && partial.hitCount > 0)
            this.stats.rebuilt += 1;
        if (partial.injection !== 'none')
            this.stats.injected += 1;
        if (partial.injection === 'replaced')
            this.stats.replaced += 1;
        if (partial.error)
            this.stats.errors += 1;
        this.stats.lastRoundAt = new Date().toISOString();
        if (!this.enabled)
            return;
        const entry = {
            ts: new Date().toISOString(),
            round: this.roundNo,
            userKey: partial.userKey,
            isolation: partial.isolation,
            query: truncate(partial.query, 300),
            hitCount: partial.hitCount,
            memoryIds: partial.memoryIds.slice(0, 10),
            fragments: this.includeFragments
                ? (partial.fragments ?? []).slice(0, 5).map((f) => truncate(f, 200))
                : [],
            rebuilt: truncate(partial.rebuilt, 600),
            rebuiltChars: partial.rebuilt.length,
            injection: partial.injection,
            latencyMs: partial.latencyMs,
            ...(partial.error ? { error: truncate(partial.error, 300) } : {}),
        };
        try {
            fs.mkdirSync(this.logDir, { recursive: true });
            fs.appendFileSync(path.join(this.logDir, this.todayFile()), `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch (err) {
            this.logger.warn(`[recall-rebuild] 写重建日志失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 统计节流落盘
        if (Date.now() - this.lastStatsWrite > this.statsIntervalMs)
            this.flushStats();
    }
    /** 原子写 stats.json(节流外也可主动调用)。 */
    flushStats() {
        this.lastStatsWrite = Date.now();
        try {
            fs.mkdirSync(this.logDir, { recursive: true });
            const p = path.join(this.logDir, 'stats.json');
            const tmp = `${p}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.stats, null, 2), 'utf8');
            fs.renameSync(tmp, p);
        }
        catch (err) {
            this.logger.warn(`[recall-rebuild] 写统计文件失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 当前累计统计(读给宿主用)。 */
    snapshot() {
        return { ...this.stats };
    }
}
/** 给 verify 用的纯函数:从日志条目提取碎片对比段(原文 vs 重建)。 */
export function fragmentSample(entry) {
    return { original: entry.fragments ?? [], rebuilt: entry.rebuilt };
}
