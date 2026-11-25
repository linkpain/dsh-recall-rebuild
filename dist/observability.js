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
    /** 日志保留天数(0 = 永不清理);按天滚动的文件靠它兜住磁盘。 */
    retainDays;
    lastPruneAt = 0;
    pruneIntervalMs = 60 * 60_000;
    constructor(opts) {
        this.logDir = opts.logDir;
        this.enabled = opts.enabled;
        this.includeFragments = opts.includeFragments;
        this.logger = opts.logger;
        this.retainDays = opts.retainDays ?? 0;
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
        // 过期日志清理:每小时最多扫一次目录,免得每轮都 readdir
        if (this.retainDays > 0 && Date.now() - this.lastPruneAt > this.pruneIntervalMs) {
            this.lastPruneAt = Date.now();
            this.pruneOldLogs();
        }
    }
    /**
     * 删除超过保留天数的按天日志文件。
     *
     * 只认自己写出来的命名(recall-YYYY-MM-DD.log),别的文件一律不碰 —— 用户可能把
     * logDir 指到一个共用目录,误删别人的日志比留着旧日志糟糕得多。
     */
    pruneOldLogs() {
        if (this.retainDays <= 0)
            return;
        const cutoff = Date.now() - this.retainDays * 86_400_000;
        let names = [];
        try {
            names = fs.readdirSync(this.logDir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const m = /^recall-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
            if (!m)
                continue;
            const at = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
            if (!Number.isFinite(at) || at >= cutoff)
                continue;
            try {
                fs.unlinkSync(path.join(this.logDir, name));
            }
            catch {
                /* 删不掉就下次再说,清理不该影响写日志 */
            }
        }
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
