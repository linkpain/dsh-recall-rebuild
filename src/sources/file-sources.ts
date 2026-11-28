/**
 * 文件系记忆插件(Markdown / JSON / JSONL)的适配器。
 *
 * 与 sqlite-sources.ts 同一思路:每个插件只描述「数据在哪、长什么样」,
 * 解析与检索全部复用 kit.ts 的原语。
 *
 * 每个 open* 都收一个 refreshMs:传 0(缺省)表示「打开时读一次,之后不再变」;
 * 传正数表示每隔这么久在检索路径上重读一次 —— 文件系记忆库是「边聊边写」的,
 * 读一次就定住会让启动后新记的东西永远召回不到,只能重启 DSH 才生效。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dshHome,
  userHome,
  isFile,
  isDir,
  walkFiles,
  readText,
  mtimeDate,
  epochToDate,
  parseFrontmatter,
  fmString,
  fmList,
  readMarkdownDocs,
  readJsonDocs,
  readJsonlDocs,
  readVecSidecar,
  makeTextStore,
} from './kit.js';
import type { Doc } from './kit.js';
import type { LoggerLike, MemoryStore } from '../store.js';

/** 空源占位(统一构造,避免各处重复)。 */
export function emptyStore(label: string, logger: LoggerLike, why: string): MemoryStore {
  logger.warn('[recall-rebuild] ' + label + ':跳过(' + why + ')');
  return { ok: false, label: label + '(' + why + ')', search: () => [], close: () => { /* 无资源 */ } };
}

/** 把一个目录下的 Markdown 全量读成 Doc[]。 */
function collectMarkdown(
  root: string,
  type: string,
  opts: { exts?: string[]; maxFiles?: number; skipDirs?: string[]; relPrefix?: string } = {},
): Doc[] {
  if (!isDir(root)) return [];
  const files = walkFiles(root, {
    exts: opts.exts ?? ['.md', '.markdown'],
    maxFiles: opts.maxFiles ?? 3000,
    skipDirs: opts.skipDirs,
  });
  const out: Doc[] = [];
  for (const file of files) {
    const rel = (opts.relPrefix ? opts.relPrefix + '/' : '') + path.relative(root, file).replace(/\\/g, '/');
    out.push(...readMarkdownDocs(file, rel, type));
  }
  return out;
}

/** @jipika/dsh-memory:~/.dsh/memory/topics/*.md 分片(每行 "- [日期] 事实")。 */
export function openJipikaSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const root = path.join(dshHome(), 'memory', 'topics');
  const collect = (): Doc[] => collectMarkdown(root, 'jipika', { relPrefix: 'topics', maxFiles: 2000 });
  const docs = collect();
  if (docs.length === 0) return emptyStore('@jipika/dsh-memory', logger, '未找到 topics 分片');
  return makeTextStore('@jipika/dsh-memory', docs, logger, { reload: collect, refreshMs });
}

/** @furongjun1999/dsh-memory(灵枢):~/.dsh/.dsh-memory/data/mdcg 下的节点 Markdown。 */
export function openLingshuSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const roots = [
    process.env.MDCG_DATA_ROOT?.trim(),
    path.join(dshHome(), '.dsh-memory', 'data', 'mdcg'),
    path.join(userHome(), '.dsh-memory', 'data', 'mdcg'),
  ].filter((x): x is string => Boolean(x));
  const collect = (): Doc[] => {
    const docs: Doc[] = [];
    for (const root of roots) {
      if (!isDir(root)) continue;
      // 节点散在各层子目录(contextual/、anchor/ 等),跳过索引与预热缓存目录
      docs.push(...collectMarkdown(root, 'lingshu', { maxFiles: 4000, skipDirs: ['_hot', '_index', '_trash', 'archive'] }));
      if (docs.length > 0) break;
    }
    return docs;
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('@furongjun1999/dsh-memory', logger, '未找到 mdcg 节点');
  return makeTextStore('@furongjun1999/dsh-memory', docs, logger, { reload: collect, refreshMs });
}

/** dsh-mnemon:~/.mnemon/runtime/{MEMORY.md,USER.md} + ~/.mnemon/documents/active/*.md。 */
export function openMnemonSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const root = path.join(userHome(), '.mnemon');
  const collect = (): Doc[] => {
    const docs: Doc[] = [];
    for (const name of ['MEMORY.md', 'USER.md']) {
      const file = path.join(root, 'runtime', name);
      if (isFile(file)) docs.push(...readMarkdownDocs(file, 'runtime/' + name, 'mnemon'));
    }
    docs.push(...collectMarkdown(path.join(root, 'documents', 'active'), 'mnemon', { relPrefix: 'documents' }));
    return docs;
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-mnemon', logger, '未找到 runtime/documents');
  return makeTextStore('dsh-mnemon', docs, logger, { reload: collect, refreshMs });
}

