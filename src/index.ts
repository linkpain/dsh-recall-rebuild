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

export const name = 'recall-rebuild';
export const inject = ['llm'];
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

  if (store.ok) {
    logger.info(`[recall-rebuild] 已只读挂载记忆库: ${store.label}`);
  } else {
    logger.warn(
      `[recall-rebuild] 记忆库不可用(${store.label}),插件按只观察模式运行(不注入)。` +
        `请先安装并运行 dsh-prime-memory / dsh-memory-palace,或确认 config.dataDir / cwd 正确`,
    );
  }

  registerRecallRebuild(ctx, store, config, logger, namespaces);
  logger.info(
    `[recall-rebuild] 重建式回忆增强就绪 ` +
      `(rebuild=${config.rebuild.enabled}, inject=${config.inject.strategy}, source=${config.source}, ` +
      `isolation=${config.user.isolation})`,
  );
}
