// js/core/BattleEngine.js
import { PHASE } from './GameState.js';
import { executeEffects, payDiscardCostFromHand } from './EffectExecutor.js';
import { getLegalActions, describeAction, ACTION } from './ActionSpace.js';
import { createAiPolicy } from './AiPolicy.js';

const EFF_NAMES = {
  draw:'抽牌', draw_until:'补牌', heal:'回血', switch_pokemon:'换位',
  discard_hand:'弃牌', discard_all_hand:'弃全部手牌', shuffle_hand_to_deck:'洗牌',
  return_to_hand:'回手', inflict_status:'状态', extra_prize:'拿奖品', end_turn:'结束回合',
  peek_and_keep:'看牌选卡', search_deck_to_hand:'搜牌加手', search_deck_to_bench:'搜牌放场',
  attach_energy_from_discard:'回收能量', attach_energy_from_deck:'牌库附能',
  recover_from_discard:'弃区回收', move_energy:'能量换位'
};

const SETUP_HAND_SIZE = 7;
const MAX_OPPONENT_MULLIGANS = 20;
const MAX_AI_ACTIONS = 3; // legacy：旧的「写死三步」预算，已被逐步动作循环取代
/** AI 回合逐步播放：每个动作之间的停顿（毫秒）；0 = 不停顿（批量测试用） */
const AI_ACTION_DELAY_MS = 2000;
/** AI 单回合最多执行动作数（防死循环） */
const MAX_AI_STEPS = 40;

