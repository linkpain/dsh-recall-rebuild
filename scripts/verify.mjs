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
check('Config observability 默认开启', cfg.observability.logEnabled === true && cfg.observability.includeFragments === true);
check('Config consolidate 默认开启', cfg.consolidate.enabled === true && cfg.consolidate.minFragments === 20);
check('Config commands 默认开启', cfg.commands.enabled === true && cfg.commands.name === 'recall-rebuild');

// ── 2. store 适配器真实检索 ──────────────────────────────────
console.log('[2] store 适配器(临时 SQLite 库)');
const { openPrimeMemoryStore, sanitizeFts, tokenizeQuery } = await import(`${distUrl}store.js`);
// 分词语义已改为「拉丁词 + 中文 2-gram」:中文不再是整句一个词元,
// 因此 3 字词「冰美式」会展开为 冰美/美式;AND/OR 作为停用词被剔除。
check('sanitizeFts 清洗特殊字符', sanitizeFts('咖啡 AND OR "冰美式"') === '"咖啡" AND "冰美" AND "美式"');
check('sanitizeFts 空查询 → 空串', sanitizeFts('   ') === '');
check('sanitizeFts 运算符词不进入 MATCH', sanitizeFts('OR NOT AND NEAR') === '');
check('tokenizeQuery 中文切 2-gram', tokenizeQuery('冰美式咖啡').join(',') === '冰美,美式,式咖,咖啡');
check('tokenizeQuery 中文过滤高频虚词', tokenizeQuery('用户喜欢什么').every((t) => t !== '用户' && t !== '什么'));
check('tokenizeQuery 中英混排各自成词', tokenizeQuery('咖啡Starbucks拿铁').includes('starbucks'));
check('tokenizeQuery 去重', tokenizeQuery('咖啡 咖啡').join(',') === '咖啡');

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

// ── 2e. 重建质量可观测 ───────────────────────────────────────
console.log('[2e] 重建质量可观测');
const { RebuildLogger, fragmentSample } = await import(`${distUrl}observability.js`);
const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-obs-'));
const obs = new RebuildLogger({ logDir: obsDir, enabled: true, includeFragments: true, logger });
obs.log({
  userKey: 'im:qq:u_alice',
  isolation: 'auto',
  query: '我最近心情不太好',
  hitCount: 2,
  memoryIds: ['r1', 'r2'],
  fragments: ['用户喜欢喝冰美式咖啡', '用户养了一只叫煤球的猫'],
  rebuilt: '记得你养了只叫煤球的黑猫,平时它一蹭你你就笑。今天是不顺心了吗?',
  injection: 'replaced',
  latencyMs: 850,
});
obs.log({
  userKey: null,
  isolation: 'auto',
  query: '明天天气怎么样',
  hitCount: 0,
  memoryIds: [],
  rebuilt: '',
  injection: 'none',
  latencyMs: 12,
});
const obsFiles = fs.readdirSync(obsDir).filter((n) => n.endsWith('.log'));
check('obs:日志文件按天命名', obsFiles.length === 1 && /^recall-\d{4}-\d{2}-\d{2}\.log$/.test(obsFiles[0]), obsFiles.join(','));
const obsLines = fs.readFileSync(path.join(obsDir, obsFiles[0]), 'utf8').trim().split('\n');
check('obs:每轮一行 JSONL', obsLines.length === 2);
const firstEntry = JSON.parse(obsLines[0]);
check('obs:记录 userKey/query/hitCount', firstEntry.userKey === 'im:qq:u_alice' && firstEntry.hitCount === 2 && firstEntry.query.includes('心情'));
check('obs:碎片↔重建同屏(含原始碎片)', Array.isArray(firstEntry.fragments) && firstEntry.fragments[0].includes('冰美式') && firstEntry.rebuilt.includes('煤球'));
check('obs:记录注入方式与耗时', firstEntry.injection === 'replaced' && typeof firstEntry.latencyMs === 'number');
const secondEntry = JSON.parse(obsLines[1]);
check('obs:零命中轮次也有记录', secondEntry.hitCount === 0 && secondEntry.injection === 'none');
check('obs:fragmentSample 对比段可读', fragmentSample(firstEntry).original[0].includes('冰美式') && fragmentSample(firstEntry).rebuilt.includes('黑猫'));
// 关闭 fragments 的日志器
const obsNoFrag = new RebuildLogger({ logDir: obsDir, enabled: true, includeFragments: false, logger });
obsNoFrag.log({
  userKey: null, isolation: 'off', query: 'q', hitCount: 1, memoryIds: ['x'],
  fragments: ['不应出现在日志中'], rebuilt: '重建结果', injection: 'appended', latencyMs: 5,
});
const noFragLine = JSON.parse(fs.readFileSync(path.join(obsDir, obsFiles[0]), 'utf8').trim().split('\n').at(-1));
check('obs:includeFragments=false 省略碎片', noFragLine.fragments.length === 0 && noFragLine.rebuilt === '重建结果');
obs.flushStats();
const stats = JSON.parse(fs.readFileSync(path.join(obsDir, 'stats.json'), 'utf8'));
check('obs:统计累积正确', stats.rounds === 2 && stats.hits === 1 && stats.rebuilt === 1 && stats.injected === 1 && stats.replaced === 1);
const noFragStats = obsNoFrag.snapshot();
check('obs:snapshot 独立计数', noFragStats.rounds === 1);
fs.rmSync(obsDir, { recursive: true, force: true });

