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
import type { Context } from '@deepseek-ai/cordis';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { recallRebuildSchema, type RecallRebuildConfig } from './config.js';
import { openMemorySource, type LoggerLike } from './store.js';
import { registerRecallRebuild } from './recall.js';
import { NamespaceStore } from './namespace.js';
import { RebuildLogger } from './observability.js';
import { ConsolidatedStore } from './consolidated.js';
import { runConsolidation } from './consolidate.js';
import { registerRecallRebuildCommands } from './commands.js';

export const name = 'recall-rebuild';
export const inject = ['llm', 'commands?'];
export const Config = recallRebuildSchema;

function resolveDataDir(config: RecallRebuildConfig, logger: LoggerLike): string {
  if (config.dataDir) return config.dataDir;
  try {
    const home = dshHomePath();
    if (home) return path.join(home, 'memory');
  } catch {
    /* 落到兜底 */
  }
  const base = process.env.HOME || process.env.USERPROFILE || '';
  const fallback = base ? path.join(base, '.dsh', 'memory') : '';
  if (!fallback) {
    logger.warn(`[recall-rebuild] 无法确定 $DSH_HOME,请在 config.dataDir 显式指定记忆库目录`);
  }
  return fallback;
}

/** 用户隔离归属目录:<DSH_HOME>/recall-rebuild/namespaces(缺省 ~/.dsh/recall-rebuild/namespaces)。 */
function resolveIsolationDir(config: RecallRebuildConfig, logger: LoggerLike): string {
  if (config.user.isolationDir) return config.user.isolationDir;
  try {
    const home = dshHomePath();
    if (home) return path.join(home, 'recall-rebuild', 'namespaces');
  } catch {
    /* 落到兜底 */
  }
  const base = process.env.HOME || process.env.USERPROFILE || '';
  const fallback = base ? path.join(base, '.dsh', 'recall-rebuild', 'namespaces') : '';
  if (!fallback) {
    logger.warn(`[recall-rebuild] 无法确定用户隔离目录,请在 config.user.isolationDir 显式指定`);
  }
  return fallback;
}

/** 重建日志目录:<DSH_HOME>/recall-rebuild/logs(缺省 ~/.dsh/recall-rebuild/logs)。 */
function resolveLogDir(config: RecallRebuildConfig, logger: LoggerLike): string {
  if (config.observability.logDir) return config.observability.logDir;
  try {
    const home = dshHomePath();
    if (home) return path.join(home, 'recall-rebuild', 'logs');
  } catch {
    /* 落到兜底 */
  }
  const base = process.env.HOME || process.env.USERPROFILE || '';
  const fallback = base ? path.join(base, '.dsh', 'recall-rebuild', 'logs') : '';
  if (!fallback) {
    logger.warn(`[recall-rebuild] 无法确定日志目录,请在 config.observability.logDir 显式指定`);
  }
  return fallback;
}

/** 睡眠巩固层目录:<DSH_HOME>/recall-rebuild/consolidated(缺省 ~/.dsh/recall-rebuild/consolidated)。 */
function resolveConsolidateDir(config: RecallRebuildConfig, logger: LoggerLike): string {
  if (config.consolidate.dir) return config.consolidate.dir;
  try {
    const home = dshHomePath();
    if (home) return path.join(home, 'recall-rebuild', 'consolidated');
  } catch {
    /* 落到兜底 */
  }
  const base = process.env.HOME || process.env.USERPROFILE || '';
  const fallback = base ? path.join(base, '.dsh', 'recall-rebuild', 'consolidated') : '';
  if (!fallback) {
    logger.warn(`[recall-rebuild] 无法确定巩固层目录,请在 config.consolidate.dir 显式指定`);
  }
  return fallback;
}

export async function apply(ctx: Context, config: RecallRebuildConfig): Promise<void> {
  const logger: LoggerLike = ctx.logger;
  const dataDir = resolveDataDir(config, logger);
  // 工作目录:用于定位 memory-palace 的工作区记忆文件(默认 DSH 进程 cwd)
  const cwd = process.cwd();

  // 可插拔记忆源:prime(SQLite FTS5)| palace(Markdown 文件)| auto(自动探测)
  const store = openMemorySource(config.source, { dataDir, cwd, logger });
  ctx.effect(() => () => store.close());

  // IM 用户级命名空间隔离(自己的目录,绝不写底层记忆库)
  const namespaces = new NamespaceStore(resolveIsolationDir(config, logger), logger);
  namespaces.ensureDir();

  // 重建质量可观测:每轮 JSONL 日志 + 统计(自己的目录)
  const obsLog = new RebuildLogger({
    logDir: resolveLogDir(config, logger),
    enabled: config.observability.logEnabled,
    includeFragments: config.observability.includeFragments,
    logger,
  });

  // 睡眠巩固层(长期记忆子系统):自己的目录,底层记忆库保持只读
  const consolidated = new ConsolidatedStore(resolveConsolidateDir(config, logger), logger);
  consolidated.load();

  if (store.ok) {
    logger.info(`[recall-rebuild] 已只读挂载记忆库: ${store.label}`);
  } else {
    logger.warn(
      `[recall-rebuild] 记忆库不可用(${store.label}),插件按只观察模式运行(不注入)。` +
        `请先安装并运行 dsh-prime-memory / dsh-memory-palace,或确认 config.dataDir / cwd 正确`,
    );
  }

  registerRecallRebuild(ctx, store, config, logger, namespaces, obsLog, consolidated);

  // 巩固层交互命令(可选依赖:宿主无 commands 服务时静默跳过,不影响插件主体)
  registerRecallRebuildCommands(ctx, store, consolidated, config, logger);

  // 睡眠巩固调度:启动后空闲 10s 查一次,之后按 checkIntervalMs 定时查;
  // 触发条件由 shouldRun 判定(pending 达标 + 距上次巩固超间隔),真正执行时
  // 在空闲间隙异步跑,绝不阻塞对话;失败保留 pending 下次再试。
  const runIfDue = async () => {
    try {
      if (consolidated.shouldRun(config.consolidate, Date.now())) {
        await runConsolidation(ctx, store, consolidated, config.consolidate, logger);
      }
    } catch (err) {
      logger.warn(
        `[recall-rebuild] 睡眠巩固调度失败(下次再试): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const firstTimer = setTimeout(() => void runIfDue(), 10_000);
  const interval = setInterval(() => void runIfDue(), config.consolidate.checkIntervalMs);
  ctx.effect(() => () => {
    clearTimeout(firstTimer);
    clearInterval(interval);
  });
  logger.info(
    `[recall-rebuild] 重建式回忆增强就绪 ` +
      `(rebuild=${config.rebuild.enabled}, inject=${config.inject.strategy}, source=${config.source}, ` +
      `isolation=${config.user.isolation}, log=${config.observability.logEnabled}, ` +
      `consolidate=${config.consolidate.enabled})`,
  );
}
