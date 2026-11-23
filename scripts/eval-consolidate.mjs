/**
 * 巩固层评测(不进入 npm 包):给「改口覆盖 / 重复观察强化 / 遗忘可逆 / 联想扩散」
 * 这四件启发式各配一份带标注的 fixture,输出 precision / recall / 到达率,
 * 而不是只靠形容词说「更像个活人了」。
 *
 * 为什么需要它:这四件事全部建立在字符相似度这类阈值启发式上,
 * 阈值松一格就误杀仍然为真的记忆,紧一格就漏判改口。
 * 没有标注集,调阈值等于蒙。
 *
 * 运行:node scripts/eval-consolidate.mjs   (先 npm run build)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distUrl = pathToFileURL(path.join(root, 'dist') + path.sep).href;
const {
  ConsolidatedStore,
  isDormant,
  findSupersedePairs,
  findTwin,
  decideInjection,
  supersedeScore,
  similarity,
} = await import(distUrl + 'consolidated.js');

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const DAY = 86400000;
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}(${detail})` : name);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/* ── A. 改口 / 重复观察 / 无关:三类标注对 ───────────────────────
 * label='supersede':同一句话换了个值(用户改口、搬家、换工作)
 * label='twin'     :几乎一字不差地又说了一遍(同一事实重复观察)
 * label='distinct' :不同事实,必须两条都留着
 * 这三类之间的边界正是两个阈值在切的东西。 */
const PAIRS = [
  // —— 改口:同一句话,一个槽位换了值 ——
  { old: '用户住在杭州', fresh: '用户住在成都', label: 'supersede' },
  { old: '用户在字节跳动做后端开发', fresh: '用户在腾讯做后端开发', label: 'supersede' },
  { old: '用户的手机是 iPhone 13', fresh: '用户的手机是 iPhone 15', label: 'supersede' },
  { old: '用户的女朋友叫小雅', fresh: '用户的女朋友叫小雨', label: 'supersede' },
  { old: '用户每天早上七点起床跑步五公里', fresh: '用户每天早上六点起床跑步五公里', label: 'supersede' },
  { old: '用户的室友叫小李,是个夜班护士', fresh: '用户的室友叫小王,是个夜班护士', label: 'supersede' },
  { old: '用户对芒果过敏', fresh: '用户对花生过敏', label: 'supersede' },
  { old: '用户的生日是十月二十三号', fresh: '用户的生日是十一月二十三号', label: 'supersede' },
  { old: '用户养了一只叫煤球的黑色英短猫', fresh: '用户养了一只叫煤球的橘色英短猫', label: 'supersede' },
  { old: '用户的电脑是 MacBook Pro 14 寸', fresh: '用户的电脑是 MacBook Air 13 寸', label: 'supersede' },
  // —— 重复观察:同一事实再说一遍(可能多几个字) ——
  { old: '用户住在杭州', fresh: '用户住在杭州', label: 'twin' },
  { old: '用户喜欢喝冰美式咖啡', fresh: '用户喜欢喝冰美式', label: 'twin' },
  { old: '用户对芒果过敏,吃芒果会起疹子', fresh: '用户对芒果过敏,吃芒果会起疹子', label: 'twin' },
  { old: '用户每天睡前要刷半小时手机', fresh: '用户每天睡前要刷半小时手机才睡得着', label: 'twin' },
  { old: '用户不吃辣,一点点辣就胃疼', fresh: '用户不吃辣', label: 'twin' },
  { old: '用户的工位在十八楼靠窗', fresh: '用户的工位在十八楼靠窗,能看见公园', label: 'twin' },
  { old: '用户正在学吉他,练的是指弹曲目', fresh: '用户正在学吉他', label: 'twin' },
  { old: '用户开车上班,单程四十分钟', fresh: '用户开车上班,单程四十分钟,走京藏高速', label: 'twin' },
  { old: '用户讨厌开会', fresh: '用户讨厌开会', label: 'twin' },
  { old: '用户喜欢看科幻小说,最喜欢三体', fresh: '用户喜欢看科幻小说', label: 'twin' },
  // —— 不同事实:必须共存 ——
  { old: '用户住在杭州', fresh: '用户养了一只叫煤球的猫', label: 'distinct' },
  { old: '用户对芒果过敏', fresh: '用户的女朋友对芒果过敏', label: 'distinct' },
  // —— 字面判不出来的:同一模板换了值,但两个值可以共存 ——
  // 「喜欢冰美式」和「喜欢手冲咖啡」不互斥,「室友叫小李」和「同事叫小李」也不互斥。
  // 要判「换的这个值是不是把旧的顶掉了」,需要知道槽位是不是单值(住址、生日、手机号
  // 是单值;喜好、熟人名字可以多值),那是语义知识,字面相似度给不出来。
  // 这类样本单列,不参与评分,也不假装解决了。
  { old: '用户喜欢喝冰美式', fresh: '用户喜欢喝手冲咖啡', label: 'ambiguous' },
  { old: '用户的妈妈住在杭州', fresh: '用户住在杭州', label: 'distinct' },
  { old: '用户每天早上七点起床跑步', fresh: '用户每天睡前要刷半小时手机', label: 'distinct' },
  { old: '用户在字节跳动做后端开发', fresh: '用户在字节跳动做前端开发', label: 'supersede' },
  { old: '用户的室友叫小李', fresh: '用户的同事叫小李', label: 'ambiguous' },
  { old: '用户讨厌冬天', fresh: '用户讨厌开会', label: 'ambiguous' },
  { old: '用户想换工作,正在投简历', fresh: '用户已经换到新公司了', label: 'supersede' },
  { old: '用户不会游泳', fresh: '用户已经学会游泳了', label: 'supersede' },
];

