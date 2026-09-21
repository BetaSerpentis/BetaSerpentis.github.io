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
import { NEUTRAL_PLAN } from './DeckPlan.js';
import { derivePickBounds } from './GameState.js';
import { getAiApiKey, getAiSettings, normalizeAiModelName, AI_ENDPOINT, AI_DEFAULT_MODEL } from './AiSettings.js';
import { serializeBattleState, formatActionList, buildLlmMessages, extractActionId } from './StateSerializer.js';

/** 「准备类」动作：做完它们再攻击（攻击会立刻结束回合，所以顺序很关键） */
/**
 * 训练家效果的「基础分」：取代原来按卡面描述关键词（抽|检索|球…）猜分的做法。
 * 数值与旧的关键词加分大致对齐（命中关键词 +20、否则 +5），但改为按效果语义判定。
 */
const TRAINER_CLASS_BASE = {
  draw: 15, search: 15, accel: 15, flood: 12, spread: 12, disrupt: 10,
  heal: 8, switch: 6, protect: 6, retreat: 5,
};

const PREP_KINDS = new Set([
  ACTION.ATTACH_ENERGY,
  ACTION.EVOLVE,
  ACTION.USE_ABILITY,
  ACTION.USE_TRAINER,
  ACTION.ACTIVATE_STADIUM,
]);

export class HeuristicPolicy {
  constructor(engine, player = null, options = {}) {
    this.engine = engine;
    this.gs = engine.gs;
    this.player = player || engine.gs.player2;
    // L2：计划权重。默认中性（全 0）→ 行为与改造前一致，便于回归对比。
    this.plan = options.plan || NEUTRAL_PLAN;
  }

  /** 注入卡组画像（由 BattleEngine.startGame 依对手卡组构建） */
  setPlan(plan) {
    this.plan = plan || NEUTRAL_PLAN;
    return this.plan;
  }

  get weights() {
    return (this.plan && this.plan.weights) || NEUTRAL_PLAN.weights;
  }