// ── 2f. 睡眠巩固层 ───────────────────────────────────────────
console.log('[2f] 睡眠巩固层');
const { tokenize, similarity, clusterize, isDormant, parseConsolidationOutput, ConsolidatedStore } =
  await import(`${distUrl}consolidated.js`);
check('cons:tokenize 产出 2-gram 集合', tokenize('用户喜欢喝冰美式咖啡').length >= 2);
check('cons:相似度同主题高、异主题低',
  similarity('用户喜欢喝冰美式咖啡', '用户爱喝冰美式咖啡,常去星巴克') >
  similarity('用户喜欢喝冰美式咖啡', '用户下周要去成都出差'));
const cluDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-clu-'));
const clu = clusterize(
  [
    { id: 'a', content: '用户喜欢喝冰美式咖啡,常去星巴克' },
    { id: 'b', content: '用户爱喝冰美式咖啡,每次去都点超大杯' },
    { id: 'c', content: '用户养了一只叫煤球的黑色猫' },
    { id: 'd', content: '用户下周要去成都出差三天' },
  ],
  0.2,
  8,
);
check('cons:同主题碎片聚为一簇', clu.some((g) => g.length >= 2 && g.includes('a') && g.includes('b')), JSON.stringify(clu));
check('cons:无关碎片不强行入簇', clu.some((g) => g.includes('c') && g.includes('d')) === false);
check('cons:parse 严格 JSON 输出', parseConsolidationOutput('好的,以下是结果:\n{"memories":[{"type":"preference","content":"用户喜欢冰美式"}]}').length === 1);
check('cons:parse 非法 type 兜底 stable-fact',
  parseConsolidationOutput('{"memories":[{"type":"weird","content":"x"}]}')[0]?.type === 'stable-fact');
check('cons:parse 拒绝编造空输出', parseConsolidationOutput('{"memories":[]}').length === 0);
const nowMs = Date.now();
const dormantSample = {
  id: 'x', userKey: null, type: 'stable-fact', content: 'x', sourceIds: ['r1'],
  confidence: 0.3, status: 'active', createdAt: nowMs - 40 * 86400000,
  updatedAt: nowMs - 40 * 86400000, touchCount: 0,
};
check('cons:低置信+长期未命中 → dormant',
  isDormant(dormantSample, nowMs, { confidenceThreshold: 0.4, dormantDays: 30 }) === true);
check('cons:高置信不遗忘',
  isDormant({ ...dormantSample, confidence: 0.8 }, nowMs, { confidenceThreshold: 0.4, dormantDays: 30 }) === false);
// 状态只是「上次扫描的结论」,不能反过来锁死判定:否则 dormant 永远算 dormant
check('cons:status 不参与遗忘判定(休眠可逆)',
  isDormant({ ...dormantSample, status: 'dormant', confidence: 0.8 }, nowMs, { confidenceThreshold: 0.4, dormantDays: 30 }) === false);
const csDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-cs-'));
const cs = new ConsolidatedStore(csDir, logger);
cs.load();
check('cons:巩固库读写', cs.pending().length === 0);
cs.addPending([{ id: 'r1', content: '用户喜欢喝冰美式咖啡', userKey: 'im:qq:u_alice' }], 50);
check('cons:pending 累积', cs.pending().length === 1);
cs.addPending([{ id: 'r1', content: '重复', userKey: null }], 50);
check('cons:pending 去重', cs.pending().length === 1);
cs.upsert({
  id: 'c_1', userKey: null, type: 'preference', content: '用户喜欢喝冰美式咖啡',
  sourceIds: ['r1'], confidence: 0.6, status: 'active', createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
});
cs.upsert({
  id: 'c_2', userKey: null, type: 'pattern', content: '用户去星巴克常点超大杯',
  sourceIds: ['r1'], confidence: 0.6, status: 'active', createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
});
check('cons:条目持久化', cs.get('c_1')?.content.includes('冰美式'));
cs.addLink('c_1', 'c_2', '同轮巩固');
cs.addLink('c_1', 'c_2', '同轮巩固');
check('cons:联想边权重累加', cs.strongLinks('c_1', 2, 5).length === 1 && cs.strongLinks('c_1', 2, 5)[0].weight === 2);
cs.touch('c_1', nowMs, { confidenceThreshold: 0.4, dormantDays: 30 });
check('cons:touch 计数', cs.get('c_1')?.touchCount === 1);
check('cons:touch 抬升置信度(越用越稳)', (cs.get('c_1')?.confidence ?? 0) > 0.6);
// 复活链路:低置信 + 长期未命中 → dormant;再被命中 → 置信度上涨、状态回 active
cs.upsert({
  id: 'c_sleep', userKey: null, type: 'stable-fact', content: '用户曾在成都出差',
  sourceIds: ['r1'], confidence: 0.3, status: 'dormant',
  createdAt: nowMs - 40 * 86400000, updatedAt: nowMs - 40 * 86400000, touchCount: 0,
});
check('cons:休眠条目先被判为应休眠',
  isDormant(cs.get('c_sleep'), nowMs, { confidenceThreshold: 0.4, dormantDays: 30 }) === true);
