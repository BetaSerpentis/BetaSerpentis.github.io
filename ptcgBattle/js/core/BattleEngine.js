// js/core/BattleEngine.js
import { PHASE } from './GameState.js';
import { executeEffects, payDiscardCostFromHand } from './EffectExecutor.js';

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
const MAX_AI_ACTIONS = 3;

export class BattleEngine {
  constructor(gameState, resolver, callbacks = {}) {
    this.gs = gameState;
    this.resolver = resolver;
    if (resolver) this.gs.cardResolver = resolver;
    this.cb = callbacks;
    this._aiTurnInProgress = false;
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
    if (!p1.active) { this.cb.onLog?.('请先放置战斗宝可梦'); return false; }
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
      if (this._findBasicPokemonInHand(player) >= 0) return this._autoSetup(player);
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
    const ok = gs.useTrainer(pl, paidHandIndex, cardData, targetSlot);
    const shouldExecuteEffects = ok && effects.length && cardData.trainerType !== 'stadium';
    // Stadium activation effects (for cards like 城镇百货公司) are future work:
    // playing a Stadium only places/replaces it and must not fire its ordinary parsed effects.
    if (shouldExecuteEffects) {
      await executeEffects(gs, pl, effects.filter(e => e.action !== 'trainer_prerequisite'), { trainerCard:usedCard, trainerCardData:cardData });
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
    gs.addLog(`${player.name} 使用了竞技场「${check.stadium.name}」`);
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
    if (!check.ok) { this.cb.onLog?.(gs._abilityReasonText?.(check.reason) || '无法使用特性'); return false; }
    gs.markAbilityUsed?.(pl, source, check.ability, check.zone);
    gs.addLog(`${pl.name} 使用了特性「${check.ability.name}」`);
    const effects = (check.ability.effects || []).map(e => ({ ...e, params: { ...(e.params || {}) }, source, sourceAbility: check.ability, sourceZone: check.zone }));
    await executeEffects(gs, pl, effects);
    gs.recomputePassives?.();
    this.cb.onFieldUpdate?.();
    return true;
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
    if (status.includes('confusion') && Math.random() >= 0.5) { atk.active.hp -= 30; this.cb.onLog?.('混乱判定失败，自己受到30伤害'); if (atk.active.hp <= 0) gs.knockout(atk); return false; }
    if (atk.active.cannotAttackNext) { this.cb.onLog?.('无法攻击'); return false; }
    if (!def.active) { this.cb.onLog?.('对手无宝可梦'); return false; }

    const attacks = atk.active.attacks || [];
    const ai = Number.isInteger(attackIndex) ? attackIndex : 0;
    const move = attacks[ai];
    if (!move) { this.cb.onLog?.('招式不存在'); return false; }

    // Check energy (with costEliminated override)
    if (!atk.active.costEliminated && !gs.checkEnergy(atk.active, ai)) {
      const cost = (move.cost || []).join('+');
      this.cb.onLog?.(`能量不足！需要 ${cost || '无消耗'}`);
      return false;
    }

    const moveName = move.name || '攻击';

    // Execute pre-damage failure checks first (coin flip failure, etc.).
    const preEffects = (move.effects || []).filter(e => e.action === 'coin_flip' && e.params?.fail_on_tails);
    const postEffects = (move.effects || []).filter(e => !(e.action === 'coin_flip' && e.params?.fail_on_tails));
    if (preEffects.length && !def.active.preventEffect) {
      try { await executeEffects(gs, atk, preEffects, { propagateFailure: true }); }
      catch(e) { this.cb.onLog?.('招式失败'); return false; }
    }

    let damage = move ? (parseInt(String(move.damage).match(/\d+/)?.[0]) || 0) : 20;

    // Weakness/resistance: simplified PTCG handling. Weakness x2, resistance -30.
    if (damage > 0 && def.active.weakness && def.active.weakness === atk.active.element && !(atk.active.ignore||[]).includes('weakness')) damage *= 2;
    if (damage > 0 && def.active.resistance && def.active.resistance === atk.active.element && !(atk.active.ignore||[]).includes('resistance')) damage = Math.max(0, damage - 30);

    // Apply damage modifier
    damage += (atk.active.damageMod || 0);
    damage += gs.getPassiveDamageModifier?.(atk.active, def.active, move, atk) || 0;
    for (const e of (atk.active.energy||[])) {
      if (e?.specialRules?.damageBonus) damage += e.specialRules.damageBonus;
    }
    for (const e of (def.active.energy||[])) {
      if (e?.specialRules?.damageReduction) damage -= e.specialRules.damageReduction;
    }
    if (damage < 0) damage = 0;

    // Prevent damage check
    if (def.active.preventDamage) {
      this.cb.onLog?.(`${def.active.name} 防止了伤害`);
      damage = 0;
    }

    // Apply damage
    if (damage > 0) {
      def.active.hp -= damage;
      gs.addLog(`${atk.active.name} 使用了「${moveName}」！造成 ${damage} 伤害`);
      this.cb.onLog?.(`${moveName} → ${damage}伤害`);
    }

    // Execute skill effects (unless prevented)
    if (postEffects.length && !def.active.preventEffect) {
      await executeEffects(gs, atk, postEffects);
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
      setTimeout(async () => { await this._aiTurn(); }, 800);
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

  async _aiTurn() {
    const gs = this.gs;
    if (gs.phase === PHASE.GAME_OVER || gs.currentPlayer !== gs.player2) return;
    if (this._aiTurnInProgress) return;

    this._aiTurnInProgress = true;
    try {
      this.cb.onLog?.('对手回合');
      let budget = MAX_AI_ACTIONS;

      if (gs.phase === PHASE.DRAW && budget-- > 0) gs.nextPhase();
      if (gs.phase === PHASE.MAIN && budget-- > 0) {
        gs.setPhase(PHASE.BATTLE);
        this.cb.onLog?.('对手进入战斗阶段');
        this.cb.onPhaseChange?.(gs.phase);
        this.cb.onFieldUpdate?.();
      }

      if (gs.phase === PHASE.BATTLE && budget-- > 0) {
        const attackIndex = this._firstLegalAttackIndex(gs.player2);
        if (attackIndex >= 0) {
          const ok = await this.attack(attackIndex);
          if (!ok && gs.currentPlayer === gs.player2 && gs.phase !== PHASE.GAME_OVER) this._passAiTurn('攻击失败，回合结束');
        } else {
          this._passAiTurn('无法攻击，回合结束');
        }
      } else if (gs.currentPlayer === gs.player2 && gs.phase !== PHASE.GAME_OVER) {
        this._passAiTurn();
      }
    } catch (err) {
      this.cb.onLog?.(`对手行动异常，回合结束：${err?.message || err}`);
      if (gs.currentPlayer === gs.player2 && gs.phase !== PHASE.GAME_OVER) this.finishTurn();
    } finally {
      this._aiTurnInProgress = false;
      this.cb.onPhaseChange?.(gs.phase);
      this.cb.onFieldUpdate?.();
    }
  }
}
