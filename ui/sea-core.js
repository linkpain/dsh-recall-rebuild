/**
 * 记忆识海 · 纯几何核心(无 DOM、无依赖,Node 与浏览器共用)。
 *
 * 只回答四个问题,全是纯函数,便于 node 直跑测试与离线出图:
 *   1. 大脑轮廓长什么样(矢状面控制点 → Catmull-Rom 闭合曲线);
 *   2. 一个点是否在轮廓内、离轮廓多远;
 *   3. 每条记忆放在哪(由 id 哈希决定的确定性坐标,刷新不重排);
 *   4. 数量 → 尺寸/亮度/连线阈值/框架透明度 的映射表。
 */

/** 矢状面大脑轮廓控制点(归一化 0..1,左侧为额叶,右下为小脑)。 */
export const BRAIN_CTRL = [
  [0.060, 0.420], [0.050, 0.330], [0.090, 0.200], [0.180, 0.100],
  [0.300, 0.045], [0.440, 0.025], [0.580, 0.035], [0.700, 0.075],
  [0.800, 0.140], [0.880, 0.240], [0.930, 0.350], [0.920, 0.440],
  [0.860, 0.500], [0.840, 0.570], [0.860, 0.660], [0.780, 0.720],
  [0.680, 0.700], [0.620, 0.620], [0.550, 0.630], [0.450, 0.660],
  [0.350, 0.660], [0.250, 0.620], [0.180, 0.550], [0.120, 0.500],
];

/** 轮廓包围盒高宽比(v 方向 0.025..0.72)。 */
export const BRAIN_ASPECT = 0.75;

/** Catmull-Rom 闭合曲线加密。 */
export function catmullClosed(pts, per = 16) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < per; s += 1) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** 归一化轮廓(只算一次)。 */
export const BRAIN_OUTLINE = catmullClosed(BRAIN_CTRL, 16);

/** 射线法判断点是否在闭合折线内。 */
export function insidePoly(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[j];
    if (y1 > py !== y2 > py && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** 到轮廓的最短距离(归一化单位,每 4 点取样)。 */
export function boundaryDistance(poly, px, py) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 4) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** 整数坐标哈希 → [0,1)。 */
function hash2(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 值噪声(平滑插值),用来做沟回的疏密。 */
export function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

/** 三层分形噪声。 */
export function fbm(x, y) {
  return (
    valueNoise(x, y) * 0.55 +
    valueNoise(x * 2.03 + 5.1, y * 2.03 + 1.7) * 0.30 +
    valueNoise(x * 4.11 + 9.3, y * 4.11 + 4.2) * 0.15
  );
}

/** 三条主脑沟(归一化端点),只做轻度减密,不做硬挖空。 */
const SULCI = [
  [0.26, 0.58, 0.46, 0.18],
  [0.50, 0.10, 0.62, 0.55],
  [0.74, 0.14, 0.80, 0.52],
];

/**
 * 点的接受概率(0..1):内部用分形噪声造疏密,皮层(贴边)按 rimBoost 加权。
 * 之前用 sin 乘积做沟回会退化成六边形网格,这里换成值噪声。
 */
export function density(u, v, edgeDist, rimBoost) {
  const n = fbm(u * 9.5, v * 9.5);
  let d = 0.28 + 0.72 * n;
  for (const [ax, ay, bx, by] of SULCI) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / len));
    const dist = Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
    if (dist < 0.035) d *= 0.45 + 0.55 * (dist / 0.035);
  }
  // 皮层带:贴着轮廓的一圈几乎必收,再往里快速衰减。
  // 这是"看得出是脑"的关键 —— 轮廓靠点云自己描出来,不画任何壳。
  const rim = Math.exp(-Math.max(0, edgeDist) / 0.038);
  const cortex = 0.55 + 1.9 * rim * (0.4 + 0.6 * rimBoost);
  return Math.max(0.015, Math.min(1, d * cortex));
}