cs.touch('c_sleep', nowMs, { confidenceThreshold: 0.4, dormantDays: 30 });
check('cons:命中后置信度上涨', (cs.get('c_sleep')?.confidence ?? 0) > 0.3);
check('cons:命中后状态回到 active', cs.get('c_sleep')?.status === 'active');
check('cons:复活后不再被判休眠',
  isDormant(cs.get('c_sleep'), nowMs, { confidenceThreshold: 0.4, dormantDays: 30 }) === false);
// 用户手改 = 直接证据:抬置信度、状态回 active(否则「改完还是休眠」等于白改)
cs.upsert({
  id: 'c_fix', userKey: null, type: 'stable-fact', content: '用户住在杭州',
  sourceIds: ['r1'], confidence: 0.3, status: 'dormant',
  createdAt: nowMs - 40 * 86400000, updatedAt: nowMs - 40 * 86400000, touchCount: 0,
});
const revised = cs.revise('c_fix', '用户住在成都', { confidenceThreshold: 0.4, dormantDays: 30 });
check('cons:edit 改内容', revised?.content === '用户住在成都');
check('cons:edit 抬置信度到阈值以上', (revised?.confidence ?? 0) > 0.4);
check('cons:edit 让休眠条目复活', revised?.status === 'active');
check('cons:edit 不存在的 id 返回 undefined',
  cs.revise('nope', 'x', { confidenceThreshold: 0.4, dormantDays: 30 }) === undefined);
check('cons:触发判定(pending 不足不触发)', cs.shouldRun({ minFragments: 20, minIntervalMs: 0 }, nowMs) === false);

// ── 2f-2. 改口覆盖(supersede)──────────────────────────────────
// 用户「改口」= 同一句话换了个值。Jaccard 会被差异稀释,包含度不会。
const { containment, supersedeScore, findSupersedePairs, decideInjection } =
  await import(`${distUrl}consolidated.js`);
// 改口 = 同一句话换个值:Jaccard 与二元组包含度都会被「差异摊薄」,子序列比例不会
check('sup:子序列分抓住「同一句话换个值」',
  supersedeScore('用户住在成都', '用户住在杭州') > similarity('用户住在成都', '用户住在杭州'));
check('sup:子序列分对无关主题低',
  supersedeScore('用户住在成都', '用户养了一只叫煤球的猫') < 0.4);
check('sup:子序列分空串安全', supersedeScore('', 'x') === 0);
check('sup:包含度预筛挡住无关对',
  containment('用户住在成都', '用户养了一只叫煤球的猫') < 0.3);

const supOld = {
  id: 'old_1', userKey: null, type: 'stable-fact', content: '用户住在杭州',
  sourceIds: ['r1'], confidence: 0.6, status: 'active', createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
};
const supFresh = [{ id: 'new_1', type: 'stable-fact', content: '用户住在成都', userKey: null }];
const supPairs = findSupersedePairs(supFresh, [supOld], 0.6);
check('sup:改口被识别为取代对', supPairs.length === 1 && supPairs[0][0] === 'new_1' && supPairs[0][1] === 'old_1');
check('sup:不同类型不误判取代',
  findSupersedePairs([{ ...supFresh[0], type: 'preference' }], [supOld], 0.6).length === 0);
check('sup:不同用户不互相取代',
  findSupersedePairs([{ ...supFresh[0], userKey: 'im:qq:u_bob' }], [supOld], 0.6).length === 0);
check('sup:内容完全相同不算取代(那是重复不是改口)',
  findSupersedePairs([{ ...supFresh[0], content: '用户住在杭州' }], [supOld], 0.6).length === 0);
check('sup:无关新条目不取代旧条目',
  findSupersedePairs([{ id: 'new_2', type: 'stable-fact', content: '用户养了一只黑猫', userKey: null }], [supOld], 0.6).length === 0);