const SUPERSEDE_T = 0.6;
const REINFORCE_T = 0.85;
const supMem = (i, p) => ({
  id: `p${i}`, userKey: null, type: 'stable-fact', content: p.old, sourceIds: ['r'],
  confidence: 0.6, status: 'active', createdAt: 0, updatedAt: 0, touchCount: 0,
});

let supTP = 0, supFP = 0, supFN = 0;
let twTP = 0, twFP = 0, twFN = 0;
const supMiss = [];
const twMiss = [];
const ambiguousHit = [];
PAIRS.forEach((p, i) => {
  const existing = [supMem(i, p)];
  const fresh = [{ id: `f${i}`, type: 'stable-fact', content: p.fresh, userKey: null }];
  const superseded = findSupersedePairs(fresh, existing, SUPERSEDE_T).length > 0;
  const twinned = !!findTwin(p.fresh, 'stable-fact', null, existing, REINFORCE_T);
  if (p.label === 'supersede') {
    if (superseded) supTP += 1; else { supFN += 1; supMiss.push(`改口未识别: ${p.old} → ${p.fresh} (score ${supersedeScore(p.old, p.fresh).toFixed(2)})`); }
    if (twinned) { twFP += 1; twMiss.push(`改口被当成重复观察: ${p.old} → ${p.fresh}`); }
  } else if (p.label === 'twin') {
    if (twinned) twTP += 1; else { twFN += 1; twMiss.push(`重复观察未识别: ${p.old} → ${p.fresh} (score ${supersedeScore(p.old, p.fresh).toFixed(2)})`); }
    if (superseded) { supFP += 1; supMiss.push(`重复观察被当成改口覆盖: ${p.old} → ${p.fresh}`); }
  } else if (p.label === 'ambiguous') {
    if (superseded) ambiguousHit.push(`${p.old} → ${p.fresh}`);
  } else {
    if (superseded) { supFP += 1; supMiss.push(`无关事实被误判改口: ${p.old} → ${p.fresh} (score ${supersedeScore(p.old, p.fresh).toFixed(2)})`); }
    if (twinned) { twFP += 1; twMiss.push(`无关事实被误判重复: ${p.old} → ${p.fresh}`); }
  }
});
const prf = (tp, fp, fn) => {
  const p = tp + fp === 0 ? 1 : tp / (tp + fp);
  const r = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  return { p, r, f };
};
const supM = prf(supTP, supFP, supFN);
const twM = prf(twTP, twFP, twFN);

