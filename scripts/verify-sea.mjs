/**
 * 记忆识海 web 层验证:纯函数断言 + 真实 HTTP 往返。
 *
 * 不装插件、不开 DSH:直接把 dist/web.js 的 handler 挂到一个裸 http 服务上,
 * 用真实请求验证 fence / 静态资源 / 数据端点三件事。
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distUrl = pathToFileURL(path.join(root, 'dist') + path.sep).href;

let failed = 0;
function check(label, cond, extra = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { failed += 1; console.log(`  FAIL ${label} ${extra}`); }
}

const web = await import(`${distUrl}web.js`);
const { buildSeaGraph, isTrustedWebRequest, resolveUiFile, SEA_ROUTE_PREFIX } = web;

console.log('\n[1] buildSeaGraph');
const mem = (id, createdAt, type = 'stable-fact', status = 'active') => ({
  id, userKey: null, type, content: `记忆 ${id}`, sourceIds: [], confidence: 0.7,
  status, createdAt, updatedAt: createdAt, touchCount: 0,
});
const now = Date.now();
const memories = [mem('a', 1000), mem('b', 2000), mem('c', 3000)];
const links = {
  a: { b: { weight: 2, label: 'co', at: now } },
  b: { a: { weight: 2, label: 'co', at: now }, c: { weight: 1, label: 'co', at: now } },
  c: { b: { weight: 1, label: 'co', at: now } },
};
const g = buildSeaGraph(memories, links, { now, maxNodes: 0 });
check('节点按 createdAt 升序', g.nodes.map((n) => n.id).join('') === 'abc');
check('双向边去重成一条', g.links.length === 2, `got ${g.links.length}`);
check('无向边只出现一次', new Set(g.links.map((l) => [l.source, l.target].sort().join('-'))).size === g.links.length);
check('权重落在 0.15–1', g.links.every((l) => l.weight >= 0.15 && l.weight <= 1));
const trimmed = buildSeaGraph(memories, links, { now, maxNodes: 2 });
check('超限丢最老的', trimmed.nodes.map((n) => n.id).join('') === 'bc');
check('被丢节点的边一并消失', trimmed.links.length === 1, `got ${trimmed.links.length}`);
check('字段名是 source/target', 'source' in g.links[0] && 'target' in g.links[0]);
check('status/confidence 透传', g.nodes[0].status === 'active' && g.nodes[0].confidence === 0.7);

console.log('\n[2] isTrustedWebRequest');
const req = (headers) => ({ headers });
check('回环 Host 放行', isTrustedWebRequest(req({ host: '127.0.0.1:55023' })));
check('localhost 放行', isTrustedWebRequest(req({ host: 'localhost:3000' })));
check('IPv6 回环放行', isTrustedWebRequest(req({ host: '[::1]:3000' })));
check('外网 Host 拒绝', !isTrustedWebRequest(req({ host: 'evil.example.com' })));
check('trustedHosts 里的 authority 放行',
  isTrustedWebRequest(req({ host: 'app.example.com' }), ['https://app.example.com']));
check('cross-site 拒绝', !isTrustedWebRequest(req({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })));
check('同源 Origin 放行',
  isTrustedWebRequest(req({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })));
check('异源 Origin 拒绝',
  !isTrustedWebRequest(req({ host: '127.0.0.1:1', origin: 'http://evil.example.com' })));
check('无 Host 拒绝', !isTrustedWebRequest(req({})));

console.log('\n[3] resolveUiFile');
check('根路径回落到 sea.html', resolveUiFile('').ok && resolveUiFile('').path.endsWith('sea.html'));
check('目录回落到 sea.html', resolveUiFile('sub/').ok === false || resolveUiFile('sub/').path.endsWith('sea.html'));
check('模块文件可达', resolveUiFile('sea-core.js').ok);
check('.. 越界拒绝', !resolveUiFile('../package.json').ok);
check('编码越界拒绝', !resolveUiFile('%2e%2e/package.json').ok);

console.log('\n[4] HTTP 往返');
const store = {
  list: () => memories,
  linkGraph: () => links,
  metaInfo: () => ({ lastRunAt: now, runCount: 3 }),
};
// 直接复用 mountRoutes 的 handler:通过假 wctx 拿到 register 的 handler
let handler;
const fakeCtx = {
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  effect: (fn) => fn(),
};
const rawStore = {
  ok: true,
  label: 'raw-test',
  search: () => [],
  list: () => [
    { id: 'r1', content: '今天在写记忆识海的渲染器', type: 'lingshu', sceneName: 'contextual', family: 'f1', priority: 0, timestampStr: '2026-11-20' },
    { id: 'r2', content: '今天在写记忆识海的渲染循环', type: 'lingshu', sceneName: 'contextual', family: 'f2', priority: 0, timestampStr: '2026-11-21' },
    { id: 'r3', content: '完全不相干的一条:周末去买菜', type: 'lingshu', sceneName: 'contextual', family: 'f3', priority: 0, timestampStr: '2026-11-22' },
  ],
  close: () => {},
};
const stores = () => ({ consolidated: store, memory: rawStore });
web.mountSeaWeb({ inject: (deps, cb) => cb({ ...fakeCtx, webStartup: { trustedHosts: [] } }) }, stores, {
  enabled: true, maxNodes: 0, source: 'consolidated', rawLinkThreshold: 0.12,
  logger: { debug() {}, info() {}, warn() {} },
});
check('mountSeaWeb 注册了 handler', typeof handler === 'function');

const server = http.createServer((rq, rs) => handler(rq, rs));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const get = async (p, headers = {}) => {
  const res = await fetch(base + p, { headers });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text(), csp: res.headers.get('content-security-policy') };
};

const page = await get('/recall-rebuild/sea/');
check('面板首页 200', page.status === 200, `${page.status}`);
check('首页是 HTML', (page.type ?? '').includes('text/html'));
check('首页含 canvas#sea', page.body.includes('id="sea"'));
check('带 CSP', (page.csp ?? '').includes("frame-ancestors 'self'"));
const core = await get('/recall-rebuild/sea/sea-core.js');
check('渲染器模块 200', core.status === 200, `${core.status}`);
check('模块 MIME 正确', (core.type ?? '').includes('javascript'));
const data = await get('/recall-rebuild/sea/data');
const parsed = JSON.parse(data.body);
check('数据端点 200', data.status === 200);
check('数据端点 no-store', data.body.length > 0 && parsed.nodes.length === 3, JSON.stringify(parsed).slice(0, 120));
check('数据含 meta', parsed.meta.runCount === 3);
check('数据不含内部字段', parsed.nodes[0].userKey === undefined && parsed.nodes[0].sourceIds === undefined);
check('默认源是巩固层', parsed.meta.source === 'consolidated', String(parsed.meta.source));
const rawData = await get('/recall-rebuild/sea/data?source=raw');
const rawParsed = JSON.parse(rawData.body);
check('?source=raw 走原始层', rawData.status === 200 && rawParsed.meta.source === 'raw', rawData.status + ' ' + rawParsed.meta?.source);
check('原始层节点数 = 库条目数', rawParsed.nodes.length === 3, String(rawParsed.nodes.length));
check('原始层无自环', rawParsed.links.every((l) => l.source !== l.target));
check('原始层相似条目连了线', rawParsed.links.some(
  (l) => [l.source, l.target].includes('r1') && [l.source, l.target].includes('r2')), JSON.stringify(rawParsed.links));
check('原始层不相干条目不连', !rawParsed.links.some(
  (l) => [l.source, l.target].includes('r3')), JSON.stringify(rawParsed.links));
check('原始层边权落在 0.15–1', rawParsed.links.every((l) => l.weight >= 0.15 && l.weight <= 1));
check('原始层时间转成毫秒', rawParsed.nodes.every((n) => n.createdAt > 1e11), JSON.stringify(rawParsed.nodes.map((n) => n.createdAt)));
const badSource = await get('/recall-rebuild/sea/data?source=nonsense');
check('非法 source 回落到默认源', JSON.parse(badSource.body).meta.source === 'consolidated');

const forbidden = await get('/recall-rebuild/sea/', { 'sec-fetch-site': 'cross-site' });
check('跨站被 fence 挡住', forbidden.status === 403, `${forbidden.status}`);
const missing = await get('/recall-rebuild/sea/nope.js');
check('不存在的资源 404', missing.status === 404);
const outside = await get('/recall-rebuild/sea/../package.json');
check('越界路径 404/403', outside.status === 404 || outside.status === 403, `${outside.status}`);
const outsideRoot = await get('/recall-rebuild/package.json');
check('非 /sea/ 前缀 404', outsideRoot.status === 404, `${outsideRoot.status}`);

server.close();

console.log('\n[5] 客户端 bundle(lib/client.js)');
const { readFileSync } = await import('node:fs');
const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
const fakeReact = { createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }) };
const requireShim = (name) => (name === 'react' ? fakeReact : {});
let entry = null;
const fakeWindow = { __ModuleLoader__: { load: (e) => { entry = e; } } };
new Function('require', 'window', clientSrc)(requireShim, fakeWindow);
check('bundle 通过 __ModuleLoader__ 注册', entry !== null && entry.id === 'dsh-recall-rebuild', String(entry && entry.id));
const clientMod = entry ? entry.factory(requireShim) : {};
check('导出 inject 含 slots', Array.isArray(clientMod.inject) && clientMod.inject.includes('slots'));
let currentSlot = null;
const regs = [];
const slotsCtx = { slots: {
  inject: (slot, cb) => { currentSlot = slot; return cb(); },
  register: (opts, comp) => { regs.push({ slot: currentSlot, opts, comp }); return () => {}; },
} };
clientMod.apply(slotsCtx);
check('注册了 2 个槽位', regs.length === 2, String(regs.length));
const mainReg = regs.find((r) => r.slot === 'main');
const listReg = regs.find((r) => r.slot === 'sidebar.panellist');
check('main 与 panellist 都注册', Boolean(mainReg && listReg));
check('main 用 key、panellist 用 id 且两者相同',
  Boolean(mainReg && listReg && mainReg.opts.key === listReg.opts.id), JSON.stringify([mainReg?.opts.key, listReg?.opts.id]));
check('面板 key 与路由前缀对应', Boolean(mainReg && mainReg.opts.key.startsWith('recall-rebuild')));
const panelEl = mainReg ? mainReg.comp({}) : null;
check('面板是 iframe', Boolean(panelEl && panelEl.type === 'iframe'));
check('iframe 指向识海路由', Boolean(panelEl && panelEl.props.src === SEA_ROUTE_PREFIX + '/sea/'), String(panelEl && panelEl.props.src));
check('iframe 允许同源脚本', Boolean(panelEl && String(panelEl.props.sandbox).includes('allow-same-origin')));
const iconEl = listReg ? listReg.comp({ size: 16 }) : null;
check('侧边栏图标是 svg', Boolean(iconEl && iconEl.type === 'svg'));

// 槽位就绪顺序不确定:先到 panellist、后到 main 也必须最终注册两处,
// 且 main 必须先于 panellist 落注册(否则宿主拒绝选中「缺页面」的行)。
const order = [];
let slotName = null;
const deferred = {};
const orderedCtx = { slots: {
  inject: (slot, cb) => { deferred[slot] = cb; },
  register: (opts, comp) => { order.push(opts.name); return () => {}; },
} };
clientMod.apply(orderedCtx);
slotName = 'sidebar.panellist';
deferred['sidebar.panellist']();
check('panellist 先到时不抢注册', order.length === 0, order.join(','));
slotName = 'main';
deferred.main();
check('main 到达后补齐两个槽位', order.join(',') === 'main,sidebar.panellist', order.join(','));

console.log('\n[6] 包清单');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
check('exports 暴露 ./client', pkg.exports['./client'] === './lib/client.js');
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web');
check('dsh.client.inject 声明 layout/conversation',
  (pkg.dsh?.client?.inject ?? []).some((s) => s.includes('ui-layout')) && (pkg.dsh?.client?.inject ?? []).some((s) => s.includes('ui-conversation')));
check('files 含 lib 与 ui', pkg.files.includes('lib') && pkg.files.includes('ui'));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
