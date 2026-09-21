// js/core/DeckPlan.js — 卡组画像（L1）与计划权重（L2）
//
// 目的：让对手 AI **按这套牌想怎么打**来取舍，而不是「有效果就放」。
//
// 背景（原实现的问题）：
//   AiPolicy.scoreAction() 用的是与卡组无关的硬编码常数，
//   任何训练家都至少 +45+5=50 分，高于被惩罚的攻击/过阶段 →
//   准备动作做完后会把手上所有训练家都放完才攻击。
//   而且状态序列化里根本没有「卡组构成」，AI 连自己是什么牌组都不知道。
//
// 本模块提供两件事：
//   L1 `buildDeckPlan(deckIds, resolver)` —— 从卡组构成 + 卡牌效果**确定性**推断原型，并给出证据
//   L2 `NEUTRAL_PLAN.weights` / 各原型 `weights` —— 供 AiPolicy 把硬编码常数换成计划权重
//
// 说明：这里只做「原型级偏好偏置」，不做真正的搜索/规划（那需要 IS-MCTS 或 RL）。
// 设计成纯函数、可注入 resolver，便于在 node 里单测。

/** 卡牌动作 → 玩法分类 */
const ACTION_CLASS = {
  // 抽牌 / 牌库操作
  draw: 'draw',
  draw_until: 'draw',
  draw_until_opp_hand_plus: 'draw',
  shuffle_hand_to_deck: 'draw',
  discard_hand_draw: 'draw',
  peek_and_keep: 'draw',
  manipulate_deck_top: 'draw',
  // 检索
  search_deck_to_hand: 'search',
  // 铺场（把宝可梦放上场）
  search_deck_to_bench: 'flood',
  discard_to_bench: 'flood',
  // 填能
  search_deck_energy_split: 'accel',
  attach_energy_from_hand: 'accel',
  attach_energy_from_deck: 'accel',
  attach_energy_from_discard: 'accel',
  attach_energy_trigger: 'accel',
  energy_accel: 'accel',
  // 铺伤 / 伤害指示物
  damage_bench: 'spread',
  damage_place: 'spread',
  // 干扰
  discard_opponent_hand: 'disrupt',
  opponent_hand_discard: 'disrupt',
  inflict_status: 'disrupt',
  // 其它
  heal: 'heal',
  heal_all: 'heal',
  switch_pokemon: 'switch',
  bench_attack_shield: 'protect',
  retreat_cost_reduce: 'retreat',
  retreat_cost_zero: 'retreat',
};

/**
 * 把一串效果归类成玩法标签（递归处理 coin_flip 的 heads/tails、trigger 的 effects）。
 * @returns {string[]} 去重后的分类
 */
export function classifyEffects(effects = []) {
  const out = new Set();
  const walk = list => {
    for (const e of list || []) {
      if (!e) continue;
      const cls = ACTION_CLASS[e.action];
      if (cls) out.add(cls);
      const p = e.params || {};
      for (const key of ['heads', 'tails', 'effects']) {
        if (Array.isArray(p[key])) walk(p[key]);
      }
    }
  };
  walk(effects);
  return [...out];
}

/** 中性计划：全部权重为 0 → 行为与改造前一致（作为兜底与回归基线） */
export const NEUTRAL_WEIGHTS = Object.freeze({
  PUT_BENCH: 0, ATTACH_ENERGY: 0, EVOLVE: 0, USE_ABILITY: 0,
  USE_TRAINER: 0, ACTIVATE_STADIUM: 0, ATTACK: 0, RETREAT: 0,
  trainerClass: Object.freeze({}),
});

export const NEUTRAL_PLAN = Object.freeze({
  archetype: 'generic', label: '通用', evidence: [], features: {}, weights: NEUTRAL_WEIGHTS,
});

/**
 * 各原型的计划权重。
 * 数值都是**加法偏置**（在原有优先级之上叠加），刻意保持小幅度，
 * 避免把某个动作抬到明显不合理的位置。
 */
