// js/core/AiPolicy.js — AI 决策策略
//
// 设计：**代码算数，策略取舍**。
//   - 合法性由 ActionSpace 保证（策略只能从合法动作里选）
//   - 启发式策略自己算伤害/KO/奖赏（facts 已由 ActionSpace 标好），做出「认真打」的取舍
//   - LlmPolicy 预留同一接口：P2 阶段接入 DeepSeek（deepseek-flash），
//     只输出候选 id，非法/超时一律回退 HeuristicPolicy
//
// 决策入口：
//   chooseAction(actions)            → 选一个动作（AI 回合逐动作循环调用）
//   choosePick(pick)                 → 应答 waitForPick（效果执行中的选牌）
//   choosePokemonPick(pick)          → 应答 waitForPokemonPick（选目标宝可梦）

import { ACTION } from './ActionSpace.js';
import { derivePickBounds } from './GameState.js';

/** 「准备类」动作：做完它们再攻击（攻击会立刻结束回合，所以顺序很关键） */
const PREP_KINDS = new Set([
  ACTION.ATTACH_ENERGY,
  ACTION.EVOLVE,
  ACTION.USE_ABILITY,
  ACTION.USE_TRAINER,
  ACTION.ACTIVATE_STADIUM,
]);

export class HeuristicPolicy {
  constructor(engine, player = null) {
    this.engine = engine;
    this.gs = engine.gs;
    this.player = player || engine.gs.player2;
  }

  /** 给动作打分（数值越大越优先） */
  scoreAction(action, actions = []) {
    let score = action.priority || 0;
    const f = action.facts || {};
    const me = this.player;
    switch (action.kind) {
      case ACTION.PUT_ACTIVE:
        score += (f.hp || 0) * 0.05;
        break;
      case ACTION.PUT_BENCH:
        // 起手尽量铺 3 只后备
        score += Math.max(0, 3 - (me.bench || []).length) * 25;
        break;
      case ACTION.CONFIRM_SETUP:
        score -= Math.max(0, 3 - (me.bench || []).length) * 20;
        break;
      case ACTION.EVOLVE:
        score += 15 + Math.min(40, (f.hp || 0) * 0.05);
        break;
      case ACTION.ATTACH_ENERGY:
        if (f.enablesAttack) score += 45;
        if (action.params?.targetSlot === 'active') score += 12;
        break;
      case ACTION.USE_ABILITY:
        score += 12;
        break;
      case ACTION.USE_TRAINER:
        score += /抽|检索|搜索|博士|研究|莉莉艾|裁判|球/.test(action.desc) ? 20 : 5;
        break;
      case ACTION.ACTIVATE_STADIUM:
        score += 3;
        break;
      case ACTION.ATTACK:
        score += Math.min(60, (f.damage || 0) * 0.35);
        if (f.canKO) score += 70;
        score += (f.prizes || 0) * 15;
        if (f.mayVary) score -= 5;
        break;
      case ACTION.RETREAT: {
        const activeRatio = f.activeMaxHp ? (f.activeHp || 0) / f.activeMaxHp : 1;
        const incomingRatio = f.incomingMaxHp ? (f.incomingHp || 0) / f.incomingMaxHp : 1;
        // 只在「战斗宝可梦濒危且后备更健康」时撤退
        score += (activeRatio <= 0.4 && incomingRatio > activeRatio + 0.2) ? 35 : -40;
        break;
      }
      default:
        break;
    }

    // 攻击会立即结束回合 → 只要还有准备动作可做，就先做它们
    if (action.kind === ACTION.ATTACK && actions.some(a => PREP_KINDS.has(a.kind))) score -= 200;
    // 同理：准备动作没做完前，不急着从主要阶段推进到战斗阶段
    if (action.kind === ACTION.PASS_PHASE && actions.some(a => PREP_KINDS.has(a.kind))) score -= 200;

    return score;
  }

  /** 从合法动作中选一个（返回 action；无动作返回 null） */
  async chooseAction(actions = []) {
    if (!actions.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const action of actions) {
      const score = this.scoreAction(action, actions);
      if (score > bestScore) { bestScore = score; best = action; }
    }
    return best;
  }

