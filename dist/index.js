/**
 * dsh-recall-rebuild —— 重建式回忆增强插件(DeepSeek Harness)。
 *
 * 定位:现有记忆插件(首选 dsh-prime-memory)的【增强层】。
 * - 只读现有记忆库(不重写捕获管线、不写任何数据);
 * - 在每步模型推理前把检索到的记忆碎片交给 LLM「生成式重建」为
 *   带语境/情绪的回忆片段注入,替代生硬的原文/摘要注入;
 * - 超时/失败一律跳过本轮,绝不阻塞对话。
 */
import * as path from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { recallRebuildSchema } from './config.js';
import { describeSources, openSource } from './sources/index.js';
import { registerRecallRebuild } from './recall.js';
import { NamespaceStore } from './namespace.js';
import { RebuildLogger } from './observability.js';
import { ConsolidatedStore } from './consolidated.js';
import { runConsolidation } from './consolidate.js';
import { registerRecallRebuildCommands } from './commands.js';
import { mountSeaWeb } from './web.js';
export { DIFFUSE_OPTS } from './recall.js';
export const name = 'recall-rebuild';
// 只声明真正的硬依赖。可选服务(commands / webServer)一律用 ctx.inject([...])
// 在 apply 里动态挂载:inject 数组里的名字会被 cordis 当成服务名逐个等待,
// 写成 'commands?' 不会变成可选,只会让插件永远停在 PENDING。
export const inject = ['llm'];
export const Config = recallRebuildSchema;
/**
 * 解析插件自己用的目录:显式配置优先,否则 <DSH_HOME>/<segments…>。
 *
 * 四套目录(记忆库 / 隔离索引 / 日志 / 巩固层)的解析规则一模一样,只是段名与
 * 提示语不同;以前是四个逐字复制的函数,改一处就得记得改四处。
 * 拿不到 DSH_HOME 时退回 ~/.dsh/<segments…>,并提示用户显式配置。
 */
function resolveDir(explicit, segments, hint, logger) {
    if (explicit)
        return explicit;
    try {
        const home = dshHomePath();
        if (home)
            return path.join(home, ...segments);
    }
    catch {
        /* 落到兜底 */
    }
    const base = process.env.HOME || process.env.USERPROFILE || '';
    const fallback = base ? path.join(base, '.dsh', ...segments) : '';
    if (!fallback) {
        logger.warn(`[recall-rebuild] 无法确定 $DSH_HOME,${hint}`);
    }
    return fallback;
}
export async function apply(ctx, config) {
    const logger = ctx.logger;
    const dataDir = resolveDir(config.dataDir, ['memory'], '请在 config.dataDir 显式指定记忆库目录', logger);
    // 工作目录:用于定位 memory-palace 的工作区记忆文件(默认 DSH 进程 cwd)
    const cwd = process.cwd();
    // 可插拔记忆源:auto 探测并打开本机所有已知记忆插件(SQLite / Markdown / JSON / JSONL),多源 RRF 融合
    const store = openSource(config.source, {
        dataDir,
        cwd,
        logger,
        refreshMs: config.sourceRefreshMs,
    });
    ctx.effect(() => () => store.close());
    // IM 用户级命名空间隔离(自己的目录,绝不写底层记忆库)
    const namespaces = new NamespaceStore(resolveDir(config.user.isolationDir, ['recall-rebuild', 'namespaces'], '请在 config.user.isolationDir 显式指定用户隔离目录', logger), logger);
    namespaces.ensureDir();
    // 重建质量可观测:每轮 JSONL 日志 + 统计(自己的目录)
    const obsLog = new RebuildLogger({
        logDir: resolveDir(config.observability.logDir, ['recall-rebuild', 'logs'], '请在 config.observability.logDir 显式指定日志目录', logger),
        enabled: config.observability.logEnabled,
        includeFragments: config.observability.includeFragments,
        retainDays: config.observability.retainDays,
        logger,
    });
    // 睡眠巩固层(长期记忆子系统):自己的目录,底层记忆库保持只读
    const consolidated = new ConsolidatedStore(resolveDir(config.consolidate.dir, ['recall-rebuild', 'consolidated'], '请在 config.consolidate.dir 显式指定巩固层目录', logger), logger);
    consolidated.load();
    if (store.ok) {
        logger.info(`[recall-rebuild] 已只读挂载记忆库: ${store.label}`);
    }
    else {
        logger.warn(`[recall-rebuild] 记忆库不可用(${store.label}),插件按只观察模式运行(不注入)。` +
            `请安装任一受支持的记忆插件(dsh-prime-memory / dsh-loci / dsh-mnemon / dsh-memory-palace 等),` +
            `或用 config.source 显式指定已装的源`);
    }
    registerRecallRebuild(ctx, store, config, logger, namespaces, obsLog, consolidated);
    // 巩固层交互命令(可选依赖:宿主无 commands 服务时静默跳过,不影响插件主体)。
    // 用 ctx.inject 动态等待,而不是写进模块级 inject —— 后者是硬依赖,缺服务会让
    // 整个插件停在 PENDING,连记忆注入与识海都一起不生效。
    ctx.inject(['commands'], (cctx) => {
        registerRecallRebuildCommands(cctx, store, consolidated, config, logger, () => describeSources({ dataDir, cwd, logger, refreshMs: config.sourceRefreshMs }));
    });
    // 记忆识海可视化(可选):把巩固层投影成星云图挂在 Web GUI 里。
    // webServer 不存在时(纯对话部署)什么都不做,不影响插件主体。
    mountSeaWeb(ctx, () => consolidated, {
        enabled: config.sea.enabled,
        maxNodes: config.sea.maxNodes,
        logger,
    });
    // 睡眠巩固调度:启动后空闲 10s 查一次,之后按 checkIntervalMs 定时查;
    // 触发条件由 shouldRun 判定(pending 达标 + 距上次巩固超间隔),真正执行时
    // 在空闲间隙异步跑,绝不阻塞对话;失败保留 pending 下次再试。
    const runIfDue = async () => {
        try {
            if (consolidated.shouldRun(config.consolidate, Date.now())) {
                await runConsolidation(ctx, store, consolidated, config.consolidate, logger);
            }
        }
        catch (err) {
            logger.warn(`[recall-rebuild] 睡眠巩固调度失败(下次再试): ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const firstTimer = setTimeout(() => void runIfDue(), 10_000);
    const interval = setInterval(() => void runIfDue(), config.consolidate.checkIntervalMs);
    ctx.effect(() => () => {
        clearTimeout(firstTimer);
        clearInterval(interval);
    });
    logger.info(`[recall-rebuild] 重建式回忆增强就绪 ` +
        `(rebuild=${config.rebuild.enabled}, inject=${config.inject.strategy}, source=${config.source}, ` +
        `isolation=${config.user.isolation}, log=${config.observability.logEnabled}, ` +
        `consolidate=${config.consolidate.enabled})`);
}
