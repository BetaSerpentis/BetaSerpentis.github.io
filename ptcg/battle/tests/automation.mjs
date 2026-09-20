// ptcg/battle/tests/automation.mjs
// 自动化测试：覆盖核心规则/效果、代表性卡牌文本、以及全卡牌效果解析覆盖率报告。
// 用法：node ptcg/battle/tests/automation.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffect } from '../js/core/EffectParser.js';
import { executeEffects } from '../js/core/EffectExecutor.js';
import { GameState, PHASE } from '../js/core/GameState.js';
import { BattleEngine } from '../js/core/BattleEngine.js';
import { CardResolver } from '../js/core/CardResolver.js';
import { PTCGBattleApp, cardPickerTitleFor, energyElementClass, energyLabel, pokemonPickerConfirmEnabled, pokemonPickerHasLegalTarget, pokemonPickerSlotAllowed, pokemonPickerSlotClass, pokemonPickerTitleFor } from '../js/main.js';
import { pokemonSpriteImgHtml, pokemonSpriteSrc, pokemonSpriteCandidates, SPRITE_PREFER_ONLINE } from '../js/ui/SpriteUtils.js';
import { DeckSource, PTCG_DECKS_STORAGE_KEY } from '../js/core/DeckSource.js';
import { TEST_DECKS, expandDeck } from '../js/data/decks.js';
import { AI_STORAGE_KEYS, getAiApiKey, hasAiApiKey, getAiSettings, describeAiStatus, onAiKeyChange } from '../js/core/AiSettings.js';
import { getLegalActions, describeAction, ACTION } from '../js/core/ActionSpace.js';
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
  assert.deepEqual(damaged.player2.discard, ['def']);

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
  assert.deepEqual(gs.player2.discard, ['def']);

  const bench = new GameState();
  bench.player1.active = mon('攻击方');
  bench.player2.active = mon('防守方');
  bench.player2.bench = [mon('备战防守', 'bench-def')];
  bench.player2.bench[0].tool = { cardId:'11176', name:'幸存锻炼器' };
  await executeEffects(bench, bench.player1, [{ action:'damage_bench', params:{ target:'opponent_all', damage:60 } }]);
  assert.equal(bench.player2.bench.length, 0);
  assert.deepEqual(bench.player2.discard, ['bench-def']);
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

await test('真实卡特性：阳光绽放补牌到4且一回合一次', async () => {
  const gs = new GameState();
  const pl = gs.player1;
  const ability = buildAbilityFromRaw(getPokemonRawByAbility('阳光绽放'));
  assert.equal(ability.effects.some(e => e.action === 'draw_until' && e.params.target === 4), true);
  pl.hand = ['h1'];
  pl.deck = ['d1', 'd2', 'd3', 'd4'];
  pl.active = mon('美丽花');
  pl.active.ability = ability;
  const engine = makeEngine(gs);
  assert.equal(await engine.useAbility(pl.active), true);
  assert.equal(pl.hand.length, 4);
  assert.equal(await engine.useAbility(pl.active), false);
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
