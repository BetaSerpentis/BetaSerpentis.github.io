/**
 * CardQueryEngine 测试。
 *
 * 重点覆盖用户确认的三条口径：
 *   1. 减费按**理论上限**算（动态量取可达上限）
 *   2. 「1能」= **恰好 1 能**（≤1 需明说「1能以下」）
 *   3. 「1能」只管**数量**不管属性（1 火能/水能/恶能… 都算 1 能）
 * 以及用户给的两个真实例子。
 *
 * 运行：npm run test:ptcg-query
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardQueryEngine, REDUCTION_CAP } from '../js/core/CardQueryEngine.js';
import { SearchIntentParser, sanitizeConditions, extractJson } from '../js/services/SearchIntentParser.js';
import { CardManager } from '../js/core/CardManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PTCG = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`    ${String(err.message).split('\n')[0]}`);
    fail++;
    process.exitCode = 1;
  }
}

// node 侧用 fs 代替 fetch（浏览器里走默认实现）
const engine = new CardQueryEngine({
  loadText: async url => fs.readFileSync(path.join(PTCG, url), 'utf8'),
});
await engine.load();

await test('引擎加载完成：卡池与环境标记', () => {
  assert.ok(engine.cards.size > 12000, `卡池过小: ${engine.cards.size}`);
  // 用户更正后的环境是 G/H/I/J，A-F 已退
  assert.deepEqual(engine.envMarks, ['G', 'H', 'I', 'J']);
  assert.ok(engine.retiredMarks.includes('F'), 'F 应属于退环境');
});

await test('口径1：动态减费按理论上限（炽焰咆哮虎ex RCCCC → 1能）', () => {
  const card = engine.cards.get('CSV7C-047');
  assert.ok(card, '找不到 CSV7C-047 炽焰咆哮虎ex');
  assert.equal(card.name, '炽焰咆哮虎ex');
  assert.equal(card.mark, 'H', '炽焰咆哮虎ex 应为 H 标');
  assert.equal(card.costs, 'RCCCC', '消耗应为 RCCCC');
  // 特性：减少的无色数量 = 对手备战数量 → 上限 5；无色有 4 个 → 可全减 → 剩 1 火
  assert.equal(engine.colorlessReductionCap('CSV7C-047'), REDUCTION_CAP.opponent_bench_count);
  assert.deepEqual(engine.minimalAttackCosts('CSV7C-047'), [1]);
  // 同名另两印同结论
  for (const id of ['CSV7C-214', 'SVP-177']) {
    assert.deepEqual(engine.minimalAttackCosts(id), [1], `${id} 也应是 1 能`);
  }
});

await test('口径1：固定减费（黑带类 amount=1 是道具，不计入自身特性）', () => {
  // 8 条 amount=1 的减费都在 pokemon-tool 上，属于需要附着的前提 → 不算
  const toolIds = ['CSM2DC-278', 'CSM2bC-133'];
  for (const id of toolIds) {
    assert.equal(engine.colorlessReductionCap(id), 0, `${id} 是道具，不应计入宝可梦自身减费`);
  }
});

await test('口径2：「1能」= 恰好 1 能，不等于 ≤1', () => {
  const exactly1 = engine.query({ types: ['宝可梦'], attackCostExactly: 1 });
  const atMost1 = engine.query({ types: ['宝可梦'], attackCostAtMost: 1 });
  // ≤1 必然包含恰好1 的结果，且不少于它
  assert.ok(exactly1.length > 0, '恰好 1 能的结果不应为空');
  assert.ok(atMost1.length >= exactly1.length, '≤1 的结果数应不少于恰好1');
  // 恰好1 的每张卡都必须真的存在一个「折算后 == 1」的招式
  for (const c of exactly1.slice(0, 50)) {
    assert.ok(c.minCosts.includes(1), `${c.name} 应存在恰好 1 能的招式，实际 ${JSON.stringify(c.minCosts)}`);
  }
});

await test('口径3：「1能」只管数量不管属性', () => {
  // 消耗 R（1 个火）也算 1 能：如 151C-021 类只需 1 个能量的招式
  const one = engine.query({ types: ['宝可梦'], attackCostExactly: 1 });
  const hasAnySingleSymbol = one.some(c => /^[A-Za-z]$/.test(String(c.costs || '').trim()));
  assert.ok(hasAnySingleSymbol, '应存在消耗为单个符号（任意 1 能）的宝可梦');
  // 属性不参与判定：同一张卡无论什么属性都应能被「1能」查到
  const attrs = new Set(one.map(c => c.attr));
  assert.ok(attrs.size >= 5, `命中结果应覆盖多种属性（说明没按属性过滤），实际 ${[...attrs].join('/')}`);
});

await test('例1：撤退能量为4的基础宝可梦', () => {
  const res = engine.query({ types: ['宝可梦'], stage: 0, retreat: 4 });
  assert.ok(res.length > 100, `命中过少: ${res.length}`);
  for (const c of res) {
    assert.equal(c.type, '宝可梦');
    assert.equal(c.stage, 0, `${c.name} 应为基础`);
    assert.equal(c.retreat, 4, `${c.name} 撤退应为 4`);
  }
  // 抽查一个已知：大岩蛇（基础、撤退4）
  assert.ok(res.some(c => c.name === '大岩蛇'), '应包含大岩蛇');
});

await test('例2：环境内需要1能就能使用招式的2阶进化宝可梦', () => {
  const res = engine.query({ types: ['宝可梦'], stage: 2, env: true, attackCostExactly: 1 });
  assert.ok(res.length > 0, '结果不应为空');
  for (const c of res) {
    assert.equal(c.stage, 2, `${c.name} 应为 2 阶进化`);
    assert.ok(engine.envMarks.includes(c.mark), `${c.name} 标记 ${c.mark} 应属于当前环境`);
    assert.ok(c.minCosts.includes(1), `${c.name} 应存在折算后恰好 1 能的招式`);
  }
  // 用户特别指出的例子必须命中
  const incineroar = res.find(c => c.id === 'CSV7C-047');
  assert.ok(incineroar, '炽焰咆哮虎ex（CSV7C-047）必须被「环境内 + 2阶 + 1能」命中');
  // 退环境的同名卡不应命中：CS6aC-052 炽焰咆哮虎 是 F 标，但它是 2 阶且招式消耗 R,RR
  const fMark = res.find(c => c.id === 'CS6aC-052');
  assert.ok(!fMark, 'F 标卡不应出现在「环境内」结果里');
});

await test('环境过滤：F 标应被排除（用户更正的 G/H/I/J）', () => {
  const fOnly = engine.query({ marks: ['F'] });
  assert.ok(fOnly.length > 0, 'F 标卡应仍存在于卡池（只是不算标准环境）');
  const envRes = engine.query({ env: true });
  assert.ok(envRes.every(c => c.mark !== 'F'), '环境查询不应包含 F 标');
});

await test('条件组合：类型 / 阶段 / HP / 属性', () => {
  const res = engine.query({ types: ['宝可梦'], stage: 0, hp: { op: '>=', value: 200 } });
  assert.ok(res.length > 0);
  for (const c of res) {
    assert.equal(c.stage, 0);
    assert.ok(c.hp >= 200, `${c.name} HP=${c.hp} 应 >=200`);
  }
  const fire = engine.query({ types: ['宝可梦'], attr: '火', stage: 0 });
  assert.ok(fire.length > 0);
  assert.ok(fire.every(c => c.attr === '火'));
});


// ============================================================
//  意图解析的安全边界：绝不信任模型输出（白名单校验）
// ============================================================

await test('sanitizeConditions：正常条件被保留', () => {
  const c = sanitizeConditions({
    types: ['宝可梦'], stage: 2, env: true,
    retreat: { op: '>=', value: 2 }, attackCostExactly: 1, keyword: '咆哮',
  });
  assert.deepEqual(c, {
    types: ['宝可梦'], stage: 2, env: true,
    retreat: { op: '>=', value: 2 }, attackCostExactly: 1, keyword: '咆哮',
  });
});

await test('sanitizeConditions：越界/非法字段被丢弃', () => {
  const c = sanitizeConditions({
    types: ['宝可梦', '不存在的类型'],
    stage: 9,
    env: 'yes',
    retreat: { op: 'DROP TABLE', value: 3 },
    hp: { op: '<=', value: 99999 },
    attackCostExactly: 99,
    attackCostAtMost: -1,
    keyword: 'x'.repeat(100),
    evil: 'rm -rf',
  });
  assert.deepEqual(c.types, ['宝可梦'], '非法类型应被过滤');
  assert.equal(c.stage, undefined, '越界 stage 应被丢弃');
  assert.equal(c.env, undefined, '非布尔 env 应被丢弃');
  assert.deepEqual(c.retreat, { op: '=', value: 3 }, '非法 op 应回退为 =');
  assert.equal(c.hp, undefined, '越界 hp 应被丢弃');
  assert.equal(c.attackCostExactly, undefined, '越界 attackCostExactly 应被丢弃');
  assert.equal(c.attackCostAtMost, undefined, '负数 attackCostAtMost 应被丢弃');
  assert.equal(c.keyword.length, 40, 'keyword 应截断到 40 字');
  assert.equal(c.evil, undefined, '未知字段不应出现');
});

await test('sanitizeConditions：非对象输入返回空条件', () => {
  for (const bad of [null, undefined, 'text', 42, [], true]) {
    assert.deepEqual(sanitizeConditions(bad), {});
  }
});

await test('extractJson：能从 Markdown 代码块/夹带说明里抠出 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json' + String.fromCharCode(10) + '{"a":1}' + String.fromCharCode(10) + '```'), { a: 1 });
  assert.deepEqual(extractJson('好的：' + String.fromCharCode(10) + '{"a":1}' + String.fromCharCode(10) + '完毕'), { a: 1 });
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson('{坏掉的'), null);
});

await test('解析器无 API Key 时返回 null（调用方回退关键词搜索）', async () => {
  const p = new SearchIntentParser({ getApiKey: () => null, getSettings: () => ({}) });
  assert.equal(p.hasApiKey(), false);
  assert.equal(await p.parse('撤退能量为4的基础宝可梦'), null);
});


// ============================================================
//  渲染契约：外部筛选结果必须映射回「带 image 的完整卡片对象」
//  （曾经直接把 CardQueryEngine 的查询对象塞进 filteredCards，
//    导致 CardGrid 取不到 card.image，整片卡图显示「加载失败」）
// ============================================================

await test('setExternalFilter：只输出当前已加载的完整卡片对象（含 image）', () => {
  const cm = Object.create(CardManager.prototype);
  cm.cards = [
    { id: 'A-1', name: '甲', image: '/img/a.webp', quantity: 2 },
    { id: 'A-2', name: '乙', image: '/img/b.webp', quantity: 0 },
  ];
  // 引擎结果只带查询字段，没有 image
  const engineOut = engine.query({ types: ['宝可梦'], stage: 0, retreat: 4 }).slice(0, 3).map(c => ({ ...c }));
  delete engineOut[0].image;
  const out = cm.setExternalFilter([{ id: 'A-1', name: '甲', retreat: 4 }, { id: 'Z-9', name: '不在当前页签' }]);
  assert.equal(out.length, 1);
  assert.ok(out.every(c => typeof c.image === 'string' && c.image), '渲染对象必须带 image');
  assert.ok(out.every(c => 'quantity' in c), '统计模式需要 quantity');
  assert.equal(cm._lastExternalFilterMissing, 1, '映射不到的应计数并提示');
});

await test('引擎产出对象本身不含 image（所以必须经过 setExternalFilter 映射）', () => {
  const one = engine.query({ types: ['宝可梦'], limit: 1 })[0];
  assert.ok(one && one.id);
  assert.equal(one.image, undefined, '引擎只产出查询字段，渲染字段由 CardManager 补');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

await test('效果文本检索：特性含「雷能量」的宝可梦（归一化命中【雷】能量）', () => {
  const res = engine.query({ types: ['宝可梦'], abilityText: ['雷能量'] });
  assert.ok(res.length > 0, '应有结果');
  for (const c of res) {
    const hay = (c.abilityTexts || []).join('\n').replace(/[【】\s]/g, '');
    assert.ok(hay.includes('雷能量'), `${c.name} 的特性文本应含雷能量`);
  }
});

await test('效果文本检索：数组语义 = 任一命中（雷能量 或 基本能量）', () => {
  const only = engine.query({ types: ['宝可梦'], abilityText: ['雷能量'] });
  const both = engine.query({ types: ['宝可梦'], abilityText: ['雷能量', '基本能量'] });
  assert.ok(both.length >= only.length, 'OR 语义结果不应少于单一条件');
  for (const c of both) {
    const hay = (c.abilityTexts || []).join('\n').replace(/[【】\s]/g, '');
    assert.ok(hay.includes('雷能量') || hay.includes('基本能量'), `${c.name} 应命中任一关键词`);
  }
});

await test('效果文本检索：attackText / textAny 的范围区分', () => {
  const attack = engine.query({ types: ['宝可梦'], attackText: ['雷能量'] });
  assert.ok(attack.length > 0, '招式文本应有结果');
  for (const c of attack) {
    const hay = (c.attackTexts || []).join('\n').replace(/[【】\s]/g, '');
    assert.ok(hay.includes('雷能量'), `${c.name} 的招式文本应含雷能量`);
  }
  const any = engine.query({ types: ['宝可梦'], textAny: ['转附'] });
  assert.ok(any.length > 0, 'textAny 应有结果');
  const nameOnly = engine.query({ types: ['宝可梦'], abilityName: ['引雷'] });
  assert.ok(nameOnly.length > 0, '特性名检索应有结果');
  for (const c of nameOnly) assert.ok((c.abilityNames || []).join('').includes('引雷'));
});

await test('sanitizeConditions：效果文本字段保留并清理非法项', () => {
  const c = sanitizeConditions({
    types: ['宝可梦'],
    abilityText: ['雷能量', '', 123, '   '],
    attackText: '附着',
    textAny: ['转附', '雷'],
    abilityName: ['引雷'],
  });
  assert.equal(c.abilityText, '雷能量', '数组收敛为单字符串');
  assert.equal(c.attackText, '附着');
  assert.deepEqual(c.textAny, ['转附', '雷']);
  assert.equal(c.abilityName, '引雷');
  const bad = sanitizeConditions({ abilityText: [1, null, {}, 'x'.repeat(50)] });
  assert.equal(bad.abilityText, 'x'.repeat(24), '超长截断、非法项丢弃');
});