/** FNV-1a 32 位哈希(同一 id 永远同一结果)。 */
export function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32:小而稳的确定性随机数。 */
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 数量 → 视觉参数。越密:点越小越暗、连线越短、框架越淡。 */
export function nodeMetrics(count) {
  const n = Math.max(0, count);
  const size = n <= 40 ? 62 : n <= 150 ? 46 : n <= 400 ? 36 : 27;
  const bright = n <= 40 ? 1 : n <= 150 ? 0.86 : n <= 400 ? 0.7 : 0.55;
  const linkThreshold = n <= 120 ? 118 : n <= 300 ? 86 : 62;
  const frameAlpha = 0.17 * Math.max(0, 1 - n / 140);
  /**
   * 皮层配额:多少比例的节点被"钉"在轮廓附近。
   * 这是全篇最关键的参数 —— 大脑轮廓不靠任何壳,只靠这圈点自己描出来;
   * 配额太低就散成一团云,太高就只剩一个空心圆环(900 条时的样子)。
   */
  const rimRatio = Math.min(0.62, 0.18 + n / 1500);
  const labelBudget = n <= 12 ? n : 8;
  return { size, bright, linkThreshold, frameAlpha, rimRatio, labelBudget };
}

/**
 * 一条记忆的确定性位置(归一化脑坐标 + 深度)。
 *
 * 坐标只由 id 决定、**与总数无关**:新记忆不会挤走旧记忆,刷新也不重排。
 * 总数只通过 rimRatio 改变"这一条落在皮层还是内部"的判定 ——
 * 但该判定本身也来自 id 哈希,所以同一批记忆在任何规模下位置都一样,
 * 成长的观感是"周围不断亮起新的点",而不是整张图重排。
 *
 * @param {string} id 记忆 id。
 * @param {number} rimRatio 0..1,皮层配额(来自 nodeMetrics)。
 */
export function placeNode(id, rimRatio) {
  const h = hashId(id);
  const rand = rngFrom(h);
  // 同一条记忆的"皮层倾向"是固定的;配额变大时,排序靠前的先被点亮到皮层。
  const rimRank = ((h >>> 11) % 1000) / 1000;
  const wantRim = rimRank < rimRatio;
  const RIM_INNER = 0.030;
  const RIM_OUTER = 0.052;

  for (let attempt = 0; attempt < 900; attempt += 1) {
    const u = rand();
    const v = rand() * BRAIN_ASPECT;
    if (!insidePoly(BRAIN_OUTLINE, u, v)) continue;
    const edge = boundaryDistance(BRAIN_OUTLINE, u, v);
    if (wantRim) {
      // 皮层带:只收贴边的一圈,形成"亮的轮廓"
      if (edge > RIM_OUTER) continue;
      if (rand() > 0.55 + 0.45 * (1 - edge / RIM_OUTER)) continue;
    } else {
      // 内部:离开轮廓一圈,再按分形噪声疏密
      if (edge < RIM_INNER) continue;
      if (rand() > density(u, v, edge, 0)) continue;
    }
    const ex = 1 - ((u - 0.5) / 0.5) ** 2;
    const ey = 1 - (v / BRAIN_ASPECT - 0.5) ** 2 / 0.25;
    const spread = Math.sqrt(Math.max(Math.min(ex, ey), 0.02));
    // 皮层本来就薄:贴边处深度收窄,侧视轮廓才不会被 z 缩放糊开
    const rimTaper = wantRim ? 0.22 : Math.min(1, 0.5 + edge / 0.09);
    const z = Math.max(-1, Math.min(1, (rand() * 2 - 1) * spread * rimTaper));
    return { u, v, z };
  }
  // 兜底:轮廓中心(理论上到不了这里)
  return { u: 0.5, v: BRAIN_ASPECT * 0.5, z: 0 };
}

/* ───────────────────────── 3D 体积(v0.1.21) ─────────────────────────
 *
 * 2D 模式用 placeNode:皮层点被 rimTaper 压在中面上,靠「点描边」画出脑剪影。
 * 3D 模式用 placeNode3D:同样的 (u, v) 采样,但 z 铺满椭球体积,
 * 于是侧视仍是脑形、正面是两个半球、任意角度都是实心的。
 *
 * 关键约束:**两者对同一 id 给出同一 (u, v)**。这样 2D↔3D 切换时
 * 点在屏幕上只是沿深度方向鼓起来,不会横向乱跳。
 */

/** 默认厚度比(厚 / 宽)。0.60 → 厚度是宽度的 60%,接近真实脑的宽厚比。 */
export const BRAIN_DEPTH = 0.6;

/** 纵向裂半宽:左右半球之间的缝隙,3D 下才可见。 */
export const FISSURE = 0.035;

/** 俯仰角上限(85°):再往上画面会上下颠倒,空间感断掉。 */
export const MAX_PITCH = 1.4835;

