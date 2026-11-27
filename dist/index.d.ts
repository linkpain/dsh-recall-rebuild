import type { Context } from '@deepseek-ai/cordis';
import { type RecallRebuildConfig } from './config.js';
export { DIFFUSE_OPTS } from './recall.js';
export declare const name = "recall-rebuild";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    dataDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    source: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    sourceRefreshMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    rebuild: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    inject: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
    query: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    user: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        isolation: import("@deepseek-ai/schemastery").default<"off" | "auto" | "strict", "off" | "auto" | "strict", "defined">;
        isolationDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        sourceTagPattern: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        isolation: import("@deepseek-ai/schemastery").default<"off" | "auto" | "strict", "off" | "auto" | "strict", "defined">;
        isolationDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        sourceTagPattern: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "defined">;
    observability: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        logEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        logDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        includeFragments: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        statsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        retainDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        logEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        logDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        includeFragments: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        statsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        retainDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    consolidate: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        minFragments: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        checkIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxFragmentsPerRun: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        clusterThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxCluster: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        confidenceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        dormantDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reviveSimilarity: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        supersedeThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reinforceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        minFragments: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        checkIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxFragmentsPerRun: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        clusterThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxCluster: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        confidenceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        dormantDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reviveSimilarity: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        supersedeThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reinforceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    commands: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        name: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        name: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "defined">;
    sea: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxNodes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        source: import("@deepseek-ai/schemastery").default<"consolidated" | "raw", "consolidated" | "raw", "defined">;
        rawLinkThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        view: import("@deepseek-ai/schemastery").default<"2d" | "3d", "2d" | "3d", "defined">;
        depth: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        autoRotate: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        perspective: import("@deepseek-ai/schemastery").default<"soft" | "strong", "soft" | "strong", "defined">;
        fissure: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxNodes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        source: import("@deepseek-ai/schemastery").default<"consolidated" | "raw", "consolidated" | "raw", "defined">;
        rawLinkThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        view: import("@deepseek-ai/schemastery").default<"2d" | "3d", "2d" | "3d", "defined">;
        depth: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        autoRotate: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        perspective: import("@deepseek-ai/schemastery").default<"soft" | "strong", "soft" | "strong", "defined">;
        fissure: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    dataDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    source: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    sourceRefreshMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    rebuild: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxResults: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxMemoryChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTotalChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    inject: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        strategy: import("@deepseek-ai/schemastery").default<"replace" | "append", "replace" | "append", "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        includeSources: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
    query: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        tailMessages: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    user: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        isolation: import("@deepseek-ai/schemastery").default<"off" | "auto" | "strict", "off" | "auto" | "strict", "defined">;
        isolationDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        sourceTagPattern: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        isolation: import("@deepseek-ai/schemastery").default<"off" | "auto" | "strict", "off" | "auto" | "strict", "defined">;
        isolationDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        sourceTagPattern: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "defined">;
    observability: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        logEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        logDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        includeFragments: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        statsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        retainDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        logEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        logDir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        includeFragments: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        statsEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        retainDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    consolidate: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        minFragments: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        checkIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxFragmentsPerRun: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        clusterThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxCluster: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        confidenceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        dormantDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reviveSimilarity: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        supersedeThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reinforceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        minFragments: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        checkIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxFragmentsPerRun: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        clusterThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxCluster: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxOutputChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        temperature: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        maxTokens: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        timeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        confidenceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        dormantDays: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reviveSimilarity: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        supersedeThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        reinforceThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
    }>>, "defined">;
    commands: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        name: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        name: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "defined">;
    sea: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxNodes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        source: import("@deepseek-ai/schemastery").default<"consolidated" | "raw", "consolidated" | "raw", "defined">;
        rawLinkThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        view: import("@deepseek-ai/schemastery").default<"2d" | "3d", "2d" | "3d", "defined">;
        depth: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        autoRotate: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        perspective: import("@deepseek-ai/schemastery").default<"soft" | "strong", "soft" | "strong", "defined">;
        fissure: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        maxNodes: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        source: import("@deepseek-ai/schemastery").default<"consolidated" | "raw", "consolidated" | "raw", "defined">;
        rawLinkThreshold: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        view: import("@deepseek-ai/schemastery").default<"2d" | "3d", "2d" | "3d", "defined">;
        depth: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        autoRotate: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        perspective: import("@deepseek-ai/schemastery").default<"soft" | "strong", "soft" | "strong", "defined">;
        fissure: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
    }>>, "defined">;
}>>, "defined">;
export declare function apply(ctx: Context, config: RecallRebuildConfig): Promise<void>;