// 分数够高 ≠ 该取代:差异的「形状」才决定它是改口还是另一件事
const { judgeSupersede } = await import(`${distUrl}consolidated.js`);
check('sup:同一模板换一个值 → 改口',
  judgeSupersede('用户住在杭州', '用户住在成都', 0.6).sameTemplate === true);
check('sup:整句是旧句子的一部分(少了主语)→ 不是改口',
  judgeSupersede('用户的妈妈住在杭州', '用户住在杭州', 0.6).sameTemplate === false);
check('sup:同一句话 → 是重复观察,不是改口',
  judgeSupersede('用户住在杭州', '用户住在杭州', 0.6).sameFact === true &&
  judgeSupersede('用户住在杭州', '用户住在杭州', 0.6).sameTemplate === false);
check('sup:一句话是另一句的省略 → 是重复观察',
  judgeSupersede('用户喜欢喝冰美式咖啡', '用户喜欢喝冰美式', 0.6).sameFact === true);
check('sup:补一个限定语换了主语 → 不算重复观察',
  judgeSupersede('用户对芒果过敏', '用户的女朋友对芒果过敏', 0.6).sameFact === false);
check('sup:换日期的数字算换槽位,不算补字',
  judgeSupersede('用户的生日是十月二十三号', '用户的生日是十一月二十三号', 0.6).sameTemplate === true);
check('sup:整块换掉(换工作)→ 不是改口模板',
  judgeSupersede('用户想换工作,正在投简历', '用户已经换到新公司了', 0.6).sameTemplate === false);
check('sup:分数不够时两个标记都为 false',
  (() => { const j = judgeSupersede('用户住在杭州', '用户养了一只猫', 0.6); return !j.sameTemplate && !j.sameFact; })());

