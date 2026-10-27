/**
 * IM 用户级命名空间隔离。
 *
 * 背景:prime-memory 的检索只按 workspace(项目路径)+ scope 过滤,IM 场景(QQ/微信桥接)
 * 的记忆全部落在 scope='global',跨用户必然串味。底层记忆库没有 IM 用户字段,
 * 本插件在**自己的目录**(<DSH_HOME>/recall-rebuild/namespaces,缺省 ~/.dsh/recall-rebuild/namespaces)
 * 维护「记忆记录 id → 归属用户」的观察式索引,检索时按隔离模式过滤。
 *
 * 归属语义(启发式,诚实声明局限):
 * - 一条记忆 id 在哪个用户的会话里被检索命中并保留,就归属哪个用户;
 * - 多用户会话都命中过的记忆 → 多归属 → 对这些用户都可见(群聊共享场景自然成立);
 * - 从未被任何用户会话命中过的"无主"记忆(auto 模式)默认可见,命中后归位;
 * - 隔离索引只写本插件的目录,绝不写底层记忆库。
 *
 * userKey 提取:优先解析 IM 桥接(@xmanrui/dsh-im 等)注入消息的
 * `<dsh_im_source>{json}</dsh_im_source>` 文本块(senderId/chatId/threadId/botId),
 * 兜底匹配常见字段(senderId/userId/user_id/openid/fromUser);桌面直接对话识别不到
 * 用户时返回 null —— 不做隔离(保持现行为),绝不猜测。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryRecord } from './store.js';
import type { LoggerLike } from './store.js';

export type IsolationMode = 'off' | 'auto' | 'strict';

/** 内置 <dsh_im_source> 块:JSON 内 < > & 被转义为 \u003c 等。 */
const SOURCE_BLOCK = /<dsh_im_source>\s*(\{[\s\S]*?\})\s*<\/dsh_im_source>/;

