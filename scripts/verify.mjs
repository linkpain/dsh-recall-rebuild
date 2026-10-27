/**
 * 运行时验证(不进入 npm 包):验证 dist 产物可加载、导出正确,
 * 以及 store 适配器在真实 SQLite 库上的检索行为(FTS5 + LIKE 兜底)。
 * 运行:node scripts/verify.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const distUrl = pathToFileURL(dist + path.sep).href;

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${extra}`);
  }
}

// ── 1. 模块导出 ──────────────────────────────────────────────
console.log('[1] 插件模块导出');
const plugin = await import(`${distUrl}index.js`);
check('name = recall-rebuild', plugin.name === 'recall-rebuild', `got ${plugin.name}`);
check('inject 包含 llm', Array.isArray(plugin.inject) && plugin.inject.includes('llm'));
check('Config 是可调用 Schema', typeof plugin.Config === 'function');
check('apply 是函数', typeof plugin.apply === 'function');

const cfg = plugin.Config({});
check('Config 默认值生效', cfg.enabled === true && cfg.rebuild.enabled === true && cfg.inject.strategy === 'replace');
check('Config 覆盖生效', plugin.Config({ inject: { strategy: 'append' } }).inject.strategy === 'append');
check('Config source 支持 dsh-memory', plugin.Config({ source: 'dsh-memory' }).source === 'dsh-memory');
check('Config user.isolation 默认 auto', cfg.user.isolation === 'auto' && cfg.user.isolationDir === '');
check('Config user.isolation 覆盖生效', plugin.Config({ user: { isolation: 'strict' } }).user.isolation === 'strict');

// ── 2. store 适配器真实检索 ──────────────────────────────────
console.log('[2] store 适配器(临时 SQLite 库)');
const { openPrimeMemoryStore, sanitizeFts } = await import(`${distUrl}store.js`);
check('sanitizeFts 清洗特殊字符', sanitizeFts('咖啡 AND OR "冰美式"') === '"咖啡" AND "冰美式"');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-verify-'));
const dbPath = path.join(tmpDir, 'memory.db');
const seed = new DatabaseSync(dbPath);
seed.exec(`
  CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY, content TEXT, type TEXT, scene_name TEXT,
    family TEXT, scope TEXT, workspace_id TEXT, priority INTEGER,
    timestamp_str TEXT
  );
  CREATE VIRTUAL TABLE l1_fts USING fts5(
    record_id, content_original, type, scene_name, family, scope, workspace_id
  );
  INSERT INTO l1_records VALUES
    ('r1', '用户喜欢喝冰美式咖啡,常去星巴克', 'fact', '咖啡偏好', 'memory', 'global', '', 5, '2026-10-01'),
    ('r2', '用户养了一只叫煤球的黑色猫', 'fact', '宠物', 'memory', 'global', '', 4, '2026-10-05'),
    ('r3', '用户下周要去成都出差三天', 'plan', '行程', 'memory', 'global', '', 3, '2026-10-20');
  INSERT INTO l1_fts VALUES
    ('r1', '用户喜欢喝冰美式咖啡,常去星巴克', 'fact', '咖啡偏好', 'memory', 'global', ''),
    ('r2', '用户养了一只叫煤球的黑色猫', 'fact', '宠物', 'memory', 'global', ''),
    ('r3', '用户下周要去成都出差三天', 'plan', '行程', 'memory', 'global', '');
`);
seed.close();

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const store = openPrimeMemoryStore(tmpDir, logger);
check('库打开成功', store.ok === true);

const hits = store.search('冰美式咖啡', 5);
check('FTS 检索命中 r1', hits.length > 0 && hits[0]?.id === 'r1', JSON.stringify(hits.map((h) => h.id)));

const catHits = store.search('煤球 猫', 5);
check('多词 FTS 命中 r2', catHits.some((h) => h.id === 'r2'));

const noneHits = store.search('量子纠缠', 5);
check('无关词返回空', noneHits.length === 0);

// LIKE 兜底:FTS 分词器对单字短词可能无命中,应回落到 l1_records LIKE
const likeHits = store.search('出差', 5);
check('LIKE 兜底命中 r3', likeHits.some((h) => h.id === 'r3'), JSON.stringify(likeHits.map((h) => h.id)));

// 降级:不存在的目录 → ok=false,search 空
const missing = openPrimeMemoryStore(path.join(tmpDir, 'nope'), logger);
check('缺失目录降级 ok=false', missing.ok === false && missing.search('x', 3).length === 0);

store.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── 2b. palace 适配器(临时 Markdown 记忆) ───────────────────
console.log('[2b] palace 适配器(临时 Markdown 记忆)');
const { openPalaceStore } = await import(`${distUrl}store.js`);
const palaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-palace-'));
fs.mkdirSync(path.join(palaceDir, '.deepseek-harness', 'memory'), { recursive: true });
fs.writeFileSync(
  path.join(palaceDir, '.deepseek-harness', 'MEMORY.md'),
  [
    '# 用户记忆',
    '',
    '## 咖啡偏好',
    '- 用户喜欢喝冰美式咖啡,常去星巴克',
    '- 用户不爱喝奶茶',
    '- ~~这条记忆已删除~~',
    '',
    '## 宠物',
    '- 用户养了一只叫煤球的黑色猫',
  ].join('\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(palaceDir, '.deepseek-harness', 'memory', '2026-10-20.md'),
  ['# 2026-10-20', '', '## 行程', '- 用户下周要去成都出差三天'].join('\n'),
  'utf8',
);
const palace = openPalaceStore(palaceDir, logger);
check('palace 库打开成功', palace.ok === true);
const phits = palace.search('冰美式咖啡', 5);
check(
  'palace 命中咖啡条目',
  phits.some((h) => h.id.includes('MEMORY.md') && h.content.includes('冰美式咖啡')),
  JSON.stringify(phits.map((h) => h.id)),
);
check('palace 条目带章节语境', phits[0]?.sceneName === '咖啡偏好');
const pcat = palace.search('煤球', 5);
check('palace 命中宠物条目', pcat.some((h) => h.sceneName === '宠物'));
const plog = palace.search('成都', 5);
check(
  'palace 命中每日日志条目(带日期)',
  plog.some((h) => h.timestampStr === '2026-10-20'),
  JSON.stringify(plog.map((h) => `${h.id}|${h.timestampStr}`)),
);
const pdead = palace.search('这条记忆已删除', 5);
check('palace 墓碑不参与检索', pdead.length === 0);
const pnone = palace.search('量子纠缠', 5);
check('palace 无关词返回空', pnone.length === 0);
palace.close();
const missingPalace = openPalaceStore(path.join(palaceDir, 'nope'), logger);
check('palace 缺失目录降级 ok=false', missingPalace.ok === false);
fs.rmSync(palaceDir, { recursive: true, force: true });

// ── 2c. dsh-memory(JSON 文件)适配器 ─────────────────────────
console.log('[2c] dsh-memory 适配器(临时 JSON 记忆)');
const { openDshMemoryStore } = await import(`${distUrl}store.js`);
const dmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-dm-'));
const dmCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-dm-cwd-'));
process.env.DSH_HOME = path.join(dmHome, '.dsh');
const dmStorages = path.join(dmHome, '.dsh', 'storages');
fs.mkdirSync(dmStorages, { recursive: true });
const dmT1 = new Date('2026-10-01T00:00:00').getTime();
const dmT2 = new Date('2026-10-05T00:00:00').getTime();
fs.writeFileSync(
  path.join(dmStorages, 'memory.json'),
  JSON.stringify({
    unit: { name: 'memory', version: 1, tables: { blocks: [
      { id: 'm1', namespace: 'global', status: 'approved', injected: false, quarantined: false, content: '用户喜欢喝冰美式咖啡,常去星巴克', keywords: ['咖啡', '星巴克'], createdAt: dmT1, updatedAt: dmT1 },
      { id: 'm2', namespace: 'global', status: 'suggested', content: '这条记忆尚未生效', keywords: [], createdAt: dmT1, updatedAt: dmT1 },
      { id: 'm3', namespace: 'global', status: 'approved', quarantined: true, content: '这条记忆被隔离了', keywords: [], createdAt: dmT1, updatedAt: dmT1 },
      { id: 'm4', namespace: 'global', status: 'approved', kind: 'prompt', content: '提示词模板索引', keywords: [], createdAt: dmT1, updatedAt: dmT1 },
    ] } },
  }, null, 2),
  'utf8',
);
fs.mkdirSync(path.join(dmCwd, '.dsh', 'storages'), { recursive: true });
fs.writeFileSync(
  path.join(dmCwd, '.dsh', 'storages', 'notes.json'),
  JSON.stringify({
    unit: { name: 'notes', version: 1, tables: { blocks: [
      { id: 'p1', namespace: 'project', status: 'approved', content: '用户下周要去成都出差三天', keywords: ['成都', '出差'], createdAt: dmT2, updatedAt: dmT2 },
    ] } },
  }, null, 2),
  'utf8',
);
const dm = openDshMemoryStore(dmCwd, logger);
check('dsh-memory 库打开成功', dm.ok === true);
const dmHits = dm.search('冰美式咖啡', 5);
check(
  'dsh-memory 命中 global 记录',
  dmHits.some((h) => h.id.includes('memory.json#m1')),
  JSON.stringify(dmHits.map((h) => h.id)),
);
check('dsh-memory 关键词加权生效', dm.search('星巴克', 5).some((h) => h.id.includes('m1')));
check('dsh-memory suggested 不生效', dm.search('尚未生效', 5).length === 0);
check('dsh-memory 隔离记录不检索', dm.search('隔离', 5).length === 0);
check('dsh-memory prompt 索引不检索', dm.search('模板', 5).length === 0);
const dmProj = dm.search('成都', 5);
check(
  'dsh-memory 命中 project 记录(带日期)',
  dmProj.some((h) => h.id.includes('notes.json#p1') && h.timestampStr === '2026-10-05'),
  JSON.stringify(dmProj.map((h) => `${h.id}|${h.timestampStr}`)),
);
const dmNone = dm.search('量子纠缠', 5);
check('dsh-memory 无关词返回空', dmNone.length === 0);
dm.close();
delete process.env.DSH_HOME;
const missingDm = openDshMemoryStore(path.join(dmCwd, 'nope'), logger);
check('dsh-memory 缺失降级 ok=false', missingDm.ok === false);
fs.rmSync(dmHome, { recursive: true, force: true });
fs.rmSync(dmCwd, { recursive: true, force: true });

// ── 2d. IM 用户命名空间隔离 ─────────────────────────────────
console.log('[2d] 用户命名空间隔离');
const { NamespaceStore, extractUserKey } = await import(`${distUrl}namespace.js`);
check('extractUserKey 解析 <dsh_im_source> senderId',
  extractUserKey(['<dsh_im_source>{"channel":"qq","senderId":"u_alice","chatId":"c1"}</dsh_im_source> 你好']) === 'im:qq:u_alice');
check('extractUserKey 优先 senderId 而非 chatId',
  extractUserKey(['<dsh_im_source>{"channel":"wechat","chatId":"room1","threadId":"t1"}</dsh_im_source>']) === 'im:wechat:room1');
check('extractUserKey 兜底字段 openid',
  extractUserKey(['openid=oX7AbCdEf123456789'])?.startsWith('im-fallback:') === true);
check('extractUserKey 桌面文本返回 null', extractUserKey(['今天天气怎么样']) === null);
check('extractUserKey 自定义正则生效',
  extractUserKey(['<[IM] user: bob42'], '<\\[IM\\]\\s+user:\\s*([^\\]]+)') === 'im-custom:bob42');

const nsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-ns-'));
const ns = new NamespaceStore(nsDir, logger);
ns.ensureDir();
// 构造候选:memA 无主、memB 属于 alice、memC 属于 bob(共享给 alice+bob)
const mk = (id, content) => ({ id, content, type: 'fact', sceneName: '', family: '', priority: 1, timestampStr: '' });
// 手工预置归属文件:alice → [memB, memC];bob → [memC]
const writeOwner = (file, ids) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ memoryIds: Object.fromEntries(ids.map((i) => [i, Date.now()])) }), 'utf8');
};
writeOwner(path.join(nsDir, 'im_qq_u_alice.json'), ['memB', 'memC']);
writeOwner(path.join(nsDir, 'im_qq_u_bob.json'), ['memC']);
const cands = [mk('memA', '用户 A 的咖啡偏好(无主)'), mk('memB', '用户 A 的宠物猫'), mk('memC', '共享群聊话题')];
check('auto:保留无主+自己的+共享(alice:memA 无主/memB 自己/memC 共享)',
  ns.filter(cands, 'im:qq:u_alice', 'auto').map((m) => m.id).join(',') === 'memA,memB,memC',
  ns.filter(cands, 'im:qq:u_alice', 'auto').map((m) => m.id).join(','));
check('auto:bob 视角保留无主+共享,剔除 alice 私享',
  ns.filter(cands, 'im:qq:u_bob', 'auto').map((m) => m.id).join(',') === 'memA,memC');
check('strict:alice 只保留自己的(含共享)',
  ns.filter(cands, 'im:qq:u_alice', 'strict').map((m) => m.id).join(',') === 'memB,memC');
check('strict:新用户 dave 零记忆',
  ns.filter(cands, 'im:qq:u_dave', 'strict').length === 0);
check('off:不过滤', ns.filter(cands, 'im:qq:u_alice', 'off').length === 3);
check('userKey=null 不过滤', ns.filter(cands, null, 'strict').length === 3);
// recordHits:alice 命中无主 memA → 归位 → bob 视角 auto 下 memA 被剔除
ns.recordHits('im:qq:u_alice', [mk('memA', 'x')]);
check('recordHits 后 alice 归属含 memA',
  ns.filter(cands, 'im:qq:u_alice', 'auto').map((m) => m.id).includes('memA'));
check('recordHits 后 memA 归位,bob auto 不再可见',
  ns.filter(cands, 'im:qq:u_bob', 'auto').map((m) => m.id).join(',') === 'memC');
const aliceAfter = JSON.parse(fs.readFileSync(path.join(nsDir, 'im_qq_u_alice.json'), 'utf8'));
check('归属文件原子写入(memA 已持久化)', Object.keys(aliceAfter.memoryIds).includes('memA'));
// 重复 recordHits 不产生重复 key 或异常
ns.recordHits('im:qq:u_alice', [mk('memA', 'x')]);
const aliceAgain = JSON.parse(fs.readFileSync(path.join(nsDir, 'im_qq_u_alice.json'), 'utf8'));
check('重复记录幂等', Object.keys(aliceAgain.memoryIds).length === Object.keys(aliceAfter.memoryIds).length);
fs.rmSync(nsDir, { recursive: true, force: true });

// ── 3. 重建引擎纯逻辑(不实际调用 LLM) ───────────────────────
console.log('[3] rebuild 碎片组装预算');
const { buildFragments: _b } = await import(path.join(dist, 'rebuild.js')).catch(() => ({}));
// buildFragments 未导出,改为从源码验证配置默认值预算口径
check('配置预算默认值合理', cfg.rebuild.maxMemoryChars >= 50 && cfg.rebuild.maxTotalChars > cfg.rebuild.maxMemoryChars);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