function _cloneForTrainerTransaction(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(_cloneForTrainerTransaction(item, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    out[key] = _cloneForTrainerTransaction(item, seen);
  }
  return out;
}

function _snapshotPlayerForTrainerTransaction(player) {
  return {
    hand: _cloneForTrainerTransaction(player.hand),
    discard: _cloneForTrainerTransaction(player.discard),
    deck: _cloneForTrainerTransaction(player.deck),
    prizes: _cloneForTrainerTransaction(player.prizes),
    active: _cloneForTrainerTransaction(player.active),
    bench: _cloneForTrainerTransaction(player.bench),
    supporterUsed: player.supporterUsed,
    energyAttached: player.energyAttached,
    retreatUsed: player.retreatUsed,
    abilityUsedThisTurn: _cloneForTrainerTransaction(player.abilityUsedThisTurn || {}),
    stadiumUsedThisTurn: _cloneForTrainerTransaction(player.stadiumUsedThisTurn || {}),
  };
}

function _restorePlayerForTrainerTransaction(player, snapshot) {
  player.hand = _cloneForTrainerTransaction(snapshot.hand);
  player.discard = _cloneForTrainerTransaction(snapshot.discard);
  player.deck = _cloneForTrainerTransaction(snapshot.deck);
  player.prizes = _cloneForTrainerTransaction(snapshot.prizes);
  player.active = _cloneForTrainerTransaction(snapshot.active);
  player.bench = _cloneForTrainerTransaction(snapshot.bench);
  player.supporterUsed = snapshot.supporterUsed;
  player.energyAttached = snapshot.energyAttached;
  player.retreatUsed = snapshot.retreatUsed;
  player.abilityUsedThisTurn = _cloneForTrainerTransaction(snapshot.abilityUsedThisTurn || {});
  player.stadiumUsedThisTurn = _cloneForTrainerTransaction(snapshot.stadiumUsedThisTurn || {});
}

function _stadiumSnapshotSource(gs) {
  return gs.stadium || gs.activeStadium || gs.player1?.stadium || gs.player2?.stadium || null;
}

function _stadiumOwnerKey(gs, stadium) {
  if (!stadium) return null;
  if (stadium.owner === gs.player1) return 'player1';
  if (stadium.owner === gs.player2) return 'player2';
  if (gs.player1?.stadium === stadium && gs.player2?.stadium !== stadium) return 'player1';
  if (gs.player2?.stadium === stadium && gs.player1?.stadium !== stadium) return 'player2';
  return null;
}

function _restoreSharedStadiumForTrainerTransaction(gs, snapshot) {
  const stadium = snapshot.stadium ? _cloneForTrainerTransaction(snapshot.stadium) : null;
  gs.stadium = stadium;
  gs.activeStadium = stadium;
  gs.player1.stadium = null;
  gs.player2.stadium = null;
  if (!stadium) return;
  if (snapshot.stadiumOwner === 'player1') {
    stadium.owner = gs.player1;
    gs.player1.stadium = stadium;
  } else if (snapshot.stadiumOwner === 'player2') {
    stadium.owner = gs.player2;
    gs.player2.stadium = stadium;
  } else {
    stadium.owner = null;
  }
}

function _snapshotTrainerTransaction(gs) {
  const stadium = _stadiumSnapshotSource(gs);
  const stadiumSnapshot = _cloneForTrainerTransaction(stadium);
  if (stadiumSnapshot && typeof stadiumSnapshot === 'object') stadiumSnapshot.owner = null;
  return {
    logLength: Array.isArray(gs.log) ? gs.log.length : 0,
    player1: _snapshotPlayerForTrainerTransaction(gs.player1),
    player2: _snapshotPlayerForTrainerTransaction(gs.player2),
    stadium: stadiumSnapshot,
    stadiumOwner: _stadiumOwnerKey(gs, stadium),
    temporaryAbilityLocks: _cloneForTrainerTransaction(gs.temporaryAbilityLocks || []),
    winner: gs.winner,
    phase: gs.phase,
  };
}

function _restoreTrainerTransaction(gs, snapshot) {
  _restorePlayerForTrainerTransaction(gs.player1, snapshot.player1);
  _restorePlayerForTrainerTransaction(gs.player2, snapshot.player2);
  _restoreSharedStadiumForTrainerTransaction(gs, snapshot);
  gs.temporaryAbilityLocks = _cloneForTrainerTransaction(snapshot.temporaryAbilityLocks || []);
  gs.winner = snapshot.winner;
  gs.phase = snapshot.phase;
  if (Array.isArray(gs.log)) gs.log.splice(snapshot.logLength);
  else gs.log = [];
  gs.recomputePassives?.();
}

export class BattleEngine {
  constructor(gameState, resolver, callbacks = {}) {
    this.gs = gameState;
    this.resolver = resolver;
    if (resolver) this.gs.cardResolver = resolver;
    this.cb = callbacks;
    this._aiTurnInProgress = false;
    // AI 决策策略：默认「混合模式」（启发式算数 + LLM 取舍），无 Key 或调用失败自动降级启发式
    this._aiPolicy = createAiPolicy(this, {
      mode: callbacks.aiMode || 'hybrid',
      player: gameState.player2,
      llmTimeoutMs: callbacks.llmTimeoutMs,
      maxLlmCallsPerTurn: callbacks.maxLlmCallsPerTurn,
      fetchImpl: callbacks.fetchImpl,
    });
    // 动作间隔（可见性）：让玩家能看清对手的每个动作
    this.aiActionDelayMs = Number.isFinite(callbacks.aiActionDelayMs) ? callbacks.aiActionDelayMs : AI_ACTION_DELAY_MS;
    // 回合交接后自动开始对手回合的延迟；<0 表示禁用自动触发（测试手动驱动）
    this.aiAutoplayDelayMs = Number.isFinite(callbacks.aiAutoplayDelayMs) ? callbacks.aiAutoplayDelayMs : 800;
  }

  startGame(p1Deck, p2Deck) {
    this.gs.init(p1Deck, p2Deck);
    this.cb.onPhaseChange?.(PHASE.SETUP);
  }

  placeActivePokemon(handIndex, cardData = null) {
    const placed = this.gs.placeActive(this.gs.currentPlayer, handIndex, cardData);
    this.cb.onFieldUpdate?.();
    return Boolean(placed);
  }

  placeBenchPokemon(handIndex, cardData = null) {
    const player = this.gs.currentPlayer;
    const placed = this.gs.placeBench(player, handIndex, cardData);
    this.cb.onFieldUpdate?.();
    return Boolean(placed);
  }

  confirmSetup() {
    const p1 = this.gs.player1, p2 = this.gs.player2;
    if (!p1.active) {
      if (!this.gs.hasBasicInHand(p1)) this.cb.onLog?.('手牌没有基础宝可梦：请先重新抽牌');
      else this.cb.onLog?.('请先放置战斗宝可梦');
      return false;
    }
    if (!p2.active && !this._autoSetupWithMulligan(p2)) {
      this.cb.onLog?.('对手无法完成布置：请重新开始或更换对手卡组');
      this.cb.onPhaseChange?.(this.gs.phase);
      this.cb.onFieldUpdate?.();
      return false;
    }

    this.gs.turn = 1;
    this.gs.currentPlayer = p1;
    this.gs.firstPlayer = p1;
    this.gs.firstPlayerFirstTurnInProgress = true;
    this.gs.setPhase(PHASE.DRAW);
    this.gs.player1.draw(1);
    this.cb.onLog?.('第1回合');
    this.gs.nextPhase();
    this.cb.onPhaseChange?.(this.gs.phase);
    this.cb.onFieldUpdate?.();
    return true;
  }

  _isBasicPokemon(cardData) {
    return cardData?.cardType === 'pokemon' && (!cardData.stage || cardData.stage === '基础') && !cardData.evolvesFrom;
  }

  _findBasicPokemonInHand(player) {
    return player.hand.findIndex(cid => this._isBasicPokemon(this.resolver?.getCard(cid)));
  }

  _hasBasicPokemonInOpeningPool(player) {
    return [...player.hand, ...player.deck].some(cid => this._isBasicPokemon(this.resolver?.getCard(cid)));
  }

  // 玩家重新抽起始手牌：每发生一次，对手额外抽 1 张（规则补偿，奖赏卡已放置完毕）
  mulliganPlayer(pl = this.gs.player1) {
    const count = this.gs.mulliganHand(pl);
    const opp = this.gs.getOpponent(pl);
    if (opp) {
      opp.draw(1);
      this.gs.addLog(`${opp.name} 因对手重新抽牌，额外抽 1 张卡`);
    }
    this.cb.onFieldUpdate?.();
    return count;
  }

  _redealOpeningHand(player) {
    player.deck = this.gs._shuffle([...player.deck, ...player.hand]);
    player.hand = [];
    player.draw(SETUP_HAND_SIZE);
  }

  _autoSetupWithMulligan(player) {
    if (player.active) return true;
    if (this._findBasicPokemonInHand(player) >= 0) return this._autoSetup(player);
    if (!this._hasBasicPokemonInOpeningPool(player)) {
      this.cb.onLog?.('对手无法完成布置：牌库和手牌中没有基础宝可梦');
      return false;
    }

    for (let attempt = 1; attempt <= MAX_OPPONENT_MULLIGANS; attempt++) {
      this._redealOpeningHand(player);
      this.cb.onLog?.(`对手重新抽起始手牌（第${attempt}次）`);
      if (this._findBasicPokemonInHand(player) >= 0) {
        // 规则补偿：对手每重新抽一次，另一方额外抽 1 张
        const me = this.gs.getOpponent(player);
        if (me) {
          me.draw(attempt);
          this.gs.addLog(`${me.name} 因对手重新抽牌，额外抽 ${attempt} 张卡`);
        }
        this.gs.mulliganCount = this.gs.mulliganCount || { player1: 0, player2: 0 };
        this.gs.mulliganCount[player === this.gs.player1 ? 'player1' : 'player2'] += attempt;
        return this._autoSetup(player);
      }
    }

    this.cb.onLog?.('对手重新抽起始手牌次数过多，仍未找到基础宝可梦');
    return false;
  }

  _autoSetup(player) {
    if (player.active) return true;
    const activeIndex = this._findBasicPokemonInHand(player);
    if (activeIndex < 0) {
      this.cb.onLog?.('对手没有可放置的基础宝可梦');
      return false;
    }
    const activeId = player.hand[activeIndex];
    const placedActive = this.gs.placeActive(player, activeIndex, this.resolver.getCard(activeId));
    if (!placedActive) {
      this.cb.onLog?.('对手自动布置失败：未能放置战斗宝可梦');
      return false;
    }
    while (player.bench.length < 3) {
      const benchIndex = this._findBasicPokemonInHand(player);
      if (benchIndex < 0) break;
      const benchId = player.hand[benchIndex];
      const placed = this.gs.placeBench(player, benchIndex, this.resolver.getCard(benchId));
      if (!placed) break;
    }
    this.cb.onLog?.('对手已完成布置');
    return true;
  }

  advancePhase() {
    const gs = this.gs;
    if (gs.phase === PHASE.GAME_OVER) return;
    switch (gs.phase) {
      case PHASE.SETUP: return this.confirmSetup();
      case PHASE.MAIN: gs.setPhase(PHASE.BATTLE); this.cb.onLog?.('战斗阶段'); break;
      case PHASE.BATTLE: gs.setPhase(PHASE.END); this.cb.onLog?.('跳过攻击'); break;
      case PHASE.END: return this.finishTurn();
      default: gs.nextPhase();
    }
    this.cb.onPhaseChange?.(gs.phase);
    this.cb.onFieldUpdate?.();
  }

  async attachEnergy(handIndex, cardData, targetSlot) {
    const pl = this.gs.currentPlayer;
    const ok = this.gs.attachEnergy(pl, handIndex, cardData, targetSlot);
    if (ok) await this._runAttachEnergyTriggers(pl, targetSlot);
    this.cb.onFieldUpdate?.();
    return ok;
  }

  async _runAttachEnergyTriggers(pl, targetSlot) {
    const source = targetSlot === 'active' ? pl.active : (targetSlot?.startsWith('bench-') ? pl.bench[parseInt(targetSlot.replace('bench-', ''))] : null);
    if (!source?.ability?.effects?.length || source.abilityDisabled) return;
    const trigger = source.ability.effects.find(e => e.action === 'attach_energy_trigger' && e.params?.event === 'attach_energy_from_hand');
    if (!trigger) return;
    const zone = this.gs.inferAbilityZone?.(pl, source) || source.ability.zone || 'field';
    if (trigger.params?.sourceZone && zone !== trigger.params.sourceZone) return;
    if (trigger.params?.target === 'self' && source !== (targetSlot === 'active' ? pl.active : source)) return;
    this.gs.addLog(`${pl.name} 触发特性「${source.ability.name}」`);
    const effects = (trigger.params.effects || []).map(e => ({ ...e, params:{ ...(e.params || {}) }, source, sourceAbility:source.ability, sourceZone:zone }));
    await executeEffects(this.gs, pl, effects);
    this.gs.recomputePassives?.();
  }

  evolvePokemon(handIndex, cardData, targetSlot) {
    const ok = this.gs.evolve(this.gs.currentPlayer, handIndex, cardData, targetSlot);
    this.cb.onFieldUpdate?.();
    return ok;
  }

  /** 撤退（每回合一次；能量不足或状态限制时返回 false） */
  retreat(benchIndex, energyIndices = null) {
    const ok = this.gs.retreat(this.gs.currentPlayer, benchIndex, energyIndices);
    this.cb.onFieldUpdate?.();
    return ok;
  }

  async useTrainer(handIndex, cardData, targetSlot = null) {
    const gs = this.gs;
    const pl = gs.currentPlayer;
    const effects = cardData.effects || [];
    const legality = gs.canUseTrainer ? gs.canUseTrainer(pl, cardData, targetSlot) : { ok: true };
    if (!legality.ok) {
      gs.addLog(gs._trainerLegalityMessage?.(legality) || '无法使用训练家卡');
      this.cb.onFieldUpdate?.();
      return false;
    }

    const transaction = _snapshotTrainerTransaction(gs);
    const discardCosts = effects.filter(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'discard_cost');
    let paidHandIndex = handIndex;
    for (const cost of discardCosts) {
      const paid = await payDiscardCostFromHand(gs, pl, cost.params || {}, { trainerHandIndex: paidHandIndex });
      if (!paid.ok) {
        this.cb.onFieldUpdate?.();
        return false;
      }
      paidHandIndex = paid.handIndex;
    }
    const usedCard = pl.hand[paidHandIndex];
    const ok = gs.useTrainer(pl, paidHandIndex, cardData, targetSlot, usedCard);
    const shouldExecuteEffects = ok && effects.length && cardData.trainerType !== 'stadium';
    // Stadium activation effects (for cards like 城镇百货公司) are future work:
    // playing a Stadium only places/replaces it and must not fire its ordinary parsed effects.
    if (shouldExecuteEffects) {
      try {
        await executeEffects(gs, pl, effects.filter(e => e.action !== 'trainer_prerequisite'), { trainerCard:usedCard, trainerCardData:cardData, failRequired: true });
      } catch (err) {
        _restoreTrainerTransaction(gs, transaction);
        gs.addLog(`训练家「${cardData.name || usedCard || '卡'}」使用取消：${err?.message || '必需效果未完成'}`);
        this.cb.onFieldUpdate?.();
        return false;
      }
    }
    this.cb.onFieldUpdate?.();
    return ok;
  }

  async activateStadium(player = this.gs.currentPlayer) {
    const gs = this.gs;
    const check = gs.canActivateStadium ? gs.canActivateStadium(player) : { ok:false, message:'无法使用竞技场' };
    if (!check.ok) {
      gs.addLog(check.message || '无法使用竞技场');
      this.cb.onFieldUpdate?.();
      return false;
    }
    gs.markStadiumUsed?.(player, check.stadium);
    // 文案区分「发动竞技场效果」（双方每回合各一次，规则允许）与「打出竞技场卡」，避免误认为重复打出
    gs.addLog(`${player.name} 发动了竞技场「${check.stadium.name}」的效果`);
    await executeEffects(gs, player, check.effects);
    gs.recomputePassives?.();
    this.cb.onFieldUpdate?.();
    return true;
  }

  async useAbility(source, ability = null, options = {}) {
    const gs = this.gs;
    const pl = options.player || gs.currentPlayer;
    const ab = ability || source?.ability;
    const check = gs.canUseAbility ? gs.canUseAbility(pl, source, ab, options.zone) : { ok: !!ab, ability: ab, zone: options.zone || 'field' };
    if (!check.ok) { this.cb.onLog?.(check.message || gs._abilityReasonText?.(check.reason) || '无法使用特性'); return false; }
    const effects = (check.ability.effects || []).map(e => ({ ...e, params: { ...(e.params || {}) }, source, sourceAbility: check.ability, sourceZone: check.zone }));
    const transaction = _snapshotTrainerTransaction(gs);
    try {
      await executeEffects(gs, pl, this._abilityCostEffects(effects), { propagateFailure: true });
      gs.addLog(`${pl.name} 使用了特性「${check.ability.name}」`);
      await executeEffects(gs, pl, effects.filter(e => e.action !== 'ability_discard_cost'), { propagateFailure: true });
      gs.markAbilityUsed?.(pl, source, check.ability, check.zone);
    } catch(e) {
      _restoreTrainerTransaction(gs, transaction);
      gs.addLog(e?.message === 'ability_cost_unpaid' ? '特性费用未支付' : `特性「${check.ability.name}」使用取消：${e?.message || '效果未完成'}`);
      this.cb.onFieldUpdate?.();
      return false;
    }
    gs.recomputePassives?.();
    this.cb.onFieldUpdate?.();
    return true;
  }

  _abilityCostEffects(effects) {
    return (effects || []).filter(e => e.action === 'ability_discard_cost');
  }

  async attack(attackIndex = 0) {
    const gs = this.gs;
    const atk = gs.currentPlayer;
    const def = (atk === gs.player1) ? gs.player2 : gs.player1;

    if (gs.phase !== PHASE.BATTLE) { this.cb.onLog?.('非战斗阶段'); return false; }
    if (gs.firstPlayerFirstTurnInProgress && atk === gs.firstPlayer) {
      const msg = '先攻玩家最初回合不能攻击';
      gs.addLog?.(msg);
      this.cb.onLog?.(msg);
      this.cb.onFieldUpdate?.();
      return false;
    }
    if (!atk.active) { this.cb.onLog?.('无战斗宝可梦'); return false; }
    const status = atk.active.status || '';
    if (status.includes('sleep') || status.includes('paralysis')) { this.cb.onLog?.('睡眠/麻痹中无法攻击'); return false; }
    if (status.includes('confusion') && Math.random() >= 0.5) { atk.active.hp = Math.max(0, atk.active.hp - 30); this.cb.onLog?.('混乱判定失败，自己受到30伤害'); if (atk.active.hp <= 0) gs.knockout(atk); return false; }
    if (atk.active.cannotAttackNext) { this.cb.onLog?.('无法攻击'); return false; }
    if (!def.active) { this.cb.onLog?.('对手无宝可梦'); return false; }

    const attacks = atk.active.attacks || [];
    const ai = Number.isInteger(attackIndex) ? attackIndex : 0;
    const move = attacks[ai];
    if (!move) { this.cb.onLog?.('招式不存在'); return false; }

    // Check energy (with costEliminated override)
    if (!atk.active.costEliminated && !gs.checkEnergy(atk.active, ai)) {
      const cost = (gs.adjustedAttackCost?.(atk.active, move) || move.cost || []).join('+');
      this.cb.onLog?.(`能量不足！需要 ${cost || '无消耗'}`);
      return false;
    }

    const moveName = move.name || '攻击';

    // Execute pre-damage failure checks first (coin flip failure, etc.), plus discard-for-damage costs. 
    const DAMAGE_CALC_ACTIONS = new Set(['conditional_damage_mod', 'passive_damage_mod', 'trigger']);
    const preEffects = (move.effects || []).filter(e => (e.action === 'coin_flip' && e.params?.fail_on_tails) || e.action === 'discard_energy_for_damage');
    const postEffects = (move.effects || []).filter(e => !((e.action === 'coin_flip' && e.params?.fail_on_tails) || e.action === 'discard_energy_for_damage' || DAMAGE_CALC_ACTIONS.has(e.action)));
    if (preEffects.length && !def.active.preventEffect) {
      try { await executeEffects(gs, atk, preEffects, { propagateFailure: true }); }
      catch(e) { this.cb.onLog?.('招式失败'); return false; }
    }

    let damage = move ? (parseInt(String(move.damage).match(/\d+/)?.[0]) || 0) : 20;
    damage += (atk.active.nextOwnTurnDamageBoost || 0);
    atk.active.nextOwnTurnDamageBoost = 0;
    damage += gs.getConditionalDamageModifier?.(atk.active, def.active, move, atk) || 0;

    // Weakness/resistance: 弱点倍率/抵抗值来自真实卡牌数据（简中 CN-Sync），缺省时退回 x2 / -30。
    // 需求：命中弱点/被抵抗时要在日志里体现，否则玩家注意不到
    if (damage > 0 && def.active.weakness && def.active.weakness === atk.active.element && !(atk.active.ignore||[]).includes('weakness') && !gs._hasPassive?.(def.active, 'weakness_null')) {
      const mult = def.active.weaknessMultiplier || 2;
      damage *= mult;
      this.cb.onLog?.(`命中弱点，效果绝佳！（${atk.active.element} → ${def.active.weakness}，伤害 ×${mult}）`);
    }
    if (damage > 0 && def.active.resistance && def.active.resistance === atk.active.element && !(atk.active.ignore||[]).includes('resistance')) {
      const val = def.active.resistanceValue ?? -30;
      damage = Math.max(0, damage + val);
      this.cb.onLog?.(`被抵抗，效果一般…（伤害 ${val}）`);
    }

    // Apply damage modifier
    damage += (atk.active.damageMod || 0);
    damage += gs.getPassiveDamageModifier?.(atk.active, def.active, move, atk) || 0;
    for (const e of (atk.active.energy||[])) {
      if (e?.specialRules?.damageBonus) damage += e.specialRules.damageBonus;
    }
    for (const e of (def.active.energy||[])) {
      if (e?.specialRules?.damageReduction) damage -= e.specialRules.damageReduction;
    }
    // 受到招式的伤害±N（防守方：一次性标记 + 能力被动运行时查询）
    damage += (def.active.damageReceivedMod || 0) + (gs.getPassiveDamageReceivedModifier?.(def.active) || 0);
    // 受到招式效果：本回合该宝可梦攻击伤害 -N（一次性）
    if ((atk.active.attackDamageReduction || 0) > 0) {
      damage = Math.max(0, damage - atk.active.attackDamageReduction);
      this.cb.onLog?.(`${atk.active.name} 招式伤害被减少 ${atk.active.attackDamageReduction}`);
      atk.active.attackDamageReduction = 0;
    }
    if (damage < 0) damage = 0;

    // Prevent damage check
    if (def.active.preventDamage) {
      this.cb.onLog?.(`${def.active.name} 防止了伤害`);
      damage = 0;
    }

    // Apply attack damage. 幸存锻炼器 is intentionally scoped to this direct
    // BattleEngine.attack path: full-HP attached Pokemon that would be KO'd by
    // opponent attack damage survives at 10 HP and discards the exact tool card.
    if (damage > 0) {
      const beforeHp = def.active.hp;
      const survivalTool = def.active.tool && (String(def.active.tool.cardId || '') === '11176' || def.active.tool.name === '幸存锻炼器') ? def.active.tool : null;
      // 需求：伤害溢出时血量最低为 0，不出现负值
      def.active.hp = Math.max(0, def.active.hp - damage);
      gs.addLog(`${atk.active.name} 使用了「${moveName}」！造成 ${damage} 伤害`);
      if (survivalTool && beforeHp === def.active.maxHp && def.active.hp <= 0) {
        const discarded = survivalTool.cardId || survivalTool.name || survivalTool;
        def.discard.push(discarded);
        def.active.tool = null;
        def.active.hp = 10;
        gs.addLog(`${def.active.name} 因「幸存锻炼器」以剩余HP 10 留在场上`);
      }
      this.cb.onLog?.(`${moveName} → ${damage}伤害`);
      // 受击事件：供道具/特性（如幸运头盔：受击时抽卡）触发
      if (def.active.hp > 0) gs.emitTriggerEvent?.('attacked_damage', { target: def.active, source: atk.active, damage });
    }

    // Execute skill effects (unless prevented)
    if (postEffects.length && !def.active.preventEffect) {
      for (const e of postEffects) { e._attackDamage = damage; }
      await executeEffects(gs, atk, postEffects);
    }

    // 受招式伤害时的反伤类效果：
    //   · 反射屏障（超梦）：反伤 = 受到的伤害数值，标记一次后消耗
    //   · 尖钉能量（特殊能量）：反伤 = 每张 2 个伤害指示物（20 伤害），附着期间持续生效
    if (damage > 0 && atk.active) {
      const defenderMon = def.active;
      let counterDamage = 0;
      const reasons = [];
      if (defenderMon?.mirrorDamageCounters) {
        counterDamage += damage;
        reasons.push('反射屏障');
        defenderMon.mirrorDamageCounters = false; // 每次受击反伤一次
      }
      const spikeCounters = (defenderMon?.energy || [])
        .reduce((sum, e) => sum + (e?.attackReflectCounters || 0), 0);
      if (spikeCounters > 0) {
        counterDamage += spikeCounters * 10;
        reasons.push('尖钉能量');
      }
      if (counterDamage > 0) {
        const attackerName = atk.active.name;
        atk.active.hp = Math.max(0, atk.active.hp - counterDamage);
        gs.addLog(`${defenderMon.name} 的${reasons.join('、')}：${attackerName} 受到 ${counterDamage} 伤害`);
        if (atk.active.hp <= 0) {
          gs.knockout(atk);
          this.cb.onLog?.(`${atk.active?.name || '攻击方'} 被反伤击倒`);
          if (gs.phase === PHASE.GAME_OVER) {
            this.cb.onPhaseChange?.(gs.phase);
            this.cb.onFieldUpdate?.();
            return true;
          }
        }
      }
    }

    if (def.active.hp <= 0) {
      gs.knockout(def);
      this.cb.onLog?.(`${def.active?.name || ''} 被击倒`);
      if (gs.phase === PHASE.GAME_OVER) {
        this.cb.onPhaseChange?.(gs.phase);
        this.cb.onFieldUpdate?.();
        return true;
      }
    }

    // A successful attack ends the player's turn immediately.
    this.finishTurn();
    return true;
  }

  finishTurn() {
    const gs = this.gs;
    gs.endTurn();
    if (gs.phase === PHASE.DRAW) gs.nextPhase();
    this.cb.onPhaseChange?.(gs.phase);
    this.cb.onFieldUpdate?.();
    if (gs.currentPlayer === gs.player2 && gs.phase !== PHASE.GAME_OVER && !this._aiTurnInProgress) {
      // aiAutoplayDelayMs < 0 时禁用自动触发（批量测试/外部手动驱动场景）
      if (this.aiAutoplayDelayMs >= 0) setTimeout(async () => { await this._aiTurn(); }, this.aiAutoplayDelayMs);
    }
  }

  _firstLegalAttackIndex(player) {
    const attacks = player.active?.attacks || [];
    return attacks.findIndex((_, i) => player.active?.costEliminated || this.gs.checkEnergy(player.active, i));
  }

  _passAiTurn(reason = '无可用行动，回合结束') {
    if (this.gs.currentPlayer !== this.gs.player2 || this.gs.phase === PHASE.GAME_OVER) return;
    this.cb.onLog?.(`对手${reason}`);
    this.finishTurn();
  }

  /**
   * AI 回合：逐动作循环。
   * 每轮重新枚举合法动作（手牌/阶段会变）→ 策略选一个 → 执行 → 停顿（可见性）→ 下一轮。
   * 效果执行中的选择由 gs.aiPickHandler 路由到策略，因此不会出现「等待玩家选牌」而卡死。
   */
  async _aiTurn() {
    const gs = this.gs;
    if (gs.phase === PHASE.GAME_OVER || gs.currentPlayer !== gs.player2) return;
    if (this._aiTurnInProgress) return;

    this._aiTurnInProgress = true;
    const prevPickHandler = gs.aiPickHandler;
    const prevMonPickHandler = gs.aiPokemonPickHandler;
    gs.aiPickHandler = pick => this._aiPolicy.choosePick(pick);
    gs.aiPokemonPickHandler = pick => this._aiPolicy.choosePokemonPick(pick);

    try {
      this.cb.onLog?.('对手回合');
      this.cb.onAiThinking?.(true);

      if (gs.phase === PHASE.DRAW) {
        gs.nextPhase();
        this.cb.onPhaseChange?.(gs.phase);
        this.cb.onFieldUpdate?.();
        await this._aiPause();
      }

      const failed = new Set();
      let stagnant = 0;
      let lastFingerprint = this._aiFingerprint();

      for (let step = 0; step < MAX_AI_STEPS; step++) {
        if (gs.phase === PHASE.GAME_OVER || gs.currentPlayer !== gs.player2) break;
        // 结束阶段无动作可做：直接交出回合，避免空转
        if (gs.phase === PHASE.END) { this.finishTurn(); break; }
        const actions = getLegalActions(gs, this.resolver, gs.player2)
          .filter(a => !failed.has(this._aiActionKey(a)));
        if (!actions.length) break;

        const action = await this._aiPolicy.chooseAction(actions);
        if (!action) break;

        this.cb.onAiAction?.({ action, desc: describeAction(action) });
        const result = await this._applyAiAction(action);
        if (result === false) failed.add(this._aiActionKey(action));

        this.cb.onPhaseChange?.(gs.phase);
        this.cb.onFieldUpdate?.();
        if (gs.phase === PHASE.GAME_OVER || gs.currentPlayer !== gs.player2) break;
        if (result && result.turnEnded) break;

        // 动作被引擎拒绝且未造成任何变化 → 防死循环
        const fingerprint = this._aiFingerprint();
        stagnant = fingerprint === lastFingerprint ? stagnant + 1 : 0;
        lastFingerprint = fingerprint;
        if (stagnant >= 3) {
          this.cb.onLog?.('对手连续无有效行动，回合结束');
          break;
        }
        await this._aiPause();
      }
    } catch (err) {
      this.cb.onLog?.(`对手行动异常，回合结束：${err?.message || err}`);
    } finally {
      this._aiTurnInProgress = false;
      gs.aiPickHandler = prevPickHandler || null;
      gs.aiPokemonPickHandler = prevMonPickHandler || null;
      this.cb.onAiThinking?.(false);
      // 兜底：回合未正常结束（异常/无动作可选）时也要交回玩家，避免卡在对手回合
      if (gs.currentPlayer === gs.player2 && gs.phase !== PHASE.GAME_OVER) this.finishTurn();
      this.cb.onPhaseChange?.(gs.phase);
      this.cb.onFieldUpdate?.();
    }
  }

  /** 外部/测试手动触发一次 AI 回合 */
  async runAiTurn() {
    await this._aiTurn();
  }

  /** 执行一个 AI 动作（人类侧的方法均按 gs.currentPlayer 工作；默认操作对手） */
  async _applyAiAction(action, player = this.gs.player2) {
    const gs = this.gs;
    const pl = player;
    const p = action?.params || {};
    const card = id => this.resolver?.getCard?.(id) || null;
    const handCard = idx => card(pl.hand?.[idx]);

    switch (action?.kind) {
      case ACTION.MULLIGAN:
        this.mulliganPlayer(pl);
        return true;
      case ACTION.PUT_ACTIVE:
        return this.placeActivePokemon(p.handIndex, handCard(p.handIndex));
      case ACTION.PUT_BENCH:
        return this.placeBenchPokemon(p.handIndex, handCard(p.handIndex));
      case ACTION.CONFIRM_SETUP:
        return this.confirmSetup();
      case ACTION.ATTACH_ENERGY:
        return this.attachEnergy(p.handIndex, handCard(p.handIndex), p.targetSlot);
      case ACTION.EVOLVE:
        return this.evolvePokemon(p.handIndex, handCard(p.handIndex), p.targetSlot);
      case ACTION.USE_TRAINER: {
        const cd = handCard(p.handIndex);
        if (!cd) return false;
        return this.useTrainer(p.handIndex, cd, p.targetSlot ?? null);
      }
      case ACTION.USE_ABILITY:
        return this.useAbility(p.source, p.ability, { player: pl, zone: p.zone });
      case ACTION.ACTIVATE_STADIUM:
        return this.activateStadium(pl);
      case ACTION.RETREAT:
        return this.retreat(p.benchIndex, p.energyIndices ?? null);
      case ACTION.ATTACK:
        return this.attack(p.attackIndex);
      case ACTION.PASS_PHASE:
        this.advancePhase();
        return true;
      case ACTION.END_TURN:
        this.finishTurn();
        return { turnEnded: true };
      default:
        return false;
    }
  }

  /** 动作指纹：用于「失败动作去重」与「无变化检测」 */
  _aiActionKey(action) {
    const p = action?.params || {};
    return [action?.kind, p.handIndex ?? '', p.targetSlot ?? '', p.attackIndex ?? '', p.benchIndex ?? '', action?.desc].join('|');
  }

  /** 动作间隔（可见性）：让玩家能看清除对手的每个动作 */
  _aiPause() {
    const ms = Number(this.aiActionDelayMs) || 0;
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 局面指纹（检测「动作执行了但什么都没变」） */
  _aiFingerprint() {
    const gs = this.gs;
    const pl = gs.player2;
    return [
      gs.phase, gs.turn,
      pl.hand.length, pl.discard.length, pl.deck.length, pl.prizes.length,
      pl.active?.hp ?? -1, pl.active?.energy?.length ?? 0, (pl.bench || []).length,
      pl.energyAttached ? 1 : 0, pl.supporterUsed ? 1 : 0, pl.retreatUsed ? 1 : 0,
      gs.player1.active?.hp ?? -1, gs.log.length,
    ].join('|');
  }
}