const PRESETS = {
  accel: {
    label: '填能加速',
    weights: {
      ATTACH_ENERGY: 25, USE_ABILITY: 8, USE_TRAINER: 0,
      trainerClass: { accel: 30, search: 8, draw: 8 },
    },
  },
  burst: {
    label: '一击爆发',
    // 先攒能量/进化，不急着用无关的招式；能 KO 时 ATTACK 的 +70 仍然主导
    weights: {
      EVOLVE: 15, ATTACH_ENERGY: 18, ATTACK: -12,
      trainerClass: { accel: 20, search: 6, draw: 6 },
    },
  },
  flood: {
    label: '铺场展开',
    weights: {
      PUT_BENCH: 25, ATTACK: -8,
      trainerClass: { flood: 30, draw: 8 },
    },
  },
  spread: {
    label: '铺伤控制',
    weights: {
      USE_ABILITY: 10, RETREAT: 8,
      trainerClass: { spread: 30, draw: 5 },
    },
  },
  control: {
    label: '手牌干扰',
    weights: {
      trainerClass: { disrupt: 25, draw: 6 },
    },
  },
};

/** 依优先级选原型（规则少、可解释；阈值都写在这里便于调参） */
function pickArchetype(f) {
  const c = f.classes || {};
  if (f.highDamage >= 2 && (c.accel || 0) >= 2) return 'burst';
  if ((c.accel || 0) >= 3) return 'accel';
  if ((c.flood || 0) >= 2) return 'flood';
  if ((c.spread || 0) >= 2) return 'spread';
  if ((c.disrupt || 0) >= 3) return 'control';
  if (f.maxDamage >= 200) return 'burst';
  return 'generic';
}

function evidenceOf(f, archetype) {
  const c = f.classes || {};
  const ev = [];
  if (c.accel) ev.push(`填能类效果 ×${c.accel}`);
  if (c.flood) ev.push(`铺场类效果 ×${c.flood}`);
  if (c.spread) ev.push(`铺伤类效果 ×${c.spread}`);
  if (c.disrupt) ev.push(`干扰类效果 ×${c.disrupt}`);
  if (c.search) ev.push(`检索 ×${c.search}`);
  if (c.draw) ev.push(`抽牌 ×${c.draw}`);
  if (f.maxDamage) ev.push(`最高招式伤害 ${f.maxDamage}`);
  if (f.energyRatio >= 0.25) ev.push(`能量占比 ${Math.round(f.energyRatio * 100)}%`);
  if (archetype === 'generic') ev.push('未识别出明显套路');
  return ev.slice(0, 4);
}

/**
 * 从卡组推断玩法画像。
 * @param {string[]} deckIds 展开后的卡牌 ID 列表（如 expandDeck 的输出）
 * @param {{getCard:(id:string)=>object|null}} resolver 卡牌解析器
 * @returns {{archetype:string,label:string,evidence:string[],features:object,weights:object}}
 */
export function buildDeckPlan(deckIds = [], resolver = null) {
  const list = Array.isArray(deckIds) ? deckIds : [];
  const f = {
    total: list.length, pokemon: 0, trainer: 0, energy: 0, basic: 0, evo: 0,
    maxDamage: 0, highDamage: 0, energyRatio: 0, classes: {},
  };

  const countClasses = classes => {
    for (const cls of classes) f.classes[cls] = (f.classes[cls] || 0) + 1;
  };

  for (const id of list) {
    let cd = null;
    try { cd = resolver?.getCard?.(id) || null; } catch (e) { cd = null; }
    if (!cd) continue;
    if (cd.cardType === 'pokemon') {
      f.pokemon++;
      if (/基础/.test(String(cd.stage || ''))) f.basic++; else f.evo++;
      for (const a of cd.attacks || []) {
        const dmg = Number(a?.damage) || 0;
        if (dmg > f.maxDamage) f.maxDamage = dmg;
        if (dmg >= 200) f.highDamage++;
      }
      const cls = new Set([
        ...classifyEffects(cd.attacks?.flatMap(a => a.effects || [])),
        ...classifyEffects(cd.ability?.effects || []),
      ]);
      countClasses(cls);
    } else if (cd.cardType === 'trainer') {
      f.trainer++;
      countClasses(classifyEffects(cd.effects || []));
    } else if (cd.cardType === 'energy' || cd.cardType === 'specialEnergy') {
      f.energy++;
    }
  }
  f.energyRatio = f.total ? f.energy / f.total : 0;

  const archetype = pickArchetype(f);
  const preset = PRESETS[archetype];
  if (!preset) return { ...NEUTRAL_PLAN, features: f };
  return {
    archetype,
    label: preset.label,
    evidence: evidenceOf(f, archetype),
    features: f,
    weights: preset.weights,
  };
}
