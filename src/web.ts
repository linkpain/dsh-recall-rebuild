/**
 * 记忆识海 · Web 挂载层(宿主侧)。
 *
 * 三件事:
 * 1. `GET /recall-rebuild/sea/` —— 返回 ui/ 目录下的静态页面(sea.html + 三个零依赖 ES 模块);
 * 2. `GET /recall-rebuild/sea/data` —— 把巩固层(memories.json + links.json)投影成
 *    `{ nodes, links }` 给渲染器(sea-app.js 用 `fetch('./data')` 取,相对路径正好落到这里);
 * 3. 浏览器信任 fence —— 只认本机回环 / 部署声明的可信域,拒绝跨站。
 *
 * 为什么要有 fence:webServer 路由对同一台机器上的**任何**网页都可见。
 * 没有 fence 时,一个恶意页面就能用 <img>/fetch 读走用户的全部长期记忆。
 * 判定规则照抄 dsh-mcp-connector(lib/web.js:116),不自己发明:
 * Host 必须存在且是本机回环或 trustedHosts 里的 authority;sec-fetch-site 不能是 cross-site;
 * 带 Origin 时必须与 Host 同源。
 *
 * 只读:本层不写巩固层,任何请求都改不了数据。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { ConsolidatedMemory, ConsolidatedStore, LinkGraph } from './consolidated.js';
import { effectiveWeight } from './consolidated.js';
import type { LoggerLike } from './store.js';

/** 路由前缀:页面 /recall-rebuild/sea/,数据 /recall-rebuild/sea/data。 */
export const SEA_ROUTE_PREFIX = '/recall-rebuild';

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
export function buildSeaGraph(
  memories: ConsolidatedMemory[],
  links: LinkGraph,
  opts: { now: number; maxNodes: number },
): SeaGraph {
  const sorted = memories.slice().sort((a, b) => a.createdAt - b.createdAt);
  const kept = opts.maxNodes > 0 && sorted.length > opts.maxNodes
    ? sorted.slice(sorted.length - opts.maxNodes)
    : sorted;
  const nodes: SeaNode[] = kept.map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    createdAt: m.createdAt,
    confidence: m.confidence,
    status: m.status,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const out: SeaLink[] = [];
  for (const [a, adj] of Object.entries(links ?? {})) {
    if (!ids.has(a)) continue;
    for (const [b, edge] of Object.entries(adj ?? {})) {
      if (a === b || !ids.has(b) || !edge) continue;
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const w = effectiveWeight(edge, opts.now);
      if (!(w > 0)) continue;
      out.push({ source: a, target: b, weight: Math.max(0.15, Math.min(1, w / 3)) });
    }
  }
  return { nodes, links: out };
}

/* ───────────────────────── 浏览器信任 fence ───────────────────────── */

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

function parseAuthority(raw: string): URL | undefined {
  const text = raw.includes('://') ? raw : `http://${raw}`;
  try {
    const url = new URL(text);
    return url.host ? url : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.endsWith('.localhost');
}

/**
 * 请求是否来自可信浏览器上下文。
 * 与 dsh-mcp-connector/lib/web.js:116 同一套规则(不共享代码:那是别的插件的私有实现)。
 */
export function isTrustedWebRequest(
  request: { headers?: Record<string, unknown> },
  trustedHosts: readonly string[] = [],
): boolean {
  const headers = request.headers ?? {};
  const host = header(headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  const trusted = trustedHosts.some((raw) => parseAuthority(raw)?.host === hostUrl.host);
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false;
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/* ───────────────────────── 静态资源 ───────────────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 面板页 CSP:自身脚本 + 内联样式(sea.html 的 <style>) + 同源 fetch;只允许同源内嵌。 */
const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** ui/ 目录(dist/web.js 的上一级)。 */
function uiDir(): string {
  return fileURLToPath(new URL('../ui/', import.meta.url));
}

/**
 * 把 URL 路径映射到 ui/ 下的真实文件;任何越界(../)一律拒绝。
 * 目录请求回落到 sea.html,所以 /recall-rebuild/sea/ 与 /recall-rebuild/sea 都能开。
 */
export function resolveUiFile(rel: string): { ok: true; path: string } | { ok: false } {
  const clean = decodeURIComponent(rel).replace(/^\/+/, '');
  if (clean.includes('\0')) return { ok: false };
  const root = path.resolve(uiDir());
  const target = path.resolve(root, clean === '' || clean.endsWith('/') ? `${clean}sea.html` : clean);
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false };
  return { ok: true, path: target };
}

/* ───────────────────────── 路由挂载 ───────────────────────── */

export interface SeaWebOptions {
  enabled: boolean;
  maxNodes: number;
  logger: LoggerLike;
}

interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact';
    path: string;
    handler: (req: any, res: any) => void | Promise<void>;
  }): () => void;
}

