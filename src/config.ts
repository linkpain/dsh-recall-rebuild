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
  /**
   * 注入位置固定为「消息批次末尾」—— 提示词缓存按逐字节前缀命中,插头部或改写历史中部
   * 都会在注入点切断前缀,让整段历史缓存每轮全废。两种策略的差别只在末尾:
   * - replace = 本 step 批次里已有本插件自己的注入(同 step 重试)时原位替换,避免重复;
   * - append  = 无条件追加一条新的重建消息。
   * 其它插件的原文召回在任何策略下都不再被改写(改写历史中部是缓存杀手)。
   */
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
  /** 日志保留天数:更早的按天日志文件在写日志时顺手删除;0 = 永不删除。 */
  retainDays: number;
}

/** 巩固层交互命令选项(/recall-rebuild list | now | edit | forget)。 */
export interface CommandsOptions {
  /** 命令总开关;false = 不注册任何命令。 */
  enabled: boolean;
  /** 注册的命令名(不含前导 /);与其它插件冲突时改名。 */
  name: string;
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
  /**
   * 休眠条目的复活阈值:当前召回碎片与它的相似度 ≥ 该值 → 视为「又被提起」,唤醒。
   * 0.15 比 clusterThreshold(0.25)松 —— 复活只需要「话题沾边」,
   * 而巩固聚类要求「同一件事」,两者标准本就不该一样。
   */
  reviveSimilarity: number;
  /**
   * 改口覆盖阈值(字符子序列比例,非 Jaccard):新条目与旧条目「几乎同一句话、
   * 只差一个值」时把旧的标记为 superseded。0.6 刻意高于 clusterThreshold ——
   * 误判覆盖会藏起一条仍然为真的记忆,代价比漏判高。
   */
  supersedeThreshold: number;
  /**
   * 重复观察强化阈值(字符子序列比例)。新观察与已有条目「几乎是同一句话」时,
   * 不新建条目,而是把那条已有记忆的置信度上调。0.85 刻意高于 supersedeThreshold ——
   * 改口只差一个值就算同一件事,强化则要求几乎一字不差,否则「用户住在成都」
   * 会被当成「用户住在杭州」的重复观察,新事实永远进不来。
   */
  reinforceThreshold: number;
}

export interface RecallRebuildConfig {
  /** 总开关。 */
  enabled: boolean;
  /** prime-memory 数据目录;空 = $DSH_HOME/memory(默认)。 */
  dataDir: string;
  /**
   * 记忆来源(插件市场适配层,见 src/sources/registry.ts):
   * - 'auto'(默认):探测本机所有已知记忆插件,命中的源**全部打开**并做 RRF 融合(按正文去重),装了多个也不会互相遮蔽;
   * - 显式指定则只读那一个,读不到会在日志里说清楚原因。
   *
   * 已适配的源 id:
   * - 'prime'           dsh-prime-memory        SQLite $dataDir/memory.db
   * - 'loci'            dsh-loci                SQLite $DSH_HOME/memory/loci/memory.db
   * - 'living'          dsh-living-memory       SQLite $DSH_HOME/dsh-living-memory/memory.sqlite3
   * - 'ltm'             @tr1v3r/dsh-ltm         SQLite memory/ltm.db
   * - 'nebula'          dsh-memory-nebula       SQLite .dsh-meow/memory.db
   * - 'dsh-memory-sqlite' dsh-memory            SQLite memory/memory.db
   * - 'lingshu'         @furongjun1999/dsh-memory  Markdown $DSH_HOME/.dsh-memory/data/mdcg
   * - 'mnemon'          dsh-mnemon              Markdown ~/.mnemon/runtime + documents
   * - 'palace'          dsh-memory-palace       Markdown ~/.deepseek-harness/MEMORY.md
   * - 'jipika'          @jipika/dsh-memory      Markdown $DSH_HOME/memory/topics
   * - 'hub'             dsh-memory-hub          Markdown $DSH_HOME/memory-hub
   * - 'longterm'        dsh-longterm-memory     Markdown Obsidian vault
   * - 'dsh-memory'      @max-null/dsh-memory    JSON $DSH_HOME/storages/memory.json
   * - 'memory-engine'   dsh-memory-engine       JSON $DSH_HOME/memory-engine/memories.json
   * - 'tiers'           dsh-memory-tiers        JSON $DSH_HOME/storages/memory/L1..DL3.json
   * - 'memory-vector'   @restregular/dsh-memory JSONL $DSH_HOME/memory-vector/*.jsonl
   */
  source: string;
  /**
   * 通用记忆源(prime 之外的全部适配器)的重读间隔(ms)。
   *
   * prime 是每次检索实时查库,新记忆立刻可见;其余源把条目读进内存换检索速度,
   * 读一次就定住意味着插件启动后新写入的记忆要重启才召回得到。给个间隔就让它们
   * 在检索路径上按需重读。0 = 关闭(回到「只读一次」的旧行为)。
   */
  sourceRefreshMs: number;
  rebuild: RebuildOptions;
  inject: InjectOptions;
  query: QueryOptions;
  user: UserIsolationOptions;
  observability: ObservabilityOptions;
  consolidate: ConsolidateOptions;
  commands: CommandsOptions;
}

export const recallRebuildSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  dataDir: Schema.string().default(''),
  // 不锁死枚举:新增记忆源适配只改 src/sources/registry.ts,配置面无需同步发版
  source: Schema.string().default('auto'),
  sourceRefreshMs: Schema.number().min(0).max(3_600_000).default(60_000),
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
    retainDays: Schema.number().min(0).max(3650).default(30),
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
    reviveSimilarity: Schema.number().min(0.05).max(0.9).default(0.15),
    supersedeThreshold: Schema.number().min(0.3).max(0.95).default(0.6),
    reinforceThreshold: Schema.number().min(0.5).max(0.99).default(0.85),
  }).default({}),
  commands: Schema.object({
    enabled: Schema.boolean().default(true),
    name: Schema.string().default('recall-rebuild'),
  }).default({}),
}).default({});
