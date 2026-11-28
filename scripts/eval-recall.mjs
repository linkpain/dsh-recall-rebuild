/**
 * 中文召回评测(不进入 npm 包):在同一批真实中文记忆上,
 * 用「旧分词(整句一个词元)」与「新分词(拉丁词 + CJK 2-gram)」各跑一遍,
 * 输出 recall@5 与 MRR@5 的 before/after 数字。
 *
 * 为什么需要这个脚本:没有数字的「优化」只能靠形容词,而形容词是最容易被
 * 维护者读代码推翻的东西。这一个数字就能证明 P0-1 到底修没修好。
 *
 * 运行:node scripts/eval-recall.mjs        (先 npm run build)
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distUrl = pathToFileURL(path.join(root, 'dist') + path.sep).href;
const { openPrimeMemoryStore } = await import(distUrl + 'store.js');

/* ── fixture:40 条中文记忆,每条配一句「用户真的会说的话」作为查询 ──
 * 查询刻意用同义/省略/换说法,而不是记忆原文的子串 —— 否则测的只是 LIKE 是否工作。 */
const FIXTURE = [
  { id: 'm01', content: '用户喜欢喝冰美式咖啡,常去公司楼下的星巴克', type: 'fact', scene: '咖啡偏好', query: '我下午想喝点冰的咖啡' },
  { id: 'm02', content: '用户养了一只叫煤球的黑色英短猫', type: 'fact', scene: '宠物', query: '我家猫最近掉毛厉害' },
  { id: 'm03', content: '用户下周要去成都出差三天,住春熙路附近', type: 'plan', scene: '行程', query: '我下周去成都住哪儿方便' },
  { id: 'm04', content: '用户对芒果过敏,吃芒果会起疹子', type: 'fact', scene: '健康', query: '这个甜品里有芒果吗我能吃吗' },
  { id: 'm05', content: '用户每天早上七点起床跑步五公里', type: 'pattern', scene: '作息', query: '我晨跑应该注意什么' },
  { id: 'm06', content: '用户在字节跳动做后端开发,主要写 Go', type: 'fact', scene: '工作', query: '我们组用的语言要不要换' },
  { id: 'm07', content: '用户的妈妈住在杭州,每周日通电话', type: 'relationship', scene: '家人', query: '我这周末得给我妈打个电话' },
  { id: 'm08', content: '用户不喜欢吃香菜,点外卖每次备注不要香菜', type: 'preference', scene: '饮食', query: '帮我点个牛肉面' },
  { id: 'm09', content: '用户最近在准备考研,目标是计算机专业', type: 'plan', scene: '学习', query: '我复习进度有点慢怎么办' },
  { id: 'm10', content: '用户的电脑是 MacBook Pro 14 寸 M2 Pro 芯片', type: 'fact', scene: '设备', query: '我这个配置跑得动 Docker 吗' },
  { id: 'm11', content: '用户讨厌开会,觉得大部分会议都在浪费时间', type: 'preference', scene: '工作习惯', query: '明天那个同步会我必须去吗' },
  { id: 'm12', content: '用户的生日是十月二十三号,天秤座', type: 'fact', scene: '个人信息', query: '我今年生日是哪天来着' },
  { id: 'm13', content: '用户上个月刚搬进新家,在望京,还没装宽带', type: 'fact', scene: '居住', query: '我家网还没通' },
  { id: 'm14', content: '用户的室友叫小李,是个夜班护士', type: 'relationship', scene: '室友', query: '我室友白天在家睡觉' },
  { id: 'm15', content: '用户正在学吉他,练的是指弹曲目', type: 'pattern', scene: '爱好', query: '我最近练琴手指头疼' },
  { id: 'm16', content: '用户有轻微的颈椎病,长时间低头会疼', type: 'fact', scene: '健康', query: '我脖子又酸了' },
  { id: 'm17', content: '用户的年终奖在明年三月发放,和绩效挂钩', type: 'fact', scene: '收入', query: '我年终奖什么时候到账' },
  { id: 'm18', content: '用户喜欢看科幻小说,最喜欢三体', type: 'preference', scene: '阅读', query: '推荐几本书吧我喜欢那种宇宙尺度的' },
  { id: 'm19', content: '用户不会游泳,一直想学但没有勇气', type: 'fact', scene: '技能', query: '我想报个班学游泳' },
  { id: 'm20', content: '用户开车上班,单程四十分钟,走京藏高速', type: 'pattern', scene: '通勤', query: '早高峰怎么绕开堵点' },
  { id: 'm21', content: '用户对花生过敏但自己经常忘记,吃饭要提醒', type: 'fact', scene: '健康', query: '这个菜里有花生碎吗' },
  { id: 'm22', content: '用户的女朋友叫小雅,在医院做检验科医生', type: 'relationship', scene: '感情', query: '我对象这周值夜班' },
  { id: 'm23', content: '用户在攒钱买房,首付还差三十万', type: 'plan', scene: '财务', query: '我什么时候能凑够首付' },
  { id: 'm24', content: '用户每天睡前要刷半小时手机才睡得着', type: 'pattern', scene: '作息', query: '我总是失眠' },
  { id: 'm25', content: '用户的手机是 iPhone 13,电池健康度只剩 78%', type: 'fact', scene: '设备', query: '我手机续航太差了要不要换电池' },
  { id: 'm26', content: '用户喜欢在周末做手冲咖啡,用的是 V60 滤杯', type: 'pattern', scene: '爱好', query: '周末我想试试手冲' },
  { id: 'm27', content: '用户刚养了一只柯基犬,叫豆豆,三个月大', type: 'fact', scene: '宠物', query: '小狗疫苗要打几针' },
  { id: 'm28', content: '用户在公司负责支付系统的对账模块', type: 'fact', scene: '工作内容', query: '对账跑批又失败了' },
  { id: 'm29', content: '用户讨厌冬天,一到冬天就手脚冰凉', type: 'preference', scene: '季节', query: '天冷了真难受' },
  { id: 'm30', content: '用户去年考驾照科目二挂了两次,现在还没过', type: 'fact', scene: '驾照', query: '我侧方停车总是压线' },
  { id: 'm31', content: '用户每个月要还房贷八千二百块,还款日是每月十五号', type: 'fact', scene: '财务', query: '十五号之前得留够钱' },
  { id: 'm32', content: '用户喜欢听周杰伦的老歌,尤其是晴天', type: 'preference', scene: '音乐', query: '放首歌吧想听点以前的' },
  { id: 'm33', content: '用户的爸爸有高血压,需要定期量血压', type: 'relationship', scene: '家人', query: '我爸最近血压有点高' },
  { id: 'm34', content: '用户在学英语口语,每天用 App 打卡二十分钟', type: 'pattern', scene: '学习', query: '我口语练了三个月还是不敢开口' },
  { id: 'm35', content: '用户不吃辣,一点点辣就胃疼', type: 'preference', scene: '饮食', query: '这家川菜我能不能吃' },
  { id: 'm36', content: '用户的工位在十八楼靠窗,能看见公园', type: 'fact', scene: '工作环境', query: '我工位晒得慌' },
  { id: 'm37', content: '用户想换工作,正在偷偷投简历,不想让同事知道', type: 'plan', scene: '职业', query: '我面试该怎么跟现公司说' },
  { id: 'm38', content: '用户的膝盖受过伤,不能长时间跑步', type: 'fact', scene: '健康', query: '我跑完膝盖疼' },
  { id: 'm39', content: '用户喜欢自己做饭,拿手菜是番茄炒蛋和红烧排骨', type: 'pattern', scene: '烹饪', query: '今晚做点什么吃好' },
  { id: 'm40', content: '用户住在望京,附近有一家二十四小时营业的便利店', type: 'fact', scene: '居住', query: '半夜饿了去哪买东西' },
];