/** 椭球包络的半宽(0..1),与 placeNode 里的 spread 同源。 */
export function halfWidth(u, v) {
  const ex = 1 - ((u - 0.5) / 0.5) ** 2;
  const ey = 1 - (v / BRAIN_ASPECT - 0.5) ** 2 / 0.25;
  return Math.sqrt(Math.max(Math.min(ex, ey), 0.02));
}

/**
 * 一条记忆的 3D 位置:(u, v) 与 placeNode 完全一致,z 铺在体积里。
 *
 * - 皮层点(wantRim)落在椭球**表面**的近轮廓处,侧视时仍是那一圈亮点;
 * - z 半轴 = depth * 0.5 * halfWidth:depth 是「厚 / 宽」比,0.6 表示厚度为宽度 60%;
 * - 内部点按 cbrt 均匀填充体积(直接用 rand 会向中心聚集);
 * - 纵向裂:落在 |z| < gap 的点被推到缝隙外,正面才分得开两个半球。
 *
 * @param {string} id 记忆 id。
 * @param {number} rimRatio 0..1,皮层配额(来自 nodeMetrics)。
 * @param {{ depth?: number, fissure?: number }} [opts]
 */
export function placeNode3D(id, rimRatio, opts = {}) {
  const depth = opts.depth ?? BRAIN_DEPTH;
  const fissure = opts.fissure ?? FISSURE;
  const h = hashId(id);
  const rand = rngFrom(h);
  const rimRank = ((h >>> 11) % 1000) / 1000;
  const wantRim = rimRank < rimRatio;
  const RIM_INNER = 0.03;
  const RIM_OUTER = 0.052;

  for (let attempt = 0; attempt < 900; attempt += 1) {
    const u = rand();
    const v = rand() * BRAIN_ASPECT;
    if (!insidePoly(BRAIN_OUTLINE, u, v)) continue;
    const edge = boundaryDistance(BRAIN_OUTLINE, u, v);
    if (wantRim) {
      if (edge > RIM_OUTER) continue;
      if (rand() > 0.55 + 0.45 * (1 - edge / RIM_OUTER)) continue;
    } else {
      if (edge < RIM_INNER) continue;
      if (rand() > density(u, v, edge, 0)) continue;
    }
    // 半轴:宽度方向 u∈[0,1] 半轴 0.5,深度方向同理 → z 半轴 = depth * 0.5
    const hw = depth * 0.5 * halfWidth(u, v);
    let z;
    if (wantRim) {
      // 贴在椭球表面:侧视时投影到轮廓线上,3D 转动时沿表面滑
      const sign = rand() < 0.5 ? -1 : 1;
      z = sign * hw * (0.86 + 0.14 * rand());
    } else {
      // 体积内均匀:cbrt 抵消球壳体积随半径平方增长
      z = (rand() * 2 - 1) * hw * Math.cbrt(rand());
    }
    const gap = Math.min(fissure, hw * 0.6);
    if (Math.abs(z) < gap) {
      z = (z < 0 ? -1 : 1) * (gap + (hw - gap) * Math.sqrt(rand()));
    }
    return { u, v, z };
  }
  return { u: 0.5, v: BRAIN_ASPECT * 0.5, z: 0 };
}

/** 大脑外接球半径(含深度),用于旋转时的稳定取景。 */
export function brainRadius(depth = BRAIN_DEPTH) {
  return Math.sqrt(0.5 * 0.5 + (BRAIN_ASPECT / 2) ** 2 + (depth * 0.5) ** 2);
}

/** 俯仰角夹紧。 */
export function clampPitch(p) {
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p));
}

/** 偏航角归一到 (-π, π],避免长时间拖动后浮点精度流失。 */
export function wrapYaw(y) {
  const TAU = Math.PI * 2;
  return ((((y + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/**
 * 轨道相机:脑空间坐标 → 相机空间。
 * 先绕 Y 轴偏航,再绕 X 轴俯仰。返回 { x, y, z },x/y 以脑中心为原点。
 */
export function orbitPoint(u, v, z, yaw, pitch) {
  const x = u - 0.5;
  const y = v - BRAIN_ASPECT / 2;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x: x1, y: y * cp - z1 * sp, z: y * sp + z1 * cp };
}

/** 透视除法:近大远小。dist 越小越戏剧化。 */
export function perspective(z, dist) {
  return dist / Math.max(0.15, dist - z);
}