/** dsh-longterm-memory:Obsidian 兼容 vault(vaultPath 由用户配置,这里探测常见位置)。 */
export function openLongtermSource(cwd: string, logger: LoggerLike, refreshMs = 0): MemoryStore {
  const candidates = [
    process.env.DSH_LONGTERM_VAULT?.trim(),
    path.join(cwd, '.dsh-longterm-memory'),
    path.join(dshHome(), 'longterm-memory'),
    path.join(dshHome(), 'vault'),
    path.join(userHome(), 'Memory', 'ObsidianVault'),
  ].filter((x): x is string => Boolean(x));
  let usedRoot = '';
  const collect = (): Doc[] => {
    // 刷新时沿用首次选中的 vault:用户新建一个空目录不该让检索悄悄换库
    if (usedRoot) return collectMarkdown(usedRoot, 'longterm', { maxFiles: 3000, skipDirs: ['.obsidian', '.trash'] });
    for (const root of candidates) {
      if (!isDir(root)) continue;
      const docs = collectMarkdown(root, 'longterm', { maxFiles: 3000, skipDirs: ['.obsidian', '.trash'] });
      if (docs.length > 0) {
        usedRoot = root;
        return docs;
      }
    }
    return [];
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-longterm-memory', logger, '未配置 vaultPath');
  return makeTextStore('dsh-longterm-memory', docs, logger, { reload: collect, refreshMs });
}

/** dsh-memory-hub:~/.dsh/memory-hub/{knowledge,records,pending} 下的 Markdown 记录。 */
export function openHubSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const root = path.join(dshHome(), 'memory-hub');
  const collect = (): Doc[] => {
    const docs: Doc[] = [];
    for (const sub of ['knowledge', 'records', 'pending']) {
      docs.push(...collectMarkdown(path.join(root, sub), 'hub', { relPrefix: sub, maxFiles: 2000 }));
    }
    return docs;
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-memory-hub', logger, '未找到 knowledge/records');
  return makeTextStore('dsh-memory-hub', docs, logger, { reload: collect, refreshMs });
}

/** 把若干 JSON 文件读成 Doc[](不存在的文件自动跳过)。 */
function collectJson(files: Array<{ file: string; rel: string }>, type: string): Doc[] {
  const out: Doc[] = [];
  for (const { file, rel } of files) {
    if (!isFile(file)) continue;
    out.push(...readJsonDocs(file, rel, type));
  }
  return out;
}

/** dsh-memory-engine / @wilshi/dsh-memory-engine:<DSH_HOME>/memory-engine/memories.json。 */
export function openMemoryEngineSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const dir = path.join(dshHome(), 'memory-engine');
  const collect = (): Doc[] =>
    collectJson(
      [
        { file: path.join(dir, 'memories.json'), rel: 'memories.json' },
        { file: path.join(dir, 'archive.json'), rel: 'archive.json' },
      ],
      'memory-engine',
    );
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-memory-engine', logger, '未找到 memories.json');
  return makeTextStore('dsh-memory-engine', docs, logger, { reload: collect, refreshMs });
}

/** dsh-memory-tiers:<DSH_HOME>/storages/memory 的六层文件(L1/L2/L3/DL1/DL2/DL3)。 */
export function openMemoryTiersSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const dir = path.join(dshHome(), 'storages', 'memory');
  const layers = ['L1.json', 'L2.json', 'L3.json', 'DL1.json', 'DL2.json', 'DL3.json'];
  const collect = (): Doc[] =>
    collectJson(
      layers.map((name) => ({ file: path.join(dir, name), rel: name.replace('.json', '') })),
      'tiers',
    );
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-memory-tiers', logger, '未找到六层记忆文件');
  return makeTextStore('dsh-memory-tiers', docs, logger, { reload: collect, refreshMs });
}

/* ── dsh-auto-memory(纯 Markdown,一个记忆一个文件)────────────────
 * 落盘形态:<DSH_HOME>/memory/ 下 `_user/`(用户级)+ `--<slug>--/`(项目级,
 * slug 是 cwd 的可读编码),每个作用域目录里「一条记忆一个 .md」,外加一个
 * 派生的 MEMORY.md 索引。文件是 YAML frontmatter + 正文:
 *   name(必填)/ description(必填)/ type / title / created / updated / reads /
 *   pinned / importance / disabled / status / keywords / supersededBy / validUntil
 * MEMORY.md 是索引、audit.jsonl 是审计日志,两者都不是记忆本身,跳过。
 * 与其它源一致:墓碑(superseded)、显式 disabled、已过 validUntil 的条目不参与召回。 */

/** dsh-auto-memory 的记忆根:默认 <DSH_HOME>/memory(上游可用 config.memoryDir 覆盖)。 */
export function autoMemoryRoot(): string {
  return path.join(dshHome(), 'memory');
}

