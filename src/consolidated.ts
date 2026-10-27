/**
 * 睡眠巩固层(长期记忆子系统):本插件自己的「二次长期记忆」。
 *
 * 类比人脑睡眠巩固:白天碎片(海马体)夜间回放、迁移到新皮层成为稳定记忆,
 * 同时修剪弱记忆、建立联想。对应到本插件:
 * - 底层记忆插件 = 海马体(即时捕获碎片);
 * - 本插件 consolidate 层 = 新皮层(把碎片聚类 → LLM 抽象为稳定记忆 → 联想扩散 → 低频遗忘);
 * - 产出只存自己的目录(<DSH_HOME>/recall-rebuild/consolidated/),绝不写底层记忆库。
 *
 * 本文件:巩固层存储(记忆条目/联想图/meta)+ 纯逻辑(聚类/相似度/遗忘判定)。
 * 引擎(LLM 抽象、触发调度)在 consolidate.ts。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from './store.js';

/** 巩固记忆条目。 */
export interface ConsolidatedMemory {
  id: string;
  /** 归属用户(参与 IM 命名空间隔离);null = 桌面/共享/无主。 */
  userKey: string | null;
  type: 'stable-fact' | 'pattern' | 'preference' | 'relationship' | 'mood';
  content: string;
  /** 蒸馏来源:底层记忆 id 列表。 */
  sourceIds: string[];
  /** 置信度 0-1:来源碎片数、一致性、命中频率共同决定。 */
  confidence: number;
  /** active = 参与召回;dormant = 被「遗忘」(召回降权),不删除、不写底层库。 */
  status: 'active' | 'dormant';
  createdAt: number;
  updatedAt: number;
  /** 被召回命中的次数(越用越稳)。 */
  touchCount: number;
  lastRecalledAt?: number;
}

export type ConsolidatedType = ConsolidatedMemory['type'];

/** 联想图:条目 id → 关联条目 id → {weight, label}。 */
export type LinkGraph = Record<string, Record<string, { weight: number; label: string }>>;

