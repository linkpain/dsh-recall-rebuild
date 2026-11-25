/**
 * 文件系记忆插件(Markdown / JSON / JSONL)的适配器。
 *
 * 与 sqlite-sources.ts 同一思路:每个插件只描述「数据在哪、长什么样」,
 * 解析与检索全部复用 kit.ts 的原语。
 */
import * as path from 'node:path';
import {
  dshHome,
  userHome,
  isFile,
  isDir,
  walkFiles,
  readMarkdownDocs,
  readJsonDocs,
  readJsonlDocs,
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
export function openJipikaSource(logger: LoggerLike): MemoryStore {
  const root = path.join(dshHome(), 'memory', 'topics');
  const docs = collectMarkdown(root, 'jipika', { relPrefix: 'topics', maxFiles: 2000 });
  if (docs.length === 0) return emptyStore('@jipika/dsh-memory', logger, '未找到 topics 分片');
  return makeTextStore('@jipika/dsh-memory', docs, logger);
}

/** @furongjun1999/dsh-memory(灵枢):~/.dsh/.dsh-memory/data/mdcg 下的节点 Markdown。 */
export function openLingshuSource(logger: LoggerLike): MemoryStore {
  const roots = [
    process.env.MDCG_DATA_ROOT?.trim(),
    path.join(dshHome(), '.dsh-memory', 'data', 'mdcg'),
    path.join(userHome(), '.dsh-memory', 'data', 'mdcg'),
  ].filter((x): x is string => Boolean(x));
  const docs: Doc[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    // 节点散在各层子目录(contextual/、anchor/ 等),跳过索引与预热缓存目录
    docs.push(...collectMarkdown(root, 'lingshu', { maxFiles: 4000, skipDirs: ['_hot', '_index', '_trash', 'archive'] }));
    if (docs.length > 0) break;
  }
  if (docs.length === 0) return emptyStore('@furongjun1999/dsh-memory', logger, '未找到 mdcg 节点');
  return makeTextStore('@furongjun1999/dsh-memory', docs, logger);
}

/** dsh-mnemon:~/.mnemon/runtime/{MEMORY.md,USER.md} + ~/.mnemon/documents/active/*.md。 */
export function openMnemonSource(logger: LoggerLike): MemoryStore {
  const root = path.join(userHome(), '.mnemon');
  const docs: Doc[] = [];
  for (const name of ['MEMORY.md', 'USER.md']) {
    const file = path.join(root, 'runtime', name);
    if (isFile(file)) docs.push(...readMarkdownDocs(file, 'runtime/' + name, 'mnemon'));
  }
  docs.push(...collectMarkdown(path.join(root, 'documents', 'active'), 'mnemon', { relPrefix: 'documents' }));
  if (docs.length === 0) return emptyStore('dsh-mnemon', logger, '未找到 runtime/documents');
  return makeTextStore('dsh-mnemon', docs, logger);
}

/** dsh-longterm-memory:Obsidian 兼容 vault(vaultPath 由用户配置,这里探测常见位置)。 */
export function openLongtermSource(cwd: string, logger: LoggerLike): MemoryStore {
  const candidates = [
    process.env.DSH_LONGTERM_VAULT?.trim(),
    path.join(cwd, '.dsh-longterm-memory'),
    path.join(dshHome(), 'longterm-memory'),
    path.join(dshHome(), 'vault'),
    path.join(userHome(), 'Memory', 'ObsidianVault'),
  ].filter((x): x is string => Boolean(x));
  for (const root of candidates) {
    if (!isDir(root)) continue;
    const docs = collectMarkdown(root, 'longterm', { maxFiles: 3000, skipDirs: ['.obsidian', '.trash'] });
    if (docs.length > 0) return makeTextStore('dsh-longterm-memory', docs, logger);
  }
  return emptyStore('dsh-longterm-memory', logger, '未配置 vaultPath');
}

/** dsh-memory-hub:~/.dsh/memory-hub/{knowledge,records,pending} 下的 Markdown 记录。 */
export function openHubSource(logger: LoggerLike): MemoryStore {
  const root = path.join(dshHome(), 'memory-hub');
  const docs: Doc[] = [];
  for (const sub of ['knowledge', 'records', 'pending']) {
    docs.push(...collectMarkdown(path.join(root, sub), 'hub', { relPrefix: sub, maxFiles: 2000 }));
  }
  if (docs.length === 0) return emptyStore('dsh-memory-hub', logger, '未找到 knowledge/records');
  return makeTextStore('dsh-memory-hub', docs, logger);
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
export function openMemoryEngineSource(logger: LoggerLike): MemoryStore {
  const dir = path.join(dshHome(), 'memory-engine');
  const docs = collectJson(
    [
      { file: path.join(dir, 'memories.json'), rel: 'memories.json' },
      { file: path.join(dir, 'archive.json'), rel: 'archive.json' },
    ],
    'memory-engine',
  );
  if (docs.length === 0) return emptyStore('dsh-memory-engine', logger, '未找到 memories.json');
  return makeTextStore('dsh-memory-engine', docs, logger);
}

/** dsh-memory-tiers:<DSH_HOME>/storages/memory 的六层文件(L1/L2/L3/DL1/DL2/DL3)。 */
export function openMemoryTiersSource(logger: LoggerLike): MemoryStore {
  const dir = path.join(dshHome(), 'storages', 'memory');
  const layers = ['L1.json', 'L2.json', 'L3.json', 'DL1.json', 'DL2.json', 'DL3.json'];
  const docs = collectJson(
    layers.map((name) => ({ file: path.join(dir, name), rel: name.replace('.json', '') })),
    'tiers',
  );
  if (docs.length === 0) return emptyStore('dsh-memory-tiers', logger, '未找到六层记忆文件');
  return makeTextStore('dsh-memory-tiers', docs, logger);
}

/** @restregular/dsh-memory:~/.dsh/memory-vector/*.jsonl(按 scope 分文件)。 */
export function openVectorJsonlSource(logger: LoggerLike): MemoryStore {
  const root = path.join(dshHome(), 'memory-vector');
  if (!isDir(root)) return emptyStore('@restregular/dsh-memory', logger, '未找到 memory-vector');
  const files = walkFiles(root, { exts: ['.jsonl'], maxFiles: 200 }).filter(
    (f) => !/approvals\.jsonl$/i.test(f),
  );
  const docs: Doc[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    docs.push(...readJsonlDocs(file, rel, 'memory-vector'));
  }
  if (docs.length === 0) return emptyStore('@restregular/dsh-memory', logger, 'jsonl 为空');
  return makeTextStore('@restregular/dsh-memory', docs, logger);
}