/** 该目录下是否有 auto-memory 的作用域目录(`_user` 或 `--<slug>--`)。 */
export function hasAutoMemoryScopes(root: string): boolean {
  if (!isDir(root)) return false;
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return false;
  }
  return names.some((n) => n === '_user' || (n.startsWith('--') && n.endsWith('--')));
}

/** 解析一个记忆文件;不是合法记忆(缺 name/description、墓碑、已禁用、已过期)返回 null。 */
function parseAutoMemoryFile(file: string, rel: string, now: number): Doc | null {
  const text = readText(file);
  if (!text) return null;
  const { data, body } = parseFrontmatter(text);
  const name = fmString(data['name']).trim();
  const description = fmString(data['description']).trim();
  // 上游 parseMemory 的硬条件:没有 name 或 description 就不是一条记忆
  if (!name || !description) return null;
  if (fmString(data['status']).trim() === 'superseded') return null;
  if (fmString(data['disabled']).trim() === 'true') return null;
  const validUntil = Number(fmString(data['validUntil']));
  if (Number.isFinite(validUntil) && validUntil > 0 && validUntil < now) return null;

  const title = fmString(data['title']).trim();
  const keywords = fmList(data['keywords']);
  const type = fmString(data['type']).trim() || 'reference';
  const bodyText = body.trim();
  const content = [title, description, bodyText].filter(Boolean).join(' — ');
  const stamp = Number(fmString(data['updated']) || fmString(data['created']));
  return {
    id: rel + '#' + name,
    text: content.length > 4000 ? content.slice(0, 4000) : content,
    // description 是上游写的「一句话摘要」,检索价值等同标题
    hints: [title, description, ...keywords].filter(Boolean),
    scene: type,
    family: rel,
    type: 'auto-memory',
    ts: Number.isFinite(stamp) && stamp > 0 ? epochToDate(stamp) : mtimeDate(file),
    scope: rel.split('/')[0] === '_user' ? 'user' : 'project',
  };
}

/** dsh-auto-memory:<DSH_HOME>/memory 的 `_user/` 与 `--<slug>--/` 目录。 */
export function openAutoMemorySource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const root = autoMemoryRoot();
  if (!isDir(root)) return emptyStore('dsh-auto-memory', logger, '未找到 memory 目录');
  const collect = (): Doc[] => {
    const now = Date.now();
    const docs: Doc[] = [];
    for (const file of walkFiles(root, { exts: ['.md'], maxFiles: 400, skipDirs: ['archive', 'graveyard'] })) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      // 索引与归档不是记忆本身;只收作用域目录下一层的 .md
      if (rel.split('/').length !== 2) continue;
      if (/^MEMORY\.md$/i.test(path.basename(file))) continue;
      const doc = parseAutoMemoryFile(file, rel, now);
      if (doc) docs.push(doc);
    }
    return docs;
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('dsh-auto-memory', logger, '没有可读的记忆文件');
  return makeTextStore('dsh-auto-memory', docs, logger, { reload: collect, refreshMs });
}

/** @restregular/dsh-memory:~/.dsh/memory-vector/*.jsonl(按 scope 分文件)。 */
export function openVectorJsonlSource(logger: LoggerLike, refreshMs = 0): MemoryStore {
  const root = path.join(dshHome(), 'memory-vector');
  if (!isDir(root)) return emptyStore('@restregular/dsh-memory', logger, '未找到 memory-vector');
  const collect = (): Doc[] => {
    const files = walkFiles(root, { exts: ['.jsonl'], maxFiles: 200 }).filter(
      (f) => !/approvals\.jsonl$/i.test(f),
    );
    const docs: Doc[] = [];
    let vecHits = 0;
    for (const file of files) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const batch = readJsonlDocs(file, rel, 'memory-vector');
      /* 上游把向量落在同名的 .vec 边车里(<name>.jsonl → <name>.vec)。
       * 有就挂上:检索时拿它做稠密邻居扩展;没有就退回字符 n-gram,行为不变。
       * 边车身份(模型+维度)挂在 Doc.vecModel 上,不同模型之间绝不互相比较。 */
      const sidecar = readVecSidecar(file.replace(/\.jsonl$/i, '.vec'));
      if (sidecar) {
        for (const doc of batch) {
          if (!doc.id.startsWith(rel + '#')) continue;
          const vec = sidecar.byId.get(doc.id.slice(rel.length + 1));
          if (!vec) continue;
          doc.vec = vec;
          doc.vecModel = sidecar.model;
          vecHits += 1;
        }
        if (vecHits > 0) {
          logger.debug?.(
            '[recall-rebuild] memory-vector: ' + rel + ' 读到 ' + sidecar.model + ' 稠密向量 ' +
              sidecar.byId.size + ' 条',
          );
        }
      }
      docs.push(...batch);
    }
    return docs;
  };
  const docs = collect();
  if (docs.length === 0) return emptyStore('@restregular/dsh-memory', logger, 'jsonl 为空');
  return makeTextStore('@restregular/dsh-memory', docs, logger, { reload: collect, refreshMs });
}
