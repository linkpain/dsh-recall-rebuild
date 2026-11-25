/**
 * 记忆源适配层冒烟测试:在临时 DSH_HOME 里造出各插件的真实落盘形态,
 * 验证「探测 → 打开 → 检索」全链路,不依赖本机装没装这些插件。
 *
 * 跑法:npm run build && node scripts/verify-sources.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-sources-'));
const home = path.join(root, 'dsh');
const fakeUserHome = path.join(root, 'user');
const cwd = path.join(root, 'workspace');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(fakeUserHome, { recursive: true });
process.env.DSH_HOME = home;
// 隔离用户级目录(~/.mnemon、~/.deepseek-harness):否则测试会读到本机真实记忆
process.env.USERPROFILE = fakeUserHome;
process.env.HOME = fakeUserHome;

const logger = {
  debug() {},
  info() {},
  warn() {},
};

/* ── 造数据 ─────────────────────────────────────────────── */

// 1) dsh-loci:SQLite,表 memory
const lociDir = path.join(home, 'memory', 'loci');
fs.mkdirSync(lociDir, { recursive: true });
let lociOk = false;
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(lociDir, 'memory.db'));
  db.exec(
    'CREATE TABLE memory (ord INTEGER PRIMARY KEY, id TEXT, kind TEXT, scope TEXT, title TEXT, body TEXT, tags TEXT, status TEXT, recorded_at TEXT)',
  );
  const ins = db.prepare('INSERT INTO memory (id, kind, scope, title, body, tags, status, recorded_at) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('m1', 'semantic', 'global', '部署约定', '生产环境部署走蓝绿切换,禁止直接热更', 'deploy,ops', 'verified', '2026-11-01');
  ins.run('m2', 'episodic', 'workspace', '踩坑记录', 'SQLite 只读打开时 WAL 模式需要目录可写', 'sqlite', 'verified', '2026-10-20');
  ins.run('m3', 'rule', 'global', '已废弃', '这条已经作废', 'old', 'superseded', '2026-09-01');
  db.close();
  lociOk = true;
} catch (err) {
  console.log('  skip dsh-loci 造数(node:sqlite 不可用):' + err.message);
}

// 2) dsh-memory-tiers:六层 JSON
const tiersDir = path.join(home, 'storages', 'memory');
fs.mkdirSync(tiersDir, { recursive: true });
fs.writeFileSync(
  path.join(tiersDir, 'L1.json'),
  JSON.stringify({ items: [{ id: 't1', content: '用户偏好中文回复,代码注释也用中文', created_at: '2026-11-10' }] }),
  'utf8',
);
fs.writeFileSync(
  path.join(tiersDir, 'L2.json'),
  JSON.stringify({ items: [{ id: 't2', content: '这个仓库用 pnpm 而不是 npm', created_at: '2026-11-05' }] }),
  'utf8',
);

// 3) @restregular/dsh-memory:JSONL
const vecDir = path.join(home, 'memory-vector');
fs.mkdirSync(vecDir, { recursive: true });
fs.writeFileSync(
  path.join(vecDir, 'global.jsonl'),
  [
    JSON.stringify({ id: 'v1', kind: 'rule', content: '提交前必须跑 typecheck', created_at: '2026-11-12' }),
    JSON.stringify({ id: 'v2', kind: 'global', content: '用户所在时区是 America/Los_Angeles', created_at: '2026-11-11' }),
  ].join('\n'),
  'utf8',
);

// 4) @jipika/dsh-memory:topics Markdown
const topicsDir = path.join(home, 'memory', 'topics');
fs.mkdirSync(topicsDir, { recursive: true });
fs.writeFileSync(
  path.join(topicsDir, '构建.md'),
  '# 构建\n\n- [2026-11-08] 构建产物输出到 dist,不提交\n- [2026-11-09] 发布前先 npm run test:all\n',
  'utf8',
);

// 5) dsh-memory-hub:knowledge Markdown
const hubDir = path.join(home, 'memory-hub', 'knowledge');
fs.mkdirSync(hubDir, { recursive: true });
fs.writeFileSync(
  path.join(hubDir, 'note.md'),
  '---\ntitle: 数据库选型\ntags: [db]\nupdated_at: 2026-11-02\n---\n\n- 记忆插件统一用 SQLite 落盘\n- 远端 Provider 走 HTTP,不塞进本地库\n',
  'utf8',
);

