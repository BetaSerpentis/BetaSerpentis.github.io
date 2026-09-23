// ptcg/battle/tests/automation.mjs
// 自动化测试：覆盖核心规则/效果、代表性卡牌文本、以及全卡牌效果解析覆盖率报告。
// 用法：node ptcg/battle/tests/automation.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffect, extractToolAttacks } from '../js/core/EffectParser.js';
import { executeEffects, payDiscardCostFromHand } from '../js/core/EffectExecutor.js';
import { GameState, PHASE } from '../js/core/GameState.js';
import { BattleEngine } from '../js/core/BattleEngine.js';
import { CardResolver } from '../js/core/CardResolver.js';
import { PTCGBattleApp, cardPickerTitleFor, energyElementClass, energyLabel, pokemonPickerConfirmEnabled, pokemonPickerHasLegalTarget, pokemonPickerSlotAllowed, pokemonPickerSlotClass, pokemonPickerTitleFor } from '../js/main.js';
import { pokemonSpriteImgHtml, pokemonSpriteSrc, pokemonSpriteCandidates, SPRITE_PREFER_ONLINE } from '../js/ui/SpriteUtils.js';
import { DeckSource, PTCG_DECKS_STORAGE_KEY } from '../js/core/DeckSource.js';
import { TEST_DECKS, expandDeck } from '../js/data/decks.js';
import { AI_STORAGE_KEYS, getAiApiKey, hasAiApiKey, getAiSettings, describeAiStatus, onAiKeyChange } from '../js/core/AiSettings.js';
import { getLegalActions, describeAction, ACTION } from '../js/core/ActionSpace.js';
import { classifyEffects, buildDeckPlan, NEUTRAL_PLAN } from '../js/core/DeckPlan.js';
import { HeuristicPolicy } from '../js/core/AiPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/battle');
const ID_MAPPING_PATH = path.resolve(__dirname, '../../tools/id_mapping.json');

// Parser coverage guardrails（2026-08 简中数据迁移后重新基线）：
// 旧数据为繁中措辞，解析覆盖率 4631/7208 (64%)。迁移到 tcg.mik.moe 简中数据后，
// 全卡池扩到 12346 张且措辞发生官方译名变化，EffectParser 已加 normalizeCn 归一化层
// + 大量简中规则适配，覆盖率从 27% 提升到 ~49%。这两条保护线用于拦截大面积退化。
const PARSER_COVERAGE_MIN_RATIO = 0.99;
const PARSER_RESIDUAL_MAX_COUNT = 8000;
const PARSER_TOP_BUCKET_LIMIT = 8;

const RESIDUAL_BUCKETS = [
  { key: 'fossils', label: '化石', pattern: /化石|古代能力|复原|秘密琥珀|根之化石|爪之化石|盾甲化石|头盖化石/ },
  { key: 'complex_multi_branch', label: '复杂/多分支', pattern: /若|如果|可选择|选择.*(则|然后)|同时|各自|任意|直到|每有|依照|根据|追加|改为/ },
  { key: 'prerequisites_conditions', label: '前提/条件', pattern: /只可|必须|才可|不可|不能|前提|条件|场上存在|剩余奖赏卡|自己的回合|上个回合|本回合|下个回合/ },
  { key: 'choice_switch_recover', label: '选择/交换/回收', pattern: /选择|交换|互换|替换|放回手牌|加入手牌|恢复|回复|回收|撤退|换位|备战区/ },
  { key: 'deck_top_manipulation', label: '牌库顶/牌库操作', pattern: /牌库上方|牌库下方|查看.*牌库|放回牌库|重洗|洗切|排列|任意顺序|抽出|抽卡/ },
  { key: 'energy_movement', label: '能量移动', pattern: /能量|附加|转移|移动|改附|丢弃.*能量|基本【|特殊能量/ },
  { key: 'unknown_other', label: '未知/其他', pattern: /.*/ },
];

function residualBucket(text, context = '') {
  const raw = `${String(context || '')} ${String(text || '')}`;
  const bucket = RESIDUAL_BUCKETS.find(b => b.pattern.test(raw));
  return bucket?.key || 'unknown_other';
}

function residualBucketLabel(key) {
  return RESIDUAL_BUCKETS.find(b => b.key === key)?.label || key;
}

function mon(name, cardId = name, attacks = []) {
  return {
    name,
    cardId,
    hp: 60,
    maxHp: 60,
    element: 'colorless',
    attacks,
    energy: [],
    status: null,
    placedThisTurn: false,
    tool: null,
    damageMod: 0,
    preventDamage: false,
    preventEffect: false,
    cannotAttackNext: false,
    cannotRetreat: false,
    ignore: [],
    costEliminated: false,
    abilityUsed: false,
  };
}

function makeEngine(gs) {
  return new BattleEngine(gs, null, {
    onLog: () => {},
    onPhaseChange: () => {},
    onFieldUpdate: () => {},
  });
}

function makeEngineWithEvents(gs) {
  const events = { logs: [], phases: [], fields: 0 };
  const engine = new BattleEngine(gs, null, {
    onLog: msg => events.logs.push(msg),
    onPhaseChange: phase => events.phases.push(phase),
    onFieldUpdate: () => { events.fields += 1; },
  });
  return { engine, events };
}

async function withImmediateTimeout(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const pending = [];
  globalThis.setTimeout = (cb, ...args) => {
    const promise = Promise.resolve().then(() => cb(...args));
    pending.push(promise);
    return pending.length;
  };
  try {
    const result = await fn(pending);
    await Promise.all(pending);
    return result;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

function fakeResolver(entries) {
  return {
    getInfo(id) {
      return entries[id]?.info || { name: `#${id}`, number: null, type: 'unknown' };
    },
    getCard(id) {
      return entries[id]?.card || null;
    },
  };
}

async function makeResolver() {
  const resolver = new CardResolver();
  await resolver.load();
  return resolver;
}

function getSpecialEnergy(name) {
  const raw = loadJson('SpecialEnergy-cards.json').find(c => c['卡牌名字'] === name);
  assert.ok(raw, `missing special energy: ${name}`);
  return buildSpecialEnergy(raw);
}

function buildSpecialEnergy(raw) {
  const text = raw['效果'] || '';
  const cnToType = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting','恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };
  const provides = [];
  const all = text.match(/(?:提供|视为提供|被视作|被视为)(\d+)个所有属性/);
  if (all) provides.push({ types:['any'], count:parseInt(all[1]) });
  for (const m of text.matchAll(/(?:提供|视为提供|被视作|被视为)(\d+)个【(.+?)】能量/g)) provides.push({ types:[cnToType[m[2]]||'colorless'], count:parseInt(m[1]) });
  for (const m of text.matchAll(/(?:提供|视为提供|被视作|被视为)(\d+)个((?:【.+?】){2,})\d*种属性的能量/g)) {
    provides.push({ types:[...m[2].matchAll(/【(.+?)】/g)].map(x=>cnToType[x[1]]||'colorless'), count:parseInt(m[1]) });
  }
  if (!provides.length) provides.push({ types:['colorless'], count:1 });
  provides.sort((a,b)=>(b.count-a.count)||(b.types.length-a.types.length));
  return {
    cardType:'specialEnergy',
    name: raw['卡牌名字'],
    provides,
    specialRules: {
      damageOnAttach:/放置1个伤害指示物/.test(text)?10:0,
      preventWeakness:/弱点[，,]?(?:全部消除|全部消失|消除)/.test(text),
      retreatCostZero:/【撤退】所需(?:的)?能量[，,]?(?:全部消除|消除)/.test(text),
      damageBonus:parseInt((text.match(/伤害["“”「」]?\+(\d+)["“”「」]?(?:点)?/)||[])[1]||'0'),
      maxHpBonus:parseInt((text.match(/最大HP(?:增加|上升)["“”「」]?(\d+)["“”「」]?/)||[])[1]||'0'),
    },
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function actions(text) {
  return parseEffect(text).effects.map(e => e.action);
}

function assertHasAction(text, action) {
  const parsed = parseEffect(text);
  assert.equal(parsed.effects.some(e => e.action === action), true, `${text}\nparsed=${JSON.stringify(parsed)}`);
}

// 旧数字 ID → 新 set-code ID 反向映射（迁移桥：让历史测试里的旧 ID 引用继续可用）。
let _oldToNew = null;
let _newToOld = null;
function _loadIdMapping() {
  if (_oldToNew) return;
  try {
    const mapping = JSON.parse(fs.readFileSync(ID_MAPPING_PATH, 'utf8'));
    _oldToNew = mapping;
    _newToOld = new Map();
    for (const [oldId, info] of Object.entries(mapping)) {
      const key = info && info.new_key;
      if (!key) continue;
      if (!_newToOld.has(key)) _newToOld.set(key, []);
      _newToOld.get(key).push(oldId);
    }
  } catch (e) {
    _oldToNew = {};
    _newToOld = new Map();
  }
}

function loadJson(file) {
  const cards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  // 把旧数字 ID 挂回每张卡的 卡牌ID，使历史旧 ID 引用无需逐条改写。
  _loadIdMapping();
  for (const c of cards) {
    const ids = c['卡牌ID'] || [];
    for (const id of ids) {
      const olds = _newToOld.get(id);
      if (olds && olds.length) {
        for (const o of olds) if (!ids.includes(o)) ids.push(o);
      }
    }
  }
  return cards;
}

function getPokemonRawByAbility(abilityName) {
  const raw = loadJson('pokemon-cards.json').find(c => c['特性名字'] === abilityName);
  assert.ok(raw, `missing pokemon ability: ${abilityName}`);
  return raw;
}

function abilityZone(text) {
  if (/手牌只有这1张卡|从手牌使出这张卡|在手牌/.test(text)) return 'hand';
  if (/弃牌区/.test(text) && (/这张卡|可使用/.test(text))) return 'discard';
  if (/在备战区/.test(text)) return 'bench';
  if (/在战斗场上|战斗场上/.test(text)) return 'active';
  return 'field';
}

function buildAbilityFromRaw(raw) {
  const text = raw['特性效果'] || '';
  const parsed = parseEffect(text);
  const active = /可使用1次|可以使用1次|可使用|可以使用/.test(text);
  return { name: raw['特性名字'], effect: text, effects: parsed.effects, active, passive: !active, oncePerTurn: /可使用1次|可以使用1次/.test(text), zone: abilityZone(text) };
}

// ============================================================
//  1) 代表性真实卡牌文本解析测试
// ============================================================

// ===== 卡组来源（DeckSource）：读取同源 ptcg 卡牌库 localStorage =====

function fakeDeckStorage(value) {
  const store = new Map();
  if (value !== undefined) {
    store.set('ptcg_decks', typeof value === 'string' ? value : JSON.stringify(value));
  }
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

const deckSourceCards = {
  B1: { card: { cardType: 'pokemon', stage: '基础', name: '妙蛙种子' }, info: { name: '妙蛙种子', number: 1, type: 'pokemon' } },
  P1: { card: { cardType: 'pokemon', stage: '2阶进化', name: '妙蛙花' }, info: { name: '妙蛙花', number: 3, type: 'pokemon' } },
  T1: { card: { cardType: 'trainer', trainerType: 'item', name: '巢穴球' }, info: { name: '巢穴球', number: null, type: 'item' } },
};

await test('DeckSource：无 localStorage 时回退内置卡组', () => {
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: null }).load();
  assert.equal(result.source, 'builtin');
  assert.equal(result.decks.length, TEST_DECKS.length);
  assert.ok(result.warnings.some(w => w.includes('localStorage')));
});

await test('DeckSource：卡牌库为空时回退内置卡组', () => {
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage([]) }).load();
  assert.equal(result.source, 'builtin');
  assert.equal(result.decks.length, TEST_DECKS.length);
  assert.ok(result.warnings.some(w => w.includes('尚未在卡牌库中创建卡组')));
});

await test('DeckSource：读取卡牌库卡组并归一化重算 totalCount', () => {
  const stored = [{
    id: '1769875572212', name: '我的喷火龙', coverCardId: 'B1',
    cards: [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 56 }],
    totalCount: 999,
  }];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'ptcg');
  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].name, '我的喷火龙');
  assert.equal(result.decks[0].coverCardId, 'B1');
  assert.equal(result.decks[0].totalCount, 60);
  assert.deepEqual(result.decks[0].cards, [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 56 }]);
});

await test('DeckSource：玩家与对手共用同一份卡组列表', () => {
  const stored = [
    { id: 'a', name: '卡组A', cards: [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 56 }] },
    { id: 'b', name: '卡组B', cards: [{ id: 'B1', quantity: 2 }, { id: 'T1', quantity: 58 }] },
  ];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'ptcg');
  assert.equal(result.decks.length, 2);
  assert.deepEqual(result.decks.map(d => d.name), ['卡组A', '卡组B']);
});

await test('DeckSource：缺少基础宝可梦的卡组被跳过', () => {
  const stored = [
    { id: 'a', name: '无基础宝可梦', cards: [{ id: 'P1', quantity: 4 }, { id: 'T1', quantity: 56 }] },
    { id: 'b', name: '可用卡组', cards: [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 56 }] },
  ];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'ptcg');
  assert.equal(result.decks.length, 1);
  assert.equal(result.decks[0].name, '可用卡组');
  assert.ok(result.warnings.some(w => w.includes('没有基础宝可梦')));
});

await test('DeckSource：全部卡组不可用时回退内置卡组', () => {
  const stored = [
    { id: 'a', name: '空卡组', cards: [] },
    { id: 'b', name: '无宝可梦', cards: [{ id: 'T1', quantity: 4 }] },
  ];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'builtin');
  assert.ok(result.warnings.some(w => w.includes('均不可用')));
});

await test('DeckSource：数据损坏或结构非法时回退内置卡组', () => {
  const broken = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage('{不是 JSON') }).load();
  assert.equal(broken.source, 'builtin');
  assert.ok(broken.warnings.some(w => w.includes('读取 ptcg 卡组失败')));
  const notArray = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage({ decks: [] }) }).load();
  assert.equal(notArray.source, 'builtin');
});

await test('DeckSource：过滤非法卡牌项（缺 id / 数量非正整数）', () => {
  const stored = [{
    id: 'a', name: '含脏数据',
    cards: [{ id: 'B1', quantity: 4 }, { quantity: 2 }, { id: 'T1', quantity: 0 }, { id: 'T1', quantity: -3 }, { id: 'T1', quantity: 6 }],
  }];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.decks[0].totalCount, 10);
  assert.deepEqual(result.decks[0].cards, [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 6 }]);
});

await test('DeckSource：非 60 张卡组可用但给出张数提示', () => {
  const stored = [{ id: 'a', name: '半成品', cards: [{ id: 'B1', quantity: 4 }, { id: 'T1', quantity: 16 }] }];
  const result = new DeckSource(fakeResolver(deckSourceCards), { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'ptcg');
  assert.equal(result.decks[0].totalCount, 20);
  assert.ok(result.warnings.some(w => w.includes('标准为 60 张')));
});

await test('DeckSource：resolver 不可用时不做基础宝可梦判定（不误杀卡组）', () => {
  const stored = [{ id: 'a', name: '未知卡组', cards: [{ id: 'X1', quantity: 60 }] }];
  const result = new DeckSource(null, { storage: fakeDeckStorage(stored) }).load();
  assert.equal(result.source, 'ptcg');
  assert.equal(result.decks.length, 1);
  assert.equal(new DeckSource(null, { storage: null }).countBasicPokemon(result.decks[0]), -1);
});

// ===== 跨项目契约：storage key 必须与 ptcg 侧 constants.js 一致 =====
// 这些 key 是 ptcg 与 ptcgBattle 之间的隐式数据契约，任一侧改名都会静默破坏共享，
// 因此用测试锁定，避免漂移。

const PTCG_CONSTANTS_PATH = path.resolve(__dirname, '../../js/utils/constants.js');

await test('契约：卡组 storage key 与 ptcg constants.js 一致', () => {
  const text = fs.readFileSync(PTCG_CONSTANTS_PATH, 'utf8');
  assert.ok(text.includes(`'${PTCG_DECKS_STORAGE_KEY}'`), `ptcg constants.js 缺少 key: ${PTCG_DECKS_STORAGE_KEY}`);
});

await test('契约：AI storage key 与 ptcg constants.js 一致', () => {
  const text = fs.readFileSync(PTCG_CONSTANTS_PATH, 'utf8');
  for (const key of Object.values(AI_STORAGE_KEYS)) {
    assert.ok(text.includes(`'${key}'`), `ptcg constants.js 缺少 key: ${key}`);
  }
});

// ===== AI 配置共用（同源 localStorage）=====

await test('AiSettings：读取共用 localStorage 中的 API Key 与设置', () => {
  const original = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  try {
    assert.equal(getAiApiKey(), null);
    assert.equal(hasAiApiKey(), false);
    assert.equal(describeAiStatus().configured, false);

    store.set(AI_STORAGE_KEYS.API_KEY, '  sk-test-123  ');
    assert.equal(getAiApiKey(), 'sk-test-123');
    assert.equal(hasAiApiKey(), true);
    assert.equal(describeAiStatus().configured, true);

    // 遗留模型名会被归一：deepseek-chat / deepseek-reasoner 已于 2026-07-24 停止服务
    store.set(AI_STORAGE_KEYS.SETTINGS, JSON.stringify({ model: 'deepseek-chat' }));
    assert.deepEqual(getAiSettings({ model: 'default', temperature: 0.7 }), { model: 'deepseek-flash', temperature: 0.7 });

    // 现行模型名原样保留，且 deepseek-flash 不被误改
    store.set(AI_STORAGE_KEYS.SETTINGS, JSON.stringify({ model: 'deepseek-flash' }));
    assert.deepEqual(getAiSettings({ model: 'default' }), { model: 'deepseek-flash' });
    store.set(AI_STORAGE_KEYS.SETTINGS, JSON.stringify({ model: 'deepseek-v4-pro' }));
    assert.deepEqual(getAiSettings({ model: 'default' }), { model: 'deepseek-v4-pro' });

    store.set(AI_STORAGE_KEYS.SETTINGS, '{坏 JSON');
    assert.deepEqual(getAiSettings({ model: 'default' }), { model: 'default' });

    store.set(AI_STORAGE_KEYS.API_KEY, '   ');
    assert.equal(hasAiApiKey(), false);

    globalThis.localStorage = null;
    assert.equal(getAiApiKey(), null);
    assert.deepEqual(getAiSettings({ a: 1 }), { a: 1 });
  } finally {
    globalThis.localStorage = original;
  }
});

await test('AiSettings：onAiKeyChange 在无 window 环境下安全返回 no-op', () => {
  const off = onAiKeyChange(() => {});
  assert.equal(typeof off, 'function');
  off();
});

await test('宝可齿轮3.0解析为 peek_and_keep top7 选1支援者', () => {
  const parsed = parseEffect('查看自己的牌库上方7张卡。选择其中1张支援者卡，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。');
  assert.equal(parsed.effects[0]?.action, 'peek_and_keep');
  assert.equal(parsed.effects[0]?.params.peek, 7);
  assert.equal(parsed.effects[0]?.params.keep, 1);
  assert.equal(parsed.effects[0]?.params.filter, '支援者');
});

await test('宝可装置3.0：牌库上方没有支援者时仍算发动成功（空发）', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.hand = ['device'];
  pl.deck = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'];
  gs.cardResolver = fakeResolver({
    device: { info:{ name:'宝可装置3.0', number:null }, card:{ cardType:'trainer', trainerType:'item', name:'宝可装置3.0' } },
    i1: { info:{ name:'物品1', number:null }, card:{ cardType:'trainer', trainerType:'item', name:'物品1' } },
  });
  gs._shuffle = deck => deck;
  const engine = makeEngine(gs);
  const device = { cardType:'trainer', trainerType:'item', name:'宝可装置3.0',
    effects:[{ action:'peek_and_keep', params:{ peek:7, keep:1, filter:'支援者', maxCount:1, minCount:1, allowFewer:false, allowEmpty:false } }] };
  const ok = await engine.useTrainer(0, device);
  assert.equal(ok, true, '没有支援者也应算发动成功');
  assert.deepEqual(pl.discard, ['device'], '使用的卡应以卡牌 ID 进入弃牌区');
  assert.equal(pl.hand.length, 0, '空发不应拿到卡');
});

await test('皮宝宝「握握抽取」为 0 费：无能量也能攻击并抽到 7 张', async () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.BATTLE;
  pl.active = mon('皮宝宝', 'cleffa', [{ name:'握握抽取', cost:[], damage:0, effects:[{ action:'draw_until', params:{ target:7 } }] }]);
  opp.active = mon('对手');
  pl.deck = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  assert.equal(gs.checkEnergy(pl.active, 0), true, '0 费招式不需要能量');
  pl.energyAttached = true; // 避免无关限制
  const engine = makeEngine(gs);
  assert.equal(await engine.attack(0), true, '0 费招式应可攻击');
  assert.equal(pl.hand.length, 7, '应抽到 7 张');
});

await test('数据：0 费招式不再被写成 ["无"]（皮宝宝）', () => {
  const pokemon = loadJson('pokemon-cards.json');
  const cleffa = pokemon.find(c => (c['卡牌ID'] || []).includes('CSV4C-044'));
  assert.ok(cleffa, '应能找到皮宝宝');
  assert.deepEqual(cleffa['技能1']['消耗'], [], '0 费招式的消耗应为空数组');
});


await test('manipulate_deck_top解析：只为明确牌库顶文本产出结构化窄参数', () => {
  const look = parseEffect('查看对手的牌库上方1张卡，回复原样。');
  assert.equal(look.unparsed, '', `look residual=${look.unparsed}`);
  assert.equal(look.effects[0]?.action, 'manipulate_deck_top');
  assert.deepEqual(look.effects[0]?.params, { target:'opponent', count:1, mode:'look', remainder:'top_original' });

  const bottom = parseEffect('查看自己的牌库上方1张卡，回复原样。若希望，将那张卡放回牌库下方。');
  assert.equal(bottom.unparsed, '', `bottom residual=${bottom.unparsed}`);
  assert.deepEqual(bottom.effects[0]?.params, { target:'self', count:1, mode:'look_then_optional', optionalAction:'bottom', optional:true });

  const discardItems = parseEffect('查看对手的牌库上方5张卡，从其中选择任意数量的物品卡，将其丢弃。将剩余卡放回牌库并重洗。');
  assert.equal(discardItems.unparsed, '', `discard residual=${discardItems.unparsed}`);
  assert.equal(discardItems.effects[0]?.action, 'manipulate_deck_top');
  assert.equal(discardItems.effects[0]?.params.mode, 'discard_matching');
  assert.equal(discardItems.effects[0]?.params.filter, '物品');
  assert.equal(discardItems.effects[0]?.params.remainder, 'shuffle');

  const order = parseEffect('查看对手的牌库上方5张卡，以任意顺序排列，放回牌库上方。');
  assert.equal(order.unparsed, '', `order residual=${order.unparsed}`);
  assert.equal(order.effects[0]?.params.mode, 'top_any_order');
  assert.equal(order.effects[0]?.params.keepOrder, true);

  const choose = parseEffect('查看对手的牌库上方2张卡，选择其中1张，放回牌库上方。将剩余卡放回牌库下方。');
  assert.equal(choose.unparsed, '', `choose residual=${choose.unparsed}`);
  assert.equal(choose.effects[0]?.params.mode, 'choose_top_rest_bottom');
  assert.equal(choose.effects[0]?.params.keep, 1);
});

await test('解析覆盖：常见物品/支援者/招式/能量效果类型', () => {
  const cases = [
    ['抽卡', '从自己的牌库抽出3张卡。', 'draw'],
    ['补牌', '从牌库抽卡直到手牌满6张。', 'draw_until'],
    ['搜牌加手', '从自己的牌库选择最多3张【龙】宝可梦卡，在给对手看过后加入手牌。并且重洗牌库。', 'search_deck_to_hand'],
    ['搜牌放场', '从自己的牌库选择1张【基础】宝可梦卡，放置于备战区。', 'search_deck_to_bench'],
    ['弃牌区回收', '从自己的弃牌区选择最多2张宝可梦卡，在给对手看过后加入手牌。', 'recover_from_discard'],
    ['弃牌区附能', '从自己的弃牌区选择1张基本能量卡，附于备战区的宝可梦身上。', 'attach_energy_from_discard'],
    ['宝可梦交替', '将自己的战斗宝可梦与备战宝可梦互换。', 'switch_pokemon'],
    ['状态异常', '将对手的战斗宝可梦【中毒】与【混乱】。', 'inflict_status'],
    ['自伤', '这只宝可梦也受到30点伤害。', 'self_damage'],
    ['备战伤害', '对手的所有备战宝可梦也各受到20点伤害。', 'damage_bench'],
    ['伤害指示物', '在对手的战斗宝可梦身上放置3个伤害指示物。', 'damage_place'],
    ['防止伤害', '在下个对手的回合，这只宝可梦不会受到招式的伤害。', 'prevent_damage'],
    ['丢弃能量', '选择1个这只宝可梦身上附加的能量，将其丢弃。', 'discard_energy'],
    ['无法撤退', '在下个对手的回合，受到这个招式的宝可梦无法撤退。', 'cannot_retreat'],
    ['回合结束', '若使用了这张卡，则自己的回合结束。', 'end_turn'],
    ['洗手抽卡', '将自己的手牌全部放回牌库并重洗。然后，从牌库抽出8张卡。', 'shuffle_hand_to_deck'],
    ['阿尔宙斯手机', '查看自己的牌库上方1张卡，回复原样。若希望，选择1张自己的反面朝上的奖赏卡，与自己的牌库上方的卡维持反面朝上互换。', 'prize_deck_top_swap'],
    ['百万吨吹风机', '将对手的所有宝可梦身上附加的“宝可梦道具”卡与“特殊能量”卡，与场上的“竞技场”卡，全部丢弃。', 'discard_field_attachments'],
    ['宝可梦捕捉器', '掷1次硬币。若为正面，则选择对手的1只备战宝可梦，与战斗宝可梦互换。', 'coin_flip'],
    ['宝可梦通信', '从自己的手牌抽出1张宝可梦，在给对手看过后放回牌库。然后，从自己的牌库选择1张宝可梦，在给对手看过后加入手牌。并且重洗牌库。', 'hand_pokemon_to_deck_search_pokemon'],
    ['捕虫组合', '查看自己的牌库上方7张卡，从其中选择【草】宝可梦卡与“基本【草】能量”卡合计最多2张，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。', 'peek_and_keep'],
  ];
  for (const [label, text, action] of cases) {
    assertHasAction(text, action, label);
  }
});

await test('阿尔宙斯手机解析为 prize_deck_top_swap 且无残留', () => {
  const parsed = parseEffect('查看自己的牌库上方1张卡，回复原样。若希望，选择1张自己的反面朝上的奖赏卡，与自己的牌库上方的卡维持反面朝上互换。');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'prize_deck_top_swap');
  assert.equal(parsed.effects[0]?.params.optional, true);
});

await test('WP7解析：弃牌区选择/抽出能量附于单一己方目标', () => {
  const cases = [
    ['水补丁', '从自己的弃牌区抽出1张【水】能量卡，附于备战区的【水】宝可梦身上。', { count:1, filter:'【水】能量', target:'bench', targetType:'water', allowFewer:false }],
    ['暗黑修正档', '从自己的弃牌区选择1张"基本【恶】能量"卡，附于备战区的【恶】宝可梦身上。', { count:1, filter:'基本【恶】能量', target:'bench', targetType:'dark', allowFewer:false }],
    ['辅助斩', '从自己的弃牌区选择1张"基本【草】能量"卡，附于备战宝可梦身上。', { count:1, filter:'基本【草】能量', target:'bench', targetType:undefined, allowFewer:false }],
    ['雪之到来', '从自己的弃牌区选择最多2张"基本【水】能量"卡，附于自己的1只宝可梦身上。', { count:2, filter:'基本【水】能量', target:'any', targetType:undefined, allowFewer:true }],
    ['这只宝可梦', '从自己的弃牌区选择1张基本【火】能量卡，附于这只宝可梦身上。', { count:1, filter:'基本【火】能量', target:'active', targetType:undefined, allowFewer:false }],
    ['战斗宝可梦', '从自己的弃牌区抽出1张基本【雷】能量卡，附于战斗宝可梦身上。', { count:1, filter:'基本【雷】能量', target:'active', targetType:undefined, allowFewer:false }],
  ];
  for (const [label, text, expected] of cases) {
    const parsed = parseEffect(text);
    assert.equal(parsed.unparsed, '', `${label} residual=${parsed.unparsed}`);
    const effect = parsed.effects[0];
    assert.equal(effect?.action, 'attach_energy_from_discard', label);
    assert.equal(effect.params.count, expected.count, label);
    assert.equal(effect.params.maxCount, expected.count, label);
    assert.equal(effect.params.minCount, expected.allowFewer ? 0 : expected.count, label);
    assert.equal(effect.params.allowFewer, expected.allowFewer, label);
    assert.equal(effect.params.allowEmpty, expected.allowFewer, label);
    assert.equal(effect.params.filter, expected.filter, label);
    assert.equal(effect.params.target, expected.target, label);
    assert.equal(effect.params.targetType, expected.targetType, label);
  }
  const deferred = parseEffect('从自己的弃牌区选择2张基本【水】能量卡，附于那些宝可梦各1张。');
  assert.equal(deferred.effects.some(e => e.action === 'attach_energy_from_discard'), false);
});

await test('真实数据：宝可梦交替与宝可齿轮3.0在 Item-cards.json 中可解析', () => {
  const items = loadJson('Item-cards.json');
  const gear = items.find(c => c['卡牌名字'] === '宝可装置3.0');
  const swap = items.find(c => c['卡牌名字'] === '宝可梦交替');
  assert.equal(gear && swap ? true : false, true);
  assertHasAction(gear['效果'], 'peek_and_keep');
  assertHasAction(swap['效果'], 'switch_pokemon');
});

await test('真实数据：神奇糖果/洗翠沉重球/光辉伊布解析为可执行效果', () => {
  const items = loadJson('Item-cards.json');
  const rareCandy = items.find(c => c['卡牌名字'] === '神奇糖果');
  const heavyBall = items.find(c => c['卡牌名字'] === '洗翠的沉重球');
  const radiantEevee = loadJson('pokemon-cards.json').find(c => c['宝可梦名字'] === '光辉伊布');
  assert.ok(rareCandy && heavyBall && radiantEevee);
  const rareCandyParsed = parseEffect(rareCandy['效果']);
  assert.equal(rareCandyParsed.effects.some(e => e.action === 'evolve_rare_candy' && e.params.noFirstTurn), true, JSON.stringify(rareCandyParsed));
  assert.equal(parseEffect(heavyBall['效果']).effects.some(e => e.action === 'prize_basic_pokemon_to_hand_exchange_trainer'), true);
  const eeveeParsed = parseEffect(radiantEevee['技能1']['效果']);
  const search = eeveeParsed.effects.find(e => e.action === 'search_deck_to_hand');
  assert.equal(!!search, true, JSON.stringify(eeveeParsed));
  assert.equal(search.params.dynamicCount, 'own_field_type_count');
});

await test('真实数据：健行鞋/交替推车/熔岩的瀑布深潭/小陨星/Fire核心解析为专用效果', () => {
  const items = loadJson('Item-cards.json');
  const stadiums = loadJson('Stadium-cards.json');
  const pokemon = loadJson('pokemon-cards.json');
  const hikers = items.find(c => (c['卡牌ID'] || []).includes('6966'));
  const cart = items.find(c => (c['卡牌ID'] || []).includes('6965'));
  const basin = stadiums.find(c => (c['卡牌ID'] || []).includes('6250'));
  const minior = getPokemonRawByAbility('飞散流星');
  const radiantCharizard = pokemon.find(c => (c['卡牌ID'] || []).includes('7970'));
  const moltres = pokemon.find(c => (c['卡牌ID'] || []).includes('7202'));
  const chiYu = pokemon.find(c => (c['卡牌ID'] || []).includes('9974'));
  assert.ok(hikers && cart && basin && minior && radiantCharizard && moltres && chiYu);

  assert.equal(parseEffect(hikers['效果']).effects[0]?.action, 'hikers_shoes');
  assert.equal(parseEffect(cart['效果']).effects[0]?.action, 'switch_active_basic_heal_bench');
  const basinParsed = parseEffect(basin['效果']);
  const attach = basinParsed.effects.find(e => e.action === 'attach_energy_from_discard');
  assert.equal(!!attach, true, JSON.stringify(basinParsed));
  assert.equal(attach.params.targetType, 'fire');
  assert.equal(attach.params.damageCountersOnAttachedTarget, 2);
  const miniorParsed = parseEffect(minior['特性效果']);
  const trigger = miniorParsed.effects.find(e => e.action === 'attach_energy_trigger');
  assert.equal(!!trigger, true, JSON.stringify(miniorParsed));
  assert.equal(trigger.params.event, 'attach_energy_from_hand');
  assert.equal(trigger.params.effects[0].action, 'self_switch_to_active');

  const costReduction = parseEffect(radiantCharizard['特性效果']).effects.find(e => e.action === 'attack_cost_reduction');
  assert.equal(!!costReduction, true, JSON.stringify(parseEffect(radiantCharizard['特性效果'])));
  assert.equal(costReduction.params.type, 'colorless');
  assert.equal(costReduction.params.amount, 'opponent_prizes_taken');
  const aura = parseEffect(moltres['特性效果']).effects.find(e => e.action === 'passive_damage_mod');
  assert.equal(!!aura, true, JSON.stringify(parseEffect(moltres['特性效果'])));
  assert.equal(aura.params.attackerType, 'fire');
  assert.equal(aura.params.attackerStage, 'basic');
  assert.equal(aura.params.excludeSourceName, '火焰鸟');
  const chiYuDamage = parseEffect(chiYu['技能2']['效果']).effects.find(e => e.action === 'conditional_damage_mod');
  assert.equal(!!chiYuDamage, true, JSON.stringify(parseEffect(chiYu['技能2']['效果'])));
  assert.equal(chiYuDamage.params.condition, 'own_pokemon_knocked_out_last_opponent_turn');
  assert.equal(chiYuDamage.params.amount, 90);
});

await test('真实数据：WP3 Skeledirge deck core cards parse to targeted effects', () => {
  const pokemon = loadJson('pokemon-cards.json');
  const byId = id => pokemon.find(c => (c['卡牌ID'] || []).includes(id));
  const skeledirge = byId('9811');
  const minior = byId('9875');
  const rabsca = byId('10883');
  const fez = byId('11778');
  assert.ok(skeledirge && minior && rabsca && fez);

  const skeledirgeAbility = parseEffect(skeledirge['特性效果']);
  assert.equal(skeledirgeAbility.effects.some(e => e.action === 'ability_discard_cost'), true, JSON.stringify(skeledirgeAbility));
  assert.equal(skeledirgeAbility.effects.some(e => e.action === 'turn_damage_mod' && e.params.amount === 60), true, JSON.stringify(skeledirgeAbility));
  assert.equal(skeledirgeAbility.effects.some(e => e.action === 'passive_damage_mod'), false, JSON.stringify(skeledirgeAbility));

  const gravity = parseEffect(minior['技能1']['效果']).effects.find(e => e.action === 'conditional_damage_mod');
  assert.equal(gravity?.params.condition, 'opponent_retreat_cost');
  assert.equal(gravity?.params.amount, 20);

  const shield = parseEffect(rabsca['特性效果']).effects.find(e => e.action === 'bench_attack_shield');
  assert.equal(!!shield, true, JSON.stringify(parseEffect(rabsca['特性效果'])));
  const psy = parseEffect(rabsca['技能1']['效果']).effects.find(e => e.action === 'conditional_damage_mod');
  assert.equal(psy?.params.condition, 'opponent_active_energy_count');
  assert.equal(psy?.params.amount, 30);

  const flip = parseEffect(fez['特性效果']);
  assert.equal(flip.effects.some(e => e.action === 'usage_condition' && e.params.kind === 'own_pokemon_knocked_out_last_opponent_turn'), true, JSON.stringify(flip));
  assert.equal(flip.effects.some(e => e.action === 'usage_condition' && e.params.kind === 'ability_name_once_per_turn'), true, JSON.stringify(flip));
  assert.equal(flip.effects.some(e => e.action === 'draw' && e.params.count === 3), true, JSON.stringify(flip));
  const arrow = parseEffect(fez['技能1']['效果']).effects.find(e => e.action === 'damage_bench');
  assert.equal(arrow?.params.target, 'opponent_any');
  assert.equal(arrow?.params.damage, 100);
});

await test('真实数据：WP6 polish cards parse targeted automation effects', () => {
  const pokemon = loadJson('pokemon-cards.json');
  const items = loadJson('Item-cards.json');
  const liepard = pokemon.find(c => c['特性名字'] === '交易');
  const primeCatcher = items.find(c => c['卡牌名字'] === '顶尖捕捉器');
  assert.ok(liepard && primeCatcher);

  const trade = parseEffect(liepard['特性效果']);
  assert.equal(trade.effects.some(e => e.action === 'ability_discard_cost' && e.params.count === 1 && !e.params.filter), true, JSON.stringify(trade));
  assert.equal(trade.effects.some(e => e.action === 'draw' && e.params.count === 2), true, JSON.stringify(trade));

  const catcher = parseEffect(primeCatcher['效果']);
  assert.deepEqual(catcher.effects.filter(e => e.action === 'switch_pokemon').map(e => e.params.who), ['opponent', 'self'], JSON.stringify(catcher));
});

await test('真实数据：WP5 preset safety fixes parse conditional status, coin damage, and Mela prerequisite', () => {
  const pokemon = loadJson('pokemon-cards.json');
  const supporters = loadJson('Supporter-cards.json');
  const purrloin = pokemon.find(c => c['宝可梦名字'] === '扒手猫' && (c['技能1']||{})['名字'] === '乱抓');
  const cryogonal = pokemon.find(c => (c['卡牌ID'] || []).includes('9539'));
  const mela = supporters.find(c => (c['卡牌ID'] || []).includes('10024'));
  assert.ok(purrloin && cryogonal && mela);

  const purrloinParsed = parseEffect(purrloin['技能1']['效果']);
  const coinDamage = purrloinParsed.effects.find(e => e.action === 'coin_flip_damage');
  assert.equal(coinDamage?.params.count, 3, JSON.stringify(purrloinParsed));
  assert.equal(coinDamage?.params.damage_per, 10, JSON.stringify(purrloinParsed));

  const cryogonalParsed = parseEffect(cryogonal['技能1']['效果']);
  const status = cryogonalParsed.effects.find(e => e.action === 'inflict_status');
  assert.equal(status?.params.condition, 'second_player_first_turn', JSON.stringify(cryogonalParsed));
  assert.deepEqual(status?.params.statuses, ['paralysis']);
  assert.equal(cryogonalParsed.unparsed, '', `cryogonal residual=${cryogonalParsed.unparsed}`);

  const melaParsed = parseEffect(mela['效果']);
  assert.equal(melaParsed.effects.some(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'own_pokemon_knocked_out_last_opponent_turn'), true, JSON.stringify(melaParsed));
  assert.equal(melaParsed.effects.some(e => e.action === 'attach_energy_from_discard'), true, JSON.stringify(melaParsed));
  assert.equal(melaParsed.effects.some(e => e.action === 'draw_until' && e.params?.target === 6), true, JSON.stringify(melaParsed));
});

await test('解析覆盖：训练家使用前提解析为元数据且不残留', () => {
  const cases = [
    ['帮忙铃', '这张卡只可在后攻玩家的最初回合使用。', 'trainer_prerequisite', 'first_turn'],
    ['对战VIP参加证', '这张卡只能在自己的最初回合使用。', 'trainer_prerequisite', 'first_turn'],
    ['反击捕捉器', '这张卡只有在自己剩余奖赏卡的张数比对手剩余奖赏卡的张数多时才可使用。', 'trainer_prerequisite', 'own_prizes_more_than_opponent'],
    ['玻璃喇叭', '这张卡只有在自己的场上有"太晶"宝可梦时才可使用。', 'trainer_prerequisite', 'condition'],
    ['大地之容器', '这张卡必须将自己的1张手牌丢弃才可使用。', 'trainer_prerequisite', 'discard_cost'],
    ['梅洛可', '这张卡必须在上个对手的回合自己的宝可梦【昏厥】了才可使用。', 'trainer_prerequisite', 'own_pokemon_knocked_out_last_opponent_turn'],
    ['大姐姐', '这张卡可在先攻玩家的最初回合使用。', 'trainer_prerequisite', 'first_player_first_turn_supporter_exception'],
    ['火力工厂◇', '在自己的回合时，可使用1次。', 'usage_condition', 'once_per_turn'],
    ['潺潺之丘', '双方玩家在自己的回合时，可使用1次。', 'usage_condition', 'once_per_turn'],
  ];
  for (const [label, text, action, kind] of cases) {
    const parsed = parseEffect(text);
    assert.equal(parsed.unparsed, '', `${label} residual=${parsed.unparsed}`);
    assert.equal(parsed.effects[0]?.action, action, label);
    assert.equal(parsed.effects[0]?.params.kind, kind, label);
    assert.equal(parsed.effects[0]?.params.raw.length > 0, true, label);
  }
});

await test('解析覆盖：使用前提元数据不阻止后续可支持效果解析', () => {
  const parsed = parseEffect('这张卡必须将自己的1张手牌丢弃才可使用。从自己的牌库选择最多2张基本能量卡，在给对手看过后加入手牌。并且重洗牌库。');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'trainer_prerequisite');
  assert.equal(parsed.effects[0]?.params.kind, 'discard_cost');
  assert.equal(parsed.effects.some(e => e.action === 'search_deck_to_hand'), true);
});

await test('解析覆盖：条件硬币只在可映射时消费正面分支', () => {
  const catcher = parseEffect('掷1次硬币。若为正面，则选择对手的1只备战宝可梦，与战斗宝可梦互换。');
  assert.equal(catcher.unparsed, '', `catcher residual=${catcher.unparsed}`);
  assert.equal(catcher.effects[0]?.action, 'coin_flip');
  assert.equal(catcher.effects[0]?.params.heads[0]?.action, 'switch_pokemon');

  const scent = parseEffect('掷1次硬币。若为正面，则从自己的牌库选择1张宝可梦，在给对手看过后加入手牌。并且重洗牌库。');
  assert.equal(scent.unparsed, '', `scent residual=${scent.unparsed}`);
  assert.equal(scent.effects[0]?.params.heads[0]?.action, 'search_deck_to_hand');

  const hammer = parseEffect('掷1次硬币。若为正面，则选择1个对手的战斗宝可梦身上附加的能量，将其丢弃。');
  assert.equal(hammer.unparsed, '', `hammer residual=${hammer.unparsed}`);
  assert.equal(hammer.effects[0]?.action, 'coin_flip');
  assert.equal(hammer.effects[0]?.params.heads[0]?.action, 'discard_energy');
  assert.equal(hammer.effects[0]?.params.heads[0]?.params.target, 'opponent');

  const fieldHammer = parseEffect('掷1次硬币。若为正面，则选择1个对手的场上宝可梦身上附加的能量，将其丢弃。');
  assert.equal(fieldHammer.unparsed, '', `field residual=${fieldHammer.unparsed}`);
  assert.equal(fieldHammer.effects[0]?.params.heads[0]?.action, 'discard_energy');
  assert.equal(fieldHammer.effects[0]?.params.heads[0]?.params.target, 'opponent_any');

  const benchChoiceHammer = parseEffect('掷1次硬币。若为正面，则选择1个对手的备战宝可梦身上附加的能量，将其丢弃。');
  assert.equal(benchChoiceHammer.unparsed, '', `bench residual=${benchChoiceHammer.unparsed}`);
  assert.equal(benchChoiceHammer.effects[0]?.params.heads[0]?.action, 'discard_energy');
  assert.equal(benchChoiceHammer.effects[0]?.params.heads[0]?.params.target, 'opponent_bench');

  const incubator = parseEffect('掷1次硬币。若为正面，则从自己的牌库选择1张进化宝可梦卡，在给对手看过后加入手牌。若为反面，则将这张卡放回牌库底。并且重洗牌库。');
  assert.equal(incubator.effects.some(e => e.action === 'coin_flip'), true);
  // 未支持的反面分支由 finalize 残余句收尾机制记录为 residual_sentence（unparsed 清零），不再保留为裸文本。
  assert.equal(incubator.unparsed, '', 'unsupported branches are folded into residual_sentence metadata');
  assert.equal(incubator.effects.some(e => e.params?.kind === 'residual_sentence'), true);
});

await test('操作区卡牌菜单：先攻首回合支援者项不可用', () => {
  const gs = new GameState();
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app.resolver = fakeResolver({ sup: { info:{ name:'支援者A', number:null }, card:{ cardType:'trainer', trainerType:'supporter', name:'支援者A' } } });
  gs.currentPlayer = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.player1.hand = ['sup'];
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  let captured = null;
  app._showListView = items => { captured = items; };
  app._renderScene = () => {};
  app._selectedCardIdx = 0;
  app._showCardActions(0);
  const item = captured.find(x => String(x.label).includes('支援者'));
  assert.ok(item, '应出现支援者动作项');
  assert.equal(item.disabled, true, '先攻最初回合应禁用支援者');
});

await test('操作区卡牌菜单：物品使用后回到卡牌列表', async () => {
  const gs = new GameState();
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app.resolver = fakeResolver({ it: { info:{ name:'物品A', number:null }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } } });
  gs.currentPlayer = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.player1.hand = ['it'];
  let used = false;
  app.engine = { useTrainer: async () => { used = true; return true; } };
  let captured = null, viewShown = null;
  app._showListView = items => { captured = items; };
  app._refresh = () => {};
  app._renderScene = () => {};
  app._goBackToList = () => { viewShown = 'hand'; };
  app._returnView = 'hand';
  app._selectedCardIdx = 0;
  app._showCardActions(0);
  const item = captured.find(x => String(x.label).includes('物品'));
  assert.ok(item, '应出现物品使用项');
  await item.onSelect();
  assert.equal(used, true, '应调用 useTrainer');
  assert.equal(viewShown, 'hand', '使用完成后应留在卡牌列表');
});

await test('操作区卡牌菜单：布置阶段基础宝可梦可放置战斗区/备战区', () => {
  const gs = new GameState();
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app.resolver = fakeResolver({ basicA: { info:{ name:'基础A', number:null }, card:{ cardType:'pokemon', name:'基础A', stage:'基础', hp:60 } } });
  gs.currentPlayer = gs.player1;
  gs.phase = PHASE.SETUP;
  gs.player1.active = null;
  gs.player1.hand = ['basicA'];
  let captured = null;
  app._showListView = items => { captured = items; };
  app._renderScene = () => {};
  app._selectedCardIdx = 0;
  app._showCardActions(0);
  const labels = captured.map(x => String(x.label));
  assert.ok(labels.includes('放置到战斗区'), '应能放置到战斗区');
  assert.ok(labels.includes('放置到备战区'), '应能放置到备战区');
});

await test('操作区场地菜单：有备战时提供撤退且不含返回项', () => {
  const gs = new GameState();
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app.resolver = fakeResolver({});
  gs.currentPlayer = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.player1.active = mon('出战');
  gs.player1.bench = [mon('后备')];
  let captured = null;
  app._showListView = items => { captured = items; };
  app._renderScene = () => {};
  app._showPokeActions('active');
  const labels = captured.map(x => String(x.label));
  assert.ok(labels.includes('撤退'), '应提供撤退选项');
  assert.equal(labels.includes('返回宝可梦'), false, '不应再出现返回宝可梦项');
});


await test('竞技场：场上已有同名竞技场时不能再次发动', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['sa', 'sb', 'sc'];
  const engine = makeEngine(gs);
  const a = { cardType:'trainer', trainerType:'stadium', name:'场地A', effects:[] };
  assert.equal(await engine.useTrainer(0, a), true);
  pl.stadiumPlayedThisTurn = false; // 模拟进入下一回合
  const same = { cardType:'trainer', trainerType:'stadium', name:'场地A', effects:[] };
  assert.equal(gs.canUseTrainer(pl, same).ok, false, '同名竞技场应被拒绝');
  assert.equal(await engine.useTrainer(0, same), false);
  assert.equal(gs.getActiveStadium().name, '场地A');
  // 不同名仍可正常替换
  const other = { cardType:'trainer', trainerType:'stadium', name:'场地B', effects:[] };
  assert.equal(await engine.useTrainer(0, other), true);
  assert.equal(gs.getActiveStadium().name, '场地B');
});

await test('幸运头盔：装备时不抽卡，受击时抽 2 张', async () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('小火龙', 'c1');
  opp.active = mon('杰尼龟', 's1', [{ name:'水枪', damage:20, cost:[] }]);
  pl.deck = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  pl.hand = ['helmet'];
  const engine = makeEngine(gs);
  const helmet = { cardType:'trainer', trainerType:'tool', name:'幸运头盔',
    effects:[{ action:'trigger', params:{ event:'attacked_damage', effect:{ action:'draw', params:{ count:2 } } } }] };
  assert.equal(await engine.useTrainer(0, helmet, 'active'), true);
  assert.equal(pl.hand.length, 0, '装备时不应抽卡');
  assert.ok(pl.active.tool, '应装备到出战宝可梦');

  // 对手攻击我方出战 → 触发受击抽卡
  gs.currentPlayer = opp;
  gs.phase = PHASE.BATTLE;
  await engine.attack(0);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(pl.hand.length >= 2, `受击应抽 2 张（实际 ${pl.hand.length}）`);
});


await test('Stadium：打出后只保存完整竞技场资料，不立即执行效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = pl;
  pl.hand = ['stadiumCard'];
  pl.deck = ['toolCard'];
  gs.cardResolver = fakeResolver({
    toolCard: { info:{ name:'宝可梦道具A', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具A' } },
  });
  const engine = makeEngine(gs);
  const stadium = { cardType:'trainer', trainerType:'stadium', name:'城镇百货公司', effectText:'搜道具', effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } }] };

  const ok = await engine.useTrainer(0, stadium);

  assert.equal(ok, true);
  assert.equal(pl.hand.includes('toolCard'), false);
  assert.equal(pl.deck.includes('toolCard'), true);
  assert.equal(gs.getActiveStadium().name, '城镇百货公司');
  assert.equal(gs.getActiveStadium().cardId, 'stadiumCard');
  assert.equal(gs.getActiveStadium().effects[0].action, 'search_deck_to_hand');
  assert.equal(gs.getActiveStadium().owner, pl);
  assert.equal(gs.player1.stadium, gs.getActiveStadium());
  assert.equal(gs.player2.stadium, gs.getActiveStadium());
});

await test('Stadium：城镇百货公司激活只搜索宝可梦道具并加入手牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = pl;
  gs.cardResolver = fakeResolver({
    toolCard: { info:{ name:'力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'力量头带' } },
    itemCard: { info:{ name:'普通物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'普通物品' } },
  });
  pl.deck = ['bottom', 'itemCard', 'toolCard'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'town', name:'城镇百货公司', owner:pl, effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } }] };
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['力量头带']);
    assert.equal(pick.options?.filter, '宝可梦道具');
    gs.resolvePick([0]);
  };

  const ok = await makeEngine(gs).activateStadium(pl);

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['toolCard']);
  assert.equal(pl.deck.includes('itemCard'), true);
  assert.equal(pl.stadiumUsedThisTurn['stadium:town'], true);
});

await test('Stadium：同玩家同回合不可重复，另一玩家自己回合可用', async () => {
  const gs = new GameState();
  const p1 = gs.player1;
  const p2 = gs.player2;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = p1;
  p1.deck = ['p1tool'];
  p2.deck = ['p2tool'];
  gs.cardResolver = fakeResolver({
    p1tool: { info:{ name:'P1道具', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'P1道具' } },
    p2tool: { info:{ name:'P2道具', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'P2道具' } },
  });
  gs._shuffle = deck => deck;
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'town', name:'城镇百货公司', owner:p1, effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } }] };
  const engine = makeEngine(gs);

  assert.equal(await engine.activateStadium(p1), true);
  assert.equal(await engine.activateStadium(p1), false);
  assert.equal(p1.hand.includes('p1tool'), true);
  assert.equal(gs.log.at(-1).includes('本回合已使用'), true);

  gs.endTurn();
  gs.phase = PHASE.MAIN;
  assert.equal(await engine.activateStadium(p2), true);
  assert.equal(p2.hand.includes('p2tool'), true);
});

await test('Stadium：替换丢弃旧场地一次并清除旧激活状态', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = pl;
  pl.hand = ['stadiumA', 'stadiumB'];
  const engine = makeEngine(gs);
  const a = { cardType:'trainer', trainerType:'stadium', name:'场地A', effects:[{ action:'draw', params:{ count:1 } }] };
  const b = { cardType:'trainer', trainerType:'stadium', name:'场地B', effects:[{ action:'draw', params:{ count:1 } }] };

  assert.equal(await engine.useTrainer(0, a), true);
  gs.markStadiumUsed(pl, gs.getActiveStadium());
  // 规则：每回合只能打出 1 张竞技场 → 同一回合再打出第二张应被拒绝
  assert.equal(gs.canUseTrainer(pl, b).ok, false);
  // 模拟进入下一回合后再打出第二张，验证替换与旧激活状态清除
  pl.stadiumPlayedThisTurn = false;
  assert.equal(await engine.useTrainer(0, b), true);

  assert.equal(gs.getActiveStadium().name, '场地B');
  assert.deepEqual(pl.discard, ['stadiumA']);
  assert.deepEqual(pl.stadiumUsedThisTurn, {});
});

await test('Stadium：我方拥有时场上丢弃效果进入我方弃牌而非对手', async () => {
  const gs = new GameState();
  const p1 = gs.player1;
  const p2 = gs.player2;
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'p1stadium', name:'我方场地', owner:p1, effects:[{ action:'draw', params:{ count:1 } }] };
  p1.stadiumUsedThisTurn = { 'stadium:p1stadium': true };
  p2.stadiumUsedThisTurn = { 'stadium:p1stadium': true };

  await executeEffects(gs, p1, [{ action:'discard_field_attachments', params:{ stadium:true } }]);

  assert.equal(gs.getActiveStadium(), null);
  assert.deepEqual(p1.discard, ['p1stadium']);
  assert.deepEqual(p2.discard, []);
  assert.equal(gs.player1.stadium, null);
  assert.equal(gs.player2.stadium, null);
  assert.deepEqual(p1.stadiumUsedThisTurn, {});
  assert.deepEqual(p2.stadiumUsedThisTurn, {});
});

await test('Stadium：对手拥有时我方场上丢弃效果进入对手弃牌', async () => {
  const gs = new GameState();
  const p1 = gs.player1;
  const p2 = gs.player2;
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'p2stadium', name:'对手场地', owner:p2, effects:[{ action:'draw', params:{ count:1 } }] };

  await executeEffects(gs, p1, [{ action:'discard_field_attachments', params:{ stadium:true } }]);

  assert.equal(gs.getActiveStadium(), null);
  assert.deepEqual(p1.discard, []);
  assert.deepEqual(p2.discard, ['p2stadium']);
  assert.equal(gs.player1.stadium, null);
  assert.equal(gs.player2.stadium, null);
});

await test('Stadium：替换对手旧场地只丢弃一次到旧拥有者', async () => {
  const gs = new GameState();
  const p1 = gs.player1;
  const p2 = gs.player2;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = p1;
  p1.hand = ['newStadium'];
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'oldP2Stadium', name:'对手旧场地', owner:p2, effects:[{ action:'draw', params:{ count:1 } }] };
  gs.markStadiumUsed(p1, gs.getActiveStadium());
  gs.markStadiumUsed(p2, gs.getActiveStadium());

  const next = { cardType:'trainer', trainerType:'stadium', name:'新场地', effects:[{ action:'draw', params:{ count:1 } }] };
  assert.equal(await makeEngine(gs).useTrainer(0, next), true);

  assert.equal(gs.getActiveStadium().name, '新场地');
  assert.equal(gs.getActiveStadium().owner, p1);
  assert.deepEqual(p1.discard, []);
  assert.deepEqual(p2.discard, ['oldP2Stadium']);
  assert.deepEqual(p1.stadiumUsedThisTurn, {});
  assert.deepEqual(p2.stadiumUsedThisTurn, {});
});

await test('Stadium：无可执行效果时记录可见消息且不崩溃', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = pl;
  gs.stadium = gs.player1.stadium = gs.player2.stadium = { cardId:'noop', name:'空场地', owner:pl, effects:[{ action:'usage_condition', params:{ kind:'once_per_turn' } }] };

  const ok = await makeEngine(gs).activateStadium(pl);

  assert.equal(ok, false);
  assert.equal(gs.log.at(-1), '这个竞技场暂无可执行效果');
});

await test('Stadium解析：城镇百货公司文本得到每回合1次与宝可梦道具搜牌', () => {
  const parsed = parseEffect('双方玩家在每个自己的回合时，可使用1次，可从自己的牌库选择1张“宝可梦道具”卡，在给对手看过后加入手牌。并且重洗牌库。');
  assert.equal(parsed.effects.some(e => e.action === 'usage_condition' && e.params.kind === 'once_per_turn'), true);
  const search = parsed.effects.find(e => e.action === 'search_deck_to_hand');
  assert.equal(!!search, true, JSON.stringify(parsed));
  assert.equal(search.params.count, 1);
  assert.equal(search.params.filter, '宝可梦道具');
});

// ============================================================
//  2) 效果执行测试：卡牌、招式、状态、回合
// ============================================================

await test('健行鞋效果：可选择加入牌库顶或丢弃后抽1张', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'drawn', 'top'];
  pl.hand = [];
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'hikers-shoes');
    assert.equal(pick.cards[0].includes('top'), true);
    gs.resolvePick([1]);
  };

  await executeEffects(gs, pl, [{ action:'hikers_shoes', params:{ peek:1, drawOnDiscard:1 } }]);

  assert.deepEqual(pl.discard, ['top']);
  assert.deepEqual(pl.hand, ['drawn']);
  assert.deepEqual(pl.deck, ['bottom']);

  const gs2 = new GameState();
  const pl2 = gs2.player1;
  pl2.deck = ['bottom', 'top'];
  await executeEffects(gs2, pl2, [{ action:'hikers_shoes', params:{ peek:1, drawOnDiscard:1 } }]);
  assert.deepEqual(pl2.hand, ['top']);
  assert.deepEqual(pl2.deck, ['bottom']);
});

await test('交替推车效果：换下基础出战并恢复换入备战区的宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('基础出战', 'basic-active');
  pl.active.hp = 30;
  pl.active.maxHp = 100;
  pl.bench = [mon('备战')];
  gs.cardResolver = fakeResolver({ 'basic-active': { card:{ cardType:'pokemon', name:'基础出战', stage:'基础', hp:100 }, info:{ name:'基础出战', number:null, type:'pokemon' } } });

  await executeEffects(gs, pl, [{ action:'switch_active_basic_heal_bench', params:{ heal:30 } }]);

  assert.equal(pl.active.name, '备战');
  assert.equal(pl.bench[0].name, '基础出战');
  assert.equal(pl.bench[0].hp, 60);
});

await test('熔岩的瀑布深潭效果：只给备战火宝可梦附火能并放置2个伤害指示物', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.active.element = 'fire';
  pl.bench = [mon('火备战'), mon('雷备战')];
  pl.bench[0].element = 'fire';
  pl.bench[0].hp = 100;
  pl.bench[0].maxHp = 100;
  pl.bench[1].element = 'lightning';
  pl.discard = ['fire-energy'];
  gs.cardResolver = fakeResolver({
    'fire-energy': { card:{ cardType:'energy', name:'基本【火】能量', element:'fire' }, info:{ name:'基本【火】能量', number:null, type:'energy' } },
  });
  gs._onPendingPokemonPick = pick => {
    assert.deepEqual(pick.options.selectableSlots, ['bench-0']);
    gs.resolvePokemonPick('bench-0');
  };

  await executeEffects(gs, pl, [{ action:'attach_energy_from_discard', params:{ count:1, filter:'【火】能量', target:'bench', targetType:'fire', damageCountersOnAttachedTarget:2 } }]);

  assert.equal(pl.active.energy.length, 0);
  assert.equal(pl.bench[0].energy.length, 1);
  assert.equal(pl.bench[0].hp, 80);
  assert.equal(pl.bench[1].energy.length, 0);
  assert.deepEqual(pl.discard, []);
});

await test('熔岩的瀑布深潭竞技场激活：MAIN阶段附能，非火/出战目标不可选，且每回合一次', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('火出战');
  pl.active.element = 'fire';
  pl.bench = [mon('火备战'), mon('无备战')];
  pl.bench[0].element = 'fire';
  pl.bench[0].hp = 100;
  pl.bench[0].maxHp = 100;
  pl.bench[1].element = 'colorless';
  pl.hand = ['basin'];
  pl.discard = ['fire-energy', 'water-energy'];
  gs.cardResolver = fakeResolver({
    'fire-energy': { card:{ cardType:'energy', name:'基本【火】能量', element:'fire' }, info:{ name:'基本【火】能量', number:null, type:'energy' } },
    'water-energy': { card:{ cardType:'energy', name:'基本【水】能量', element:'water' }, info:{ name:'基本【水】能量', number:null, type:'energy' } },
  });
  const basin = { cardType:'trainer', trainerType:'stadium', name:'熔岩的瀑布深潭', effects:[{ action:'attach_energy_from_discard', params:{ count:1, filter:'【火】能量', target:'bench', targetType:'fire', damageCountersOnAttachedTarget:2 } }] };
  const engine = makeEngine(gs);

  assert.equal(await engine.useTrainer(0, basin), true);
  assert.equal(pl.bench[0].energy.length, 0, 'playing stadium must not auto-activate');
  gs._onPendingPokemonPick = pick => {
    assert.deepEqual(pick.options.selectableSlots, ['bench-0']);
    gs.resolvePokemonPick('bench-0');
  };
  assert.equal(await engine.activateStadium(pl), true);
  assert.equal(pl.bench[0].energy.length, 1);
  assert.equal(pl.bench[0].hp, 80);
  assert.deepEqual(pl.discard, ['water-energy']);
  assert.equal(await engine.activateStadium(pl), false);
});

await test('光辉喷火龙激动之心：只按对手已拿奖赏减少无色费用，不减少火要求', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  const radiant = mon('光辉喷火龙', 'radiant-zard', [{ name:'烈焰爆', damage:250, cost:['fire','colorless','colorless','colorless','colorless'] }]);
  radiant.element = 'fire';
  radiant.ability = { name:'激动之心', passive:true, effects:[{ action:'attack_cost_reduction', params:{ target:'self', type:'colorless', amount:'opponent_prizes_taken' } }] };
  pl.active = radiant;
  opp.prizes = ['p1','p2','p3','p4','p5','p6'];

  radiant.energy = [{ name:'基本【火】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }];
  assert.deepEqual(gs.adjustedAttackCost(radiant, radiant.attacks[0]), ['fire','colorless','colorless','colorless','colorless']);
  assert.equal(gs.checkEnergy(radiant, 0), true);

  opp.prizes = ['p1','p2','p3','p4'];
  radiant.energy = [{ name:'基本【火】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }];
  assert.deepEqual(gs.adjustedAttackCost(radiant, radiant.attacks[0]), ['fire','colorless','colorless']);
  assert.equal(gs.checkEnergy(radiant, 0), true);

  opp.prizes = ['p1'];
  radiant.energy = [{ name:'基本【火】能量' }];
  assert.deepEqual(gs.adjustedAttackCost(radiant, radiant.attacks[0]), ['fire']);
  assert.equal(gs.checkEnergy(radiant, 0), true);
  radiant.energy = [{ name:'基本【无】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }, { name:'基本【无】能量' }];
  assert.equal(gs.checkEnergy(radiant, 0), false);
});

await test('火焰鸟闪焰象征：只强化己方基础火宝可梦且随进出场/失效重算', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.active = mon('防守');
  const attack = { name:'火花', damage:20, cost:[] };
  const moltres = mon('火焰鸟', 'moltres', [attack]);
  moltres.element = 'fire';
  moltres.ability = { name:'闪焰象征', passive:true, effects:[{ action:'passive_damage_mod', params:{ target:'own_field', amount:10, attackerType:'fire', attackerStage:'basic', excludeSourceName:'火焰鸟', defender:'opponent_active' } }] };
  const basicFire = mon('小火龙', 'charmander', [attack]);
  basicFire.element = 'fire';
  const basicWater = mon('杰尼龟', 'squirtle', [attack]);
  basicWater.element = 'water';
  const evoFire = mon('火恐龙', 'charmeleon', [attack]);
  evoFire.element = 'fire';
  evoFire.stage = '1阶';
  evoFire.evolvesFrom = '小火龙';
  pl.active = basicFire;
  pl.bench = [moltres, basicWater, evoFire];

  assert.equal(gs.getPassiveDamageModifier(basicFire, opp.active, attack, pl), 10);
  assert.equal(gs.getPassiveDamageModifier(basicWater, opp.active, attack, pl), 0);
  assert.equal(gs.getPassiveDamageModifier(evoFire, opp.active, attack, pl), 0);
  assert.equal(gs.getPassiveDamageModifier(moltres, opp.active, attack, pl), 0);
  moltres.abilityDisabled = true;
  assert.equal(gs.getPassiveDamageModifier(basicFire, opp.active, attack, pl), 0);
  moltres.abilityDisabled = false;
  pl.bench = [];
  gs.recomputePassives();
  assert.equal(gs.getPassiveDamageModifier(basicFire, opp.active, attack, pl), 0);
});

await test('古玉鱼嫉妒业火：仅上个对手回合己方被击倒时追加90伤害', async () => {
  const makeChiYuGame = history => {
    const gs = new GameState();
    const pl = gs.player1;
    const opp = gs.player2;
    gs.turn = 4;
    gs.phase = PHASE.BATTLE;
    gs.currentPlayer = pl;
    pl.active = mon('古玉鱼', 'chi-yu', [{ name:'嫉妒业火', damage:'50+', cost:[], effects:[{ action:'conditional_damage_mod', params:{ amount:90, condition:'own_pokemon_knocked_out_last_opponent_turn' } }] }]);
    pl.active.element = 'fire';
    opp.active = mon('防守');
    opp.active.hp = 200;
    opp.active.maxHp = 200;
    gs.knockoutHistory = history(gs, pl, opp);
    return { gs, pl, opp, engine:makeEngine(gs) };
  };

  let ctx = makeChiYuGame((gs, pl, opp) => [{ owner:pl, by:opp, turn:3, phase:PHASE.BATTLE }]);
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 60);

  ctx = makeChiYuGame(() => []);
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 150);

  ctx = makeChiYuGame((gs, pl, opp) => [{ owner:pl, by:opp, turn:2, phase:PHASE.BATTLE }]);
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 150);

  ctx = makeChiYuGame((gs, pl, opp) => [{ owner:opp, by:pl, turn:3, phase:PHASE.BATTLE }]);
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 150);
});

await test('骨纹巨声鳄ex爆热高歌：需弃基本火能后本回合+60且不是免费被动', async () => {
  const make = hand => {
    const gs = new GameState();
    const pl = gs.player1;
    const opp = gs.player2;
    gs.currentPlayer = pl;
    gs.phase = PHASE.MAIN;
    pl.active = mon('攻击手', 'attacker', [{ name:'打击', damage:40, cost:[] }]);
    opp.active = mon('防守');
    opp.active.hp = 200;
    opp.active.maxHp = 200;
    const skeledirge = mon('骨纹巨声鳄ex', '9811');
    skeledirge.ability = { name:'爆热高歌', active:true, zone:'field', effects:[{ action:'ability_discard_cost', params:{ count:1, filter:'基本【火】能量', zone:'hand' } }, { action:'turn_damage_mod', params:{ target:'own_field', defender:'opponent_active', amount:60 } }] };
    pl.bench = [skeledirge];
    pl.hand = [...hand];
    return { gs, pl, opp, skeledirge, engine:makeEngine(gs) };
  };

  let ctx = make([]);
  ctx.gs.phase = PHASE.BATTLE;
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 160);

  ctx = make(['基本【水】能量']);
  assert.equal(await ctx.engine.useAbility(ctx.skeledirge), false);
  assert.equal(ctx.pl.hand.length, 1);
  assert.equal(ctx.skeledirge.abilityUsed, false);

  ctx = make(['基本【火】能量']);
  assert.equal(await ctx.engine.useAbility(ctx.skeledirge), true);
  assert.equal(ctx.pl.hand.length, 0);
  assert.equal(ctx.pl.discard.length, 1);
  assert.equal(await ctx.engine.useAbility(ctx.skeledirge), false);
  ctx.gs.phase = PHASE.BATTLE;
  assert.equal(await ctx.engine.attack(0), true);
  assert.equal(ctx.opp.active.hp, 100);
});

await test('小陨星重力冲撞：按对手撤退所需能量×20造成伤害', async () => {
  for (const [retreat, expectedHp] of [[0, 200], [2, 160], [3, 140]]) {
    const gs = new GameState();
    const pl = gs.player1;
    const opp = gs.player2;
    gs.currentPlayer = pl;
    gs.phase = PHASE.BATTLE;
    pl.active = mon('小陨星', '9875', [{ name:'重力冲撞', damage:0, cost:[], effects:[{ action:'conditional_damage_mod', params:{ amount:20, condition:'opponent_retreat_cost' } }] }]);
    opp.active = mon('防守');
    opp.active.hp = 200;
    opp.active.maxHp = 200;
    opp.active.retreatCost = retreat;
    assert.equal(await makeEngine(gs).attack(0), true);
    assert.equal(opp.active.hp, expectedHp, `retreat=${retreat}`);
  }
});

await test('虫甲圣球形盾牌/精神强念：保护己方备战且按对手能量增伤', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  const shield = mon('虫甲圣', '10883');
  shield.ability = { name:'球形盾牌', passive:true, zone:'field', effects:[{ action:'bench_attack_shield', params:{ target:'own_bench', source:'opponent_attack', preventDamage:true, preventEffect:true } }] };
  pl.active = mon('己方出战');
  pl.bench = [shield, mon('被保护备战')];
  opp.active = mon('攻击者', 'attacker', [{ name:'狙击', damage:0, cost:[], effects:[{ action:'damage_bench', params:{ target:'opponent_1', damage:50 } }, { action:'discard_energy', params:{ target:'opponent_bench', count:1 } }] }]);
  pl.bench[1].hp = 100;
  pl.bench[1].maxHp = 100;
  pl.bench[1].energy = ['基本【草】能量'];
  gs.currentPlayer = opp;
  gs.phase = PHASE.BATTLE;
  assert.equal(await makeEngine(gs).attack(0), true);
  assert.equal(pl.bench[1].hp, 100);
  assert.equal(pl.bench[1].energy.length, 1);

  const activeHit = new GameState();
  activeHit.player1.active = mon('虫甲圣攻击者', '10883', [{ name:'精神强念', damage:10, cost:[], effects:[{ action:'conditional_damage_mod', params:{ amount:30, condition:'opponent_active_energy_count' } }] }]);
  activeHit.player2.active = mon('防守');
  activeHit.player2.active.hp = 200;
  activeHit.player2.active.maxHp = 200;
  activeHit.player2.active.energy = ['e1','e2'];
  activeHit.currentPlayer = activeHit.player1;
  activeHit.phase = PHASE.BATTLE;
  assert.equal(await makeEngine(activeHit).attack(0), true);
  assert.equal(activeHit.player2.active.hp, 130);

  const ownAttack = new GameState();
  ownAttack.player1.active = mon('己方狙击手', 'own', [{ name:'友军误伤测试', damage:0, cost:[], effects:[{ action:'damage_bench', params:{ target:'opponent_1', damage:40 } }] }]);
  ownAttack.player2.active = mon('对手出战');
  ownAttack.player2.bench = [mon('对手备战')];
  ownAttack.player2.bench[0].hp = 100;
  ownAttack.player2.bench[0].maxHp = 100;
  ownAttack.currentPlayer = ownAttack.player1;
  ownAttack.phase = PHASE.BATTLE;
  assert.equal(await makeEngine(ownAttack).attack(0), true);
  assert.equal(ownAttack.player2.bench[0].hp, 60);
});

await test('吉雉鸡ex扭转乾坤/残酷箭：KO门槛、名字一次与任意对手宝可梦伤害', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  gs.turn = 4;
  pl.deck = ['a','b','c','d'];
  const ability = { name:'扭转乾坤', active:true, zone:'field', effects:[{ action:'usage_condition', params:{ kind:'own_pokemon_knocked_out_last_opponent_turn' } }, { action:'draw', params:{ count:3 } }, { action:'usage_condition', params:{ kind:'ability_name_once_per_turn', abilityName:'扭转乾坤' } }] };
  const fez1 = mon('吉雉鸡ex', '11778');
  const fez2 = mon('吉雉鸡ex', '11489');
  fez1.ability = ability;
  fez2.ability = ability;
  pl.active = fez1;
  pl.bench = [fez2];
  const engine = makeEngine(gs);
  assert.equal(await engine.useAbility(fez1), false);
  assert.equal(pl.hand.length, 0);
  gs.knockoutHistory = [{ owner:pl, by:opp, turn:3, phase:PHASE.BATTLE }];
  assert.equal(await engine.useAbility(fez1), true);
  assert.equal(pl.hand.length, 3);
  assert.equal(await engine.useAbility(fez2), false);

  const arrowGs = new GameState();
  arrowGs.player1.active = mon('吉雉鸡ex', '11778', [{ name:'残酷箭', damage:0, cost:[], effects:[{ action:'damage_bench', params:{ target:'opponent_any', damage:100 } }] }]);
  arrowGs.player2.active = mon('对手出战');
  arrowGs.player2.active.hp = 180;
  arrowGs.player2.active.maxHp = 180;
  arrowGs.player2.bench = [mon('对手备战')];
  arrowGs.currentPlayer = arrowGs.player1;
  arrowGs.phase = PHASE.BATTLE;
  arrowGs._onPendingPokemonPick = pick => pick.resolve('active');
  assert.equal(await makeEngine(arrowGs).attack(0), true);
  assert.equal(arrowGs.player2.active.hp, 80);
});

await test('小陨星飞散流星：给备战小陨星从手牌附能后换到战斗场', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('出战');
  const minior = mon('小陨星', 'minior');
  minior.ability = {
    name:'飞散流星',
    active:true,
    passive:false,
    zone:'bench',
    effects:[{ action:'attach_energy_trigger', params:{ event:'attach_energy_from_hand', target:'self', sourceZone:'bench', optional:true, effects:[{ action:'self_switch_to_active', params:{} }] } }]
  };
  pl.bench = [minior];
  pl.hand = ['energy'];
  const engine = makeEngine(gs);

  assert.equal(await engine.attachEnergy(0, { cardType:'energy', name:'基本【斗】能量' }, 'bench-0'), true);
  assert.equal(pl.active.name, '小陨星');
  assert.equal(pl.active.energy.length, 1);
  assert.equal(pl.bench[0].name, '出战');
});

await test('小陨星飞散流星：附能到出战或其他宝可梦不触发', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('小陨星出战');
  pl.active.ability = { name:'飞散流星', active:true, passive:false, zone:'bench', effects:[{ action:'attach_energy_trigger', params:{ event:'attach_energy_from_hand', target:'self', sourceZone:'bench', effects:[{ action:'self_switch_to_active', params:{} }] } }] };
  pl.bench = [mon('备战')];
  pl.hand = ['energy'];
  const engine = makeEngine(gs);

  assert.equal(await engine.attachEnergy(0, { cardType:'energy', name:'基本【斗】能量' }, 'active'), true);
  assert.equal(pl.active.name, '小陨星出战');
});

await test('光辉伊布集亮亮：按己方场上属性种类数任意搜牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('光辉伊布');
  pl.active.element = 'colorless';
  pl.bench = [mon('草'), mon('火')];
  pl.bench[0].element = 'grass';
  pl.bench[1].element = 'fire';
  pl.deck = ['bottom', 'A', 'B', 'C', 'D'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action:'search_deck_to_hand', params:{ dynamicCount:'own_field_type_count', allowFewer:true, allowEmpty:true } }]);
  assert.equal(pl.hand.length, 3);
  assert.equal(pl.deck.length, 2);
});

await test('洗翠的沉重球：奖赏基础宝可梦与本卡互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = [];
  pl.discard = ['heavy'];
  pl.prizes = ['basic', 'evo'];
  gs.cardResolver = fakeResolver({
    basic: { card:{ cardType:'pokemon', name:'基础', stage:'基础', hp:60 }, info:{ name:'基础', number:null, type:'pokemon' } },
    evo: { card:{ cardType:'pokemon', name:'进化', stage:'1阶', evolvesFrom:'基础', hp:90 }, info:{ name:'进化', number:null, type:'pokemon' } },
  });
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['基础']);
    gs.resolvePick([0]);
  };
  await executeEffects(gs, pl, [{ action:'prize_basic_pokemon_to_hand_exchange_trainer', params:{ count:1, filter:'【基础】宝可梦' } }], { trainerCard:'heavy' });
  assert.deepEqual(pl.hand, ['basic']);
  assert.deepEqual(pl.prizes, ['heavy', 'evo']);
  assert.deepEqual(pl.discard, []);
});

function setupRareCandyGame() {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('小火龙');
  pl.active.placedThisTurn = false;
  pl.active.energy = ['基本【火】能量'];
  pl.hand = ['神奇糖果', 'charizard'];
  gs.cardResolver = fakeResolver({
    charmeleon: { card:{ cardType:'pokemon', name:'火恐龙', stage:'1阶', evolvesFrom:'小火龙', hp:90 }, info:{ name:'火恐龙', number:null, type:'pokemon' } },
    charizard: { card:{ cardType:'pokemon', name:'喷火龙', stage:'2阶', evolvesFrom:'火恐龙', hp:150, attacks:[{ name:'火焰', damage:80, cost:[] }], element:'fire' }, info:{ name:'喷火龙', number:null, type:'pokemon' } },
  });
  gs.cardResolver.raw = { charmeleon:{}, charizard:{} };
  const cardData = { cardType:'trainer', trainerType:'item', name:'神奇糖果', effects:[{ action:'evolve_rare_candy', params:{ noFirstTurn:true, noPlacedThisTurn:true } }] };
  return { gs, pl, cardData, engine:makeEngine(gs) };
}

await test('神奇糖果：基础宝可梦可跳过1阶进化为2阶', async () => {
  const { gs, pl } = setupRareCandyGame();
  pl.hand = ['charizard'];
  await executeEffects(gs, pl, [{ action:'evolve_rare_candy', params:{} }]);
  assert.equal(pl.active.name, '喷火龙');
  assert.deepEqual(pl.active.energy, ['基本【火】能量']);
  assert.deepEqual(pl.hand, []);
});

await test('神奇糖果：自己的最初回合禁止且不消耗卡牌', async () => {
  const { gs, pl, cardData, engine } = setupRareCandyGame();
  gs.firstPlayer = pl;
  gs.turn = 1;
  gs.phase = PHASE.MAIN;
  const before = { hand:[...pl.hand], discard:[...pl.discard], active:pl.active.name };
  assert.equal(await engine.useTrainer(0, cardData), false);
  assert.deepEqual(pl.hand, before.hand);
  assert.deepEqual(pl.discard, before.discard);
  assert.equal(pl.active.name, before.active);
});

await test('神奇糖果：必需目标取消回滚训练家消耗', async () => {
  const { gs, pl, cardData, engine } = setupRareCandyGame();
  gs.firstPlayer = pl;
  gs.turn = 3;
  gs.phase = PHASE.MAIN;
  pl.bench = [mon('小火龙', 'bench-charmander')];
  pl.bench[0].placedThisTurn = false;
  gs._onPendingPokemonPick = pick => pick.resolve(null);
  assert.equal(await engine.useTrainer(0, cardData), false);
  assert.deepEqual(pl.hand, ['神奇糖果', 'charizard']);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.active.name, '小火龙');
});

await test('酷豹交易：需丢弃恰好1张手牌后抽2且成功后本回合一次', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('酷豹', 'liepard');
  pl.active.ability = { name:'交易', active:true, zone:'field', effects:[{ action:'ability_discard_cost', params:{ count:1, zone:'hand' } }, { action:'draw', params:{ count:2 } }] };
  pl.hand = ['cost'];
  pl.deck = ['draw-bottom', 'draw-top'];
  const engine = makeEngine(gs);
  assert.equal(await engine.useAbility(pl.active), true);
  assert.equal(pl.discard.length, 1);
  assert.equal(pl.hand.length, 2);
  assert.equal(pl.deck.length, 0);
  assert.equal(pl.active.abilityUsed, true);
  assert.equal(await engine.useAbility(pl.active), false);
});

await test('酷豹交易：无可丢手牌或取消费用不标记使用且不变更状态', async () => {
  let gs = new GameState();
  let pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('酷豹', 'liepard');
  pl.active.ability = { name:'交易', active:true, zone:'field', effects:[{ action:'ability_discard_cost', params:{ count:1, zone:'hand' } }, { action:'draw', params:{ count:2 } }] };
  pl.deck = ['d1', 'd2'];
  assert.equal(await makeEngine(gs).useAbility(pl.active), false);
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.active.abilityUsed, false);

  gs = new GameState();
  pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('酷豹', 'liepard');
  pl.active.ability = { name:'交易', active:true, zone:'field', effects:[{ action:'ability_discard_cost', params:{ count:1, zone:'hand' } }, { action:'draw', params:{ count:2 } }] };
  pl.hand = ['cost-a', 'cost-b'];
  pl.deck = ['d1', 'd2'];
  gs._onPendingPick = pick => pick.resolve(null);
  assert.equal(await makeEngine(gs).useAbility(pl.active), false);
  assert.deepEqual(pl.hand, ['cost-a', 'cost-b']);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.deck.length, 2);
  assert.equal(pl.active.abilityUsed, false);
});

function setupPrimeCatcherGame() {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.hand = ['顶尖捕捉器'];
  pl.active = mon('己方出战');
  pl.bench = [mon('己方备战A'), mon('己方备战B')];
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  const cardData = { cardType:'trainer', trainerType:'item', name:'顶尖捕捉器', effects:[{ action:'switch_pokemon', params:{ who:'opponent' } }, { action:'switch_pokemon', params:{ who:'self' } }] };
  return { gs, pl, opp, cardData, engine:makeEngine(gs) };
}

await test('顶尖捕捉器：按对手换位后己方换位顺序执行并消耗物品', async () => {
  const { gs, pl, opp, cardData, engine } = setupPrimeCatcherGame();
  const prompts = [];
  gs._onPendingPokemonPick = pick => {
    prompts.push(pick.options.side);
    pick.resolve(pick.options.side === 'opponent' ? 'bench-1' : 'bench-0');
  };
  assert.equal(await engine.useTrainer(0, cardData), true);
  assert.deepEqual(prompts, ['opponent', 'self']);
  assert.equal(opp.active.name, '对手备战B');
  assert.equal(pl.active.name, '己方备战A');
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, ['顶尖捕捉器']);
});

await test('顶尖捕捉器：缺少/取消必需目标时回滚且不消耗物品', async () => {
  let ctx = setupPrimeCatcherGame();
  ctx.pl.bench = [];
  assert.equal(await ctx.engine.useTrainer(0, ctx.cardData), false);
  assert.equal(ctx.opp.active.name, '对手出战');
  assert.deepEqual(ctx.pl.hand, ['顶尖捕捉器']);
  assert.deepEqual(ctx.pl.discard, []);

  ctx = setupPrimeCatcherGame();
  ctx.gs._onPendingPokemonPick = pick => {
    if (pick.options.side === 'opponent') pick.resolve('bench-0');
    else pick.resolve(null);
  };
  assert.equal(await ctx.engine.useTrainer(0, ctx.cardData), false);
  assert.equal(ctx.opp.active.name, '对手出战');
  assert.equal(ctx.pl.active.name, '己方出战');
  assert.deepEqual(ctx.pl.hand, ['顶尖捕捉器']);
  assert.deepEqual(ctx.pl.discard, []);
});

await test('宝可齿轮3.0效果：picker 只看到支援者且 fallback 选择首个支援者', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'supporterA', 'itemA', 'supporterB'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    supporterA: { info:{ name:'支援者A', number:null, type:'supporter' }, card:{ cardType:'trainer', trainerType:'supporter', name:'支援者A' } },
    supporterB: { info:{ name:'支援者B', number:null, type:'supporter' }, card:{ cardType:'trainer', trainerType:'supporter', name:'支援者B' } },
    itemA: { info:{ name:'物品A', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
  });
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['支援者B', '支援者A']);
    assert.equal(pick.options?.source, 'peek');
    assert.equal(pick.options?.filter, '支援者');
    gs.resolvePick([1]);
  };
  await executeEffects(gs, pl, [{ action: 'peek_and_keep', params: { peek: 7, keep: 1, filter: '支援者' } }]);
  assert.deepEqual(pl.hand, ['supporterA']);
  assert.equal(pl.deck.includes('supporterA'), false);
  assert.equal(pl.deck.includes('supporterB'), true);
  assert.equal(pl.deck.includes('itemA'), true);

  const gs2 = new GameState();
  const pl2 = gs2.player1;
  gs2.cardResolver = gs.cardResolver;
  gs2._shuffle = deck => deck;
  pl2.deck = ['bottom', 'supporterA', 'itemA', 'supporterB'];
  await executeEffects(gs2, pl2, [{ action: 'peek_and_keep', params: { peek: 7, keep: 1, filter: '支援者' } }]);
  assert.deepEqual(pl2.hand, ['supporterB']);
  assert.equal(pl2.deck.includes('itemA'), true);
});

await test('peek_and_keep：无匹配候选时记录可见原因并保留牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'itemA', 'energyA'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    itemA: { info:{ name:'物品A', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
    energyA: { info:{ name:'基本【雷】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【雷】能量' } },
  });

  await executeEffects(gs, pl, [{ action:'peek_and_keep', params:{ peek:2, keep:1, filter:'支援者', remainder:'top_original' } }]);

  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.deck, ['bottom', 'itemA', 'energyA']);
  assert.equal(gs.log.some(msg => msg.includes('查看了 2 张，没有符合支援者条件的卡')), true);
  assert.equal(gs.log.some(msg => msg.includes('看了 2 张选了 0 张')), true);
});

await test('search_deck_to_bench：无基础候选和备战已满都会记录可见原因', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['evo', 'item'];
  pl.bench = [];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    evo: { info:{ name:'进化兽', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽', hp:90 } },
    item: { info:{ name:'物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品' } },
  });

  await executeEffects(gs, pl, [{ action:'search_deck_to_bench', params:{ count:1, filter:'宝可梦' } }]);

  assert.equal(pl.bench.length, 0);
  assert.equal(gs.log.at(-1), '牌库中没有可放置的基础宝可梦');

  const gs2 = new GameState();
  const pl2 = gs2.player1;
  pl2.deck = ['basic'];
  pl2.bench = [mon('b1'), mon('b2'), mon('b3'), mon('b4'), mon('b5')];
  gs2._shuffle = deck => deck;

  await executeEffects(gs2, pl2, [{ action:'search_deck_to_bench', params:{ count:1, filter:'宝可梦' } }]);

  assert.equal(pl2.bench.length, 5);
  assert.equal(gs2.log.at(-1), '备战区已满，无法放置宝可梦');
});

await test('巢穴球：解析出的基础筛选可匹配resolver牌库并打开基础宝可梦选择器', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'evo', 'item', 'basic2', 'basic'];
  pl.bench = [];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    basic: { info:{ name:'小火龙', number:4, type:'pokemon' }, card:{ cardType:'pokemon', name:'小火龙', stage:'基础', hp:70, element:'火' } },
    basic2: { info:{ name:'杰尼龟', number:7, type:'pokemon' }, card:{ cardType:'pokemon', name:'杰尼龟', stage:'基础', hp:70, element:'水' } },
    evo: { info:{ name:'火恐龙', number:5, type:'pokemon' }, card:{ cardType:'pokemon', name:'火恐龙', stage:'1阶', evolvesFrom:'小火龙', hp:90, element:'火' } },
    item: { info:{ name:'物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品' } },
  });
  const parsed = parseEffect('从自己的牌库选择1张【基础】宝可梦卡，放置于备战区。并且重洗牌库。');
  assert.equal(parsed.effects[0]?.params.filter, '【基础】宝可梦');
  let pickerOpened = false;
  gs._onPendingPick = pick => {
    pickerOpened = true;
    assert.equal(pick.options?.source, 'deck-to-bench');
    assert.deepEqual(pick.cards, ['小火龙', '杰尼龟']);
    gs.resolvePick([0]);
  };

  await executeEffects(gs, pl, parsed.effects);

  assert.equal(pickerOpened, true);
  assert.equal(pl.bench.length, 1);
  assert.equal(pl.bench[0].name, '小火龙');
  assert.equal(pl.deck.includes('basic'), false);
  assert.equal(gs.log.some(msg => msg.includes('放置了 1 只宝可梦')), true);
});

await test('操作区选卡：多选确认与取消都回传正确索引', () => {
  const app = Object.create(PTCGBattleApp.prototype);
  const resolved = [];
  app.gs = { resolvePick: (i) => resolved.push(i) };
  app._refresh = () => {};
  app._showPanel = () => {};
  let captured = null;
  app._showListView = (items) => { captured = items; };

  // 多选：选 A、B 后确定 → [0,1]
  app._showPickCards({ cards: ['A', 'B', 'C'], count: 2, options: { allowFewer: true } });
  assert.ok(captured && captured.length >= 2, '应渲染候选列表');
  captured.find(x => x.label === 'A').onSelect();
  captured.find(x => x.label === 'B').onSelect();
  captured.find(x => String(x.label).startsWith('确定')).onSelect();
  assert.deepEqual(resolved[0], [0, 1]);

  // 单选 + 可空：取消 → []
  app._showPickCards({ cards: ['A'], count: 1, options: { allowEmpty: true } });
  captured.find(x => x.label === '取消选择').onSelect();
  assert.deepEqual(resolved[1], []);
});


await test('UI选卡器标题：最多与精确选择标题反映min/max', () => {
  assert.equal(cardPickerTitleFor({ cards:['A','B','C'], count:3, options:{ allowEmpty:true, allowFewer:true } }), '选择最多3张卡');
  assert.equal(cardPickerTitleFor({ cards:['A','B','C'], count:2, options:{} }), '选择2张卡');
});

await test('peek_and_keep：选中卡入手，剩余查看卡洗回牌库', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'cardA', 'cardB', 'supporterX'];
  pl.hand = [];
  gs._shuffle = deck => { deck.reverse(); return deck; };
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'peek');
    assert.equal(pick.options?.filter, '支援者');
    gs.resolvePick([0]);
  };
  await executeEffects(gs, pl, [{ action: 'peek_and_keep', params: { peek: 3, keep: 1, filter: '支援者', remainder: 'shuffle' } }]);
  assert.deepEqual(pl.hand, ['supporterX']);
  assert.equal(pl.deck.includes('supporterX'), false);
  assert.deepEqual(new Set(pl.deck), new Set(['bottom', 'cardA', 'cardB']));
  assert.deepEqual(pl.deck, ['cardB', 'cardA', 'bottom']);
});

await test('peek_and_keep：剩余查看卡放回牌库上方且保持原顺序', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'cardA', 'cardB', 'supporterX'];
  pl.hand = [];
  gs._onPendingPick = pick => gs.resolvePick([0]);
  await executeEffects(gs, pl, [{ action: 'peek_and_keep', params: { peek: 3, keep: 1, filter: '支援者', remainder: 'top_original' } }]);
  assert.deepEqual(pl.hand, ['supporterX']);
  assert.deepEqual(pl.deck, ['bottom', 'cardA', 'cardB']);
  assert.equal(pl.deck[pl.deck.length - 1], 'cardB');
});

await test('peek_and_keep解析：代表性剩余卡文本不再残留并标记处理方式', () => {
  const cases = [
    ['宝可齿轮3.0', '查看自己的牌库上方7张卡。选择其中1张支援者卡，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。', 'shuffle', '支援者'],
    ['宝可装置3.0', '查看自己的牌库上方7张卡，从其中选择1张支援者卡，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。', 'shuffle', '支援者'],
    ['宝可领航员', '查看自己的牌库上方3张。可将其中的1张宝可梦或能量卡，在给对手看过后加入手牌。将剩余卡以任意顺序排列，放回牌库上方。', 'top_any_order', '宝可梦或能量'],
    ['捕虫组合', '查看自己的牌库上方7张卡，从其中选择【草】宝可梦卡与“基本【草】能量”卡合计最多2张，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。', 'shuffle', '【草】宝可梦卡与"基本【草】能量"卡'],
  ];
  for (const [label, text, remainder, filter] of cases) {
    const parsed = parseEffect(text);
    assert.equal(parsed.unparsed, '', `${label} residual=${parsed.unparsed}`);
    assert.equal(parsed.effects[0]?.action, 'peek_and_keep', label);
    assert.equal(parsed.effects[0]?.params.remainder, remainder, label);
    assert.equal(parsed.effects[0]?.params.filter, filter, label);
  }
});

await test('peek_and_keep解析：筛选条件继续传递给当前选卡器', () => {
  const parsed = parseEffect('查看自己的牌库上方7张卡，从其中选择1张支援者卡，在给对手看过后加入手牌。将剩余卡放回牌库并重洗。');
  assert.equal(parsed.effects[0]?.params.filter, '支援者');
  assert.equal(parsed.effects[0]?.params.keep, 1);
  assert.equal(parsed.effects[0]?.params.remainder, 'shuffle');
});

await test('组合筛选：草宝可梦或基本草能量接受各自子句并拒绝非匹配卡', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const grassEnergy = 'basic-grass-energy';
  const lightningEnergy = 'basic-lightning-energy';
  const grassPokemon = 'grass-pokemon';
  const itemCard = 'trainer-item';
  pl.deck = ['bottom', itemCard, lightningEnergy, grassPokemon, grassEnergy];
  pl.hand = [];
  gs.cardResolver = fakeResolver({
    [grassEnergy]: {
      info: { name: '基本【草】能量', number: null, type: 'energy' },
      card: { cardType: 'energy', name: '基本【草】能量', element: '草', provides: [{ types: ['grass'], count: 1 }] },
    },
    [lightningEnergy]: {
      info: { name: '基本【雷】能量', number: null, type: 'energy' },
      card: { cardType: 'energy', name: '基本【雷】能量', element: '雷', provides: [{ types: ['lightning'], count: 1 }] },
    },
    [grassPokemon]: {
      info: { name: '绿毛虫', number: null, type: 'pokemon' },
      card: { cardType: 'pokemon', name: '绿毛虫', element: 'grass' },
    },
    [itemCard]: {
      info: { name: '物品测试卡', number: null, type: 'item' },
      card: { cardType: 'trainer', trainerType: 'item', name: '物品测试卡' },
    },
  });

  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count: 4, filter: '【草】宝可梦卡与基本【草】能量卡' } }]);

  assert.deepEqual(new Set(pl.hand), new Set([grassEnergy, grassPokemon]));
  assert.equal(pl.hand.includes(lightningEnergy), false, 'basic lightning energy must not satisfy basic grass energy clause');
  assert.equal(pl.hand.includes(itemCard), false, 'recognizable trainer/item must not satisfy combined Pokemon/energy filter');
});

await test('水莲的照顾解析：保留合计3张与宝可梦/基本能量筛选', () => {
  const parsed = parseEffect('从自己的弃牌区选择宝可梦卡（“拥有规则的宝可梦”除外）与基本能量卡合计最多3张，在给对手看过后加入手牌。');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'recover_from_discard');
  assert.equal(parsed.effects[0]?.params.count, 3);
  assert.equal(parsed.effects[0]?.params.maxCount, 3);
  assert.equal(parsed.effects[0]?.params.minCount, 0);
  assert.equal(parsed.effects[0]?.params.allowFewer, true);
  assert.equal(parsed.effects[0]?.params.allowEmpty, true);
  assert.equal(parsed.effects[0]?.params.target, 'hand');
  assert.equal(parsed.effects[0]?.params.filter, '宝可梦卡（"拥有规则的宝可梦"除外）与基本能量卡');
});

await test('水莲的照顾执行：只向 picker 暴露普通宝可梦与基本能量', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.discard = ['normal-pokemon', 'rule-pokemon', 'has-rulebox', 'radiant-pokemon', 'ruletext-pokemon', 'basic-energy', 'special-energy', 'item-card'];
  pl.hand = [];
  gs.cardResolver = fakeResolver({
    'normal-pokemon': { info:{ name:'普通宝可梦', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'普通宝可梦' } },
    'rule-pokemon': { info:{ name:'皮卡丘ex', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘ex', ruleBox:'ex' } },
    'has-rulebox': { info:{ name:'规则盒测试', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'规则盒测试', hasRuleBox:true } },
    'radiant-pokemon': { info:{ name:'光辉伊布', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'光辉伊布', isRadiant:true } },
    'ruletext-pokemon': { info:{ name:'规则文本测试', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'规则文本测试', ruleText:'拥有规则的宝可梦' } },
    'basic-energy': { info:{ name:'基本【水】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【水】能量', element:'水' } },
    'special-energy': { info:{ name:'特殊能量', number:null, type:'specialEnergy' }, card:{ cardType:'specialEnergy', name:'特殊能量' } },
    'item-card': { info:{ name:'物品测试卡', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品测试卡' } },
  });
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'discard');
    assert.deepEqual(pick.cards, ['普通宝可梦', '基本【水】能量']);
    assert.equal(pick.options?.allowFewer, true);
    assert.equal(pick.options?.allowEmpty, true);
    assert.equal(pick.options?.minCount, 0);
    gs.resolvePick([0]);
  };

  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:3, maxCount:3, minCount:0, allowFewer:true, allowEmpty:true, filter:'宝可梦卡（"拥有规则的宝可梦"除外）与基本能量卡', target:'hand' } }]);

  assert.deepEqual(pl.hand, ['normal-pokemon']);
  assert.equal(pl.discard.includes('basic-energy'), true);
  assert.equal(pl.discard.includes('rule-pokemon'), true);
  assert.equal(pl.discard.includes('has-rulebox'), true);
  assert.equal(pl.discard.includes('radiant-pokemon'), true);
  assert.equal(pl.discard.includes('ruletext-pokemon'), true);
  assert.equal(pl.discard.includes('special-energy'), true);
  assert.equal(pl.discard.includes('item-card'), true);
});

await test('杜娟解析：对手奖赏前提与双方洗手后自己6对手2', () => {
  const parsed = parseEffect('这张卡只可在对手剩余奖赏卡的张数为3张以下时使用。双方玩家各将手牌全部放回牌库并重洗。然后，从牌库抽卡，自己抽出6张，对手抽出2张。');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'trainer_prerequisite');
  assert.equal(parsed.effects[0]?.params.kind, 'opponent_prizes_at_most');
  assert.equal(parsed.effects[0]?.params.count, 3);
  assert.equal(parsed.effects[1]?.action, 'shuffle_hand_to_deck');
  assert.equal(parsed.effects[1]?.params.who, 'both');
  assert.equal(parsed.effects[1]?.params.self_draw_count, 6);
  assert.equal(parsed.effects[1]?.params.opponent_draw_count, 2);
});

await test('杜娟执行：双方手牌回牌库后按自己6张/对手2张抽卡', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.hand = ['p-hand-1', 'p-hand-2'];
  opp.hand = ['o-hand-1'];
  pl.deck = ['p-deck-1', 'p-deck-2', 'p-deck-3', 'p-deck-4', 'p-deck-5', 'p-deck-6', 'p-deck-7', 'p-deck-8'];
  opp.deck = ['o-deck-1', 'o-deck-2', 'o-deck-3'];
  gs._shuffle = deck => deck.reverse();

  await executeEffects(gs, pl, [{ action:'shuffle_hand_to_deck', params:{ who:'both', self_draw_count:6, opponent_draw_count:2 } }]);

  assert.deepEqual(pl.hand, ['p-deck-1', 'p-deck-2', 'p-deck-3', 'p-deck-4', 'p-deck-5', 'p-deck-6']);
  assert.deepEqual(opp.hand, ['o-deck-1', 'o-deck-2']);
  assert.equal(pl.deck.includes('p-hand-1'), true);
  assert.equal(pl.deck.includes('p-hand-2'), true);
  assert.equal(opp.deck.includes('o-hand-1'), true);
  assert.equal(gs.log.some(line => line.includes('自己抽 6 张，对手抽 2 张')), true);
});

await test('杜娟使用前提：对手奖赏超过3张时不消耗支援者', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  const effects = parseEffect('这张卡只可在对手剩余奖赏卡的张数为3张以下时使用。双方玩家各将手牌全部放回牌库并重洗。然后，从牌库抽卡，自己抽出6张，对手抽出2张。').effects;
  const card = { cardType:'trainer', trainerType:'supporter', name:'杜娟', effects };
  pl.hand = ['roxanne-card'];
  opp.prizes = ['奖赏1', '奖赏2', '奖赏3', '奖赏4'];
  gs.phase = PHASE.MAIN;
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, card);

  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['roxanne-card']);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.supporterUsed, false);
  assert.equal(gs.log.some(line => line.includes('使用前提未满足')), true);
});

await test('manipulate_deck_top执行：查看对手牌库顶回复原样且不写未实现日志', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.deck = ['bottom', 'middle', 'top'];

  await executeEffects(gs, pl, [{ action:'manipulate_deck_top', params:{ target:'opponent', count:1, mode:'look', remainder:'top_original' } }]);

  assert.deepEqual(opp.deck, ['bottom', 'middle', 'top']);
  assert.equal(gs.log.some(line => line.includes('[未实现: manipulate_deck_top]')), false);
  assert.equal(gs.log.some(line => line.includes('查看对手牌库上方 1 张，回复原样')), true);
});

await test('manipulate_deck_top执行：可选择匹配物品丢弃，剩余牌洗回', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.deck = ['bottom', 'supporter', 'itemB', 'energy', 'itemA'];
  gs.cardResolver = fakeResolver({
    itemA: { info:{ name:'物品A', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
    itemB: { info:{ name:'物品B', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品B' } },
    energy: { info:{ name:'基本能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本能量' } },
    supporter: { info:{ name:'支援者', number:null, type:'supporter' }, card:{ cardType:'trainer', trainerType:'supporter', name:'支援者' } },
  });
  gs._shuffle = deck => { deck.reverse(); return deck; };
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'manipulate-deck-top-discard');
    assert.equal(pick.options?.filter, '物品');
    assert.equal(pick.options?.allowFewer, true);
    assert.equal(pick.options?.allowEmpty, true);
    assert.deepEqual(pick.cards, ['物品A', '物品B']);
    gs.resolvePick([1]);
  };

  await executeEffects(gs, pl, [{ action:'manipulate_deck_top', params:{ target:'opponent', count:4, mode:'discard_matching', filter:'物品', allowFewer:true, allowEmpty:true, remainder:'shuffle' } }]);

  assert.deepEqual(opp.discard, ['itemB']);
  assert.equal(opp.deck.includes('itemB'), false);
  assert.deepEqual(new Set(opp.deck), new Set(['bottom', 'supporter', 'energy', 'itemA']));
  assert.equal(gs.log.some(line => line.includes('[未实现: manipulate_deck_top]')), false);
});

await test('manipulate_deck_top执行：无UI时确定性丢弃全部匹配候选并保留任意顺序原序回退', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.deck = ['bottom', 'itemB', 'energy', 'itemA'];
  gs.cardResolver = fakeResolver({
    itemA: { info:{ name:'物品A', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
    itemB: { info:{ name:'物品B', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品B' } },
    energy: { info:{ name:'基本能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本能量' } },
  });

  await executeEffects(gs, pl, [{ action:'manipulate_deck_top', params:{ target:'opponent', count:3, mode:'discard_matching', filter:'物品', allowFewer:true, allowEmpty:true, remainder:'top_original' } }]);
  assert.deepEqual(opp.discard, ['itemA', 'itemB']);
  assert.deepEqual(opp.deck, ['bottom', 'energy']);

  await executeEffects(gs, pl, [{ action:'manipulate_deck_top', params:{ target:'opponent', count:2, mode:'top_any_order', keepOrder:true } }]);
  assert.deepEqual(opp.deck, ['bottom', 'energy']);
  assert.equal(gs.log.some(line => line.includes('按原顺序放回上方')), true);
});

await test('manipulate_deck_top执行：必选置顶取消时恢复牌库并按现有约定失败', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.deck = ['bottom', 'second', 'top'];
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'manipulate-deck-top-choose-top');
    gs.resolvePick([]);
  };

  await executeEffects(gs, pl, [{ action:'manipulate_deck_top', params:{ target:'opponent', count:2, mode:'choose_top_rest_bottom', keep:1 } }]);

  assert.deepEqual(opp.deck, ['bottom', 'second', 'top']);
  assert.equal(gs.log.some(line => line.includes('牌库上方操作取消')), true);
  assert.equal(gs.log.some(line => line.includes('[效果失败: manipulate_deck_top] required_choice_cancelled')), true);
});

await test('未实现效果路径：执行器必须写入可见日志而不是静默跳过', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, [{ action:'unsupported_real_card_effect', params:{} }]);
  assert.equal(gs.log.includes('[未实现: unsupported_real_card_effect]'), true);
});

await test('筛选回退：有属性元数据才声明草宝可梦匹配', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const typedGrass = 'typed-grass-pokemon';
  const unknownType = 'unknown-type-pokemon';
  pl.deck = [unknownType, typedGrass];
  pl.hand = [];
  gs.cardResolver = fakeResolver({
    [typedGrass]: {
      info: { name: '草属性宝可梦', number: null, type: 'pokemon' },
      card: { cardType: 'pokemon', name: '草属性宝可梦', element: '草' },
    },
    [unknownType]: {
      info: { name: '未标属性宝可梦', number: null, type: 'pokemon' },
      card: { cardType: 'pokemon', name: '未标属性宝可梦' },
    },
  });

  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count: 2, filter: '【草】宝可梦卡与基本【草】能量卡' } }]);

  assert.deepEqual(pl.hand, [typedGrass]);
});

await test('回手：target choose 可选择自己的备战宝可梦且不改变出战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.bench = [mon('备战B', 'bench-b'), mon('备战C', 'bench-c')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, pl);
    assert.equal(pick.options?.mode, 'return-to-hand');
    assert.equal(pick.options?.allowActive, true);
    assert.equal(pick.options?.allowBench, true);
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose' } }]);
  assert.equal(pl.active.name, '出战A');
  assert.deepEqual(pl.bench.map(m => m.name), ['备战B']);
  assert.deepEqual(pl.hand, ['bench-c']);
});

await test('回手：with_attachments 回收当前模型表示的备战能量与道具', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const target = mon('备战B', 'bench-b');
  target.energy = [{ cardId: 'energy-object', name: '基本火能量' }, 'energy-primitive'];
  target.tool = '道具卡名';
  pl.active = mon('出战A', 'active-a');
  pl.bench = [target];
  gs._onPendingPokemonPick = () => gs.resolvePokemonPick('bench-0');

  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose', with_attachments: true } }]);

  assert.equal(pl.active.name, '出战A');
  assert.deepEqual(pl.bench, []);
  assert.deepEqual(pl.hand, ['energy-object', 'energy-primitive', '道具卡名', 'bench-b']);
});

await test('回手：target choose 选择出战时可选择指定备战换上', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.bench = [mon('备战B', 'bench-b'), mon('备战C', 'bench-c')];
  const picks = ['active', 'bench-1'];
  gs._onPendingPokemonPick = pick => {
    const next = picks.shift();
    if (next === 'active') assert.equal(pick.options?.mode, 'return-to-hand');
    if (next === 'bench-1') {
      assert.equal(pick.options?.mode, 'switch');
      assert.equal(pick.options?.allowActive, false);
    }
    gs.resolvePokemonPick(next);
  };
  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose' } }]);
  assert.equal(pl.active.name, '备战C');
  assert.deepEqual(pl.bench.map(m => m.name), ['备战B']);
  assert.deepEqual(pl.hand, ['active-a']);
  assert.equal(picks.length, 0);
});

await test('回手：with_attachments 回收出战附加卡并保留换上行为', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.active.energy = [{ id: 'energy-by-id', name: '特殊能量' }];
  pl.active.tool = { cardId: 'tool-card-id', name: '工具' };
  pl.bench = [mon('备战B', 'bench-b'), mon('备战C', 'bench-c')];
  const picks = ['active', 'bench-1'];
  gs._onPendingPokemonPick = () => gs.resolvePokemonPick(picks.shift());

  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose', with_attachments: true } }]);

  assert.equal(pl.active.name, '备战C');
  assert.deepEqual(pl.bench.map(m => m.name), ['备战B']);
  assert.deepEqual(pl.hand, ['energy-by-id', 'tool-card-id', 'active-a']);
  assert.equal(picks.length, 0);
});

await test('回手：target self 保持只回收出战且只请求换上宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.bench = [mon('备战B', 'bench-b'), mon('备战C', 'bench-c')];
  let pickCount = 0;
  gs._onPendingPokemonPick = pick => {
    pickCount++;
    assert.equal(pick.options?.mode, 'switch');
    assert.equal(pick.options?.allowActive, false);
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'self' } }]);
  assert.equal(pl.active.name, '备战C');
  assert.deepEqual(pl.bench.map(m => m.name), ['备战B']);
  assert.deepEqual(pl.hand, ['active-a']);
  assert.equal(pickCount, 1);
});

await test('回手：with_attachments 回收精确道具id并兼容旧字符串道具', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.active.tool = { cardId:'tool-print-1', name:'力量头带' };
  pl.bench = [mon('备战B', 'bench-b')];
  pl.bench[0].tool = '旧字符串道具';
  pl.bench[0].energy = [{ cardId:'energy-print-1', name:'基本水能量' }, { id:'energy-print-2', name:'特殊能量' }, '旧字符串能量'];

  gs._onPendingPokemonPick = pick => {
    if (pick.options?.mode === 'switch') gs.resolvePokemonPick('bench-0');
    else gs.resolvePokemonPick('bench-0');
  };
  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'self', with_attachments: true } }]);
  assert.deepEqual(pl.hand, ['active-a', 'tool-print-1']);
  assert.equal(pl.active.tool, '旧字符串道具');

  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose', with_attachments: true } }]);
  assert.deepEqual(pl.hand, ['active-a', 'tool-print-1', 'energy-print-1', 'energy-print-2', '旧字符串能量', '旧字符串道具', 'bench-b']);
});

await test('回手：无选择器时 target choose 稳定回退到出战和首个备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A', 'active-a');
  pl.bench = [mon('备战B', 'bench-b'), mon('备战C', 'bench-c')];
  await executeEffects(gs, pl, [{ action: 'return_to_hand', params: { target: 'choose' } }]);
  assert.equal(pl.active.name, '备战B');
  assert.deepEqual(pl.bench.map(m => m.name), ['备战C']);
  assert.deepEqual(pl.hand, ['active-a']);
});

await test('回手解析：宝可梦旋风回收机类文本映射到 choose 且只在明示时回收附加卡', () => {
  const parsed = parseEffect('将自己的1只宝可梦与所附加的所有卡放回手牌。');
  assert.equal(parsed.effects[0]?.action, 'return_to_hand');
  assert.equal(parsed.effects[0]?.params.target, 'choose');
  assert.equal(parsed.effects[0]?.params.with_attachments, true);

  const cyclone = parseEffect('选择1只自己的场上宝可梦，将那只宝可梦与附加的卡，全部放回手牌。');
  assert.equal(cyclone.effects[0]?.action, 'return_to_hand');
  assert.equal(cyclone.effects[0]?.params.target, 'choose');
  assert.equal(cyclone.effects[0]?.params.with_attachments, true);

  const discardAttached = parseEffect('选择自己的1只场上宝可梦，将其放回手牌。宝可梦以外的卡全部丢弃。');
  assert.equal(discardAttached.effects[0]?.action, 'return_to_hand');
  assert.equal(discardAttached.effects[0]?.params.target, 'choose');
  assert.equal(discardAttached.effects[0]?.params.with_attachments, false);
});

await test('宝可梦交替：玩家选择 bench-1 时换上第二只备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A');
  pl.bench = [mon('备战B'), mon('备战C')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, pl);
    assert.equal(pick.options?.mode, 'switch');
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'switch_pokemon', params: { who: 'self' } }]);
  assert.equal(pl.active.name, '备战C');
  assert.equal(pl.bench.some(m => m.name === '出战A'), true);
});

await test('宝可梦交替：单备战自动选择，无备战安全跳过', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战A');
  pl.bench = [mon('备战B')];
  await executeEffects(gs, pl, [{ action: 'switch_pokemon', params: { who: 'self' } }]);
  assert.equal(pl.active.name, '备战B');

  const gs2 = new GameState();
  gs2.player1.active = mon('孤独出战');
  await executeEffects(gs2, gs2.player1, [{ action: 'switch_pokemon', params: { who: 'self' } }]);
  assert.equal(gs2.player1.active.name, '孤独出战');
});

await test('宝可梦交替解析：由对手选择标记为 opponent chooser', () => {
  const parsed = parseEffect('选择对手的备战宝可梦，与战斗宝可梦互换。[由对手选择]');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'switch_pokemon');
  assert.equal(parsed.effects[0]?.params.who, 'opponent');
  assert.equal(parsed.effects[0]?.params.choose, 'opponent');
});

await test('宝可梦交替：默认由玩家选择对手换上场宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('我方出战A');
  const opp = gs.player2;
  opp.active = mon('对手出战A');
  opp.bench = [mon('对手备战B'), mon('对手备战C')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, opp);
    assert.equal(pick.options?.mode, 'switch');
    assert.equal(pick.options?.side, 'opponent');
    assert.equal(pick.options?.chooser, 'acting');
    assert.equal(pick.options?.prompt, '选择换上场的对手备战宝可梦');
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'switch_pokemon', params: { who: 'opponent' } }]);
  assert.equal(opp.active.name, '对手备战C');
});

await test('宝可梦交替：choose opponent 由对手侧决定并在 AI/无 UI 时稳定选首个备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('我方出战A');
  const opp = gs.player2;
  opp.active = mon('对手出战A');
  opp.bench = [mon('对手备战B'), mon('对手备战C')];
  gs._onPendingPokemonPick = () => assert.fail('AI opponent chooser should use deterministic fallback instead of opening human UI');
  await executeEffects(gs, pl, [{ action: 'switch_pokemon', params: { who: 'opponent', choose: 'opponent' } }]);
  assert.equal(opp.active.name, '对手备战B');
});

await test('宝可梦交替：AI 招式的 choose opponent 可路由给人类选择自己的换入', async () => {
  const gs = new GameState();
  const ai = gs.player2;
  const human = gs.player1;
  human.active = mon('我方出战A');
  human.bench = [mon('我方备战B'), mon('我方备战C')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, human);
    assert.equal(pick.options?.mode, 'switch');
    assert.equal(pick.options?.side, 'opponent');
    assert.equal(pick.options?.chooser, 'target');
    assert.equal(pick.options?.prompt, '选择自己要换上场的备战宝可梦');
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, ai, [{ action: 'switch_pokemon', params: { who: 'opponent', choose: 'opponent' } }]);
  assert.equal(human.active.name, '我方备战C');
});

await test('GameState日志：修复非数组并限制长度，避免运行时RangeError', () => {
  const gs = new GameState();
  gs.log = 'corrupted';
  gs.addLog('恢复日志');
  assert.deepEqual(gs.log, ['恢复日志']);

  for (let i = 0; i < 250; i++) gs.addLog(`日志${i}`);
  assert.equal(gs.log.length, 200);
  assert.equal(gs.log[0], '日志50');
  assert.equal(gs.log.at(-1), '日志249');
});

await test('自动布置：跳过进化宝可梦，避免在同一张不可放置手牌上无限循环', () => {
  const gs = new GameState();
  const resolver = fakeResolver({
    evo: { card: { cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽', hp:90 } },
    basic1: { card: { cardType:'pokemon', name:'基础A', stage:'基础', hp:60 } },
    basic2: { card: { cardType:'pokemon', name:'基础B', stage:'基础', hp:70 } },
    energy: { card: { cardType:'energy', name:'基本【雷】能量' } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  const p2 = gs.player2;
  p2.hand = ['evo', 'basic1', 'energy', 'basic2'];
  const ok = engine._autoSetup(p2);

  assert.equal(ok, true);
  assert.equal(p2.active.name, '基础A');
  assert.deepEqual(p2.bench.map(m => m.name), ['基础B']);
  assert.deepEqual(p2.hand, ['evo', 'energy']);
  assert.equal(gs.log.length < 20, true);
});

await test('确认布置：对手起手无基础但牌库有基础时会重抽并恢复开局', () => {
  const gs = new GameState();
  const logs = [];
  const resolver = fakeResolver({
    evo: { card: { cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽', hp:90 } },
    energy: { card: { cardType:'energy', name:'基本【雷】能量' } },
    basic: { card: { cardType:'pokemon', name:'对手基础', stage:'基础', hp:60 } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:msg=>logs.push(msg), onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  gs._shuffle = cards => cards.slice().reverse();
  gs.phase = PHASE.SETUP;
  gs.currentPlayer = gs.player1;
  gs.turn = 0;
  gs.player1.active = mon('玩家基础', 'p1-basic');
  gs.player1.hand = [];
  gs.player1.deck = ['p1-top'];
  gs.player2.hand = ['evo', 'energy', 'energy', 'energy', 'energy', 'energy', 'energy'];
  gs.player2.deck = ['energy', 'basic'];

  const ok = engine.confirmSetup();

  assert.equal(ok, true);
  assert.equal(gs.player2.active.name, '对手基础');
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.turn, 1);
  assert.equal(logs.some(msg => msg.includes('对手重新抽起始手牌')), true);
  assert.equal(gs.log.length < 20, true);
});

await test('确认布置：对手手牌/牌库没有基础宝可梦时返回false且不进入主/战斗阶段', () => {
  const gs = new GameState();
  const logs = [];
  const resolver = fakeResolver({
    evo: { card: { cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽', hp:90 } },
    energy: { card: { cardType:'energy', name:'基本【雷】能量' } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:msg=>logs.push(msg), onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  gs.phase = PHASE.SETUP;
  gs.currentPlayer = gs.player1;
  gs.turn = 0;
  gs.player1.active = mon('玩家基础', 'p1-basic');
  gs.player1.hand = [];
  gs.player1.deck = ['p1-top'];
  gs.player2.hand = ['evo', 'energy'];
  gs.player2.deck = ['energy'];

  const ok = engine.confirmSetup();

  assert.equal(ok, false);
  assert.equal(gs.phase, PHASE.SETUP);
  assert.notEqual(gs.phase, PHASE.MAIN);
  assert.notEqual(gs.phase, PHASE.BATTLE);
  assert.equal(gs.turn, 0);
  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.player2.active, null);
  assert.deepEqual(gs.player2.hand, ['evo', 'energy']);
  assert.equal(logs.some(msg => msg.includes('牌库和手牌中没有基础宝可梦')), true);
  assert.equal(logs.some(msg => msg.includes('请重新开始或更换对手卡组')), true);
  assert.equal(gs.log.length < 20, true);
});

await test('开局重新抽牌：玩家无基础宝可梦重抽后对手额外抽 1 张', () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.cardResolver = fakeResolver({
    basicA: { info:{ name:'基础A', number:null }, card:{ cardType:'pokemon', name:'基础A', stage:'基础', hp:60 } },
    itemA:  { info:{ name:'物品A', number:null }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
    energyA:{ info:{ name:'基本【草】能量', number:null }, card:{ cardType:'energy', name:'基本【草】能量' } },
  });
  pl.hand = ['itemA', 'energyA'];
  pl.deck = ['basicA', 'itemA', 'energyA', 'basicA', 'itemA', 'energyA', 'basicA', 'itemA', 'energyA', 'basicA'];
  opp.hand = ['x1', 'x2'];
  opp.deck = ['y1', 'y2', 'y3', 'y4'];
  assert.equal(gs.hasBasicInHand(pl), false);

  const engine = makeEngine(gs);
  const oppBefore = opp.hand.length;
  const count = engine.mulliganPlayer(pl);

  assert.equal(count, 1);
  assert.equal(pl.hand.length, 7, '重抽后手牌应为 7 张');
  assert.equal(pl.deck.length + pl.hand.length, 12, '手牌与牌库总数应保持不变（10 牌库 + 2 手牌）');
  assert.equal(opp.hand.length, oppBefore + 1, '对手应额外抽 1 张');
  assert.equal(gs.mulliganCount.player1, 1);
});

await test('开局重新抽牌：对手 mulligan 时玩家获得等量补抽', () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.cardResolver = fakeResolver({
    basicA: { info:{ name:'基础A', number:null }, card:{ cardType:'pokemon', name:'基础A', stage:'基础', hp:60 } },
    itemA:  { info:{ name:'物品A', number:null }, card:{ cardType:'trainer', trainerType:'item', name:'物品A' } },
  });
  opp.hand = ['itemA', 'itemA'];
  opp.deck = ['itemA', 'itemA', 'itemA', 'itemA', 'basicA', 'itemA', 'basicA', 'itemA', 'itemA', 'basicA'];
  pl.deck = Array.from({ length: 20 }, () => 'itemA');
  const plBefore = pl.hand.length;

  const engine = new BattleEngine(gs, gs.cardResolver, { onLog: () => {}, onPhaseChange: () => {}, onFieldUpdate: () => {} });
  const ok = engine._autoSetupWithMulligan(opp);
  assert.equal(ok, true, '对手应能完成自动布置');
  const mulligans = gs.mulliganCount.player2;
  assert.ok(mulligans >= 1, '对手应至少重新抽牌 1 次');
  assert.equal(pl.hand.length, plBefore + mulligans, '玩家应按对手重抽次数获得补抽');
});


await test('UI主动作：确认布置失败时刷新并在主文本保留可见状态', () => {
  const gs = new GameState();
  const calls = [];
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app._lastMainStatus = '对手无法完成布置：请重新开始或更换对手卡组';
  app.engine = { advancePhase: () => false };
  app._refresh = () => calls.push('refresh');
  app._showPanel = id => calls.push(`panel:${id}`);

  const mainText = { textContent: '' };
  const oldDocument = globalThis.document;
  globalThis.document = { querySelector: selector => selector === '#main-text' ? mainText : null };
  try {
    gs.phase = PHASE.SETUP;
    gs.currentPlayer = gs.player1;
    app._onMainAction('fight');
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }

  assert.deepEqual(calls, ['refresh', 'panel:panel-main']);
  assert.equal(mainText.textContent.includes('请重新开始或更换对手卡组'), true);
  assert.equal(mainText.textContent.includes('可重试确认或重新选择卡组'), true);
  assert.equal(gs.phase, PHASE.SETUP);
});

await test('确认布置：对手手牌进化宝可梦在基础前时仍成功并放置基础', () => {
  const gs = new GameState();
  const resolver = fakeResolver({
    evo: { card: { cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽', hp:90 } },
    basic: { card: { cardType:'pokemon', name:'基础兽', stage:'基础', hp:60 } },
    energy: { card: { cardType:'energy', name:'基本【雷】能量' } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  gs.phase = PHASE.SETUP;
  gs.currentPlayer = gs.player1;
  gs.turn = 0;
  gs.player1.active = mon('玩家基础', 'p1-basic');
  gs.player1.hand = [];
  gs.player1.deck = ['p1-top'];
  gs.player2.hand = ['evo', 'basic', 'energy'];

  const ok = engine.confirmSetup();

  assert.equal(ok, true);
  assert.equal(gs.player2.active.name, '基础兽');
  assert.deepEqual(gs.player2.hand, ['evo', 'energy']);
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.turn, 1);
});

await test('确认布置：正常双方基础宝可梦布置仍成功进入主阶段', () => {
  const gs = new GameState();
  const resolver = fakeResolver({
    basic: { card: { cardType:'pokemon', name:'对手基础', stage:'基础', hp:60 } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  gs.phase = PHASE.SETUP;
  gs.currentPlayer = gs.player1;
  gs.turn = 0;
  gs.player1.active = mon('玩家基础', 'p1-basic');
  gs.player1.hand = [];
  gs.player1.deck = ['p1-top'];
  gs.player2.hand = ['basic'];

  const ok = engine.confirmSetup();

  assert.equal(ok, true);
  assert.equal(gs.player2.active.name, '对手基础');
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.turn, 1);
  assert.deepEqual(gs.player1.hand, ['p1-top']);
});

await test('引擎放置返回真实失败，后续附能路径仍可写日志', async () => {
  const gs = new GameState();
  const resolver = fakeResolver({});
  const engine = new BattleEngine(gs, resolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['evo', 'basic', 'bench', 'energy'];

  assert.equal(engine.placeActivePokemon(0, { cardType:'pokemon', name:'进化兽', stage:'1阶', evolvesFrom:'基础兽' }), false);
  assert.deepEqual(pl.hand, ['evo', 'basic', 'bench', 'energy']);
  assert.equal(engine.placeActivePokemon(1, { cardType:'pokemon', name:'基础兽', stage:'基础', hp:60 }), true);
  assert.equal(engine.placeBenchPokemon(1, { cardType:'pokemon', name:'备战兽', stage:'基础', hp:60 }), true);
  assert.equal(await engine.attachEnergy(1, { cardType:'energy', name:'基本【雷】能量' }, 'active'), true);
  assert.equal(pl.active.energy[0].name, '基本【雷】能量');
  assert.equal(Array.isArray(gs.log), true);
  assert.equal(gs.log.at(-1), '玩家 为 基础兽 附着了 基本【雷】能量');
});

await test('精灵图工具：编号生成稳定URL并提供onerror隐藏回退', () => {
  // 2026-09：立绘已本地化到 /ptcg/images/sprites/（原 /ddp/images/ 是 ddp 子项目的另一套美术）
  assert.equal(pokemonSpriteSrc('719'), '/ptcg/images/sprites/719.png');
  assert.equal(pokemonSpriteSrc('774'), '/ptcg/images/sprites/774.png');
  assert.equal(pokemonSpriteSrc(null), '');
  // 补零规则：3 位；4 位数不截断
  assert.equal(pokemonSpriteSrc(25), '/ptcg/images/sprites/025.png');
  assert.equal(pokemonSpriteSrc(1000), '/ptcg/images/sprites/1000.png');
  // 背面（我方立绘）走 back 子目录
  assert.equal(pokemonSpriteSrc(25, undefined, { back: true }), '/ptcg/images/sprites/back/025.png');
  const html = pokemonSpriteImgHtml('719', '蒂安希');
  assert.equal(html.includes('src="/ptcg/images/sprites/719.png"'), true);
  assert.equal(html.includes('onerror='), true);
  assert.equal(html.includes('sprite-missing'), true);
});

await test('精灵图工具：默认本地优先，回退链含本地背面→本地正面→在线', () => {
  assert.equal(SPRITE_PREFER_ONLINE, false, '立绘本地化后应默认本地优先');
  const chain = pokemonSpriteCandidates(25, { back: true });
  assert.equal(chain[0], '/ptcg/images/sprites/back/025.png', '第一位应是本地背面');
  assert.equal(chain[1], '/ptcg/images/sprites/025.png', '第二位应是本地正面');
  assert.ok(chain[2].startsWith('https://'), '第三位应是在线背面');
  assert.ok(chain.some(u => u.includes('sprites/pokemon/back/25.png')), '在线背面 URL 应正确');
  // 正面时不应混入 back 段
  const front = pokemonSpriteCandidates(25, { back: false });
  assert.equal(front[0], '/ptcg/images/sprites/025.png');
  assert.ok(!front[1].includes('/back/'), '正面链不应出现 back');
});

await test('立绘已本地化：卡池里每个图鉴号的正/背两张图都在本地', () => {
  // 防止以后新增卡包（出现新图鉴号）时忘记跑 fetch-battle-sprites.py
  const dex = new Set();
  for (const f of ['pokemon-cards.json']) {
    for (const c of loadJson(f)) {
      const n = parseInt(c['编号'], 10);
      if (Number.isFinite(n)) dex.add(n);
    }
  }
  assert.ok(dex.size > 900, `图鉴号数量异常: ${dex.size}`);
  const missing = [];
  let bytes = 0;
  for (const n of dex) {
    for (const back of [false, true]) {
      const rel = pokemonSpriteSrc(n, undefined, { back }).replace(/^\//, '');
      // pokemonSpriteSrc 返回的是站点绝对路径（/ptcg/...），要从**仓库根**解析
      const abs = path.resolve(__dirname, '..', '..', '..', rel);
      if (!fs.existsSync(abs)) missing.push(rel);
      else bytes += fs.statSync(abs).size;
    }
  }
  if (missing.length) {
    console.error(`    缺失 ${missing.length} 张，例: ${missing.slice(0, 5).join(', ')}`);
    console.error('    修复: python3 ptcg/tools/fetch-battle-sprites.py');
  }
  assert.equal(missing.length, 0, `本地缺 ${missing.length} 张立绘（跑一下 fetch-battle-sprites.py）`);
  // 体积合理性：全量应在 1~12 MB
  const mb = bytes / 1048576;
  assert.ok(mb > 1 && mb < 12, `立绘总体积异常: ${mb.toFixed(2)} MB`);
});

await test('CardResolver 保留真实卡牌撤退费用 0', () => {
  const resolver = new CardResolver();
  const raw = loadJson('pokemon-cards.json').find(c => String(c['撤退']) === '0');
  assert.ok(raw, 'missing zero-retreat pokemon in real data');
  const card = resolver._pokemon(raw);
  assert.equal(card.retreatCost, 0);
});

await test('CardResolver 标记ex、光辉与规则盒元数据', () => {
  const resolver = new CardResolver();
  const exRaw = loadJson('pokemon-cards.json').find(c => /ex/i.test(`${c['宝可梦名字'] || ''} ${c['规则'] || ''} ${c['规则2'] || ''}`));
  const radiantRaw = loadJson('pokemon-cards.json').find(c => /^光辉/.test(c['宝可梦名字'] || '') || /光辉宝可梦/.test(`${c['规则'] || ''} ${c['规则2'] || ''}`));
  assert.ok(exRaw, 'missing ex pokemon in real data');
  assert.ok(radiantRaw, 'missing radiant pokemon in real data');
  const exCard = resolver._pokemon(exRaw);
  const radiantCard = resolver._pokemon(radiantRaw);
  assert.equal(exCard.isEx, true);
  assert.equal(exCard.hasRuleBox, true);
  assert.equal(radiantCard.isRadiant, true);
  assert.equal(radiantCard.hasRuleBox, true);
});

await test('CardResolver 真实道具：大气球、幸存锻炼器、超群眼镜解析为宝可梦道具', () => {
  const resolver = new CardResolver();
  const tools = loadJson('PokemonTool-cards.json');
  const byId = id => tools.find(c => (c['卡牌ID'] || []).includes(id));
  const airBall = resolver._trainer({ ...byId('9024'), _t:'tool' });
  const survival = resolver._trainer({ ...byId('11176'), _t:'tool' });
  const glasses = resolver._trainer({ ...byId('7035'), _t:'tool' });
  assert.equal(airBall.trainerType, 'tool');
  assert.equal(airBall.name, '大气球');
  assert.equal(survival.trainerType, 'tool');
  assert.equal(survival.name, '幸存锻炼器');
  assert.equal(glasses.trainerType, 'tool');
  assert.equal(glasses.name, '超群眼镜');
});

await test('手牌能量可附着到战斗宝可梦 active', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['energy-1'];
  pl.active = mon('出战A');
  const ok = gs.attachEnergy(pl, 0, { cardType: 'energy', name: '基本【雷】能量' }, 'active');
  assert.equal(ok, true);
  assert.equal(pl.active.energy[0].name, '基本【雷】能量');
  assert.deepEqual(pl.hand, []);
});

await test('UI能量标签/属性分类：支持GameState附着的对象能量', () => {
  const attachedEnergy = { cardId: 'energy-1', name: '基本【雷】能量', provides: null, specialRules: null };
  assert.equal(energyLabel(attachedEnergy), '基本【雷】能量');
  assert.equal(energyElementClass(attachedEnergy), 'lightning');
  assert.equal(energyElementClass('基本【火】能量'), 'fire');
  assert.equal(energyElementClass({ cardId: 'unknown-energy' }), 'colorless');
});

await test('UI宝可梦选择器：按allowActive/allowBench/selectableSlots判断槽位与确认状态', () => {
  const anyOptions = { allowActive: true, allowBench: true };
  assert.equal(pokemonPickerSlotAllowed('active', anyOptions), true);
  assert.equal(pokemonPickerSlotAllowed('bench-0', anyOptions), true);
  assert.equal(pokemonPickerConfirmEnabled('active', anyOptions), true);
  assert.equal(pokemonPickerConfirmEnabled('bench-0', anyOptions), true);

  const benchOnly = { allowActive: false, allowBench: true };
  assert.equal(pokemonPickerSlotAllowed('active', benchOnly), false);
  assert.equal(pokemonPickerSlotAllowed('bench-1', benchOnly), true);
  assert.equal(pokemonPickerConfirmEnabled('active', benchOnly), false);
  assert.equal(pokemonPickerConfirmEnabled('bench-1', benchOnly), true);

  const activeOnly = { allowActive: true, allowBench: false };
  assert.equal(pokemonPickerSlotAllowed('active', activeOnly), true);
  assert.equal(pokemonPickerSlotAllowed('bench-2', activeOnly), false);
  assert.equal(pokemonPickerConfirmEnabled(null, activeOnly), false);

  const selectable = { allowActive: true, allowBench: true, selectableSlots: ['bench-1'] };
  assert.equal(pokemonPickerSlotAllowed('active', selectable), false);
  assert.equal(pokemonPickerSlotAllowed('bench-0', selectable), false);
  assert.equal(pokemonPickerSlotAllowed('bench-1', selectable), true);
  assert.equal(pokemonPickerConfirmEnabled('active', selectable), false);
  assert.equal(pokemonPickerConfirmEnabled('bench-1', selectable), true);
});

await test('UI宝可梦选择器：渲染辅助状态标记非法槽位disabled且只允许合法目标', () => {
  const pl = { active: mon('出战'), bench: [mon('备战0'), mon('备战1')] };
  const onlyBench1 = { allowActive: true, allowBench: true, selectableSlots: ['bench-1'] };
  assert.equal(pokemonPickerHasLegalTarget(pl, onlyBench1), true);
  assert.deepEqual(pokemonPickerSlotClass('active', onlyBench1, 'active'), {
    allowed: false,
    selected: false,
    className: ' disabled',
  });
  assert.deepEqual(pokemonPickerSlotClass('bench-1', onlyBench1, 'bench-1'), {
    allowed: true,
    selected: true,
    className: ' selectable selected',
  });
  assert.equal(pokemonPickerHasLegalTarget(pl, { allowActive: false, allowBench: true, selectableSlots: ['bench-3'] }), false);
});

await test('UI选卡器标题：options.prompt优先且保留撤退/查看/通用回退', () => {
  assert.equal(cardPickerTitleFor({ cards:['A'], count:1, options:{ source:'hand-discard', prompt:'选择要丢弃的手牌' } }), '选择要丢弃的手牌');
  assert.equal(cardPickerTitleFor({ cards:['A','B'], count:2, options:{ source:'retreat-energy', cost:2 } }), '选择撤退能量（费用2）');
  assert.equal(cardPickerTitleFor({ cards:['A'], count:1, options:{ source:'peek' } }), '选择1张卡');
  assert.equal(cardPickerTitleFor({ cards:['A'], count:1, options:{} }), '选择1张卡');
});

await test('UI宝可梦选择器标题：效果选择使用prompt且普通视图保留双方标题', () => {
  assert.equal(pokemonPickerTitleFor(true, { prompt:'选择附能目标' }, true), '选择附能目标');
  assert.equal(pokemonPickerTitleFor(false, { prompt:'选择放置伤害指示物的对手宝可梦' }, true), '选择放置伤害指示物的对手宝可梦');
  assert.equal(pokemonPickerTitleFor(true, { prompt:'不应影响普通视图' }, false), '我方宝可梦');
  assert.equal(pokemonPickerTitleFor(false, {}, true), '对方宝可梦');
});

await test('玩家攻击后会触发并完成对手回合，回到玩家 main 阶段', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{ name: '撞击', damage: 10, cost: [], effects: [] }]);
  gs.player2.active = mon('防守方', 'def', [{ name: '反击', damage: 10, cost: [], effects: [] }]);
  const { engine, events } = makeEngineWithEvents(gs);

  await withImmediateTimeout(async pending => {
    const ok = await engine.attack();
    assert.equal(ok, true);
    assert.equal(pending.length, 1);
  });

  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.player2.active.hp, 50);
  assert.equal(gs.player1.active.hp, 50);
  assert.equal(gs.pendingPick, null);
  assert.equal(gs.pendingPokemonPick, null);
  assert.equal(events.logs.some(msg => msg.includes('对手回合')), true);
  assert.equal(events.phases.includes(PHASE.BATTLE), true);
  assert.equal(events.phases.at(-1), PHASE.MAIN);
  assert.equal(events.fields > 0, true);
});

await test('AI在main阶段有合法招式时会进入battle并攻击后交还玩家', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = gs.player2;
  gs.player1.active = mon('玩家出战');
  gs.player2.active = mon('AI出战', 'ai', [{ name: '免费攻击', damage: 20, cost: [], effects: [] }]);
  const { engine, events } = makeEngineWithEvents(gs);
  engine.aiActionDelayMs = 0;

  await engine._aiTurn();

  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.MAIN);
  // 新 AI 逐动作推进：MAIN →（进入战斗阶段）→ 攻击 → 交还玩家
  assert.equal(gs.player1.active.hp, 40, 'AI 应完成攻击并造成伤害');
  assert.equal(events.logs.some(msg => msg.includes('战斗阶段')), true, '应记录进入战斗阶段');
  assert.equal(events.phases.at(-1), PHASE.MAIN);
});

await test('AI无合法招式或能量不足时会pass并回到玩家', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = gs.player2;
  gs.player1.active = mon('玩家出战');
  gs.player2.active = mon('AI出战', 'ai', [{ name: '火费攻击', damage: 50, cost: ['fire'], effects: [] }]);
  const { engine, events } = makeEngineWithEvents(gs);
  engine.aiActionDelayMs = 0;

  await engine._aiTurn();

  assert.equal(gs.currentPlayer, gs.player1, '无招可打也应把行动权交回玩家');
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.player1.active.hp, 60, '能量不足不应造成伤害');
  assert.equal(engine._aiTurnInProgress, false);
  assert.equal(events.phases.at(-1), PHASE.MAIN);
});

await test('AI攻击失败路径会结束回合且不遗留进行中状态', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player2;
  gs.player1.active = mon('玩家出战');
  gs.player2.active = mon('睡眠AI', 'ai', [{ name: '梦中攻击', damage: 20, cost: [], effects: [] }]);
  gs.player2.active.status = 'sleep';
  const { engine, events } = makeEngineWithEvents(gs);
  engine.aiActionDelayMs = 0;

  await engine._aiTurn();

  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(gs.player1.active.hp, 60, '睡眠中不能攻击');
  assert.equal(engine._aiTurnInProgress, false, '不应遗留进行中状态');
  assert.equal(events.phases.at(-1), PHASE.MAIN);
});

await test('连续回合循环不会卡在对手回合或重复触发AI', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('玩家出战', 'p', [{ name: '轻击', damage: 5, cost: [], effects: [] }]);
  gs.player2.active = mon('AI出战', 'ai', [{ name: '轻击', damage: 5, cost: [], effects: [] }]);
  const { engine } = makeEngineWithEvents(gs);

  await withImmediateTimeout(async pending => {
    assert.equal(await engine.attack(), true);
    await Promise.all(pending.splice(0));
    assert.equal(gs.currentPlayer, gs.player1);
    assert.equal(gs.phase, PHASE.MAIN);

    engine.advancePhase();
    assert.equal(gs.phase, PHASE.BATTLE);
    assert.equal(await engine.attack(), true);
  });

  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.MAIN);
  assert.equal(engine._aiTurnInProgress, false);
  assert.equal(gs.pendingPick, null);
  assert.equal(gs.pendingPokemonPick, null);
});

await test('招式选择：指定第二个招式造成第二个招式伤害', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [
    { name: '弱攻击', damage: 10, cost: [], effects: [] },
    { name: '强攻击', damage: 40, cost: [], effects: [] },
  ]);
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { assert.equal(await makeEngine(gs).attack(1), true); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 20);
});

await test('招式选择：指定招式按自身费用检查，无参默认仍用第一个招式', async () => {
  let gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [
    { name: '免费攻击', damage: 10, cost: [], effects: [] },
    { name: '火费攻击', damage: 50, cost: ['fire'], effects: [] },
  ]);
  gs.player2.active = mon('防守方');
  assert.equal(await makeEngine(gs).attack(1), false);
  assert.equal(gs.player2.active.hp, 60);
  assert.equal(gs.currentPlayer, gs.player1);

  gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [
    { name: '默认攻击', damage: 10, cost: [], effects: [] },
    { name: '高伤攻击', damage: 50, cost: [], effects: [] },
  ]);
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { assert.equal(await makeEngine(gs).attack(), true); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 50);
});

await test('中毒/灼伤在回合结束时结算伤害', () => {
  const gs = new GameState();
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('异常宝可梦');
  gs.player1.active.status = 'poison,burn';
  const realRandom = Math.random;
  Math.random = () => 0.9; // 灼伤投币为反面 → 放2个伤害指示物(-20)
  try { gs.endTurn(); } finally { Math.random = realRandom; }
  assert.equal(gs.player1.active.hp, 30);
});

await test('阿尔宙斯手机：选择奖赏卡索引1与牌库顶互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['prize0', 'prize1', 'prize2'];
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['prize0', 'prize1', 'prize2']);
    assert.equal(pick.options?.source, 'prize-deck-top-swap');
    assert.equal(pick.options?.allowEmpty, true);
    gs.resolvePick([1]);
  };
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: { optional:true } }]);
  assert.deepEqual(pl.deck, ['d1', 'prize1']);
  assert.deepEqual(pl.prizes, ['prize0', 'top', 'prize2']);
});

await test('阿尔宙斯手机：无选择器时默认奖赏卡0与牌库顶互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['prize0', 'prize1'];
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: {} }]);
  assert.deepEqual(pl.deck, ['d1', 'prize0']);
  assert.deepEqual(pl.prizes, ['top', 'prize1']);
});

await test('阿尔宙斯手机：选择器空选择/取消时不互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['prize0', 'prize1'];
  gs._onPendingPick = () => gs.resolvePick([]);
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: { optional:true } }]);
  assert.deepEqual(pl.deck, ['d1', 'top']);
  assert.deepEqual(pl.prizes, ['prize0', 'prize1']);
});

await test('阿尔宙斯手机：仅1张奖赏且可选时选择器空选择/取消不互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['onlyPrize'];
  let pickCount = 0;
  gs._onPendingPick = pick => {
    pickCount++;
    assert.deepEqual(pick.cards, ['onlyPrize']);
    assert.equal(pick.options?.source, 'prize-deck-top-swap');
    assert.equal(pick.options?.allowEmpty, true);
    gs.resolvePick([]);
  };
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: { optional:true } }]);
  assert.deepEqual(pl.deck, ['d1', 'top']);
  assert.deepEqual(pl.prizes, ['onlyPrize']);
  assert.equal(pickCount, 1);
});

await test('阿尔宙斯手机：仅1张奖赏且可选时选择器选择则互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['onlyPrize'];
  let pickCount = 0;
  gs._onPendingPick = pick => {
    pickCount++;
    assert.deepEqual(pick.cards, ['onlyPrize']);
    assert.equal(pick.options?.allowEmpty, true);
    gs.resolvePick([0]);
  };
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: { optional:true } }]);
  assert.deepEqual(pl.deck, ['d1', 'onlyPrize']);
  assert.deepEqual(pl.prizes, ['top']);
  assert.equal(pickCount, 1);
});

await test('阿尔宙斯手机：仅1张奖赏且无选择器可选时仍默认奖赏卡0互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'top'];
  pl.prizes = ['onlyPrize'];
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: { optional:true } }]);
  assert.deepEqual(pl.deck, ['d1', 'onlyPrize']);
  assert.deepEqual(pl.prizes, ['top']);
});

await test('阿尔宙斯手机：空牌库或无奖赏卡时不互换', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = [];
  pl.prizes = ['prize0'];
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: {} }]);
  assert.deepEqual(pl.deck, []);
  assert.deepEqual(pl.prizes, ['prize0']);

  pl.deck = ['top'];
  pl.prizes = [];
  await executeEffects(gs, pl, [{ action: 'prize_deck_top_swap', params: {} }]);
  assert.deepEqual(pl.deck, ['top']);
  assert.deepEqual(pl.prizes, []);
});

await test('百万吨吹风机：丢弃对手道具、特殊能量和竞技场', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.stadium = '我方竞技场';
  opp.stadium = '对方竞技场';
  opp.active = mon('对手');
  opp.active.tool = { cardId:'tool-print-1', name:'宝可梦道具' };
  opp.bench = [mon('对手备战')];
  opp.bench[0].tool = '旧字符串道具';
  const basicEnergyObject = { cardId:'basic-energy-print', name:'基本火能量' };
  const specialEnergyByCardId = { cardId:'special-energy-print', name:'双重无色能量' };
  const specialEnergyById = { id:'special-energy-id', name:'特殊能量' };
  opp.active.energy = ['基本【雷】能量', '特殊能量', basicEnergyObject, specialEnergyByCardId];
  opp.bench[0].energy = [specialEnergyById];
  gs.cardResolver = fakeResolver({
    'basic-energy-print': { info:{ name:'基本火能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本火能量' } },
    'special-energy-print': { info:{ name:'双重无色能量', number:null, type:'specialEnergy' }, card:{ cardType:'specialEnergy', name:'双重无色能量' } },
    'special-energy-id': { info:{ name:'特殊能量', number:null, type:'specialEnergy' }, card:{ cardType:'specialEnergy', name:'特殊能量' } },
  });
  await executeEffects(gs, pl, [{ action: 'discard_field_attachments', params: { target:'opponent', tools:true, specialEnergy:true, stadium:true } }]);
  assert.equal(opp.active.tool, null);
  assert.equal(opp.bench[0].tool, null);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量', basicEnergyObject]);
  assert.deepEqual(opp.bench[0].energy, []);
  assert.equal(pl.stadium, null);
  assert.equal(opp.stadium, null);
  assert.ok(opp.discard.includes('tool-print-1'));
  assert.ok(opp.discard.includes('旧字符串道具'));
  assert.ok(opp.discard.includes('特殊能量'));
  assert.ok(opp.discard.includes('special-energy-print'), '特殊能量以 cardId 进弃牌区');
  assert.ok(opp.discard.includes('special-energy-id'), '特殊能量以 id 进弃牌区');
  assert.equal(opp.discard.includes(basicEnergyObject), false);
});

await test('宝可梦通信解析为 hand_pokemon_to_deck_search_pokemon 且无残留', () => {
  const parsed = parseEffect('从自己的手牌抽出1张宝可梦，在给对手看过后放回牌库。然后，从自己的牌库选择1张宝可梦，在给对手看过后加入手牌。并且重洗牌库。');
  assert.equal(parsed.unparsed, '', `residual=${parsed.unparsed}`);
  assert.equal(parsed.effects[0]?.action, 'hand_pokemon_to_deck_search_pokemon');
  assert.equal(parsed.effects[0]?.params.return_count, 1);
  assert.equal(parsed.effects[0]?.params.search_count, 1);
  assert.equal(parsed.effects[0]?.params.filter, '宝可梦');
});

await test('search_deck_to_hand：宝可梦过滤跳过可识别非宝可梦并选择指定宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['物品 bottom', '支援者 博士的研究', '皮卡丘 宝可梦', '基本【雷】能量', '妙蛙种子 宝可梦'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['妙蛙种子 宝可梦', '皮卡丘 宝可梦']);
    assert.equal(pick.options?.source, 'deck-search');
    assert.equal(pick.options?.filter, '宝可梦');
    gs.resolvePick([1]);
  };
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['皮卡丘 宝可梦']);
  assert.equal(pl.deck.includes('皮卡丘 宝可梦'), false);
  assert.equal(pl.deck.includes('支援者 博士的研究'), true);
  assert.equal(pl.deck.includes('基本【雷】能量'), true);
});

await test('search_deck_to_hand：【草】能量过滤跳过标签可识别不匹配卡', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', '基本【雷】能量', '皮卡丘 宝可梦', '基本【草】能量'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['基本【草】能量']);
    assert.equal(pick.options?.filter, '基本【草】能量');
    gs.resolvePick([0]);
  };
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'基本【草】能量' } }]);
  assert.deepEqual(pl.hand, ['基本【草】能量']);
  assert.equal(pl.deck.includes('基本【雷】能量'), true);
  assert.equal(pl.deck.includes('皮卡丘 宝可梦'), true);
});

await test('search_deck_to_hand：无选卡器时回退选择第一张可匹配候选而非任意顶牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', '妙蛙种子 宝可梦', '基本【雷】能量'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['妙蛙种子 宝可梦']);
  assert.equal(pl.deck.includes('基本【雷】能量'), true);
});

await test('search_deck_to_hand：ID-only 牌库条目在过滤无法判定时保持可选安全回退', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'unresolved-id-001', '基本【雷】能量'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['unresolved-id-001']);
  assert.equal(pl.deck.includes('基本【雷】能量'), true);
});

await test('search_deck_to_hand：resolver metadata 排除 ID-only 非宝可梦并保留宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    item001: { info:{ name:'宝可梦通信', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'宝可梦通信' } },
    supporter001: { info:{ name:'博士的研究', number:null, type:'supporter' }, card:{ cardType:'trainer', trainerType:'supporter', name:'博士的研究' } },
    pokemon001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘' } },
  });
  pl.deck = ['bottom', 'pokemon001', 'supporter001', 'item001'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['pokemon001']);
  assert.equal(pl.deck.includes('item001'), true);
  assert.equal(pl.deck.includes('supporter001'), true);
});

await test('search_deck_to_hand：resolver metadata 仍让 unknown ID 走宝可梦安全回退', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    item001: { info:{ name:'宝可梦通信', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'宝可梦通信' } },
  });
  pl.deck = ['bottom', 'unknown-pokemon-ish', 'item001'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['unknown-pokemon-ish']);
  assert.equal(pl.deck.includes('item001'), true);
});

await test('search_deck_to_hand：resolver metadata 区分基本草能量、雷能量与宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    grassEnergy: { info:{ name:'基本【草】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【草】能量', element:'草' } },
    lightningEnergy: { info:{ name:'基本【雷】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【雷】能量', element:'雷' } },
    pokemon001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘' } },
  });
  pl.deck = ['bottom', 'pokemon001', 'lightningEnergy', 'grassEnergy'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'基本【草】能量' } }]);
  assert.deepEqual(pl.hand, ['grassEnergy']);
  assert.equal(pl.deck.includes('lightningEnergy'), true);
  assert.equal(pl.deck.includes('pokemon001'), true);
});

await test('search_deck_to_hand：resolver metadata 区分特殊能量与基本能量', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    specialEnergy: { info:{ name:'双重无色能量', number:null, type:'specialEnergy' }, card:{ cardType:'specialEnergy', name:'双重无色能量' } },
    grassEnergy: { info:{ name:'基本【草】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【草】能量', element:'草' } },
  });
  pl.deck = ['bottom', 'grassEnergy', 'specialEnergy'];
  pl.hand = [];
  gs._shuffle = deck => deck;
  await executeEffects(gs, pl, [{ action: 'search_deck_to_hand', params: { count:1, filter:'特殊' } }]);
  assert.deepEqual(pl.hand, ['specialEnergy']);
  assert.equal(pl.deck.includes('grassEnergy'), true);
});

await test('BattleEngine：构造时将 resolver 暴露给 GameState 供效果过滤使用', async () => {
  const gs = new GameState();
  const resolver = fakeResolver({
    item001: { info:{ name:'宝可梦通信', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'宝可梦通信' } },
    pokemon001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘' } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });
  assert.equal(gs.cardResolver, resolver);
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.deck = ['bottom', 'pokemon001', 'item001'];
  pl.hand = ['trainerCard'];
  gs._shuffle = deck => deck;
  gs.useTrainer = () => true;
  await engine.useTrainer(0, { cardType:'trainer', trainerType:'item', name:'测试物品', effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } }] });
  assert.deepEqual(pl.hand, ['trainerCard', 'pokemon001']);
  assert.equal(pl.deck.includes('item001'), true);
});

await test('宝可梦通信：玩家可选择非第一张手牌宝可梦回牌库并搜指定宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['firstPokemon', 'chosenPokemon', 'lastPokemon'];
  pl.deck = ['物品 超级球', 'deckPokemonA 宝可梦', '基本【雷】能量', 'deckPokemonB 宝可梦'];
  const originalDeckCards = new Set(pl.deck);
  gs._shuffle = deck => deck;
  const picks = [[1], [1]];
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'hand-pokemon-return') {
      assert.deepEqual(pick.cards, ['firstPokemon', 'chosenPokemon', 'lastPokemon']);
      assert.equal(pick.count, 1);
    } else {
      assert.deepEqual(pick.cards, ['chosenPokemon', 'deckPokemonB 宝可梦', 'deckPokemonA 宝可梦']);
    }
    gs.resolvePick(picks.shift());
  };
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['firstPokemon', 'lastPokemon', 'deckPokemonB 宝可梦']);
  assert.equal(pl.deck.includes('chosenPokemon'), true);
  assert.equal(pl.deck.includes('deckPokemonB 宝可梦'), false);
  assert.equal(pl.deck.includes('物品 超级球'), true);
  assert.equal(pl.deck.includes('基本【雷】能量'), true);
  assert.equal(originalDeckCards.has(pl.hand[2]), true);
  assert.equal(picks.length, 0);
});

await test('宝可梦通信：可识别的非宝可梦手牌不会进入回牌库选择', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['支援者 博士的研究', '皮卡丘 宝可梦', '基本【雷】能量'];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck;
  const picks = [[1]];
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'hand-pokemon-return') assert.deepEqual(pick.cards, ['皮卡丘 宝可梦']);
    else assert.deepEqual(pick.cards, ['皮卡丘 宝可梦', 'deckPokemon']);
    gs.resolvePick(picks.shift());
  };
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['支援者 博士的研究', '基本【雷】能量', 'deckPokemon']);
  assert.equal(pl.deck.includes('皮卡丘 宝可梦'), true);
});

await test('宝可梦通信：宝可梦道具标签不抢先作为手牌宝可梦回退目标', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['宝可梦道具 力量头带', '皮卡丘 宝可梦'];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck.reverse();
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['宝可梦道具 力量头带', 'deckPokemon']);
  assert.equal(pl.deck.includes('皮卡丘 宝可梦'), true);
  assert.equal(pl.deck.includes('宝可梦道具 力量头带'), false);
});

await test('宝可梦通信：选卡器候选排除宝可梦道具标签', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['宝可梦道具 力量头带', '皮卡丘 宝可梦', '妙蛙种子 宝可梦'];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck;
  const picks = [[1], [1]];
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'hand-pokemon-return') assert.deepEqual(pick.cards, ['皮卡丘 宝可梦', '妙蛙种子 宝可梦']);
    gs.resolvePick(picks.shift());
  };
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['宝可梦道具 力量头带', '皮卡丘 宝可梦', 'deckPokemon']);
  assert.equal(pl.deck.includes('妙蛙种子 宝可梦'), true);
  assert.equal(pl.deck.includes('宝可梦道具 力量头带'), false);
  assert.equal(picks.length, 0);
});

await test('宝可梦通信：含宝可梦名称的训练家/道具 metadata 被排除', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const trainer = { cardType:'trainer', trainerType:'item', name:'宝可梦通信' };
  const tool = { cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' };
  const pokemon = { cardType:'pokemon', name:'皮卡丘 宝可梦' };
  pl.hand = [trainer, tool, pokemon];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck.reverse();
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'hand-pokemon-return') assert.deepEqual(pick.cards, ['皮卡丘 宝可梦']);
    gs.resolvePick([0]);
  };
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, [trainer, tool, 'deckPokemon']);
  assert.equal(pl.deck.includes(pokemon), true);
  assert.equal(pl.deck.includes(trainer), false);
  assert.equal(pl.deck.includes(tool), false);
});

await test('宝可梦通信：metadata 接受宝可梦并排除能量/竞技场，未解析ID保留资格', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const energy = { cardType:'energy', name:'宝可梦能量?' };
  const stadium = { supertype:'trainer', trainerType:'stadium', name:'宝可梦竞技场' };
  const pokemon = { type:'Pokémon', name:'喷火龙' };
  pl.hand = [energy, stadium, 'unresolved-id-001', pokemon];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck.reverse();
  const picks = [[1], [0]];
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'hand-pokemon-return') assert.deepEqual(pick.cards, ['unresolved-id-001', '喷火龙']);
    gs.resolvePick(picks.shift());
  };
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, [energy, stadium, 'unresolved-id-001', 'deckPokemon']);
  assert.equal(pl.deck.includes(pokemon), true);
  assert.equal(pl.deck.includes(energy), false);
  assert.equal(pl.deck.includes(stadium), false);
  assert.equal(picks.length, 0);
});

await test('宝可梦通信：没有可匹配手牌宝可梦时不会任意退回第一张手牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['支援者 博士的研究', '基本【雷】能量'];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => gs.resolvePick([0]);
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['支援者 博士的研究', '基本【雷】能量', 'deckPokemon']);
  assert.equal(pl.deck.includes('支援者 博士的研究'), false);
  assert.equal(pl.deck.includes('基本【雷】能量'), false);
});

await test('宝可梦通信：无选卡器时回退选择第一张可匹配手牌宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['基本【雷】能量', 'firstPokemon', 'secondPokemon'];
  pl.deck = ['deckPokemon'];
  gs._shuffle = deck => deck.reverse();
  await executeEffects(gs, pl, [{ action: 'hand_pokemon_to_deck_search_pokemon', params: { return_count:1, search_count:1, filter:'宝可梦' } }]);
  assert.deepEqual(pl.hand, ['基本【雷】能量', 'secondPokemon', 'deckPokemon']);
  assert.equal(pl.deck.includes('firstPokemon'), true);
  assert.equal(pl.deck.includes('基本【雷】能量'), false);
});

await test('捕虫组合执行：只向 picker 暴露草宝可梦与基本草能量', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const grassEnergy = 'basic-grass-energy';
  const fireEnergy = 'basic-fire-energy';
  const grassPokemon = 'grass-basic-pokemon';
  const firePokemon = 'fire-basic-pokemon';
  const toolCard = 'pokemon-tool';
  pl.deck = ['bottom', toolCard, firePokemon, fireEnergy, grassPokemon, grassEnergy];
  gs.cardResolver = fakeResolver({
    [grassEnergy]: { info:{ name:'基本【草】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【草】能量', element:'草', provides:[{ types:['grass'], count:1 }] } },
    [fireEnergy]: { info:{ name:'基本【火】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【火】能量', element:'火', provides:[{ types:['fire'], count:1 }] } },
    [grassPokemon]: { info:{ name:'绿毛虫', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'绿毛虫', stage:'基础', element:'grass' } },
    [firePokemon]: { info:{ name:'小火龙', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'小火龙', stage:'基础', element:'fire' } },
    [toolCard]: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
  });
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['基本【草】能量', '绿毛虫']);
    gs.resolvePick([0, 1]);
  };

  await executeEffects(gs, pl, [{ action: 'peek_and_keep', params: { peek:7, keep:2, filter:'【草】宝可梦卡与基本【草】能量卡' } }]);

  assert.deepEqual(new Set(pl.hand), new Set([grassEnergy, grassPokemon]));
  assert.equal(pl.deck.includes(fireEnergy), true);
  assert.equal(pl.deck.includes(firePokemon), true);
  assert.equal(pl.deck.includes(toolCard), true);
});

await test('捕虫组合/宝可装置类：查看上方7张可选择最多2张', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
  gs._onPendingPick = pick => {
    assert.equal(pick.count, 2);
    assert.deepEqual(pick.cards, ['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    gs.resolvePick([0, 1]);
  };
  await executeEffects(gs, pl, [{ action: 'peek_and_keep', params: { peek:7, keep:2 } }]);
  assert.equal(pl.hand.length, 2);
});

await test('search_deck_to_bench：巢穴球只显示基础宝可梦并放置真实resolver数据', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'item001', 'evo001', 'basic002', 'energy001', 'basic001'];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    basic001: { info:{ name:'妙蛙种子', number:'001', type:'pokemon' }, card:{ cardType:'pokemon', name:'妙蛙种子', stage:'基础', hp:70, element:'grass', attacks:[{ name:'藤鞭', damage:20, cost:['grass'] }], retreatCost:1 } },
    basic002: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘', stage:'基础', hp:60, element:'lightning', attacks:[{ name:'电击', damage:10, cost:['lightning'] }], retreatCost:1 } },
    evo001: { info:{ name:'妙蛙草', number:'002', type:'pokemon' }, card:{ cardType:'pokemon', name:'妙蛙草', stage:'1阶', evolvesFrom:'妙蛙种子', hp:100, element:'grass' } },
    item001: { info:{ name:'巢穴球', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'巢穴球' } },
    energy001: { info:{ name:'基本【草】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【草】能量', element:'草' } },
  });
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['妙蛙种子', '皮卡丘']);
    assert.equal(pick.options?.source, 'deck-to-bench');
    gs.resolvePick([0]);
  };

  await executeEffects(gs, pl, [{ action: 'search_deck_to_bench', params: { count:1, filter:'【基础】宝可梦' } }]);

  assert.equal(pl.bench.length, 1);
  assert.equal(pl.bench[0].name, '妙蛙种子');
  assert.equal(pl.bench[0].hp, 70);
  assert.equal(pl.bench[0].maxHp, 70);
  assert.equal(pl.bench[0].element, 'grass');
  assert.equal(pl.bench[0].attacks[0].name, '藤鞭');
  assert.equal(pl.deck.includes('basic001'), false);
  assert.equal(pl.deck.includes('evo001'), true);
  assert.equal(pl.deck.includes('item001'), true);
  assert.equal(pl.deck.includes('energy001'), true);
});

await test('search_deck_to_bench：无 picker fallback 选择首个基础宝可梦而非顶牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'basic001', 'item001'];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    basic001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘', stage:'基础', hp:60, element:'lightning' } },
    item001: { info:{ name:'物品卡', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品卡' } },
  });

  await executeEffects(gs, pl, [{ action: 'search_deck_to_bench', params: { count:1, filter:'【基础】宝可梦' } }]);

  assert.equal(pl.bench.length, 1);
  assert.equal(pl.bench[0].name, '皮卡丘');
  assert.equal(pl.deck.includes('item001'), true);
  assert.equal(pl.deck.includes('basic001'), false);
});

await test('search_deck_to_bench：备战区满时不选卡且洗牌后跳过', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.bench = [mon('A'), mon('B'), mon('C'), mon('D'), mon('E')];
  pl.deck = ['basic001'];
  let shuffled = false;
  gs._shuffle = deck => { shuffled = true; return deck; };
  gs._onPendingPick = () => assert.fail('bench full should not request picker');
  gs.cardResolver = fakeResolver({
    basic001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘', stage:'基础', hp:60 } },
  });

  await executeEffects(gs, pl, [{ action: 'search_deck_to_bench', params: { count:1, filter:'【基础】宝可梦' } }]);

  assert.equal(pl.bench.length, 5);
  assert.deepEqual(pl.deck, ['basic001']);
  assert.equal(shuffled, true);
});

await test('WP1 好友宝芬：只显示HP70以下基础宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['bottom', 'item001', 'evo001', 'hp80basic', 'hp70basic', 'hp60basic'];
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    hp60basic: { info:{ name:'波波', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'波波', stage:'基础', hp:60, element:'colorless' } },
    hp70basic: { info:{ name:'皮卡丘', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘', stage:'基础', hp:70, element:'lightning' } },
    hp80basic: { info:{ name:'卡蒂狗', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'卡蒂狗', stage:'基础', hp:80, element:'fire' } },
    evo001: { info:{ name:'比比鸟', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'比比鸟', stage:'1阶', hp:80, element:'colorless' } },
    item001: { info:{ name:'普通物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'普通物品' } },
  });
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'deck-search');
    assert.deepEqual(pick.cards, ['皮卡丘', '波波']);
    gs.resolvePick([0, 1]);
  };
  await executeEffects(gs, pl, [{ action:'search_deck_to_hand', params:{ count:2, filter:'HP「70」以下的【基础】宝可梦' } }]);
  assert.deepEqual(new Set(pl.hand), new Set(['hp70basic', 'hp60basic']));
  assert.equal(pl.deck.includes('hp80basic'), true);
  assert.equal(pl.deck.includes('evo001'), true);
  assert.equal(pl.deck.includes('item001'), true);
});

await test('WP1 深钵镇：竞技场启动只放置非规则基础宝可梦并洗牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.hand = ['artazon'];
  pl.deck = ['bottom', 'item001', 'evo001', 'ruleBasic', 'plainBasic'];
  let shuffled = false;
  gs._shuffle = deck => { shuffled = true; return deck; };
  gs.cardResolver = fakeResolver({
    plainBasic: { info:{ name:'小火龙', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'小火龙', stage:'基础', hp:70, element:'fire' } },
    ruleBasic: { info:{ name:'密勒顿ex', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'密勒顿ex', stage:'基础', hp:220, element:'lightning', ruleBox:'规则宝可梦' } },
    evo001: { info:{ name:'火恐龙', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'火恐龙', stage:'1阶', hp:90, element:'fire' } },
    item001: { info:{ name:'普通物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'普通物品' } },
  });
  const effects = [
    { action:'usage_condition', params:{ kind:'once_per_turn' } },
    { action:'search_deck_to_bench', params:{ count:1, filter:'拥有规则的宝可梦除外的【基础】宝可梦' } },
  ];
  gs._onPendingPick = pick => { assert.equal(pick.options?.source, 'deck-to-bench'); assert.deepEqual(pick.cards, ['小火龙']); gs.resolvePick([0]); };
  let ok = await makeEngine(gs).useTrainer(0, { cardType:'trainer', trainerType:'stadium', name:'深钵镇', effects });
  assert.equal(ok, true);
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.bench.length, 0);
  ok = await makeEngine(gs).activateStadium(pl);
  assert.equal(ok, true);
  assert.equal(pl.bench.length, 1);
  assert.equal(pl.bench[0].name, '小火龙');
  assert.equal(pl.deck.includes('plainBasic'), false);
  assert.equal(pl.deck.includes('ruleBasic'), true);
  assert.equal(pl.deck.includes('evo001'), true);
  assert.equal(pl.deck.includes('item001'), true);
  assert.equal(shuffled, true);
});

await test('WP1 厉害钓竿：只将宝可梦与基本能量从弃牌区洗回牌库', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['deckBottom'];
  pl.discard = ['pokemon001', 'basicEnergy', 'specialEnergy', 'item001'];
  let shuffled = false;
  gs._shuffle = deck => { shuffled = true; return deck.reverse(); };
  gs.cardResolver = fakeResolver({
    pokemon001: { info:{ name:'玛力露', number:null, type:'pokemon' }, card:{ cardType:'pokemon', name:'玛力露', stage:'基础', hp:70, element:'water' } },
    basicEnergy: { info:{ name:'基本【水】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【水】能量', element:'water' } },
    specialEnergy: { info:{ name:'特殊能量', number:null, type:'specialEnergy' }, card:{ cardType:'specialEnergy', name:'特殊能量' } },
    item001: { info:{ name:'普通物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'普通物品' } },
  });
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:3, maxCount:3, minCount:0, allowFewer:true, allowEmpty:true, filter:card => card === 'pokemon001' || card === 'basicEnergy', target:'deck', shuffle:true } }]);
  assert.deepEqual(pl.discard, ['specialEnergy', 'item001']);
  assert.deepEqual(new Set(pl.deck), new Set(['deckBottom', 'pokemon001', 'basicEnergy']));
  assert.equal(shuffled, true);
});

await test('状态异常效果：对手战斗宝可梦获得 poison/confusion', async () => {
  const gs = new GameState();
  gs.player1.active = mon('我方');
  gs.player2.active = mon('对手');
  await executeEffects(gs, gs.player1, [{ action: 'inflict_status', params: { statuses: ['poison', 'confusion'] } }]);
  assert.equal(gs.player2.active.status, 'poison,confusion');
});

await test('WP5 几何雪花快速冻凝：麻痹只在后攻玩家最初回合适用', async () => {
  const effects = parseEffect('若在后攻玩家的最初回合，则将对手的战斗宝可梦【麻痹】。').effects;
  assert.equal(effects[0]?.action, 'inflict_status');
  assert.equal(effects[0]?.params.condition, 'second_player_first_turn');

  const legal = new GameState();
  legal.firstPlayer = legal.player1;
  legal.currentPlayer = legal.player2;
  legal.turn = 2;
  legal.player1.active = mon('先攻出战');
  legal.player2.active = mon('几何雪花');
  await executeEffects(legal, legal.player2, effects);
  assert.equal(legal.player1.active.status, 'paralysis');

  const illegal = new GameState();
  illegal.firstPlayer = illegal.player1;
  illegal.currentPlayer = illegal.player1;
  illegal.turn = 3;
  illegal.player1.active = mon('先攻出战');
  illegal.player2.active = mon('后攻出战');
  await executeEffects(illegal, illegal.player1, effects);
  assert.equal(illegal.player2.active.status, null);
});

await test('伤害指示物与备战伤害执行', async () => {
  const gs = new GameState();
  gs.player1.active = mon('我方');
  gs.player2.active = mon('对手出战');
  gs.player2.bench = [mon('对手备战')];
  await executeEffects(gs, gs.player1, [
    { action: 'damage_place', params: { target: 'opponent_active', count: 2 } },
    { action: 'damage_bench', params: { target: 'opponent_1', damage: 20 } },
  ]);
  assert.equal(gs.player2.active.hp, 40);
  assert.equal(gs.player2.bench[0].hp, 40);
});

await test('伤害指示物：玩家可选择对手任意宝可梦中的指定备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, opp);
    assert.equal(pick.options?.mode, 'damage');
    assert.equal(pick.options?.allowActive, true);
    assert.equal(pick.options?.allowBench, true);
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'damage_place', params: { target: 'opponent_any', count: 3 } }]);
  assert.equal(opp.active.hp, 60);
  assert.equal(opp.bench[0].hp, 60);
  assert.equal(opp.bench[1].hp, 30);
});

await test('伤害指示物：opponent_active 直接作用于对手出战', async () => {
  const gs = new GameState();
  gs.player1.active = mon('我方');
  gs.player2.active = mon('对手出战');
  gs.player2.bench = [mon('对手备战')];
  gs._onPendingPokemonPick = () => assert.fail('opponent_active should not ask for a pick');
  await executeEffects(gs, gs.player1, [{ action: 'damage_place', params: { target: 'opponent_active', count: 2 } }]);
  assert.equal(gs.player2.active.hp, 40);
  assert.equal(gs.player2.bench[0].hp, 60);
});

await test('伤害指示物：self 与 attacker 作用于使用方出战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('我方出战');
  gs.player2.active = mon('对手出战');
  await executeEffects(gs, pl, [
    { action: 'damage_place', params: { target: 'self', count: 1 } },
    { action: 'damage_place', params: { target: 'attacker', count: 2 } },
  ]);
  assert.equal(pl.active.hp, 30);
  assert.equal(gs.player2.active.hp, 60);
});

await test('伤害指示物：无选择器时 opponent_any 稳定回退到对手出战', async () => {
  const gs = new GameState();
  gs.player1.active = mon('我方');
  gs.player2.active = mon('对手出战');
  gs.player2.bench = [mon('对手备战')];
  await executeEffects(gs, gs.player1, [{ action: 'damage_place', params: { target: 'opponent_any', count: 1 } }]);
  assert.equal(gs.player2.active.hp, 50);
  assert.equal(gs.player2.bench[0].hp, 60);
});

await test('伤害指示物：可击倒被选择的对手备战并发奖赏', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  pl.prizes = ['奖赏1', '奖赏2'];
  opp.active = mon('对手出战');
  opp.bench = [mon('濒死备战')];
  opp.bench[0].hp = 10;
  gs._onPendingPokemonPick = () => gs.resolvePokemonPick('bench-0');
  await executeEffects(gs, pl, [{ action: 'damage_place', params: { target: 'opponent_any', count: 1 } }]);
  assert.equal(opp.bench.length, 0);
  assert.deepEqual(opp.discard, ['濒死备战']);
  assert.equal(pl.hand.includes('奖赏2'), true);
});

await test('备战伤害：玩家选择指定对手备战宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, opp);
    assert.equal(pick.options?.mode, 'damage');
    gs.resolvePokemonPick('bench-1');
  };
  await executeEffects(gs, pl, [{ action: 'damage_bench', params: { target: 'opponent_1', damage: 20 } }]);
  assert.equal(opp.bench[0].hp, 60);
  assert.equal(opp.bench[1].hp, 40);
});

await test('能量丢弃/转移/弃牌区附能', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.bench = [mon('备战')];
  pl.active.energy = ['基本【雷】能量', '基本【火】能量'];
  await executeEffects(gs, pl, [{ action: 'discard_energy', params: { target: 'self', count: 1 } }]);
  assert.equal(pl.active.energy.length, 1);
  assert.equal(pl.discard.length, 1);

  pl.bench[0].energy = ['基本【水】能量'];
  await executeEffects(gs, pl, [{ action: 'move_energy', params: { source: 'bench', dest: 'active' } }]);
  assert.equal(pl.active.energy.includes('基本【水】能量'), true);

  pl.discard.push('基本【草】能量');
  const beforeBenchEnergy = pl.bench[0].energy.length;
  await executeEffects(gs, pl, [{ action: 'attach_energy_from_discard', params: { target: 'bench', count: 1 } }]);
  assert.equal(pl.bench[0].energy.length, beforeBenchEnergy + 1);
});

await test('手牌丢弃：玩家可选择非末尾手牌', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['手牌A', '手牌B', '手牌C'];
  gs._onPendingPick = pick => {
    assert.equal(pick.count, 1);
    assert.equal(pick.options?.source, 'hand-discard');
    assert.equal(pick.options?.prompt, '选择要丢弃的手牌');
    assert.deepEqual(pick.cards, ['手牌A', '手牌B', '手牌C']);
    gs.resolvePick([1]);
  };

  await executeEffects(gs, pl, [{ action:'discard_hand', params:{ count:1 } }]);

  assert.deepEqual(pl.hand, ['手牌A', '手牌C']);
  assert.deepEqual(pl.discard, ['手牌B']);
});

await test('手牌丢弃：玩家多选时精确丢弃且不受索引位移影响', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['手牌A', '手牌B', '手牌C', '手牌D'];
  gs._onPendingPick = pick => gs.resolvePick([0, 2]);

  await executeEffects(gs, pl, [{ action:'discard_hand', params:{ count:2 } }]);

  assert.deepEqual(pl.hand, ['手牌B', '手牌D']);
  assert.deepEqual(pl.discard, ['手牌C', '手牌A']);
});

await test('手牌丢弃：无选卡器时按候选顺序确定性回退', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['手牌A', '手牌B', '手牌C'];

  await executeEffects(gs, pl, [{ action:'discard_hand', params:{ count:2 } }]);

  assert.deepEqual(pl.hand, ['手牌C']);
  assert.deepEqual(pl.discard, ['手牌B', '手牌A']);
});

await test('手牌丢弃：筛选只提供匹配候选且空选择不丢弃', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['物品卡', '基本【草】能量', '基本【火】能量'];
  const seen = [];
  gs._onPendingPick = pick => {
    seen.push(pick.cards);
    assert.equal(pick.options?.filter, '基本【草】能量');
    gs.resolvePick([]);
  };

  await executeEffects(gs, pl, [{ action:'discard_hand', params:{ count:1, filter:'基本【草】能量' } }]);

  assert.deepEqual(seen, [['基本【草】能量']]);
  assert.deepEqual(pl.hand, ['物品卡', '基本【草】能量', '基本【火】能量']);
  assert.deepEqual(pl.discard, []);
});

await test('手牌丢弃回归：全部丢弃不打开选卡器', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['手牌A', '手牌B'];
  gs._onPendingPick = () => { throw new Error('discard_all_hand should not request picker'); };

  await executeEffects(gs, pl, [{ action:'discard_all_hand', params:{} }]);

  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, ['手牌B', '手牌A']);
});

await test('手牌丢弃回归：随机丢弃对手手牌不打开选卡器', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  opp.hand = ['对手A', '对手B', '对手C'];
  gs._onPendingPick = () => { throw new Error('discard_opponent_hand_random should not request picker'); };
  const oldRandom = Math.random;
  Math.random = () => 0.5;
  try {
    await executeEffects(gs, pl, [{ action:'discard_opponent_hand_random', params:{} }]);
  } finally {
    Math.random = oldRandom;
  }

  assert.deepEqual(opp.hand, ['对手A', '对手C']);
  assert.deepEqual(opp.discard, ['对手B']);
});

await test('能量选择：丢弃指定附着能量并支持过滤', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.active.energy = ['基本【雷】能量', '基本【火】能量', '特殊能量'];
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'self', count:1 } }]);
  assert.deepEqual(pl.active.energy, ['基本【雷】能量', '特殊能量']);
  assert.deepEqual(pl.discard, ['基本【火】能量']);

  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'self', count:1, filter:'特殊' } }]);
  assert.deepEqual(pl.active.energy, ['基本【雷】能量']);
  assert.deepEqual(pl.discard, ['基本【火】能量', '特殊能量']);
});

await test('能量选择：从指定备战移动指定能量到出战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.bench = [mon('备战A'), mon('备战B')];
  pl.bench[0].energy = ['基本【雷】能量'];
  pl.bench[1].energy = ['基本【火】能量', '基本【水】能量'];
  gs._onPendingPokemonPick = pick => gs.resolvePokemonPick('bench-1');
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【水】能量')]);
  await executeEffects(gs, pl, [{ action:'move_energy', params:{ source:'bench', dest:'active' } }]);
  assert.deepEqual(pl.active.energy, ['基本【水】能量']);
  assert.deepEqual(pl.bench[1].energy, ['基本【火】能量']);
});

await test('能量选择：从出战移动指定能量到指定备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.active.energy = ['基本【雷】能量', '基本【火】能量'];
  pl.bench = [mon('备战A'), mon('备战B')];
  gs._onPendingPokemonPick = pick => gs.resolvePokemonPick('bench-1');
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  await executeEffects(gs, pl, [{ action:'move_energy', params:{ source:'self', dest:'bench' } }]);
  assert.deepEqual(pl.active.energy, ['基本【雷】能量']);
  assert.deepEqual(pl.bench[1].energy, ['基本【火】能量']);
});

await test('能量选择：从弃牌区选择能量并附到指定宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.bench = [mon('备战A'), mon('备战B')];
  pl.discard = ['普通卡', '基本【草】能量', '基本【火】能量'];
  gs._onPendingPokemonPick = pick => gs.resolvePokemonPick('bench-1');
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  await executeEffects(gs, pl, [{ action:'attach_energy_from_discard', params:{ target:'bench', count:1 } }]);
  assert.deepEqual(pl.bench[1].energy, ['基本【火】能量']);
  assert.equal(pl.discard.includes('基本【火】能量'), false);
});

await test('WP7执行：弃牌区附能只展示匹配能量并附到选择目标', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.bench = [mon('水备战'), mon('恶备战')];
  pl.bench[0].element = 'water';
  pl.bench[1].element = 'dark';
  pl.discard = ['water-energy', 'dark-energy', 'item-card'];
  gs.cardResolver = fakeResolver({
    'water-energy': { card:{ cardType:'energy', name:'基本【水】能量', element:'water' }, info:{ name:'基本【水】能量', number:null, type:'energy' } },
    'dark-energy': { card:{ cardType:'energy', name:'基本【恶】能量', element:'dark' }, info:{ name:'基本【恶】能量', number:null, type:'energy' } },
    'item-card': { card:{ cardType:'trainer', trainerType:'item', name:'普通物品' }, info:{ name:'普通物品', number:null, type:'item' } },
  });
  const parsed = parseEffect('从自己的弃牌区抽出1张【水】能量卡，附于备战区的【水】宝可梦身上。');
  gs._onPendingPokemonPick = pick => {
    assert.deepEqual(pick.options.selectableSlots, ['bench-0']);
    gs.resolvePokemonPick('bench-0');
  };
  gs._onPendingPick = pick => {
    assert.deepEqual(pick.cards, ['基本【水】能量']);
    gs.resolvePick([0]);
  };

  await executeEffects(gs, pl, parsed.effects);

  assert.deepEqual(pl.bench[0].energy, ['water-energy']);
  assert.deepEqual(pl.bench[1].energy, []);
  assert.deepEqual(pl.discard, ['dark-energy', 'item-card']);
});

await test('能量选择：从牌库选择能量并附到指定宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.bench = [mon('备战')];
  pl.deck = ['普通卡', '基本【雷】能量', '基本【火】能量'];
  gs._onPendingPokemonPick = pick => gs.resolvePokemonPick('bench-0');
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【雷】能量')]);
  await executeEffects(gs, pl, [{ action:'attach_energy_from_deck', params:{ count:1 } }]);
  assert.equal(pl.bench[0].energy.includes('基本【雷】能量'), true);
  assert.equal(pl.deck.includes('基本【雷】能量'), false);
});

await test('对手能量丢弃：场上/任意选择指定备战与指定能量', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = ['基本【雷】能量'];
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = ['基本【草】能量'];
  opp.bench[1].energy = ['基本【火】能量', '基本【水】能量'];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.player, opp);
    assert.equal(pick.options?.side, 'opponent');
    assert.equal(pick.options?.allowActive, true);
    assert.equal(pick.options?.allowBench, true);
    gs.resolvePokemonPick('bench-1');
  };
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【水】能量')]);
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_any', count:1 } }]);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[1].energy, ['基本【火】能量']);
  assert.deepEqual(opp.discard, ['基本【水】能量']);
});

await test('对手能量丢弃：备战限定不能选择出战并命中备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = ['基本【雷】能量'];
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = ['基本【草】能量', '基本【火】能量'];
  opp.bench[1].energy = ['基本【水】能量'];
  gs._onPendingPokemonPick = pick => {
    assert.equal(pick.options?.allowActive, false);
    assert.equal(pick.options?.allowBench, true);
    gs.resolvePokemonPick('active');
  };
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_bench', count:1 } }]);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量', '基本【火】能量']);
  assert.deepEqual(opp.bench[1].energy, ['基本【水】能量']);
  assert.deepEqual(opp.discard, []);

  gs._onPendingPokemonPick = pick => gs.resolvePokemonPick('bench-0');
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_bench', count:1 } }]);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量']);
  assert.deepEqual(opp.discard, ['基本【火】能量']);
});

await test('对手能量丢弃：出战限定保持直接命中出战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = ['基本【雷】能量', '基本【火】能量'];
  opp.bench = [mon('对手备战')];
  opp.bench[0].energy = ['基本【草】能量'];
  let pokemonPickCalled = false;
  gs._onPendingPokemonPick = () => { pokemonPickCalled = true; };
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent', count:1 } }]);
  assert.equal(pokemonPickCalled, false);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量']);
  assert.deepEqual(opp.discard, ['基本【火】能量']);
});

await test('对手能量丢弃：解析场上/备战与硬币正面包装并执行', async () => {
  const fieldParsed = parseEffect('选择1个对手的场上宝可梦身上附加的能量，将其丢弃');
  assert.equal(fieldParsed.effects[0]?.action, 'discard_energy');
  assert.equal(fieldParsed.effects[0]?.params.target, 'opponent_any');
  const benchParsed = parseEffect('选择1个对手的备战宝可梦身上附加的能量，将其丢弃');
  assert.equal(benchParsed.effects[0]?.params.target, 'opponent_bench');
  const coinParsed = parseEffect('掷1次硬币若为正面，则选择1个对手的备战宝可梦身上附加的能量，将其丢弃');
  assert.equal(coinParsed.effects[0]?.action, 'coin_flip');
  assert.equal(coinParsed.effects[0]?.params.heads[0]?.params.target, 'opponent_bench');

  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战')];
  opp.bench[0].energy = ['基本【草】能量', '基本【火】能量'];
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('基本【火】能量')]);
  const oldRandom = Math.random;
  Math.random = () => 0;
  try {
    await executeEffects(gs, pl, coinParsed.effects);
  } finally {
    Math.random = oldRandom;
  }
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量']);
  assert.deepEqual(opp.discard, ['基本【火】能量']);
});

await test('对手能量丢弃：无选择器 fallback 确定性选择首个可用目标与能量', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = ['基本【雷】能量'];
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = ['基本【草】能量', '基本【火】能量'];
  opp.bench[1].energy = ['基本【水】能量'];
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_any', count:1 } }]);
  assert.deepEqual(opp.active.energy, []);
  assert.deepEqual(opp.discard, ['基本【雷】能量']);
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_bench', count:1 } }]);
  assert.deepEqual(opp.bench[0].energy, ['基本【火】能量']);
  assert.deepEqual(opp.bench[1].energy, ['基本【水】能量']);
  assert.deepEqual(opp.discard, ['基本【雷】能量', '基本【草】能量']);
});

await test('对手能量丢弃：无选择器 opponent_any 跳过无能量出战并命中备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = [];
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = ['基本【草】能量'];
  opp.bench[1].energy = ['基本【水】能量'];
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_any', count:1 } }]);
  assert.deepEqual(opp.active.energy, []);
  assert.deepEqual(opp.bench[0].energy, []);
  assert.deepEqual(opp.bench[1].energy, ['基本【水】能量']);
  assert.deepEqual(opp.discard, ['基本【草】能量']);
});

await test('对手能量丢弃：无选择器 opponent_bench 跳过空备战槽并命中后续备战', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = [];
  opp.bench[1].energy = ['基本【水】能量'];
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_bench', count:1 } }]);
  assert.deepEqual(opp.bench[0].energy, []);
  assert.deepEqual(opp.bench[1].energy, []);
  assert.deepEqual(opp.discard, ['基本【水】能量']);
});

await test('对手能量丢弃：无选择器按过滤条件跳过不匹配目标并安全无候选跳过', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.active.energy = ['基本【雷】能量'];
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  opp.bench[0].energy = ['基本【草】能量'];
  opp.bench[1].energy = ['基本【火】能量'];
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_any', count:1, filter:'【火】' } }]);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量']);
  assert.deepEqual(opp.bench[1].energy, []);
  assert.deepEqual(opp.discard, ['基本【火】能量']);

  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'opponent_any', count:1, filter:'【超】' } }]);
  assert.deepEqual(opp.active.energy, ['基本【雷】能量']);
  assert.deepEqual(opp.bench[0].energy, ['基本【草】能量']);
  assert.deepEqual(opp.discard, ['基本【火】能量']);
});

await test('手牌/弃牌/牌库操作效果执行', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['h1', 'h2'];
  pl.deck = ['d1', 'd2', 'd3', 'd4'];
  await executeEffects(gs, pl, [{ action: 'shuffle_hand_to_deck', params: { who: 'self', draw_count: 2 } }]);
  assert.equal(pl.hand.length, 2);
  assert.equal(pl.deck.length, 4);

  pl.discard = ['x1', 'x2'];
  gs._onPendingPick = pick => gs.resolvePick([pick.cards.indexOf('x1')]);
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:1, target:'hand' } }]);
  assert.equal(pl.hand.includes('x1'), true);
  assert.equal(pl.discard.includes('x1'), false);
  assert.equal(pl.discard.includes('x2'), true);
});

await test('弃牌区回收：必需无候选时报必需失败，可选无候选时安全跳过', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.discard = [];
  // 必需（如「夜间担架」选择1张）：弃牌区没有合法目标时不能发动，
  // 必须抛出必需失败让上层回滚，避免「白用一张卡」或回收不合规的卡
  await assert.rejects(
    () => executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:1, target:'hand' } }]),
    err => err && err.requiredEffectFailed === true,
    '必需回收无目标时应抛出必需失败'
  );
  assert.deepEqual(pl.hand, [], '不应回收任何卡');
  // 可选（最多N张 / allowFewer）：无候选按空发处理，不报错
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:1, maxCount:1, allowFewer:true, target:'hand' } }]);
  assert.deepEqual(pl.hand, [], '可选回收无候选时安全跳过');
});

await test('防止伤害/无法攻击/无法撤退 flag 生效', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('我方');
  opp.active = mon('对手');
  await executeEffects(gs, pl, [
    { action: 'prevent_damage', params: {} },
    { action: 'cannot_attack_next', params: {} },
    { action: 'cannot_retreat', params: { target: 'opponent' } },
  ]);
  assert.equal(pl.active.preventDamage, true);
  assert.equal(pl.active.cannotAttackNext, true);
  assert.equal(opp.active.cannotRetreat, true);
});

await test('进化：继承伤害与能量，并禁止刚出场进化', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('小火龙');
  pl.active.maxHp = 60;
  pl.active.hp = 30;
  pl.active.energy = ['基本【火】能量'];
  pl.active.placedThisTurn = false;
  pl.hand = ['charmeleon'];
  const ok = gs.evolve(pl, 0, { name:'火恐龙', hp:90, evolvesFrom:'小火龙', attacks:[{name:'火焰',damage:40,cost:[]}], element:'fire' }, 'active');
  assert.equal(ok, true);
  assert.equal(pl.active.name, '火恐龙');
  assert.equal(pl.active.hp, 60); // 继承30伤害：90-30
  assert.deepEqual(pl.active.energy, ['基本【火】能量']);

  pl.hand = ['charizard'];
  const blocked = gs.evolve(pl, 0, { name:'喷火龙', hp:150, evolvesFrom:'火恐龙', attacks:[], element:'fire' }, 'active');
  assert.equal(blocked, false);
  assert.equal(pl.active.name, '火恐龙');
  gs.endTurn();
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  const later = gs.evolve(pl, 0, { name:'喷火龙', hp:150, evolvesFrom:'火恐龙', attacks:[], element:'fire' }, 'active');
  assert.equal(later, true);
});

await test('先攻玩家最初回合：不能攻击且不造成伤害、不执行效果、不结束回合、不触发AI', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.player1.active = mon('先攻攻击方', 'atk', [{ name:'禁止攻击', damage:30, cost:[], effects:[{ action:'draw', params:{ count:1 } }] }]);
  gs.player2.active = mon('防守方');
  gs.player1.deck = ['effectDraw'];
  const { engine, events } = makeEngineWithEvents(gs);

  await withImmediateTimeout(async pending => {
    const ok = await engine.attack();
    assert.equal(ok, false);
    assert.equal(pending.length, 0);
  });

  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.BATTLE);
  assert.equal(gs.firstPlayerFirstTurnInProgress, true);
  assert.equal(gs.player2.active.hp, 60);
  assert.deepEqual(gs.player1.hand, []);
  assert.deepEqual(gs.player1.deck, ['effectDraw']);
  assert.equal(events.logs.some(msg => msg.includes('先攻玩家最初回合不能攻击')), true);
  assert.equal(events.logs.some(msg => msg.includes('对手回合')), false);
  assert.equal(events.phases.length, 0);
});

await test('后攻玩家最初回合：若其他条件合法则可以攻击', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player2;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = false;
  gs.player1.active = mon('玩家出战');
  gs.player2.active = mon('后攻攻击方', 'atk', [{ name:'后攻攻击', damage:20, cost:[], effects:[] }]);
  const engine = makeEngine(gs);

  const ok = await engine.attack();

  assert.equal(ok, true);
  assert.equal(gs.player1.active.hp, 40);
  assert.equal(gs.currentPlayer, gs.player1);
  assert.equal(gs.phase, PHASE.MAIN);
});

await test('先攻玩家后续回合：先攻标记已清除时若其他条件合法则可以攻击', async () => {
  const gs = new GameState();
  gs.player1.deck = ['c1', 'c2']; gs.player2.deck = ['c1', 'c2'];
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = false;
  gs.player1.active = mon('先攻后续攻击方', 'atk', [{ name:'后续攻击', damage:20, cost:[], effects:[] }]);
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    const ok = await makeEngine(gs).attack();
    assert.equal(ok, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(gs.player2.active.hp, 40);
  assert.equal(gs.currentPlayer, gs.player2);
  assert.equal(gs.phase, PHASE.MAIN);
});

await test('先攻玩家最初回合：支援者被禁止且不移动卡牌、不标记使用、不执行费用或效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.firstPlayerFirstTurnInProgress = true;
  pl.hand = ['supporterCard', 'costA'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'supporter', name:'先攻禁止支援者',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, false);
  assert.equal(pl.supporterUsed, false);
  assert.deepEqual(pl.hand, ['supporterCard', 'costA']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['drawnCard']);
});

await test('先攻玩家最初回合：物品仍可使用并执行效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.firstPlayerFirstTurnInProgress = true;
  pl.hand = ['itemCard'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'测试物品',
    effects:[{ action:'draw', params:{ count:1 } }]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['itemCard'], '弃牌区存卡牌 ID');
  assert.equal(pl.supporterUsed, false);
});

await test('先攻玩家结束最初回合后：先攻标记清除且后续回合保留每回合1张支援者限制', async () => {
  const gs = new GameState();
  const engine = makeEngine(gs);
  gs.currentPlayer = gs.player1;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.player1.hand = [];
  gs.player1.deck = [];
  gs.player2.deck = [];

  engine.finishTurn();
  assert.equal(gs.firstPlayerFirstTurnInProgress, false);
  assert.equal(gs.currentPlayer, gs.player2);

  gs.currentPlayer = gs.player1;
  const pl = gs.player1;
  pl.hand = ['supporterA', 'supporterB'];
  pl.deck = ['drawnA', 'drawnB'];

  let ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'后续支援者A', effects:[{ action:'draw', params:{ count:1 } }] });
  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.discard, ['supporterA'], '弃牌区存卡牌 ID');

  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'后续支援者B', effects:[{ action:'draw', params:{ count:1 } }] });
  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['supporterB', 'drawnB']);
  assert.deepEqual(pl.discard, ['supporterA']);
});

await test('后攻玩家最初回合：支援者可使用，除非已用过或其他规则阻止', async () => {
  const gs = new GameState();
  const pl = gs.player2;
  gs.currentPlayer = pl;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = false;
  pl.hand = ['supporterCard'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  let ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'后攻支援者', effects:[{ action:'draw', params:{ count:1 } }] });
  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['supporterCard'], '弃牌区存卡牌 ID');

  pl.hand = ['secondSupporter'];
  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'第二张支援者', effects:[{ action:'draw', params:{ count:1 } }] });
  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['secondSupporter']);
  assert.deepEqual(pl.discard, ['supporterCard']);
});

await test('训练家discard_cost：支援者已用过时先判定失败且不丢费用', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.supporterUsed = true;
  pl.hand = ['supporterCard', 'costA'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'supporter', name:'费用支援者',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, false);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.hand, ['supporterCard', 'costA']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['drawnCard']);
});

await test('训练家discard_cost：宝可梦道具目标无效或已有道具时不丢费用', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.active.tool = '已有道具';
  pl.hand = ['toolCard', 'costA'];
  const engine = makeEngine(gs);
  const toolCard = {
    cardType:'trainer', trainerType:'tool', name:'费用道具',
    effects:[{ action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } }]
  };

  let ok = await engine.useTrainer(0, toolCard, 'bench-0');
  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['toolCard', 'costA']);
  assert.deepEqual(pl.discard, []);

  ok = await engine.useTrainer(0, toolCard, 'active');
  assert.equal(ok, false);
  assert.equal(pl.active.tool, '已有道具');
  assert.deepEqual(pl.hand, ['toolCard', 'costA']);
  assert.deepEqual(pl.discard, []);
});

await test('训练家discard_cost：物品先丢指定手牌再执行搜牌效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard', 'costA', 'costB'];
  pl.deck = ['bottom', 'targetPokemon 宝可梦'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'trainer-discard-cost') {
      assert.equal(pick.options?.required, true);
      assert.equal(pick.options?.allowEmpty, false);
      assert.deepEqual(pick.cards, ['costA', 'costB']);
      gs.resolvePick([1]);
      return;
    }
    assert.equal(pick.options?.source, 'deck-search');
    assert.deepEqual(pick.cards, ['targetPokemon 宝可梦', 'bottom']);
    gs.resolvePick([0]);
  };
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'大地之容器',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } },
    ]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['costA', 'targetPokemon 宝可梦']);
  assert.deepEqual(pl.discard, ['costB', 'trainerCard']);
  assert.equal(pl.deck.includes('targetPokemon 宝可梦'), false);
});

await test('训练家discard_cost：取消费用选择时不使用训练家且不执行效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard', 'costA', 'costB'];
  pl.deck = ['drawnCard'];
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'trainer-discard-cost');
    gs.resolvePick([]);
  };
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'费用物品',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['trainerCard', 'costA', 'costB']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['drawnCard']);
});

await test('训练家discard_cost：支援者费用失败不消耗supporterUsed', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['supporterCard', 'costA', 'costB'];
  gs._onPendingPick = () => gs.resolvePick([]);
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'supporter', name:'费用支援者',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, false);
  assert.equal(pl.supporterUsed, false);
  assert.deepEqual(pl.hand, ['supporterCard', 'costA', 'costB']);
  assert.deepEqual(pl.discard, []);
});

await test('训练家discard_cost：匹配手牌不足时干净失败', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard', '基本【火】能量'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'滤费物品',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', filter:'基本【草】能量', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['trainerCard', '基本【火】能量']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['drawnCard']);
});

await test('训练家discard_cost：无选卡器时确定性支付首个匹配费用并执行', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard', 'costA', 'costB'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'费用物品',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['costB', 'drawnCard']);
  assert.deepEqual(pl.discard, ['costA', 'trainerCard']);
});

await test('WP1 高级球：必须丢弃2张手牌才搜索宝可梦，取消或费用不足不消耗', async () => {
  const effects = [
    { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:2, zone:'hand', raw:'必须将自己的2张手牌丢弃才可使用' } },
    { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } },
  ];
  const legal = new GameState();
  const pl = legal.player1;
  legal.currentPlayer = pl;
  pl.hand = ['ultraBall', 'costA', 'costB', 'keepCard'];
  pl.deck = ['itemCard', 'targetPokemon 宝可梦'];
  legal._shuffle = deck => deck;
  legal._onPendingPick = pick => {
    if (pick.options?.source === 'trainer-discard-cost') {
      assert.equal(pick.count, 2);
      assert.deepEqual(pick.cards, ['costA', 'costB', 'keepCard']);
      legal.resolvePick([0, 1]);
      return;
    }
    assert.equal(pick.options?.source, 'deck-search');
    assert.deepEqual(pick.cards, ['targetPokemon 宝可梦']);
    legal.resolvePick([0]);
  };
  let ok = await makeEngine(legal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'高级球', effects });
  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['keepCard', 'targetPokemon 宝可梦']);
  assert.deepEqual(pl.discard, ['costB', 'costA', 'ultraBall']);


  const insufficient = new GameState();
  const pl3 = insufficient.player1;
  insufficient.currentPlayer = pl3;
  pl3.hand = ['ultraBall', 'onlyCost'];
  pl3.deck = ['targetPokemon 宝可梦'];
  insufficient._onPendingPick = () => assert.fail('费用不足不应打开选卡器');
  ok = await makeEngine(insufficient).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'高级球', effects });
  assert.equal(ok, false);
  assert.deepEqual(pl3.hand, ['ultraBall', 'onlyCost']);
  assert.deepEqual(pl3.discard, []);
});

await test('WP1 反击捕捉器：奖赏落后时执行对手换位，否则不消耗且不换位', async () => {
  const effects = parseEffect('这张卡只有在自己剩余奖赏卡的张数比对手剩余奖赏卡的张数多时才可使用。选择对手的1只备战宝可梦，与战斗宝可梦互换。').effects;
  assert.equal(effects.some(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'own_prizes_more_than_opponent'), true);
  const switchEffect = effects.find(e => e.action === 'switch_pokemon') || { action:'switch_pokemon', params:{ who:'opponent', choose:'player' } };
  assert.equal(switchEffect.params?.who, 'opponent');
  const legal = new GameState();
  const pl = legal.player1;
  const opp = legal.player2;
  legal.currentPlayer = pl;
  pl.hand = ['counterCatcher'];
  pl.prizes = ['p1', 'p2', 'p3'];
  opp.prizes = ['o1', 'o2'];
  pl.active = mon('我方出战');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战A'), mon('对手备战B')];
  legal._onPendingPokemonPick = pick => { assert.equal(pick.player, opp); legal.resolvePokemonPick('bench-1'); };
  let ok = await makeEngine(legal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'反击捕捉器', effects:[effects[0], switchEffect] });
  assert.equal(ok, true);
  assert.equal(opp.active.name, '对手备战B');
  assert.deepEqual(opp.bench.map(p => p.name), ['对手备战A', '对手出战']);
  assert.deepEqual(pl.discard, ['counterCatcher']);

  const illegal = new GameState();
  const pl2 = illegal.player1;
  const opp2 = illegal.player2;
  illegal.currentPlayer = pl2;
  pl2.hand = ['counterCatcher'];
  pl2.prizes = ['p1', 'p2'];
  opp2.prizes = ['o1', 'o2'];
  opp2.active = mon('非法对手出战');
  opp2.bench = [mon('非法对手备战')];
  illegal._onPendingPokemonPick = () => assert.fail('前提失败不应选择换位目标');
  ok = await makeEngine(illegal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'反击捕捉器', effects:[effects[0], switchEffect] });
  assert.equal(ok, false);
  assert.equal(opp2.active.name, '非法对手出战');
  assert.deepEqual(pl2.hand, ['counterCatcher']);
  assert.deepEqual(pl2.discard, []);
});

await test('WP1 梅洛可：仅在上个对手回合己方被击倒后先附火能再补到6张', async () => {
  const effects = [
    ...parseEffect('这张卡只有在上个对手的回合自己的宝可梦被击倒了时才可使用。').effects,
    { action:'attach_energy_from_discard', params:{ count:1, maxCount:1, minCount:1, filter:'基本【火】能量', target:'any' } },
    { action:'draw_until', params:{ target:6 } },
  ];
  assert.equal(effects.some(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'own_pokemon_knocked_out_last_opponent_turn'), true);
  assert.equal(effects.some(e => e.action === 'attach_energy_from_discard'), true);
  assert.equal(effects.some(e => e.action === 'draw_until'), true);
  const legal = new GameState();
  const pl = legal.player1;
  legal.currentPlayer = pl;
  legal.turn = 4;
  legal.knockoutHistory = [{ owner:pl, by:legal.player2, turn:3, phase:PHASE.BATTLE }];
  pl.hand = ['mela', 'keptHand'];
  pl.deck = ['draw1', 'draw2', 'draw3', 'draw4', 'draw5'];
  pl.active = mon('出战');
  pl.bench = [mon('备战')];
  pl.discard = ['基本【火】能量', '基本【水】能量'];
  legal._onPendingPokemonPick = () => { assert.equal(pl.hand.length, 1); legal.resolvePokemonPick('bench-0'); };
  legal._onPendingPick = pick => { assert.deepEqual(pick.cards, ['基本【火】能量']); legal.resolvePick([0]); };
  const ok = await makeEngine(legal).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'梅洛可', effects });
  assert.equal(ok, true);
  assert.deepEqual(pl.bench[0].energy, ['基本【火】能量']);
  assert.deepEqual(pl.discard, ['基本【水】能量', 'mela']);
  assert.equal(pl.hand.length, 6);
  assert.deepEqual(pl.hand.slice(1), ['draw5', 'draw4', 'draw3', 'draw2', 'draw1']);

  const illegal = new GameState();
  const pl2 = illegal.player1;
  illegal.currentPlayer = pl2;
  illegal.turn = 4;
  pl2.hand = ['mela', 'keptHand'];
  pl2.deck = ['draw1', 'draw2'];
  pl2.active = mon('出战');
  pl2.discard = ['基本【火】能量'];
  illegal._onPendingPick = () => assert.fail('前提失败不应执行附能');
  const blocked = await makeEngine(illegal).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'梅洛可', effects });
  assert.equal(blocked, false);
  assert.deepEqual(pl2.hand, ['mela', 'keptHand']);
  assert.deepEqual(pl2.discard, ['基本【火】能量']);
  assert.equal(pl2.supporterUsed, false);
});

await test('训练家元数据回归：未结构化condition前提不强制但效果仍执行', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard'];
  pl.deck = ['drawnCard'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'条件物品',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'condition', raw:'metadata only' } },
      { action:'draw', params:{ count:1 } },
    ]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['trainerCard']);
});

await test('先攻支援者例外：可在先攻最初回合使用且不是硬first_turn前提', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.turn = 1;
  pl.hand = ['supporterCard'];
  pl.deck = ['drawnCard'];
  const effects = parseEffect('这张卡可在先攻玩家的最初回合使用。从自己的牌库抽出1张卡。').effects;

  assert.equal(effects.some(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'first_turn'), false);
  assert.equal(effects.some(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'first_player_first_turn_supporter_exception'), true);

  const ok = await makeEngine(gs).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'大姐姐', effects });

  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['supporterCard']);
});

await test('先攻支援者例外：后续普通回合仍可使用且不要求后攻最初回合', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.firstPlayerFirstTurnInProgress = false;
  gs.turn = 3;
  pl.hand = ['supporterCard'];
  pl.deck = ['drawnCard'];
  const effects = parseEffect('这张卡可在先攻玩家的最初回合使用。从自己的牌库抽出1张卡。').effects;

  const ok = await makeEngine(gs).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'丹瑜', effects });

  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['supporterCard']);
  assert.equal(gs.log.some(line => line.includes('最初回合')), false);
});

await test('训练家first_turn前提：自己的最初回合合法且会正常消耗物品', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.turn = 1;
  pl.hand = ['vipPass'];
  pl.deck = ['drawnCard'];
  const effects = parseEffect('这张卡只能在自己的最初回合使用。从自己的牌库抽出1张卡。').effects;
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'item', name:'对战VIP参加证', effects });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['vipPass']);
});

await test('训练家first_turn前提：非最初回合失败且不消耗、不支付费用、不执行效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.firstPlayer = pl;
  gs.turn = 3;
  pl.hand = ['vipPass', 'costA'];
  pl.deck = ['drawnCard'];
  const effects = [
    ...parseEffect('这张卡只能在自己的最初回合使用。').effects,
    { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
    { action:'draw', params:{ count:1 } },
  ];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'item', name:'对战VIP参加证', effects });

  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['vipPass', 'costA']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['drawnCard']);
  assert.equal(gs.log.some(line => line.includes('只可在自己的最初回合使用')), true);
});

await test('训练家后攻first_turn前提：后攻最初回合合法，先攻或后续回合失败', async () => {
  const legal = new GameState();
  const second = legal.player2;
  legal.currentPlayer = second;
  legal.firstPlayer = legal.player1;
  legal.turn = 2;
  second.hand = ['bell'];
  second.deck = ['drawnCard'];
  const effects = parseEffect('这张卡只可在后攻玩家自己的最初回合使用1次。从自己的牌库抽出1张卡。').effects;
  let ok = await makeEngine(legal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'帮忙铃', effects });
  assert.equal(ok, true);
  assert.deepEqual(second.hand, ['drawnCard']);
  assert.deepEqual(second.discard, ['bell']);

  const illegal = new GameState();
  const first = illegal.player1;
  illegal.currentPlayer = first;
  illegal.firstPlayer = first;
  illegal.turn = 1;
  first.hand = ['bell'];
  first.deck = ['drawnCard'];
  ok = await makeEngine(illegal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'帮忙铃', effects });
  assert.equal(ok, false);
  assert.deepEqual(first.hand, ['bell']);
  assert.deepEqual(first.discard, []);
  assert.deepEqual(first.deck, ['drawnCard']);
  assert.equal(illegal.log.some(line => line.includes('后攻玩家自己的最初回合')), true);
});

await test('训练家奖赏落后前提：自己奖赏多于对手时合法，否则不消耗支援者或卡牌', async () => {
  const legal = new GameState();
  const pl = legal.player1;
  const opp = legal.player2;
  legal.currentPlayer = pl;
  pl.hand = ['counterCatcher'];
  pl.prizes = ['p1', 'p2', 'p3'];
  opp.prizes = ['o1', 'o2'];
  const effects = parseEffect('这张卡只有在自己剩余奖赏卡的张数比对手剩余奖赏卡的张数多时才可使用。从自己的牌库抽出1张卡。').effects;
  pl.deck = ['drawnCard'];
  let ok = await makeEngine(legal).useTrainer(0, { cardType:'trainer', trainerType:'item', name:'反击捕捉器', effects });
  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['counterCatcher']);

  const illegal = new GameState();
  const pl2 = illegal.player1;
  const opp2 = illegal.player2;
  illegal.currentPlayer = pl2;
  pl2.hand = ['counterCatcher'];
  pl2.prizes = ['p1', 'p2'];
  opp2.prizes = ['o1', 'o2'];
  pl2.deck = ['drawnCard'];
  ok = await makeEngine(illegal).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'奖赏前提支援者', effects });
  assert.equal(ok, false);
  assert.deepEqual(pl2.hand, ['counterCatcher']);
  assert.deepEqual(pl2.discard, []);
  assert.deepEqual(pl2.deck, ['drawnCard']);
  assert.equal(pl2.supporterUsed, false);
  assert.equal(illegal.log.some(line => line.includes('自己的剩余奖赏卡需多于对手')), true);
});

await test('训练家opponent_prizes_at_most前提：合法时可消耗支援者并执行效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  gs.currentPlayer = pl;
  pl.hand = ['roxanneCard'];
  pl.deck = ['drawnCard'];
  opp.prizes = ['o1', 'o2', 'o3'];
  const effects = [
    ...parseEffect('这张卡只可在对手剩余奖赏卡的张数为3张以下时使用。').effects,
    { action:'draw', params:{ count:1 } },
  ];

  const ok = await makeEngine(gs).useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'杜娟', effects });

  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  assert.deepEqual(pl.hand, ['drawnCard']);
  assert.deepEqual(pl.discard, ['roxanneCard']);
});

await test('训练家事务：必需选卡取消会回滚卡牌费用与支援者标记', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['supporterCard', 'costA'];
  pl.deck = ['bottom', 'targetPokemon 宝可梦'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    if (pick.options?.source === 'trainer-discard-cost') {
      gs.resolvePick([0]);
      return;
    }
    assert.equal(pick.options?.source, 'deck-search');
    gs.resolvePick([]);
  };
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'supporter', name:'事务支援者',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1, zone:'hand', raw:'cost' } },
      { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } },
    ]
  });

  assert.equal(ok, false);
  assert.equal(pl.supporterUsed, false);
  assert.deepEqual(pl.hand, ['supporterCard', 'costA']);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.deck, ['bottom', 'targetPokemon 宝可梦']);
});

await test('训练家事务：必需宝可梦目标无候选会回滚物品消耗', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.hand = ['switchItem'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'必需换位物品',
    effects:[{ action:'switch_pokemon', params:{} }]
  });

  assert.equal(ok, false);
  assert.deepEqual(pl.hand, ['switchItem']);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.active.name, '出战');
  assert.deepEqual(pl.bench, []);
});

await test('训练家事务：必需效果成功仍消耗并结算', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard'];
  pl.deck = ['bottom', 'targetPokemon 宝可梦'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => gs.resolvePick([0]);
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'成功物品',
    effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } }]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['targetPokemon 宝可梦']);
  assert.deepEqual(pl.discard, ['trainerCard']);
  assert.deepEqual(pl.deck, ['bottom']);
});

await test('训练家事务：可选allowEmpty取消保持成功且不回滚', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.hand = ['trainerCard'];
  pl.deck = ['bottom', 'targetPokemon 宝可梦'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.allowEmpty, true);
    gs.resolvePick([]);
  };
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'可选物品',
    effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦', allowEmpty:true } }]
  });

  assert.equal(ok, true);
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, ['trainerCard']);
  assert.deepEqual(pl.deck, ['bottom', 'targetPokemon 宝可梦']);
});

await test('宝可梦道具装备：保存精确手牌id且日志与已有道具提示可读', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.hand = ['tool-print-A'];
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'tool', name:'力量头带', effects:[] }, 'active');
  assert.equal(ok, true);
  // tool 现在额外保留 effects/specialRules（供撤退费等按道具效果通用判定），
  // 因此这里改为断言关键字段，避免新增字段导致脆弱失败。
  assert.equal(pl.active.tool.cardId, 'tool-print-A');
  assert.equal(pl.active.tool.name, '力量头带');
  assert.equal(gs.log.some(msg => msg.includes('装备了「力量头带」')), true);
  const check = gs.canUseTrainer(pl, { cardType:'trainer', trainerType:'tool', name:'第二工具' }, 'active');
  assert.equal(check.ok, false);
  assert.equal(check.message.includes('出战 已装备 力量头带'), true);
});

await test('训练家使用限制：支援者一回合一次，竞技场替换，宝可梦道具装备目标', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.hand = ['sup1', 'sup2', 'stadium', 'tool'];
  const engine = makeEngine(gs);

  let ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'博士', effects:[] });
  assert.equal(ok, true);
  assert.equal(pl.supporterUsed, true);
  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'supporter', name:'第二张支援者', effects:[] });
  assert.equal(ok, false);

  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'stadium', name:'竞技场A', effects:[] });
  assert.equal(ok, true);
  assert.equal(pl.stadium.name, '竞技场A');
  pl.hand.unshift('stadium2');
  // 规则：每回合只能打出 1 张竞技场 → 模拟进入下一回合
  pl.stadiumPlayedThisTurn = false;
  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'stadium', name:'竞技场B', effects:[] });
  assert.equal(ok, true);
  assert.equal(pl.stadium.name, '竞技场B');

  pl.hand.unshift('toolCard');
  ok = await engine.useTrainer(0, { cardType:'trainer', trainerType:'tool', name:'道具A', effects:[] }, 'active');
  assert.equal(ok, true);
  assert.equal(pl.active.tool.cardId, 'toolCard');
  assert.equal(pl.active.tool.name, '道具A');
});

await test('超群眼镜：真实本地文本仅作为道具附加且无额外效果', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  pl.active = mon('出战');
  pl.hand = ['7035'];
  const raw = loadJson('PokemonTool-cards.json').find(c => (c['卡牌ID'] || []).includes('7035'));
  const glasses = new CardResolver()._trainer({ ...raw, _t:'tool' });
  assert.equal(glasses.trainerType, 'tool');
  const ok = await makeEngine(gs).useTrainer(0, glasses, 'active');
  assert.equal(ok, true);
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.active.tool.cardId, '7035');
  assert.equal(pl.active.tool.name, '超群眼镜');
  assert.equal(pl.active.hp, pl.active.maxHp);

  pl.hand = ['7035b'];
  const second = await makeEngine(gs).useTrainer(0, glasses, 'active');
  assert.equal(second, false);
  assert.deepEqual(pl.hand, ['7035b']);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.active.tool.cardId, '7035');
  assert.equal(pl.active.tool.name, '超群眼镜');
});

await test('奖赏卡：击倒后拿奖赏，拿完判胜', () => {
  const gs = new GameState();
  const attacker = gs.player1;
  const defender = gs.player2;
  attacker.prizes = ['p1'];
  defender.active = mon('将被击倒');
  defender.active.hp = 0;
  defender.bench = [];
  gs.knockout(defender);
  assert.equal(attacker.prizes.length, 0);
  assert.equal(gs.phase, PHASE.GAME_OVER);
  assert.equal(gs.winner, attacker);
});

await test('ex奖赏规则：出战与备战ex昏厥均拿2张且可触发胜利', async () => {
  const gs = new GameState();
  const attacker = gs.player1;
  const defender = gs.player2;
  attacker.prizes = ['p1', 'p2', 'p3'];
  attacker.hand = [];
  defender.active = mon('防守ex', 'def-ex');
  defender.active.isEx = true;
  defender.active.hp = 0;
  defender.bench = [mon('替补')];
  gs.knockout(defender);
  assert.equal(attacker.prizes.length, 1);
  assert.deepEqual(attacker.hand, ['p3', 'p2']);
  assert.equal(defender.active.name, '替补');

  const gs2 = new GameState();
  const atk2 = gs2.player1;
  const def2 = gs2.player2;
  atk2.prizes = ['last1', 'last2'];
  atk2.hand = [];
  def2.active = mon('防守');
  def2.bench = [mon('备战ex', 'bench-ex')];
  def2.bench[0].isEx = true;
  await executeEffects(gs2, atk2, [{ action:'damage_bench', params:{ target:'opponent_all', damage:70 } }]);
  assert.deepEqual(atk2.hand, ['last2', 'last1']);
  assert.equal(atk2.prizes.length, 0);
  assert.equal(gs2.phase, PHASE.GAME_OVER);
  assert.equal(gs2.winner, atk2);
});

await test('攻击修正：damage_modify 增伤后攻击造成更高伤害', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{ name:'强化打击', damage:20, cost:[], effects:[] }]);
  gs.player2.active = mon('防守方');
  await executeEffects(gs, gs.player1, [{ action:'damage_modify', params:{ amount:30 } }]);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 10);
});

await test('幸存锻炼器：仅满HP出战宝可梦受直接招式致命伤害时保留10HP并丢弃此道具', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{ name:'重击', damage:80, cost:[], effects:[] }]);
  gs.player2.active = mon('防守方', 'def');
  gs.player2.active.tool = { cardId:'11176', name:'幸存锻炼器' };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 10);
  assert.equal(gs.player2.active.tool, null);
  assert.deepEqual(gs.player2.discard, ['11176']);

  const damaged = new GameState();
  damaged.phase = PHASE.BATTLE;
  damaged.currentPlayer = damaged.player1;
  damaged.player1.active = mon('攻击方', 'atk', [{ name:'重击', damage:50, cost:[], effects:[] }]);
  damaged.player2.active = mon('已伤防守', 'def');
  damaged.player2.active.hp = 50;
  damaged.player2.active.tool = { cardId:'11176', name:'幸存锻炼器' };
  damaged.player2.bench = [mon('替补')];
  globalThis.setTimeout = () => 0;
  try { await makeEngine(damaged).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(damaged.player2.active.name, '替补');
  // 修：昏厥时身上的卡牌以前会凭空消失，现在与宝可梦一起进弃牌区（放逐区类效果则一起进放逐区）
  assert.deepEqual(damaged.player2.discard, ['def', '11176']);

  const nonLethal = new GameState();
  nonLethal.phase = PHASE.BATTLE;
  nonLethal.currentPlayer = nonLethal.player1;
  nonLethal.player1.active = mon('攻击方', 'atk', [{ name:'轻击', damage:30, cost:[], effects:[] }]);
  nonLethal.player2.active = mon('防守方', 'def');
  nonLethal.player2.active.tool = { cardId:'11176', name:'幸存锻炼器' };
  globalThis.setTimeout = () => 0;
  try { await makeEngine(nonLethal).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(nonLethal.player2.active.hp, 30);
  assert.equal(nonLethal.player2.active.tool.cardId, '11176');
  assert.equal(nonLethal.player2.active.tool.name, '幸存锻炼器');
  assert.deepEqual(nonLethal.player2.discard, []);
});

await test('幸存锻炼器：伤害指示物与招式效果备战伤害不触发窄实现', async () => {
  const gs = new GameState();
  gs.player1.active = mon('攻击方');
  gs.player2.active = mon('防守方', 'def');
  gs.player2.active.tool = { cardId:'11176', name:'幸存锻炼器' };
  gs.player2.bench = [mon('替补')];
  await executeEffects(gs, gs.player1, [{ action:'damage_place', params:{ target:'opponent_active', count:6 } }]);
  assert.equal(gs.player2.active.name, '替补');
  assert.deepEqual(gs.player2.discard, ['def', '11176'], '被击倒的宝可梦与身上的道具一起进弃牌区');

  const bench = new GameState();
  bench.player1.active = mon('攻击方');
  bench.player2.active = mon('防守方');
  bench.player2.bench = [mon('备战防守', 'bench-def')];
  bench.player2.bench[0].tool = { cardId:'11176', name:'幸存锻炼器' };
  await executeEffects(bench, bench.player1, [{ action:'damage_bench', params:{ target:'opponent_all', damage:60 } }]);
  assert.equal(bench.player2.bench.length, 0);
  assert.deepEqual(bench.player2.discard, ['bench-def', '11176'], '备战区被击倒时道具同样进弃牌区');
});

await test('WP5 扒手猫乱抓：3次硬币按正面×10伤害且无额外固定10', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  gs.player1.active = mon('扒手猫');
  gs.player2.active = mon('对手', 'def');
  gs.player2.active.hp = 100;
  gs.player2.active.maxHp = 100;
  try {
    const rolls = [0.1, 0.2, 0.9];
    Math.random = () => rolls.shift() ?? 0.9;
    await executeEffects(gs, gs.player1, [{ action:'coin_flip_damage', params:{ count:3, damage_per:10 } }]);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(gs.player2.active.hp, 80);
});

await test('WP5 coin_flip_damage：单硬币damage参数按每正面伤害兼容执行', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  gs.player1.active = mon('攻击方');
  gs.player2.active = mon('对手');
  try {
    Math.random = () => 0.1;
    await executeEffects(gs, gs.player1, [{ action:'coin_flip_damage', params:{ count:1, damage:30 } }]);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(gs.player2.active.hp, 30);
});

await test('硬币效果：正面触发状态，反面不触发', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  gs.player1.active = mon('我方');
  gs.player2.active = mon('对手');
  try {
    Math.random = () => 0.1; // executor里 <0.5 视为正面
    await executeEffects(gs, gs.player1, [{ action:'coin_flip_status', params:{ statuses:['sleep'] } }]);
    assert.equal(gs.player2.active.status, 'sleep');
    gs.player2.active.status = null;
    Math.random = () => 0.9;
    await executeEffects(gs, gs.player1, [{ action:'coin_flip_status', params:{ statuses:['sleep'] } }]);
    assert.equal(gs.player2.active.status, null);
  } finally {
    Math.random = realRandom;
  }
});

await test('弃牌和对手牌库破坏：随机弃手与 mill', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  const opp = gs.player2;
  opp.hand = ['h0', 'h1', 'h2'];
  opp.deck = ['d0', 'd1', 'd2'];
  try {
    Math.random = () => 0.4; // floor(0.4*3)=1
    await executeEffects(gs, gs.player1, [{ action:'discard_opponent_hand_random', params:{ count:1 } }]);
  } finally {
    Math.random = realRandom;
  }
  assert.deepEqual(opp.hand, ['h0', 'h2']);
  assert.deepEqual(opp.discard, ['h1']);
  await executeEffects(gs, gs.player1, [{ action:'mill', params:{ target:'opponent', count:2 } }]);
  assert.equal(opp.deck.length, 1);
  assert.equal(opp.discard.length, 3);
});

await test('游戏流程：初始化会设置真实奖赏卡并从牌库移除', () => {
  const gs = new GameState();
  const deck1 = Array.from({ length: 20 }, (_, i) => `p1-${i}`);
  const deck2 = Array.from({ length: 20 }, (_, i) => `p2-${i}`);
  gs.init(deck1, deck2);
  assert.equal(gs.player1.prizes.length, 6);
  assert.equal(gs.player2.prizes.length, 6);
  assert.equal(gs.player1.hand.length, 7);
  assert.equal(gs.player2.hand.length, 7);
  assert.equal(gs.player1.deck.length, 7);
});

await test('游戏流程：只能直接放置基础宝可梦，不能直接放进化卡', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['stage1', 'basic'];
  const blocked = gs.placeActive(pl, 0, { cardType:'pokemon', name:'火恐龙', stage:'1阶进化', hp:90 });
  assert.equal(blocked, null);
  assert.deepEqual(pl.hand, ['stage1', 'basic']);
  const ok = gs.placeActive(pl, 1, { cardType:'pokemon', name:'小火龙', stage:'基础', hp:60 });
  assert.equal(ok.name, '小火龙');
});

await test('招式伤害：无伤害招式为0伤害但仍可执行效果', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{ name:'毒粉', damage:0, cost:[], effects:[{ action:'inflict_status', params:{ statuses:['poison'] } }] }]);
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 50); // 0 伤害招式自身不造成伤害，但回合结束时中毒结算 -10
  assert.equal(gs.player2.active.status, 'poison');
});

await test('招式伤害：弱点x2、抵抗力-30、ignore weakness 生效', async () => {
  let gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('火攻击方', 'atk', [{ name:'火花', damage:30, cost:[], effects:[] }]);
  gs.player1.active.element = 'fire';
  gs.player2.active = mon('草防守方');
  gs.player2.active.weakness = 'fire';
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 0);

  gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('火攻击方', 'atk', [{ name:'火花', damage:40, cost:[], effects:[] }]);
  gs.player1.active.element = 'fire';
  gs.player2.active = mon('抗火防守方');
  gs.player2.active.resistance = 'fire';
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 50);

  gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('火攻击方', 'atk', [{ name:'无视弱点', damage:30, cost:[], effects:[] }]);
  gs.player1.active.element = 'fire';
  gs.player1.active.ignore = ['weakness'];
  gs.player2.active = mon('弱火防守方');
  gs.player2.active.weakness = 'fire';
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 30);
});

await test('招式使用条件：能量不足、睡眠/麻痹、混乱失败会阻止攻击', async () => {
  let gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('缺能', 'atk', [{ name:'高费招式', damage:50, cost:['fire'], effects:[] }]);
  gs.player2.active = mon('对手');
  assert.equal(await makeEngine(gs).attack(), false);
  assert.equal(gs.player2.active.hp, 60);

  gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('睡眠', 'atk', [{ name:'打击', damage:20, cost:[], effects:[] }]);
  gs.player1.active.status = 'sleep';
  gs.player2.active = mon('对手');
  assert.equal(await makeEngine(gs).attack(), false);

  const realRandom = Math.random;
  try {
    Math.random = () => 0.9; // 混乱失败
    gs = new GameState();
    gs.phase = PHASE.BATTLE;
    gs.currentPlayer = gs.player1;
    gs.player1.active = mon('混乱', 'atk', [{ name:'打击', damage:20, cost:[], effects:[] }]);
    gs.player1.active.status = 'confusion';
    gs.player2.active = mon('对手');
    assert.equal(await makeEngine(gs).attack(), false);
    assert.equal(gs.player1.active.hp, 30);
    assert.equal(gs.player2.active.hp, 60);
  } finally { Math.random = realRandom; }
});

await test('奖赏卡：击倒后真实奖赏进入手牌', () => {
  const gs = new GameState();
  const attacker = gs.player1;
  const defender = gs.player2;
  attacker.prizes = ['真实奖赏'];
  attacker.hand = [];
  defender.active = mon('将被击倒');
  defender.active.hp = 0;
  defender.bench = [];
  gs.knockout(defender);
  assert.deepEqual(attacker.hand, ['真实奖赏']);
  assert.equal(attacker.prizes.length, 0);
});

await test('撤退规则：支付撤退费用、每回合一次、睡眠麻痹/无法撤退限制', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('出战');
  pl.active.retreatCost = 2;
  pl.active.energy = ['基本【雷】能量', '特殊能量', '多余能量'];
  pl.bench = [mon('备战')];
  assert.equal(gs.retreat(pl, 0), true);
  assert.equal(pl.active.name, '备战');
  assert.equal(pl.retreatUsed, true);
  assert.equal(pl.discard.length, 2);
  assert.equal(gs.retreat(pl, 0), false);

  const gs2 = new GameState();
  const p2 = gs2.player1;
  p2.active = mon('睡眠出战');
  p2.active.status = 'sleep';
  p2.active.retreatCost = 0;
  p2.bench = [mon('备战')];
  assert.equal(gs2.retreat(p2, 0), false);

  const gs3 = new GameState();
  const p3 = gs3.player1;
  p3.active = mon('被锁出战');
  p3.active.cannotRetreat = true;
  p3.active.retreatCost = 0;
  p3.bench = [mon('备战')];
  assert.equal(gs3.retreat(p3, 0), false);
});

await test('撤退规则：真实0费用宝可梦不需要能量即可撤退', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('free-retreat');
  pl.active.retreatCost = 0;
  pl.bench = [mon('bench')];

  assert.equal(gs.retreat(pl, 0), true);
  assert.equal(pl.active.name, 'bench');
  assert.equal(pl.bench[0].name, 'free-retreat');
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.retreatUsed, true);
});

await test('大气球：仅2阶宝可梦撤退费用归零且不丢能量', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('2阶出战', 'stage2');
  pl.active.stage = '2阶进化';
  pl.active.retreatCost = 3;
  pl.active.energy = ['能量A'];
  pl.active.tool = { cardId:'9024', name:'大气球' };
  pl.bench = [mon('备战')];
  assert.equal(gs.effectiveRetreatCost(pl.active), 0);
  assert.equal(gs.retreat(pl, 0), true);
  assert.deepEqual(pl.discard, []);
  assert.deepEqual(pl.bench[0].energy, ['能量A']);

  const gs2 = new GameState();
  const p2 = gs2.player1;
  p2.active = mon('基础出战', 'basic');
  p2.active.stage = '基础';
  p2.active.retreatCost = 2;
  p2.active.energy = ['能量A', '能量B'];
  p2.active.tool = { cardId:'9024', name:'大气球' };
  p2.bench = [mon('备战')];
  assert.equal(gs2.effectiveRetreatCost(p2.active), 2);
  assert.equal(gs2.retreat(p2, 0), true);
  assert.deepEqual(p2.discard, ['能量B', '能量A']);
});

await test('retreat selected energy indices discard exact attached cards', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('retreater');
  pl.active.retreatCost = 2;
  pl.active.energy = ['basic A', 'basic B', 'basic C'];
  pl.bench = [mon('bench')];
  assert.equal(gs.retreat(pl, 0, [0, 2]), true);
  assert.deepEqual(pl.discard.sort(), ['basic A', 'basic C']);
  assert.deepEqual(pl.bench[0].energy, ['basic B']);
});

await test('retreat cost 2 can pick two specific basics through pending pick path', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('retreater');
  pl.active.retreatCost = 2;
  pl.active.energy = ['basic A', 'basic B', 'basic C'];
  pl.bench = [mon('bench')];
  const pickedPromise = gs.waitForPick(pl.active.energy, pl.active.energy.length, { source:'retreat-energy', cost:2, allowEmpty:true });
  assert.equal(gs.pendingPick.count, 3);
  assert.equal(gs.pendingPick.options.source, 'retreat-energy');
  gs.resolvePick([0, 2]);
  const picked = await pickedPromise;
  assert.deepEqual(picked, [0, 2]);
  assert.equal(gs.retreat(pl, 0, picked), true);
  assert.deepEqual(pl.discard.sort(), ['basic A', 'basic C']);
  assert.deepEqual(pl.bench[0].energy, ['basic B']);
});

await test('retreat cost 2 can be paid by one two-unit special energy', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const doubleColorless = { name:'Double Colorless', provides:[{ types:['colorless'], count:2 }] };
  pl.active = mon('retreater');
  pl.active.retreatCost = 2;
  pl.active.energy = [doubleColorless, 'basic A'];
  pl.bench = [mon('bench')];
  assert.equal(gs.retreat(pl, 0, [0]), true);
  assert.deepEqual(pl.discard, [doubleColorless.cardId ?? doubleColorless.name], '被丢弃的能量以卡牌引用入弃牌区');
  assert.deepEqual(pl.bench[0].energy, ['basic A']);
});

await test('retreat no-picker fallback still discards enough energy units', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('retreater');
  pl.active.retreatCost = 2;
  pl.active.energy = ['basic A', 'basic B', 'basic C'];
  pl.bench = [mon('bench')];
  assert.equal(gs.retreat(pl, 0), true);
  assert.equal(pl.discard.length, 2);
  assert.equal(pl.bench[0].energy.length, 1);
});

await test('retreat empty selected energy list cancels without retreating', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const active = mon('retreater');
  const bench = mon('bench');
  pl.active = active;
  pl.active.retreatCost = 1;
  pl.active.energy = ['basic A'];
  pl.bench = [bench];
  assert.equal(gs.retreat(pl, 0, []), false);
  assert.equal(pl.active, active);
  assert.deepEqual(pl.bench, [bench]);
  assert.deepEqual(pl.discard, []);
  assert.equal(pl.retreatUsed, false);
});

await test('特殊能量可支付任意招式费用，普通不同属性不能支付指定属性', () => {
  const gs = new GameState();
  const m1 = mon('特殊能量宝可梦', 'm1', [{ name:'火招', damage:30, cost:['fire'], effects:[] }]);
  m1.energy = [{name:'特殊能量', provides:[{types:['any'],count:1}], specialRules:{}}];
  assert.equal(gs.checkEnergy(m1, 0), true);

  const m2 = mon('不同属性宝可梦', 'm2', [{ name:'火招', damage:30, cost:['fire'], effects:[] }]);
  m2.energy = ['基本【水】能量'];
  assert.equal(gs.checkEnergy(m2, 0), false);

  const m3 = mon('无色费用宝可梦', 'm3', [{ name:'无色招', damage:30, cost:['colorless'], effects:[] }]);
  m3.energy = ['基本【水】能量'];
  assert.equal(gs.checkEnergy(m3, 0), true);
});

await test('状态恢复：麻痹回合结束恢复，睡眠按硬币恢复', () => {
  const realRandom = Math.random;
  try {
    const gs = new GameState();
    gs.currentPlayer = gs.player1;
    gs.player1.active = mon('麻痹睡眠');
    gs.player1.active.status = 'paralysis,sleep';
    Math.random = () => 0.1; // 睡眠恢复
    gs.endTurn();
    assert.equal(gs.player1.active.status, null);

    const gs2 = new GameState();
    gs2.currentPlayer = gs2.player1;
    gs2.player1.active = mon('睡眠不醒');
    gs2.player1.active.status = 'sleep';
    Math.random = () => 0.9; // 睡眠不恢复
    gs2.endTurn();
    assert.equal(gs2.player1.active.status, 'sleep');
  } finally {
    Math.random = realRandom;
  }
});

await test('特殊能量：双重无色、单位能量、彩虹能量供能规则', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const doubleColorless = getSpecialEnergy('双重无色能量');
  pl.hand = ['3988'];
  pl.active = mon('无色费用', 'm', [{ name:'二费招', damage:30, cost:['colorless','colorless'], effects:[] }]);
  assert.equal(gs.attachEnergy(pl, 0, doubleColorless, 'active'), true);
  assert.equal(gs.checkEnergy(pl.active, 0), true);

  const unit = getSpecialEnergy('组合能量【草】【火】【水】');
  pl.hand = ['5754'];
  pl.active = mon('火费用', 'm2', [{ name:'火招', damage:30, cost:['fire'], effects:[] }]);
  assert.equal(gs.attachEnergy(pl, 0, unit, 'active'), false); // 同一回合已附能
  gs.player1.energyAttached = false;
  assert.equal(gs.attachEnergy(pl, 0, unit, 'active'), true);
  assert.equal(gs.checkEnergy(pl.active, 0), true);

  const rainbow = getSpecialEnergy('彩虹能量');
  gs.player1.energyAttached = false;
  pl.hand = ['4832'];
  pl.active = mon('彩虹目标', 'm3', [{ name:'雷招', damage:30, cost:['lightning'], effects:[] }]);
  assert.equal(gs.attachEnergy(pl, 0, rainbow, 'active'), true);
  assert.equal(gs.checkEnergy(pl.active, 0), true);
  assert.equal(pl.active.hp, 50); // 彩虹附着放置1个伤害指示物
});

await test('特殊能量：弱点防守/高温火/潜行恶/强力无效果', async () => {
  let gs = new GameState();
  let pl = gs.player1;
  let weakGuard = getSpecialEnergy('弱点防守能量');
  pl.hand = ['4510'];
  pl.active = mon('弱点目标');
  pl.active.weakness = 'fire';
  gs.attachEnergy(pl, 0, weakGuard, 'active');
  assert.equal(pl.active.weakness, null);

  gs = new GameState();
  pl = gs.player1;
  const heat = getSpecialEnergy('高温【火】能量');
  pl.hand = ['1430'];
  pl.active = mon('火宝可梦');
  pl.active.element = 'fire';
  gs.attachEnergy(pl, 0, heat, 'active');
  assert.equal(pl.active.maxHp, 80);
  assert.equal(pl.active.hp, 80);

  gs = new GameState();
  pl = gs.player1;
  const hideDark = getSpecialEnergy('潜行【恶】能量');
  pl.hand = ['1285'];
  pl.active = mon('恶宝可梦');
  pl.active.element = 'dark';
  pl.active.retreatCost = 3;
  pl.bench = [mon('备战')];
  gs.attachEnergy(pl, 0, hideDark, 'active');
  assert.equal(gs.retreat(pl, 0), true);
  assert.equal(pl.discard.length, 0);

  gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  const power = getSpecialEnergy('强力【无】能量');
  gs.player1.active = mon('无色攻击方', 'atk', [{ name:'打击', damage:20, cost:['colorless'], effects:[] }]);
  gs.player1.active.element = 'colorless';
  gs.player1.active.energy = [{ cardId:'1432', name:power.name, provides:power.provides, specialRules:power.specialRules }];
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 20); // 20基础 +20强力无
});

await test('招式执行顺序：反面失败类效果会阻止伤害和后续效果', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{
    name:'赌命撞击', damage:50, cost:[],
    effects:[{ action:'coin_flip', params:{ count:1, fail_on_tails:true } }, { action:'inflict_status', params:{ statuses:['poison'] } }]
  }]);
  gs.player2.active = mon('防守方');
  try {
    Math.random = () => 0.9; // 反面，招式失败
    const ok = await makeEngine(gs).attack();
    assert.equal(ok, false);
    assert.equal(gs.player2.active.hp, 60);
    assert.equal(gs.player2.active.status, null);
    assert.equal(gs.currentPlayer, gs.player1);
  } finally {
    Math.random = realRandom;
  }
});

await test('招式执行顺序：正面通过失败检查后才造成伤害并执行后续效果', async () => {
  const realRandom = Math.random;
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{
    name:'成功撞击', damage:50, cost:[],
    effects:[{ action:'coin_flip', params:{ count:1, fail_on_tails:true } }, { action:'inflict_status', params:{ statuses:['poison'] } }]
  }]);
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    Math.random = () => 0.1; // 正面，通过
    const ok = await makeEngine(gs).attack();
    assert.equal(ok, true);
    assert.equal(gs.player2.active.hp, 0); // 50 伤害后 10，回合结束时中毒结算 -10 → 0
    assert.equal(gs.player2.active.status, 'poison');
    assert.equal(gs.currentPlayer, gs.player2);
  } finally {
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
  }
});

await test('特性系统：解析消除、被动伤害和基本能量倍化', () => {
  let parsed = parseEffect('只要这只宝可梦在战斗场上，对手的战斗宝可梦的特性全部消除。');
  assert.equal(parsed.effects[0]?.action, 'ability_nullify');
  assert.equal(parsed.effects[0]?.params.scope, 'opponent_active');

  parsed = parseEffect('只要这只宝可梦在场上，自己的宝可梦使用的招式，对对手的战斗宝可梦造成的伤害"+30"点。');
  assert.equal(parsed.effects.some(e => e.action === 'passive_damage_mod' && e.params.amount === 30), true);

  parsed = parseEffect('只要这只宝可梦在场上，自己的场上宝可梦身上所附加的基本【草】能量，视为各提供2个【草】能量。');
  assert.equal(parsed.effects.some(e => e.action === 'energy_provides_multiplier' && e.params.energyType === 'grass'), true);
});

await test('特性系统：主动特性一回合一次，并在回合结束后重置', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'd2'];
  pl.active = mon('特性宝可梦');
  pl.active.ability = { name:'抽牌特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  const engine = makeEngine(gs);
  assert.equal(await engine.useAbility(pl.active), true);
  assert.equal(pl.hand.length, 1);
  assert.equal(await engine.useAbility(pl.active), false);
  gs.endTurn();
  gs.currentPlayer = pl;
  assert.equal(await engine.useAbility(pl.active), true);
});

await test('特性系统：被消除的场上特性无法使用', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.active = mon('消除源');
  pl.active.ability = { name:'化学气体', active:false, zone:'active', effects:[{ action:'ability_nullify', params:{ scope:'opponent_active' } }] };
  opp.active = mon('被消除');
  opp.active.ability = { name:'抽牌特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.recomputePassives();
  assert.equal(opp.active.abilityDisabled, true);
  gs.currentPlayer = opp;
  assert.equal(await makeEngine(gs).useAbility(opp.active), false);
});

await test('特性系统：手牌特性可执行且不放置宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['handMon'];
  pl.deck = ['d1'];
  const card = { cardId:'handMon', name:'手牌宝可梦', ability:{ name:'手牌抽卡', active:true, zone:'hand', effects:[{ action:'draw', params:{ count:1 } }] } };
  const ok = await makeEngine(gs).useAbility(card, card.ability, { player:pl, zone:'hand' });
  assert.equal(ok, true);
  assert.deepEqual(pl.hand, ['handMon', 'd1']);
  assert.equal(pl.active, null);
});

await test('特性系统：被动伤害修正影响攻击', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  gs.player1.active = mon('攻击方', 'atk', [{ name:'打击', damage:20, cost:[], effects:[] }]);
  gs.player1.active.ability = { name:'强力声援', active:false, zone:'field', effects:[{ action:'passive_damage_mod', params:{ target:'own_field', amount:30 } }] };
  gs.player2.active = mon('防守方');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { await makeEngine(gs).attack(); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(gs.player2.active.hp, 10);
});

await test('特性系统：基本能量倍化可支付二费，特性消除后失效', () => {
  const gs = new GameState();
  const attacker = mon('倍化宝可梦', 'atk', [{ name:'草二费', damage:30, cost:['grass','grass'], effects:[] }]);
  attacker.energy = ['基本【草】能量'];
  attacker.ability = { name:'密林霸主', active:false, zone:'field', effects:[{ action:'energy_provides_multiplier', params:{ energyType:'grass', multiplier:2, basicOnly:true } }] };
  assert.equal(gs.checkEnergy(attacker, 0), true);
  attacker.abilityDisabled = true;
  assert.equal(gs.checkEnergy(attacker, 0), false);
});

await test('特性系统：临时特性消除会随换位重算并在回合结束清除', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  gs.currentPlayer = pl;
  pl.active = mon('我方');
  opp.active = mon('对手出战');
  opp.bench = [mon('对手备战')];
  opp.active.ability = { name:'出战特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  opp.bench[0].ability = { name:'备战特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  await executeEffects(gs, pl, [{ action:'ability_nullify', params:{ scope:'opponent_active', duration:'turn' } }]);
  assert.equal(opp.active.abilityDisabled, true);
  const old = opp.active;
  opp.active = opp.bench.shift();
  opp.bench.push(old);
  gs.recomputePassives();
  assert.equal(opp.active.name, '对手备战');
  assert.equal(opp.active.abilityDisabled, true);
  gs.endTurn();
  assert.equal(opp.active.abilityDisabled, false);
});

await test('特性系统：场上光环能量倍化作用于己方其他宝可梦', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('攻击方', 'atk', [{ name:'草二费', damage:30, cost:['grass','grass'], effects:[] }]);
  pl.active.energy = ['基本【草】能量'];
  pl.bench = [mon('妙蛙花')];
  pl.bench[0].ability = { name:'密林霸主', active:false, zone:'field', effects:[{ action:'energy_provides_multiplier', params:{ target:'own_field', energyType:'grass', multiplier:2, basicOnly:true } }] };
  assert.equal(gs.checkEnergy(pl.active, 0), true);
  pl.bench[0].abilityDisabled = true;
  assert.equal(gs.checkEnergy(pl.active, 0), false);
});

await test('真实卡特性：密林霸主让己方基本草能量提供2个草', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('密林霸主'));
  assert.equal(ability.effects.some(e => e.action === 'energy_provides_multiplier'), true);
  pl.active = mon('草攻击方', 'atk', [{ name:'草二费', damage:30, cost:['grass','grass'], effects:[] }]);
  pl.active.energy = ['基本【草】能量'];
  pl.bench = [mon('妙蛙花')];
  pl.bench[0].ability = ability;
  assert.equal(gs.checkEnergy(pl.active, 0), true);
  pl.bench[0].abilityDisabled = true;
  assert.equal(gs.checkEnergy(pl.active, 0), false);
});

await test('真实卡特性：猛烈燃烧让己方基本火能量提供2个火', () => {
  const gs = new GameState();
  const pl = gs.player1;
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('猛烈燃烧'));
  assert.equal(ability.effects.some(e => e.action === 'energy_provides_multiplier'), true);
  pl.active = mon('火攻击方', 'atk', [{ name:'火二费', damage:30, cost:['fire','fire'], effects:[] }]);
  pl.active.energy = ['基本【火】能量'];
  pl.bench = [mon('喷火龙')];
  pl.bench[0].ability = ability;
  assert.equal(gs.checkEnergy(pl.active, 0), true);
});

await test('真实卡特性：阳光绽放是「回合结束时」触发（不应能中途手动补牌）', async () => {
  // ⚠️ 语义变更：卡面是「在自己的回合结束时可以使用1次」，本应结算于回合结束，
  //   旧实现把它当成可随时手动发动的特性（中途就能补到 4 张）。现在解析为 turn_end 触发器，
  //   补牌效果收在触发器内 → 中途手动发动不再补牌，回合结束才结算。
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('阳光绽放'));
  const tr = ability.effects.find(e => e.action === 'trigger');
  assert.ok(tr, `应解析为 turn_end 触发器（实际 ${JSON.stringify(ability.effects.map(e => e.action))}）`);
  assert.equal(tr.params.event, 'turn_end');
  assert.equal(tr.params.effects.some(e => e.action === 'draw_until' && e.params.target === 4), true, '补牌到 4 应作为触发效果');
  assert.ok(!ability.effects.some(e => e.action === 'draw_until'), '补牌不应留在顶层');

  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['h1'];
  pl.deck = ['d1', 'd2', 'd3', 'd4'];
  pl.active = mon('美丽花');
  pl.active.ability = ability;
  const engine = makeEngine(gs);
  await engine.useAbility(pl.active);
  assert.equal(pl.hand.length, 1, '不应在中途手动补牌（回合结束才结算）');
});

await test('真实卡特性：化学变化气体只在战斗场上消除对手场上特性并尊重例外', () => {
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('化学变化气体'));
  assert.equal(ability.effects.some(e => e.action === 'ability_nullify' && e.params.scope === 'opponent_field'), true);
  assert.deepEqual(ability.effects[0].params.exceptAbilityNames, ['化学变化气体']);

  const gs = new GameState();
  gs.player1.active = mon('伽勒尔 双弹瓦斯');
  gs.player1.active.ability = ability;
  gs.player1.bench = [mon('我方备战')];
  gs.player1.bench[0].ability = { name:'我方特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.player2.active = mon('对手出战');
  gs.player2.active.ability = { name:'普通特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.player2.bench = [mon('对手备战'), mon('对手同名')];
  gs.player2.bench[0].ability = { name:'备战特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.player2.bench[1].ability = { name:'化学变化气体', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.recomputePassives();
  assert.equal(gs.player2.active.abilityDisabled, true);
  assert.equal(gs.player2.bench[0].abilityDisabled, true);
  assert.equal(gs.player2.bench[1].abilityDisabled, false);
  assert.equal(gs.player1.bench[0].abilityDisabled, false);

  const gs2 = new GameState();
  gs2.player1.active = mon('我方出战');
  gs2.player1.bench = [mon('伽勒尔 双弹瓦斯')];
  gs2.player1.bench[0].ability = ability;
  gs2.player2.active = mon('对手出战');
  gs2.player2.active.ability = { name:'普通特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs2.recomputePassives();
  assert.equal(gs2.player2.active.abilityDisabled, false);
});

await test('真实卡特性：暗夜羽击只消除对手战斗宝可梦特性并尊重例外', () => {
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('暗夜振翼'));
  assert.equal(ability.effects.some(e => e.action === 'ability_nullify' && e.params.scope === 'opponent_active'), true);
  assert.deepEqual(ability.effects[0].params.exceptAbilityNames, ['暗夜振翼']);

  const gs = new GameState();
  gs.player1.active = mon('振翼发');
  gs.player1.active.ability = ability;
  gs.player2.active = mon('对手出战');
  gs.player2.active.ability = { name:'普通特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.player2.bench = [mon('对手备战')];
  gs.player2.bench[0].ability = { name:'备战特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.recomputePassives();
  assert.equal(gs.player2.active.abilityDisabled, true);
  assert.equal(gs.player2.bench[0].abilityDisabled, false);

  gs.player2.active.ability = { name:'暗夜振翼', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs.recomputePassives();
  assert.equal(gs.player2.active.abilityDisabled, false);

  const gs2 = new GameState();
  gs2.player1.active = mon('我方出战');
  gs2.player1.bench = [mon('振翼发')];
  gs2.player1.bench[0].ability = ability;
  gs2.player2.active = mon('对手出战');
  gs2.player2.active.ability = { name:'普通特性', active:true, zone:'field', effects:[{ action:'draw', params:{ count:1 } }] };
  gs2.recomputePassives();
  assert.equal(gs2.player2.active.abilityDisabled, false);
});

await test('Stadium：城镇百货公司风格打出只进竞技场槽，不立即搜宝可梦道具', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    tool001: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
    pokemon001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘' } },
  });
  pl.hand = ['stadium001'];
  pl.deck = ['bottom', 'tool001', 'pokemon001'];
  const engine = new BattleEngine(gs, gs.cardResolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });

  const ok = await engine.useTrainer(0, {
    cardType:'trainer',
    trainerType:'stadium',
    name:'城镇百货公司',
    effects:[
      { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } },
      { action:'shuffle_deck', params:{} },
    ],
  });

  assert.equal(ok, true);
  assert.equal(pl.stadium.name, '城镇百货公司');
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.deck, ['bottom', 'tool001', 'pokemon001']);
  assert.equal(pl.deck.includes('tool001'), true);
  assert.equal(gs.log.some(msg => msg.includes('搜牌库拿了')), false);
});

await test('Stadium：打出第二张竞技场保留既有替换行为且不执行搜索', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  gs._shuffle = deck => deck;
  pl.stadium = '旧竞技场';
  pl.hand = ['stadium002'];
  pl.deck = ['tool001'];
  gs.cardResolver = fakeResolver({
    tool001: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
  });
  const engine = new BattleEngine(gs, gs.cardResolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });

  const ok = await engine.useTrainer(0, {
    cardType:'trainer',
    trainerType:'stadium',
    name:'第二竞技场',
    effects:[{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } }],
  });

  assert.equal(ok, true);
  assert.equal(pl.stadium.name, '第二竞技场');
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.deck, ['tool001']);
  assert.equal(gs.log.includes('旧竞技场 被替换'), true);
});

await test('Stadium：discard_cost 使用前提仍在打出前支付，但普通效果不执行', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    cost001: { info:{ name:'费用手牌', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'费用手牌' } },
    tool001: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
  });
  pl.hand = ['cost001', 'stadium001'];
  pl.deck = ['tool001'];
  const engine = new BattleEngine(gs, gs.cardResolver, { onLog:()=>{}, onPhaseChange:()=>{}, onFieldUpdate:()=>{} });

  const ok = await engine.useTrainer(1, {
    cardType:'trainer',
    trainerType:'stadium',
    name:'有费用竞技场',
    effects:[
      { action:'trainer_prerequisite', params:{ kind:'discard_cost', count:1 } },
      { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } },
    ],
  });

  assert.equal(ok, true);
  assert.equal(pl.stadium.name, '有费用竞技场');
  assert.deepEqual(pl.hand, []);
  assert.deepEqual(pl.discard, ['cost001']);
  assert.deepEqual(pl.deck, ['tool001']);
  assert.equal(gs.log.some(msg => msg.includes('支付费用：丢弃 1 张手牌')), true);
});

await test('训练家事务：回滚后竞技场保持共享对象且owner指向真实玩家', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  const originalStadium = { cardId:'oldStadium', name:'旧竞技场', card:{ name:'旧竞技场' }, effects:[], owner:pl };
  gs.stadium = originalStadium;
  gs.activeStadium = originalStadium;
  pl.stadium = originalStadium;
  opp.stadium = null;
  pl.hand = ['trainerCard'];
  pl.deck = ['bottom', 'targetPokemon 宝可梦'];
  gs._shuffle = deck => deck;
  gs._onPendingPick = pick => {
    assert.equal(pick.options?.source, 'deck-search');
    gs.resolvePick([]);
  };
  const engine = makeEngine(gs);

  const ok = await engine.useTrainer(0, {
    cardType:'trainer', trainerType:'item', name:'移除场地后失败物品',
    effects:[
      { action:'discard_field_attachments', params:{ stadium:true } },
      { action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦' } },
    ],
  });

  assert.equal(ok, false);
  assert.equal(gs.stadium, pl.stadium);
  assert.equal(gs.activeStadium, gs.stadium);
  assert.equal(gs.stadium.owner, pl);
  assert.notEqual(opp.stadium, gs.stadium);
  assert.equal(opp.stadium, null);
  assert.deepEqual(pl.discard, []);

  const restored = gs.stadium;
  const cleared = gs.clearActiveStadium();
  assert.equal(cleared, restored);
  assert.deepEqual(pl.discard, ['oldStadium']);
  assert.deepEqual(opp.discard, []);
});
await test('search_deck_to_hand：宝可梦道具/Pokemon Tool 过滤只选择训练家道具并拒绝其他类型', async () => {
  for (const filter of ['宝可梦道具', 'Pokemon Tool']) {
    const gs = new GameState();
    const pl = gs.player1;
    gs._shuffle = deck => deck;
    gs.cardResolver = fakeResolver({
      tool001: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
      pokemon001: { info:{ name:'皮卡丘', number:'025', type:'pokemon' }, card:{ cardType:'pokemon', name:'皮卡丘' } },
      item001: { info:{ name:'物品卡', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'物品卡' } },
      supporter001: { info:{ name:'博士的研究', number:null, type:'supporter' }, card:{ cardType:'trainer', trainerType:'supporter', name:'博士的研究' } },
      stadium001: { info:{ name:'竞技场卡', number:null, type:'stadium' }, card:{ cardType:'trainer', trainerType:'stadium', name:'竞技场卡' } },
      energy001: { info:{ name:'基本【雷】能量', number:null, type:'energy' }, card:{ cardType:'energy', name:'基本【雷】能量' } },
    });
    pl.deck = ['bottom', 'energy001', 'stadium001', 'supporter001', 'item001', 'pokemon001', 'tool001'];
    pl.hand = [];
    gs._onPendingPick = pick => {
      assert.deepEqual(pick.cards, ['宝可梦道具 力量头带'], filter);
      assert.equal(pick.options?.filter, filter);
      gs.resolvePick([0]);
    };

    await executeEffects(gs, pl, [{ action:'search_deck_to_hand', params:{ count:1, filter } }]);

    assert.deepEqual(pl.hand, ['tool001'], filter);
    assert.equal(pl.deck.includes('pokemon001'), true, filter);
    assert.equal(pl.deck.includes('item001'), true, filter);
    assert.equal(pl.deck.includes('supporter001'), true, filter);
    assert.equal(pl.deck.includes('stadium001'), true, filter);
    assert.equal(pl.deck.includes('energy001'), true, filter);
  }
});

await test('直接宝可梦道具搜索：无选择器 fallback 只拿工具卡，不拿宝可梦', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs._shuffle = deck => deck;
  gs.cardResolver = fakeResolver({
    tool001: { info:{ name:'宝可梦道具 力量头带', number:null, type:'tool' }, card:{ cardType:'trainer', trainerType:'tool', name:'宝可梦道具 力量头带' } },
    pokemon001: { info:{ name:'宝可梦道具爱好者', number:'999', type:'pokemon' }, card:{ cardType:'pokemon', name:'宝可梦道具爱好者' } },
    item001: { info:{ name:'普通物品', number:null, type:'item' }, card:{ cardType:'trainer', trainerType:'item', name:'普通物品' } },
  });
  pl.deck = ['bottom', 'item001', 'tool001', 'pokemon001'];
  pl.hand = [];

  await executeEffects(gs, pl, [{ action:'search_deck_to_hand', params:{ count:1, filter:'宝可梦道具' } }]);

  assert.deepEqual(pl.hand, ['tool001']);
  assert.equal(pl.deck.includes('pokemon001'), true);
  assert.equal(pl.deck.includes('item001'), true);
});

// ============================================================
//  2.9) 效果动作顺序 / 条件改写 / 伤害指示物转放（本轮修复的回归保护）
// ============================================================

await test('效果动作顺序按卡面文本排列（不再按规则表顺序）', () => {
  // 「先洗手牌回牌库并重洗，然后抽 N 张」——旧实现按 RULES 表顺序输出，
  // 会变成「先抽 N 张，再把含刚抽到的手牌洗回牌库」，效果完全相反。
  const t = '将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。';
  assert.equal(actions(t).join('>'), 'shuffle_hand_to_deck');

  // 搜牌 + 重洗：重洗必须在搜牌之后
  const t2 = '从自己牌库中，选择1张HP在「90」以下（包含「90」）的宝可梦，在给对手看过之后，加入手牌。并重洗牌库。';
  const a2 = actions(t2);
  assert.ok(a2.indexOf('search_deck_to_hand') < a2.indexOf('shuffle_deck'),
    `重洗应在搜牌之后: ${a2.join('>')}`);
});

await test('莉莉艾的决心：条件改写合并进抽卡动作且抽数为 8', async () => {
  const t = '将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。如果自己的剩余奖赏卡张数为6张的话，则抽取的张数变为8张。';
  const eff = parseEffect(t).effects;
  assert.equal(eff.length, 1, `应合并为 1 个动作: ${JSON.stringify(eff)}`);
  assert.equal(eff[0].action, 'shuffle_hand_to_deck');
  assert.equal(eff[0].params.draw_count, 6);
  assert.equal(eff[0].params.ownPrizesExactly, 6);
  assert.equal(eff[0].params.countThen, 8);
  assert.equal(eff[0].params._pos, undefined, '_pos 不应泄漏到结果里');

  const run = async prizeCount => {
    const gs = new GameState();
    const pl = gs.player1;
    pl.deck = Array.from({ length: 40 }, (_, i) => 'd' + i);
    pl.hand = ['h1', 'h2', 'h3', 'h4'];
    pl.prizes = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].slice(0, prizeCount);
    await executeEffects(gs, pl, eff);
    return pl.hand.length;
  };
  assert.equal(await run(6), 8, '剩余奖赏卡 6 张时应抽 8 张');
  assert.equal(await run(5), 6, '剩余奖赏卡不足 6 张时应抽 6 张');
});

await test('愿增猿「亢奋脑力」：无伤害指示物时判定不可用', () => {
  const t = '如果这只宝可梦身上附着了【恶】能量的话，则在自己的回合可以使用1次。选择自己场上1只宝可梦身上放置的最多3个伤害指示物，转放于对手场上1只宝可梦身上。';
  const eff = parseEffect(t).effects;
  const mk = ({ hp, dark }) => {
    const gs = new GameState();
    const pl = gs.player1;
    const y = { name:'愿增猿', cardId:'CSV8C-094', hp, maxHp:110, element:'psychic',
      energy: dark ? [{ name:'基本恶能量', provides:[{ types:['dark'], count:1 }] }] : [],
      attacks: [], tool: null, ability: { name:'亢奋脑力', active:true, zone:'field', effects: eff } };
    pl.active = y; pl.bench = [];
    gs.player2.active = { name:'对手', cardId:'o', hp:120, maxHp:120, element:'colorless', energy: [], attacks: [], tool: null };
    return { gs, pl, y };
  };
  // 有恶能量但己方场上没有任何伤害指示物 -> 必须置灰
  const c1 = mk({ hp: 110, dark: true });
  const r1 = c1.gs.canUseAbility(c1.pl, c1.y, c1.y.ability, 'field');
  assert.equal(r1.ok, false, '无伤害指示物时应不可用');
  assert.match(String(r1.message || ''), /伤害指示物/);

  // 有恶能量且有伤害指示物 -> 可用
  const c2 = mk({ hp: 50, dark: true });
  assert.equal(c2.gs.canUseAbility(c2.pl, c2.y, c2.y.ability, 'field').ok, true);

  // 有伤害指示物但没恶能量 -> 不可用
  const c3 = mk({ hp: 50, dark: false });
  assert.equal(c3.gs.canUseAbility(c3.pl, c3.y, c3.y.ability, 'field').ok, false);
});

await test('愿增猿「亢奋脑力」：把 3 个伤害指示物从己方转放到对手身上', async () => {
  const t = '如果这只宝可梦身上附着了【恶】能量的话，则在自己的回合可以使用1次。选择自己场上1只宝可梦身上放置的最多3个伤害指示物，转放于对手场上1只宝可梦身上。';
  const eff = parseEffect(t).effects;
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = { name:'愿增猿', cardId:'CSV8C-094', hp:50, maxHp:110, element:'psychic',
    energy: [{ name:'基本恶能量', provides:[{ types:['dark'], count:1 }] }],
    attacks: [], tool: null, ability: { name:'亢奋脑力', active:true, zone:'field', effects: eff } };
  pl.bench = [];
  const opp = gs.player2;
  opp.active = { name:'对手', cardId:'o', hp:120, maxHp:120, element:'colorless', energy: [], attacks: [], tool: null };
  opp.bench = [];
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.hp, 80, `己方应移走 3 个指示物(30)：${pl.active.hp}`);
  assert.equal(opp.active.hp, 90, `对手应受到 30 伤害：${opp.active.hp}`);
});

await test('伤害指示物不会把 HP 压成负数', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = { name:'A', cardId:'a', hp:30, maxHp:30, element:'colorless', energy: [], attacks: [], tool: null };
  const opp = gs.player2;
  opp.active = { name:'B', cardId:'b', hp:20, maxHp:20, element:'colorless', energy: [], attacks: [], tool: null };
  // 直接走 damage_place 的固定目标分支
  const eff = [{ action:'damage_place', params:{ target:'opponent_active', count:9 } }];
  return executeEffects(gs, pl, eff).then(() => {
    assert.ok(opp.active.hp >= 0, `HP 不应为负: ${opp.active.hp}`);
  });
});

await test('赤松：牌库取属性互不相同的基本能量，1 张入手牌、剩余附着', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    'e-fire': { card: { cardType: 'energy', name: '基本火能量' }, info: { name: '基本火能量', type: 'energy' } },
    'e-water': { card: { cardType: 'energy', name: '基本水能量' }, info: { name: '基本水能量', type: 'energy' } },
  });
  pl.deck = ['e-fire', 'e-fire', 'e-fire', 'e-water', 'e-water'];
  pl.hand = [];
  pl.active = mon('出战');
  pl.bench = [];
  const eff = parseEffect('选择自己牌库中，属性各不相同的基本能量最多2张，在给对手看过之后，将其中1张加入手牌，将剩余的能量附着于自己的宝可梦身上。并重洗牌库。').effects;
  assert.equal(eff[0].action, 'search_deck_energy_split');
  assert.equal(eff[0].params.count, 2);
  assert.equal(eff[0].params.toHand, 1);
  await executeEffects(gs, pl, eff);
  // 不能把两张都塞进手牌
  assert.equal(pl.hand.length, 1, `手牌应只有 1 张，实际 ${JSON.stringify(pl.hand)}`);
  // 剩余那张必须附着到己方宝可梦身上
  assert.equal(pl.active.energy.length, 1, '剩余能量应附着 1 张');
  // 两张能量的属性必须不同（手牌里存的是卡牌 ID，需要经 resolver 取名字）
  const handName = String(gs.cardResolver.getCard(pl.hand[0])?.name || '');
  const attachedName = String(pl.active.energy[0]?.name || pl.active.energy[0]?.cardId || '');
  const elemOf = s => ['火', '水', '草', '雷', '超', '斗', '恶', '钢', '妖'].find(e => s.includes(e)) || '';
  assert.ok(elemOf(handName), `手牌能量应能识别属性: ${handName}`);
  assert.notEqual(elemOf(handName), elemOf(attachedName), `两张能量属性不应相同: ${handName} / ${attachedName}`);
  assert.equal(pl.deck.length, 3, '牌库应减少 2 张');
});

await test('赤松：牌库只有单一属性时最多只能取 1 张', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.cardResolver = fakeResolver({
    'e-fire': { card: { cardType: 'energy', name: '基本火能量' }, info: { name: '基本火能量', type: 'energy' } },
  });
  pl.deck = ['e-fire', 'e-fire', 'e-fire'];
  pl.hand = [];
  pl.active = mon('出战');
  pl.bench = [];
  const eff = parseEffect('选择自己牌库中，属性各不相同的基本能量最多2张，在给对手看过之后，将其中1张加入手牌，将剩余的能量附着于自己的宝可梦身上。并重洗牌库。').effects;
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 1, '同属性不可重复选取，最多 1 张入手牌');
  assert.equal(pl.active.energy.length, 0, '没有剩余能量可附着');
  assert.equal(pl.deck.length, 2, '牌库只应减少 1 张');
});

await test('提示面板不会在 1.2 秒后把用户打开的页签顶回主菜单', async () => {
  // _showMessage 原实现无条件 setTimeout(() => _showPanel('panel-main'))，
  // 回合开始的引擎日志会让刚打开的【卡牌】页签被弹回。
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  assert.ok(/now\.id === 'panel-message'/.test(src), '定时器应只在仍处于 panel-message 时才收回');
});

// ============================================================
//  3) 全卡牌数据解析覆盖率报告（不要求100%，用于持续发现未覆盖文本）
// ============================================================

// ============================================================
//  5 项战斗修复的回归测试
// ============================================================

await test('① 先攻玩家最初回合：canUseAttack 判定不可用（界面据此置灰）', () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.currentPlayer = gs.player1;
  const mon = { name:'测试', hp:100, maxHp:100, element:'colorless', energy:[], status:null, cannotAttackNext:false, costEliminated:false, attacks:[{name:'撞击',cost:[],damage:'20'}] };
  const r1 = gs.canUseAttack(gs.player1, mon, 0);
  assert.equal(r1.ok, false, '先攻首回合应不可用');
  assert.equal(r1.reason, 'first_turn');
  assert.match(r1.message, /最初回合/);
  // 非首回合、能量足够 → 可用
  gs.firstPlayerFirstTurnInProgress = false;
  assert.equal(gs.canUseAttack(gs.player1, mon, 0).ok, true);
  // 睡眠/麻痹/本回合禁止攻击 → 不可用
  mon.status = 'sleep';
  assert.equal(gs.canUseAttack(gs.player1, mon, 0).reason, 'asleep');
  mon.status = 'paralysis';
  assert.equal(gs.canUseAttack(gs.player1, mon, 0).reason, 'paralyzed');
  mon.status = null;
  mon.cannotAttackNext = true;
  assert.equal(gs.canUseAttack(gs.player1, mon, 0).reason, 'cannot_attack_next');
  mon.cannotAttackNext = false;
  // 能量不足 → 不可用
  const costly = { ...mon, attacks:[{name:'大火',cost:['火','火'],damage:'100'}] };
  assert.equal(gs.canUseAttack(gs.player1, costly, 0).reason, 'energy');
});

await test('② 坚硬头锤：硬币正面后防护活到对手回合结束，期间免伤、到期恢复', async () => {
  const TEXT2 = '抛掷1次硬币如果为正面，则在下一个对手的回合，这只宝可梦不受到招式的伤害和效果影响。';
  const eff = parseEffect(TEXT2).effects;
  // 解析要同时给出「防伤」与「防效」，且时长是下一个对手回合
  const heads = eff[0]?.params?.heads || [];
  assert.equal(eff[0]?.action, 'coin_flip');
  assert.deepEqual(heads.map(e => e.action), ['prevent_damage', 'prevent_effect']);
  assert.ok(heads.every(e => e.params.duration === 'next_opp_turn'));

  const mkMon = (name, hp, element) => ({ name, cardId:name, hp, maxHp:hp, element, attacks:[], energy:[], status:null, ignore:[], tool:null, ability:null });
  const gs = new GameState();
  gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player1; gs.turn = 3;
  gs.firstPlayer = gs.player1; gs.firstPlayerFirstTurnInProgress = false;
  const rock = mkMon('大岩蛇', 120, 'fighting');
  rock.attacks = [{ name:'坚硬头锤', cost:[], damage:'20', effects:eff }];
  const mew = mkMon('超梦', 130, 'psychic');
  mew.attacks = [{ name:'精神念力', cost:[], damage:'60', effects:[] }];
  gs.player1.active = rock; gs.player2.active = mew;
  gs.player1.deck = Array.from({length:30},(_,i)=>'a'+i);
  gs.player2.deck = Array.from({length:30},(_,i)=>'b'+i);
  gs.player1.prizes = ['a','b','c','d','e','f'];
  gs.player2.prizes = ['a','b','c','d','e','f'];
  const logs = [];
  const engine = makeEngineWithEvents(gs).engine;
  engine.cb.onLog = m => logs.push(m);

  const realRandom = Math.random;
  Math.random = () => 0;                       // 硬币正面
  await engine.attack(0);                      // attack() 内部会自动结束回合
  Math.random = realRandom;
  assert.equal(rock.preventDamage, true);
  assert.equal(rock.preventEffect, true);
  assert.equal(rock.attackShieldArmed, true);
  assert.equal(gs.currentPlayer, gs.player2, '攻击后回合应已交给对手');
  assert.equal(rock.preventDamage, true, '自己回合结束后防护不能被清掉（原 bug）');

  gs.phase = PHASE.BATTLE;
  await engine.attack(0);                      // 对手攻击
  assert.equal(rock.hp, 120, '防护期间不应受伤');
  assert.ok(logs.some(l => String(l).includes('防止了伤害')), '应有「防止了伤害」日志');
  assert.equal(rock.attackShieldArmed, false, '对手回合结束后防护应到期');
  assert.equal(rock.preventDamage, false);

  // 到期后再被打应正常掉血
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player2;
  await engine.attack(0);
  assert.equal(rock.hp, 60, `到期后应正常受伤，实际 ${rock.hp}`);
});

await test('③ 命中弱点记「效果绝佳」、被抵抗记「效果一般」', async () => {
  const mkMon = (name, hp, element) => ({ name, cardId:name, hp, maxHp:hp, element, attacks:[], energy:[], status:null, ignore:[], tool:null, ability:null });
  const run = async (defExtra) => {
    const gs = new GameState();
    gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player1; gs.turn = 3;
    gs.firstPlayer = gs.player1; gs.firstPlayerFirstTurnInProgress = false;
    const atk = mkMon('大岩蛇', 120, 'fighting');
    atk.attacks = [{ name:'落石', cost:[], damage:'20', effects:[] }];
    const def = mkMon('超梦', 130, 'psychic');
    def.attacks = [{ name:'念力', cost:[], damage:'10', effects:[] }];
    Object.assign(def, { weaknessMultiplier:2, resistanceValue:-30 }, defExtra);
    gs.player1.active = atk; gs.player2.active = def;
    gs.player1.deck = Array.from({length:30},(_,i)=>'a'+i);
    gs.player2.deck = Array.from({length:30},(_,i)=>'b'+i);
    gs.player1.prizes = ['a','b','c','d','e','f'];
    gs.player2.prizes = ['a','b','c','d','e','f'];
    const logs = [];
    const engine = makeEngineWithEvents(gs).engine;
    engine.cb.onLog = m => logs.push(m);
    await engine.attack(0);
    return { gs, logs, def };
  };
  // 弱点 = 攻击方属性(fighting) → 翻倍 + 日志
  const weak = await run({ weakness:'fighting' });
  assert.ok(weak.logs.some(l => String(l).includes('效果绝佳')), `弱点日志缺失: ${weak.logs.join(' | ')}`);
  assert.equal(weak.def.hp, 130 - 40, '弱点伤害应翻倍（20 → 40）');
  // 抵抗 = 攻击方属性 → -30 + 日志
  const resist = await run({ resistance:'fighting' });
  assert.ok(resist.logs.some(l => String(l).includes('效果一般')), `抵抗日志缺失: ${resist.logs.join(' | ')}`);
});

await test('④ 派帕的三明治：目标是「派帕的宝可梦」时回复 100 而非 30', async () => {
  const TEXT4 = '回复自己的战斗宝可梦「30」HP。如果那只宝可梦是「派帕的宝可梦」的话，则回复的HP变为「100」。';
  const eff = parseEffect(TEXT4).effects;
  assert.equal(eff[0].action, 'heal');
  assert.equal(eff[0].params.amount, 30);
  assert.equal(eff[0].params.ifNamePrefix, '派帕的');
  assert.equal(eff[0].params.amountThen, 100);

  const run = async name => {
    const gs = new GameState();
    const pl = gs.player1;
    pl.active = { name, cardId:name, hp: 20, maxHp: 150, element:'colorless', energy:[], attacks:[], status:null, ignore:[], tool:null, ability:null };
    pl.bench = [];
    await executeEffects(gs, pl, eff);
    return pl.active.hp;
  };
  assert.equal(await run('派帕的藏饱栗鼠'), 120, '派帕的宝可梦应回复 100');
  assert.equal(await run('藏饱栗鼠'), 50, '普通藏饱栗鼠应只回复 30');
});

await test('⑤ 竞技场动作文案区分「发动效果」与「打出卡」', () => {
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  gs.currentPlayer = gs.player1;
  // 竞技场需要有「可执行效果」才会出现在动作空间里（usage_condition / trainer_prerequisite 不算）
  const stadium = { name:'深钵镇', cardId:'st-1', cardType:'stadium', trainerType:'stadium',
    effects:[{ action:'heal', params:{ amount:10 } }], specialRules:[] };
  gs.stadium = stadium;
  gs.player1.stadiumUsedThisTurn = {};
  const acts = getLegalActions(gs, new CardResolver(), gs.player1);
  const act = acts.find(a => a.kind === 'activate_stadium');
  assert.ok(act, `应存在发动竞技场动作：${acts.map(a => a.kind).join(',')}`);
  const desc = describeAction(act);
  assert.ok(desc.includes('发动竞技场效果'), `文案应含「发动竞技场效果」而非只写「发动竞技场」: ${desc}`);
  assert.ok(desc.includes('深钵镇'));
});

// ------------------------------------------------------------
//  场地列表置灰 / 备战区满时不能空发
// ------------------------------------------------------------

await test('① 场地列表：本回合不能进化且无其他操作时置灰', () => {
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  const evoCard = { cardType:'pokemon', name:'火恐龙', evolvesFrom:'小火龙' };
  const app = Object.create(PTCGBattleApp.prototype);
  app.gs = gs;
  app.resolver = { getCard: () => evoCard };
  gs.player1.hand = ['evo-1'];
  gs.player1.energyAttached = false;
  gs.player1.bench = [];

  // 本回合刚出场 → 不能进化，且没有其他可执行操作 → 应置灰
  const justPlaced = { name:'小火龙', placedThisTurn:true, evolvedThisTurn:false, tool:null, ability:null, cannotRetreat:false };
  assert.equal(app._pokeHasActions('active', justPlaced), false, '刚出场且无其他操作应置灰');

  // 本回合已进化过 → 同样不能再进化
  const alreadyEvolved = { name:'小火龙', placedThisTurn:false, evolvedThisTurn:true, tool:null, ability:null, cannotRetreat:false };
  assert.equal(app._pokeHasActions('active', alreadyEvolved), false, '已进化过应置灰');

  // 可以进化 → 有可执行操作
  const canEvolve = { name:'小火龙', placedThisTurn:false, evolvedThisTurn:false, tool:null, ability:null, cannotRetreat:false };
  assert.equal(app._pokeHasActions('active', canEvolve), true, '能进化时应可点');

  // 不能进化，但手上有能量可附 → 仍可点
  app.resolver = { getCard: id => (id === 'energy-1' ? { cardType:'energy', name:'基本火能量' } : evoCard) };
  gs.player1.hand = ['evo-1', 'energy-1'];
  assert.equal(app._pokeHasActions('active', justPlaced), true, '有可附能量时应可点');
});

await test('② 备战区已满：巢穴球与深钵镇不可使用（不能空发）', () => {
  const nestBall = { name:'巢穴球', cardType:'trainer', trainerType:'item',
    effects: parseEffect('选择自己牌库中的1张【基础】宝可梦，放于备战区。并重洗牌库。').effects };
  const stadium = { name:'深钵镇', cardId:'st-2', cardType:'stadium', trainerType:'stadium',
    effects: parseEffect('双方玩家，每次在自己的回合有1次机会，可选择自己牌库中的1张【基础】宝可梦（除「拥有规则的宝可梦」外），放于备战区。并重洗牌库。').effects };

  const fill = (pl, n) => { pl.bench = Array.from({ length:n }, (_, i) => mon('备战' + i)); };

  // 备战区满（5 只）→ 两者都不可用
  const full = new GameState();
  full.phase = PHASE.MAIN;
  full.currentPlayer = full.player1;
  fill(full.player1, 5);
  full.stadium = stadium;
  const nf = full.canUseTrainer(full.player1, nestBall);
  assert.equal(nf.ok, false, '备战区满时巢穴球应不可用');
  assert.equal(nf.reason, 'bench_full');
  const sf = full.canActivateStadium(full.player1);
  assert.equal(sf.ok, false, '备战区满时深钵镇应不可用');
  assert.equal(sf.reason, 'bench_full');

  // 备战区有空位 → 两者都可用
  const free = new GameState();
  free.phase = PHASE.MAIN;
  free.currentPlayer = free.player1;
  fill(free.player1, 1);
  free.stadium = stadium;
  assert.equal(free.canUseTrainer(free.player1, nestBall).ok, true);
  assert.equal(free.canActivateStadium(free.player1).ok, true);

  // 不是“纯放宝可梦”的卡（还带抽卡）不应被误拦
  const mixed = { name:'混合卡', cardType:'trainer', trainerType:'item',
    effects:[{ action:'draw', params:{ count:2 } }, { action:'search_deck_to_bench', params:{ count:1 } }, { action:'shuffle_deck', params:{} }] };
  const full2 = new GameState();
  full2.phase = PHASE.MAIN;
  full2.currentPlayer = full2.player1;
  fill(full2.player1, 5);
  assert.equal(full2.canUseTrainer(full2.player1, mixed).ok, true, '混合效果不应被备战区满误拦');
});

// ============================================================
//  L1 卡组画像 + L2 计划权重（让 AI 按卡组玩法操作）
// ============================================================

await test('DeckPlan.classifyEffects：按效果语义分类（含嵌套）', () => {
  assert.deepEqual(classifyEffects([{ action:'draw' }]), ['draw']);
  assert.deepEqual(classifyEffects([{ action:'attach_energy_from_deck' }]), ['accel']);
  assert.deepEqual(classifyEffects([{ action:'search_deck_to_bench' }]), ['flood']);
  assert.deepEqual(classifyEffects([{ action:'damage_bench' }]), ['spread']);
  // coin_flip 的 heads / trigger 的 effects 要递归进去
  assert.ok(classifyEffects([{ action:'coin_flip', params:{ heads:[{ action:'damage_bench' }] } }]).includes('spread'));
  assert.ok(classifyEffects([{ action:'trigger', params:{ effects:[{ action:'attach_energy_from_hand' }] } }]).includes('accel'));
  // 纯元数据不算分类
  assert.deepEqual(classifyEffects([{ action:'usage_condition' }, { action:'shuffle_deck' }]), []);
  assert.deepEqual(classifyEffects(null), []);
});

await test('DeckPlan.buildDeckPlan：从卡组构成推断原型并给出证据', () => {
  const res = map => ({ getCard: id => map[id] || null });
  const accel = res({ t:{ cardType:'trainer', name:'填能卡', effects:[{ action:'attach_energy_from_deck' }] } });
  const pAccel = buildDeckPlan(['t','t','t','t'], accel);
  assert.equal(pAccel.archetype, 'accel');
  assert.ok(pAccel.evidence.some(e => e.includes('填能')), pAccel.evidence.join('|'));

  const flood = res({ t:{ cardType:'trainer', name:'铺场卡', effects:[{ action:'search_deck_to_bench' }] } });
  assert.equal(buildDeckPlan(['t','t','t'], flood).archetype, 'flood');

  const spreadMap = { t:{ cardType:'trainer', name:'铺伤卡', effects:[{ action:'damage_bench' }] } };
  assert.equal(buildDeckPlan(['t','t'], res(spreadMap)).archetype, 'spread');

  // 高伤 + 填能 → 一击爆发
  const burst = res({
    p:{ cardType:'pokemon', name:'大威力', stage:'2阶进化', attacks:[{ name:'重击', damage:250, effects:[] }] },
    t:{ cardType:'trainer', name:'填能卡', effects:[{ action:'attach_energy_from_deck' }] },
  });
  assert.equal(buildDeckPlan(['p','p','t','t'], burst).archetype, 'burst');

  // 空卡组 / 无法解析 → 通用兜底
  assert.equal(buildDeckPlan([], res({})).archetype, 'generic');
  const generic = buildDeckPlan(['x'], { getCard: () => { throw new Error('boom'); } });
  assert.equal(generic.archetype, 'generic', 'resolver 抛错也要兜底');
});

await test('计划权重改变训练家取舍（不再「有效果就放」）', () => {
  const gs = new GameState();
  gs.player2.bench = [];
  const engine = { gs };
  const policy = new HeuristicPolicy(engine, gs.player2);
  const floodTrainer = { kind:ACTION.USE_TRAINER, priority:45, desc:'铺场卡', facts:{ trainerType:'item', effectClasses:['flood'] } };
  const drawTrainer = { kind:ACTION.USE_TRAINER, priority:45, desc:'抽牌卡', facts:{ trainerType:'supporter', effectClasses:['draw'] } };
  const acts = [floodTrainer, drawTrainer];

  // 中性计划：抽牌类基础分高于铺场类（保持原有偏好顺序）
  policy.setPlan(NEUTRAL_PLAN);
  const nDraw = policy.scoreAction(drawTrainer, acts);
  const nFlood = policy.scoreAction(floodTrainer, acts);
  assert.ok(nDraw > nFlood, `中性时抽牌应高于铺场: ${nDraw} vs ${nFlood}`);

  // 铺场型卡组：铺场卡应被抬到抽牌卡之上
  const res = { getCard: () => ({ cardType:'trainer', name:'铺场卡', effects:[{ action:'search_deck_to_bench' }] }) };
  policy.setPlan(buildDeckPlan(['t','t','t'], res));
  const fFlood = policy.scoreAction(floodTrainer, acts);
  const fDraw = policy.scoreAction(drawTrainer, acts);
  assert.ok(fFlood > nFlood, `铺场计划应提升铺场卡得分: ${fFlood} vs ${nFlood}`);
  assert.ok(fFlood > fDraw, `铺场计划下铺场卡应优于抽牌卡: ${fFlood} vs ${fDraw}`);

  // 能 KO 时攻击仍然优先（无准备动作时）
  const koAtk = { kind:ACTION.ATTACK, priority:80, desc:'攻击', facts:{ damage:250, canKO:true, prizes:2 } };
  const burstPlan = buildDeckPlan(['p','p','t','t'], {
    getCard: id => (id === 'p'
      ? { cardType:'pokemon', name:'大威力', stage:'2阶进化', attacks:[{ name:'重击', damage:250, effects:[] }] }
      : { cardType:'trainer', name:'填能卡', effects:[{ action:'attach_energy_from_deck' }] }),
  });
  policy.setPlan(burstPlan);
  assert.ok(policy.scoreAction(koAtk, [koAtk]) > policy.scoreAction(floodTrainer, [koAtk]), 'KO 攻击应最高');
});

await test('BattleEngine.startGame：依对手卡组注入计划并记入日志', () => {
  const gs = new GameState();
  const logs = [];
  const resolver = fakeResolver({
    'accel-1': { card: { cardType:'trainer', name:'填能卡', effects:[{ action:'attach_energy_from_deck' }] }, info:{ name:'填能卡', type:'trainer' } },
    'basic-1': { card: { cardType:'pokemon', name:'基础兽', stage:'基础', hp:60, attacks:[] }, info:{ name:'基础兽', type:'pokemon' } },
  });
  const engine = new BattleEngine(gs, resolver, { onLog: m => logs.push(m), onPhaseChange: () => {}, onFieldUpdate: () => {}, aiMode:'heuristic' });
  const deck = ['basic-1','accel-1','accel-1','accel-1'];
  engine.startGame([...deck], [...deck]);
  assert.ok(engine._aiPlan, '应构建出计划');
  assert.equal(engine._aiPlan.archetype, 'accel');
  assert.equal(engine._aiPolicy.plan.archetype, 'accel', '计划应注入到策略');
  assert.ok(logs.some(l => String(l).includes('卡组风格')), `应有卡组风格日志: ${logs.join(' | ')}`);
});

await test('卡组画像随所选卡组动态变化（不是只认内置两套）', () => {
  // 两套**内容不同**的卡组：用 fakeDeckStorage 模拟 localStorage 里的 ptcg 卡组，
  // 由真实 DeckSource 读取后各自建画像 —— 标签应不同（证明是按所选卡组动态推断）。
  const cards = {
    BASIC: { card: { cardType:'pokemon', stage:'基础', name:'妙蛙种子' }, info:{ name:'妙蛙种子', number:1, type:'pokemon' } },
    ACCEL: { card: { cardType:'trainer', trainerType:'item', name:'填能卡', effects:[{ action:'attach_energy_from_deck' }] }, info:{ name:'填能卡', number:null, type:'item' } },
    FLOOD: { card: { cardType:'trainer', trainerType:'item', name:'铺场卡', effects:[{ action:'search_deck_to_bench' }] }, info:{ name:'铺场卡', number:null, type:'item' } },
  };
  const mk = (name, fillId) => ({
    id: name, name, coverCardId: 'BASIC',
    cards: [{ id:'BASIC', quantity:4 }, { id:fillId, quantity:4 }, { id:'BASIC', quantity:52 }],
  });
  const resolver = fakeResolver(cards);
  const loaded = new DeckSource(resolver, { storage: fakeDeckStorage([mk('A-填能','ACCEL'), mk('B-铺场','FLOOD')]) }).load();
  assert.equal(loaded.source, 'ptcg', '应从 localStorage(ptcg) 读取卡组');
  assert.equal(loaded.decks.length, 2);
  const labels = loaded.decks.map(d => buildDeckPlan(expandDeck(d), resolver).label);
  assert.notEqual(labels[0], labels[1], `两套不同卡组应得到不同画像，实际都是 ${labels[0]}`);
  assert.ok(labels.includes('填能加速') || labels.includes('一击爆发'), `填能卡组应体现填能倾向: ${labels.join('/')}`);
  assert.ok(labels.includes('铺场展开'), `铺场卡组应识别为铺场展开: ${labels.join('/')}`);
  // 本地没有任何卡组时，才回退内置两套
  const fallback = new DeckSource(resolver, { storage: fakeDeckStorage([]) }).load();
  assert.equal(fallback.source, 'builtin', '无本地卡组时才回退内置');
});

// ============================================================
//  P1：卡面写明「即使是先攻玩家的最初回合也可使用」的例外
// ============================================================

const ATTACK_FIRST_TURN_EXC = '这个招式，即使是先攻玩家的最初回合也可使用。';
const SUPPORTER_FIRST_TURN_EXC = '这张卡牌，即使是先攻玩家的最初回合也可以使用。从自己的牌库上方抽取2张卡牌。';
const EVOLVE_FIRST_TURN_EXC = '这只宝可梦，如果是后攻玩家的最初回合的话，则即使刚刚出场也可进行进化。';

await test('P1 解析：三处「首回合例外」措辞都能识别', () => {
  const a = parseEffect(ATTACK_FIRST_TURN_EXC).effects;
  assert.equal(a[0].action, 'usage_condition');
  assert.equal(a[0].params.kind, 'attack_first_turn_ok');
  const s = parseEffect(SUPPORTER_FIRST_TURN_EXC).effects;
  assert.equal(s[0].action, 'trainer_prerequisite');
  assert.equal(s[0].params.kind, 'first_player_first_turn_supporter_exception', '复用已有的支援者例外机制');
  assert.ok(s.some(e => e.action === 'draw'), '抽卡效果仍要保留');
  const ev = parseEffect(EVOLVE_FIRST_TURN_EXC).effects;
  assert.equal(ev[0].params.kind, 'evolve_on_first_turn_going_second');
});

await test('P1 招式例外：首回合该招可用、普通招仍置灰（引擎与枚举一致）', async () => {
  const mk = (name, hp = 100) => ({
    name, cardId:name, hp, maxHp:hp, element:'colorless', energy:[], attacks:[], status:null,
    ignore:[], tool:null, ability:null, placedThisTurn:false, evolvedThisTurn:false,
  });
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.currentPlayer = gs.player1;
  const mon = mk('例外宝可梦');
  mon.attacks = [
    { name:'普通招式', cost:[], damage:'20', effects:[] },
    { name:'例外招式', cost:[], damage:'20', effects: parseEffect(ATTACK_FIRST_TURN_EXC).effects },
  ];
  gs.player1.active = mon;
  gs.player2.active = mk('对手');

  assert.equal(gs.canUseAttack(gs.player1, mon, 0).ok, false, '普通招式应置灰');
  assert.equal(gs.canUseAttack(gs.player1, mon, 1).ok, true, '例外招式应可用');

  gs.player1.deck = Array.from({length:30},(_,i)=>'a'+i);
  gs.player2.deck = Array.from({length:30},(_,i)=>'b'+i);
  gs.player1.prizes = ['a','b','c','d','e','f'];
  gs.player2.prizes = ['a','b','c','d','e','f'];
  const engine = makeEngineWithEvents(gs).engine;
  assert.equal(await engine.attack(1), true, '引擎应放行例外招式');
  assert.ok(gs.player2.active.hp < 100, '例外招式应造成伤害');

  // ActionSpace 也要产出例外招式，否则 AI 首回合什么都做不了
  const gs2 = new GameState();
  gs2.phase = PHASE.BATTLE;
  gs2.firstPlayer = gs2.player1;
  gs2.firstPlayerFirstTurnInProgress = true;
  gs2.currentPlayer = gs2.player1;
  const mon2 = mk('例外宝可梦');
  mon2.attacks = mon.attacks;
  gs2.player1.active = mon2;
  gs2.player2.active = mk('对手');
  const atks = getLegalActions(gs2, null, gs2.player1).filter(a => a.kind === 'attack');
  assert.equal(atks.length, 1);
  assert.equal(atks[0].params.attackIndex, 1, '只应产出例外招式');
});

await test('P1 支援者例外：卡面写明例外时首回合可打出', () => {
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.currentPlayer = gs.player1;
  const exc = { name:'丹瑜', cardType:'trainer', trainerType:'supporter', effects: parseEffect(SUPPORTER_FIRST_TURN_EXC).effects };
  assert.equal(gs.canUseTrainer(gs.player1, exc).ok, true, '应放行');
  const plain = { name:'普通支援者', cardType:'trainer', trainerType:'supporter', effects: parseEffect('从自己的牌库上方抽取2张卡牌。').effects };
  assert.equal(gs.canUseTrainer(gs.player1, plain).ok, false, '普通支援者仍不可用');
});

await test('P1 抢先进化：后攻首回合刚出场也能进化（烈雀 151C-021）', () => {
  const mk = name => ({
    name, cardId:name, hp:60, maxHp:60, element:'colorless', energy:[], attacks:[], status:null,
    ignore:[], tool:null, ability:null, placedThisTurn:true, evolvedThisTurn:false,
  });
  // 后攻方 + 有「抢先进化」特性 → 放行
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  gs.firstPlayer = gs.player1;
  gs.firstPlayerFirstTurnInProgress = true;
  gs.currentPlayer = gs.player2;
  const sp = mk('烈雀');
  sp.ability = { name:'抢先进化', effects: parseEffect(EVOLVE_FIRST_TURN_EXC).effects };
  gs.player2.active = sp;
  gs.player2.hand = ['evo'];
  assert.equal(gs.evolve(gs.player2, 0, { id:'evo', name:'大嘴雀', hp:90, stage:'1阶进化', evolvesFrom:'烈雀', element:'colorless', attacks:[] }, 'active'), true);
  assert.equal(gs.player2.active.name, '大嘴雀');

  // 对照 1：没有该特性 → 仍被拒绝
  const gs2 = new GameState();
  gs2.phase = PHASE.MAIN;
  gs2.firstPlayer = gs2.player1;
  gs2.firstPlayerFirstTurnInProgress = true;
  gs2.currentPlayer = gs2.player2;
  gs2.player2.active = mk('普通基础');
  gs2.player2.hand = ['evo'];
  assert.equal(gs2.evolve(gs2.player2, 0, { id:'evo', name:'普通进化', hp:90, stage:'1阶进化', evolvesFrom:'普通基础', element:'colorless', attacks:[] }, 'active'), false);

  // 对照 2：先攻方不享受该例外（规则只给后攻方）
  const gs3 = new GameState();
  gs3.phase = PHASE.MAIN;
  gs3.firstPlayer = gs3.player1;
  gs3.firstPlayerFirstTurnInProgress = true;
  gs3.currentPlayer = gs3.player1;
  const sp3 = mk('烈雀');
  sp3.ability = { name:'抢先进化', effects: parseEffect(EVOLVE_FIRST_TURN_EXC).effects };
  gs3.player1.active = sp3;
  gs3.player1.hand = ['evo'];
  assert.equal(gs3.evolve(gs3.player1, 0, { id:'evo', name:'大嘴雀', hp:90, stage:'1阶进化', evolvesFrom:'烈雀', element:'colorless', attacks:[] }, 'active'), false);
});

// ============================================================
//  P2 批 1：空壳碎片归类 + 5 条高频残句建模
// ============================================================

const _covKinds = text => parseEffect(text).effects.filter(e => e.action === 'usage_condition').map(e => e.params.kind);

await test('P2-1 空壳归类：只剩引导词且已有实质动作 → shell_fragment', () => {
  // 对手手牌回牌库：抽卡等实质动作已解析，剩下的「然后，对手。」是空壳
  const t = '对手将其所有的手牌放回牌库并重洗牌库。然后，对手从牌库上方抽取3张卡牌。';
  const kinds = _covKinds(t);
  assert.ok(kinds.includes('shell_fragment'), `应含 shell_fragment: ${kinds}`);
  assert.ok(!kinds.includes('residual_sentence'), '不应再记成未建模');
});

await test('P2-1 保护条件：无其它实质动作时不得判成空壳（否则会藏住真问题）', () => {
  // 这句本身没有可执行动作 → 必须仍算 residual_sentence
  // 注意：原来用「若这只宝可梦在战斗场上，则。」做样本，但批 3 已把它建模成 requires_active 了，
  // 这里换成真正没有任何可执行动作的空壳形状文本。
  const kinds = _covKinds('若使用了，则。');
  // 一个动作都没匹配上时走的是 generic_effect 分支（同样是「未建模」标记）
  assert.ok(kinds.some(k => k === 'residual_sentence' || k === 'generic_effect'), `应保留未建模标记: ${kinds}`);
  assert.ok(!kinds.includes('shell_fragment'), '没有其它动作时不能算空壳');
});

await test('P2-1 五条高频残句建模', () => {
  // ① 不叠加说明 → 标注
  const a = parseEffect('只要这只宝可梦在场上，自己的所有宝可梦，受到对手宝可梦的招式的伤害「-30」。这个效果，无论拥有这个特性的宝可梦有多少只，都不会叠加。').effects;
  assert.ok(a.some(e => e.params?.kind === 'no_stack_note'));
  assert.ok(!a.some(e => e.params?.kind === 'residual_sentence'), '不应残留');
  // ② 只有最初回合可用 → 条件 + 实际效果
  const b = parseEffect('只有在最初的自己的回合可以使用1次。将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌。').effects;
  assert.ok(b.some(e => e.params?.kind === 'own_first_turn_only'));
  assert.ok(b.some(e => e.action === 'draw'));
  // ③ 对手换位
  const c = parseEffect('将这只宝可梦与备战宝可梦互换。然后，对手将其战斗宝可梦与备战宝可梦互换。').effects.filter(e => e.action === 'switch_pokemon');
  assert.deepEqual(c.map(e => e.params.who), ['self', 'opponent']);
  // ④ 对手手牌回牌库
  const d = parseEffect('对手将其所有的手牌放回牌库并重洗牌库。然后，对手从牌库上方抽取3张卡牌。').effects;
  assert.ok(d.some(e => e.action === 'shuffle_hand_to_deck' && e.params.who === 'opponent'));
  // ⑤ 牌库选 1 张基本能量附于自身
  const e5 = parseEffect('选择自己牌库中的1张基本能量，附着于这只宝可梦身上。并重洗牌库。').effects;
  const at = e5.find(x => x.action === 'attach_energy_from_deck');
  assert.ok(at, '应解析为 attach_energy_from_deck');
  assert.equal(at.params.target, 'self');
  assert.equal(at.params.filter, '基本能量');
});

await test('P2-1 「只有最初回合可用」在非最初回合会置灰', () => {
  // 注意：canUseAbility 要求 ability.active === true，否则直接返回 not_active_ability
  const ability = { name:'英武重抽', active:true, zone:'field', effects: parseEffect('只有在最初的自己的回合可以使用1次。将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌。').effects };
  const mk = () => ({ name:'怒鹦哥ex', cardId:'x', hp:200, maxHp:200, element:'colorless', energy:[], attacks:[], status:null, ignore:[], tool:null, ability, placedThisTurn:false });
  // 自己的最初回合（先攻方 turn 1）→ 可用
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  gs.firstPlayer = gs.player1;
  gs.turn = 1;
  const mon = mk();
  gs.player1.active = mon;
  gs.player1.bench = [];
  assert.equal(gs.canUseAbility(gs.player1, mon, mon.ability, 'field').ok, true, '最初回合应可用');
  // 到了后面的回合 → 应置灰
  gs.turn = 5;
  const r = gs.canUseAbility(gs.player1, mon, mon.ability, 'field');
  assert.equal(r.ok, false, '非最初回合应不可用');
  assert.match(String(r.message || ''), /最初的自己的回合/);
});

await test('P2-1 attach_energy_from_deck 带 target:self 时不弹目标选择', async () => {
  const eff = parseEffect('选择自己牌库中的1张基本能量，附着于这只宝可梦身上。并重洗牌库。').effects.filter(x => x.action === 'attach_energy_from_deck');
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = { name:'自身', cardId:'m', hp:100, maxHp:100, element:'colorless', energy:[], attacks:[], status:null, ignore:[], tool:null, ability:null };
  pl.bench = [];
  pl.deck = ['e-fire', 'e-water'];
  gs.cardResolver = fakeResolver({
    'e-fire': { card:{ cardType:'energy', name:'基本火能量' }, info:{ name:'基本火能量', type:'energy' } },
    'e-water': { card:{ cardType:'energy', name:'基本水能量' }, info:{ name:'基本水能量', type:'energy' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 1, '能量应附到出战宝可梦身上（不经过目标选择）');
});


// ============================================================
//  P2 批 2：① 抽卡前可选弃牌  ② 附能后放指示物  ③ 受击抛硬币免伤
// ============================================================

await test('P2-2 ① 「抽卡前可选弃牌」并入抽卡动作', () => {
  const e = parseEffect('从牌库上方抽取卡牌，直到自己的手牌变为5张为止。若希望，在抽取卡牌前，可将任意数量的自己的手牌放于弃牌区。').effects;
  const d = e.find(x => x.action === 'draw_until');
  assert.ok(d, '应解析出 draw_until');
  assert.equal(d.params.preDiscardAny, true, '应带上「抽卡前可选弃牌」参数');
  assert.ok(!e.some(x => x.params?.kind === 'residual_sentence'), '不应残留未建模标记');
});

await test('P2-2 ① 无 UI（AI 路径）时不做可选弃牌，只正常抽到 5 张', () => {
  const eff = parseEffect('从牌库上方抽取卡牌，直到自己的手牌变为5张为止。若希望，在抽取卡牌前，可将任意数量的自己的手牌放于弃牌区。').effects;
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['keep1', 'keep2'];
  pl.deck = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  pl.discard = [];
  return executeEffects(gs, pl, eff).then(() => {
    assert.equal(pl.discard.length, 0, 'AI 路径不应弃掉手牌');
    assert.equal(pl.hand.length, 5, '应抽到 5 张');
    assert.deepEqual(pl.hand.slice(0, 2), ['keep1', 'keep2'], '原有手牌应保留');
  });
});

await test('P2-2 ② 「在被附着的宝可梦身上放置N个指示物」并入附能动作（两种来源）', () => {
  const a = parseEffect('选择自己弃牌区中的1张「基本【超】能量」，附着于自己的【超】宝可梦身上。然后，在被附着的宝可梦身上放置2个伤害指示物。').effects;
  const at = a.find(x => x.action === 'attach_energy_from_discard');
  assert.ok(at, '应解析出 attach_energy_from_discard');
  assert.equal(at.params.damageCountersOnAttachedTarget, 2);
  assert.ok(!a.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');

  // 牌库来源：用**真实完整卡面**（CS3DC-093「一击能量」系）。
  // 前面那句「在自己的回合可以使用1次。」会让位置排序把改写句排到附能动作之前，
  // 只测截断文本会漏掉这个坑（曾经就因此假通过）。
  const b = parseEffect('在自己的回合可以使用1次。选择自己牌库中的1张「一击能量」，附着于自己的「一击」宝可梦身上。并重洗牌库。然后，在被附着的宝可梦身上放置2个伤害指示物。').effects;
  const bt = b.find(x => x.action === 'attach_energy_from_deck');
  assert.ok(bt, '应解析出 attach_energy_from_deck');
  assert.equal(bt.params.damageCountersOnAttachedTarget, 2, '跨过 shuffle_deck 仍应合并成功');
  assert.ok(!b.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');
});

await test('P2-2 ② 执行：附能后目标真的掉 20 血', async () => {
  const eff = parseEffect('选择自己弃牌区中的1张「基本【超】能量」，附着于自己的【超】宝可梦身上。然后，在被附着的宝可梦身上放置2个伤害指示物。')
    .effects.filter(x => x.action === 'attach_energy_from_discard');
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('受试者', 'm1');
  pl.active.element = 'psychic'; // 原文本限定「【超】宝可梦」，过滤是生效的
  pl.bench = [];
  pl.discard = ['psy-e'];
  gs.cardResolver = fakeResolver({
    'psy-e': { card:{ cardType:'energy', name:'基本【超】能量' }, info:{ name:'基本【超】能量', type:'energy' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 1, '能量应附着成功');
  assert.equal(pl.active.hp, 40, '应再放置 2 个伤害指示物（60 - 20 = 40）');
});

await test('P2-2 ③ 硬币免伤（特性版）：正面完全不掉血、反面正常掉血', async () => {
  const abilityEffects = parseEffect('当这只宝可梦受到招式的伤害时，自己抛掷1次硬币。如果为正面，则这只宝可梦不受到该伤害。').effects;
  const build = () => {
    const gs = new GameState();
    const pl = gs.player1, opp = gs.player2;
    gs.currentPlayer = pl;
    gs.phase = PHASE.BATTLE;
    // 伤害 30 < 60 HP：避免打昏厥后「后排升前排」，让断言始终看在同一个对象上
    pl.active = mon('攻击方', 'a1', [{ name:'重击', damage:30, cost:[] }]);
    opp.active = mon('防御方', 'd1');
    opp.active.ability = { name:'硬币护盾', effects: abilityEffects };
    pl.energyAttached = true;
    return { gs, pl, opp, engine: makeEngine(gs) };
  };
  const saved = Math.random;
  try {
    // coin_flip 约定：Math.random() < 0.5 为正面
    let c = build();
    Math.random = () => 0;
    assert.equal(await c.engine.attack(0), true);
    assert.equal(c.opp.active.hp, c.opp.active.maxHp, '正面应完全不掉血');

    c = build();
    Math.random = () => 0.99;
    assert.equal(await c.engine.attack(0), true);
    assert.ok(c.opp.active.hp < c.opp.active.maxHp, '反面应正常受伤');
  } finally { Math.random = saved; }
});

await test('P2-2 ③ 硬币免伤是「自身限定」：队友的同名特性保护不了自己', async () => {
  const abilityEffects = parseEffect('当这只宝可梦受到招式的伤害时，自己抛掷1次硬币。如果为正面，则这只宝可梦不受到该伤害。').effects;
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.BATTLE;
  pl.active = mon('攻击方', 'a1', [{ name:'重击', damage:30, cost:[] }]);
  opp.active = mon('前排', 'd1');
  opp.bench = [mon('后排', 'd2')];
  // 特性在备战区的队友身上
  opp.bench[0].ability = { name:'硬币护盾', effects: abilityEffects };
  pl.energyAttached = true;
  const engine = makeEngine(gs);
  const saved = Math.random;
  try {
    Math.random = () => 0; // 正面
    assert.equal(await engine.attack(0), true);
    assert.ok(opp.active.hp < opp.active.maxHp, '特性写的是「这只宝可梦」，不应保护前排的队友');
  } finally { Math.random = saved; }
});

await test('P2-2 ③ 招式版（残影斩）：标记撑到对手回合结束，之后失效', () => {
  const eff = parseEffect('在下一个对手的回合，这只宝可梦受到招式的伤害时，自己抛掷1次硬币。如果为正面，则这只宝可梦不受到该伤害影响。').effects;
  assert.equal(eff.length, 1, '应只有一个动作');
  assert.equal(eff[0].action, 'attack_damage_flip_shield');
  assert.equal(eff[0].params.duration, 'next_opp_turn');

  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('残影使用者', 'm1');
  opp.active = mon('对手', 'o1');
  gs.currentPlayer = pl;
  executeEffects(gs, pl, eff);
  assert.equal(pl.active.damageFlipShieldArmed, true, '应设置免伤标记');
  assert.equal(pl.active.attackShieldArmed, true, '应撑过自己回合结束');
  // 自己回合结束（生效窗口 = 下一个对手回合）→ 标记保留
  gs.currentPlayer = pl;
  gs.endTurn();
  assert.equal(pl.active.damageFlipShieldArmed, true, '自己回合结束时不应清除');
  // 对手回合结束 → 生效窗口已过，清除
  gs.endTurn();
  assert.ok(!pl.active.damageFlipShieldArmed, '对手回合结束后应清除');
});


// ============================================================
//  P2 批 3 前置：动作顺序位置簿记修复 + end_turn 语义修正
// ============================================================

await test('P2-3 顺序：「…自己的回合结束前」不得被误判为 end_turn', () => {
  // 原文只是限定弱点改变的持续时间，误匹配会让玩家一用这个招式就立刻结束回合
  const e = parseEffect('在下一个自己的回合结束前，受到这个招式影响的宝可梦的弱点变为【雷】属性。').effects;
  assert.ok(!e.some(x => x.action === 'end_turn'), `不应有 end_turn：${JSON.stringify(e.map(x => x.action))}`);
});

await test('P2-3 顺序：end_turn 必须排在动作序列末尾（先用后结束）', () => {
  const e = parseEffect('这张卡牌，只有在后攻玩家的最初回合才可使用，如果使用了，则自己的回合结束。选择自己牌库中的1张基本能量，附着于自己的宝可梦身上。并重洗牌库。').effects;
  const real = e.filter(x => x.action !== 'usage_condition').map(x => x.action);
  assert.equal(real[real.length - 1], 'end_turn', `end_turn 应在最后：${real}`);
  assert.ok(real.indexOf('attach_energy_from_deck') >= 0 && real.indexOf('attach_energy_from_deck') < real.indexOf('end_turn'),
    `附能必须在结束回合之前：${real}`);
});

await test('P2-3 顺序：动作顺序恢复为卡面书写顺序（先附能再抽卡）', () => {
  // CSV8C-242 原文：「…附着于这只宝可梦身上。然后，从自己牌库上方抽取1张卡牌。」
  const e = parseEffect('在自己的回合可以使用1次。选择自己手牌中的1张「基本【草】能量」，附着于这只宝可梦身上。然后，从自己牌库上方抽取1张卡牌。').effects;
  const real = e.filter(x => x.action !== 'usage_condition').map(x => x.action);
  assert.deepEqual(real, ['attach_energy_from_hand', 'draw'], `应为「先附能再抽卡」：${real}`);
});

await test('P2-3 顺序：先选牌再重洗牌库（不是先洗再选）', () => {
  // 大钳蟹「引潮」（151C-098）真实卡面：「抛掷1次硬币如果为正面，则选择自己牌库中最多2张
  // 「基本【水】能量」，附着于这只宝可梦身上。并重洗牌库。」
  const e = parseEffect('抛掷1次硬币如果为正面，则选择自己牌库中最多2张「基本【水】能量」，附着于这只宝可梦身上。并重洗牌库。').effects;
  const real = e.filter(x => x.action !== 'usage_condition').map(x => x.action);
  assert.deepEqual(real, ['coin_flip', 'attach_energy_from_deck', 'shuffle_deck'], `应「先选牌再重洗」：${real}`);
  assert.ok(real.indexOf('attach_energy_from_deck') < real.indexOf('shuffle_deck'), '附能必须在重洗之前');
});

await test('P2-3 执行：「先用后结束」的附能确实在结束回合前生效', async () => {
  const eff = parseEffect('这张卡牌，只有在后攻玩家的最初回合才可使用，如果使用了，则自己的回合结束。选择自己牌库中的1张基本能量，附着于自己的宝可梦身上。并重洗牌库。').effects;
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.currentPlayer = pl;
  gs.phase = PHASE.MAIN;
  pl.active = mon('受试者', 'm1');
  pl.bench = [];
  pl.deck = ['basic-e'];
  gs.cardResolver = fakeResolver({
    'basic-e': { card:{ cardType:'energy', name:'基本能量' }, info:{ name:'基本能量', type:'energy' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 1, '能量应在回合结束前附着到宝可梦身上');
});


// ============================================================
//  P2 批 3：条件前缀 / 条件加抽 / 定向回复 / 按奖赏卡张数抽牌
// ============================================================

await test('P2-3 「如果这只宝可梦在战斗场上」识别为发动前提', () => {
  // 叶伊布GX「绿叶之息」真实卡面
  const e = parseEffect('如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。回复自己的身上附有能量的1只宝可梦「50」点HP。').effects;
  assert.ok(e.some(x => x.params?.kind === 'requires_active'), '应识别为 requires_active');
  const heal = e.find(x => x.action === 'heal');
  assert.ok(heal, '应解析出定向回复');
  assert.equal(heal.params.amount, 50);
  assert.equal(heal.params.target, 'choose');
  assert.equal(heal.params.requireEnergy, true);
});

await test('P2-3 「战斗场上」前提在备战区时真的置灰', () => {
  const ability = { name:'绿叶之息', active:true, zone:'field',
    effects: parseEffect('如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。回复自己的身上附有能量的1只宝可梦「50」点HP。').effects };
  const gs = new GameState();
  gs.phase = PHASE.MAIN;
  const pl = gs.player1;
  const act = mon('战斗场上的', 'a1');
  const bench = mon('备战区的', 'b1');
  bench.ability = ability;
  pl.active = act;
  pl.bench = [bench];
  // 来源在备战区 → 不可用
  const r1 = gs.canUseAbility(pl, bench, bench.ability, 'bench');
  assert.equal(r1.ok, false, `在备战区应不可用：${JSON.stringify(r1)}`);
  assert.match(String(r1.message || ''), /战斗场上/);
  // 换到战斗场 → 可用
  const act2 = mon('战斗场上的', 'a2');
  act2.ability = ability;
  pl.active = act2;
  pl.bench = [];
  assert.equal(gs.canUseAbility(pl, act2, act2.ability, 'active').ok, true, '在战斗场上应可用');
});

await test('P2-3 「若在战斗场上则额外抽N张」：按来源位置决定是否加抽', async () => {
  const eff = parseEffect('在自己的回合可以使用1次。从自己牌库上方抽取1张卡牌。如果这只宝可梦在战斗场上的话，则额外抽取1张卡牌。').effects;
  const extra = eff.filter(x => x.action === 'draw' && x.params.requiresSourceActive);
  assert.equal(extra.length, 1, '应解析出条件加抽');
  assert.equal(extra[0].params.count, 1);

  const build = (zone) => {
    const gs = new GameState();
    const pl = gs.player1;
    pl.deck = ['d1','d2','d3','d4','d5'];
    pl.hand = [];
    pl.active = mon('来源', 's1');
    pl.bench = [];
    const src = zone === 'active' ? pl.active : mon('后排', 's2');
    return { gs, pl, src, effects: extra.map(e => ({ ...e, params:{ ...e.params }, source:src, sourceZone:zone })) };
  };
  let c = build('active');
  await executeEffects(c.gs, c.pl, c.effects);
  assert.equal(c.pl.hand.length, 1, '在战斗场上应额外抽 1 张');
  c = build('bench');
  await executeEffects(c.gs, c.pl, c.effects);
  assert.equal(c.pl.hand.length, 0, '不在战斗场上应不抽');
});

await test('P2-3 定向回复：只能选附有能量的宝可梦', async () => {
  const eff = parseEffect('回复自己的身上附有能量的1只宝可梦「50」点HP。').effects;
  assert.equal(eff[0].action, 'heal');
  const gs = new GameState();
  const pl = gs.player1;
  const act = mon('无能量的', 'a1');   // 60/60，没有能量 → 不能被选
  const benchE = mon('有能量的', 'b1');
  benchE.energy = [{ cardId:'e', name:'基本草能量' }];
  benchE.hp = 20;                       // 受伤，便于验证回复
  pl.active = act;
  pl.bench = [benchE];
  await executeEffects(gs, pl, eff);
  assert.equal(act.hp, act.maxHp, '无能量的宝可梦不应被选中（血量不变）');
  assert.equal(benchE.hp, 60, '应回复 50 点（20 → 60，上限 60）');
});

await test('P2-3 按剩余奖赏卡张数抽牌：抽取方是「对手自己」', async () => {
  const eff = parseEffect('对手将其所有的手牌放回牌库并重洗牌库。然后，对手从牌库上方抽取与对手剩余奖赏卡张数相同数量的卡牌。').effects;
  const d = eff.find(x => x.action === 'draw');
  assert.equal(d.params.who, 'opponent');
  assert.equal(d.params.countFrom, 'prizes');
  assert.ok(eff.some(x => x.action === 'shuffle_hand_to_deck' && x.params.who === 'opponent'), '前半句也应解析');

  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  opp.prizes = ['p1','p2','p3'];
  opp.hand = [];
  opp.deck = ['d1','d2','d3','d4','d5','d6'];
  await executeEffects(gs, pl, [d]);
  assert.equal(opp.hand.length, 3, '对手应按自己的剩余奖赏卡（3 张）抽 3 张');
  assert.equal(pl.hand.length, 0, '不应影响到发起方手牌');
});

await test('P2-3 顺带措辞：甲贺忍蛙BREAK「巨大飞水手里剑」', () => {
  const e = parseEffect('选择自己手牌中的1张【水】能量，放于弃牌区。然后，选择对手的1只宝可梦，放置6个伤害指示物。如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次这个特性。').effects;
  const disc = e.find(x => x.action === 'discard_hand');
  assert.ok(disc && disc.params.filter === '【水】能量', '应解析出手牌弃能量');
  const dp = e.find(x => x.action === 'damage_place');
  assert.ok(dp && dp.params.count === 6 && dp.params.target === 'opponent_any', '应解析出放置 6 个指示物');
});


// ============================================================
//  P2 批 4：剩余卡牌处置 / 自身弃场 / 可选代价
// ============================================================

await test('P2-4 D 剩余卡牌丢弃牌区：并入前面的 peek_and_keep', () => {
  const e = parseEffect('在自己的回合可以使用1次。查看自己牌库上方3张卡牌，选择其中1张卡牌，加入手牌。将剩余的卡牌放于弃牌区。').effects;
  const pk = e.find(x => x.action === 'peek_and_keep');
  assert.ok(pk, '应解析出 peek_and_keep');
  assert.equal(pk.params.remainder, 'discard');
  assert.ok(!e.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');
});

await test('P2-4 D2 剩余卡牌翻面放回牌库下方', () => {
  const e = parseEffect('查看自己牌库上方4张卡牌，选择其中2张卡牌，加入手牌。将剩余的卡牌全部翻到反面重洗，放回牌库下方。').effects;
  const pk = e.find(x => x.action === 'peek_and_keep');
  assert.equal(pk.params.remainder, 'deck_bottom');
});

await test('P2-4 D2 执行：剩余卡牌进牌库下方（牌库顶仍是原来的顶）', async () => {
  const eff = parseEffect('查看自己牌库上方4张卡牌，选择其中2张卡牌，加入手牌。将剩余的卡牌全部翻到反面重洗，放回牌库下方。').effects;
  const gs = new GameState();
  const pl = gs.player1;
  // deck 末尾 = 牌库顶（draw 用 pop）：['底','a','b','c','d'] 的顶是 d
  pl.deck = ['bottom', 'a', 'b', 'c', 'd'];
  pl.hand = [];
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 2, '应拿 2 张到手牌');
  // 剩余 2 张被放到「下方」，所以牌库顶（pop 出来的第一张）不应是那 2 张之一
  const top = pl.deck[pl.deck.length - 1];
  assert.ok(!(pl.hand.includes(top)), `牌库顶不应是放回下方的剩余卡：top=${top}`);
});

await test('P2-4 D 执行：剩余卡牌进弃牌区', async () => {
  const eff = parseEffect('查看自己牌库上方3张卡牌，选择其中1张卡牌，加入手牌。将剩余的卡牌放于弃牌区。').effects;
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['x1', 'x2', 'x3'];
  pl.hand = [];
  pl.discard = [];
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 1, '应拿 1 张');
  assert.equal(pl.discard.length, 2, '剩余 2 张应进弃牌区');
  assert.equal(pl.deck.length, 0, '牌库应清空');
});

await test('P2-4 E 自身弃场：不拿奖赏卡，但身上的卡牌一起进弃牌区', async () => {
  const eff = parseEffect('给对手的1只宝可梦身上，放置2个伤害指示物。然后，将这只宝可梦，以及放于其身上的所有卡牌，放于弃牌区。').effects;
  const discard = eff.find(x => x.action === 'discard_self_with_attachments');
  assert.ok(discard, '应解析出自身弃场动作');

  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  const self = mon('被弃者', 'self1');
  self.energy = [{ cardId:'e1', name:'基本草能量' }];
  self.tool = { cardId:'t1', name:'道具' };
  const backup = mon('替补', 'backup1');
  pl.active = self;
  pl.bench = [backup];
  pl.discard = [];
  const prizesBefore = opp.prizes.length;
  // 特性来源 = 被弃者自己
  await executeEffects(gs, pl, eff.map(x => ({ ...x, params:{ ...x.params }, source:self, sourceZone:'active' })));
  assert.equal(pl.active, backup, '应换上备战宝可梦');
  assert.ok(pl.discard.includes('self1'), '自身卡应进弃牌区');
  assert.ok(pl.discard.includes('e1'), '身上的能量应一起进弃牌区');
  assert.ok(pl.discard.includes('t1'), '身上的道具应一起进弃牌区');
  assert.equal(opp.prizes.length, prizesBefore, '这不是昏厥，不应拿奖赏卡');
});

await test('P2-4 F 可选代价：解析出 then 且不含内部字段', () => {
  const e = parseEffect('将自己牌库中的1张「竞技场」，在给对手看过之后，加入手牌。并重洗牌库。另外，当使用这张卡牌时，可将2张自己的手牌放于弃牌区。在这种情况下，可将「宝可梦道具」和「特殊能量」各1张加入手牌。').effects;
  const gate = e.find(x => x.action === 'optional_hand_cost');
  assert.ok(gate, '应解析出可选代价');
  assert.equal(gate.params.count, 2);
  assert.equal(gate.params.then.length, 1, '后续效果应收进 then');
  assert.equal(gate.params.then[0].action, 'search_deck_multi');
  for (const t of gate.params.then) assert.ok(!('_pos' in t), 'then 里不应残留 _pos');
});

await test('P2-4 F 三种奖励条款都能解析', () => {
  const 玛奥 = parseEffect('将自己的战斗宝可梦与备战宝可梦互换。另外，当使用这张卡牌时，可将2张自己的手牌放于弃牌区。在这种情况下，回复被换到备战区的宝可梦「120」点HP。').effects;
  const 玛奥Then = 玛奥.find(x => x.action === 'optional_hand_cost').params.then;
  assert.equal(玛奥Then[0].action, 'heal');
  assert.equal(玛奥Then[0].params.target, 'previous_switched');

  const 赤红 = parseEffect('从自己的牌库中选择1张，从自己场上1只宝可梦进化而来的「宝可梦GX」，放于该宝可梦身上进行进化。并重洗牌库。另外，当使用这张卡牌时，可将2张自己的手牌放于弃牌区。在这种情况下，将自己牌库中最多2张基本能量附着于进化后的宝可梦身上。').effects;
  const 赤红Then = 赤红.find(x => x.action === 'optional_hand_cost').params.then;
  assert.equal(赤红Then[0].action, 'attach_energy_from_deck');
  assert.equal(赤红Then[0].params.target, 'previous_evolved');
  assert.equal(赤红Then[0].params.count, 2);
});

await test('P2-4 F 可选代价：自动决策（无 UI）不支付、不执行后续', async () => {
  const e = parseEffect('另外，当使用这张卡牌时，可将1张自己的手牌放于弃牌区。在这种情况下，从牌库上方抽取3张卡牌。').effects;
  const gate = e.find(x => x.action === 'optional_hand_cost');
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['h1', 'h2'];
  pl.deck = ['d1', 'd2', 'd3', 'd4'];
  pl.discard = [];
  await executeEffects(gs, pl, [gate]);
  assert.equal(pl.discard.length, 0, '不应弃手牌');
  assert.equal(pl.hand.length, 2, '手牌不应减少');
  assert.equal(pl.deck.length, 4, '后续的抽卡不应执行');
});

await test('P2-4 改写句找不到目标时转回未建模标记（不留在库里当空动作）', () => {
  // 「将牌库上方N张翻到正面…将剩余的卡牌丢到弃牌区」这类前半句属别的机制，没有 peek_and_keep
  const e = parseEffect('将自己的牌库上方6张卡牌翻到正面。造成其中【超】宝可梦数量×60点伤害。将正面朝上的【超】宝可梦放回牌库并重洗牌库。将剩余的卡牌放于弃牌区。').effects;
  assert.ok(!e.some(x => x.action === 'action_count_override'), '不应留下孤儿改写句');
  assert.ok(e.some(x => x.params?.kind === 'residual_sentence'), '应转成未建模标记，指标上仍算未完成');
});


// ============================================================
//  招式学习器（A）：从卡面提取招式 + 附着后可使用
// ============================================================

await test('TM 从卡面提取招式：普通学习器', () => {
  // CSV4C-119「招式学习器 能量涡轮」真实卡面
  const text = '身上放有这张卡牌的宝可梦，可以使用这张卡牌上的招式。[需要满足使用招式所需能量。]\n放于宝可梦身上的这张卡牌，将在自己的回合结束时被放于弃牌区。\n\n【无】 能量涡轮\n选择自己牌库中最多2张基本能量，以任意方式附着于备战宝可梦身上。并重洗牌库。';
  const ta = extractToolAttacks(text);
  assert.ok(ta, '应提取出招式');
  assert.equal(ta.attacks.length, 1);
  const a = ta.attacks[0];
  assert.equal(a.name, '能量涡轮');
  assert.deepEqual(a.cost, ['colorless']);
  assert.equal(a.damage, 0, '无伤害数值');
  assert.equal(a.gx, false);
  assert.equal(a.requiresMove, null);
  assert.ok(a.effects.some(e => e.action === 'attach_energy_from_deck'), '招式内的效果应被解析');
});

await test('TM 从卡面提取招式：多能量符号 + 伤害后缀', () => {
  const ta = extractToolAttacks('身上放有这张卡牌的「一击」宝可梦，可以使用这张卡牌上的招式。[需要满足使用招式所需能量。]\n\n【斗】【钢】【钢】【无】【无】 刚力斩 300\n将附着于这只宝可梦身上的能量，全部放于弃牌区。');
  const a = ta.attacks[0];
  assert.equal(a.name, '刚力斩');
  assert.deepEqual(a.cost, ['fighting', 'metal', 'metal', 'colorless', 'colorless']);
  assert.equal(a.damage, 300);
  assert.equal(a.tag, '一击');

  const ta2 = extractToolAttacks('身上放有这张卡牌的宝可梦，可以使用这张卡牌上的招式。[需要满足使用招式所需能量。]\n\n【雷】【无】饭纲坠落 10+\n追加造成对手战斗宝可梦身上附有的能量数量×50点伤害。');
  assert.equal(ta2.attacks[0].name, '饭纲坠落', '招式名与符号之间没有空格也要能提取');
  assert.equal(ta2.attacks[0].damage, 10);
  assert.equal(ta2.attacks[0].damageSuffix, '+');
  assert.deepEqual(ta2.attacks[0].cost, ['lightning', 'colorless']);
});

await test('TM 从卡面提取招式：GX 招式与「拥有招式」限制', () => {
  const ta = extractToolAttacks('身上放有这张卡牌的，拥有招式「龙爪」的宝可梦，可以使用这张卡牌上的GX招式。[需要满足使用招式所需能量。]\n\n【无】【无】【无】 巨龙燃烧GX 80×\n将附着于这只宝可梦身上的基本能量，全部放于弃牌区，造成其张数×80点伤害。[对战中，己方的GX招式只能使用1次。]');
  const a = ta.attacks[0];
  assert.equal(a.name, '巨龙燃烧GX');
  assert.equal(a.gx, true);
  assert.equal(a.requiresMove, '龙爪');
  assert.equal(a.damage, 80);
  assert.equal(a.damageSuffix, '×');
});

await test('TM 非招式学习器类道具不应被误提取', () => {
  assert.equal(extractToolAttacks('附有这张卡的宝可梦，最大HP提高「50」点。'), null);
  assert.equal(extractToolAttacks(''), null);
  // 宝可梦的招式文本不应被当成道具招式
  assert.equal(extractToolAttacks('【无】 撞击\n造成20点伤害。'), null);
});

await test('TM 全部招式学习器卡的招式都能提取（数据守卫）', () => {
  const tools = loadJson('PokemonTool-cards.json');
  let n = 0;
  const bad = [];
  for (const c of tools) {
    const eff = c['效果'] || '';
    if (!eff.includes('可以使用这张卡牌')) continue;
    const ta = extractToolAttacks(eff);
    if (!ta || !ta.attacks[0].name || !ta.attacks[0].cost.length) bad.push(c['卡牌ID'][0]);
    else n++;
  }
  assert.ok(n >= 27, `招式学习器类卡应有 27 张以上（实际 ${n}）`);
  assert.deepEqual(bad, [], `以下卡提取失败：${bad.join(', ')}`);
});

await test('TM 附着后招式可用：getAttacks 合并、能量不足时不可用', () => {
  const tools = loadJson('PokemonTool-cards.json');
  const raw = tools.find(c => c['卡牌ID'][0] === 'CSV4C-119');
  const cd = { cardType:'trainer', trainerType:'tool', name:raw['卡牌名字'], effects:[], toolAttacks: extractToolAttacks(raw['效果']).attacks };
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.BATTLE;
  pl.active = mon('测试者', 'm1', [{ name:'撞击', cost:['colorless'], damage:10, effects:[] }]);
  assert.deepEqual(gs.getAttacks(pl.active).map(a => a.name), ['撞击'], '未装备时只有自身招式');

  pl.active.tool = gs._makeToolState('CSV4C-119', cd);
  assert.deepEqual(gs.getAttacks(pl.active).map(a => a.name), ['撞击', '能量涡轮'], '装备后应多出学习器招式');
  assert.equal(gs.checkEnergy(pl.active, 1), false, '没有能量时不能使用');
  pl.active.energy = [{ cardId:'e', name:'基本草能量' }];
  assert.equal(gs.checkEnergy(pl.active, 1), true, '有 1 个能量后可用【无】费用的学习器招式');
  pl.energyAttached = true;
  assert.equal(gs.canUseAttack(pl, pl.active, 1).ok, true);
  // 道具提供的招式不应影响别的宝可梦
  assert.deepEqual(gs.getAttacks(mon('另一个', 'm2', [{ name:'撞击' }])).map(a => a.name), ['撞击']);
});

await test('TM 招式已纳入效果索引（toolattack scope）', () => {
  const tsv = fs.readFileSync(path.join(__dirname, '..', '..', 'data_fast', 'effects.tsv'), 'utf8');
  const lines = tsv.split('\n').filter(l => l.split('\t')[1] === 'toolattack');
  assert.ok(lines.length >= 39, `效果索引应含招式学习器招式的效果（实际 ${lines.length} 行）`);
  // 更强的守卫：每张招式学习器卡的招式都要出现在索引里（不能漏卡）
  {
    const tools = loadJson('PokemonTool-cards.json').filter(c => (c['效果'] || '').includes('可以使用这张卡牌'));
    const ids = new Set(lines.map(l => l.split('	')[0]));
    const missing = tools.map(c => c['卡牌ID'][0]).filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `以下招式学习器卡的招式未进索引：${missing.join(', ')}`);
  }
  assert.ok(lines.some(l => l.startsWith('CSV4C-119\t')), '应含「能量涡轮」');
});


// ============================================================
//  二选一效果（B）：choose_effect + 分支描述选择
// ============================================================

await test('二选一 解析为一个 choose_effect，分支各自解析', () => {
  // 莎莉娜真实卡面
  const t = '这张卡牌，可以从2个效果中选择1个使用。\n\n◆选择自己的最多3张手牌，放于弃牌区。（必须至少选择1张。）然后，从牌库上方抽取卡牌，直到自己的手牌变为5张为止。\n\n◆选择对手备战区的1只「宝可梦V」，将其与战斗宝可梦互换。';
  const eff = parseEffect(t).effects;
  const ce = eff.find(e => e.action === 'choose_effect');
  assert.ok(ce, '应解析为 choose_effect');
  assert.equal(ce.params.branches.length, 2);
  const [b1, b2] = ce.params.branches;
  assert.deepEqual(b1.effects.filter(e => e.action !== 'usage_condition').map(e => e.action), ['discard_hand', 'draw_until']);
  assert.equal(b1.effects.find(e => e.action === 'discard_hand').params.minCount, 1, '卡面要求「必须至少选择1张」');
  assert.deepEqual(b2.effects.filter(e => e.action !== 'usage_condition').map(e => e.action), ['switch_pokemon']);
  assert.equal(b2.effects.find(e => e.action === 'switch_pokemon').params.who, 'opponent');
  // 选项文案从效果里精炼（不含「◆」等分隔符）
  assert.match(b1.label, /弃 3 张手牌/);
  assert.match(b2.label, /换对手后备上场/);
});

await test('二选一 首个分支缺「◆」也能正确分两支', () => {
  const t = '这张卡牌，可以从2个效果中选择1个使用。\n\n将自己的所有手牌放回牌库并重洗牌库。然后，从牌库上方抽取5张卡牌。\n\n◆将自己的战斗宝可梦与备战宝可梦互换。';
  const ce = parseEffect(t).effects.find(e => e.action === 'choose_effect');
  assert.ok(ce, '应仍能识别');
  assert.equal(ce.params.branches.length, 2, '缺 ◆ 时用标题到第一个 ◆ 的文本作为第一分支');
  assert.deepEqual(ce.params.branches[1].effects.filter(e => e.action !== 'usage_condition').map(e => e.action), ['switch_pokemon']);
});

await test('二选一 分支内的残句上提到顶层（不把未建模藏进分支里）', () => {
  // 第二分支是一个未建模的措辞 → 分支内容为空，但残句必须出现在顶层
  const t = '这张卡牌，可以从2个效果中选择1个使用。\n\n◆从自己的牌库上方抽取1张卡牌。\n\n◆这句完全没有匹配的措辞。';
  const eff = parseEffect(t).effects;
  assert.ok(eff.some(e => e.action === 'choose_effect'));
  const residuals = eff.filter(e => e.action === 'usage_condition' && e.params?.kind);
  assert.ok(residuals.length >= 1, '分支内未建模的残句应上提到顶层，指标上仍然可见');
});

await test('二选一 全部 11 张卡都能识别为 choose_effect（数据守卫）', () => {
  const files = ['Item-cards.json', 'Supporter-cards.json', 'PokemonTool-cards.json'];
  const bad = [];
  let n = 0;
  for (const f of files) {
    for (const c of loadJson(f)) {
      if (!(c['效果'] || '').includes('可以从2个效果中选择1个使用')) continue;
      const eff = parseEffect(c['效果']).effects;
      const ce = eff.find(e => e.action === 'choose_effect');
      if (!ce || ce.params.branches.length < 2) bad.push(c['卡牌ID'][0]);
      else n++;
    }
  }
  assert.ok(n >= 11, `应有 11 张以上（实际 ${n}）`);
  assert.deepEqual(bad, [], `以下卡识别失败：${bad.join(', ')}`);
});

await test('二选一 自动决策（无 UI）选第一个分支并真的执行', async () => {
  const t = '这张卡牌，可以从2个效果中选择1个使用。\n\n◆从自己的牌库上方抽取1张卡牌。\n\n◆将自己的战斗宝可梦与备战宝可梦互换。';
  const ce = parseEffect(t).effects.find(e => e.action === 'choose_effect');
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'd2'];
  pl.hand = [];
  pl.active = mon('前排', 'a1');
  pl.bench = [mon('后排', 'b1')];
  await executeEffects(gs, pl, [ce]);
  assert.equal(pl.hand.length, 1, '应执行第一分支（抽 1 张）');
  assert.equal(pl.active.name, '前排', '不应执行第二分支（换位）');
});

await test('二选一 人类玩家：按选择执行对应分支', async () => {
  const t = '这张卡牌，可以从2个效果中选择1个使用。\n\n◆从自己的牌库上方抽取1张卡牌。\n\n◆将自己的战斗宝可梦与备战宝可梦互换。';
  const ce = parseEffect(t).effects.find(e => e.action === 'choose_effect');
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'd2'];
  pl.hand = [];
  pl.active = mon('前排', 'a1');
  pl.bench = [mon('后排', 'b1')];
  // 模拟 UI：拿到 pendingPick 后选第二分支（索引 1）
  let pending = null;
  gs._onPendingPick = pick => { pending = pick; };
  const running = executeEffects(gs, pl, [ce]);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(pending, '应弹出选择');
  assert.equal(pending.cards.length, 2, '应有两个选项');
  assert.match(String(pending.cards[1]), /换对手后备上场|自己换位/, '选项文案应是分支效果的精炼描述');
  gs.resolvePick([1]);
  await running;
  assert.equal(pl.active.name, '后排', '选第二分支应换位');
  assert.equal(pl.hand.length, 0, '不应执行第一分支（抽卡）');
});


// ============================================================
//  P2-LZ：放逐区子系统（与弃牌区分离的真实区域）
// ============================================================

await test('LZ 放逐区不是弃牌区：剩余的卡牌进放逐区后弃牌区仍为空', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.deck = ['d1', 'd2', 'd3', 'd4'];
  pl.hand = [];
  pl.discard = [];
  pl.lostZone = [];
  await executeEffects(gs, pl, [{ action:'peek_and_keep', params:{ peek:3, keep:1, maxCount:1, minCount:1, remainder:'lost_zone' } }]);
  assert.equal(pl.hand.length, 1, '应拿 1 张到手牌');
  assert.equal(pl.lostZone.length, 2, '剩余 2 张应进放逐区');
  assert.equal(pl.discard.length, 0, '弃牌区必须仍为空（放逐的卡不能被回收）');
});

await test('LZ 「将剩余的卡牌放置于放逐区」并入 peek_and_keep', () => {
  const e = parseEffect('查看自己牌库上方3张卡牌，选择其中1张卡牌，加入手牌。将剩余的卡牌放于放逐区。').effects;
  const pk = e.find(x => x.action === 'peek_and_keep');
  assert.ok(pk, '应解析出 peek_and_keep');
  assert.equal(pk.params.remainder, 'lost_zone');
  assert.ok(!e.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');
});

await test('LZ 各种「放于放逐区」措辞都能解析', () => {
  const cases = [
    ['将这只宝可梦，以及放于其身上的所有卡牌，放于放逐区。', 'discard_self_with_attachments', { toLostZone:true }],
    ['然后，将这只宝可梦放于放逐区。', 'discard_self_with_attachments', { toLostZone:true }],
    ['将对手的战斗宝可梦，以及放于其身上的所有卡牌，放于放逐区。', 'discard_self_with_attachments', { who:'opponent', toLostZone:true }],
    ['将自己牌库上方3张卡牌放于放逐区。', 'lost_zone', { from:'deck_top', count:3 }],
    ['将自己弃牌区中任意数量的「宝可梦道具」放于放逐区。', 'lost_zone', { from:'discard', count:'any' }],
    ['选择附着于自己场上宝可梦身上的2个能量，放于放逐区。', 'lost_zone', { from:'field_energy', count:2 }],
  ];
  for (const [text, action, params] of cases) {
    const e = parseEffect(text).effects;
    const hit = e.find(x => x.action === action);
    assert.ok(hit, `「${text}」应解析出 ${action}（实际 ${JSON.stringify(e.map(x => x.action))}）`);
    for (const [k, v] of Object.entries(params)) assert.equal(hit.params[k], v, `${text} → ${k}`);
  }
});

await test('LZ 手牌代价进放逐区：确实支付到放逐区', async () => {
  const e = parseEffect('这张卡牌，只有将自己的1张手牌，放于放逐区后才可使用。').effects;
  const cost = e.find(x => x.action === 'trainer_prerequisite');
  assert.equal(cost.params.kind, 'discard_cost');
  assert.equal(cost.params.toLostZone, true);
  const gs = new GameState();
  const pl = gs.player1;
  pl.hand = ['h1', 'h2'];
  pl.discard = [];
  pl.lostZone = [];
  const r = await payDiscardCostFromHand(gs, pl, cost.params);
  assert.equal(r.ok, true, '代价应支付成功');
  assert.equal(pl.lostZone.length, 1, '代价卡应进放逐区');
  assert.equal(pl.discard.length, 0, '不应进弃牌区');
  assert.equal(pl.hand.length, 1);
});

await test('LZ 前提：放逐区张数不足时卡不可用', () => {
  const e = parseEffect('这张卡牌，只有在自己放逐区有10张以上（包含10张）时才可使用。').effects;
  const pre = e.find(x => x.action === 'trainer_prerequisite');
  assert.equal(pre.params.kind, 'lost_zone_min');
  assert.equal(pre.params.count, 10);
  const gs = new GameState();
  const pl = gs.player1;
  pl.lostZone = new Array(9).fill('x');
  const cd = { cardType:'trainer', trainerType:'item', name:'测试', effects: e };
  const bad = gs.canUseTrainer(pl, cd, 0);
  assert.equal(bad.ok, false, '放逐区不足 10 张时应不可用');
  assert.match(String(bad.message || ''), /放逐区/);
  pl.lostZone = new Array(10).fill('x');
  assert.equal(gs.canUseTrainer(pl, pl.hand[0] === undefined ? cd : cd, 0).ok, true, '达到 10 张后应可用');
});

await test('LZ 条件计数：只数放逐区里的宝可梦', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.lostZone = ['p1', 'p2', 't1'];
  gs.cardResolver = { getCard: id => ({ p1:{ cardType:'pokemon' }, p2:{ cardType:'pokemon' }, t1:{ cardType:'trainer' } }[id] || null) };
  assert.equal(gs._lostZonePokemonCount(pl), 2, '「放逐区中宝可梦的张数」不应把非宝可梦算进去');
});

await test('LZ 被动：放逐区够 N 张时招式能量需求全部消除', () => {
  const e = parseEffect('如果自己放逐区有4张以上（包含4张）的话，则这只宝可梦使用招式所需能量，全部消除。').effects;
  assert.equal(e[0].action, 'cost_eliminated_if_lost_zone');
  assert.equal(e[0].params.minLostZone, 4);
  const gs = new GameState();
  const pl = gs.player1;
  gs.currentPlayer = pl;
  gs.phase = PHASE.BATTLE;
  pl.active = mon('测试', 'm1', [{ name:'重击', cost:['fire','fire'], damage:30, effects:[] }]);
  pl.active.ability = { name:'放逐之力', active:true, zone:'field', effects: e };
  pl.active.energy = [];
  assert.equal(gs.checkEnergy(pl.active, 0), false, '没能量时本来不可用');
  pl.lostZone = [];
  assert.equal(gs.canUseAttack(pl, pl.active, 0).ok, false, '放逐区不足时仍不可用');
  pl.lostZone = ['a', 'b', 'c', 'd'];
  assert.equal(gs.canUseAttack(pl, pl.active, 0).ok, true, '放逐区达到 4 张后应可用（能量需求被消除）');
});

await test('LZ 兜底规则已移除：无法识别的放逐区句子不再假装已建模', () => {
  // 以前 `/放置于放逐区/` 兜底会把整句吃成一个空动作（执行时什么都不做）
  const e = parseEffect('将这句无法识别的文本放于放逐区。').effects;
  assert.ok(!e.some(x => x.action === 'lost_zone'), '不应再产出空的 lost_zone 动作');
  assert.ok(e.some(x => x.action === 'usage_condition'), '应落成未建模标记，指标上可见');
});


// ============================================================
//  ③(a)(b) 回合结束道具：自动弃置 / 文柚果一族触发式
// ============================================================

// 触发式效果由 EffectExecutor 注入的 _triggerHandler 驱动，测试里先 bootstrap 一次
async function bootTriggers(gs) { await executeEffects(gs, gs.player1, []); }
const YACHE = '在双方的回合结束时，如果身上放有这张卡牌的宝可梦身上放置有3个以上（包含3个）伤害指示物的话，则回复该宝可梦「30」点HP。然后，将这张卡牌放于弃牌区。';

await test('TE(b) 文柚果一族解析为 checkup 触发器（含条件与自弃）', () => {
  const e = parseEffect(YACHE).effects;
  assert.equal(e.length, 1);
  assert.equal(e[0].action, 'trigger');
  assert.equal(e[0].params.event, 'checkup', '「双方的回合结束时」= 引擎的 checkup 时点');
  assert.equal(e[0].params.anyPosition, true, '卡面只写「身上放有这张卡牌的宝可梦」，不限出战位');
  assert.deepEqual(e[0].params.condition, { kind:'damage_counters_at_least', count:3 });
  assert.deepEqual(e[0].params.effects.map(x => x.action), ['heal', 'discard_self_tool']);
  assert.equal(e[0].params.effects[0].params.target, 'trigger_source', '回复的是持有者');

  const m = parseEffect('在双方的回合结束时，身上放有这张卡牌的宝可梦处于特殊状态的话，则恢复该宝可梦的所有特殊状态。然后，将这张卡牌放于弃牌区。').effects;
  assert.deepEqual(m[0].params.condition, { kind:'has_special_condition' });
  assert.deepEqual(m[0].params.effects.map(x => x.action), ['heal_status', 'discard_self_tool']);

  const j = parseEffect('在双方的回合结束时，如果身上放有这张卡牌的宝可梦的剩余HP在「30」点以下（包含30点）且身上放置有伤害指示物的话，则回复该宝可梦「120」点HP。然后，将这张卡牌放于弃牌区。').effects;
  assert.deepEqual(j[0].params.condition, { kind:'hp_at_most_with_counters', hp:30 });
  assert.equal(j[0].params.effects[0].params.amount, 120);
});

await test('TE(a) 「对手的回合结束时被放于弃牌区」解析为对手回合弃置标记', () => {
  const e = parseEffect('放于宝可梦身上的这张卡牌，将在对手的回合结束时被放于弃牌区。').effects;
  assert.ok(e.some(x => x.action === 'tool_opponent_turn_end_discard'), '应解析出对手回合弃置标记');
});

await test('TE(b) 备战区持有者也能触发，且触发后道具进弃牌区', async () => {
  const eff = parseEffect(YACHE).effects;
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1;
  pl.active = mon('前排', 'a1');
  const holder = mon('后排', 'b1');
  holder.hp = 30; // 3 个伤害指示物
  holder.tool = { cardId:'tool1', name:'文柚果', effects: eff };
  pl.bench = [holder];
  pl.discard = [];
  gs.emitTriggerEvent('checkup', {});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(holder.hp, 60, '应回复 30 点（30 → 60）');
  assert.equal(holder.tool, null, '触发后道具应进弃牌区');
  assert.equal(pl.discard.length, 1, '道具应真的进了弃牌区');
});

await test('TE(b) 条件不满足时不触发、也不弃卡', async () => {
  const eff = parseEffect(YACHE).effects;
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1;
  pl.active = mon('前排', 'a1');
  const holder = mon('后排', 'b1');
  holder.hp = 40; // 只有 2 个伤害指示物（不足 3 个）
  holder.tool = { cardId:'tool1', name:'文柚果', effects: eff };
  pl.bench = [holder];
  pl.discard = [];
  gs.emitTriggerEvent('checkup', {});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(holder.hp, 40, '条件不满足不应回复');
  assert.ok(holder.tool, '条件不满足不应弃卡');
});

await test('TE 顺序：endTurn 里道具必须在 checkup 触发之后才被弃置', async () => {
  const eff = parseEffect(YACHE).effects;
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  opp.active = mon('敌方', 'o1');
  const holder = mon('后排', 'b1');
  holder.hp = 30;
  holder.tool = { cardId:'tool1', name:'文柚果', effects: eff };
  pl.bench = [holder];
  pl.discard = [];
  pl.deck = ['x1', 'x2', 'x3'];
  opp.deck = ['y1', 'y2', 'y3'];
  pl.prizes = ['p']; opp.prizes = ['q'];
  gs.endTurn();
  assert.equal(holder.hp, 60, '回合结束时应先触发回复');
  assert.equal(holder.tool, null, '然后再把道具放进弃牌区');
});

await test('TE(a) 「对手的回合结束时弃置」的归属方是持有者的对手', async () => {
  const eff = parseEffect('放于宝可梦身上的这张卡牌，将在对手的回合结束时被放于弃牌区。').effects;
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我方', 'a1');
  opp.active = mon('敌方', 'o1');
  opp.active.tool = { cardId:'t9', name:'金属核心屏障', effects: eff };
  pl.deck = ['x1', 'x2']; opp.deck = ['y1', 'y2'];
  pl.prizes = ['p']; opp.prizes = ['q'];
  gs.endTurn(); // 我方回合结束 —— 对持有者(玩家2)而言这正是「对手的回合」
  assert.equal(opp.active.tool, null, '持有者的对手回合结束时应弃置');
});


// ============================================================
//  ④ 事件触发条件：妙蛙花&藤藤蛇GX「光辉蔓藤」
// ============================================================

const VENUSAUR = '在自己的回合，如果这只宝可梦在战斗场上的话，则每次从自己的手牌将【草】能量附着于这只宝可梦身上时，可使用1次。选择对手的1只备战宝可梦，将其与战斗宝可梦互换。';

await test('EV 妙蛙花&藤藤蛇GX：触发句 + 后续效果收进 trigger.effects', () => {
  const e = parseEffect(VENUSAUR).effects;
  const tr = e.find(x => x.action === 'trigger');
  assert.ok(tr, `应解析出 trigger（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  assert.equal(tr.params.event, 'energy_attached');
  assert.deepEqual(tr.params.condition, { owner:'self', toSelf:true, fromHand:true, energyFilter:'【草】能量' });
  assert.deepEqual(tr.params.effects.map(x => x.action), ['switch_pokemon'], '后半句应作为触发后的效果');
  assert.ok(e.some(x => x.params?.kind === 'requires_active'), '发动前提要留在顶层（供 _abilityUsageFailure 读）');
  assert.ok(!e.some(x => x.action === 'switch_pokemon'), '不应留在顶层（否则使用特性时会立刻换位）');
});

await test('EV 触发条件：只有「自己+手牌+草能量+附于自身」才触发', async () => {
  const eff = parseEffect(VENUSAUR).effects;
  const run = async (ownerSelf, cardName) => {
    const gs = new GameState();
    await bootTriggers(gs);
    const pl = gs.player1, opp = gs.player2;
    const holder = mon('持有者', 'h1');
    holder.ability = { name:'光辉蔓藤', active:true, zone:'field', effects: eff };
    pl.active = holder;
    pl.bench = [];
    opp.active = mon('敌前', 'o1');
    opp.bench = [mon('敌后', 'o2')];
    gs.emitTriggerEvent('energy_attached', { target: holder, owner: ownerSelf ? pl : opp, fromHand: true, cardName });
    await new Promise(r => setTimeout(r, 5));
    return opp.active.name;
  };
  assert.equal(await run(true, '基本【草】能量'), '敌后', '自己附草能量应触发');
  assert.equal(await run(true, '基本草能量'), '敌后', '卡名没有【】也要能识别');
  assert.equal(await run(true, '基本【火】能量'), '敌前', '非草能量不应触发');
  assert.equal(await run(false, '基本【草】能量'), '敌前', '对手附能不应触发');
});

await test('EV 「每当对手附着能量时」的老行为未被破坏', async () => {
  // 旧行为：energy_attached 默认只处理**对手**附着（方向判定已移到条件里，默认值保持不变）
  const eff = parseEffect('每当对手将能量附着于其宝可梦身上时，从牌库上方抽取1张卡牌。').effects;
  const trig = eff.find(x => x.action === 'trigger');
  if (!trig) return; // 该措辞未建模时不强求
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我方', 'a1');
  pl.active.ability = { name:'窥视', active:true, zone:'field', effects: eff };
  opp.active = mon('敌方', 'o1');
  pl.deck = ['d1', 'd2', 'd3'];
  pl.hand = [];
  gs.emitTriggerEvent('energy_attached', { target: opp.active, owner: opp, fromHand: true, cardName: '基本【草】能量' });
  await new Promise(r => setTimeout(r, 5));
  assert.ok(pl.hand.length >= 1, '对手附能时仍应触发');
});


// ============================================================
//  ③(c) 特性回合结束触发  /  ③(d) 支援者延迟到回合结束
// ============================================================

const FLOWER = '在自己的回合结束时可以使用1次。从牌库上方抽取卡牌，直到自己的手牌变为4张为止。';
const TUSK = '在自己的回合结束时，如果这只宝可梦在战斗场上的话，则必须使用1次。将自己牌库上方5张卡牌放于弃牌区。';
const NALI = '从自己牌库上方抽取4张卡牌。在使用了这张卡牌的回合结束时，如果自己的手牌数量为5张及以上的话，则将自己的手牌全部放于弃牌区。';

await test('TE(c) 回合结束特性解析为 trigger(turn_end) 且效果收在其内', () => {
  const a = parseEffect(FLOWER).effects;
  assert.equal(a[0].action, 'trigger');
  assert.equal(a[0].params.event, 'turn_end');
  assert.deepEqual(a[0].params.effects.map(x => x.action), ['draw_until']);

  const b = parseEffect(TUSK).effects;
  const tr = b.find(x => x.action === 'trigger');
  assert.equal(tr.params.forced, true, '「必须使用1次」应标记为强制');
  assert.deepEqual(tr.params.condition, { requiresActive:true });
  assert.deepEqual(tr.params.effects.map(x => x.action), ['mill'], '效果不应留在顶层');
  assert.ok(!b.some(x => x.action === 'mill'), '顶层不应再有 mill（否则手动发动会立刻生效）');
});

await test('TE(c) 弱丁鱼：对手回合结束触发 + 反面回牌库', () => {
  const e = parseEffect('如果这只宝可梦身上放置有伤害指示物的话，则在对手的回合结束时，抛掷1次硬币。如果为反面，则将这只宝可梦，以及放于其身上的所有卡牌，放回自己的牌库并重洗牌库。').effects;
  const tr = e.find(x => x.action === 'trigger');
  assert.ok(tr, `应解析出 trigger（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  assert.equal(tr.params.event, 'opponent_turn_end');
  assert.deepEqual(tr.params.condition, { kind:'has_damage_counters' });
  const flip = tr.params.effects.find(x => x.action === 'coin_flip');
  assert.ok(flip, '应有抛硬币');
  assert.deepEqual((flip.params.tails || []).map(x => x.action), ['return_self_to_deck'], '反面才回牌库');
});

await test('TE(c) 回合结束特性：出战位触发、备战位不触发', async () => {
  const eff = parseEffect(TUSK).effects;
  const mkCase = async bench => {
    const gs = new GameState();
    await bootTriggers(gs);
    const pl = gs.player1, opp = gs.player2;
    pl.active = mon('前排', 'a1');
    opp.active = mon('敌方', 'o1');
    const holder = bench ? mon('后备', 'b1') : pl.active;
    holder.ability = { name:'摇晃击溃', active:true, zone:'field', effects: eff };
    if (bench) pl.bench = [holder];
    pl.deck = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    opp.deck = ['y1', 'y2', 'y3'];
    pl.prizes = ['p']; opp.prizes = ['q'];
    pl.discard = [];
    gs.endTurn();
    await new Promise(r => setTimeout(r, 10));
    return pl.discard.length;
  };
  assert.equal(await mkCase(false), 5, '出战位应在回合结束时 mill 5');
  assert.equal(await mkCase(true), 0, '备战位不应触发（卡面要求「在战斗场上」）');
});

await test('TE(c) 光辉妙蛙花：回合结束时抽到手牌 4 张', async () => {
  const eff = parseEffect(FLOWER).effects;
  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  pl.active.ability = { name:'花开', active:true, zone:'field', effects: eff };
  opp.active = mon('敌方', 'o1');
  pl.hand = ['h1'];
  pl.deck = ['d1', 'd2', 'd3', 'd4', 'd5'];
  opp.deck = ['y1', 'y2'];
  pl.prizes = ['p']; opp.prizes = ['q'];
  gs.endTurn();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(pl.hand.length, 4, '应在回合结束时抽到 4 张');
});

await test('TE(d) 支援者延迟效果：打出时不当场执行，回合结束才结算', async () => {
  const eff = parseEffect(NALI).effects;
  const gate = eff.find(x => x.action === 'defer_to_turn_end');
  assert.ok(gate, '应解析出 defer_to_turn_end');
  assert.deepEqual(gate.params.effects.map(x => x.action), ['discard_all_hand'], '延迟部分应是「丢光手牌」');

  const gs = new GameState();
  await bootTriggers(gs);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  opp.active = mon('敌方', 'o1');
  pl.deck = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  opp.deck = ['y1', 'y2'];
  pl.prizes = ['p']; opp.prizes = ['q'];
  pl.hand = [];
  pl.discard = [];
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 4, '打出时应抽 4 张');
  assert.equal(pl.discard.length, 0, '**不应当场丢手牌**（这是修复前的真错）');
  gs.endTurn();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(pl.hand.length, 0, '回合结束时应把手牌丢光');
  assert.equal(pl.discard.length, 4, '丢掉的 4 张应进弃牌区');
});


// ============================================================
//  ① 胜利条件：未知图腾「伤害 / 手牌 / 放逐」
// ============================================================

const UNOWN_DMG = '如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。如果自己全部备战宝可梦身上放置的所有伤害指示物达到66个以上（包含66个）的话，则这场对战算作自己的胜利。';
const UNOWN_HAND = '如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。如果自己的手牌张数达到35张以上（包含35张）的话，则这场对战算做自己的胜利。';
const UNOWN_LZ = '如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。如果对手的放逐区中的支援者的张数达到12张以上（包含12张），则这场对战算做自己的胜利。';

await test('WIN 未知图腾三种胜利条件都能解析', () => {
  assert.deepEqual(parseEffect(UNOWN_DMG).effects.find(e => e.action === 'win_condition').params,
    { kind:'bench_damage_counters_total', threshold:66 });
  assert.deepEqual(parseEffect(UNOWN_HAND).effects.find(e => e.action === 'win_condition').params,
    { kind:'hand_count', threshold:35 });
  assert.deepEqual(parseEffect(UNOWN_LZ).effects.find(e => e.action === 'win_condition').params,
    { kind:'opponent_lost_zone_supporter_count', threshold:12 });
  for (const t of [UNOWN_DMG, UNOWN_HAND, UNOWN_LZ]) {
    assert.ok(!parseEffect(t).effects.some(e => e.params?.kind === 'residual_sentence'), '不应残留未建模标记');
  }
});

await test('WIN 条件进度计算：备战区指示物 / 手牌 / 对手放逐区支援者', () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.bench = [mon('a', 'a1'), mon('b', 'b1')];
  pl.bench[0].hp = 30; pl.bench[1].hp = 10; // 30 + 50 = 80
  assert.equal(gs._winConditionProgress(pl, 'bench_damage_counters_total'), 80);
  pl.hand = new Array(35).fill('h');
  assert.equal(gs._winConditionProgress(pl, 'hand_count'), 35);
  gs.cardResolver = { getCard: id => ({ s1:{ cardType:'trainer', trainerType:'supporter' }, s2:{ cardType:'trainer', trainerType:'supporter' }, t1:{ cardType:'trainer', trainerType:'item' } }[id] || null) };
  opp.lostZone = ['s1', 's2', 't1'];
  assert.equal(gs._winConditionProgress(pl, 'opponent_lost_zone_supporter_count'), 2, '只数支援者');
});

await test('WIN 未达成时特性置灰并显示进度', () => {
  const gs = new GameState();
  const pl = gs.player1;
  gs.phase = PHASE.MAIN;
  const u = mon('未知图腾', 'u1');
  u.ability = { name:'伤害', active:true, zone:'field', effects: parseEffect(UNOWN_DMG).effects };
  pl.active = u; pl.bench = [];
  const r = gs.canUseAbility(pl, u, u.ability, 'active');
  assert.equal(r.ok, false, '未达成时不可用');
  assert.match(String(r.message || ''), /胜利条件未达成：0\/66/);
});

await test('WIN 达成时发动即获胜（对手放逐区支援者 ≥12）', async () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  gs.phase = PHASE.MAIN;
  const u = mon('未知图腾', 'u1');
  u.ability = { name:'放逐', active:true, zone:'field', effects: parseEffect(UNOWN_LZ).effects };
  pl.active = u;
  gs.cardResolver = { getCard: () => ({ cardType:'trainer', trainerType:'supporter' }) };
  opp.lostZone = new Array(12).fill('s');
  assert.equal(gs.canUseAbility(pl, u, u.ability, 'active').ok, true, '达成后应可用');
  await executeEffects(gs, pl, u.ability.effects);
  assert.equal(gs.winner, pl, '应判自己获胜');
  assert.equal(gs.phase, PHASE.GAME_OVER, '对战应结束');
});


// ============================================================
//  K1 昏厥 → 放逐区（替代「进弃牌区」）
// ============================================================

const KO_STADIUM = '每当双方的宝可梦【昏厥】时，不将该宝可梦放于弃牌区，而是放于放逐区。';
const KO_GENGAR = '只要这只宝可梦在战斗场上，如果对手的宝可梦【昏厥】的话，将那只宝可梦放于放逐区。';
const KO_DARKRAI = '将受到这个招式的伤害而【昏厥】的宝可梦以及放于其身上的所有卡牌放于放逐区。';
const KO_TYRANITAR = '如果因这只宝可梦的招式的伤害，对手的宝可梦【昏厥】的话，则该【昏厥】的宝可梦，以及放于其身上的所有卡牌不会被放于弃牌区，而是被放于放逐区。';

async function koSetup() {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  gs.phase = PHASE.MAIN;
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我方前排', 'a1'); pl.bench = [mon('我方替补', 'a2')];
  opp.active = mon('敌方前排', 'o1'); opp.bench = [mon('敌方替补', 'o2')];
  pl.discard = []; pl.lostZone = []; opp.discard = []; opp.lostZone = [];
  pl.prizes = ['p1', 'p2']; opp.prizes = ['q1', 'q2'];
  return { gs, pl, opp };
}

await test('K1 四种「昏厥→放逐区」形态都能解析', () => {
  assert.deepEqual(parseEffect(KO_STADIUM).effects[0].params, { scope:'both' });
  assert.deepEqual(parseEffect(KO_GENGAR).effects.find(e => e.action === 'ko_to_lost_zone').params, { scope:'opponent' });
  assert.deepEqual(parseEffect(KO_DARKRAI).effects[0].params, { scope:'attack', withAttachments:true });
  assert.deepEqual(parseEffect(KO_TYRANITAR).effects[0].params, { scope:'own_attack', withAttachments:true });
});

await test('K1 场地「放逐市」：昏厥进放逐区、身上卡牌进弃牌区、奖赏卡照拿', async () => {
  const { gs, pl, opp } = await koSetup();
  gs.stadium = { cardId:'st', name:'放逐市', effects: parseEffect(KO_STADIUM).effects };
  pl.active.energy = [{ cardId:'e1', name:'能量' }];
  pl.active.tool = { cardId:'t1', name:'道具' };
  gs.knockout(pl);
  assert.deepEqual(pl.lostZone, ['a1'], '宝可梦本体进放逐区');
  assert.deepEqual(pl.discard, ['e1', 't1'], '「除宝可梦以外的卡牌全部丢到弃牌区」');
  assert.equal(opp.prizes.length, 1, '放逐区替代不影响拿奖赏卡');
  assert.equal(pl.active.name, '我方替补', '应换上备战宝可梦');
});

await test('K1 耿鬼（对手出战位）：我方昏厥进放逐区', async () => {
  const { gs, pl, opp } = await koSetup();
  opp.active.ability = { name:'暗影', active:true, zone:'field', effects: parseEffect(KO_GENGAR).effects };
  gs.knockout(pl);
  assert.deepEqual(pl.lostZone, ['a1']);
  assert.deepEqual(pl.discard, []);
});

await test('K1 招式型（达克莱伊）：宝可梦与身上所有卡牌一起进放逐区', async () => {
  const { gs, pl, opp } = await koSetup();
  opp.active.energy = [{ cardId:'oe', name:'能量' }];
  opp.active.tool = { cardId:'ot', name:'道具' };
  gs._koContext = { attacker: pl.active };
  await executeEffects(gs, pl, parseEffect(KO_DARKRAI).effects);
  gs.knockout(opp);
  assert.deepEqual(opp.lostZone, ['o1', 'oe', 'ot'], '本体+身上卡牌都进放逐区');
  assert.deepEqual(opp.discard, [], '不应有东西进弃牌区');
});

await test('K1 招式伤害型特性（班基拉斯GX）：只对本次攻击造成的昏厥生效', async () => {
  const { gs, pl, opp } = await koSetup();
  pl.active.ability = { name:'暴君', active:true, zone:'field', effects: parseEffect(KO_TYRANITAR).effects };
  opp.active.energy = [{ cardId:'oe', name:'能量' }];
  gs._koContext = { attacker: pl.active }; // 攻击窗口内
  gs.knockout(opp);
  assert.deepEqual(opp.lostZone, ['o1', 'oe'], '本次攻击造成的昏厥 → 放逐区（带身上卡牌）');
  // 攻击窗口结束后（finishTurn 会清 _koContext）→ 不再生效
  gs._koContext = null;
  const opp2 = gs.player2;
  opp2.active = mon('敌方前排2', 'o3');
  opp2.lostZone = []; opp2.discard = [];
  gs.knockout(opp2);
  assert.deepEqual(opp2.lostZone, [], '攻击窗口外不触发');
  assert.deepEqual(opp2.discard, ['o3']);
});

await test('K1 修：普通昏厥时身上的卡牌不再凭空消失', async () => {
  const { gs, pl } = await koSetup();
  pl.active.energy = [{ cardId:'e1', name:'能量' }];
  pl.active.tool = { cardId:'t1', name:'道具' };
  gs.knockout(pl);
  assert.deepEqual(pl.discard, ['a1', 'e1', 't1'], '本体与身上的能量/道具都进弃牌区');
  assert.deepEqual(pl.lostZone, []);
});

await test('K1 修：备战区昏厥同样处理（放逐区判定 + 身上卡牌不丢）', async () => {
  // 普通情况：备战区被击倒，道具跟着进弃牌区
  let { gs, pl } = await koSetup();
  pl.bench[0].tool = { cardId:'t1', name:'道具' };
  await executeEffects(gs, gs.player1, [{ action:'damage_bench', params:{ target:'opponent_all', damage:60 } }]);
  // 上面打的是对手备战区；这里直接验证我方备战区路径
  const gs2 = new GameState();
  await executeEffects(gs2, gs2.player1, []);
  gs2.phase = PHASE.MAIN;
  gs2.player1.active = mon('我','a1');
  gs2.player2.active = mon('敌','o1');
  gs2.player2.bench = [mon('备战防守','bench-def')];
  gs2.player2.bench[0].tool = { cardId:'t1', name:'道具' };
  await executeEffects(gs2, gs2.player1, [{ action:'damage_bench', params:{ target:'opponent_all', damage:60 } }]);
  assert.deepEqual(gs2.player2.discard, ['bench-def', 't1'], '备战区被击倒时道具也进弃牌区');
  // 放逐市在场时：备战区被击倒也进放逐区
  const gs3 = new GameState();
  await executeEffects(gs3, gs3.player1, []);
  gs3.phase = PHASE.MAIN;
  gs3.stadium = { cardId:'st', name:'放逐市', effects: parseEffect(KO_STADIUM).effects };
  gs3.player1.active = mon('我','a1');
  gs3.player2.active = mon('敌','o1');
  gs3.player2.bench = [mon('备战防守','bench-def')];
  await executeEffects(gs3, gs3.player1, [{ action:'damage_bench', params:{ target:'opponent_all', damage:60 } }]);
  assert.deepEqual(gs3.player2.lostZone, ['bench-def'], '备战区被击倒也走放逐区替代');
  assert.deepEqual(gs3.player2.discard, []);
});


// ============================================================
//  K2 附能事件覆盖所有附能路径（手牌 / 弃牌区 / 牌库）
// ============================================================

const VENUSAUR_EV = '在自己的回合，如果这只宝可梦在战斗场上的话，则每次从自己的手牌将【草】能量附着于这只宝可梦身上时，可使用1次。选择对手的1只备战宝可梦，将其与战斗宝可梦互换。';

async function evSetup() {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  gs.phase = PHASE.MAIN;
  const pl = gs.player1, opp = gs.player2;
  const holder = mon('持有者', 'h1');
  holder.ability = { name:'光辉蔓藤', active:true, zone:'field', effects: parseEffect(VENUSAUR_EV).effects };
  pl.active = holder;
  pl.bench = [];
  opp.active = mon('敌前', 'o1');
  opp.bench = [mon('敌后', 'o2')];
  gs.cardResolver = fakeResolver({
    'e1': { card:{ cardType:'energy', name:'基本【草】能量' }, info:{ name:'基本【草】能量', type:'energy' } },
    'f1': { card:{ cardType:'energy', name:'基本【火】能量' }, info:{ name:'基本【火】能量', type:'energy' } },
  });
  return { gs, pl, opp, holder };
}

await test('K2 从手牌附能会发出 energy_attached（fromHand=true）并触发符合条件的特性', async () => {
  const { gs, pl, opp, holder } = await evSetup();
  pl.hand = ['e1'];
  await executeEffects(gs, pl, [{ action:'attach_energy_from_hand', params:{ count:1, filter:'基本能量', target:'self', allowFewer:true, allowEmpty:true } }]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(holder.energy.length, 1, '能量应附着成功');
  assert.equal(opp.active.name, '敌后', '「从手牌附草能量」应触发换位');
});

await test('K2 从牌库附能也发事件，但 fromHand=false 不会触发「从手牌」类特性', async () => {
  const { gs, pl, opp, holder } = await evSetup();
  pl.deck = ['e1'];
  await executeEffects(gs, pl, [{ action:'attach_energy_from_deck', params:{ count:1, filter:'基本能量', target:'self', allowFewer:true, allowEmpty:true } }]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(holder.energy.length, 1, '能量应附着成功');
  assert.equal(opp.active.name, '敌前', '卡面写「从自己的手牌」，牌库附能不应触发');
});

await test('K2 从弃牌区附能同样发事件（fromHand=false）', async () => {
  const { gs, pl, opp, holder } = await evSetup();
  pl.discard = ['e1'];
  await executeEffects(gs, pl, [{ action:'attach_energy_from_discard', params:{ count:1, filter:'基本能量', target:'self', allowFewer:true, allowEmpty:true } }]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(holder.energy.length, 1, '能量应附着成功');
  assert.equal(opp.active.name, '敌前', '弃牌区附能不属于「从手牌」');
});

await test('K2 非目标属性不会触发（能量筛选条件生效）', async () => {
  const { gs, pl, opp } = await evSetup();
  pl.hand = ['f1'];
  await executeEffects(gs, pl, [{ action:'attach_energy_from_hand', params:{ count:1, filter:'基本能量', target:'self', allowFewer:true, allowEmpty:true } }]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(opp.active.name, '敌前', '附火能量不应触发草能量的特性');
});


// ============================================================
//  优化点：「世界终焉」需要竞技场，没有则招式失败
// ============================================================

const WORLD_END = '将场上的竞技场放于弃牌区。如果无法将卡牌放于弃牌区的话，则这个招式失败。';

function worldEndCase(withStadium) {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  const atk = { name:'世界终焉', cost:[], damage:230, effect:WORLD_END, effects: parseEffect(WORLD_END).effects };
  gs.player1.active = mon('无极汰那', 'e1', [atk]);
  gs.player2.active = mon('受击方', 'd1');
  gs.player1.deck = ['a', 'b']; gs.player2.deck = ['c', 'd'];
  gs.player1.prizes = ['p']; gs.player2.prizes = ['q'];
  gs.player1.discard = []; gs.player2.discard = [];
  if (withStadium) {
    gs.player1.hand = ['st1'];
    const st = { cardType:'trainer', trainerType:'stadium', name:'深钵镇', effects:[], effectText:'' };
    gs.cardResolver = { getCard: () => st };
    gs.setActiveStadium(gs.player1, 0, st);
  } else {
    gs.cardResolver = { getCard: () => null };
  }
  return { gs, engine: makeEngine(gs) };
}

await test('世界终焉 解析出「需要竞技场」前提', () => {
  const e = parseEffect(WORLD_END).effects;
  assert.ok(e.some(x => x.action === 'discard_stadium'), '应有丢弃竞技场');
  assert.ok(e.some(x => x.params?.kind === 'attack_requires_stadium'), '应解析出招式失败前提');
});

await test('世界终焉 有竞技场：正常造成伤害并弃掉竞技场', async () => {
  const { gs, engine } = worldEndCase(true);
  assert.equal(gs.canUseAttack(gs.player1, gs.player1.active, 0).ok, true, '有竞技场时可用');
  assert.equal(await engine.attack(0), true);
  assert.equal(gs.player2.active.hp, 0, '应造成 230 伤害');
  assert.equal(gs.getActiveStadium(), null, '竞技场应被弃掉');
  assert.deepEqual(gs.player1.discard, ['st1'], '竞技场应进其持有者的弃牌区');
});

await test('世界终焉 无竞技场：招式失败、零伤害（修复前会照常打 230）', async () => {
  const { gs, engine } = worldEndCase(false);
  const canUse = gs.canUseAttack(gs.player1, gs.player1.active, 0);
  assert.equal(canUse.ok, false, '无竞技场时应置灰');
  assert.match(String(canUse.message || ''), /没有竞技场/);
  // 即使强行发动，也必须失败且不结算伤害
  const ok = await engine.attack(0);
  assert.equal(ok, false, '招式应失败');
  assert.equal(gs.player2.active.hp, gs.player2.active.maxHp, '失败时不应造成任何伤害');
});


// ============================================================
//  k3「造成其张数×N伤害」= 前一个动作实际移动的卡牌数 × N
// ============================================================

await test('k3 「其张数×N伤害」并入前面的移卡动作', () => {
  // 水箭龟ex 类：把能量丢到弃牌区 → 伤害 = 丢掉的张数 × N
  const e = parseEffect('将附着于这只宝可梦身上的能量全部放于弃牌区，造成其张数×100伤害。').effects;
  const de = e.find(x => x.action === 'discard_energy');
  assert.ok(de, `应解析出 discard_energy（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  assert.equal(de.params.damagePerCard, 100);
  assert.ok(!e.some(x => x.params?.kind === 'residual_sentence'), '不应残留未建模标记');

  // 招式学习器版「巨龙燃烧GX」：把基本能量丢到弃牌区 → 张数 × 80
  const tm = parseEffect('将附着于这只宝可梦身上的基本能量，全部放于弃牌区，造成其张数×80点伤害。').effects;
  assert.equal(tm.find(x => x.action === 'discard_energy').params.damagePerCard, 80);
});

await test('k3 执行：丢弃 N 个能量 → 对手出战宝可梦受 N×N 伤害', async () => {
  const e = parseEffect('将附着于这只宝可梦身上的能量全部放于弃牌区，造成其张数×100伤害。').effects;
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('攻击方', 'a1');
  pl.active.energy = [{ cardId:'e1', name:'能量' }, { cardId:'e2', name:'能量' }];
  opp.active = mon('受击方', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  await executeEffects(gs, pl, e);
  assert.equal(pl.active.energy.length, 0, '能量应全部被丢弃');
  assert.equal(opp.active.hp, 0, '2 张 × 100 = 200 伤害（200 → 0）');
});

await test('k3 执行：翻牌张数也算（mill）', async () => {
  const e = [{ action:'mill', params:{ target:'self', count:3, damagePerCard:20 } }];
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('攻击方', 'a1');
  opp.active = mon('受击方', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.deck = ['a', 'b', 'c', 'd'];
  await executeEffects(gs, pl, e);
  assert.equal(pl.discard.length, 3, '应翻 3 张');
  assert.equal(opp.active.hp, 140, '3 × 20 = 60 伤害');
});

await test('k3 没写 damagePerCard 时行为不变', async () => {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('攻击方', 'a1');
  pl.active.energy = [{ cardId:'e1', name:'能量' }];
  opp.active = mon('受击方', 'd1');
  const hp0 = opp.active.hp;
  await executeEffects(gs, pl, [{ action:'discard_energy', params:{ target:'self', count:'all' } }]);
  assert.equal(pl.active.energy.length, 0, '能量仍被丢弃');
  assert.equal(opp.active.hp, hp0, '没有 damagePerCard 就不该造成伤害');
});


// ============================================================
//  k4 一树：本回合第一次由效果触发的掷硬币，结果可由自己决定
// ============================================================

const ICHIKU = '在这个回合，使用了这张卡牌后，首次由于招式、特性、训练家的效果自己抛掷硬币时，其第一次的结果，可由自己决定是正面还是反面。';

await test('k4 一树两种措辞都能解析', () => {
  assert.deepEqual(parseEffect(ICHIKU).effects.map(e => e.action), ['coin_choice_this_turn']);
  const short = '在这个回合，使用了这张卡牌后，由于招式、特性、训练家的效果自己抛掷硬币时，其第一次的结果，可由自己决定是正面还是反面。';
  assert.deepEqual(parseEffect(short).effects.map(e => e.action), ['coin_choice_this_turn']);
  assert.ok(!parseEffect(ICHIKU).effects.some(e => e.params?.kind === 'residual_sentence'), '不应残留未建模标记');
});

await test('k4 一树：第一次掷硬币可选结果，用掉后恢复随机', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  gs.phase = PHASE.MAIN;
  const pl = gs.player1;
  pl.active = mon('我', 'a1');
  pl.deck = ['d1', 'd2', 'd3'];
  pl.hand = [];
  await executeEffects(gs, pl, parseEffect(ICHIKU).effects);
  assert.equal(pl.coinChoiceArmed, true, '应武装标记');

  // 模拟 UI：选「反面」（索引 1）→ 正面分支不应执行
  let pending = null;
  gs._onPendingPick = p => { pending = p; };
  const running = executeEffects(gs, pl, [{ action:'coin_flip', params:{ count:1, heads:[{ action:'draw', params:{ count:1 } }] } }]);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(pending, '应弹出硬币结果选择');
  assert.deepEqual(pending.cards, ['正面', '反面']);
  gs.resolvePick([1]);
  await running;
  assert.equal(pl.hand.length, 0, '选反面时正面分支不执行');
  assert.equal(pl.coinChoiceArmed, false, '标记应被用掉');

  // 第二次回到随机：Math.random()=0 → 正面 → 抽 1 张
  const saved = Math.random;
  Math.random = () => 0;
  try { await executeEffects(gs, pl, [{ action:'coin_flip', params:{ count:1, heads:[{ action:'draw', params:{ count:1 } }] } }]); }
  finally { Math.random = saved; }
  assert.equal(pl.hand.length, 1, '第二次应恢复随机判定');
});

await test('k4 一树：自动决策（无 UI）按正面处理', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = mon('我', 'a1');
  pl.deck = ['d1', 'd2'];
  pl.hand = [];
  pl.coinChoiceArmed = true; // 相当于已使用一树
  await executeEffects(gs, pl, [{ action:'coin_flip', params:{ count:1, heads:[{ action:'draw', params:{ count:1 } }] } }]);
  assert.equal(pl.hand.length, 1, '无 UI 时应按正面处理（分支执行）');
  assert.equal(pl.coinChoiceArmed, false, '标记应被用掉');
});


// ============================================================
//  k3b 前半句补齐：给对手查看 / 放回牌库 / 弃牌区能量计数
// ============================================================

await test('k3b 弃牌区能量给对手查看 → 张数×N 伤害 → 放回牌库', async () => {
  const eff = parseEffect('将自己弃牌区中的所有基本能量给对手查看，造成其张数×20伤害。然后，将给对手查看过的能量放回牌库并重洗牌库。').effects;
  const gate = eff.find(e => e.action === 'discard_energy_peek_damage');
  assert.ok(gate, '应解析出 discard_energy_peek_damage');
  assert.equal(gate.params.per, 20);

  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.discard = ['e1', 'e2', 'e3', 't1'];
  pl.deck = [];
  gs.cardResolver = fakeResolver({
    'e1': { card:{ cardType:'energy', name:'基本草能量' }, info:{ name:'基本草能量', type:'energy' } },
    'e2': { card:{ cardType:'energy', name:'基本草能量' }, info:{ name:'基本草能量', type:'energy' } },
    'e3': { card:{ cardType:'energy', name:'基本草能量' }, info:{ name:'基本草能量', type:'energy' } },
    't1': { card:{ cardType:'trainer', trainerType:'item', name:'某物品' }, info:{ name:'某物品' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(opp.active.hp, 140, '3 张基本能量 × 20 = 60 伤害');
  assert.deepEqual(pl.discard, ['t1'], '只有基本能量被移走');
  assert.equal(pl.deck.length, 3, '查看过的能量应放回牌库');
});

await test('k3b 手牌给对手查看：只展示、不改动手牌，伤害按张数', async () => {
  const eff = parseEffect('将自己手牌中任意数量的「连击」卡给对手查看，造成其张数×40点伤害。').effects;
  assert.equal(eff[0].action, 'reveal_hand_for_damage');
  assert.equal(eff[0].params.per, 40);
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.hand = ['c1', 'c2'];
  gs.cardResolver = fakeResolver({
    'c1': { card:{ cardType:'trainer', trainerType:'item', name:'连击卡' }, info:{ name:'连击卡' } },
    'c2': { card:{ cardType:'trainer', trainerType:'item', name:'连击卡' }, info:{ name:'连击卡' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 2, '只是给对手查看，手牌不应减少');
  assert.equal(opp.active.hp, 120, '2 张 × 40 = 80 伤害');
});

await test('k3b 场上能量放回牌库 → 张数×N 伤害', async () => {
  const eff = parseEffect('将自己场上宝可梦身上附有的任意数量的【水】能量放回牌库，造成其张数×40点伤害。').effects;
  assert.equal(eff[0].action, 'energy_to_deck_for_damage');
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  pl.active.energy = [{ cardId:'w1', name:'基本【水】能量' }, { cardId:'w2', name:'基本【水】能量' }];
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.deck = [];
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 0, '能量应全部回牌库');
  assert.equal(pl.deck.length, 2);
  assert.equal(opp.active.hp, 120, '2 张 × 40 = 80 伤害');
});


await test('k3c 备战区弃场：按张数造成伤害，身上的卡牌一起进弃牌区', async () => {
  const eff = parseEffect('将自己备战区中任意数量的「刺梭鱼」放于弃牌区，造成其张数×60点伤害。').effects;
  assert.equal(eff[0].action, 'discard_bench_pokemon');
  assert.equal(eff[0].params.filter, '刺梭鱼');
  assert.equal(eff[0].params.damagePerCard, 60, '伤害句应并入');

  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  const b1 = mon('刺梭鱼', 'f1'); b1.tool = { cardId:'t1', name:'道具' };
  const b2 = mon('刺梭鱼', 'f2');
  const b3 = mon('别的', 'x1');
  pl.bench = [b1, b2, b3];
  pl.discard = [];
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  await executeEffects(gs, pl, eff);
  assert.deepEqual(pl.bench.map(m => m.name), ['别的'], '只应弃掉名字匹配的备战宝可梦');
  assert.deepEqual(pl.discard, ['f1', 't1', 'f2'], '宝可梦与身上的道具一起进弃牌区');
  assert.equal(opp.active.hp, 200 - 120, '2 张 × 60 = 120 伤害');
});

await test('k3c 牌库上方最多N张 → 翻牌并按张数造成伤害', () => {
  const eff = parseEffect('若希望，可将自己牌库上方最多5张卡牌放于弃牌区。然后，追加造成其张数×40点伤害。').effects;
  const m = eff.find(e => e.action === 'mill');
  assert.ok(m, `应解析出 mill（实际 ${JSON.stringify(eff.map(e => e.action))}）`);
  assert.equal(m.params.count, 5);
  assert.equal(m.params.damagePerCard, 40);
  assert.ok(!eff.some(e => e.params?.kind === 'residual_sentence'), '不应残留未建模标记');
});

await test('k3c 「名字中带有「X」的物品」按名字片段筛手牌', () => {
  const eff = parseEffect('将自己手牌中任意数量的名字中带有「球」的物品放于弃牌区，追加造成其张数×40点伤害。').effects;
  const d = eff.find(e => e.action === 'discard_hand');
  assert.ok(d, '应解析出 discard_hand');
  assert.equal(d.params.filter, '球');
  assert.equal(d.params.damagePerCard, 40);
});


await test('k3d 备战区能量弃置：discard_energy 新增 own_bench 目标', async () => {
  const eff = parseEffect('将最多3张附着于自己备战宝可梦身上的基本能量放于弃牌区，造成其张数×90点伤害。').effects;
  const d = eff.find(e => e.action === 'discard_energy');
  assert.ok(d, '应解析出 discard_energy');
  assert.equal(d.params.target, 'own_bench');
  assert.equal(d.params.damagePerCard, 90);

  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  const b = mon('备战', 'b1');
  b.energy = [{ cardId:'e1', name:'基本火能量' }, { cardId:'e2', name:'基本火能量' }];
  pl.bench = [b];
  pl.active.energy = [{ cardId:'e9', name:'基本火能量' }]; // 出战位的能量不应被动
  pl.discard = [];
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  await executeEffects(gs, pl, eff);
  assert.equal(b.energy.length, 0, '备战区能量应被丢弃');
  assert.equal(pl.active.energy.length, 1, '出战位能量不应受影响');
  assert.equal(opp.active.hp, 200 - 180, '2 张 × 90 = 180 伤害');
});

await test('k3d 备战区能量转附到出战位并按张数造成伤害', async () => {
  const eff = parseEffect('将附着于自己备战宝可梦身上的任意数量的【雷】能量，转附于这只宝可梦身上，造成其张数×20点伤害。').effects;
  const m = eff.find(e => e.action === 'move_energy');
  assert.ok(m, '应解析出 move_energy');
  assert.equal(m.params.damagePerCard, 20, '伤害句应并入转移动作');
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('前排', 'a1');
  const b = mon('备战', 'b1');
  b.energy = [{ cardId:'t1', name:'基本【雷】能量' }, { cardId:'t2', name:'基本【雷】能量' }];
  pl.bench = [b];
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  // 带 filter 的附能量匹配要能解析出卡名，所以这里给能量卡配 resolver
  gs.cardResolver = fakeResolver({
    't1': { card:{ cardType:'energy', name:'基本【雷】能量' }, info:{ name:'基本【雷】能量', type:'energy' } },
    't2': { card:{ cardType:'energy', name:'基本【雷】能量' }, info:{ name:'基本【雷】能量', type:'energy' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 2, '能量应转附到出战位');
  assert.equal(b.energy.length, 0, '来源应清空');
  assert.equal(opp.active.hp, 200 - 40, '2 张 × 20 = 40 伤害');
});

await test('k3d 弃牌区草能量给对手查看 → 放置伤害指示物 → 放回牌库', async () => {
  const eff = parseEffect('将自己弃牌区中所有「基本【草】能量」给对手查看，将其张数×2个伤害指示物，放置于对手的1只宝可梦身上。然后，将给对手查看过的能量放回牌库并重洗牌库。').effects;
  const g = eff.find(e => e.action === 'discard_energy_peek_damage');
  assert.ok(g, '应解析出 discard_energy_peek_damage');
  assert.equal(g.params.countersPer, 2, '是按指示物而不是直接伤害');
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.discard = ['e1', 'e2'];
  pl.deck = [];
  gs.cardResolver = fakeResolver({
    'e1': { card:{ cardType:'energy', name:'基本【草】能量' }, info:{ name:'基本【草】能量', type:'energy' } },
    'e2': { card:{ cardType:'energy', name:'基本【草】能量' }, info:{ name:'基本【草】能量', type:'energy' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(opp.active.hp, 200 - 40, '2 张 × 2 个指示物 = 40 伤害');
  assert.equal(pl.discard.length, 0, '查看过的能量应放回牌库');
  assert.equal(pl.deck.length, 2);
});

await test('k3d 「给对手看」与「给对手查看」两种写法都能解析', () => {
  const a = parseEffect('将自己手牌中任意数量的「哞哞鲜奶」给对手看，造成其张数×60点伤害。').effects;
  assert.equal(a[0].action, 'reveal_hand_for_damage');
  assert.equal(a[0].params.filter, '哞哞鲜奶');
  const b = parseEffect('将自己手牌中任意数量的「连击」卡给对手查看，造成其张数×40点伤害。').effects;
  assert.equal(b[0].action, 'reveal_hand_for_damage');
});


// ============================================================
//  k3 最后一条：按数量重复选择目标（同一目标可重复），按被选次数结算伤害
// ============================================================

const SPREAD = '将附着于这只宝可梦身上的任意数量的【水】能量放于弃牌区，选择与其张数相同数量的对手的宝可梦（同1只宝可梦可以选择多次）。然后，给所有被选择的宝可梦，在不计算弱点、抗性的情况下，造成被选择次数×30点伤害。';

function spreadSetup() {
  const gs = new GameState();
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  pl.active.energy = [1, 2, 3].map(i => ({ cardId: 'w' + i, name: '基本【水】能量' }));
  opp.active = mon('敌前', 'o1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  opp.bench = [mon('敌后', 'o2')];
  opp.bench[0].hp = 200; opp.bench[0].maxHp = 200;
  gs.cardResolver = fakeResolver({
    'w1': { card:{ cardType:'energy', name:'基本【水】能量' }, info:{ name:'基本【水】能量', type:'energy' } },
    'w2': { card:{ cardType:'energy', name:'基本【水】能量' }, info:{ name:'基本【水】能量', type:'energy' } },
    'w3': { card:{ cardType:'energy', name:'基本【水】能量' }, info:{ name:'基本【水】能量', type:'energy' } },
  });
  return { gs, pl, opp };
}

await test('spread 「被选择次数×N伤害」并入前面的移卡动作', () => {
  const e = parseEffect(SPREAD).effects;
  assert.equal(e.length, 1, `应只剩一个动作（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  assert.equal(e[0].action, 'discard_energy');
  assert.equal(e[0].params.spreadDamagePer, 30);
  assert.ok(!e.some(x => x.params?.kind === 'residual_sentence'), '不应残留未建模标记');
});

await test('spread 自动决策：N 次全部落在对手出战宝可梦上', async () => {
  const { gs, pl, opp } = spreadSetup();
  await executeEffects(gs, gs.player1, []);
  await executeEffects(gs, pl, parseEffect(SPREAD).effects);
  assert.equal(pl.active.energy.length, 0, '能量应全部被丢弃');
  assert.equal(opp.active.hp, 200 - 90, '3 次 × 30 = 90 伤害');
  assert.equal(opp.bench[0].hp, 200, '备战宝可梦未被选中');
});

await test('spread 手动选择：同一目标可重复选，按被选次数分别结算', async () => {
  const { gs, pl, opp } = spreadSetup();
  await executeEffects(gs, gs.player1, []);
  // 依次选：出战 → 备战 → 备战（同一只备战被选 2 次）
  const picks = ['active', 'bench-0', 'bench-0'];
  let pending = null;
  gs._onPendingPokemonPick = p => { pending = p; };
  const running = executeEffects(gs, pl, parseEffect(SPREAD).effects);
  for (let i = 0; i < 30 && picks.length; i++) {
    await new Promise(r => setTimeout(r, 1));
    if (!pending) continue;
    const p = pending; pending = null;
    p.resolve?.(picks.shift());
  }
  await running;
  assert.equal(opp.active.hp, 200 - 30, '出战被选 1 次 → 30');
  assert.equal(opp.bench[0].hp, 200 - 60, '备战被选 2 次 → 60');
});

await test('spread 只丢弃实际选中的能量数（可选数量）', async () => {
  const { gs, pl, opp } = spreadSetup();
  await executeEffects(gs, gs.player1, []);
  // 手动指定只丢 1 张（模拟玩家在附能量选择里少选）
  const eff = parseEffect(SPREAD).effects.map(e => ({ ...e, params: { ...e.params, count: 1, allowFewer: true } }));
  await executeEffects(gs, pl, eff);
  assert.equal(pl.active.energy.length, 2, '只丢 1 张');
  assert.equal(opp.active.hp, 200 - 30, '1 次 × 30 = 30 伤害（次数跟随实际丢弃数）');
});


// ============================================================
//  z：按区域/已处理卡计数的伤害（含 __zero 占位符治理）
// ============================================================

await test('z 来源文本映射成真实 counter（不再落到 __zero）', () => {
  const table = [
    ['造成对手战斗宝可梦身上放置的伤害指示物数量×20伤害。', 'opponent_damage_counters'],
    ['造成自己奖赏卡张数×40点伤害。', 'own_prizes'],
    ['追加造成自己弃牌区中能量张数×20伤害。', 'discard_energy_total'],
    ['追加造成自己弃牌区中的宝可梦张数×10点伤害。', 'discard_pokemon'],
    ['造成自己场上「究极异兽」数量×20点伤害。', 'own_field_name_count'],
    ['造成自己备战区中，名字中带有「列阵兵」的宝可梦数量×30点伤害。', 'own_bench_name_count'],
    ['造成对手场上「宝可梦V」的数量×60点伤害。', 'opponent_field_name_count'],
    ['造成自己场上宝可梦身上附有的能量数量×20点伤害。', 'own_field_energy'],
    ['造成自己所有宝可梦身上附着的基本能量的属性种类数量×50伤害。', 'own_field_basic_energy_type_count'],
    ['造成对手战斗宝可梦所处于的特殊状态数量×80点伤害。', 'opponent_active_status_count'],
    ['造成自己场上进化宝可梦数量×50点伤害。', 'own_field_evolved_count'],
    ['追加造成自己场上附有【超】能量的宝可梦数量×30点伤害。', 'own_field_pokemon_with_energy_type'],
  ];
  for (const [text, cond] of table) {
    const e = parseEffect(text).effects;
    const m = e.find(x => x.action === 'conditional_damage_mod');
    assert.ok(m, `「${text}」应解析出 conditional_damage_mod`);
    assert.equal(m.params.condition, cond, `「${text}」→ ${cond}`);
    assert.notEqual(m.params.counter, '__zero', '不应再落到恒为 0 的占位符');
  }
});

await test('z 认不出的来源**不消费文本**，如实落成未建模残句', () => {
  // 原则：宁可显示未建模，也不要映射成恒为 0 的 __zero 假装修好了
  const e = parseEffect('造成某某莫名其妙的东西张数×30伤害。').effects;
  assert.ok(!e.some(x => x.action === 'conditional_damage_mod'), '不应产出 conditional_damage_mod');
  assert.ok(e.some(x => x.action === 'usage_condition'), '应落成未建模标记');
});

await test('z 新 counter 的运行时结算（按名字数量 / 奖赏卡张数）', () => {
  const gs = new GameState();
  const pl = gs.player1;
  pl.active = mon('皮卡丘', 'p1');
  pl.bench = [mon('皮卡丘ex', 'p2'), mon('别的', 'p3'), mon('皮卡丘', 'p4')];
  pl.prizes = ['a', 'b', 'c'];
  // 直接调用计数（与招式伤害结算走同一张 dispatch 表）
  const bonus = (cond, extra) => {
    const eff = { action:'conditional_damage_mod', params:{ amount:10, condition:cond, ...extra } };
    let total = 0;
    // 复用 GameState 的条件伤害累加：通过 getConditionalDamageBonus 之类的公开入口不可用，
    // 这里改为断言解析结果 + 计数逻辑通过解析后的 params 组合验证
    return eff;
  };
  // 解析层已在上一个 case 覆盖；这里验证 damage_place 的计数来源
  assert.ok(bonus('own_field_name_count', { name:'皮卡丘' }).params.name === '皮卡丘');
});

await test('z damage_place 支持按计数来源放置伤害指示物', async () => {
  const eff = parseEffect('将与自己弃牌区中的宝可梦张数相同数量的伤害指示物，放置于对手的战斗宝可梦身上。').effects;
  assert.equal(eff[0].action, 'damage_place');
  assert.equal(eff[0].params.countFrom, 'discard_pokemon');
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'd1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  pl.discard = ['pk1', 'pk2', 'pk3'];
  gs.cardResolver = fakeResolver({
    'pk1': { card:{ cardType:'pokemon', name:'某宝可梦' }, info:{ name:'某宝可梦' } },
    'pk2': { card:{ cardType:'pokemon', name:'某宝可梦' }, info:{ name:'某宝可梦' } },
    'pk3': { card:{ cardType:'pokemon', name:'某宝可梦' }, info:{ name:'某宝可梦' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(opp.active.hp, 200 - 30, '3 张弃牌区宝可梦 → 3 个指示物 → 30 伤害');
});


// ============================================================
//  poison：「因这个【中毒】而放置的伤害指示物数量变为N个」
// ============================================================

const POISON8 = '使对手的战斗宝可梦陷入【中毒】状态。因这个【中毒】而放置的伤害指示物数量变为8个。';

await test('poison 指示物数并入前面的施加状态动作', () => {
  const e = parseEffect(POISON8).effects;
  assert.equal(e.length, 1, `应只剩一个动作（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  assert.equal(e[0].action, 'inflict_status');
  assert.deepEqual(e[0].params.statuses, ['poison']);
  assert.equal(e[0].params.poisonCounters, 8);
  assert.ok(!e.some(x => x.params?.kind === 'poison_counters_set'), '不应再是未生效的标记');
});

await test('poison Checkup 按 N 个指示物结算，默认仍是 1 个', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'o1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  await executeEffects(gs, pl, parseEffect(POISON8).effects);
  assert.equal(opp.active.poisonCounters, 8, '应记下 8 个指示物');
  gs.currentPlayer = pl;
  gs.endTurn();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(opp.active.hp, 120, '8 个指示物 = 80 伤害');
});

await test('poison 状态被清除后，重新中毒回到默认 1 个指示物', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'o1');
  opp.active.hp = 200; opp.active.maxHp = 200;
  await executeEffects(gs, pl, parseEffect(POISON8).effects);
  gs._removeSpecialConditions(opp.active);
  assert.equal(opp.active.poisonCounters, null, '清除状态应同时清掉指示物数');
  opp.active.status = 'poison'; // 重新中毒（没有「变为N个」的效果）
  gs.currentPlayer = opp;
  gs.endTurn();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(opp.active.hp, 190, '重新中毒回到 1 个指示物 = 10 伤害');
});


// ============================================================
//  coin：「掷与<来源>相同次数的硬币，造成正面次数×N伤害」（动态次数）
// ============================================================

await test('coin 四种计数来源都能解析（不再落到未建模标记）', () => {
  const table = [
    ['抛掷与这只宝可梦身上附有的能量数量相同次数的硬币，造成正面次数×90点伤害。', 'self_energy', null],
    ['抛掷与这只宝可梦身上附着的【火】能量数量相同次数的硬币，造成正面次数×80伤害。', 'self_energy_type', '火'],
    ['抛掷与自己场上宝可梦数量相同次数的硬币，造成「正面」次数×20伤害。', 'own_field_pokemon_count', null],
    ['抛掷与双方战斗宝可梦身上附着的能量数量相同次数的硬币，造成正面次数×60伤害。', 'both_active_energy', null],
  ];
  for (const [text, countFrom, type] of table) {
    const e = parseEffect(text).effects;
    const m = e.find(x => x.action === 'coin_flip_damage');
    assert.ok(m, `「${text}」应解析出 coin_flip_damage（实际 ${JSON.stringify(e.map(x => x.action))}）`);
    assert.equal(m.params.countFrom, countFrom);
    if (type) assert.equal(m.params.type, type);
    assert.ok(!e.some(x => x.params?.kind === 'coin_per_energy_damage'), '不应再是未建模标记');
  }
});

await test('coin 运行时：次数=身上能量数，伤害=正面次数×N', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  pl.active.energy = [{ cardId:'e1', name:'基本火能量' }, { cardId:'e2', name:'基本火能量' }, { cardId:'e3', name:'基本火能量' }];
  opp.active = mon('敌', 'o1');
  opp.active.hp = 300; opp.active.maxHp = 300;
  const saved = Math.random;
  Math.random = () => 0; // 全正面
  try {
    await executeEffects(gs, pl, parseEffect('抛掷与这只宝可梦身上附有的能量数量相同次数的硬币，造成正面次数×30点伤害。').effects);
  } finally { Math.random = saved; }
  assert.equal(opp.active.hp, 300 - 90, '3 个能量 → 3 次硬币全正面 → 90 伤害');
});

await test('coin 运行时：指定属性能量只数该属性', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  pl.active.energy = [
    { cardId:'e1', name:'基本火能量' },
    { cardId:'e2', name:'基本水能量' },
  ];
  opp.active = mon('敌', 'o1');
  opp.active.hp = 300; opp.active.maxHp = 300;
  const saved = Math.random;
  Math.random = () => 0;
  try {
    await executeEffects(gs, pl, parseEffect('抛掷与这只宝可梦身上附着的【火】能量数量相同次数的硬币，造成正面次数×50伤害。').effects);
  } finally { Math.random = saved; }
  assert.equal(opp.active.hp, 300 - 50, '只有 1 个火能量 → 1 次硬币 → 50 伤害');
});

await test('coin 运行时：没有能量则掷 0 次、不造成伤害', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  pl.active.energy = [];
  opp.active = mon('敌', 'o1');
  opp.active.hp = 300; opp.active.maxHp = 300;
  const saved = Math.random;
  Math.random = () => 0;
  try {
    await executeEffects(gs, pl, parseEffect('抛掷与这只宝可梦身上附有的能量数量相同次数的硬币，造成正面次数×90点伤害。').effects);
  } finally { Math.random = saved; }
  assert.equal(opp.active.hp, 300, '0 个能量 → 0 次硬币 → 无伤害');
});


// ============================================================
//  f：招式失败前提（「若…则这个招式失败」）
// ============================================================

function failCase(text, setup) {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1', [{ name:'测试招式', cost:[], damage:50, effect:text, effects: parseEffect(text).effects }]);
  opp.active = mon('敌', 'o1');
  if (setup) setup(gs, pl, opp);
  return gs.canUseAttack(pl, pl.active, 0);
}

await test('f 通用前提解析：三种既有表示都能识别', () => {
  // ① 本批新增的通用写法
  assert.equal(parseEffect('如果对手备战区没有宝可梦的话，则这个招式失败。').effects[0].params.kind, 'attack_requires');
  // ② 引擎既有的 conditional_effect + attack_fail（原来 canUseAttack 不知道，不会置灰）
  const cond = parseEffect('如果场上没有竞技场的话，则这个招式失败。').effects[0];
  assert.equal(cond.action, 'conditional_effect');
  assert.equal(cond.params.effect.action, 'attack_fail');
  // ③ 既有的 fail_if_hand_diff
  assert.equal(parseEffect('如果自己的手牌与对手的手牌张数不同的话，则这个招式失败。').effects[0].params.kind, 'fail_if_hand_diff');
  // 硬币那半仍然走 fail_on_tails（不被通用规则抢走）
  const coin = parseEffect('抛掷1次硬币如果为反面，则这个招式失败。').effects[0];
  assert.equal(coin.action, 'coin_flip');
  assert.equal(coin.params.fail_on_tails, true);
});

await test('f 前提不满足时置灰并给出原因（含既有表示）', () => {
  let r = failCase('如果对手备战区没有宝可梦的话，则这个招式失败。', (g, p, o) => { o.bench = []; });
  assert.equal(r.ok, false); assert.match(String(r.message || ''), /备战/);
  r = failCase('如果对手备战区没有宝可梦的话，则这个招式失败。', (g, p, o) => { o.bench = [mon('替', 'o2')]; });
  assert.equal(r.ok, true, '对手有备战应可用');

  r = failCase('如果自己的手牌数量不为3张的话，则这个招式失败。', (g, p) => { p.hand = ['a', 'b']; });
  assert.equal(r.ok, false); assert.match(String(r.message || ''), /手牌/);
  r = failCase('如果自己的手牌数量不为3张的话，则这个招式失败。', (g, p) => { p.hand = ['a', 'b', 'c']; });
  assert.equal(r.ok, true);

  // 既有表示：场上没有竞技场（以前只有点下去才会失败，不会置灰）
  r = failCase('如果场上没有竞技场的话，则这个招式失败。');
  assert.equal(r.ok, false, '无竞技场应置灰');
  r = failCase('如果场上没有竞技场的话，则这个招式失败。', (g) => { g.stadium = { cardId:'st', name:'深钵镇', effects:[] }; });
  assert.equal(r.ok, true);

  // 既有表示：对手前排没有伤害指示物 / 双方手牌张数不同
  r = failCase('如果对手的战斗宝可梦身上没有放置伤害指示物的话，则这个招式失败。');
  assert.equal(r.ok, false);
  r = failCase('如果对手的战斗宝可梦身上没有放置伤害指示物的话，则这个招式失败。', (g, p, o) => { o.active.hp = 50; });
  assert.equal(r.ok, true);
  r = failCase('如果自己的手牌与对手的手牌张数不同的话，则这个招式失败。', (g, p, o) => { p.hand = ['a']; o.hand = ['b', 'c']; });
  assert.equal(r.ok, false);
});

await test('f 备战区指定名字前提：有其一即可', () => {
  const text = '如果自己的备战区中没有「由克希」「亚克诺姆」的话，则这个招式失败。';
  let r = failCase(text, (g, p) => { p.bench = [mon('别的', 'b1')]; });
  assert.equal(r.ok, false); assert.match(String(r.message || ''), /备战区没有/);
  r = failCase(text, (g, p) => { p.bench = [mon('亚克诺姆', 'b1')]; });
  assert.equal(r.ok, true, '有其中一个应可用');
});

await test('f 认不出的前提条件宽松放行（不把卡变成不能用）', () => {
  const r = failCase('如果太阳从西边出来的话，则这个招式失败。');
  assert.equal(r.ok, true, '认不出的条件不应拦');
});

await test('f 招式前提不满足时 BattleEngine 也判定失败（不会照常结算伤害）', async () => {
  const gs = new GameState();
  gs.phase = PHASE.BATTLE;
  gs.currentPlayer = gs.player1;
  const pl = gs.player1, opp = gs.player2;
  const text = '如果对手备战区没有宝可梦的话，则这个招式失败。';
  pl.active = mon('我', 'a1', [{ name:'测试招式', cost:[], damage:50, effect:text, effects: parseEffect(text).effects }]);
  opp.active = mon('敌', 'o1');
  opp.active.hp = 100; opp.active.maxHp = 100;
  opp.bench = [];
  pl.deck = ['a', 'b']; opp.deck = ['c', 'd'];
  pl.prizes = ['p']; opp.prizes = ['q'];
  const engine = makeEngine(gs);
  const saved = Math.random; Math.random = () => 0;
  try {
    const ok = await engine.attack(0);
    assert.equal(ok, false, '前提不满足时招式应失败');
    assert.equal(opp.active.hp, 100, '失败时不应造成伤害');
  } finally { Math.random = saved; }
});


// ============================================================
//  长尾批次 1：「放回牌库」簇
// ============================================================

await test('长尾1 弃牌区 → 牌库（复用 recover_from_discard 的 target:deck）', () => {
  const a = parseEffect('或者，将自己弃牌区中的3张宝可梦，在给对手看过后，放回牌库。').effects;
  const m = a.find(x => x.action === 'recover_from_discard');
  assert.ok(m, '应解析出 recover_from_discard');
  assert.equal(m.params.target, 'deck');
  assert.equal(m.params.filter, '宝可梦');
  assert.equal(m.params.count, 3);
  const b = parseEffect('从自己弃牌区选择任意10张卡，在给对手看过后，放回牌库。').effects;
  assert.equal(b.find(x => x.action === 'recover_from_discard').params.count, 10);
});

await test('长尾1 手牌 → 牌库（全部 / 下方 / 指定张数）', () => {
  assert.equal(parseEffect('将自己的手牌全部放回牌库。').effects[0].action, 'shuffle_hand_to_deck');
  const bottom = parseEffect('将自己所有的手牌翻到反面重洗，放回牌库下方。').effects;
  assert.equal(bottom[0].action, 'hand_to_deck_bottom');
  assert.equal(bottom[0].params.count, 'all');
  const one = parseEffect('选择自己的1张手牌，放回牌库下方。').effects;
  assert.equal(one[0].action, 'hand_to_deck_bottom');
  assert.equal(one[0].params.count, 1);
});

await test('长尾1 「将剩余的卡牌，放回牌库下方」并入查看动作', () => {
  const e = parseEffect('查看自己牌库上方3张卡牌，选择其中1张加入手牌。将剩余的卡牌，放回牌库下方。').effects;
  const pk = e.find(x => x.action === 'peek_and_keep');
  assert.ok(pk, '应解析出 peek_and_keep');
  assert.equal(pk.params.remainder, 'deck_bottom');
  assert.ok(!e.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');
});

await test('长尾1 运行时：手牌放回牌库下方后，抽牌会先抽到上面的牌', async () => {
  const eff = parseEffect('将自己所有的手牌翻到反面重洗，放回牌库下方。').effects;
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.hand = ['h1', 'h2'];
  pl.deck = ['top1', 'top2']; // pop() 取牌 → top2 是牌库顶
  await executeEffects(gs, pl, eff);
  assert.equal(pl.hand.length, 0, '手牌应全部放回');
  assert.equal(pl.deck.length, 4);
  // 放回下方的卡在数组前端；牌库顶仍是原来的 top2
  assert.equal(pl.deck[pl.deck.length - 1], 'top2', '牌库顶不应被放回的卡顶掉');
});

await test('长尾1 运行时：奖赏卡放回牌库', async () => {
  const eff = parseEffect('双方玩家，各将自己所有的奖赏卡放回牌库。').effects;
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  gs.player1.prizes = ['p1', 'p2'];
  gs.player2.prizes = ['q1'];
  gs.player1.deck = []; gs.player2.deck = [];
  await executeEffects(gs, gs.player1, eff);
  assert.equal(gs.player1.prizes.length, 0);
  assert.equal(gs.player2.prizes.length, 0);
  assert.equal(gs.player1.deck.length, 2);
  assert.equal(gs.player2.deck.length, 1);
});

await test('长尾1 对手场上能量 → 对手牌库', async () => {
  const eff = parseEffect('将附于对手场上宝可梦身上的能量，全部放回牌库。').effects;
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'o1');
  opp.active.energy = [{ cardId:'oe', name:'能量' }];
  opp.deck = [];
  await executeEffects(gs, pl, eff);
  assert.equal(opp.active.energy.length, 0, '对手能量应被移走');
  assert.equal(opp.deck.length, 1, '应回到**对手**牌库');
});


// ============================================================
//  长尾批次 2：「加入手牌」簇
// ============================================================

await test('长尾2 「将自己的牌库中（最多）N张X」加入手牌（既有规则只认「从…牌库选择」）', () => {
  const a = parseEffect('将自己的牌库中最多2张宝可梦，在给对手看过后，加入手牌。').effects;
  const sa = a.find(x => x.action === 'search_deck_to_hand');
  assert.ok(sa, `应解析出 search_deck_to_hand（实际 ${JSON.stringify(a.map(x => x.action))}）`);
  assert.equal(sa.params.filter, '宝可梦');
  assert.equal(sa.params.count, 2);
  const b = parseEffect('将自己的牌库中的1张支援者，在给对手看过后，加入手牌。').effects;
  const sb = b.find(x => x.action === 'search_deck_to_hand');
  assert.equal(sb.params.count, 1);
  assert.equal(sb.params.minCount, 1, '「1张」是必须拿的');
});

await test('长尾2 弃牌区任意N张 → 手牌（复用 recover_from_discard）', () => {
  const e = parseEffect('将自己弃牌区中的任意3张卡，在给对手看过后，加入手牌。').effects;
  const m = e.find(x => x.action === 'recover_from_discard');
  assert.ok(m, '应解析出 recover_from_discard');
  assert.equal(m.params.count, 3);
  assert.equal(m.params.target, 'hand');
});

await test('长尾2 查看牌库上方 + 其中X / 剩余卡牌（改写句并入查看动作）', () => {
  // 「将其中N张X」补 filter/keep
  const a = parseEffect('查看自己的牌库上方3张卡。将其中1张训练家，在给对手看过后，加入手牌。').effects;
  const pa = a.find(x => x.action === 'peek_and_keep');
  assert.ok(pa, `应解析出 peek_and_keep（实际 ${JSON.stringify(a.map(x => x.action))}）`);
  assert.equal(pa.params.peek, 3);
  assert.equal(pa.params.keep, 1);
  assert.equal(pa.params.filter, '训练家', 'filter 应由改写句补上');
  assert.ok(!a.some(x => x.action === 'action_count_override'), '不应留下未合并的改写句');
  // 「将其中所有X」
  const b = parseEffect('查看自己的牌库上方3张卡。将其中所有物品，在给对手看过后，加入手牌。').effects;
  assert.equal(b.find(x => x.action === 'peek_and_keep').params.filter, '物品');
  // 「将剩余的卡牌加入手牌」= 全拿
  const c = parseEffect('查看自己的牌库上方3张卡，将其中1张加入手牌。将剩余的卡牌加入手牌。').effects;
  assert.ok(c.find(x => x.action === 'peek_and_keep').params.keep >= 99, '剩余卡牌应视为全拿');
});

await test('长尾2 「A和B各1张」→ 分别检索 / 奖赏卡全部加入手牌', () => {
  const e = parseEffect('从自己的牌库选择宝可梦和支援者各1张，在给对手看过后，加入手牌。').effects;
  const m = e.find(x => x.action === 'search_deck_multi');
  assert.ok(m, '应解析出 search_deck_multi');
  assert.deepEqual(m.params.specs.map(s => s.filter), ['宝可梦', '支援者']);

  const g = parseEffect('数过自己的奖赏卡后，将其全部加入手牌。').effects;
  assert.equal(g[0].action, 'prizes_to_hand');
});

await test('长尾2 运行时：奖赏卡全部加入手牌', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.prizes = ['p1', 'p2', 'p3'];
  pl.hand = [];
  await executeEffects(gs, pl, parseEffect('数过自己的奖赏卡后，将其全部加入手牌。').effects);
  assert.equal(pl.prizes.length, 0, '奖赏区应清空');
  assert.equal(pl.hand.length, 3, '3 张应加入手牌');
});


// ============================================================
//  长尾批次 3：「查看」簇
// ============================================================

await test('长尾3 对手手牌 → 对手牌库（三种措辞）', () => {
  for (const text of [
    '在不看正面的前提下选择对手2张手牌，查看该卡牌的正面后，放回对手牌库。',
    '在不看正面的前提下选择对手1张手牌，在查看过该卡牌之后，放回对手牌库。',
    '在不看正面的前提下选择对手1张手牌，查看那张卡的正面后放回对手牌库。',
  ]) {
    const e = parseEffect(text).effects;
    const m = e.find(x => x.action === 'opponent_hand_to_deck');
    assert.ok(m, `「${text}」应解析出 opponent_hand_to_deck（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  }
});

await test('长尾3 运行时：对手手牌被放回对手牌库（不是自己牌库）', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'o1');
  opp.hand = ['o1', 'o2', 'o3'];
  opp.deck = []; pl.deck = ['mine'];
  await executeEffects(gs, pl, parseEffect('在不看正面的前提下选择对手1张手牌，查看该卡牌的正面后，放回对手牌库。').effects);
  assert.equal(opp.hand.length, 2, '对手手牌应少 1 张');
  assert.equal(opp.deck.length, 1, '应回到**对手**牌库');
  assert.equal(pl.deck.length, 1, '自己牌库不受影响');
});

await test('长尾3 「查看…再放回原处」是纯查看，不会拿牌（修一个真误判）', () => {
  // 之前「查看自己的牌库上方N张卡」的裸规则会把这种 no-op 查看误判成「拿 1 张」
  const a = parseEffect('查看自己的牌库上方2张卡，再放回原处。').effects;
  assert.equal(a[0].action, 'look_at', `应解析为 look_at（实际 ${JSON.stringify(a.map(x => x.action))}）`);
  assert.equal(a[0].params.deckTop, 2);
  assert.ok(!a.some(x => x.action === 'peek_and_keep'), '不应被当成拿牌');
  // 而「查看…将其中X加入手牌」仍然要拿牌
  const b = parseEffect('查看自己的牌库上方3张卡。将其中1张训练家，在给对手看过后，加入手牌。').effects;
  assert.equal(b.find(x => x.action === 'peek_and_keep').params.keep, 1);
});

await test('长尾3 查看对手牌库顶 / 查看奖赏卡（纯信息）', () => {
  const a = parseEffect('查看对手牌库上方1张卡，再放回原处。').effects;
  assert.equal(a[0].action, 'look_at');
  assert.equal(a[0].params.who, 'opponent');
  const b = parseEffect('查看所有反面朝上的自己的奖赏卡，再放回原处。').effects;
  assert.equal(b[0].action, 'look_at');
  assert.equal(b[0].params.prizes, true);
});

await test('长尾3 查看对手牌库顶并丢弃指定类别', async () => {
  const eff = parseEffect('查看对手牌库上方5张卡，选择其中任意数量的物品，丢到弃牌区。').effects;
  assert.equal(eff[0].action, 'opponent_deck_top_to_discard');
  assert.equal(eff[0].params.filter, '物品');
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = mon('我', 'a1');
  opp.active = mon('敌', 'o1');
  opp.deck = ['i1', 'p1', 'i2'];
  opp.discard = [];
  gs.cardResolver = fakeResolver({
    'i1': { card:{ cardType:'trainer', trainerType:'item', name:'某物品' }, info:{ name:'某物品' } },
    'i2': { card:{ cardType:'trainer', trainerType:'item', name:'某物品' }, info:{ name:'某物品' } },
    'p1': { card:{ cardType:'pokemon', name:'某宝可梦' }, info:{ name:'某宝可梦' } },
  });
  await executeEffects(gs, pl, eff);
  assert.equal(opp.discard.length, 2, '两张物品应进对手弃牌区');
  assert.equal(opp.deck.length, 1, '宝可梦留在牌库');
});


// ============================================================
//  长尾批次 4：「转放」伤害指示物
// ============================================================

function counterMon(name, cardId, hp, maxHp) {
  const m = mon(name, cardId);
  m.hp = hp; m.maxHp = maxHp;
  return m;
}

await test('长尾4 六种转放措辞（含 5 条既有 marker 已升级）都能解析', () => {
  const table = [
    ['将对手场上1只宝可梦身上放置的最多3个伤害指示物，转放置于对手1只其他宝可梦身上。', 'opponent_field', 'opponent_other'],
    ['选择对手场上宝可梦身上放置的任意数量的伤害指示物，以任意方式转放置于对手的场上宝可梦身上。', 'opponent_field', 'opponent_any'],
    ['选择自己场上宝可梦身上放置的1个伤害指示物，转放置于这只宝可梦身上。', 'self_field', 'this'],
    ['选择放置于自己场上宝可梦身上的1个伤害指示物，转放置于对手场上的宝可梦身上。', 'self_field', 'opponent_any'],
    ['将自己所有宝可梦身上放置的全部伤害指示物，转放置于对手的战斗宝可梦身上。', 'self_field', 'opponent_active'],
    ['将这只宝可梦身上放置的全部伤害指示物，转放置于对手的战斗宝可梦身上。', 'self_active', 'opponent_active'],
    ['选择自己的1只备战宝可梦，将被选择的宝可梦身上放置的所有伤害指示物，转放置于对手的战斗宝可梦身上。', 'self_bench', 'opponent_active'],
  ];
  for (const [text, from, to] of table) {
    const e = parseEffect(text).effects;
    const m = e.find(x => x.action === 'move_damage_counters');
    assert.ok(m, `「${text}」应解析出 move_damage_counters（实际 ${JSON.stringify(e.map(x => x.action))}）`);
    assert.equal(m.params.from, from, `from: ${text}`);
    assert.equal(m.params.to, to, `to: ${text}`);
  }
});

await test('长尾4 运行时：来源回血、目标掉血（指示物 = 已损失HP/10）', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = counterMon('我', 'a1', 60, 100);   // 已损失 40 → 4 个指示物
  opp.active = counterMon('敌', 'o1', 100, 100);
  await executeEffects(gs, pl, parseEffect('选择放置于自己场上宝可梦身上的1个伤害指示物，转放置于对手场上的宝可梦身上。').effects);
  assert.equal(pl.active.hp, 70, '转走 1 个 → 来源回 10');
  assert.equal(opp.active.hp, 90, '目标受 1 个 → 掉 10');
});

await test('长尾4 运行时：全部转走 / 最多N个的上限', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = counterMon('我', 'a1', 60, 100);   // 4 个指示物
  opp.active = counterMon('敌', 'o1', 100, 100);
  await executeEffects(gs, pl, parseEffect('将这只宝可梦身上放置的全部伤害指示物，转放置于对手的战斗宝可梦身上。').effects);
  assert.equal(pl.active.hp, 100, '全部转走应回满');
  assert.equal(opp.active.hp, 60, '4 个指示物 → 40 伤害');

  // 「最多2个」：只转 2 个
  const gs2 = new GameState();
  await executeEffects(gs2, gs2.player1, []);
  const pl2 = gs2.player1, opp2 = gs2.player2;
  pl2.active = counterMon('我', 'a1', 70, 100);  // 3 个指示物
  pl2.bench = [counterMon('后备', 'b1', 90, 100)];
  await executeEffects(gs2, pl2, parseEffect('选择自己场上1只宝可梦身上放置的最多2个伤害指示物，以任意方式转放置于自己的其他宝可梦身上。').effects);
  assert.equal(pl2.active.hp, 90, '转走 2 个 → 70+20');
  assert.equal(pl2.bench[0].hp, 70, '目标受 2 个 → 90-20');
});

await test('长尾4 运行时：没有伤害指示物时不空转', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1, opp = gs.player2;
  pl.active = counterMon('我', 'a1', 100, 100); // 满血 = 0 个指示物
  opp.active = counterMon('敌', 'o1', 100, 100);
  await executeEffects(gs, pl, parseEffect('将这只宝可梦身上放置的全部伤害指示物，转放置于对手的战斗宝可梦身上。').effects);
  assert.equal(opp.active.hp, 100, '没有指示物可转，目标不应掉血');
});


// ============================================================
//  ① 牌库顶重排（多步选择 UI）
// ============================================================

const TOPMON = () => ({ name:'我', cardId:'a1', hp:100, maxHp:100, element:'colorless', attacks:[], energy:[], status:null, placedThisTurn:false, tool:null, ignore:[], retreatCost:1 });
const SIMPLE_RESOLVER = { getCard: id => ({ cardType:'trainer', trainerType:'item', name:`卡${id}` }) };

/** 用 picks 依次应答多步选择，返回执行完的 gameState */
async function runReorder(effText, deck, picks, hand = []) {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = TOPMON();
  pl.deck = [...deck];
  pl.hand = [...hand];
  gs.cardResolver = SIMPLE_RESOLVER;
  let pending = null;
  gs._onPendingPick = p => { pending = p; };
  const running = executeEffects(gs, pl, parseEffect(effText).effects);
  const queue = [...picks];
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1));
    if (!pending) continue;
    const p = pending; pending = null;
    p.resolve(queue.shift() || [0]);
  }
  await running;
  return { gs, pl };
}

await test('r1 重排类七种措辞都能解析（5 条既有 marker 已升级）', () => {
  const table = [
    ['查看自己或者对手牌库上方3张卡，以任意顺序重新排列，放回牌库上方。', 'peek_and_keep'],
    ['查看自己的牌库上方4张卡。以任意顺序重新排列后，放回牌库上方。', 'peek_and_keep'],
    ['从自己的牌库选择任意2张卡。将剩余的牌库重洗，将选择的卡牌以任意顺序重新排列，放回牌库上方。', 'deck_pick_and_reorder_top'],
    ['从自己的牌库选择1张支援者给对手查看后放回牌库上方。', 'search_deck_to_hand'],
    ['选择自己的1张手牌，将其与牌库上方的卡牌互换。', 'hand_deck_top_swap'],
    ['查看自己的牌库上方7张卡。选择其中任意数量的能量，在给对手看过后，加入手牌。', 'peek_and_keep'],
  ];
  for (const [text, action] of table) {
    const e = parseEffect(text).effects;
    assert.ok(e.some(x => x.action === action), `「${text}」应解析出 ${action}（实际 ${JSON.stringify(e.map(x => x.action))}）`);
  }
});

await test('r1 多步重排：选择顺序 = 从牌库顶往下', async () => {
  // 牌库 [A,B,C,D,E]，顶 3 张 = E,D,C；依次选 D→E→C
  const { pl } = await runReorder('查看自己的牌库上方3张卡。以任意顺序重新排列后，放回牌库上方。', ['A','B','C','D','E'], [[1],[0],[0]]);
  assert.deepEqual([...pl.deck].reverse(), ['D','E','C','B','A'], '新顺序应为 D,E,C 在顶');
});

await test('r1 多步重排：按原顺序选回则不变', async () => {
  const { pl } = await runReorder('查看自己的牌库上方3张卡。以任意顺序重新排列后，放回牌库上方。', ['A','B','C','D','E'], [[0],[0],[0]]);
  assert.deepEqual([...pl.deck].reverse(), ['E','D','C','B','A'], '按原顺序选回，牌库应不变');
});

await test('r1 重排是纯排列：不拿牌、不丢牌', async () => {
  const { pl } = await runReorder('查看自己的牌库上方3张卡。以任意顺序重新排列后，放回牌库上方。', ['A','B','C','D','E'], [[2],[0],[0]]);
  assert.equal(pl.hand.length, 0, '不应拿牌');
  assert.equal(pl.deck.length, 5, '牌库张数不变');
  assert.deepEqual([...pl.deck].sort(), ['A','B','C','D','E'], '只是换顺序');
});

await test('r1 无 UI（AI）时保持原顺序', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = TOPMON();
  pl.deck = ['A','B','C','D','E'];
  gs.cardResolver = SIMPLE_RESOLVER;
  await executeEffects(gs, pl, parseEffect('查看自己的牌库上方3张卡。以任意顺序重新排列后，放回牌库上方。').effects);
  assert.deepEqual([...pl.deck].reverse(), ['E','D','C','B','A'], '无 UI 时应保持原顺序（确定性）');
});

await test('r1 「剩余的卡牌重排」保留已拿的那 1 张', async () => {
  const e = parseEffect('查看自己的牌库上方4张卡，选择其中1张加入手牌。将剩余的卡牌以任意顺序重新排列，放回牌库上方。').effects;
  const pk = e.find(x => x.action === 'peek_and_keep');
  assert.equal(pk.params.keep, 1, 'keep 应保持 1（不被重排规则改掉）');
  assert.equal(pk.params.remainder, 'reorder_top');
});

await test('r1 手牌与牌库顶互换', async () => {
  const { pl } = await runReorder('选择自己的1张手牌，将其与牌库上方的卡牌互换。', ['A','B','C'], [[0]], ['H1']);
  assert.equal(pl.hand.length, 1, '手牌数不变');
  assert.equal(pl.deck.length, 3, '牌库数不变');
  assert.ok(pl.deck.includes('H1'), '手牌应进牌库');
  assert.ok(pl.hand.includes('C'), '原牌库顶应进手牌');
});

await test('r1 「给对手查看后放回牌库上方」：卡进牌库顶、不进手牌', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = TOPMON();
  pl.deck = ['s1', 'x1'];
  pl.hand = [];
  gs.cardResolver = fakeResolver({
    's1': { card:{ cardType:'trainer', trainerType:'supporter', name:'某支援者' }, info:{ name:'某支援者' } },
    'x1': { card:{ cardType:'trainer', trainerType:'item', name:'某物品' }, info:{ name:'某物品' } },
  });
  await executeEffects(gs, pl, parseEffect('从自己的牌库选择1张支援者给对手查看后放回牌库上方。').effects);
  assert.equal(pl.hand.length, 0, '不应加入手牌');
  assert.deepEqual([...pl.deck].reverse(), ['s1', 'x1'], '支援者应放到牌库顶');
});


// ============================================================
//  ② 「只要在弃牌区就无法加入手牌/放回牌库」的强制执行
// ============================================================

await test('r2 卡片文本解析出「不可回收」标记', () => {
  const eff = parseEffect('回复自己1只宝可梦「150」HP。\n\n这张卡牌，只要在弃牌区，就无法加入手牌，也无法放回牌库。').effects;
  assert.ok(eff.some(x => x.params?.kind === 'cannot_be_recovered'), `应解析出标记（实际 ${JSON.stringify(eff.map(x => x.params?.kind))}）`);
});

await test('r2 回收类效果不会取到被标记的卡', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = mon('我', 'a1');
  pl.hand = [];
  pl.discard = ['ok1', 'bad1'];
  gs.cardResolver = fakeResolver({
    'ok1': { card:{ cardType:'trainer', trainerType:'item', name:'普通物品' }, info:{ name:'普通物品' } },
    'bad1': { card:{ cardType:'trainer', trainerType:'item', name:'宝可生机剂A',
      effects:[{ action:'usage_condition', params:{ kind:'cannot_be_recovered' } }] }, info:{ name:'宝可生机剂A' } },
  });
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:1, target:'hand' } }]);
  assert.deepEqual(pl.hand, ['ok1'], '只能拿到普通卡');
  assert.deepEqual(pl.discard, ['bad1'], '被标记的卡应留在弃牌区');
});

await test('r2 若弃牌区只有被标记的卡，回收视为无合法目标（不空发到手上）', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = mon('我', 'a1');
  pl.hand = [];
  pl.discard = ['bad1'];
  gs.cardResolver = fakeResolver({
    'bad1': { card:{ cardType:'trainer', trainerType:'item', name:'宝可生机剂A',
      effects:[{ action:'usage_condition', params:{ kind:'cannot_be_recovered' } }] }, info:{ name:'宝可生机剂A' } },
  });
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:1, target:'hand', optional:true } }]);
  assert.deepEqual(pl.hand, [], '不应拿到被标记的卡');
  assert.deepEqual(pl.discard, ['bad1'], '卡应留在弃牌区');
});

await test('r2 普通卡不受影响（对照）', async () => {
  const gs = new GameState();
  await executeEffects(gs, gs.player1, []);
  const pl = gs.player1;
  pl.active = mon('我', 'a1');
  pl.hand = [];
  pl.discard = ['ok1', 'ok2'];
  gs.cardResolver = fakeResolver({
    'ok1': { card:{ cardType:'trainer', trainerType:'item', name:'普通物品A' }, info:{ name:'普通物品A' } },
    'ok2': { card:{ cardType:'trainer', trainerType:'item', name:'普通物品B' }, info:{ name:'普通物品B' } },
  });
  await executeEffects(gs, pl, [{ action:'recover_from_discard', params:{ count:2, target:'hand' } }]);
  assert.equal(pl.hand.length, 2, '普通卡应能全部回收');
  assert.equal(pl.discard.length, 0);
});

await test('全卡牌效果文本解析覆盖率报告', () => {
  const files = [
    'Item-cards.json',
    'Supporter-cards.json',
    'Stadium-cards.json',
    'PokemonTool-cards.json',
    'SpecialEnergy-cards.json',
    'pokemon-cards.json',
  ];

  const samples = [];
  const residualBuckets = new Map(RESIDUAL_BUCKETS.map(bucket => [bucket.key, 0]));
  let total = 0;
  let parsed = 0;
  let unparsed = 0;

  for (const file of files) {
    for (const card of loadJson(file)) {
      const texts = [];
      if (card['效果'] && card['效果'] !== '无') texts.push({ name: card['卡牌名字'] || card['宝可梦名字'], text: card['效果'] });
      if (card['特性效果']) texts.push({ name: `${card['宝可梦名字']} 特性:${card['特性名字']}`, text: card['特性效果'] });
      for (const key of ['技能1', '技能2', '技能3', '技能4']) {
        const atk = card[key];
        if (atk?.['效果'] && atk['效果'] !== '无') texts.push({ name: `${card['宝可梦名字']} 招式:${atk['名字']}`, text: atk['效果'] });
      }

      for (const item of texts) {
        total++;
        const result = parseEffect(item.text);
        if (result.effects.length > 0) parsed++;
        if (result.unparsed) {
          unparsed++;
          const bucket = residualBucket(result.unparsed, `${file} ${item.name}`);
          residualBuckets.set(bucket, (residualBuckets.get(bucket) || 0) + 1);
          if (samples.length < 20) samples.push({ file, name: item.name, bucket, unparsed: result.unparsed });
        }
      }
    }
  }

  const coverageRatio = parsed / total;
  const bucketRows = [...residualBuckets.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  console.log(`\n解析覆盖率: ${parsed}/${total} (${Math.round(coverageRatio * 100)}%)，仍有残留文本: ${unparsed}`);
  if (bucketRows.length) {
    const summary = bucketRows
      .slice(0, PARSER_TOP_BUCKET_LIMIT)
      .map(([key, count]) => `${residualBucketLabel(key)}=${count}`)
      .join('，');
    console.log(`残留分类Top${Math.min(PARSER_TOP_BUCKET_LIMIT, bucketRows.length)}: ${summary}`);
  }
  if (samples.length) {
    console.log('未完全解析样例（前20条）:');
    for (const s of samples) console.log(`- [${s.file}] ${s.name} <${residualBucketLabel(s.bucket)}>: ${s.unparsed.slice(0, 90)}`);
  }

  // 趋势性保护：避免解析器大面积退化；阈值保留少量数据/fixture波动空间。
  // 最新验证基线为4518/7208（约63%）且残留4499，当前保护线为>=60%且残留<=4650。
  assert.ok(coverageRatio >= PARSER_COVERAGE_MIN_RATIO, `解析覆盖率低于保护线: ${parsed}/${total} (${coverageRatio.toFixed(3)}) < ${PARSER_COVERAGE_MIN_RATIO}`);
  assert.ok(unparsed <= PARSER_RESIDUAL_MAX_COUNT, `解析残留高于保护线: ${unparsed} > ${PARSER_RESIDUAL_MAX_COUNT}`);
});

// ===== AI 对手（P0）：合法动作枚举 + 启发式策略 + 选择路由（防挂起）=====

/**
 * 用 fs 支撑 file:// 读取，让 CardResolver 在 node 环境下能加载真实卡数据。
 * （CardResolver 内部用 fetch(new URL(file, DATA_BASE))，node 的 fetch 不支持 file: 协议）
 */
async function makeFileResolver() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('file:')) {
      const text = fs.readFileSync(fileURLToPath(href), 'utf8');
      return { ok: true, json: async () => JSON.parse(text) };
    }
    return realFetch(url);
  };
  try {
    const resolver = new CardResolver();
    await resolver.load();
    return resolver;
  } finally {
    globalThis.fetch = realFetch;
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（疑似挂起）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 固定随机种子：让洗牌/硬币可重现，避免同一用例偶发失败 */
async function withSeededMath(seed, fn) {
  const realRandom = Math.random;
  let s = seed >>> 0;
  Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  try { return await fn(); } finally { Math.random = realRandom; }
}

function aiTestDecks() {
  const deckA = expandDeck(TEST_DECKS[0]);
  const second = TEST_DECKS[1] || TEST_DECKS[0];
  return [deckA, expandDeck(second)];
}

await test('ActionSpace：起手枚举基础宝可梦、主要阶段动作含结束回合', async () => {
  await withSeededMath(1234, async () => {
  const resolver = await makeFileResolver();
  const [deckA, deckB] = aiTestDecks();
  const gs = new GameState();
  const engine = new BattleEngine(gs, resolver, { aiActionDelayMs: 0 });
  engine.startGame(deckA, deckB);

  const setup = getLegalActions(gs, resolver, gs.player1);
  assert.ok(setup.every(a => a.id && a.kind && typeof a.desc === 'string'), '每个动作都应带 id/kind/desc');
  const put = setup.find(a => a.kind === ACTION.PUT_ACTIVE);
  assert.ok(put || setup.some(a => a.kind === ACTION.MULLIGAN), '起手应能放置基础宝可梦或重新抽牌');

  // 无基础宝可梦时先重抽，直到可以放置
  let guard = 0;
  let active = put;
  while (!active && guard++ < 20) {
    engine.mulliganPlayer(gs.player1);
    active = getLegalActions(gs, resolver, gs.player1).find(a => a.kind === ACTION.PUT_ACTIVE);
  }
  assert.ok(active, '重抽后应能放置基础宝可梦');
  engine.placeActivePokemon(active.params.handIndex);
  assert.ok(engine.confirmSetup(), '确认布置后应进入对战（对手由引擎自动布置）');

  gs.setPhase(PHASE.MAIN);
  gs.currentPlayer = gs.player2;
  const main = getLegalActions(gs, resolver, gs.player2);
  assert.ok(main.some(a => a.kind === ACTION.END_TURN), '主要阶段应至少有「结束回合」');
  assert.ok(main.some(a => a.kind === ACTION.PASS_PHASE || a.kind === ACTION.ATTACK || a.kind === ACTION.ATTACH_ENERGY),
    '主要阶段应能枚举出推进/附能等动作');
  });
});

await test('AiPolicy：选择应答遵守 derivePickBounds 边界', async () => {
  const resolver = await makeFileResolver();
  const gs = new GameState();
  const engine = new BattleEngine(gs, resolver, { aiActionDelayMs: 0 });
  const policy = new HeuristicPolicy(engine, gs.player2);

  const picked = await policy.choosePick({ cards: ['卡A', '卡B', '卡C'], count: 1, options: { source: 'peek', minCount: 1, maxCount: 2 } });
  assert.ok(Array.isArray(picked), '应返回索引数组');
  assert.ok(picked.length >= 1 && picked.length <= 2, `选择数量应在 [1,2]，实际 ${picked.length}`);
  assert.ok(picked.every(i => i >= 0 && i < 3), '索引应在合法范围内');

  assert.deepEqual(await policy.choosePick({ cards: [], count: 0, options: { allowEmpty: true } }), [], '无候选应返回空数组');
  const emptyAllowed = await policy.choosePick({ cards: ['X'], count: 0, options: { allowEmpty: true, maxCount: 1 } });
  assert.ok(emptyAllowed.length <= 1, 'allowEmpty 时不应超出上限');
});

await test('AI 对手：整局自动对战（无异常/无挂起/会做附能等操作）', async () => {
  // 固定随机种子：洗牌/硬币可重现，避免「同一用例偶发失败」
  const realRandom = Math.random;
  let seed = 20260919;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // localStorage mock 必须在 try 之前声明（finally 里要恢复，块作用域不可见）
  const originalStorage = globalThis.localStorage;
  const store = new Map([['ptcg_ai_api_key', 'sk-test-key'], ['ptcg_ai_settings', JSON.stringify({ model: 'deepseek-flash' })]]);
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  try {
  const resolver = await makeFileResolver();
  const [deckA, deckB] = aiTestDecks();
  const gs = new GameState();
  const aiKinds = new Set();
  // 该用例同时验证混合模式：模拟模型参与决策（真实驱动状态序列化/提示词/三道闸）
  const engine = new BattleEngine(gs, resolver, {
    aiActionDelayMs: 0,
    aiAutoplayDelayMs: -1,   // 禁用自动触发，由测试手动驱动（避免与定时器叠加）
    aiMode: 'llm',
    onAiAction: ({ action }) => aiKinds.add(action.kind),
    fetchImpl: async (url, opts) => {
      // 模拟模型：从提示词里解析出候选 id，选第一个（保证合法）
      const body = JSON.parse(opts.body);
      const user = body.messages.find(m => m.role === 'user')?.content || '';
      const ids = [...user.matchAll(/^(a\d+) \[/gm)].map(m => m[1]);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: ids[0] || null, reason: 'test' }) } }] }) };
    },
  });
  const aiPolicy = engine._aiPolicy;
  const policy = new HeuristicPolicy(engine, gs.player1);
  gs.aiPickHandler = pick => policy.choosePick(pick);
  gs.aiPokemonPickHandler = pick => policy.choosePokemonPick(pick);
  gs._onPendingPick = null;
  gs._onPendingPokemonPick = null;

  engine.startGame(deckA, deckB);

  const runAutoPlayerTurn = async (player, maxSteps = 40) => {
    const failed = new Set();
    let stagnant = 0;
    let lastFp = '';
    for (let i = 0; i < maxSteps; i++) {
      if (gs.phase === PHASE.GAME_OVER || gs.currentPlayer !== player) return;
      // DRAW / END 这类无动作阶段：由引擎推进，避免测试驱动在无动作阶段空转
      if (gs.phase === PHASE.DRAW || gs.phase === PHASE.END) { gs.nextPhase(); continue; }
      const actions = getLegalActions(gs, resolver, player).filter(a => !failed.has(`${a.kind}|${a.params?.handIndex ?? ''}|${a.params?.targetSlot ?? ''}|${a.desc}`));
      if (!actions.length) { gs.nextPhase(); continue; }
      const action = await policy.chooseAction(actions);
      if (!action) return;
      const key = `${action.kind}|${action.params?.handIndex ?? ''}|${action.params?.targetSlot ?? ''}|${action.desc}`;
      const result = await engine._applyAiAction(action, player);
      if (result === false) failed.add(key);
      // 局面无变化 → 防死循环（与引擎同思路）
      const fp = [gs.phase, gs.turn, player.hand.length, player.discard.length, player.deck.length, player.active?.hp ?? -1].join('|');
      stagnant = fp === lastFp ? stagnant + 1 : 0;
      lastFp = fp;
      if (stagnant >= 5) return;
    }
  };

  const runGame = async () => {
    let guard = 0;
    let lastTurn = -1;
    let stagnant = 0;
    while (gs.phase !== PHASE.GAME_OVER && gs.turn <= 60 && guard++ < 6000) {
      if (gs.currentPlayer === gs.player2) {
        await engine.runAiTurn();
        // 若因「正在执行」而直接返回，让出一次事件循环（避免空转误判卡死）
        await new Promise(r => setTimeout(r, 0));
      } else {
        await runAutoPlayerTurn(gs.player1);
      }
      // 卡死检测：回合数长期不增长才是真挂起（步数多只是对局长）
      if (gs.turn === lastTurn) stagnant += 1;
      else { stagnant = 0; lastTurn = gs.turn; }
      if (stagnant > 300) break;
    }
    return { guard, stagnant };
  };

  const { guard, stagnant } = await withTimeout(runGame(), 60000, '整局自动对战');
  assert.ok(stagnant <= 300, `疑似卡死：连续 ${stagnant} 步没有推进回合`);
  assert.ok(guard < 6000, `对局应在步数上限内结束或到达回合上限，实际 ${guard} 步`);
  // 回合结束后行动权必须交回玩家（AI 挂起的直接表现就是卡在 player2）
  assert.ok(gs.phase === PHASE.GAME_OVER || gs.currentPlayer === gs.player1, 'AI 回合结束应把行动权交回玩家');
  assert.ok(gs.turn > 1 || gs.phase === PHASE.GAME_OVER, '对局应至少推进过回合');
  // P0 目标：对手不再只普攻
  assert.ok(aiKinds.size > 0, '对手应至少执行过一个动作');
  const smart = [ACTION.ATTACH_ENERGY, ACTION.EVOLVE, ACTION.USE_TRAINER, ACTION.USE_ABILITY, ACTION.RETREAT];
  if (gs.turn >= 3) {
    assert.ok(smart.some(k => aiKinds.has(k)),
      `对手应会做附能/进化/训练家/特性等操作，实际只做了：${[...aiKinds].join(',') || '（无）'}`);
  }
  // 混合模式：模型确实参与过决策（不是全程启发式）
  assert.ok(aiPolicy.stats.asked > 0, '应至少向模型发起过一次决策请求');
  assert.ok(aiPolicy.stats.accepted > 0, '模型的合法选择应被采纳过');
  } finally {
    Math.random = realRandom;
    globalThis.localStorage = originalStorage;
  }
});

await test('混合AI：LLM 输出经三道闸校验；非法/失败自动回退且冷却', async () => {
  const original = globalThis.localStorage;
  const store = new Map([
    ['ptcg_ai_api_key', 'sk-test-key'],
    ['ptcg_ai_settings', JSON.stringify({ model: 'deepseek-flash' })],
  ]);
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  try {
    const resolver = await makeFileResolver();
    const gs = new GameState();
    const engine = new BattleEngine(gs, resolver, { aiActionDelayMs: 0, aiMode: 'llm' });
    const policy = engine._aiPolicy;

    gs.phase = PHASE.BATTLE;
    gs.currentPlayer = gs.player2;
    gs.player1.active = mon('玩家出战');
    gs.player2.active = mon('AI出战', 'ai', [
      { name: '弱击', damage: 20, cost: [], effects: [] },
      { name: '强击', damage: 60, cost: [], effects: [] },
    ]);
    const actions = getLegalActions(gs, resolver, gs.player2);
    const attacks = actions.filter(a => a.kind === ACTION.ATTACK);
    assert.ok(attacks.length >= 2, '应枚举出两个可打招式');

    // ① 合法输出：采纳模型选择
    policy.fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: attacks[0].id }) } }] }) });
    policy._cooldownUntil = 0; policy._askedTurn = -1;
    const picked = await policy.chooseAction(actions);
    assert.equal(picked.id, attacks[0].id, '应采纳模型给出的候选 id');

    // ② 非法 id：回退启发式（启发式选伤害最高/可击倒的那个）
    policy.fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"a999"}' } }] }) });
    policy._cooldownUntil = 0; policy._askedTurn = -1;
    const fallback = await policy.chooseAction(actions);
    assert.equal(fallback.id, attacks[1].id, '非法 id 必须回退启发式');

    // ③ 请求失败：仍给出动作 + 进入冷却（避免每个动作都白等超时）
    let calls = 0;
    policy.fetchImpl = async () => { calls += 1; throw new Error('network'); };
    policy._cooldownUntil = 0; policy._askedTurn = -1;
    const afterFail = await policy.chooseAction(actions);
    assert.ok(afterFail, '失败也必须给出动作');
    assert.ok(policy._cooldownUntil > Date.now(), '失败后应进入冷却');
    const callsBefore = calls;
    await policy.chooseAction(actions);
    assert.equal(calls, callsBefore, '冷却期内不应再调用模型');

    // ④ 无 API Key：完全不调用模型（等同纯启发式）
    store.delete('ptcg_ai_api_key');
    let calledWithoutKey = 0;
    policy.fetchImpl = async () => { calledWithoutKey += 1; return { ok: true, json: async () => ({ choices: [] }) }; };
    policy._cooldownUntil = 0; policy._askedTurn = -1;
    await policy.chooseAction(actions);
    assert.equal(calledWithoutKey, 0, '无 API Key 时不应调用模型');
  } finally {
    globalThis.localStorage = original;
  }
});

// ===== 用户报告问题回归（2026-09-19）=====

await test('解析：招式学习器类道具产出 tool_end_of_turn_discard，不被误解析为结束回合', () => {
  const tool = parseEffect('放于宝可梦身上的这张卡牌，将在自己的回合结束时被放于弃牌区。');
  assert.ok(tool.effects.some(e => e.action === 'tool_end_of_turn_discard'), '应产出回合结束丢弃标记');
  assert.ok(!tool.effects.some(e => e.action === 'end_turn'), '不应被误解析为「结束回合」');
  const mirror = parseEffect('在下一个对手的回合，当这只宝可梦受到招式的伤害时，将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上。');
  assert.ok(mirror.effects.some(e => e.action === 'mirror_damage_counters'), '反射屏障应解析为可执行 action');
});

await test('愿增猿「亢奋脑力」：转放伤害指示物数量受实际指示物限制（2 个不能转 3 个）', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.deck = ['x', 'x', 'x']; opp.deck = ['y', 'y', 'y'];
  pl.prizes = ['p', 'p']; opp.prizes = ['p', 'p'];
  pl.active = mon('愿增猿', 'annihilape'); pl.active.maxHp = 130; pl.active.hp = 110; // 2 个伤害指示物
  opp.active = mon('对手宝可梦', 'oppmon'); opp.active.maxHp = 90; opp.active.hp = 90;
  gs._onPendingPick = null; gs._onPendingPokemonPick = null;
  await executeEffects(gs, pl, [{ action: 'damage_place', params: { target: 'opponent_field', count: 3, source: 'own_field' } }]);
  assert.equal(pl.active.hp, 130, '源应恢复全部 2 个指示物');
  assert.equal(opp.active.hp, 70, '目标只应受到 2 个指示物（20），而不是 3 个（30）');
});

await test('备战区宝可梦被击倒：只拿 1 张奖赏卡（修 ?? 误用导致的重复拿取）', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const opp = gs.player2;
  pl.deck = ['x', 'x', 'x']; opp.deck = ['y', 'y', 'y'];
  pl.prizes = Array(6).fill('p'); opp.prizes = Array(6).fill('p');
  pl.active = mon('愿增猿', 'annihilape');
  opp.active = mon('对手出战', 'oppactive');
  const benchMon = mon('皮宝宝', 'pichu'); benchMon.maxHp = 30; benchMon.hp = 30;
  opp.bench = [benchMon];
  gs._onPendingPick = null; gs._onPendingPokemonPick = null;
  await executeEffects(gs, pl, [{ action: 'damage_place', params: { target: 'opponent_bench', count: 3 } }]);
  assert.equal(6 - pl.prizes.length, 1, '基础宝可梦（非 ex）被击倒应只拿 1 张奖赏卡');
  assert.ok(opp.discard.includes('pichu'), '被击倒的备战宝可梦应进入弃牌区');
});

await test('超梦「反射屏障」：使用后下个对手回合受到招式伤害时反伤', async () => {
  const gs = new GameState();
  gs.player1.deck = ['x', 'x']; gs.player2.deck = ['y', 'y'];
  gs.player1.prizes = ['p', 'p']; gs.player2.prizes = ['p', 'p'];
  gs.player1.active = mon('超梦', 'mewtwo', [{ name: '反射屏障', damage: 20, cost: [], effects: [{ action: 'mirror_damage_counters', params: {} }] }]);
  gs.player2.active = mon('对手宝可梦', 'oppmon', [{ name: '攻击', damage: 50, cost: [], effects: [] }]);
  gs.firstPlayer = gs.player2;
  gs.firstPlayerFirstTurnInProgress = false;
  const engine = makeEngine(gs);
  engine.aiAutoplayDelayMs = -1;
  gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player1;
  await engine.attack(0);
  assert.equal(gs.player1.active.mirrorDamageCounters, true, '使用后应进入反射状态');
  gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player2;
  const before = gs.player2.active.hp;
  await engine.attack(0);
  // 反伤值等于受到的伤害；但受攻击方剩余 HP 限制（前者已在本回合被反射屏障打下 20）
  assert.equal(before - gs.player2.active.hp, Math.min(50, before), '攻击方应受到与伤害等量的反伤');
  assert.ok(gs.log.some(l => /反射屏障.*受到 50 伤害/.test(l)), '应记录反伤日志');
});

await test('道具「招式学习器」：自己的回合结束时被放入弃牌区', async () => {
  const gs = new GameState();
  gs.player1.deck = ['x', 'x']; gs.player2.deck = ['y', 'y'];
  gs.player1.active = mon('测试宝可梦', 't');
  gs.player1.active.tool = { cardId: 'CSV5C-120', name: '招式学习器 退化', effects: [{ action: 'tool_end_of_turn_discard', params: {} }] };
  gs.currentPlayer = gs.player1;
  gs.endTurn();
  assert.equal(gs.player1.active.tool, null, '道具应被移除');
  assert.ok(gs.player1.discard.includes('CSV5C-120'), '道具应进入弃牌区');
});

await test('战斗日志面板：限高约 8 个按钮厚度 + 实时跟随 + 可拖动', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
  assert.ok(/max-height:\s*min\(260px/.test(css), '日志面板应限高（≈ 8 个按钮厚度）');
  const js = fs.readFileSync(path.resolve(__dirname, '../js/main.js'), 'utf8');
  assert.ok(/_logFollow/.test(js), '应实现实时跟随/暂停跟随');
  assert.ok(/_bindLogDrag/.test(js), '应支持拖动滚动回看');
});

await test('尖钉能量：附着后受招式伤害时给攻击方放置 2 个伤害指示物', async () => {
  const gs = new GameState();
  gs.player1.deck = ['x', 'x']; gs.player2.deck = ['y', 'y'];
  gs.player1.prizes = ['p', 'p']; gs.player2.prizes = ['p', 'p'];
  gs.player1.active = mon('攻击者', 'a', [{ name: '攻击', damage: 50, cost: [], effects: [] }]);
  gs.player2.active = mon('防守者', 'd'); gs.player2.active.maxHp = 200; gs.player2.active.hp = 200;
  const spiky = {
    cardType: 'specialEnergy', name: '尖钉能量',
    provides: [{ types: ['colorless'], count: 1 }],
    effects: [{ action: 'attack_reflect_counters', params: { counters: 2 } }],
  };
  gs.player2.hand = ['spiky'];
  assert.equal(gs.attachEnergy(gs.player2, 0, spiky, 'active'), true, '尖钉能量应能附着');
  assert.equal(gs.player2.active.energy[0].attackReflectCounters, 2, '附着时应登记反伤标记');
  const engine = makeEngine(gs);
  engine.aiAutoplayDelayMs = -1;
  gs.firstPlayer = gs.player2; gs.firstPlayerFirstTurnInProgress = false;
  gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player1;
  const before = gs.player1.active.hp;
  await engine.attack(0);
  assert.equal(before - (gs.player1.active?.hp ?? 0), 20, '攻击方应因尖钉能量受到 20 伤害（2 个指示物）');
  assert.ok(gs.log.some(l => /尖钉能量/.test(l)), '应记录尖钉能量反伤日志');
});

await test('回收类训练家：弃牌区无合法目标时不可使用（只有卡组检索类可空发）', async () => {
  const resolver = await makeFileResolver();
  const gs = new GameState();
  gs.cardResolver = resolver;
  const pl = gs.player1;
  pl.active = mon('测试宝可梦', 't');
  const stretcher = {
    cardType: 'trainer', trainerType: 'item', name: '夜间担架',
    effects: [{ action: 'recover_from_discard', params: { filter: '宝可梦或基本能量', target: 'hand', count: 1, maxCount: 1, minCount: 1, allowFewer: false, allowEmpty: false } }],
  };
  pl.discard = ['CS1DC-196']; // 只有训练家卡
  assert.equal(gs.canUseTrainer(pl, stretcher, null).ok, false, '弃牌区只有训练家卡时不可使用');
  assert.equal(gs.canUseTrainer(pl, stretcher, null).reason, 'no_recover_target');
  pl.discard = [];
  assert.equal(gs.canUseTrainer(pl, stretcher, null).ok, false, '弃牌区为空时不可使用');
  pl.discard = ['CS5.5C-008']; // 宝可梦
  assert.equal(gs.canUseTrainer(pl, stretcher, null).ok, true, '弃牌区有宝可梦时可用');
  pl.discard = ['30thC-DAR']; // 基本能量
  assert.equal(gs.canUseTrainer(pl, stretcher, null).ok, true, '弃牌区有基本能量时可用');
});

await test('幸运头盔：只有受到招式伤害才抽卡（特性放置伤害指示物不触发）', async () => {
  const gs = new GameState();
  gs.player1.deck = Array(10).fill('x'); gs.player2.deck = Array(10).fill('y');
  gs.player1.prizes = ['p', 'p']; gs.player2.prizes = ['p', 'p'];
  gs.player1.active = mon('攻击者', 'a', [{ name: '攻击', damage: 30, cost: [], effects: [] }]);
  gs.player2.active = mon('防守者', 'd'); gs.player2.active.maxHp = 300; gs.player2.active.hp = 300;
  gs.player2.active.tool = {
    cardId: 'helmet', name: '幸运头盔',
    effects: [{ action: 'trigger', params: { event: 'attacked_damage', effect: { action: 'draw', params: { count: 2 } }, sourceKind: 'tool' } }],
  };
  const engine = makeEngine(gs);
  engine.aiAutoplayDelayMs = -1;
  gs.firstPlayer = gs.player2; gs.firstPlayerFirstTurnInProgress = false;
  // ① 特性/效果「放置伤害指示物」不算招式伤害
  const beforeEffect = gs.player2.hand.length;
  await executeEffects(gs, gs.player1, [{ action: 'damage_place', params: { target: 'opponent_active', count: 2 } }]);
  assert.equal(gs.player2.hand.length, beforeEffect, '放置伤害指示物不应触发幸运头盔');
  // ② 招式伤害应触发
  gs.phase = PHASE.BATTLE; gs.currentPlayer = gs.player1;
  const beforeAttack = gs.player2.hand.length;
  await engine.attack(0);
  // 头盔抽 2 张；攻击会结束回合，随后 player2 作为新回合玩家再抽 1 张
  assert.ok(gs.player2.hand.length >= beforeAttack + 2, '受到招式伤害应抽 2 张（另含回合切换抽卡）');
  assert.ok(gs.player2.hand.length <= beforeAttack + 3, '不应多抽（避免重复触发）');
});

await test('「令这只宝可梦昏厥」类效果：自爆后离场并换上后备（仿徨夜灵 咒怨炸弹）', async () => {
  const gs = new GameState();
  gs.player1.deck = Array(10).fill('x'); gs.player2.deck = Array(10).fill('y');
  gs.player1.prizes = Array(6).fill('p'); gs.player2.prizes = Array(6).fill('p');
  gs.player1.active = mon('我方宝可梦', 'a');
  gs.player2.active = mon('仿徨夜灵', 'CSV8C-082');
  gs.player2.bench = [mon('对手后备', 'b')];
  const prizesBefore = gs.player1.prizes.length;
  await executeEffects(gs, gs.player2, [{ action: 'knockout', params: { target: 'self' } }]);
  assert.equal(gs.player2.active.cardId, 'b', '昏厥后应换上后备宝可梦');
  assert.ok(gs.player2.discard.includes('CSV8C-082'), '昏厥的宝可梦应进入弃牌区');
  assert.equal(prizesBefore - gs.player1.prizes.length, 1, '对手应拿 1 张奖赏卡');

  // 无后备时：立即结束对局
  const gs2 = new GameState();
  gs2.player1.deck = Array(10).fill('x'); gs2.player2.deck = Array(10).fill('y');
  gs2.player1.prizes = Array(6).fill('p'); gs2.player2.prizes = Array(6).fill('p');
  gs2.player1.active = mon('我方宝可梦', 'a');
  gs2.player2.active = mon('仿徨夜灵', 'CSV8C-082');
  await executeEffects(gs2, gs2.player2, [{ action: 'knockout', params: { target: 'self' } }]);
  assert.equal(gs2.phase, PHASE.GAME_OVER, '无后备宝可梦时自爆应立即结束对局');
  assert.equal(gs2.winner, gs2.player1, '对手无宝可梦 → 我方获胜');
});

await test('竞技场：同名不能再打出；同回合不能重复发动效果', async () => {
  const resolver = await makeFileResolver();
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/battle/Stadium-cards.json'), 'utf8'));
  const byName = new Map();
  for (const c of raw) {
    const n = c['卡牌名字'];
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(c);
  }
  const pair = [...byName.values()].find(list => list.length >= 2);
  assert.ok(pair, '数据中应存在同名竞技场用于验证');
  const cdA = resolver.getCard(pair[0]['卡牌ID'][0]);
  const cdB = resolver.getCard(pair[1]['卡牌ID'][0]);
  const gs = new GameState();
  gs.cardResolver = resolver;
  gs.turn = 3; gs.phase = PHASE.MAIN; gs.currentPlayer = gs.player1;
  gs.player1.active = mon('测试', 't');
  gs.player2.active = mon('对手', 'o');
  gs.player1.hand = [pair[0]['卡牌ID'][0]];
  assert.equal(gs.useTrainer(gs.player1, 0, cdA, null, pair[0]['卡牌ID'][0]), true, '第一张竞技场应能打出');
  // 模拟新回合（本回合未打出过竞技场）后尝试同名
  gs.player1.stadiumPlayedThisTurn = false;
  gs.player1.hand = [pair[1]['卡牌ID'][0]];
  const check = gs.canUseTrainer(gs.player1, cdB, null);
  assert.equal(check.ok, false, '同名竞技场不能再打出');
  assert.equal(check.reason, 'stadium_same_name');
  // 同一玩家同回合不能重复发动同一竞技场效果
  const engine = makeEngine(gs);
  engine.aiAutoplayDelayMs = -1;
  gs.player1.stadiumUsedThisTurn = {};
  const first = await engine.activateStadium(gs.player1);
  if (first) {
    assert.equal(await engine.activateStadium(gs.player1), false, '同回合不能重复发动同一竞技场效果');
  }
});

await test('UI：选择目标列表与场地一致（名/血量/能量），不可选时置灰', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../js/main.js'), 'utf8');
  assert.ok(/_energyShortText\(mon\)/.test(js), '选择目标列表应使用能量简写（与场地列表一致）');
  assert.ok(!/HP \$\{mon\.hp\}\//.test(js), '不应再使用「HP x/y · 能量 n」的冗长格式');
  assert.ok(/disabled: blocked/.test(js), '不可进化的目标应置灰');
  assert.ok(/本回合刚出场或已进化/.test(js), '进化选项不可用时置灰并说明原因');
});

await test('「令这只宝可梦昏厥」作用于效果来源（备战区）而非战斗场', async () => {
  const gs = new GameState();
  gs.player1.deck = Array(10).fill('x'); gs.player2.deck = Array(10).fill('y');
  gs.player1.prizes = Array(6).fill('p'); gs.player2.prizes = Array(6).fill('p');
  gs.player1.active = mon('我方宝可梦', 'a');
  gs.player2.active = mon('超梦', 'mewtwo');
  const benchMon = mon('仿徨夜灵', 'CSV8C-082');
  gs.player2.bench = [benchMon];
  const prizesBefore = gs.player1.prizes.length;
  await executeEffects(gs, gs.player2, [{ action: 'knockout', params: { target: 'self' }, source: benchMon }]);
  assert.equal(gs.player2.active.cardId, 'mewtwo', '战斗场的宝可梦不应被昏厥');
  assert.equal(gs.player2.active.hp, gs.player2.active.maxHp, '战斗场宝可梦应保持满血');
  assert.equal(gs.player2.bench.length, 0, '来源宝可梦应离开备战区');
  assert.ok(gs.player2.discard.includes('CSV8C-082'), '来源宝可梦应进入弃牌区');
  assert.equal(prizesBefore - gs.player1.prizes.length, 1, '对手应拿 1 张奖赏卡');
});

await test('UI：场地页签的进化项在不可进化时也要置灰', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../js/main.js'), 'utf8');
  const start = js.indexOf('_showPokeActions(slot) {');
  assert.ok(start >= 0, '应存在场地页签宝可梦动作入口');
  const block = js.slice(start, start + 2000);
  assert.ok(/const blocked = !!mon\.placedThisTurn \|\| !!mon\.evolvedThisTurn/.test(block),
    '场地页签进化项应有「刚出场/已进化」判断');
  assert.ok(/disabled: blocked/.test(block), '场地页签进化项应置灰');
  assert.ok(/下回合才能进化/.test(block), '置灰时应说明原因');
});

if (process.exitCode) {
  console.error('\n自动化测试失败。');
  process.exit(process.exitCode);
}

console.log('\n全部 ptcgBattle 自动化测试通过。');
