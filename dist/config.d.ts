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
export interface RecallRebuildConfig {
    /** 总开关。 */
    enabled: boolean;
    /** 记忆库目录;空 = $DSH_HOME/memory(默认)。 */
    dataDir: string;
    /** 记忆来源:auto(自动探测,当前等价 prime)| prime(只读 dsh-prime-memory 库)。 */
    source: 'auto' | 'prime';
    rebuild: RebuildOptions;
    inject: InjectOptions;
    query: QueryOptions;
}
export declare const recallRebuildSchema: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
    enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    dataDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    source: import("@deepseek-ai/schemastery").default<"auto" | "prime", "auto" | "prime", "defined">;
    rebuild: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    inject: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
    query: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
}>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
    enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    dataDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    source: import("@deepseek-ai/schemastery").default<"auto" | "prime", "auto" | "prime", "defined">;
    rebuild: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    inject: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
    query: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, import("@deepseek-ai/schemastery").Schemastery.ObjectT<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
}>>, "defined">;