console.log('\n巩固层评测\n');
console.log('  A. 标注对判定(改口 12 / 重复观察 10 / 无关 5 / 字面不可判定 3)');
console.log(`     改口覆盖  P=${pct(supM.p)}  R=${pct(supM.r)}  F1=${pct(supM.f)}`);
console.log(`     重复强化  P=${pct(twM.p)}  R=${pct(twM.r)}  F1=${pct(twM.f)}`);
if (supMiss.length) console.log('     改口侧偏差:\n' + supMiss.map((s) => '       - ' + s).join('\n'));
if (twMiss.length) console.log('     强化侧偏差:\n' + twMiss.map((s) => '       - ' + s).join('\n'));
if (ambiguousHit.length) {
  console.log('     字面不可判定、当前实现判成改口的(已知边界):\n' +
    ambiguousHit.map((s) => '       - ' + s).join('\n'));
}

// 误判代价不对称:把仍然为真的记忆藏起来(FP)比漏判一条改口(FN)更糟
check('改口覆盖在可判定样本上无误杀', supFP === 0, `FP=${supFP}`);
check('改口覆盖召回率 ≥ 70%', supM.r >= 0.7, pct(supM.r));
check('重复观察无误合并(改口不被当重复)', twFP === 0, `FP=${twFP}`);
check('重复观察召回率 ≥ 60%', twM.r >= 0.6, pct(twM.r));

/* ── B. 遗忘可逆:端到端跑一遍 45 天 ───────────────────────── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cons-'));
const store = new ConsolidatedStore(dir, logger);
store.load();
const t0 = Date.now();
const mk = (id, content, conf, status = 'active') => ({
  id, userKey: null, type: 'stable-fact', content, sourceIds: ['r'],
  confidence: conf, status, createdAt: t0, updatedAt: t0, touchCount: 0,
});
const seed = [
  ['m1', '用户住在杭州,在西湖区上班', 0.35],
  ['m2', '用户养了一只叫煤球的黑色英短猫', 0.35],
  ['m3', '用户的女朋友叫小雅,在医院做检验科医生', 0.35],
  ['m4', '用户对芒果过敏,吃芒果会起疹子', 0.9],
  ['m5', '用户下个月要去成都出差三天', 0.35],
];
for (const [id, content, conf] of seed) store.upsert(mk(id, content, conf));
const forgetOpts = { confidenceThreshold: 0.4, dormantDays: 30 };
const t45 = t0 + 45 * DAY;
let slept = 0;
for (const [id] of seed) {
  const m = store.get(id);
  if (isDormant(m, t45, forgetOpts)) { m.status = 'dormant'; slept += 1; }
}
check('B. 45 天后低置信条目进入休眠', slept === 4, `${slept}/4(高置信的 m4 不该睡)`);
check('B. 高置信条目不被遗忘', store.get('m4').status === 'active');

// 用户又提起「成都出差」→ 这条该被唤醒;其余不碰。
// 这里刻意只放一条能唤得醒的证据:唤醒靠字符相似度(reviveSimilarity 默认 0.15),
// 「我家猫最近掉毛厉害」与「养了一只叫煤球的黑色英短猫」几乎没有共同字面,
// 硬要求它唤醒等于要求这个启发式做语义理解——那是 Roadmap 里嵌入模型的事。
// 评测只对当前实现承诺的能力打分,不给自己发安慰奖。
const evidence = ['下个月成都那趟出差要准备什么'];
const injected = [];
let revivedSoFar = 0;
const revived = [];
for (const [id] of seed) {
  const m = store.get(id);
  const d = decideInjection(m, evidence, { reviveSimilarity: 0.15, maxInject: 2 }, revivedSoFar);
  if (d.revived) { revivedSoFar += 1; revived.push(id); }
  if (d.inject) injected.push(id);
}
check('B. 相关休眠条目被唤醒', revived.includes('m5'), revived.join(',') || '无');
check('B. 唤醒条数受本轮注入上限约束', injected.filter((id) => id !== 'm4').length <= 2, injected.join(','));
check('B. 无关休眠条目保持休眠',
  !revived.includes('m1') && !revived.includes('m3'), revived.join(',') || '无');
check('B. 高置信条目照常注入', injected.includes('m4'));
// 唤醒是「复活」不是「无视上限全塞进去」:上限只约束附带注入的条数
check('B. 被唤醒的条目本身仍然注入', injected.includes('m5'));

/* ── C. 联想扩散:关联话题到达率 ───────────────────────────── */
// 造一条真实对话里常见的联想链:咖啡 → 咖啡因失眠 → 睡前刷手机
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-diff-'));
const g = new ConsolidatedStore(d2, logger);
g.load();
for (const [id, content] of [
  ['k1', '用户喜欢喝冰美式咖啡'],
  ['k2', '用户下午喝咖啡会失眠'],
  ['k3', '用户每天睡前要刷半小时手机'],
  ['k4', '用户对芒果过敏'],
]) g.upsert(mk(id, content, 0.8));
// 同一轮巩固里反复共现 → 强边;k4 与谁都不共现
g.addLink('k1', 'k2', '同轮巩固', t0);
g.addLink('k1', 'k2', '同轮巩固', t0);
g.addLink('k2', 'k3', '同轮巩固', t0);
g.addLink('k2', 'k3', '同轮巩固', t0);
const dOpts = { hop1Min: 2, hop2Min: 2, minScore: 1, maxHop1: 2, maxHop2: 1 };
const reached = g.diffuse('k1', dOpts, t0);
check('C. 一跳带出强共现话题', reached.some((x) => x.id === 'k2' && x.hop === 1));
check('C. 两跳带出弱关联话题', reached.some((x) => x.id === 'k3' && x.hop === 2));
check('C. 无关联话题不被硬拉进来', reached.every((x) => x.id !== 'k4'));
check('C. 扩散不返回起点', reached.every((x) => x.id !== 'k1'));
// 联想会淡忘:90 天后同一条链不再扩散
const stale = g.diffuse('k1', dOpts, t0 + 90 * DAY);
check('C. 久未共现的联想自然淡出', stale.length === 0, `${stale.length} 条`);

