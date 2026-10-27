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
}).default({});
