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

// 3) @restregular/dsh-memory:JSONL + 上游自带的 .vec 稠密边车
const vecDir = path.join(home, 'memory-vector');
fs.mkdirSync(vecDir, { recursive: true });
fs.writeFileSync(
  path.join(vecDir, 'global.jsonl'),
  [
    JSON.stringify({ id: 'v1', kind: 'rule', content: '提交前必须跑 typecheck', created_at: '2026-11-12' }),
    JSON.stringify({ id: 'v2', kind: 'global', content: '用户所在时区是 America/Los_Angeles', created_at: '2026-11-11' }),
    JSON.stringify({ id: 'v3', kind: 'rule', content: '流水线门禁规则', created_at: '2026-11-10' }),
  ].join('\n'),
  'utf8',
);
/* 边车格式与上游一致:首行 `#<model>\t<dims>\t<pooling>`,之后 `<id>\t<base64 float32>`。
 * v3 与 v1 的向量几乎同向(0.98/0.19),但正文与查询零字面重叠 —— 只有稠密通道
 * 能把它捞回来,于是这条断言恰好测的是「稠密通道真的接上了」。 */
function encodeVec(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}
fs.writeFileSync(
  path.join(vecDir, 'global.vec'),
  [
    '#bge-m3\t3\tcls',
    'v1\t' + encodeVec([1, 0, 0]),
    'v2\t' + encodeVec([0, 1, 0]),
    'v3\t' + encodeVec([0.98, 0.19, 0]),
  ].join('\n'),
  'utf8',
);
/* 反例:没有 `#` 身份头的老边车,整份不采信 —— 不知道模型身份就没法和正文对齐。
 * p1 的向量与 v1 完全相同,如果实现「见边车就用」,p1 会被当成 v1 的邻居捞进结果。 */
fs.writeFileSync(
  path.join(vecDir, 'project.jsonl'),
  JSON.stringify({ id: 'p1', kind: 'global', content: '无头边车的条目', created_at: '2026-11-09' }) + '\n',
  'utf8',
);
fs.writeFileSync(
  path.join(vecDir, 'project.vec'),
  ['p1\t' + encodeVec([1, 0, 0])].join('\n'),
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

// 6.5) dsh-auto-memory:纯 Markdown,_user/ 与 --<slug>--/ 两个作用域
const autoDir = path.join(home, 'memory');
const autoUserDir = path.join(autoDir, '_user');
const autoProjDir = path.join(autoDir, '--D-workspace--');
fs.mkdirSync(autoUserDir, { recursive: true });
fs.mkdirSync(autoProjDir, { recursive: true });
const fm = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n\n' + body + '\n';
fs.writeFileSync(
  path.join(autoUserDir, 'reply-style.md'),
  fm(
    { name: 'reply-style', description: '用户偏好中文回复,先给结论', type: 'user', title: '回复风格', keywords: '[中文, 结论]', created: 1790000000000, updated: 1790000000000 },
    '解释要短,不要复述问题。',
  ),
  'utf8',
);
fs.writeFileSync(
  path.join(autoUserDir, 'old-habit.md'),
  fm({ name: 'old-habit', description: '已经被新习惯取代的旧条目', type: 'feedback', status: 'superseded' }, '旧正文。'),
  'utf8',
);
fs.writeFileSync(
  path.join(autoUserDir, 'muted.md'),
  fm({ name: 'muted', description: '用户显式禁用的条目', type: 'feedback', disabled: 'true' }, '不该出现。'),
  'utf8',
);
fs.writeFileSync(
  path.join(autoUserDir, 'expired.md'),
  fm({ name: 'expired', description: '已过有效期', type: 'project', validUntil: 1000 }, '早过期了。'),
  'utf8',
);
fs.writeFileSync(
  path.join(autoProjDir, 'deploy.md'),
  fm(
    { name: 'deploy', description: '本工作区部署走蓝绿切换', type: 'project', title: '部署约定', keywords: '[deploy]' },
    '禁止直接热更。',
  ),
  'utf8',
);
// MEMORY.md 是派生索引、audit.jsonl 是审计日志:两者都不该被当成记忆
fs.writeFileSync(path.join(autoUserDir, 'MEMORY.md'), '- 用户偏好中文回复\n', 'utf8');
fs.writeFileSync(path.join(autoDir, 'audit.jsonl'), '{"op":"write"}\n', 'utf8');

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
check('探测到 auto-memory', present.includes('auto-memory'));
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
  { id: 'auto-memory', q: '中文回复', want: '中文回复' },
];
for (const c of cases) {
  const store = mod.openSource(c.id, ctx);
  const hits = store.ok ? store.search(c.q, 5) : [];
  const text = hits.map((h) => h.content).join(' | ');
  check(c.id + ' 检索命中 ' + c.q, store.ok && hits.length > 0 && text.includes(c.want), 'label=' + store.label);
  store.close();
}

/* auto-memory:frontmatter 的语义过滤(墓碑/禁用/过期)必须生效。 */
{
  const store = mod.openSource('auto-memory', ctx);
  const all = store.search('用户 记忆 部署 习惯 条目', 20).map((h) => h.content).join(' | ');
  check('auto-memory:读到用户级条目', all.includes('用户偏好中文回复'), 'hits=' + all);
  check('auto-memory:读到项目级条目', all.includes('本工作区部署走蓝绿切换'), 'hits=' + all);
  check('auto-memory:superseded 不召回', !all.includes('已经被新习惯取代'), 'hits=' + all);
  check('auto-memory:disabled 不召回', !all.includes('用户显式禁用的条目'), 'hits=' + all);
  check('auto-memory:过期条目不召回', !all.includes('已过有效期'), 'hits=' + all);
  check('auto-memory:MEMORY.md 索引不当记忆', !all.includes('用户偏好中文回复\n- '), 'hits=' + all);
  const hit = store.search('中文回复', 5)[0];
  check('auto-memory:时间戳取 frontmatter updated', !!hit && hit.timestampStr === '2026-09-21', hit ? hit.timestampStr : 'none');
  store.close();
}

/* 稠密边车解析器本身:身份头是硬门槛,不是可选装饰。 */
{
  const kit = await import('../dist/sources/kit.js');
  const good = kit.readVecSidecar(path.join(vecDir, 'global.vec'));
  check('边车:读出模型身份 bge-m3:3', !!good && good.model === 'bge-m3:3', good ? good.model : 'null');
  check('边车:向量条数 = 3', !!good && good.byId.size === 3, good ? String(good.byId.size) : 'null');
  check('边车:float32 解码正确', !!good && Math.abs((good.byId.get('v3') ?? [0])[0] - 0.98) < 1e-6);
  check('边车:无身份头整份拒绝', kit.readVecSidecar(path.join(vecDir, 'project.vec')) === null);
  check('边车:文件不存在返回 null', kit.readVecSidecar(path.join(vecDir, 'nope.vec')) === null);
}

/* 稠密边车:有身份头的才采信,且只做「邻居扩展」不做独立候选。 */
{
  const store = mod.openSource('memory-vector', ctx);
  const hits = store.search('typecheck', 5);
  const text = hits.map((h) => h.content).join(' | ');
  check('稠密边车:语义邻居被带进结果', text.includes('流水线门禁规则'), 'hits=' + text);
  check('稠密边车:无身份头的边车不采信', !text.includes('无头边车的条目'), 'hits=' + text);
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
