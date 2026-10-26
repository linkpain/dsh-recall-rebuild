import type { Context } from '@deepseek-ai/cordis';
import { type RecallRebuildConfig } from './config.js';
export declare const name = "recall-rebuild";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<import("@deepseek-ai/schemastery").Schemastery.ObjectS<NoInfer<{
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
export declare function apply(ctx: Context, config: RecallRebuildConfig): Promise<void>;