/**
 * 挂载识海路由。webServer 是可选依赖:
 * 纯对话部署(无 HTTP 服务)下 ctx.inject 的回调永不触发,插件其余部分照常工作。
 *
 * webStartup / webRuntime 是同一个服务的两代名字(alpha.1 之后改名),两个都注入,
 * 谁先就绪用谁 —— 照抄 dsh-mcp-connector 的 reconcile 做法,避免新旧宿主各挂一遍。
 */
export function mountSeaWeb(
  ctx: Context,
  getStore: () => ConsolidatedStore,
  opts: SeaWebOptions,
): void {
  if (!opts.enabled) return;
  const host = ctx as unknown as {
    inject(deps: string[], cb: (child: any) => void): unknown;
  };
  if (typeof host.inject !== 'function') return;

  const candidates = new Map<string, { ctx: any; trustedHosts: string[] }>();
  let active: { ctx: any; trustedHosts: string[] } | undefined;
  let dispose: (() => void) | undefined;

  const reconcile = () => {
    const next = candidates.get('webStartup') ?? candidates.get('webRuntime');
    if (next === active) return;
    dispose?.();
    dispose = undefined;
    active = next;
    if (!next) return;
    try {
      dispose = mountRoutes(next.ctx, getStore, next.trustedHosts, opts);
      opts.logger.info(`[recall-rebuild] 记忆识海已挂载: ${SEA_ROUTE_PREFIX}/sea/`);
    } catch (err) {
      opts.logger.warn(
        `[recall-rebuild] 记忆识海挂载失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  for (const name of ['webStartup', 'webRuntime']) {
    host.inject(['webServer', name], (wctx: any) => {
      wctx.effect(() => {
        const candidate = { ctx: wctx, trustedHosts: (wctx[name]?.trustedHosts ?? []) as string[] };
        candidates.set(name, candidate);
        reconcile();
        return () => {
          if (candidates.get(name) === candidate) candidates.delete(name);
          reconcile();
        };
      });
    });
  }
}

function mountRoutes(
  wctx: any,
  getStore: () => ConsolidatedStore,
  trustedHosts: string[],
  opts: SeaWebOptions,
): () => void {
  const server = wctx.webServer as WebServerLike;
  const fence = (req: any) => isTrustedWebRequest(req, trustedHosts);

  return server.register({
    kind: 'prefix',
    path: SEA_ROUTE_PREFIX,
    handler: async (req: any, res: any) => {
      if (!fence(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rel = url.pathname.replace(new RegExp(`^${SEA_ROUTE_PREFIX}`), '') || '/';

      // 数据端点:/recall-rebuild/sea/data(sea-app.js 的 fetch('./data'))
      if (rel === '/sea/data' || rel === '/data') {
        writeJson(res, req.method === 'HEAD', seaPayload(getStore(), opts));
        return;
      }

      // 静态资源:只允许 /sea/ 下的文件,其它路径一律 404
      if (rel !== '/sea' && !rel.startsWith('/sea/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const inner = rel.slice('/sea'.length).replace(/^\//, '');
      const file = resolveUiFile(inner);
      if (!file.ok) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      try {
        const body = await fs.promises.readFile(file.path);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': PANEL_CSP,
          'content-length': body.length,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
    },
  });
}

/** 组装一次数据响应(读巩固层内存态,不碰磁盘 —— 存储层已 load 过)。 */
function seaPayload(store: ConsolidatedStore, opts: SeaWebOptions): SeaGraph & { meta: { lastRunAt: number; runCount: number } } {
  const meta = store.metaInfo();
  try {
    const graph = buildSeaGraph(store.list(), store.linkGraph(), {
      now: Date.now(),
      maxNodes: opts.maxNodes,
    });
    return { ...graph, meta };
  } catch (err) {
    opts.logger.warn(
      `[recall-rebuild] 识海数据组装失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { nodes: [], links: [], meta };
  }
}

function writeJson(res: any, head: boolean, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}