// 6) dsh-memory-engine:memories.json
const engDir = path.join(home, 'memory-engine');
fs.mkdirSync(engDir, { recursive: true });
fs.writeFileSync(
  path.join(engDir, 'memories.json'),
  JSON.stringify([
    { id: 'e1', content: '用户讨厌冗长的解释,先给结论', created_at: '2026-11-07' },
    { id: 'e2', content: '插件发布用 npm publish --access public', created_at: '2026-11-06' },
  ]),
  'utf8',
);

// 7) 工作区级 palace
const wsPalace = path.join(cwd, '.deepseek-harness');
fs.mkdirSync(wsPalace, { recursive: true });
fs.writeFileSync(path.join(wsPalace, 'MEMORY.md'), '## 工作区约定\n\n- 这个工作区只跑测试,不改源码\n', 'utf8');

/* ── 跑适配层 ───────────────────────────────────────────── */

const mod = await import('../dist/sources/index.js');

console.log('\n[sqlite] node:sqlite 可用性');
check('sqliteAvailable() 与造数结果一致', mod.sqliteAvailable() === lociOk, String(mod.sqliteAvailable()));

const ctx = { dataDir: '', cwd, logger };
const described = mod.describeSources(ctx);
const present = described.filter((d) => d.present).map((d) => d.id);
console.log('\n[detect] 识别到的源: ' + present.join(', '));
check('探测到 tiers', present.includes('tiers'));
check('探测到 memory-vector', present.includes('memory-vector'));
check('探测到 jipika', present.includes('jipika'));
check('探测到 hub', present.includes('hub'));
check('探测到 memory-engine', present.includes('memory-engine'));
check('探测到 palace', present.includes('palace'));
if (lociOk) check('探测到 loci', present.includes('loci'));
check('未误报 prime', !present.includes('prime'));

console.log('\n[open] 逐源打开 + 检索');
const cases = [
  { id: 'tiers', q: 'pnpm', want: 'pnpm' },
  { id: 'memory-vector', q: 'typecheck', want: 'typecheck' },
  { id: 'jipika', q: '构建产物', want: '构建产物' },
  { id: 'hub', q: 'SQLite', want: 'SQLite' },
  { id: 'memory-engine', q: 'npm publish', want: 'npm publish' },
  { id: 'palace', q: '工作区', want: '工作区' },
];
for (const c of cases) {
  const store = mod.openSource(c.id, ctx);
  const hits = store.ok ? store.search(c.q, 5) : [];
  const text = hits.map((h) => h.content).join(' | ');
  check(c.id + ' 检索命中 ' + c.q, store.ok && hits.length > 0 && text.includes(c.want), 'label=' + store.label);
  store.close();
}

if (lociOk) {
  const store = mod.openSource('loci', ctx);
  const hits = store.search('蓝绿部署', 5);
  check('loci 检索命中 蓝绿部署', store.ok && hits.some((h) => h.content.includes('蓝绿')));
  const tomb = store.search('这条已经作废', 5);
  check('loci 过滤 superseded 墓碑', tomb.length === 0, JSON.stringify(tomb.map((t) => t.content)));
  store.close();
}

console.log('\n[auto] 自动选择');
const auto = mod.openSource('auto', ctx);
check('auto 打开成功', auto.ok, auto.label);
const autoHits = auto.search('pnpm typecheck 构建', 8);
check('auto 能检索到内容', autoHits.length > 0, 'hits=' + autoHits.length);
console.log('  auto label = ' + auto.label);
auto.close();

console.log('\n[fallback] 未知 id / 空目录');
const unknown = mod.openSource('not-a-source', ctx);
check('未知 id 回退 auto 而非抛错', typeof unknown.label === 'string');
// 静默回退会让用户以为「只读某个源」,实际在融合全部源;label 必须留下痕迹
check('未知 id 在 label 里显式标注', unknown.label.includes('not-a-source'), unknown.label);
unknown.close();

const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-empty-'));
const emptyHome = path.join(emptyRoot, 'dsh');
const emptyUser = path.join(emptyRoot, 'user');
fs.mkdirSync(emptyHome, { recursive: true });
fs.mkdirSync(emptyUser, { recursive: true });
process.env.DSH_HOME = emptyHome;
process.env.USERPROFILE = emptyUser;
process.env.HOME = emptyUser;
const empty = mod.openSource('auto', { dataDir: '', cwd: emptyRoot, logger });
check('空环境返回 ok:false 且不抛错', empty.ok === false, empty.label);
empty.close();

// Windows 上 SQLite 句柄释放略滞后,清理失败不影响测试结论
for (const dir of [root, emptyRoot]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录残留交给系统清理 */
  }
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
