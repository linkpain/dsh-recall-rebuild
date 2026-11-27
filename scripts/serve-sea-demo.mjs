/**
 * 识海联调服务器:把 dist/web.js 的路由挂到裸 http 上,数据用合成样本。
 * 仅开发用,不随包发布(npm files 不含 scripts/)。
 *
 * 用法:node scripts/serve-sea-demo.mjs [端口] [节点数]
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distUrl = pathToFileURL(path.join(root, 'dist') + path.sep).href;
const { mountSeaWeb } = await import(`${distUrl}web.js`);

const port = Number(process.argv[2] ?? 8791);
const total = Number(process.argv[3] ?? 420);

/** 确定性伪随机(联调要看同一张图,不要每次都不一样)。 */
let seed = 20261126;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const TYPES = ['stable-fact', 'pattern', 'preference', 'relationship', 'mood'];
const TOPICS = [
  '用户偏好冰美式不加糖', '用户在做 DeepSeek Harness 插件', '用户养了一只叫煤球的猫',
  '用户住在杭州', '用户每周三晚上练吉他', '用户不喜欢被追问进度',
  '用户和同事小周一起做记忆插件', '用户对咖啡因敏感', '用户最近在焦虑发布节奏',
  '用户用 Windows 开发', '用户的显示器是 27 寸 4K', '用户习惯深夜写代码',
];
const now = Date.now();
const DAY = 86400000;

const memories = [];
for (let i = 0; i < total; i++) {
  const t = TOPICS[i % TOPICS.length];
  memories.push({
    id: `m${String(i).padStart(4, '0')}`,
    userKey: null,
    type: TYPES[Math.floor(rnd() * TYPES.length)],
    content: `${t}(第 ${i + 1} 次观察)`,
    sourceIds: [],
    confidence: 0.35 + rnd() * 0.6,
    status: rnd() < 0.12 ? 'dormant' : rnd() < 0.05 ? 'superseded' : 'active',
    createdAt: now - Math.floor((1 - i / total) * 300) * DAY,
    updatedAt: now,
    touchCount: Math.floor(rnd() * 5),
  });
}

/**
 * 联想图:同主题的相邻几次观察互相连边(模拟同轮巩固的簇内两两连边)。
 * 主题按 i % TOPICS.length 轮转,所以「同主题」= 下标相差 TOPICS.length 的整数倍。
 */
const links = {};
for (let i = 0; i < memories.length; i++) {
  const a = memories[i];
  for (let k = 1; k <= 2; k++) {
    const b = memories[i + TOPICS.length * k];
    if (!b) continue;
    const w = 1 + Math.floor(rnd() * 2);
    (links[a.id] ??= {})[b.id] = { weight: w, label: 'co', at: now };
    (links[b.id] ??= {})[a.id] = { weight: w, label: 'co', at: now };
  }
}

const store = {
  list: () => memories,
  linkGraph: () => links,
  metaInfo: () => ({ lastRunAt: now, runCount: 12 }),
};

let handler;
mountSeaWeb(
  { inject: (deps, cb) => cb({ webServer: { register: (r) => { handler = r.handler; return () => {}; } }, webStartup: { trustedHosts: [] }, effect: (fn) => fn() }) },
  () => store,
  { enabled: true, maxNodes: 2000, logger: { debug() {}, info: console.log, warn: console.warn } },
);

http.createServer((rq, rs) => handler(rq, rs)).listen(port, '127.0.0.1', () => {
  console.log(`识海联调:http://127.0.0.1:${port}/recall-rebuild/sea/  (${total} 条)`);
});