/* ── D. 置信度动态化:一条记忆的成长轨迹 ───────────────────── */
const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-conf-'));
const c = new ConsolidatedStore(d3, logger);
c.load();
c.upsert(mk('x1', '用户住在杭州', 0.35, 'dormant'));
const trail = [0.35];
for (let i = 0; i < 3; i += 1) {
  c.touch('x1', t0 + i * 1000, forgetOpts);
  trail.push(Number(c.get('x1').confidence.toFixed(2)));
}
c.reinforceMany(['x1'], t0 + 5000, forgetOpts);
trail.push(Number(c.get('x1').confidence.toFixed(2)));
check('D. 命中让置信度单调上升', trail.every((v, i) => i === 0 || v >= trail[i - 1]), trail.join(' → '));
// trail = [初始, 命中1, 命中2, 命中3, 强化];强化那一步的增量应大于任一次命中
check('D. 重复观察比单次命中抬得更多',
  trail[4] - trail[3] > trail[1] - trail[0], trail.join(' → '));
check('D. 置信度封顶 0.95', (() => {
  for (let i = 0; i < 40; i += 1) c.reinforceMany(['x1'], t0 + 9000, forgetOpts);
  return c.get('x1').confidence === 0.95;
})());
check('D. 强化后休眠条目回到 active', c.get('x1').status === 'active');

for (const d of [dir, d2, d3]) fs.rmSync(d, { recursive: true, force: true });

/* ── 汇总 ─────────────────────────────────────────────────── */
const total = 4 + 5 + 4 + 4;
if (failures.length) {
  console.log(`\n✗ ${failures.length} 项失败:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\n✓ 全部 ${total} 项通过(改口 F1 ${pct(supM.f)} / 强化 F1 ${pct(twM.f)})\n`);
