/**
 * 记忆识海 · 页面装配(零依赖)。
 *
 * 只做五件事:取数据 → 交给渲染器 → 悬停卡片 / 搜索 / 时间轴回放 → 2D/3D 切换。
 * 渲染与几何全在 sea-view.js / sea-view3d.js / sea-core.js,这里不碰像素。
 */
import { SeaView, TYPE_LABEL, TYPE_COLOR } from './sea-view.js';
import { SeaView3D, MORPH_MS } from './sea-view3d.js';

const canvas2d = document.getElementById('sea');
const canvas3d = document.getElementById('sea3d');
const cardEl = document.getElementById('card');
const subEl = document.getElementById('sub');
const legendEl = document.getElementById('legend');
const emptyEl = document.getElementById('empty');
const qEl = document.getElementById('q');
const timeEl = document.getElementById('time');
const timeLabelEl = document.getElementById('timeLabel');
const playEl = document.getElementById('play');
const switchEl = document.getElementById('switch');
const modeEl = document.getElementById('mode');
const resetEl = document.getElementById('resetView');
const optToggleEl = document.getElementById('optToggle');
const optsEl = document.getElementById('opts');
const emptyTitleEl = document.getElementById('emptyTitle');
const emptyBodyEl = document.getElementById('emptyBody');

/** 空态文案随数据源变:两路「空」的原因完全不同,不能共用一句话。 */
const EMPTY_TEXT = {
  consolidated: ['还没有巩固记忆', '聊天内容会先成为碎片,<br />夜间巩固后才会在这里点亮。'],
  raw: ['没有读到记忆条目', '没有检测到可读的记忆库。<br />装一个记忆插件(灵枢 / mnemon / prime)后这里会自动点亮。'],
};

const MODE_KEY = 'sea.mode';
const CAM_KEY = 'sea.cam3d';
/** 3D 造型参数和相机分开存:相机是「从哪看」,这三项是「长什么样」。 */
const OPT_KEY = 'sea.opts3d';
const FADE_MS = 240;
/** 透视强度在实现上就是视距:远 = 温和(近似正交),近 = 强烈。 */
const PERSP_DIST = { soft: 5.0, strong: 1.8 };
const OPT_DEFAULT = { depth: 0.6, autoRotate: false, perspective: 'soft' };

// 首屏不指定 source,由服务端默认值决定(配置里改默认,面板自动跟随);
// 用户点了切换按钮之后才显式带上 ?source=。
let source = null;

/* ───────────────────────── 渲染器 ───────────────────────── */

let mode = '2d';
let selectedId = null;
let opts = { ...OPT_DEFAULT };
/** 用户手动改过参数(存过 / URL 指定过)→ 配置里的默认值不再覆盖。 */
let optsTouched = false;
let optsOpen = false;
let morphRaf = 0;
let fadeTimer = 0;

const view2d = new SeaView(canvas2d, {
  onHover: (node, cx, cy) => showCard(node, cx, cy),
  onSelect: onSelectNode,
});

const view3d = new SeaView3D(canvas3d, {
  onHover: (node, cx, cy) => showCard(node, cx, cy),
  onSelect: onSelectNode,
  onCamera: saveCamera,
});

// 拖动结束后不会走 onCamera(只有自转/滚轮会),这里补一次落盘
canvas3d.addEventListener('pointerup', () => saveCamera(view3d.cameraState()));
canvas3d.addEventListener('pointercancel', () => saveCamera(view3d.cameraState()));

function currentView() {
  return mode === '3d' ? view3d : view2d;
}

function otherView() {
  return mode === '3d' ? view2d : view3d;
}

function onSelectNode(node) {
  selectedId = node ? node.id : null;
  showCard(node, null, null, !!node);
  // 另一个渲染器同步选中态,切过去时不会丢
  otherView().select(selectedId);
}

/* ───────────────────────── 2D / 3D 切换 ───────────────────────── */

function storedMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === '2d' || v === '3d' ? v : null;
  } catch {
    return null;
  }
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额满:记忆失效不影响功能 */
  }
}

function saveCamera(cam) {
  if (!cam) return;
  writeJSON(CAM_KEY, { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist });
  // 渲染器会因为「用户一拖动」自行关掉自转;以它为准,否则刷新后开关和画面不一致。
  if (view3d.autoRotate !== opts.autoRotate) {
    opts.autoRotate = view3d.autoRotate;
    writeJSON(OPT_KEY, opts);
    paintOpts();
  }
}

function paintMode() {
  document.body.classList.toggle('mode-3d', mode === '3d');
  for (const btn of modeEl.querySelectorAll('button[data-view]')) {
    btn.classList.toggle('on', btn.dataset.view === mode);
  }
  paintOpts();
}

/* ───────────────────────── 3D 造型参数 ───────────────────────── */

function clampDepth(d) {
  return Math.max(0.3, Math.min(0.9, d));
}

function storedOpts() {
  const v = readJSON(OPT_KEY);
  if (!v || typeof v !== 'object') return null;
  const out = {};
  if (Number.isFinite(v.depth)) out.depth = clampDepth(v.depth);
  if (typeof v.autoRotate === 'boolean') out.autoRotate = v.autoRotate;
  if (v.perspective === 'soft' || v.perspective === 'strong') out.perspective = v.perspective;
  return Object.keys(out).length ? out : null;
}

function paintOpts() {
  const visible = optsOpen && mode === '3d';
  optsEl.classList.toggle('on', visible);
  optToggleEl.classList.toggle('on', visible);
  for (const btn of optsEl.querySelectorAll('button[data-val]')) {
    const group = btn.closest('.seg')?.dataset.opt;
    let on = false;
    if (group === 'depth') on = Math.abs(Number(btn.dataset.val) - opts.depth) < 0.001;
    else if (group === 'rotate') on = (btn.dataset.val === 'on') === opts.autoRotate;
    else if (group === 'persp') on = btn.dataset.val === opts.perspective;
    btn.classList.toggle('on', on);
  }
}

/**
 * 把参数落到渲染器上。
 * zoom 默认不动视距:用户可能自己滚轮调过,改厚度不该把视角拉回默认。
 */
function applyOpts({ persist = true, zoom = false } = {}) {
  view3d.setDepth(opts.depth);
  view3d.setAutoRotate(opts.autoRotate);
  if (zoom) view3d.setZoom(PERSP_DIST[opts.perspective] ?? PERSP_DIST.soft);
  paintOpts();
  if (persist) {
    writeJSON(OPT_KEY, opts);
    optsTouched = true;
  }
}

/** morph 补间:0 = 完全 2D 投影,1 = 完全 3D。 */
function tweenMorph(from, to, ms, done) {
  if (morphRaf) cancelAnimationFrame(morphRaf);
  const start = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; // easeInOutQuad
    view3d.setMorph(from + (to - from) * e);
    if (t < 1) morphRaf = requestAnimationFrame(step);
    else {
      morphRaf = 0;
      done?.();
    }
  };
  morphRaf = requestAnimationFrame(step);
}

function fade3d(opacity, ms, done) {
  if (fadeTimer) clearTimeout(fadeTimer);
  canvas3d.style.transition = `opacity ${ms}ms ease`;
  canvas3d.style.opacity = String(opacity);
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0;
    done?.();
  }, ms + 30);
}

