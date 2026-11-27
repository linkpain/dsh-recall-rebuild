/**
 * 记忆识海 · Canvas 2D 渲染器(零依赖,浏览器侧)。
 *
 * 性能策略:节点/连线/框架画进一张**离屏静态层**,只在数据或尺寸变化时重绘;
 * 每帧只做「整层轻微位移 + 选中节点脉冲 + 1/4 缩放的 bloom 叠回」,
 * 所以 900 节点也是稳定 60fps。
 */
import {
  BRAIN_OUTLINE, BRAIN_ASPECT, nodeMetrics, placeNode,
} from './sea-core.js';

/** 各类型记忆的点色(刻意压得很淡,整体仍是冷白,只在悬停时略微显色)。 */
const TYPE_COLOR = {
  // 巩固层五类
  'stable-fact': [214, 232, 255],
  pattern: [186, 214, 255],
  preference: [255, 226, 190],
  relationship: [212, 200, 255],
  mood: [186, 240, 226],
  // 原始层:按记忆库来源着色(宿主的 MemoryRecord.type 就是来源族名)
  lingshu: [196, 224, 255],
  mnemon: [206, 214, 255],
  prime: [186, 236, 224],
  palace: [255, 222, 196],
  'dsh-memory': [216, 208, 255],
  memory: [214, 232, 255],
};

const TYPE_LABEL = {
  'stable-fact': '稳定事实',
  pattern: '行为模式',
  preference: '偏好',
  relationship: '关系',
  mood: '情绪',
  lingshu: '灵枢',
  mnemon: 'mnemon',
  prime: 'prime',
  palace: '记忆宫殿',
  'dsh-memory': 'dsh-memory',
  memory: '记忆',
};