export interface ConsolidateMeta {
  lastRunAt: number;
  runCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 中文 2-gram + 空白词的 token 集合(用于轻量相似度聚类,无需 LLM)。 */
const STOP = new Set([
  '用户', '喜欢', '一个', '这个', '那个', '什么', '怎么', '我们', '你们', '他们',
  '因为', '所以', '但是', '如果', '就是', '还是', '已经', '可以', '没有',
  '的', '了', '我', '你', '他', '她', '它', '在', '是', '和', '与', '及', '都',
  '很', '也', '就', '不', '吗', '呢', '啊', '呀', '吧', '哦', '哈', '嗯', '哎',
]);

export function tokenize(s: string): string[] {
  const t = (s ?? '').toLowerCase().trim();
  if (!t) return [];
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (g.trim() && !STOP.has(g)) out.add(g);
  }
  for (const w of t.split(/\s+/)) {
    if (w.length > 1 && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

/** Jaccard 相似度。 */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let inter = 0;
  for (const x of ta) if (setB.has(x)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * 贪心聚类:按相似度阈值把碎片分组。
 * 返回下标分组数组,每个碎片最多进入一个簇。
 */
export function clusterize(
  items: { id: string; content: string }[],
  threshold: number,
  maxCluster: number,
): string[][] {
  const clusters: string[][] = [];
  const used = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || used.has(item.id)) continue;
    const group: string[] = [item.id];
    used.add(item.id);
    for (let j = 0; j < items.length && group.length < maxCluster; j++) {
      if (i === j) continue;
      const other = items[j];
      if (!other || used.has(other.id)) continue;
      if (similarity(item.content, other.content) >= threshold) {
        group.push(other.id);
        used.add(other.id);
      }
    }
    if (group.length > 1 || item.content.length >= 12) clusters.push(group);
  }
  return clusters;
}

/** 遗忘判定:置信度过低 + 长期未命中 → dormant。 */
export function isDormant(
  m: ConsolidatedMemory,
  now: number,
  opts: { confidenceThreshold: number; dormantDays: number },
): boolean {
  if (m.status === 'dormant') return true;
  if (m.confidence >= opts.confidenceThreshold) return false;
  if (m.touchCount >= 3) return false;
  const last = m.lastRecalledAt ?? m.createdAt;
  return now - last > opts.dormantDays * DAY_MS;
}

/** 按快照读取的巩固层存储(内存态 + 原子落盘)。 */
export class ConsolidatedStore {
  private readonly dir: string;
  private readonly logger: LoggerLike;
  private memories: Map<string, ConsolidatedMemory> = new Map();
  private links: LinkGraph = {};
  private meta: ConsolidateMeta = { lastRunAt: 0, runCount: 0 };
  private readonly files = {
    memories: 'memories.json',
    links: 'links.json',
    meta: 'meta.json',
    pending: 'pending.json',
  };

  constructor(dir: string, logger: LoggerLike) {
    this.dir = dir;
    this.logger = logger;
  }

  ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `[recall-rebuild] 巩固层目录创建失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown): void {
    try {
      const p = path.join(this.dir, file);
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (err) {
      this.logger.warn(
        `[recall-rebuild] 巩固层写 ${file} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 从磁盘加载(容错:文件缺失/损坏 → 空)。 */
  load(): void {
    this.ensureDir();
    const mems = this.readJson<ConsolidatedMemory[]>(this.files.memories, []);
    this.memories = new Map(mems.map((m) => [m.id, m]));
    this.links = this.readJson<LinkGraph>(this.files.links, {});
    this.meta = this.readJson<ConsolidateMeta>(this.files.meta, { lastRunAt: 0, runCount: 0 });
  }

  saveAll(): void {
    this.writeJson(this.files.memories, [...this.memories.values()]);
    this.writeJson(this.files.links, this.links);
    this.writeJson(this.files.meta, this.meta);
  }

  list(): ConsolidatedMemory[] {
    return [...this.memories.values()];
  }

  get(id: string): ConsolidatedMemory | undefined {
    return this.memories.get(id);
  }

  /** 新增或合并条目(同 id 更新)。 */
  upsert(m: ConsolidatedMemory): void {
    this.memories.set(m.id, m);
    this.writeJson(this.files.memories, [...this.memories.values()]);
  }

  /** 命中一次:计数 +1、更新 lastRecalledAt;同时按遗忘规则降权。 */
  touch(id: string, now: number, opts: { confidenceThreshold: number; dormantDays: number }): void {
    const m = this.memories.get(id);
    if (!m) return;
    m.touchCount += 1;
    m.lastRecalledAt = now;
    if (isDormant(m, now, opts)) m.status = 'dormant';
    this.writeJson(this.files.memories, [...this.memories.values()]);
  }

  /** 用户主动删除:物理移除条目及全部联想边(与被动遗忘不同,这是显式操作)。 */
  remove(id: string): boolean {
    if (!this.memories.has(id)) return false;
    this.memories.delete(id);
    delete this.links[id];
    for (const k of Object.keys(this.links)) {
      delete this.links[k]?.[id];
      if (Object.keys(this.links[k] ?? {}).length === 0) delete this.links[k];
    }
    this.writeJson(this.files.memories, [...this.memories.values()]);
    this.writeJson(this.files.links, this.links);
    return true;
  }

  /** 联想扩散:给一对条目加关联边(weight 累加)。 */
  addLink(a: string, b: string, label: string): void {
    if (a === b) return;
    if (!this.links[a]) this.links[a] = {};
    const edge = this.links[a][b];
    if (edge) edge.weight += 1;
    else this.links[a][b] = { weight: 1, label };
    this.writeJson(this.files.links, this.links);
  }

  /** 取某条目的强关联(weight ≥ minWeight),按权重降序。 */
  strongLinks(id: string, minWeight: number, max: number): { id: string; weight: number }[] {
    const edges = this.links[id] ?? {};
    return Object.entries(edges)
      .filter(([, e]) => e.weight >= minWeight)
      .map(([tid, e]) => ({ id: tid, weight: e.weight }))
      .sort((x, y) => y.weight - x.weight)
      .slice(0, max);
  }

  // ── 待巩固碎片缓冲(pending) ────────────────────────────────
  /** 读 pending 碎片(容错)。 */
  pending(): { id: string; content: string; userKey: string | null; ts: number }[] {
    return this.readJson(this.files.pending, []);
  }

  /** 追加 pending 碎片(去重,限量防膨胀)。 */
  addPending(items: { id: string; content: string; userKey: string | null }[], max: number): void {
    const cur = this.pending();
    const seen = new Set(cur.map((p) => p.id));
    const now = Date.now();
    for (const it of items) {
      if (seen.has(it.id)) continue;
      if (cur.length >= max) break;
      cur.push({ ...it, ts: now });
      seen.add(it.id);
    }
    this.writeJson(this.files.pending, cur);
  }

  /** 清空 pending(巩固完成/放弃)。 */
  clearPending(): void {
    this.writeJson(this.files.pending, []);
  }

  /** 更新 meta(lastRunAt/runCount)。 */
  markRun(now: number): void {
    this.meta.lastRunAt = now;
    this.meta.runCount += 1;
    this.writeJson(this.files.meta, this.meta);
  }

  metaInfo(): ConsolidateMeta {
    return { ...this.meta };
  }

  /** 触发判定:pending 数量达标 且 距上次巩固超过最短间隔。 */
  shouldRun(opts: { minFragments: number; minIntervalMs: number }, now: number): boolean {
    if (this.pending().length < opts.minFragments) return false;
    return now - this.meta.lastRunAt > opts.minIntervalMs;
  }
}

/** 给 verify 用的纯函数:从 LLM 原始输出解析巩固 JSON。 */
export function parseConsolidationOutput(
  raw: string,
): { type: ConsolidatedType; content: string }[] {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const obj = JSON.parse(m[0]) as { memories?: { type?: string; content?: string }[] };
    if (!Array.isArray(obj.memories)) return [];
    const valid: ConsolidatedType[] = ['stable-fact', 'pattern', 'preference', 'relationship', 'mood'];
    return obj.memories
      .filter((x) => x && typeof x.content === 'string' && x.content.trim())
      .map((x) => ({
        type: valid.includes(x.type as ConsolidatedType) ? (x.type as ConsolidatedType) : 'stable-fact',
        content: x.content!.trim().slice(0, 400),
      }));
  } catch {
    return [];
  }
}