/** 把当前模式对应的渲染器拉起来、另一个收掉。 */
function activateView() {
  if (mode === '3d') {
    canvas3d.hidden = false;
    canvas3d.style.transition = 'none';
    canvas3d.style.opacity = '0';
    view3d.resize();
    syncData(view3d);
    view3d.setQuery(qEl.value);
    view3d.select(selectedId);
    view3d.setMorph(0);
    view3d.start();
    void canvas3d.offsetWidth; // 让 opacity:0 先落地,否则过渡不生效
    fade3d(1, FADE_MS);
    tweenMorph(0, 1, MORPH_MS, () => view2d.stop());
    return;
  }
  view2d.resize();
  syncData(view2d);
  view2d.setQuery(qEl.value);
  view2d.select(selectedId);
  view2d.start();
  if (!canvas3d.hidden) {
    tweenMorph(view3d.morph, 0, Math.min(MORPH_MS, 220));
    fade3d(0, FADE_MS, () => {
      canvas3d.hidden = true;
      view3d.stop();
    });
  }
}

function setMode(next, { persist = true } = {}) {
  if (next !== '2d' && next !== '3d') return;
  if (next === mode) {
    paintMode();
    return;
  }
  mode = next;
  if (persist) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* 忽略 */
    }
  }
  paintMode();
  activateView();
}

modeEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-view]');
  if (!btn) return;
  setMode(btn.dataset.view);
});

resetEl.addEventListener('click', () => {
  view3d.resetCamera();
  saveCamera(view3d.cameraState());
});

optToggleEl.addEventListener('click', () => {
  optsOpen = !optsOpen;
  paintOpts();
});

optsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-val]');
  if (!btn) return;
  const group = btn.closest('.seg')?.dataset.opt;
  const val = btn.dataset.val;
  if (group === 'depth') opts.depth = clampDepth(Number(val));
  else if (group === 'rotate') opts.autoRotate = val === 'on';
  else if (group === 'persp') {
    opts.perspective = val === 'strong' ? 'strong' : 'soft';
    view3d.setZoom(PERSP_DIST[opts.perspective]);
  } else return;
  applyOpts();
});

/* ───────────────────────── 数据 ───────────────────────── */

let allNodes = [];
let allLinks = [];
let lastNodes = [];
let lastLinks = [];
let dataVersion = 0;
const seenVersion = { '2d': -1, '3d': -1 };
let lastKey = null;
let minT = 0;
let maxT = 0;
let playing = 0;

/** 只在数据真的变了才把几何算进某个渲染器(3D 建点很贵,回放时别每帧重算)。 */
function syncData(view) {
  const key = view === view3d ? '3d' : '2d';
  if (seenVersion[key] === dataVersion) return;
  view.setData(lastNodes, lastLinks);
  seenVersion[key] = dataVersion;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showCard(node, cx, cy, pinned = false) {
  if (!node) {
    if (!pinned) cardEl.classList.remove('on');
    return;
  }
  const degree = allLinks.filter((l) => l.source === node.id || l.target === node.id).length;
  const statusText = node.status === 'dormant' ? '休眠' : node.status === 'superseded' ? '已被取代' : '活跃';
  cardEl.innerHTML =
    `<div>${escapeHtml(node.content ?? '')}</div>` +
    `<div class="meta">` +
    `<span class="type">${TYPE_LABEL[node.type] ?? node.type ?? '记忆'}</span>` +
    `<span>${statusText}</span>` +
    `<span>置信 ${Math.round((node.confidence ?? 0) * 100)}%</span>` +
    `<span>${degree} 条联想</span>` +
    `<span>${fmtDate(node.createdAt)}</span>` +
    `</div>`;
  cardEl.classList.add('on');
  if (cx != null && cy != null) {
    const pad = 16;
    const rect = cardEl.getBoundingClientRect();
    let x = cx + pad;
    let y = cy + pad;
    if (x + rect.width > window.innerWidth - 12) x = cx - rect.width - pad;
    if (y + rect.height > window.innerHeight - 12) y = cy - rect.height - pad;
    cardEl.style.left = `${Math.max(8, x)}px`;
    cardEl.style.top = `${Math.max(8, y)}px`;
  } else {
    cardEl.style.left = '24px';
    cardEl.style.top = '70px';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLegend(nodes) {
  const counts = new Map();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  legendEl.innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, c]) => {
      const rgb = TYPE_COLOR[type] ?? [214, 232, 255];
      return `<span><i style="background:rgb(${rgb.join(',')})"></i>${TYPE_LABEL[type] ?? type} ${c}</span>`;
    })
    .join('');
}