/** 生成辉光贴图(只做一次)。 */
function makeGlowSprite(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(244,250,255,1)');
  grad.addColorStop(0.12, 'rgba(226,240,255,0.86)');
  grad.addColorStop(0.3, 'rgba(176,208,246,0.30)');
  grad.addColorStop(0.62, 'rgba(130,175,232,0.07)');
  grad.addColorStop(1, 'rgba(110,160,225,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** 生成静态远星层(只做一次)。 */
function makeStars(count) {
  const out = [];
  let seed = 20261126;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    out.push({ x: rnd(), y: rnd(), r: 0.3 + rnd() * 0.9, a: 0.12 + rnd() * 0.5 });
  }
  return out;
}

export class SeaView {
  /**
   * @param {HTMLCanvasElement} canvas 画布。
   * @param {{ onHover?: (node: object | null, x: number, y: number) => void, onSelect?: (node: object | null) => void }} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ctx = canvas.getContext('2d');
    this.stars = makeStars(420);
    this.glow = makeGlowSprite(96);
    this.nodes = [];
    this.links = [];
    this.metrics = nodeMetrics(0);
    this.hovered = null;
    this.selected = null;
    this.query = '';
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.staticLayer = document.createElement('canvas');
    this.bloomLayer = document.createElement('canvas');
    this.t0 = performance.now();
    this.raf = 0;
    this.dirty = true;
    this.pointer = { x: -1, y: -1 };
    this._onMove = (e) => this._handleMove(e);
    this._onLeave = () => {
      this.pointer = { x: -1, y: -1 };
      this._setHovered(null);
    };
    this._onClick = () => this._handleClick();
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);
    canvas.addEventListener('click', this._onClick);
  }

  /** 载入数据(节点 + 边)。 */
  setData(nodes, links) {
    const metrics = nodeMetrics(nodes.length);
    this.metrics = metrics;
    const placed = nodes.map((n) => {
      const p = placeNode(n.id, metrics.rimRatio);
      return { ...n, u: p.u, v: p.v, z: p.z, x: 0, y: 0, scale: 1 };
    });
    const byId = new Map(placed.map((n) => [n.id, n]));
    const edges = [];
    for (const e of links) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (a && b) edges.push({ a, b, w: Math.max(0.15, Math.min(1, e.weight ?? 0.5)) });
    }
    // 真实联想边不足时,按"最近的 3 个邻居"补边。
    // 不设度数上限的话,密集区会退化成一张乱网 —— 连线的职责是暗示通路,不是铺满画面。
    if (edges.length < placed.length * 0.55) {
      // 连线长度上限:归一化脑宽是 1.0,超过 0.11 的连线会横穿整个脑区,
      // 在稀疏阶段尤其扎眼 —— 通路应该短促、局部,而不是拉满全屏。
      const thr = Math.min(metrics.linkThreshold / 640, 0.11);
      const seen = new Set(edges.map((e) => (e.a.id < e.b.id ? e.a.id + '|' + e.b.id : e.b.id + '|' + e.a.id)));
      const MAX_DEG = 3;
      const deg = new Map();
      for (let i = 0; i < placed.length; i += 1) {
        const cands = [];
        for (let j = 0; j < placed.length; j += 1) {
          if (i === j) continue;
          const du = placed[i].u - placed[j].u;
          const dv = (placed[i].v - placed[j].v) / BRAIN_ASPECT;
          const d = Math.hypot(du, dv);
          if (d < thr) cands.push({ j, d });
        }
        cands.sort((x, y) => x.d - y.d);
        for (const c of cands) {
          const key = i < c.j ? placed[i].id + '|' + placed[c.j].id : placed[c.j].id + '|' + placed[i].id;
          if (seen.has(key)) continue;
          if ((deg.get(i) ?? 0) >= MAX_DEG || (deg.get(c.j) ?? 0) >= MAX_DEG) continue;
          seen.add(key);
          deg.set(i, (deg.get(i) ?? 0) + 1);
          deg.set(c.j, (deg.get(c.j) ?? 0) + 1);
          edges.push({ a: placed[i], b: placed[c.j], w: 1 - c.d / thr });
        }
      }
    }
    this.nodes = placed;
    this.links = edges;
    this.hovered = null;
    this.dirty = true;
    return this;
  }

  /** 搜索高亮(空串 = 清除)。 */
  setQuery(q) {
    this.query = (q ?? '').trim();
    this.dirty = true;
  }

  /** 选中的节点 id。 */
  select(id) {
    this.selected = id ? this.nodes.find((n) => n.id === id) ?? null : null;
    this.dirty = true;
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      this._frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.canvas.removeEventListener('click', this._onClick);
  }

  /** 尺寸变化时重算投影。 */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.staticLayer.width = this.canvas.width;
    this.staticLayer.height = this.canvas.height;
    this.bloomLayer.width = Math.max(1, Math.round(this.canvas.width / 4));
    this.bloomLayer.height = Math.max(1, Math.round(this.canvas.height / 4));
    this.dirty = true;
  }

  /**
   * 脑图在画布里的放置框:等比缩放,**同时**受宽高约束。
   * 之前只按宽度算,宽扁窗口会把脑的上下切掉。
   */
  _fit() {
    const pad = Math.min(this.w, this.h) * 0.07;
    const availW = Math.max(80, this.w - pad * 2);
    const availH = Math.max(80, this.h - pad * 2);
    const bw = Math.min(availW, availH / BRAIN_ASPECT);
    return { pad, bw, ox: (this.w - bw) / 2, oy: (this.h - bw * BRAIN_ASPECT) / 2 };
  }

  /** 归一化坐标 → 屏幕坐标。 */
  _project(u, v, z) {
    const { bw, ox, oy } = this._fit();
    const s = 1 / (1 + z * 0.07);
    const cx = ox + bw / 2;
    const cy = oy + (bw * BRAIN_ASPECT) / 2;
    return {
      x: cx + (ox + u * bw - cx) * s,
      y: cy + (oy + v * bw - cy) * s,
      s,
      alpha: 0.25 + 0.75 * ((z + 1) / 2),
    };
  }

  /** 重绘静态层(节点 + 连线 + 框架)。 */
  _buildStatic() {
    const g = this.staticLayer.getContext('2d');
    const { w, h, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const m = this.metrics;
    const { bw, ox: pad, oy } = this._fit();

    // 框架:零记忆时是唯一可见的东西,随数量淡出
    if (m.frameAlpha > 0.004) {
      g.save();
      g.strokeStyle = `rgba(150,190,235,${m.frameAlpha})`;
      g.lineWidth = 1;
      g.setLineDash([3, 5]);
      g.beginPath();
      BRAIN_OUTLINE.forEach(([u, v], i) => {
        const x = pad + u * bw;
        const y = oy + v * bw;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.stroke();
      g.restore();
    }

    // 连线
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const e of this.links) {
      const pa = this._project(e.a.u, e.a.v, e.a.z);
      const pb = this._project(e.b.u, e.b.v, e.b.z);
      const alpha = (0.05 + 0.10 * e.w) * m.bright * ((pa.alpha + pb.alpha) / 2);
      if (alpha < 0.012) continue;
      g.strokeStyle = `rgba(186,216,255,${alpha.toFixed(3)})`;
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
    }
    g.restore();

    // 节点
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const n of this.nodes) {
      const p = this._project(n.u, n.v, n.z);
      n.x = p.x;
      n.y = p.y;
      n.scale = p.s;
      // 光晕只负责"发光感",真正的形状由下面那颗小而实的核心点给出 ——
      // 只画光晕会糊成一片雾,只画实点又会像散落的沙子。
      const size = Math.max(7, m.size * p.s * (0.34 + 0.26 * p.alpha));
      const alpha = m.bright * p.alpha;
      g.globalAlpha = Math.min(1, alpha * 0.72);
      g.drawImage(this.glow, p.x - size / 2, p.y - size / 2, size, size);
      const rgb = TYPE_COLOR[n.type] ?? [214, 232, 255];
      g.globalAlpha = Math.min(1, alpha);
      g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      g.beginPath();
      g.arc(p.x, p.y, Math.max(1.1, size * 0.11), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    this.dirty = false;
  }

  /** 每帧。 */
  _frame() {
    this.resize();
    if (this.dirty) this._buildStatic();
    const g = this.ctx;
    const { w, h, dpr } = this;
    const t = (performance.now() - this.t0) / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 底色
    const bg = g.createRadialGradient(w / 2, h * 0.48, 0, w / 2, h * 0.48, Math.max(w, h) * 0.78);
    bg.addColorStop(0, '#0a1020');
    bg.addColorStop(1, '#05070d');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // 远星
    g.save();
    for (const s of this.stars) {
      g.globalAlpha = s.a * (0.75 + 0.25 * Math.sin(t * 0.6 + s.x * 30));
      g.fillStyle = '#cfe0ff';
      g.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    g.restore();

    // 静态层 + 极缓慢的呼吸位移
    const dx = Math.sin(t * 0.23) * w * 0.004;
    const dy = Math.cos(t * 0.19) * h * 0.004;
    g.drawImage(this.staticLayer, dx, dy, w, h);

    // 悬停 / 选中的强调
    if (this.selected || this.hovered) this._drawFocus(g, t);

    // bloom:缩到 1/4 再放大叠回,是"好看"的分水岭
    const b = this.bloomLayer.getContext('2d');
    b.clearRect(0, 0, this.bloomLayer.width, this.bloomLayer.height);
    b.drawImage(this.canvas, 0, 0, this.bloomLayer.width, this.bloomLayer.height);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.18;
    g.drawImage(this.bloomLayer, 0, 0, w, h);
    g.restore();

    // 搜索时压暗未命中的点
    if (this.query) this._drawDim(g);
  }

  /** 高亮选中/悬停节点的连线与光晕。 */
  _drawFocus(g, t) {
    const focus = this.hovered ?? this.selected;
    if (!focus) return;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const pulse = 0.55 + 0.45 * Math.sin(t * 3.4);
    for (const e of this.links) {
      if (e.a !== focus && e.b !== focus) continue;
      const other = e.a === focus ? e.b : e.a;
      g.strokeStyle = `rgba(210,236,255,${(0.35 + 0.35 * pulse).toFixed(3)})`;
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(focus.x, focus.y);
      g.lineTo(other.x, other.y);
      g.stroke();
    }
    const size = Math.max(26, this.metrics.size * focus.scale * 1.5);
    g.globalAlpha = 0.85;
    g.drawImage(this.glow, focus.x - size / 2, focus.y - size / 2, size, size);
    g.globalAlpha = 0.9;
    g.strokeStyle = `rgba(226,242,255,${(0.5 + 0.4 * pulse).toFixed(3)})`;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(focus.x, focus.y, 8 + 3 * pulse, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  /** 搜索:压暗不匹配的节点。 */
  _drawDim(g) {
    const q = this.query.toLowerCase();
    g.save();
    g.fillStyle = 'rgba(5,7,13,0.62)';
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
    for (const n of this.nodes) {
      if (!String(n.content ?? '').toLowerCase().includes(q)) continue;
      const size = Math.max(20, this.metrics.size * n.scale * 1.15);
      g.globalAlpha = 0.95;
      g.drawImage(this.glow, n.x - size / 2, n.y - size / 2, size, size);
    }
    g.restore();
  }

  _hit(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      const r = Math.max(12, this.metrics.size * n.scale * 0.34);
      if (d < r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  _handleMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.pointer = { x, y };
    const hit = this._hit(x, y);
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    this._setHovered(hit, e.clientX, e.clientY);
  }

  _handleClick() {
    const { x, y } = this.pointer;
    const hit = this._hit(x, y);
    this.selected = hit;
    this.dirty = true;
    this.opts.onSelect?.(hit);
  }

  _setHovered(node, cx, cy) {
    if (this.hovered === node) {
      if (node) this.opts.onHover?.(node, cx, cy);
      return;
    }
    this.hovered = node;
    this.opts.onHover?.(node, cx, cy);
  }
}

export { TYPE_LABEL, TYPE_COLOR };