/**
 * 插件配置:Schemastery schema + 类型。
 *
 * 默认数据目录:复用 dsh-prime-memory 的 $DSH_HOME/memory(用官方 dshHomePath 解析,
 * DSH_HOME 缺省 ~/.dsh)。键名/默认值/取值范围是部署面契约
 * (cordis.patch.yml 按"整行替换,不深合并"覆盖),不可更名。
 */
import Schema from '@deepseek-ai/schemastery';
export const recallRebuildSchema = Schema.object({
    enabled: Schema.boolean().default(true),
    dataDir: Schema.string().default(''),
    source: Schema.union(['auto', 'prime']).default('auto'),
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
}).default({});
