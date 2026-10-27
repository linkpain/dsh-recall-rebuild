/**
 * 插件配置:Schemastery schema + 类型。
 *
 * 默认数据目录:复用 dsh-prime-memory 的 $DSH_HOME/memory(用官方 dshHomePath 解析,
 * DSH_HOME 缺省 ~/.dsh)。键名/默认值/取值范围是部署面契约
 * (cordis.patch.yml 按"整行替换,不深合并"覆盖),不可更名。
 */
import Schema from '@deepseek-ai/schemastery';

/** 重建式回忆引擎选项。 */
export interface RebuildOptions {
  /** 重建总开关;false = 退化为原文检索注入(仍走本插件的检索与注入)。 */
  enabled: boolean;
  /** 每轮检索的记忆条数。 */
  maxResults: number;
  /** 单条记忆进重建 prompt 的字符上限。 */
  maxMemoryChars: number;
  /** 全部记忆进重建 prompt 的总字符上限。 */
  maxTotalChars: number;
  /** 重建片段输出字符上限。 */
  maxOutputChars: number;
  /** 重建调用温度。 */
  temperature: number;
  /** 重建调用输出 token 上限。 */
  maxTokens: number;
  /** 重建总超时(ms);超时跳过本轮,绝不阻塞对话。 */
  timeoutMs: number;
}

/** 注入策略与预算。 */
export interface InjectOptions {
  /** replace = 替换其它插件(如 prime-memory)已注入的原文召回;append = 追加一条重建消息。 */
  strategy: 'replace' | 'append';
  /** 注入正文单条字符上限。 */
  maxChars: number;
  /** 注入时附记忆来源 id 标注。 */
  includeSources: boolean;
}

/** 召回查询构建选项。 */
export interface QueryOptions {
  /** 召回查询取会话末尾消息条数。 */
  tailMessages: number;
  /** 召回查询字符上限。 */
  maxChars: number;
}

/** IM 用户级命名空间隔离选项。 */
export interface UserIsolationOptions {
  /**
   * 隔离模式:
   * - 'off':不过滤(所有用户共享全部记忆,旧行为);
   * - 'auto':剔除「明确属于其他用户」的记忆,无主记忆默认可见(命中后归位);
   * - 'strict':只注入「已归属当前用户」的记忆,新用户零记忆起步(随会话命中逐渐归位)。
   * 桌面直接对话(识别不到 IM 用户)时任何模式都不过滤。
   */
  isolation: 'off' | 'auto' | 'strict';
  /** 归属索引目录;空 = <DSH_HOME>/recall-rebuild/namespaces(缺省 ~/.dsh/...)。 */
  isolationDir: string;
  /** 覆盖内置 <dsh_im_source> 解析正则(不同桥接插件字段不同时可自定义);空 = 内置。 */
  sourceTagPattern: string;
}

/** 重建质量可观测选项。 */
export interface ObservabilityOptions {
  /** 每轮重建审计日志开关(JSON Lines,按天滚动)。 */
  logEnabled: boolean;
  /** 日志目录;空 = <DSH_HOME>/recall-rebuild/logs。 */
  logDir: string;
  /** 日志是否记录原始检索碎片(与重建片段同屏对比);false 只记重建结果。 */
  includeFragments: boolean;
  /** 是否写统计文件 stats.json(30s 节流)。 */
  statsEnabled: boolean;
}

/** 睡眠巩固(长期记忆子系统)选项。 */
export interface ConsolidateOptions {
  /** 巩固总开关。 */
  enabled: boolean;
  /** 巩固层目录;空 = <DSH_HOME>/recall-rebuild/consolidated。 */
  dir: string;
  /** 待巩固碎片累积达到多少条才触发一次巩固。 */
  minFragments: number;
  /** 距上次巩固的最短间隔(ms);防止巩固过于频繁。 */
  minIntervalMs: number;
  /** 定时检查间隔(ms)。 */
  checkIntervalMs: number;
  /** 单次巩固最多处理的碎片条数。 */
  maxFragmentsPerRun: number;
  /** 聚类相似度阈值(0-1);同主题碎片 ≥ 阈值归为一簇。 */
  clusterThreshold: number;
  /** 单簇最多碎片条数。 */
  maxCluster: number;
  /** 单条巩固输出字符上限。 */
  maxOutputChars: number;
  /** 巩固调用温度(巩固要稳,默认低于重建)。 */
  temperature: number;
  /** 巩固调用输出 token 上限。 */
  maxTokens: number;
  /** 单簇巩固超时(ms);离线任务可放宽。 */
  timeoutMs: number;
  /** 遗忘阈值:置信度低于它且长期未命中 → dormant(召回降权)。 */
  confidenceThreshold: number;
  /** 多少天未命中(且低置信)进入 dormant。 */
  dormantDays: number;
}