/** 兜底字段(QQ openid / senderId / userId / fromUser 等)。 */
const FALLBACK_FIELD = /(?:senderId|userId|user_id|openid|fromUser|from_openid)["':=\s]*([A-Za-z0-9_@.\-]{6,64})/;

/** 从消息文本中提取当前 IM 用户键;识别不到返回 null。pattern 可覆盖内置 <dsh_im_source> 正则。 */
export function extractUserKey(texts: string[], pattern?: string): string | null {
  const custom = pattern ? new RegExp(pattern, 'i') : null;
  for (const t of texts) {
    if (!t) continue;
    const block = SOURCE_BLOCK.exec(t);
    if (block) {
      try {
        const j = JSON.parse(block[1] ?? '{}') as {
          senderId?: unknown;
          chatId?: unknown;
          threadId?: unknown;
          botId?: unknown;
          channel?: unknown;
        };
        const id = j.senderId ?? j.chatId ?? j.threadId ?? j.botId;
        if (typeof id === 'string' && id) {
          const channel = typeof j.channel === 'string' && j.channel ? j.channel : 'im';
          return `im:${channel}:${id.slice(0, 128)}`;
        }
      } catch {
        /* 块解析失败 → 尝试兜底字段 */
      }
    }
    const fb = FALLBACK_FIELD.exec(t);
    if (fb && fb[1]) return `im-fallback:${fb[1].slice(0, 128)}`;
    if (custom) {
      const cm = custom.exec(t);
      if (cm && cm[1]) return `im-custom:${cm[1].slice(0, 128)}`;
    }
  }
  return null;
}

/** 用户键 → 文件名(只留安全字符,避免路径穿越/非法字符)。 */
function fileFor(userKey: string): string {
  const safe = userKey.replace(/[^A-Za-z0-9_.@-]/g, '_');
  return `${safe}.json`;
}

interface OwnerFile {
  memoryIds: Record<string, number>;
}

export class NamespaceStore {
  private readonly dir: string;
  private readonly logger: LoggerLike;
  /** 目录缓存:userKey → memoryId 集;cacheTtlMs 内复用,避免每轮扫描磁盘。 */
  private cache: Map<string, Set<string>> = new Map();
  private cacheAt = 0;
  private readonly cacheTtlMs = 5000;

  constructor(dir: string, logger: LoggerLike) {
    this.dir = dir;
    this.logger = logger;
  }

  /** 确保目录存在(只建本插件自己的目录)。 */
  ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `[recall-rebuild] 无法创建用户隔离目录 ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 重建缓存(遍历 namespaces 下所有归属文件)。 */
  private refresh(): void {
    this.cache.clear();
    this.cacheAt = Date.now();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return; // 目录不存在/不可读 → 空索引(不隔离)
    }
    for (const n of names) {
      const p = path.join(this.dir, n);
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8')) as OwnerFile;
        const ids = doc.memoryIds ?? {};
        const set = new Set<string>(Object.keys(ids));
        if (set.size > 0) this.cache.set(n, set);
      } catch {
        /* 单个文件损坏不影响其它用户 */
      }
    }
  }

  /** 全部用户归属集:memoryId → [userKey...](cache 内复用)。 */
  private ownersOf(): Map<string, string[]> {
    if (this.cache.size === 0 || Date.now() - this.cacheAt > this.cacheTtlMs) this.refresh();
    const owners = new Map<string, string[]>();
    for (const [file, ids] of this.cache) {
      for (const id of ids) {
        const arr = owners.get(id);
        if (arr) arr.push(file);
        else owners.set(id, [file]);
      }
    }
    return owners;
  }

  /** 当前用户已归属的记忆 id 集。 */
  private userIds(userKey: string): Set<string> {
    if (this.cache.size === 0 || Date.now() - this.cacheAt > this.cacheTtlMs) this.refresh();
    return this.cache.get(fileFor(userKey)) ?? new Set<string>();
  }

  /**
   * 按隔离模式过滤候选记忆。
   * @param memories 检索候选(已按相关性排序)
   * @param userKey  当前用户键;null = 桌面/无法识别 → 不过滤
   * @param mode     off / auto / strict
   */
  filter(memories: MemoryRecord[], userKey: string | null, mode: IsolationMode): MemoryRecord[] {
    if (!userKey || mode === 'off' || memories.length === 0) return memories;
    const owners = this.ownersOf();
    const mine = this.userIds(userKey);
    if (mode === 'strict') {
      // 只保留"已归属给当前用户"的记忆;无主记忆一律不注入(新用户记忆随命中逐渐归位)
      return memories.filter((m) => m.id && mine.has(m.id));
    }
    // auto:剔除"明确属于其他用户"的记忆;无主记忆保留(保守可见,命中后归位)
    return memories.filter((m) => {
      if (!m.id) return true;
      const who = owners.get(m.id);
      if (!who || who.length === 0) return true; // 无主 → 保留
      return who.some((f) => f === fileFor(userKey));
    });
  }

  /** 把"本轮实际保留的候选"记为当前用户归属(增量、原子写)。 */
  recordHits(userKey: string | null, memories: MemoryRecord[]): void {
    if (!userKey || memories.length === 0) return;
    const file = fileFor(userKey);
    const p = path.join(this.dir, file);
    const now = Date.now();
    let doc: OwnerFile = { memoryIds: {} };
    try {
      if (fs.existsSync(p)) doc = JSON.parse(fs.readFileSync(p, 'utf8')) as OwnerFile;
    } catch {
      doc = { memoryIds: {} };
    }
    let changed = false;
    for (const m of memories) {
      if (!m.id) continue;
      if (typeof doc.memoryIds[m.id] !== 'number') {
        doc.memoryIds[m.id] = now;
        changed = true;
      }
    }
    if (!changed) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, p); // 原子替换,避免半写
      // 写归属会改变反向索引(ownersOf),整体失效缓存,下次读取重新扫描
      this.cache.clear();
      this.cacheAt = 0;
    } catch (err) {
      this.logger.warn(
        `[recall-rebuild] 写用户归属失败(${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