  /** 给动作打分（数值越大越优先） */
  scoreAction(action, actions = []) {
    let score = action.priority || 0;
    const f = action.facts || {};
    const me = this.player;
    const w = this.weights;
    switch (action.kind) {
      case ACTION.PUT_ACTIVE:
        score += (f.hp || 0) * 0.05;
        break;
      case ACTION.PUT_BENCH:
        // 起手尽量铺 3 只后备；铺场型卡组额外加权
        score += Math.max(0, 3 - (me.bench || []).length) * 25 + (w.PUT_BENCH || 0);
        break;
      case ACTION.CONFIRM_SETUP:
        score -= Math.max(0, 3 - (me.bench || []).length) * 20;
        break;
      case ACTION.EVOLVE:
        score += 15 + Math.min(40, (f.hp || 0) * 0.05) + (w.EVOLVE || 0);
        break;
      case ACTION.ATTACH_ENERGY:
        if (f.enablesAttack) score += 45;
        if (action.params?.targetSlot === 'active') score += 12;
        score += (w.ATTACH_ENERGY || 0);
        break;
      case ACTION.USE_ABILITY:
        score += 12 + (w.USE_ABILITY || 0);
        break;
      case ACTION.USE_TRAINER: {
        // 按这张卡的**效果分类**给基础分（原来是对描述做关键词正则），
        // 再叠加本卡组计划对这类效果的偏好 —— 解决「有效果就放」。
        const classes = f.effectClasses || [];
        const bases = classes.map(c => TRAINER_CLASS_BASE[c] || 0);
        const base = bases.length ? Math.max(...bases) : 5;
        let bonus = w.USE_TRAINER || 0;
        const classW = w.trainerClass || {};
        for (const c of classes) bonus += classW[c] || 0;
        score += base + bonus;
        break;
      }
      case ACTION.ACTIVATE_STADIUM:
        score += 3 + (w.ACTIVATE_STADIUM || 0);
        break;
      case ACTION.ATTACK:
        score += Math.min(60, (f.damage || 0) * 0.35);
        if (f.canKO) score += 70;
        score += (f.prizes || 0) * 15;
        if (f.mayVary) score -= 5;
        score += (w.ATTACK || 0);
        break;
      case ACTION.RETREAT: {
        const activeRatio = f.activeMaxHp ? (f.activeHp || 0) / f.activeMaxHp : 1;
        const incomingRatio = f.incomingMaxHp ? (f.incomingHp || 0) / f.incomingMaxHp : 1;
        // 只在「战斗宝可梦濒危且后备更健康」时撤退
        score += (activeRatio <= 0.4 && incomingRatio > activeRatio + 0.2) ? 35 : -40;
        score += (w.RETREAT || 0);
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
 * 混合 AI（默认模式）：**启发式算数 + LLM 取舍**。
 *
 * 工作方式：
 *   - 启发式先算好候选与事实（伤害/KO/奖赏），并作为永远可用的兜底；
 *   - 只在「关键决策点」（攻击/训练家/特性/撤退/进化）且候选≥2 时问模型；
 *   - 每回合限制调用次数（默认 2 次），其余动作走启发式 —— 兼顾质量与延迟；
 *   - 三道闸：① 输出可解析 ② id 在候选内 ③ 引擎执行时再校验；任一失败均回退启发式；
 *   - 无 API Key、超时、报错 → 自动降级，不阻塞对局（失败后冷却一段时间，避免每个动作都等超时）。
 */
export class LlmPolicy extends HeuristicPolicy {
  constructor(engine, options = {}) {
    super(engine, options.player);
    this.options = options;
    this.llmTimeoutMs = Number.isFinite(options.llmTimeoutMs) ? options.llmTimeoutMs : 8000;
    this.maxLlmCallsPerTurn = Number.isFinite(options.maxLlmCallsPerTurn) ? options.maxLlmCallsPerTurn : 2;
    this.cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 60000;
    this._cooldownUntil = 0;
    this._askedTurn = -1;
    this._askedThisTurn = 0;
    this._warnedOnce = false;
    this.stats = { asked: 0, accepted: 0, rejected: 0, failed: 0, fallback: 0 };
    // 测试/调试可注入 fetch
    this.fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  }

  /** 关键决策点才值得花一次模型调用 */
  _isKeyDecision(actions) {
    const kinds = new Set(actions.map(a => a.kind));
    if (actions.length < 2) return false;
    if (kinds.has(ACTION.ATTACK)) return true;
    if (kinds.has(ACTION.RETREAT)) return true;
    if (kinds.has(ACTION.USE_TRAINER) && actions.filter(a => a.kind === ACTION.USE_TRAINER).length >= 2) return true;
    if (kinds.has(ACTION.USE_ABILITY)) return true;
    if (kinds.has(ACTION.EVOLVE)) return true;
    return false;
  }

  _canAskLlm(actions) {
    if (!this.fetchImpl) return false;
    if (Date.now() < this._cooldownUntil) return false;
    if (!getAiApiKey()) return false;
    if (!this._isKeyDecision(actions)) return false;
    const turn = this.gs.turn;
    if (this._askedTurn !== turn) { this._askedTurn = turn; this._askedThisTurn = 0; }
    return this._askedThisTurn < this.maxLlmCallsPerTurn;
  }

  async chooseAction(actions = []) {
    const fallback = await super.chooseAction(actions);
    if (!actions.length) return fallback;
    if (!this._canAskLlm(actions)) return fallback;

    this._askedThisTurn += 1;
    this.stats.asked += 1;
    const picked = await this._askLlm(actions);
    if (picked) { this.stats.accepted += 1; return picked; }
    this.stats.rejected += 1;
    return fallback;
  }

  /** 调用模型并做三道闸校验（返回合法 action 或 null） */
  async _askLlm(actions) {
    const stateText = serializeBattleState(this.gs, this.player, { recentLogs: 4 });
    const actionText = formatActionList(actions);
    const messages = buildLlmMessages(stateText, actionText);
    const settings = getAiSettings({});
    const model = normalizeAiModelName(settings.model) || AI_DEFAULT_MODEL;
    const body = {
      model,
      messages,
      max_tokens: 120,
      temperature: 0,
      stream: false,
      // 关闭思考模式：战斗决策要求低延迟（开启会先输出大段 CoT）
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.llmTimeoutMs) : null;
    try {
      const resp = await this.fetchImpl(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAiApiKey()}` },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (!resp || !resp.ok) throw new Error(`API ${resp?.status ?? 'error'}`);
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      // 闸 1：输出可解析
      const id = extractActionId(content);
      if (!id) throw new Error('unparsable_output');
      // 闸 2：id 必须在本次候选内
      const action = actions.find(a => a.id === id);
      if (!action) throw new Error(`unknown_action:${id}`);
      return action;
    } catch (err) {
      this.stats.failed += 1;
      this.stats.fallback += 1;
      // 失败后冷却，避免每个动作都白等一个超时
      this._cooldownUntil = Date.now() + this.cooldownMs;
      if (!this._warnedOnce) {
        this._warnedOnce = true;
        this.engine?.cb?.onLog?.(`AI 模型暂不可用，改用启发式策略（${err?.message || err}）`);
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 策略工厂（默认混合模式：无 Key / 失败自动降级为纯启发式） */
export function createAiPolicy(engine, options = {}) {
  const mode = options.mode || 'hybrid';
  if (mode === 'heuristic') return new HeuristicPolicy(engine, options.player);
  return new LlmPolicy(engine, options);
}