export interface RecallRebuildConfig {
  /** 总开关。 */
  enabled: boolean;
  /** prime-memory 数据目录;空 = $DSH_HOME/memory(默认)。 */
  dataDir: string;
  /**
   * 记忆来源:
   * - 'auto':自动探测 —— prime-memory 库存在则读它,否则依次尝试 dsh-memory(JSON)与 memory-palace(Markdown);
   * - 'prime':只读 dsh-prime-memory 的 SQLite 库($dataDir/memory.db);
   * - 'dsh-memory':只读 @max-null/dsh-memory 的 JSON 记忆(~/.dsh/storages/memory.json 与 <cwd>/.dsh/storages/);
   * - 'palace':只读 dsh-memory-palace 的 Markdown 文件(~/.deepseek-harness/MEMORY.md 与 <cwd>/.deepseek-harness/memory/)。
   */
  source: 'auto' | 'prime' | 'dsh-memory' | 'palace';
  rebuild: RebuildOptions;
  inject: InjectOptions;
  query: QueryOptions;
  user: UserIsolationOptions;
  observability: ObservabilityOptions;
  consolidate: ConsolidateOptions;
}

export const recallRebuildSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  dataDir: Schema.string().default(''),
  source: Schema.union(['auto', 'prime', 'dsh-memory', 'palace']).default('auto'),
  rebuild: Schema.object({
    enabled: Schema.boolean().default(true),
    maxResults: Schema.number().min(1).max(20).default(5),
    maxMemoryChars: Schema.number().min(50).max(2000).default(400),
    maxTotalChars: Schema.number().min(200).max(8000).default(2000),
    maxOutputChars: Schema.number().min(40).max(4000).default(600),
    temperature: Schema.number().min(0).max(1.5).default(0.7),
    maxTokens: Schema.number().min(64).max(4096).default(1024),
    timeoutMs: Schema.number().min(500).max(30000).default(8000),
  }).default({}),
  inject: Schema.object({
    strategy: Schema.union(['replace', 'append']).default('replace'),
    maxChars: Schema.number().min(100).max(8000).default(1200),
    includeSources: Schema.boolean().default(true),
  }).default({}),
  query: Schema.object({
    tailMessages: Schema.number().min(1).max(30).default(8),
    maxChars: Schema.number().min(100).max(4000).default(1200),
  }).default({}),
  user: Schema.object({
    isolation: Schema.union(['off', 'auto', 'strict']).default('auto'),
    isolationDir: Schema.string().default(''),
    sourceTagPattern: Schema.string().default(''),
  }).default({}),
  observability: Schema.object({
    logEnabled: Schema.boolean().default(true),
    logDir: Schema.string().default(''),
    includeFragments: Schema.boolean().default(true),
    statsEnabled: Schema.boolean().default(true),
  }).default({}),
  consolidate: Schema.object({
    enabled: Schema.boolean().default(true),
    dir: Schema.string().default(''),
    minFragments: Schema.number().min(5).max(200).default(20),
    minIntervalMs: Schema.number().min(60000).max(86400000 * 7).default(21600000),
    checkIntervalMs: Schema.number().min(60000).max(86400000).default(3600000),
    maxFragmentsPerRun: Schema.number().min(10).max(200).default(50),
    clusterThreshold: Schema.number().min(0.05).max(0.9).default(0.25),
    maxCluster: Schema.number().min(2).max(20).default(8),
    maxOutputChars: Schema.number().min(40).max(2000).default(400),
    temperature: Schema.number().min(0).max(1.5).default(0.4),
    maxTokens: Schema.number().min(64).max(4096).default(1024),
    timeoutMs: Schema.number().min(1000).max(120000).default(20000),
    confidenceThreshold: Schema.number().min(0.1).max(0.9).default(0.4),
    dormantDays: Schema.number().min(3).max(365).default(30),
  }).default({}),
}).default({});
