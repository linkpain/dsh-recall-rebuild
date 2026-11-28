/**
 * 记忆识海 · 3D 渲染器(零依赖,浏览器侧)。
 *
 * 与 sea-view.js(2D)并存,互不干扰:
 * - 2D 模式由 SeaView 画,本文件一行不改它;
 * - 3D 模式由 SeaView3D 画,多一个轨道相机与体积几何。
 *
 * 两个渲染器共享**同一份 (u, v)**:同一 id 在两种模式下横向位置完全一致,
 * 只有 z 不同(2D 压在中面描边,3D 铺满椭球体积)。所以切换时把 morph 从 0 推到 1,
 * 点只会沿深度方向「鼓起来」,不会横向乱跳 —— 这就是切换动画的全部原理。
 *
 * 性能策略与 2D 一致:节点/连线/星场烘焙进离屏静态层,只在数据/尺寸/**相机**变化时重建;
 * 相机静止时每帧只做一次贴图 + bloom,CPU 接近 0。
 */
import {
  BRAIN_ASPECT, BRAIN_DEPTH, BRAIN_OUTLINE, FISSURE,
  brainRadius, clampPitch, nodeMetrics, orbitPoint, perspective, placeNode, placeNode3D, wrapYaw,
} from './sea-core.js';
import { TYPE_COLOR, growEase, strokeDendrites } from './sea-view.js';

/** 拖动灵敏度(弧度/像素):拖满一屏宽约转 360°。 */
const DRAG_SENS = 0.005;
/** 惯性衰减(每帧)。0.92 → 松手后约 1 秒停住。 */
const INERTIA = 0.92;
/** 惯性停止阈值(弧度/帧)。 */
const INERTIA_MIN = 0.0008;
/** 滚轮缩放倍率(每格)。 */
const ZOOM_STEP = 1.12;
/** 相机距离范围。1.2 太近会穿模,8.0 太远成一个小点。 */
const DIST_MIN = 1.2;
const DIST_MAX = 8.0;
/** 默认距离:5.0 是「温和」透视,近点比远点大约 1.5 倍。 */
const DIST_DEFAULT = 5.0;
/** 点击判定:位移小于此值(像素)且时长小于 CLICK_MS 才算点击,否则算拖动。 */
const CLICK_SLOP = 5;
const CLICK_MS = 250;
/** 切换动画时长(ms)。 */
const MORPH_MS = 500;
/** 出生动画时长(ms),与 2D 一致。 */
const GROW_MS = 720;
/** 超过这个条数就不画树突须(与 2D 同阈值)。 */
const DENDRITE_NODE_CAP = 900;

/** 生成辉光贴图(与 2D 同款,保证切换时点的大小不变)。 */
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

/**
 * 远星层:每颗星带一个球壳上的 (x, y, z),
 * 这样转动相机时它们会反向滑动,纵深立刻出来(纯 2D 噪点会暴露「背景是贴图」)。
 */
function makeStars(count) {
  const out = [];
  let seed = 20261126;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const a = rnd() * Math.PI * 2;
    const r = 2.2 + rnd() * 1.6;
    out.push({
      x: Math.cos(a) * r,
      y: (rnd() * 2 - 1) * 1.5,
      z: Math.sin(a) * r,
      r: 0.3 + rnd() * 0.9,
      a: 0.12 + rnd() * 0.5,
    });
  }
  return out;
}