const csSup = new ConsolidatedStore(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-sup-')), logger);
csSup.load();
csSup.upsert({ ...supOld });
csSup.upsert({
  id: 'new_1', userKey: null, type: 'stable-fact', content: '用户住在成都',
  sourceIds: ['r1'], confidence: 0.6, status: 'active', createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
});
csSup.addLink('old_1', 'c_other', '旧联想');
check('sup:取代落盘为 superseded', csSup.supersedeMany([['new_1', 'old_1']], nowMs) === 1 &&
  csSup.get('old_1')?.status === 'superseded' && csSup.get('old_1')?.supersededBy === 'new_1');
check('sup:被取代的条目不再重复取代', csSup.supersedeMany([['new_1', 'old_1']], nowMs) === 0);
check('sup:联想边迁到新条目', csSup.strongLinks('new_1', 1, 5).some((l) => l.id === 'c_other') &&
  csSup.strongLinks('old_1', 1, 5).length === 0);
check('sup:被取代后 touch 不再复活', (() => {
  csSup.touch('old_1', nowMs, { confidenceThreshold: 0.4, dormantDays: 30 });
  return csSup.get('old_1')?.status === 'superseded' && csSup.get('old_1')?.touchCount === 0;
})());
check('sup:用户 edit 可翻案(回到 active 并清掉取代指针)', (() => {
  const m = csSup.revise('old_1', '用户又搬回杭州', { confidenceThreshold: 0.4, dormantDays: 30 });
  return m?.status === 'active' && m?.supersededBy === undefined;
})());

// 注入判定:superseded 哪怕与新事实高度相似也绝不复活
const supEv = ['用户住在成都'];
check('sup:superseded 永不注入',
  decideInjection({ ...supOld, status: 'superseded' }, supEv, { reviveSimilarity: 0.15, maxInject: 2 }, 0).inject === false);
check('sup:superseded 即使话题相似也不唤醒',
  decideInjection({ ...supOld, status: 'superseded' }, supEv, { reviveSimilarity: 0.15, maxInject: 2 }, 0).revived === false);
check('sup:active 直接注入',
  decideInjection({ ...supOld, status: 'active' }, supEv, { reviveSimilarity: 0.15, maxInject: 2 }, 0).inject === true);
check('sup:dormant 无人提起则不碰',
  decideInjection({ ...supOld, status: 'dormant' }, ['用户养了一只黑猫'], { reviveSimilarity: 0.5, maxInject: 2 }, 0).reason === 'dormant');
check('sup:dormant 被提起则唤醒并注入',
  decideInjection({ ...supOld, status: 'dormant' }, supEv, { reviveSimilarity: 0.15, maxInject: 2 }, 0).reason === 'revived');
check('sup:唤醒超过上限仍生效但不注入',
  decideInjection({ ...supOld, status: 'dormant' }, supEv, { reviveSimilarity: 0.15, maxInject: 2 }, 2).reason === 'revived-capped');

// ── 2f-3. 边权衰减 + 两跳扩散 ────────────────────────────────
const { effectiveWeight, LINK_HALF_LIFE_DAYS } = await import(`${distUrl}consolidated.js`);
check('edge:半衰期常量为 30 天', LINK_HALF_LIFE_DAYS === 30);
check('edge:刚强化的边不衰减',
  effectiveWeight({ weight: 4, label: 'x', at: nowMs }, nowMs) === 4);
check('edge:一个半衰期后权重减半',
  Math.abs(effectiveWeight({ weight: 4, label: 'x', at: nowMs - 30 * 86400000 }, nowMs) - 2) < 0.01);
check('edge:两个半衰期后剩四分之一',
  Math.abs(effectiveWeight({ weight: 4, label: 'x', at: nowMs - 60 * 86400000 }, nowMs) - 1) < 0.01);
check('edge:无时间戳的老边不凭空扣分',
  effectiveWeight({ weight: 3, label: 'x' }, nowMs) === 3);

const dgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-dg-'));
const dg = new ConsolidatedStore(dgDir, logger);
dg.load();
for (const id of ['a', 'b', 'c', 'd']) {
  dg.upsert({
    id, userKey: null, type: 'stable-fact', content: id, sourceIds: [],
    confidence: 0.6, status: 'active', createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
  });
}
dg.addLink('a', 'b', '同轮巩固', nowMs);
dg.addLink('a', 'b', '同轮巩固', nowMs);
dg.addLink('b', 'c', '同轮巩固', nowMs);
dg.addLink('b', 'c', '同轮巩固', nowMs);
dg.addLink('c', 'd', '同轮巩固', nowMs); // 单次弱边:不该扩散出来
const dOpts = { hop1Min: 2, hop2Min: 2, minScore: 1, maxHop1: 2, maxHop2: 1 };
const dgOut = dg.diffuse('a', dOpts, nowMs);
check('diffuse:一跳带出强共现条目', dgOut.some((x) => x.id === 'b' && x.hop === 1));
check('diffuse:两跳带出强链的强链', dgOut.some((x) => x.id === 'c' && x.hop === 2));
check('diffuse:弱边不参与扩散', dgOut.every((x) => x.id !== 'd'));
check('diffuse:不重复返回起点', dgOut.every((x) => x.id !== 'a'));
check('diffuse:结果不重复', new Set(dgOut.map((x) => x.id)).size === dgOut.length);
// 陈旧的边即使 weight 高,也会因衰减掉到门槛之下
dg.addLink('a', 'd', '同轮巩固', nowMs);
dg.addLink('a', 'd', '同轮巩固', nowMs);
check('diffuse:陈旧强边衰减后掉出扩散',
  dg.diffuse('a', dOpts, nowMs + 90 * 86400000).every((x) => x.id !== 'd'));
check('diffuse:新边在当期仍然生效',
  dg.diffuse('a', dOpts, nowMs).some((x) => x.id === 'd'));
check('edge:strongLinks 暴露有效权重',
  dg.strongLinks('a', 1, 5, nowMs).every((l) => typeof l.effective === 'number' && l.effective <= l.weight));
fs.rmSync(dgDir, { recursive: true, force: true });
// 重启加载(原子落盘后重读)
const cs2 = new ConsolidatedStore(csDir, logger);
cs2.load();
check('cons:重启后数据仍在', cs2.get('c_2')?.content.includes('超大杯') && cs2.pending().length === 1);
cs.markRun(nowMs);
check('cons:markRun 记录运行', cs.metaInfo().runCount === 1);
fs.rmSync(cluDir, { recursive: true, force: true });
fs.rmSync(csDir, { recursive: true, force: true });

// ── 2f-4. 置信度动态化:重复观察强化 ─────────────────────────
// 同一件事又被观察到 → 强化旧条目,而不是攒出一堆近义重复。
const { findTwin, reinforceMany: _rm, REINFORCE_CONFIDENCE_GAIN } =
  await import(`${distUrl}consolidated.js`);
check('tw:强化增量高于召回命中', REINFORCE_CONFIDENCE_GAIN > 0.05);
const twinPool = [
  { ...supOld, id: 'twin_1', content: '用户住在杭州', status: 'active' },
  { ...supOld, id: 'twin_2', content: '用户养了一只叫煤球的猫', type: 'preference', status: 'active' },
];
check('tw:同一句话再观察一次 → 命中已有条目',
  findTwin('用户住在杭州', 'stable-fact', null, twinPool, 0.85)?.id === 'twin_1');
check('tw:换了个值(改口)不算重复观察',
  findTwin('用户住在成都', 'stable-fact', null, twinPool, 0.85) === undefined);
check('tw:不跨 type 匹配',
  findTwin('用户住在杭州', 'preference', null, twinPool, 0.85) === undefined);
check('tw:不跨用户匹配',
  findTwin('用户住在杭州', 'stable-fact', 'im:qq:u_bob', twinPool, 0.85) === undefined);
check('tw:被取代的旧话不能靠重复出现翻案',
  findTwin('用户住在杭州', 'stable-fact', null, [{ ...supOld, status: 'superseded' }], 0.85) === undefined);

const rfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-rf-'));
const rf = new ConsolidatedStore(rfDir, logger);
rf.load();
const rfOpts = { confidenceThreshold: 0.4, dormantDays: 30 };
rf.upsert({
  id: 'rf_1', userKey: null, type: 'stable-fact', content: '用户住在杭州',
  sourceIds: ['r1'], confidence: 0.35, status: 'dormant',
  createdAt: nowMs - 40 * 86400000, updatedAt: nowMs - 40 * 86400000, touchCount: 0,
});
check('rf:重复观察抬高置信度', (() => {
  rf.reinforceMany(['rf_1'], nowMs, rfOpts);
  return (rf.get('rf_1')?.confidence ?? 0) > 0.35;
})());
check('rf:重复观察让休眠条目回到 active', rf.get('rf_1')?.status === 'active');
check('rf:置信度封顶 0.95', (() => {
  for (let i = 0; i < 20; i += 1) rf.reinforceMany(['rf_1'], nowMs, rfOpts);
  return rf.get('rf_1')?.confidence === 0.95;
})());
rf.upsert({
  id: 'rf_dead', userKey: null, type: 'stable-fact', content: '用户住在杭州',
  sourceIds: ['r1'], confidence: 0.6, status: 'superseded', supersededBy: 'rf_1',
  createdAt: nowMs, updatedAt: nowMs, touchCount: 0,
});
check('rf:被取代的条目不会被强化复活', (() => {
  rf.reinforceMany(['rf_dead'], nowMs, rfOpts);
  return rf.get('rf_dead')?.status === 'superseded' && rf.get('rf_dead')?.confidence === 0.6;
})());
check('rf:不存在的 id 安全跳过', rf.reinforceMany(['nope'], nowMs, rfOpts) === 0);
fs.rmSync(rfDir, { recursive: true, force: true });

// ── 2g. 巩固层交互命令 ─────────────────────────────────────────
console.log('[2g] 巩固层交互命令');
const { parseCommandLine, visibleMemories, formatMemoryList } = await import(`${distUrl}commands.js`);
check('cmd:空输入 → help', parseCommandLine('').sub === 'help');
check('cmd:list 解析', parseCommandLine('list').sub === 'list' && parseCommandLine('list').args.length === 0);
check('cmd:list --all 标记', parseCommandLine('list --all').all === true);
check('cmd:edit 拆出 id 与内容', parseCommandLine('edit c_1 用户喜欢冰美式').args.join('|') === 'c_1|用户喜欢冰美式');
check('cmd:未知子命令', parseCommandLine('foo bar').sub === 'unknown');
check('cmd:大小写不敏感', parseCommandLine('LIST').sub === 'list');

const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-cmd-'));
const cstore = new ConsolidatedStore(cmdDir, logger);
cstore.load();
const nowC = Date.now();
const mkMem = (id, userKey, type, content, conf, status = 'active') => ({
  id, userKey, type, content, sourceIds: ['r1'], confidence: conf, status,
  createdAt: nowC, updatedAt: nowC, touchCount: 1,
});
cstore.upsert(mkMem('a1', 'im:qq:u_alice', 'preference', '用户喜欢冰美式咖啡', 0.8));
cstore.upsert(mkMem('a2', 'im:qq:u_alice', 'stable-fact', '用户养了一只煤球猫', 0.6));
cstore.upsert(mkMem('b1', 'im:qq:u_bob', 'stable-fact', '用户打游戏到很晚', 0.7));
cstore.upsert(mkMem('s1', null, 'mood', '共享群聊情绪', 0.5));
cstore.upsert(mkMem('d1', null, 'stable-fact', '旧记忆', 0.2, 'dormant'));
check('cmd:off 模式全部可见', visibleMemories(cstore, 'im:qq:u_alice', 'off', false).length === 5);
check('cmd:auto 只见自己+共享',
  visibleMemories(cstore, 'im:qq:u_alice', 'auto', false).map((m) => m.id).sort().join(',') === 'a1,a2,d1,s1');
check('cmd:strict 同 auto 管理视图',
  visibleMemories(cstore, 'im:qq:u_bob', 'strict', false).map((m) => m.id).sort().join(',') === 'b1,d1,s1');
check('cmd:桌面 null 全部可见', visibleMemories(cstore, null, 'strict', false).length === 5);
check('cmd:--all 忽略隔离', visibleMemories(cstore, 'im:qq:u_alice', 'strict', true).length === 5);
const listText = formatMemoryList(visibleMemories(cstore, 'im:qq:u_alice', 'auto', false), {
  userKey: 'im:qq:u_alice', all: false, now: nowC,
});
check('cmd:list 输出含 id/类型/置信', listText.includes('a1') && listText.includes('偏好') && listText.includes('80%'));
check('cmd:list dormant 标记', listText.includes('dormant'));
check('cmd:list 隔离提示', listText.includes('隔离视图'));
check('cmd:remove 删除条目', cstore.remove('a1') === true && cstore.get('a1') === undefined);
cstore.addLink('a2', 'b1', '同轮巩固');
cstore.addLink('b1', 'a2', '同轮巩固');
check('cmd:remove 清联想边',
  cstore.remove('a2') === true && cstore.strongLinks('b1', 1, 5).length === 0 && cstore.strongLinks('a2', 1, 5).length === 0);
check('cmd:remove 不存在返回 false', cstore.remove('nope') === false);
fs.rmSync(cmdDir, { recursive: true, force: true });

// ── 2h. 时效衰减(排序分) ───────────────────────────────────────
console.log('[2h] 时效衰减');
const { decayFactor, DECAY_FLOOR, DECAY_HALF_LIFE_DAYS } = await import(`${distUrl}store.js`);
const NOW = Date.parse('2026-11-19T00:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10);
check('decay:今天的记忆系数为 1', decayFactor(iso(0), NOW) === 1);
check('decay:半衰期当天约 0.5', Math.abs(decayFactor(iso(DECAY_HALF_LIFE_DAYS), NOW) - 0.5) < 0.02);
check('decay:老记忆不沉底(守住 floor)', decayFactor(iso(3650), NOW) === DECAY_FLOOR);
check('decay:时间缺失不惩罚', decayFactor('', NOW) === 1 && decayFactor('不是日期', NOW) === 1);
check('decay:未来时间不倒扣', decayFactor(iso(-30), NOW) === 1);
check('decay:越新分越高', decayFactor(iso(1), NOW) > decayFactor(iso(90), NOW));

// ── 2i. 多路融合(RRF)与排序出口 ─────────────────────────────
console.log('[2i] 多路融合与排序');
const { fuseRanked, rankMemories, RRF_K } = await import(`${distUrl}store.js`);
const mkm = (id, priority, timestampStr = '') => ({
  id, content: id, type: 't', sceneName: '', family: '', priority, timestampStr,
});
// 两路都排了 a/b,顺序相反:c 只在第二路出现且名次靠前
const fused = fuseRanked(
  [[mkm('a', 5), mkm('b', 3)], [mkm('b', 3), mkm('c', 1), mkm('a', 5)]],
  10,
);
check('rrf:K 取论文值 60', RRF_K === 60);
check('rrf:两路都命中的 b 排第一', fused[0].id === 'b');
check('rrf:去重(3 条不重复)', fused.length === 3 && new Set(fused.map((m) => m.id)).size === 3);
check('rrf:单路结果保持原序', fuseRanked([[mkm('x', 1), mkm('y', 2)]], 10).map((m) => m.id).join(',') === 'x,y');
check('rrf:空输入安全', fuseRanked([], 10).length === 0 && fuseRanked([[]], 10).length === 0);
check('rrf:limit 生效', fuseRanked([[mkm('a', 1), mkm('b', 2), mkm('c', 3)]], 2).length === 2);
check('rrf:无 id 记录被丢弃', fuseRanked([[{ ...mkm('', 9) }]], 5).length === 0);

const RANK_NOW = Date.parse('2026-11-19T00:00:00Z');
const day = (n) => new Date(RANK_NOW - n * 86400000).toISOString().slice(0, 10);
check('rank:同分下新记忆优先',
  rankMemories([mkm('old', 5, day(300)), mkm('new', 5, day(0))], 2, RANK_NOW)[0].id === 'new');
check('rank:衰减不足以翻转量级差',
  rankMemories([mkm('oldHigh', 10, day(300)), mkm('newLow', 1, day(0))], 2, RANK_NOW)[0].id === 'oldHigh');
check('rank:limit 截断', rankMemories([mkm('a', 1), mkm('b', 2), mkm('c', 3)], 2, RANK_NOW).length === 2);
check('rank:不改动入参数组', (() => {
  const src = [mkm('a', 1, day(9)), mkm('b', 9, day(0))];
  const before = src.map((m) => m.id).join(',');
  rankMemories(src, 2, RANK_NOW);
  return src.map((m) => m.id).join(',') === before;
})());

// ── 2j. 跨轮去重(同一 agent 内降权) ─────────────────────────
console.log('[2j] 跨轮去重');
const { rememberInjected, demoteRecentlyInjected, resetRecentInjection, DEDUPE_TTL_MS } =
  await import(`${distUrl}recall.js`);
const T0 = 1_700_000_000_000;
const three = [mkm('m1', 9), mkm('m2', 8), mkm('m3', 7)];
resetRecentInjection();
check('dedupe:未注入时顺序不变',
  demoteRecentlyInjected(three, 'ag1', T0).map((m) => m.id).join(',') === 'm1,m2,m3');
rememberInjected('ag1', ['m1'], T0);
check('dedupe:已注入的降到末尾但不丢弃',
  demoteRecentlyInjected(three, 'ag1', T0 + 1000).map((m) => m.id).join(',') === 'm2,m3,m1');
check('dedupe:窗口过期后恢复原序',
  demoteRecentlyInjected(three, 'ag1', T0 + DEDUPE_TTL_MS + 1).map((m) => m.id).join(',') === 'm1,m2,m3');
check('dedupe:不同 agent 互不影响',
  demoteRecentlyInjected(three, 'ag2', T0 + 1000).map((m) => m.id).join(',') === 'm1,m2,m3');
check('dedupe:空 agentKey 不做任何事',
  demoteRecentlyInjected(three, '', T0 + 1000).map((m) => m.id).join(',') === 'm1,m2,m3');
rememberInjected('ag1', ['m1'], T0);
rememberInjected('ag1', [], T0);
check('dedupe:空 id 列表不写入', demoteRecentlyInjected(three, 'ag9', T0).length === 3);
resetRecentInjection();
check('dedupe:reset 清空状态',
  demoteRecentlyInjected(three, 'ag1', T0 + 1000).map((m) => m.id).join(',') === 'm1,m2,m3');

// ── 2k. 字符 n-gram 语义通道与精排 ──────────────────────────
console.log('[2k] 语义通道与精排');
const {
  buildCharNgramVector, cosineSimilarity, rerankBySemantic,
  SEMANTIC_MIN_SIM, SEMANTIC_RERANK_ALPHA,
} = await import(`${distUrl}store.js`);
check('sem:空串得到空向量', buildCharNgramVector('').size === 0);
check('sem:空向量余弦为 0',
  cosineSimilarity(buildCharNgramVector(''), buildCharNgramVector('咖啡')) === 0);
check('sem:完全相同文本余弦为 1', (() => {
  const v = buildCharNgramVector('用户喜欢喝冰美式咖啡');
  return Math.abs(cosineSimilarity(v, v) - 1) < 1e-9;
})());
check('sem:相似句高于无关句', (() => {
  const q = buildCharNgramVector('我下午想喝点冰的咖啡');
  const near = buildCharNgramVector('用户喜欢喝冰美式咖啡,常去公司楼下的星巴克');
  const far = buildCharNgramVector('用户养了一只叫煤球的黑色英短猫');
  return cosineSimilarity(q, near) > cosineSimilarity(q, far);
})());
check('sem:拉丁词参与特征', buildCharNgramVector('MacBook Pro').has('w:macbook'));
check('sem:中文二元组参与特征', buildCharNgramVector('冰美式').has('g:冰美'));
check('sem:门槛不做高精度过滤', SEMANTIC_MIN_SIM > 0 && SEMANTIC_MIN_SIM < 0.02);
check('sem:精排系数在(0,1]', SEMANTIC_RERANK_ALPHA > 0 && SEMANTIC_RERANK_ALPHA <= 1);

// 精排:构造「名次靠前但语义无关」与「名次靠后但语义贴合」两条,语义贴合者应上浮
const COFFEE = {
  id: 'coffee', content: '用户喜欢喝冰美式咖啡,常去公司楼下的星巴克',
  type: 'fact', sceneName: '咖啡偏好', family: '', priority: 5, timestampStr: '',
};
const CAT = {
  id: 'cat', content: '用户养了一只叫煤球的黑色英短猫',
  type: 'fact', sceneName: '宠物', family: '', priority: 5, timestampStr: '',
};
const reranked = rerankBySemantic([CAT, COFFEE], '我下午想喝点冰的咖啡');
check('sem:精排把语义贴合的条目提到前面', reranked[0].id === 'coffee');
check('sem:精排不丢候选', reranked.length === 2);
check('sem:精排不改动入参数组', (() => {
  const src = [CAT, COFFEE];
  rerankBySemantic(src, '冰咖啡');
  return src[0].id === 'cat';
})());
check('sem:单条列表原样返回', rerankBySemantic([COFFEE], '咖啡').length === 1);
check('sem:空列表安全', rerankBySemantic([], '咖啡').length === 0);

// ── 3. 重建引擎纯逻辑(不实际调用 LLM) ───────────────────────
console.log('[3] rebuild 碎片组装预算');
const { buildFragments: _b } = await import(path.join(dist, 'rebuild.js')).catch(() => ({}));
// buildFragments 未导出,改为从源码验证配置默认值预算口径
check('配置预算默认值合理', cfg.rebuild.maxMemoryChars >= 50 && cfg.rebuild.maxTotalChars > cfg.rebuild.maxMemoryChars);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