/* ── 旧实现(改动前)的分词:只按「非字母数字」切分,中文整句 = 1 个词元 ── */
const LEGACY_STOP = new Set(['and', 'or', 'not', 'near']);
function legacyTokenize(query) {
  const q = typeof query === 'string' ? query.toLowerCase() : '';
  if (!q) return [];
  return q.split(/[^\p{L}\p{N}]+/u).map(function (t) { return t.trim(); }).filter(function (t) { return t && !LEGACY_STOP.has(t); });
}
function legacySanitize(query) {
  const tokens = legacyTokenize(query);
  if (tokens.length === 0) return '';
  return tokens.map(function (t) { return '"' + String(t).replace(/"/g, '""') + '"'; }).join(' AND ');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function buildDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  db.exec(
    'CREATE TABLE l1_records (' +
      'record_id TEXT PRIMARY KEY, content TEXT, type TEXT, scene_name TEXT,' +
      'family TEXT, scope TEXT, workspace_id TEXT, priority INTEGER, timestamp_str TEXT);' +
    'CREATE VIRTUAL TABLE l1_fts USING fts5(' +
      'record_id, content_original, type, scene_name, family, scope, workspace_id);',
  );
  const insRec = db.prepare('INSERT INTO l1_records VALUES (?,?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO l1_fts VALUES (?,?,?,?,?,?,?)');
  FIXTURE.forEach(function (m, i) {
    // 时间分散在 2026 年内,让时效衰减真的参与排序,而不是同一天
    const ts = '2026-' + pad2(1 + (i % 9)) + '-' + pad2(1 + (i % 27));
    insRec.run(m.id, m.content, m.type, m.scene, 'memory', 'global', '', 5, ts);
    insFts.run(m.id, m.content, m.type, m.scene, 'memory', 'global', '');
  });
  db.close();
}

/** 旧实现的检索(仅用于对照):FTS AND 命中优先,否则取前 3 词做 LIKE OR。 */
function legacySearch(dir, query, limit) {
  const db = new DatabaseSync(path.join(dir, 'memory.db'), { readOnly: true });
  try {
    const fts = legacySanitize(query);
    if (fts) {
      try {
        const rows = db.prepare(
          'SELECT record_id FROM l1_fts WHERE l1_fts MATCH ? ORDER BY bm25(l1_fts) ASC LIMIT ?',
        ).all(fts, limit);
        if (rows.length > 0) return rows.map(function (r) { return r.record_id; });
      } catch (err) { /* 落 LIKE */ }
    }
    const words = legacyTokenize(query).slice(0, 3);
    if (words.length === 0) return [];
    const ors = words.map(function () { return 'content LIKE ?'; }).join(' OR ');
    const params = words.map(function (w) { return '%' + w + '%'; });
    params.push(limit);
    const rows = db.prepare('SELECT record_id FROM l1_records WHERE ' + ors + ' LIMIT ?').all(...params);
    return rows.map(function (r) { return r.record_id; });
  } finally {
    db.close();
  }
}

const logger = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

function evaluate(label, searchFn) {
  let hitAt5 = 0;
  let mrr = 0;
  const misses = [];
  for (const m of FIXTURE) {
    const got = searchFn(m.query, 5).map(function (x) { return typeof x === 'string' ? x : x.id; });
    const rank = got.indexOf(m.id);
    if (rank >= 0 && rank < 5) {
      hitAt5 += 1;
      mrr += 1 / (rank + 1);
    } else {
      misses.push(m.id);
    }
  }
  const n = FIXTURE.length;
  return { label: label, recall: hitAt5 / n, mrr: mrr / n, missCount: misses.length, misses: misses.slice(0, 8) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-eval-'));
buildDb(tmp);

const store = openPrimeMemoryStore(tmp, logger);
if (!store.ok) {
  console.error('记忆库打开失败,评测无法进行');
  process.exit(1);
}
const after = evaluate('新分词(拉丁词 + CJK 2-gram)', function (q, k) {
  return store.search(q, k).map(function (r) { return r.id; });
});
store.close();

/* ── 通用源路径(14 个源共用 makeTextStore)───────────────────
 * 之前评测只覆盖 prime:其余源把条目读进内存、走另一套打分,
 * 改动它们时没有任何回归信号。这里用同一批 fixture 跑一遍通用源。
 * 另外 2 个非 prime 源(palace / dsh-memory)不走 makeTextStore,单列在下面。 */
const { makeTextStore } = await import(distUrl + 'sources/kit.js');
const genericDocs = FIXTURE.map(function (m, i) {
  return {
    id: m.id,
    text: m.content,
    hints: [m.scene],
    scene: m.scene,
    family: 'fixture',
    type: m.type,
    // 与 prime 那批同一套日期口径,让时效衰减在两路上可比
    ts: '2026-' + pad2(1 + (i % 9)) + '-' + pad2(1 + (i % 27)),
  };
});
const genericStore = makeTextStore('eval', genericDocs, logger);
const generic = evaluate('通用源(14 个源共用)', function (q, k) {
  return genericStore.search(q, k).map(function (r) { return r.id; });
});

/* ── 专属适配器路径:palace 与 dsh-memory ───────────────────────
 * 这两个源不走 makeTextStore:它们各自解析自己的文件格式(Markdown / JSON)。
 * 于是 v0.1.15 给通用源补的三路融合 + 语义精排,它们一条都没吃到,而评测
 * 一直只覆盖 prime 与通用源 —— 这条脱节没有任何数字看住。
 * 这里把同一批 fixture 落成它们各自的真实文件格式,跑真实适配器(不是假数据)。 */
const { openPalaceStore, openDshMemoryStore } = await import(distUrl + 'store.js');
const contentToId = new Map(FIXTURE.map(function (m) { return [m.content, m.id]; }));
function idsOf(list) {
  return list.map(function (r) { return contentToId.get(r.content) || r.id; });
}
const tsOf = function (i) { return '2026-' + pad2(1 + (i % 9)) + '-' + pad2(1 + (i % 27)); };

const adapterTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rebuild-adapters-'));
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
const prevDshHome = process.env.DSH_HOME;
// 把 home 也指到临时目录:否则本机真实的 ~/.deepseek-harness/MEMORY.md 会混进评测
process.env.HOME = adapterTmp;
process.env.USERPROFILE = adapterTmp;
process.env.DSH_HOME = path.join(adapterTmp, 'dshhome');

// palace:一个 MEMORY.md,按 scene 分 ## 章节。MEMORY.md 的时间线索是文件 mtime,
// 所以这一路所有条目同一天 —— 时效衰减是常量,测的纯粹是相关性打分。
const palaceDir = path.join(adapterTmp, 'palace', '.deepseek-harness');
fs.mkdirSync(palaceDir, { recursive: true });
const palaceLines = [];
const byScene = new Map();
FIXTURE.forEach(function (m) {
  if (!byScene.has(m.scene)) byScene.set(m.scene, []);
  byScene.get(m.scene).push(m.content);
});
byScene.forEach(function (items, scene) {
  palaceLines.push('## ' + scene);
  items.forEach(function (c) { palaceLines.push('- ' + c); });
  palaceLines.push('');
});
fs.writeFileSync(path.join(palaceDir, 'MEMORY.md'), palaceLines.join('\n'), 'utf8');
const palaceStore = openPalaceStore(path.join(adapterTmp, 'palace'), logger);
const palace = evaluate('palace(Markdown)', function (q, k) {
  return idsOf(palaceStore.search(q, k));
});
palaceStore.close();

/* 对照:把同一批条目按**旧打分**(只有命中词数一条通道)排一遍。
 * 没有这一行,「palace 70%」只是个孤立数字 —— 看不出接入共享出口到底值多少。 */
const { tokenizeQuery, lengthFactor, rankMemories } = await import(distUrl + 'store.js');
const palaceLegacyItems = [];
byScene.forEach(function (items, scene) {
  items.forEach(function (c, i) {
    palaceLegacyItems.push({ id: contentToId.get(c), content: c, scene: scene, ts: '' });
  });
});
function legacyRankPalace(query, limit) {
  const words = tokenizeQuery(query);
  if (words.length === 0) return [];
  const scored = [];
  for (const it of palaceLegacyItems) {
    const nl = it.content.trim().replace(/\s+/g, ' ').toLowerCase();
    let hits = 0;
    for (const w of words) if (nl.includes(w)) hits += 1;
    if (hits > 0) scored.push({ it: it, hits: hits });
  }
  const ranked = scored
    .slice(0, Math.max(limit * 8, 40))
    .map(function (x) {
      return {
        id: x.it.id,
        content: x.it.content,
        type: 'palace',
        sceneName: x.it.scene,
        family: 'legacy',
        priority: x.hits * lengthFactor(x.it.content.length),
        timestampStr: x.it.ts,
      };
    });
  return rankMemories(ranked, limit, Date.now()).map(function (r) { return r.id; });
}
const palaceBefore = evaluate('palace(旧打分,仅词元)', function (q, k) { return legacyRankPalace(q, k); });

// dsh-memory:storage-hub 的 JSON 库,blocks 里 status 必须 approved 才生效。
const dmDir = path.join(process.env.DSH_HOME, 'storages');
fs.mkdirSync(dmDir, { recursive: true });
const blocks = FIXTURE.map(function (m, i) {
  return {
    id: m.id,
    namespace: 'global',
    status: 'approved',
    injected: true,
    quarantined: false,
    kind: 'memory',
    content: m.content,
    keywords: [m.scene],
    createdAt: Date.parse(tsOf(i) + 'T00:00:00Z'),
    updatedAt: Date.parse(tsOf(i) + 'T00:00:00Z'),
  };
});
fs.writeFileSync(
  path.join(dmDir, 'memory.json'),
  JSON.stringify({ unit: { name: 'memory', tables: { blocks: blocks } } }),
  'utf8',
);
const dmStore = openDshMemoryStore(adapterTmp, logger);
const dshMemory = evaluate('dsh-memory(JSON)', function (q, k) {
  return idsOf(dmStore.search(q, k));
});
dmStore.close();

function legacyRankDshMemory(query, limit) {
  const words = tokenizeQuery(query);
  if (words.length === 0) return [];
  const scored = [];
  for (const b of blocks) {
    const cNorm = b.content.trim().replace(/\s+/g, ' ').toLowerCase();
    let hits = 0;
    for (const w of words) {
      if (cNorm.includes(w)) hits += 1;
      for (const kw of b.keywords) {
        if (kw.trim().toLowerCase().includes(w)) hits += 2;
      }
    }
    if (hits > 0) scored.push({ b: b, hits: hits });
  }
  const ranked = scored.slice(0, Math.max(limit * 8, 40)).map(function (x) {
    return {
      id: x.b.id,
      content: x.b.content,
      type: 'dsh-memory',
      sceneName: 'global 记忆',
      family: 'legacy',
      priority: x.hits * lengthFactor(x.b.content.length),
      timestampStr: '',
    };
  });
  return rankMemories(ranked, limit, Date.now()).map(function (r) { return r.id; });
}
const dshMemoryBefore = evaluate('dsh-memory(旧打分,仅词元)', function (q, k) {
  return legacyRankDshMemory(q, k);
});

// 还原环境,别让评测进程的临时改动漏给后面的路径
if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
fs.rmSync(adapterTmp, { recursive: true, force: true });

const before = evaluate('旧分词(整句一个词元)', function (q, k) { return legacySearch(tmp, q, k); });

fs.rmSync(tmp, { recursive: true, force: true });

function pct(x) { return (x * 100).toFixed(1) + '%'; }
console.log('');
console.log('中文召回评测(40 条 fixture,recall@5 / MRR@5)');
console.log('');
[before, after, generic, palaceBefore, palace, dshMemoryBefore, dshMemory].forEach(function (r) {
  console.log('  ' + r.label.padEnd(26) + ' recall@5 = ' + pct(r.recall).padStart(6) +
    '   MRR@5 = ' + r.mrr.toFixed(3) + '   未命中 ' + r.missCount + '/40');
});
console.log('');
console.log('  recall@5 提升 ' + (after.recall - before.recall >= 0 ? '+' : '') +
  ((after.recall - before.recall) * 100).toFixed(1) + ' 个百分点');
if (after.misses.length > 0) console.log('  新实现仍未命中: ' + after.misses.join(', '));
if (generic.misses.length > 0) console.log('  通用源仍未命中: ' + generic.misses.join(', '));
if (palace.misses.length > 0) console.log('  palace 仍未命中: ' + palace.misses.join(', '));
if (dshMemory.misses.length > 0) console.log('  dsh-memory 仍未命中: ' + dshMemory.misses.join(', '));
if (after.recall <= before.recall) {
  console.error('');
  console.error('失败:新分词的 recall@5 未超过旧分词,改动可能未生效');
  process.exit(1);
}
// 回归闸门:改动前锁 0.55(当前实测 0.625),留 7 个点余量给 fixture 微调,
// 但任何把中文召回打回「几乎全靠单字」的改动都会掉到线下。
const MIN_RECALL = Number(process.env.EVAL_MIN_RECALL ?? 0.65);
if (after.recall < MIN_RECALL) {
  console.error('');
  console.error('失败:recall@5 ' + pct(after.recall) + ' 低于回归闸门 ' + pct(MIN_RECALL));
  process.exit(1);
}
// 通用源单列闸门:它和 prime 走不同打分路径,不能用 prime 的成绩替它担保。
// 历史上这里比 prime 低 22 个点(47.5%),因为通用源只有「命中词数」一条通道,
// 2-gram 全落空时彻底失明。补齐单字覆盖 + 字符 n-gram 语义 + RRF 融合 + 语义精排
// 之后,通用源追平 prime(70.0%/MRR 0.615),闸门随之抬到与 prime 同级 ——
// 从此任何一侧退化都会被同一个数字看住。
const MIN_GENERIC = Number(process.env.EVAL_MIN_GENERIC ?? 0.65);
if (generic.recall < MIN_GENERIC) {
  console.error('');
  console.error('失败:通用源 recall@5 ' + pct(generic.recall) + ' 低于回归闸门 ' + pct(MIN_GENERIC));
  process.exit(1);
}
// 两个专属适配器各自单列闸门。它们解析的是不同格式(Markdown / JSON),
// 但既然已经接入同一条打分出口,成绩就该和通用源同级;任何一侧掉队都说明
// 「接入」只接了一半(比如正文没归一化、keywords 没当高价值字段)。
const MIN_ADAPTER = Number(process.env.EVAL_MIN_ADAPTER ?? 0.65);
if (palace.recall < MIN_ADAPTER) {
  console.error('');
  console.error('失败:palace recall@5 ' + pct(palace.recall) + ' 低于回归闸门 ' + pct(MIN_ADAPTER));
  process.exit(1);
}
if (dshMemory.recall < MIN_ADAPTER) {
  console.error('');
  console.error('失败:dsh-memory recall@5 ' + pct(dshMemory.recall) + ' 低于回归闸门 ' + pct(MIN_ADAPTER));
  process.exit(1);
}
console.log('');
process.exit(0);