export class SeaView3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onHover?: Function, onSelect?: Function, onCamera?: Function }} [opts]
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

    // 相机
    this.yaw = -0.471;      // 默认 3/4 侧视(-27°):既看得出脑形,又看得出厚度
    this.pitch = 0.209;     // 12°
    this.dist = DIST_DEFAULT;
    this.yawVel = 0;
    this.pitchVel = 0;
    this.autoRotate = false;
    this.autoRotateSpeed = 0.105; // ≈6°/s

    // 几何与外观
    this.depth = BRAIN_DEPTH;
    this.fissure = 0.035;
    this.fitSc = 0;          // 当前取景缩放(随视角自适应,带缓动)
    this.fitReady = false;
    this.morph = 1;         // 0 = 完全 2D 投影,1 = 完全 3D

    // 交互状态
    this.dragging = false;
    this.dragMoved = 0;
    this.dragStart = 0;
    this.pointer = { x: -1, y: -1 };
    this.last = { x: 0, y: 0 };

    this.staticLayer = document.createElement('canvas');
    this.bloomLayer = document.createElement('canvas');
    this.t0 = performance.now();
    this.raf = 0;
    this.dirty = true;
    this.frameTimes = [];
    this.lodLevel = 0;      // 0 = 全量,1 = 减边,2 = 只画点

    this._onDown = (e) => this._handleDown(e);
    this._onMove = (e) => this._handleMove(e);
    this._onUp = (e) => this._handleUp(e);
    this._onLeave = () => { this.pointer = { x: -1, y: -1 }; this._setHovered(null); };
    this._onWheel = (e) => this._handleWheel(e);
    this._onDbl = () => this.resetCamera();
    this._onClick = () => this._handleClick();

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('pointerleave', this._onLeave);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('dblclick', this._onDbl);
    canvas.addEventListener('click', this._onClick);
  }

  /* ───────────────────────── 数据 ───────────────────────── */

  setData(nodes, links) {
    const metrics = nodeMetrics(nodes.length);
    this.metrics = metrics;
    const now = performance.now();
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const placed = nodes.map((n) => {
      const p3 = placeNode3D(n.id, metrics.rimRatio, { depth: this.depth, fissure: this.fissure });
      // 2D 坐标必须与 sea-view.js 完全一致:placeNode 与 placeNode3D 用同一套拒绝采样,
      // 所以 (u, v) 逐位相同(已用 node 断言 uvMismatch=0);z 直接取 2D 的原值。
      // morph=0 时本渲染器画出来就是 2D 那一帧,不是「近似」。
      const p2 = placeNode(n.id, metrics.rimRatio);
      const old = prev.get(n.id);
      return {
        ...n,
        u: p3.u,
        v: p3.v,
        z3: p3.z,
        z2: p2.z,
        birth: old ? -1 : now,
        x: 0,
        y: 0,
        scale: 1,
      };
    });
    const byId = new Map(placed.map((n) => [n.id, n]));
    const edges = [];
    for (const e of links) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (a && b) edges.push({ a, b, w: Math.max(0.15, Math.min(1, e.weight ?? 0.5)) });
    }
    this.nodes = placed;
    this.links = edges;
    this.hovered = null;
    this.dirty = true;
    return this;
  }

  setQuery(q) {
    this.query = (q ?? '').trim();
    this.dirty = true;
  }

  select(id) {
    this.selected = id ? this.nodes.find((n) => n.id === id) ?? null : null;
    this.dirty = true;
  }

  /* ───────────────────────── 相机 ───────────────────────── */

  setCamera(yaw, pitch) {
    this.yaw = wrapYaw(yaw);
    this.pitch = clampPitch(pitch);
    this.dirty = true;
    this.opts.onCamera?.(this.cameraState());
  }

  /** 滚轮/外部设置缩放(视距)。 */
  setZoom(dist) {
    const d = Number(dist);
    if (!Number.isFinite(d)) return;
    this.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, d));
    this.dirty = true;
    this.opts.onCamera?.(this.cameraState());
  }

  resetCamera() {
    this.yawVel = 0;
    this.pitchVel = 0;
    this.dist = DIST_DEFAULT;
    this.setCamera(-0.471, 0.209);
  }

  cameraState() {
    return { yaw: this.yaw, pitch: this.pitch, dist: this.dist };
  }

  setDepth(depth) {
    this.depth = depth;
    // 重新算一遍 z:depth 是几何参数,不是渲染参数
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    for (const n of this.nodes) {
      const p = placeNode3D(n.id, this.metrics.rimRatio, { depth, fissure: this.fissure });
      n.z3 = p.z;
      n.z2 = placeNode(n.id, this.metrics.rimRatio).z;
    }
    this.dirty = true;
  }

  /** 纵向裂开关:关掉后左右半球连成完整椭球。 */
  setFissure(on) {
    this.fissure = on ? FISSURE : 0;
    this.setDepth(this.depth);
  }

  setAutoRotate(on) {
    this.autoRotate = !!on;
  }

  setMorph(t) {
    this.morph = Math.max(0, Math.min(1, t));
    this.dirty = true;
  }

  /* ───────────────────────── 生命周期 ───────────────────────── */

  start() {
    if (this.raf) return;
    this.t0 = performance.now();
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
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('pointerleave', this._onLeave);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('dblclick', this._onDbl);
    c.removeEventListener('click', this._onClick);
  }

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

  /* ───────────────────────── 投影 ───────────────────────── */

  /** 2D 投影,逐字复刻 sea-view.js:229-240(含 fit 与 7% 缩放)。 */
  _project2D(u, v, z) {
    const pad = Math.min(this.w, this.h) * 0.07;
    const availW = Math.max(80, this.w - pad * 2);
    const availH = Math.max(80, this.h - pad * 2);
    const bw = Math.min(availW, availH / BRAIN_ASPECT);
    const ox = (this.w - bw) / 2;
    const oy = (this.h - bw * BRAIN_ASPECT) / 2;
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

  /**
   * 取景缩放:按**当前视角**下椭球的投影包围盒算,而不是外接球。
   * 外接球是「最坏角度也能装下」的保守解,默认 3/4 侧视下只能用到 68%,
   * 画面比 2D 小一圈;按包围盒算,任何角度都刚好填满,且随转动平滑缓动。
   */
  _fitScale() {
    const A = 0.5;                 // x 半轴
    const B = BRAIN_ASPECT / 2;    // y 半轴
    const C = this.depth * 0.5;    // z 半轴(depth 是厚度比,不是半轴)
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const halfW = Math.sqrt(A * A * cy * cy + C * C * sy * sy);
    const halfH = Math.sqrt(B * B * cp * cp + (A * A * sy * sy + C * C * cy * cy) * sp * sp);
    const FIT = 0.78;              // 留出透视近端放大的余量(近点 k≈dist/(dist-C))
    return Math.min((this.w * FIT) / (2 * halfW), (this.h * FIT) / (2 * halfH));
  }

  /** 3D 投影:轨道相机 + 透视。取景缩放用 this.fitSc(由 _buildStatic 每帧更新)。 */
  _project3D(u, v, z) {
    const p = orbitPoint(u, v, z, this.yaw, this.pitch);
    const r = brainRadius(this.depth);
    const sc = this.fitSc || (Math.min(this.w, this.h) * 0.86) / (2 * r);
    const k = perspective(p.z, this.dist);
    // 深度归一:0 = 最远,1 = 最近。透视本身在这个视距下只差 ~11%(近似正交),
    // 立体感必须靠「亮度 + 大小」这两条更强烈的线索,否则转起来像一张平面图在转。
    const t = Math.max(0, Math.min(1, (p.z + r) / (2 * r)));
    const fog = 0.20 + 0.80 * t ** 1.15;
    // 近处更大:0.62 → 1.38 倍,配合亮度差就能读出前后
    const size = k * (0.62 + 0.76 * t);
    return {
      x: this.w / 2 + p.x * k * sc,
      y: this.h / 2 + p.y * k * sc,
      s: size,
      alpha: fog,
      z2: p.z,
      depthT: t,
    };
  }

  /** 当前节点的屏幕坐标(morph 插值:位置、缩放、亮度一起过渡)。 */
  _screenNode(n) {
    const a = this._project2D(n.u, n.v, n.z2);
    if (this.morph <= 0) return a;
    const b = this._project3D(n.u, n.v, n.z3);
    const t = this.morph;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      s: a.s + (b.s - a.s) * t,
      alpha: a.alpha + (b.alpha - a.alpha) * t,
      z2: b.z2 ?? 0,
      depthT: b.depthT ?? 0.5,
    };
  }

  /* ───────────────────────── 静态层 ───────────────────────── */

  _buildStatic() {
    const g = this.staticLayer.getContext('2d');
    const { w, h, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const m = this.metrics;

    // 取景缩放:目标值随视角变,缓动过去(否则转动时画面会「呼吸」)
    const target = this._fitScale();
    if (!this.fitReady || !Number.isFinite(this.fitSc)) {
      this.fitSc = target;
      this.fitReady = true;
    } else {
      const d = target - this.fitSc;
      this.fitSc += Math.abs(d) < 0.5 ? d : d * 0.28;
    }

    // 远星(带视差)
    const sc = this.fitSc;
    g.save();
    for (const s of this.stars) {
      const p = orbitPoint(s.x * 0.5 + 0.5, s.y * 0.5 + BRAIN_ASPECT / 2, s.z * 0.5, this.yaw, this.pitch);
      const k = perspective(p.z, this.dist);
      g.globalAlpha = s.a * (0.55 + 0.45 * k);
      g.fillStyle = '#cfe0ff';
      g.fillRect(w / 2 + p.x * k * sc, h / 2 + p.y * k * sc, s.r, s.r);
    }
    g.restore();

    // 框架:只在记忆很少时出现(和 2D 一致),转到侧面时淡出
    if (m.frameAlpha > 0.004) {
      const faceOn = Math.abs(Math.cos(this.yaw)) * Math.abs(Math.cos(this.pitch));
      g.save();
      g.strokeStyle = `rgba(150,190,235,${(m.frameAlpha * faceOn).toFixed(3)})`;
      g.lineWidth = 1;
      g.setLineDash([3, 5]);
      g.beginPath();
      BRAIN_OUTLINE.forEach(([u, v], i) => {
        const p = this._project3D(u, v, 0);
        if (i === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      });
      g.closePath();
      g.stroke();
      g.restore();
    }

    // 连线(按 LOD 裁剪)
    const maxLinks = this.lodLevel >= 2 ? 0 : this.lodLevel === 1 ? 600 : Infinity;
    let edges = this.links;
    if (edges.length > maxLinks) {
      edges = edges.slice().sort((a, b) => b.w - a.w).slice(0, maxLinks);
    }
    g.save();
    g.globalCompositeOperation = 'lighter';
    const axonOf = new Map();
    for (const e of edges) {
      const pa = this._screenNode(e.a);
      const pb = this._screenNode(e.b);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy);
      const fade = 1 / (1 + len / 90);
      const alpha = (0.05 + 0.10 * e.w) * m.bright * ((pa.alpha + pb.alpha) / 2) * fade;
      if (alpha < 0.008) continue;
      g.strokeStyle = `rgba(186,216,255,${alpha.toFixed(3)})`;
      g.lineWidth = 0.7;
      const bow = Math.min(0.42, len / 520) * (e.a.id < e.b.id ? 1 : -1);
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.quadraticCurveTo(
        (pa.x + pb.x) / 2 - dy * bow,
        (pa.y + pb.y) / 2 + dx * bow,
        pb.x,
        pb.y,
      );
      g.stroke();
      const sa = axonOf.get(e.a.id);
      if (!sa || e.w > sa.w) axonOf.set(e.a.id, { w: e.w, a: Math.atan2(dy, dx), dist: len });
      const sb = axonOf.get(e.b.id);
      if (!sb || e.w > sb.w) axonOf.set(e.b.id, { w: e.w, a: Math.atan2(-dy, -dx), dist: len });
    }
    g.restore();

    // 节点
    g.save();
    g.globalCompositeOperation = 'lighter';
    const dendrites = this.lodLevel === 0 && this.nodes.length <= DENDRITE_NODE_CAP;
    for (const n of this.nodes) {
      const p = this._screenNode(n);
      n.x = p.x;
      n.y = p.y;
      n.scale = p.s;
      // p.s 已含「近大远小」(0.62–1.38);这里再乘 0.34+0.26*alpha 保持与 2D 同观感
      const size = Math.max(7, m.size * p.s * (0.34 + 0.26 * p.alpha));
      const alpha = m.bright * p.alpha;
      const rgb = TYPE_COLOR[n.type] ?? [214, 232, 255];
      if (dendrites) strokeDendrites(g, p.x, p.y, size, rgb, alpha, n.id, axonOf.get(n.id) ?? null);
      g.globalAlpha = Math.min(1, alpha * 0.72);
      g.drawImage(this.glow, p.x - size / 2, p.y - size / 2, size, size);
      g.globalAlpha = Math.min(1, alpha);
      g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      g.beginPath();
      g.arc(p.x, p.y, Math.max(1.2, size * 0.15), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    this.dirty = false;
  }

  /* ───────────────────────── 每帧 ───────────────────────── */

  _frame() {
    const now = performance.now();
    this.resize();

    // 惯性 + 自转:相机自己在动,就要重画
    let moved = false;
    if (!this.dragging) {
      if (Math.abs(this.yawVel) > INERTIA_MIN || Math.abs(this.pitchVel) > INERTIA_MIN) {
        this.yaw = wrapYaw(this.yaw + this.yawVel);
        this.pitch = clampPitch(this.pitch + this.pitchVel);
        this.yawVel *= INERTIA;
        this.pitchVel *= INERTIA;
        moved = true;
      } else if (this.yawVel || this.pitchVel) {
        this.yawVel = 0;
        this.pitchVel = 0;
      }
      if (this.autoRotate && this.morph > 0.5) {
        this.yaw = wrapYaw(this.yaw + this.autoRotateSpeed / 60);
        moved = true;
      }
    }
    if (moved) this.dirty = true;
    if (this.dirty) this._buildStatic();

    const g = this.ctx;
    const { w, h, dpr } = this;
    const t = (now - this.t0) / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = g.createRadialGradient(w / 2, h * 0.48, 0, w / 2, h * 0.48, Math.max(w, h) * 0.78);
    bg.addColorStop(0, '#0a1020');
    bg.addColorStop(1, '#05070d');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // 静态层 + 呼吸位移(拖动时关掉,否则手感发飘)
    const dx = this.dragging ? 0 : Math.sin(t * 0.23) * w * 0.004;
    const dy = this.dragging ? 0 : Math.cos(t * 0.19) * h * 0.004;
    g.drawImage(this.staticLayer, dx, dy, w, h);

    // 出生生长:与 2D 同一套缓动,只是投影换成 morph 插值后的屏幕坐标。
    // 逐帧叠在静态层之上,不触发 dirty —— 重建静态层是这里最贵的一步。
    this._drawGrowing(g, now, dx, dy);

    if (this.selected || this.hovered) this._drawFocus(g, t);
    if (this.query) this._drawDim(g);

    // bloom:拖动中跳过(最大的单笔性能节省),静止时才叠
    if (!this.dragging) {
      const b = this.bloomLayer.getContext('2d');
      b.clearRect(0, 0, this.bloomLayer.width, this.bloomLayer.height);
      b.drawImage(this.canvas, 0, 0, this.bloomLayer.width, this.bloomLayer.height);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.18;
      g.drawImage(this.bloomLayer, 0, 0, w, h);
      g.restore();
    }

    this._trackPerf(now);
  }

  /** 连续掉帧就降一档 LOD,回升不自动恢复(避免抖动)。 */
  _trackPerf(now) {
    if (!this._prevFrame) {
      this._prevFrame = now;
      return;
    }
    const dt = now - this._prevFrame;
    this._prevFrame = now;
    if (!this.dragging && !this.autoRotate) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 12) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 22 && this.lodLevel < 2) {
      this.lodLevel += 1;
      this.dirty = true;
    }
  }

  /** 出生生长(与 2D 同款,投影走 _screenNode,所以 morph 过渡期间也对得上)。 */
  _drawGrowing(g, now, dx, dy) {
    let alive = false;
    const m = this.metrics;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const n of this.nodes) {
      const age = now - (n.birth ?? -1);
      if (!(n.birth >= 0) || age > GROW_MS) continue;
      alive = true;
      const k = growEase(age / GROW_MS);
      const p = this._screenNode(n);
      const size = Math.max(7, m.size * p.s * (0.34 + 0.26 * p.alpha));
      const scale = k < 1 ? 0.35 + 1.75 * k : 1;
      const fade = 1 - k;
      const gs = size * scale;
      const rgb = TYPE_COLOR[n.type] ?? [214, 232, 255];
      g.globalAlpha = Math.min(1, 0.9 * fade);
      g.drawImage(this.glow, p.x + dx - gs / 2, p.y + dy - gs / 2, gs, gs);
      g.globalAlpha = Math.min(0.6, 0.5 * fade);
      g.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.55 * fade).toFixed(3)})`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(p.x + dx, p.y + dy, Math.max(2, gs * 0.34), 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
    return alive;
  }

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

  /* ───────────────────────── 交互 ───────────────────────── */

  _hit(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      // 命中半径随缩放走:远处点不该还有 12px 的命中圈
      const r = Math.max(9, Math.min(22, this.metrics.size * n.scale * 0.34));
      if (d < r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  _local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _handleDown(e) {
    const p = this._local(e);
    this.dragging = true;
    this.dragMoved = 0;
    this.dragStart = performance.now();
    this.last = p;
    this.yawVel = 0;
    this.pitchVel = 0;
    this.canvas.style.cursor = 'grabbing';
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  }

  _handleMove(e) {
    const p = this._local(e);
    this.pointer = p;
    if (this.dragging) {
      const dx = p.x - this.last.x;
      const dy = p.y - this.last.y;
      this.dragMoved += Math.hypot(dx, dy);
      this.last = p;
      this.yawVel = -dx * DRAG_SENS * 0.6;
      this.pitchVel = dy * DRAG_SENS * 0.6;
      this.yaw = wrapYaw(this.yaw - dx * DRAG_SENS);
      this.pitch = clampPitch(this.pitch + dy * DRAG_SENS);
      this.dirty = true;
      // 拖动中不弹卡片,否则卡片跟着鼠标乱飞
      this._setHovered(null);
      return;
    }
    const hit = this._hit(p.x, p.y);
    this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    this._setHovered(hit, e.clientX, e.clientY);
  }

  _handleUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = 'grab';
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    this.dirty = true;
    // 拖动距离很小才算「点了空白处」,不触发选中
    if (this.dragMoved < CLICK_SLOP && performance.now() - this.dragStart < CLICK_MS) {
      this.selected = null;
      this.opts.onSelect?.(null);
    }
    // 用户接管了,自转交还给他
    if (this.autoRotate && this.dragMoved > CLICK_SLOP) {
      this.autoRotate = false;
      this.opts.onCamera?.(this.cameraState());
    }
  }

  _handleWheel(e) {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    this.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, this.dist * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    this.dirty = true;
    this.opts.onCamera?.(this.cameraState());
  }

  _handleClick() {
    if (this.dragMoved >= CLICK_SLOP) return;
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
    this.dirty = true;
    this.opts.onHover?.(node, cx, cy);
  }
}

export { MORPH_MS, DIST_DEFAULT, DIST_MIN, DIST_MAX };
