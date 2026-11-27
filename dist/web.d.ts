import type { Context } from '@deepseek-ai/cordis';
import type { ConsolidatedMemory, ConsolidatedStore, LinkGraph } from './consolidated.js';
import type { LoggerLike, MemoryRecord, MemoryStore } from './store.js';
/** 路由前缀:页面 /recall-rebuild/sea/,数据 /recall-rebuild/sea/data。 */
export declare const SEA_ROUTE_PREFIX = "/recall-rebuild";
/** 识海节点(渲染器契约,与 ui/sea-app.js 的字段一一对应)。 */
export interface SeaNode {
    id: string;
    /** 'stable-fact' | 'pattern' | 'preference' | 'relationship' | 'mood'。 */
    type: string;
    content: string;
    createdAt: number;
    confidence: number;
    /** 'active' | 'dormant' | 'superseded'。 */
    status: string;
}
/** 识海连线(渲染器契约:字段名是 source/target,不是 a/b)。 */
export interface SeaLink {
    source: string;
    target: string;
    /** 0.15–1 的显示权重(已按 30 天半衰期衰减)。 */
    weight: number;
}
export interface SeaGraph {
    nodes: SeaNode[];
    links: SeaLink[];
}
/**
 * 巩固层 → 渲染器数据(纯函数,verify.mjs 直接断言)。
 *
 * 三条规则:
 * - 节点按 createdAt 升序,超出 maxNodes 时**丢最老的**而不是最新的(识海要能看见最近在想什么);
 * - 联想边去重成无向边(links.json 里 A→B 与 B→A 都存,画两遍就是重叠线);
 * - 边权按 effectiveWeight 衰减后再压到 0.15–1(原始 weight 是强化次数,可能远大于 1)。
 */
export declare function buildSeaGraph(memories: ConsolidatedMemory[], links: LinkGraph, opts: {
    now: number;
    maxNodes: number;
}): SeaGraph;
/**
 * 原始记忆 → 渲染器数据(纯函数,verify-sea.mjs 直接断言)。
 *
 * 与 buildSeaGraph 的区别是**数据从哪来**:那边读巩固层(memories.json + links.json,
 * 已经有聚类与联想边),这边直接读记忆库本身(灵枢 / mnemon / prime 的原始条目)。
 *
 * 三条规则:
 * - 原始层没有现成边(灵枢节点的 edges 目前全是 []),连线只能现算:字符 n-gram
 *   余弦 ≥ linkThreshold 才连,且每个节点只保留最强 topK 条 —— 全连会让画面糊成一团;
 * - 时间戳原始值可能是秒(灵枢 created_at = 1794884879.42),统一走 toEpochMs;
 * - 无时间线索的条目(ts 空串)排最前,不因缺时间被丢。
 */
export declare function buildRawSeaGraph(records: MemoryRecord[], opts: {
    now: number;
    maxNodes: number;
    linkThreshold?: number;
    topK?: number;
}): SeaGraph;
/**
 * 请求是否来自可信浏览器上下文。
 * 与 dsh-mcp-connector/lib/web.js:116 同一套规则(不共享代码:那是别的插件的私有实现)。
 */
export declare function isTrustedWebRequest(request: {
    headers?: Record<string, unknown>;
}, trustedHosts?: readonly string[]): boolean;
/**
 * 把 URL 路径映射到 ui/ 下的真实文件;任何越界(../)一律拒绝。
 * 目录请求回落到 sea.html,所以 /recall-rebuild/sea/ 与 /recall-rebuild/sea 都能开。
 */
export declare function resolveUiFile(rel: string): {
    ok: true;
    path: string;
} | {
    ok: false;
};
export interface SeaWebOptions {
    enabled: boolean;
    maxNodes: number;
    /** 默认数据源:'consolidated'(巩固层) | 'raw'(记忆库原始条目)。 */
    source: 'consolidated' | 'raw';
    /** 原始层连边阈值(字符 n-gram 余弦);越小线越密。 */
    rawLinkThreshold: number;
    /** 首次打开的视图(面板只在用户没手动切过时跟随)。 */
    view?: '2d' | '3d';
    /** 3D 厚度比。 */
    depth?: number;
    /** 3D 闲置自转。 */
    autoRotate?: boolean;
    /** 3D 透视强度。 */
    perspective?: 'soft' | 'strong';
    /** 3D 纵向裂。 */
    fissure?: boolean;
    logger: LoggerLike;
}
/**
 * 挂载识海路由。webServer 是可选依赖:
 * 纯对话部署(无 HTTP 服务)下 ctx.inject 的回调永不触发,插件其余部分照常工作。
 *
 * webStartup / webRuntime 是同一个服务的两代名字(alpha.1 之后改名),两个都注入,
 * 谁先就绪用谁 —— 照抄 dsh-mcp-connector 的 reconcile 做法,避免新旧宿主各挂一遍。
 */
export declare function mountSeaWeb(ctx: Context, getStores: () => {
    consolidated: ConsolidatedStore;
    memory: MemoryStore;
}, opts: SeaWebOptions): void;
