/**
 * 记忆识海 · 页面装配(零依赖)。
 *
 * 只做四件事:取数据 → 交给 SeaView → 悬停卡片 / 搜索 / 时间轴回放。
 * 渲染与几何全在 sea-view.js / sea-core.js,这里不碰像素。
 */
import { SeaView, TYPE_LABEL, TYPE_COLOR } from './sea-view.js';

const canvas = document.getElementById('sea');
const cardEl = document.getElementById('card');
const subEl = document.getElementById('sub');
const legendEl = document.getElementById('legend');
const emptyEl = document.getElementById('empty');
const qEl = document.getElementById('q');
const timeEl = document.getElementById('time');
const timeLabelEl = document.getElementById('timeLabel');
const playEl = document.getElementById('play');
const switchEl = document.getElementById('switch');
const emptyTitleEl = document.getElementById('emptyTitle');
const emptyBodyEl = document.getElementById('emptyBody');

/** 空态文案随数据源变:两路「空」的原因完全不同,不能共用一句话。 */
const EMPTY_TEXT = {
  consolidated: ['还没有巩固记忆', '聊天内容会先成为碎片,<br />夜间巩固后才会在这里点亮。'],
  raw: ['没有读到记忆条目', '没有检测到可读的记忆库。<br />装一个记忆插件(灵枢 / mnemon / prime)后这里会自动点亮。'],
};

// 首屏不指定 source,由服务端默认值决定(配置里改默认,面板自动跟随);
// 用户点了切换按钮之后才显式带上 ?source=。
let source = null;

const view = new SeaView(canvas, {
  onHover: (node, cx, cy) => showCard(node, cx, cy),
  onSelect: (node) => showCard(node, null, null, true),
});

let allNodes = [];
let allLinks = [];
let minT = 0;
let maxT = 0;
let playing = 0;

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
  view.setData(nodes, links);
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
  const [title, body] = EMPTY_TEXT[source] ?? EMPTY_TEXT.consolidated;
  emptyTitleEl.textContent = title;
  emptyBodyEl.innerHTML = body;
  stopPlay();
  timeEl.value = '1000';
  timeLabelEl.textContent = '全部';
  allNodes = (data.nodes ?? []).slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  allLinks = data.links ?? [];
  const times = allNodes.map((n) => n.createdAt ?? 0).filter((t) => t > 0);
  minT = times.length ? Math.min(...times) : 0;
  maxT = times.length ? Math.max(...times) : 0;
  timeEl.disabled = !times.length || maxT === minT;
  applyTime(0);
  view.start();
}

switchEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.dataset.source === source) return;
  source = btn.dataset.source;
  paintSwitch();
  subEl.textContent = '正在读取…';
  view.setQuery('');
  qEl.value = '';
  load();
});

qEl.addEventListener('input', () => view.setQuery(qEl.value));

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

window.addEventListener('resize', () => view.resize());
load();