function applyTime(cutoff) {
  const nodes = allNodes.filter((n) => !cutoff || (n.createdAt ?? 0) <= cutoff);
  const keep = new Set(nodes.map((n) => n.id));
  const links = allLinks.filter((l) => keep.has(l.source) && keep.has(l.target));
  // 回放时每帧都会进来,但节点集合只在跨过某条记忆的 createdAt 时才变;
  // 用「条数 + 末位 id」判断是否真的变了(节点已按时间排序)。
  const key = `${nodes.length}|${nodes.length ? nodes[nodes.length - 1].id : ''}`;
  if (key !== lastKey) {
    lastKey = key;
    lastNodes = nodes;
    lastLinks = links;
    dataVersion += 1;
    syncData(currentView());
  }
  renderLegend(nodes);
  subEl.textContent = cutoff
    ? `${nodes.length} 条记忆 · 截至 ${fmtDate(cutoff)}`
    : `${nodes.length} 条记忆 · ${allLinks.length} 条联想`;
  emptyEl.hidden = nodes.length > 0;
}

function paintSwitch() {
  for (const btn of switchEl.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.source === source);
  }
}

async function load() {
  let data;
  try {
    const url = source === null ? './data' : `./data?source=${encodeURIComponent(source)}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    subEl.textContent = `读取失败:${err instanceof Error ? err.message : String(err)}`;
    emptyEl.hidden = false;
    return;
  }
  // 服务端可能回落到默认源(非法参数),以响应里的 meta.source 为准
  if (data.meta?.source) source = data.meta.source;
  paintSwitch();
  // 配置里的默认值只在用户没手动动过时生效:切过视图 / 转过相机 / URL 指定过,都以用户为准。
  const m = data.meta ?? {};
  const qsp = new URLSearchParams(location.search);
  if (!storedMode() && !qsp.get('view') && (m.view === '2d' || m.view === '3d')) {
    setMode(m.view, { persist: false });
  }
  if (typeof m.fissure === 'boolean') view3d.setFissure(m.fissure);
  if (!optsTouched) {
    if (Number.isFinite(m.depth)) opts.depth = clampDepth(m.depth);
    if (typeof m.autoRotate === 'boolean') opts.autoRotate = m.autoRotate;
    if (m.perspective === 'soft' || m.perspective === 'strong') opts.perspective = m.perspective;
    applyOpts({ persist: false, zoom: !camTouched });
  } else {
    paintOpts();
  }
  const [title, body] = EMPTY_TEXT[source] ?? EMPTY_TEXT.consolidated;
  emptyTitleEl.textContent = title;
  emptyBodyEl.innerHTML = body;
  stopPlay();
  timeEl.value = '1000';
  timeLabelEl.textContent = '全部';
  allNodes = (data.nodes ?? []).slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  allLinks = data.links ?? [];
  lastKey = null;
  selectedId = null;
  view2d.select(null);
  view3d.select(null);
  const times = allNodes.map((n) => n.createdAt ?? 0).filter((t) => t > 0);
  minT = times.length ? Math.min(...times) : 0;
  maxT = times.length ? Math.max(...times) : 0;
  timeEl.disabled = !times.length || maxT === minT;
  applyTime(0);
  currentView().start();
}

switchEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.dataset.source === source) return;
  source = btn.dataset.source;
  paintSwitch();
  subEl.textContent = '正在读取…';
  view2d.setQuery('');
  view3d.setQuery('');
  qEl.value = '';
  load();
});

qEl.addEventListener('input', () => {
  view2d.setQuery(qEl.value);
  view3d.setQuery(qEl.value);
});

timeEl.addEventListener('input', () => {
  stopPlay();
  const ratio = Number(timeEl.value) / 1000;
  if (ratio >= 0.999) {
    timeLabelEl.textContent = '全部';
    applyTime(0);
    return;
  }
  const cutoff = minT + (maxT - minT) * ratio;
  timeLabelEl.textContent = fmtDate(cutoff);
  applyTime(cutoff);
});

function stopPlay() {
  if (playing) cancelAnimationFrame(playing);
  playing = 0;
  playEl.textContent = '▶ 回放';
}

playEl.addEventListener('click', () => {
  if (playing) {
    stopPlay();
    return;
  }
  if (maxT === minT) return;
  playEl.textContent = '⏸ 暂停';
  const start = performance.now();
  const duration = 9000;
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / duration);
    timeEl.value = String(Math.round(t * 1000));
    const cutoff = minT + (maxT - minT) * t;
    timeLabelEl.textContent = t >= 1 ? '全部' : fmtDate(cutoff);
    applyTime(t >= 1 ? 0 : cutoff);
    if (t < 1) playing = requestAnimationFrame(step);
    else stopPlay();
  };
  playing = requestAnimationFrame(step);
});

window.addEventListener('resize', () => {
  view2d.resize();
  view3d.resize();
});

/* ───────────────────────── 启动 ───────────────────────── */

const qs = new URLSearchParams(location.search);
const qView = qs.get('view');
const qDepth = Number(qs.get('depth'));
const qDist = Number(qs.get('dist'));
const qYaw = Number(qs.get('yaw'));
const qPitch = Number(qs.get('pitch'));

const cam = readJSON(CAM_KEY);
// 用户自己调过相机(存过角度,或 URL 指定过参数)→ 配置里的相机默认值不再覆盖
const camTouched = !!cam || ['yaw', 'pitch', 'dist'].some((k) => qs.has(k));
if (cam && Number.isFinite(cam.yaw) && Number.isFinite(cam.pitch)) view3d.setCamera(cam.yaw, cam.pitch);
if (cam && Number.isFinite(cam.dist)) view3d.setZoom(cam.dist);
// URL 里的角度用「度」写(yaw=-28&pitch=14),和人说话一致;内部是弧度。
const DEG = Math.PI / 180;
if (qs.has('yaw') && Number.isFinite(qYaw)) {
  view3d.setCamera(qYaw * DEG, (qs.has('pitch') && Number.isFinite(qPitch) ? qPitch : view3d.pitch / DEG) * DEG);
}
if (Number.isFinite(qDist) && qs.has('dist')) view3d.setZoom(qDist);
// 造型参数:存的 < URL 显式指定的;两者都没有时,交给 load() 里的配置默认值。
const savedOpts = storedOpts();
if (savedOpts) {
  Object.assign(opts, savedOpts);
  optsTouched = true;
}
if (Number.isFinite(qDepth) && qs.has('depth')) {
  opts.depth = clampDepth(qDepth);
  optsTouched = true;
}
const qRotate = qs.get('rotate');
if (qRotate === 'on' || qRotate === 'off') {
  opts.autoRotate = qRotate === 'on';
  optsTouched = true;
}
const qPersp = qs.get('persp');
if (qPersp === 'soft' || qPersp === 'strong') {
  opts.perspective = qPersp;
  optsTouched = true;
}
applyOpts({ persist: false, zoom: optsTouched && !camTouched });

setMode(qView === '2d' || qView === '3d' ? qView : storedMode() ?? '2d', { persist: false });
if (mode === '3d') {
  // 首屏直接进 3D:不走淡入,免得闪一下
  canvas3d.hidden = false;
  canvas3d.style.opacity = '1';
  view3d.setMorph(1);
  view3d.start();
  view2d.stop();
}
paintMode();
load();