  /**
   * 应答 waitForPick（返回索引数组，长度必须落在 derivePickBounds 的 [min,max] 内）
   */
  async choosePick(pick = {}) {
    const cards = pick.cards || [];
    if (!cards.length) return [];
    const options = pick.options || {};
    const source = String(options.source || '');
    const { min, max } = derivePickBounds(pick);
    if (max <= 0) return [];

    const indices = [...cards.keys()];
    let ordered;
    if (/discard/i.test(source)) ordered = this._orderForDiscard(cards, indices);
    else if (/retreat-energy|attached-energy|discard-energy/.test(source)) ordered = indices.slice().reverse();
    else if (/peek|search|draw|recover|hand-energy|hand-pokemon/.test(source)) ordered = this._orderForGain(cards, indices, options.filter);
    else ordered = indices;

    // 弃牌类尽量少丢（满足 min 即可）；获取类尽量多拿
    const want = /discard/i.test(source) ? min : Math.max(min, Math.min(max, ordered.length));
    const take = Math.max(min, Math.min(want, max, ordered.length));
    return ordered.slice(0, Math.max(0, take));
  }

  /** 应答 waitForPokemonPick（返回 slot 字符串或 null） */
  async choosePokemonPick(pick = {}) {
    const options = pick.options || {};
    const owner = pick.player || this.gs.player1;
    const allowed = Array.isArray(options.selectableSlots) ? options.selectableSlots : null;
    const candidates = [];
    const consider = (slot, mon) => {
      if (!mon) return;
      if (allowed && !allowed.includes(slot)) return;
      if (slot === 'active' && options.allowActive === false) return;
      if (slot.startsWith('bench-') && options.allowBench === false) return;
      candidates.push({ slot, mon });
    };
    consider('active', owner.active);
    (owner.bench || []).forEach((mon, i) => consider(`bench-${i}`, mon));
    if (!candidates.length) return null;

    // 目标是「对手的宝可梦」时：优先选择血量最低的（更容易击倒）
    const isOpponentSide = options.side === 'opponent' || owner !== this.player;
    if (isOpponentSide) {
      return candidates.slice().sort((a, b) => (a.mon.hp || 0) - (b.mon.hp || 0))[0].slot;
    }
    // 自己一侧：优先主攻手（出战位），其次血量最高的
    return candidates.slice().sort((a, b) => {
      const aActive = a.slot === 'active' ? 1 : 0;
      const bActive = b.slot === 'active' ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.mon.hp || 0) - (a.mon.hp || 0);
    })[0].slot;
  }

  /** 弃牌顺序：重复的、非规则宝可梦优先丢 */
  _orderForDiscard(cards, indices) {
    const counts = new Map();
    for (const label of cards) counts.set(label, (counts.get(label) || 0) + 1);
    const weight = (i) => {
      const name = String(cards[i]);
      let s = 0;
      if ((counts.get(name) || 0) > 1) s += 50;
      if (/能量/.test(name)) s -= 10;
      if (/ex|EX|【V】|VMAX|GX|VSTAR/.test(name)) s -= 25;
      if (i === 0) s -= 5; // 手牌靠前的通常更早拿到，略微保留
      return s;
    };
    return indices.slice().sort((a, b) => weight(b) - weight(a));
  }

  /** 获取顺序：优先匹配 filter 指定的类别，其次规则宝可梦 */
  _orderForGain(cards, indices, filter) {
    const f = String(filter || '');
    const weight = (i) => {
      const name = String(cards[i]);
      let s = 0;
      if (f) {
        if (f.includes('基本能量') && (/(基本|【.+】)能量/.test(name))) s += 40;
        else if (f.includes('能量') && /能量/.test(name)) s += 30;
        if (f.includes('宝可梦') && !/能量|支援者|物品|竞技场/.test(name)) s += 25;
        if (/支援者|人物/.test(f) && /博士|莉莉艾|裁判|老大|玛丽/.test(name)) s += 25;
      }
      if (/ex|EX|【V】|VMAX|GX|VSTAR/.test(name)) s += 8;
      return s;
    };
    return indices.slice().sort((a, b) => weight(b) - weight(a));
  }
}

/**
 * LLM 策略（P2 实现）：
 * 与启发式同接口，内部把「候选动作 + 事实标注」交给 deepseek-flash 选择；
 * 任何失败（超时/非法/无 Key）都回退启发式，绝不阻塞对局。
 */
export class LlmPolicy extends HeuristicPolicy {
  constructor(engine, options = {}) {
    super(engine, options.player);
    this.options = options;
    this.llmEnabled = false; // P2：接入后置为 true
  }

  async chooseAction(actions = []) {
    // P2：调用 LLM 选择候选 id；此处先行为与启发式一致，保证可随时启用
    return super.chooseAction(actions);
  }
}

/** 策略工厂 */
export function createAiPolicy(engine, options = {}) {
  const mode = options.mode || 'heuristic';
  if (mode === 'llm') return new LlmPolicy(engine, options);
  return new HeuristicPolicy(engine, options.player);
}
