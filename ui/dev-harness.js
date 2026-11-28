/**
 * dev-harness 的装配脚本(外置而非内联:面板 CSP 是 script-src 'self',
 * 内联 <script> 会被拦掉,页面只剩一张空画布)。
 *
 * 查询参数:n=条数(默认 450) view=2d|3d types=all|raw still=1(不跑 rAF)
 */
import { SeaView } from './sea-view.js';
import { SeaView3D } from './sea-view3d.js';

const Q = new URLSearchParams(location.search);
const COUNT = Number(Q.get('n') ?? 450);
const MODE = Q.get('view') === '3d' ? '3d' : '2d';
const RAW = Q.get('types') === 'raw';

const CONSOLIDATED = ['stable-fact', 'pattern', 'preference', 'relationship', 'mood'];
const RAW_TYPES = [
  'lingshu', 'mnemon', 'prime', 'palace', 'dsh-memory', 'ltm',
  'loci', 'living', 'longterm', 'memory-vector', 'hub', 'nebula',
  'memory-engine', 'tiers', 'jipika', 'auto-memory', 'memory',
];
const TYPES = RAW ? RAW_TYPES : CONSOLIDATED;

const nodes = Array.from({ length: COUNT }, (_, i) => ({
  id: 'm' + i,
  type: TYPES[i % TYPES.length],
  content: '记忆条目 #' + i + ' 的内容预览',
  confidence: 0.5 + (i % 50) / 100,
  status: 'active',
  createdAt: 1760000000000 + i * 3600000,
}));
const links = [];
for (let i = 1; i < nodes.length; i += 1) {
  links.push({ source: nodes[i].id, target: nodes[i - 1].id, weight: 0.5 });
}

const canvas = document.getElementById('sea');
const card = document.getElementById('card');
const onHover = (n, x, y) => {
  if (!n) { card.classList.remove('on'); return; }
  card.textContent = n.content ?? n.id;
  card.style.left = (x + 16) + 'px';
  card.style.top = (y + 16) + 'px';
  card.classList.add('on');
};

const view = MODE === '3d' ? new SeaView3D(canvas, { onHover }) : new SeaView(canvas, { onHover });
view.setData(nodes, links);
// 供截图脚本调参 / 触发增量生长
window.__view = view;
window.__nodes = nodes;
window.__links = links;
/** 往画布里再塞 k 条新记忆,用来观察出生生长动画。 */
window.__grow = (k = 12) => {
  const extra = Array.from({ length: k }, (_, i) => ({
    id: 'g' + i + '-' + Math.random().toString(36).slice(2, 6),
    type: TYPES[i % TYPES.length],
    content: '新记忆 #' + i,
    confidence: 0.8,
    status: 'active',
    createdAt: Date.now(),
  }));
  const all = [...nodes, ...extra];
  view.setData(all, links);
  return all.length;
};

if (Q.get('still') === '1') {
  view.resize();
  for (let i = 0; i < 3; i += 1) view._frame();
} else {
  view.start();
}
