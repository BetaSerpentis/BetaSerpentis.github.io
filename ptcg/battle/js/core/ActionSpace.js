// js/core/ActionSpace.js — 合法动作枚举（确定性代码，不依赖任何模型）
//
// 作用：把 GameState 转成「当前玩家可执行的合法动作列表」，供
//   ① AI 决策（启发式 / LLM）在合法集合内选择
//   ② 批量自动对战测试
// 每个动作都带 id / kind / params / desc / facts：
//   - params 是执行参数（交给 BattleEngine 执行）
//   - desc   是人类可读描述（用于日志 / LLM prompt）
//   - facts  是「算好的事实」（伤害、能否 KO、拿几张奖赏…），供 LLM 直接采信而不必自己算
//
// 重要：动作里的手牌索引 handIndex 只在「当前手牌」下有效；
// 每执行一个动作后必须重新枚举（AI 回合是「执行一个 → 重算 → 再选」的循环）。

import { PHASE } from './GameState.js';

export const ACTION = {
  MULLIGAN: 'mulligan',
  PUT_ACTIVE: 'put_active',
  PUT_BENCH: 'put_bench',
  CONFIRM_SETUP: 'confirm_setup',
  EVOLVE: 'evolve',
  ATTACH_ENERGY: 'attach_energy',
  USE_TRAINER: 'use_trainer',
  USE_ABILITY: 'use_ability',
  ACTIVATE_STADIUM: 'activate_stadium',
  RETREAT: 'retreat',
  ATTACK: 'attack',
  PASS_PHASE: 'pass_phase',
  END_TURN: 'end_turn',
};

/** 每个动作类型的启发式基础优先级（数值越大越优先；AiPolicy 会在此基础上加情境分） */
export const ACTION_PRIORITY = {
  [ACTION.MULLIGAN]: 100,
  [ACTION.PUT_ACTIVE]: 95,
  [ACTION.CONFIRM_SETUP]: 90,
  [ACTION.PUT_BENCH]: 60,
  [ACTION.ATTACK]: 80,
  [ACTION.EVOLVE]: 70,
  [ACTION.USE_ABILITY]: 55,
  [ACTION.ATTACH_ENERGY]: 50,
  [ACTION.USE_TRAINER]: 45,
  [ACTION.ACTIVATE_STADIUM]: 30,
  [ACTION.RETREAT]: 20,
  [ACTION.PASS_PHASE]: 15,
  [ACTION.END_TURN]: 0,
};

const BASIC_STAGE_RE = /^(基础|basic)$/i;

/** 是否为基础宝可梦（起手可放置） */
export function isBasicPokemon(cardData) {
  return !!cardData
    && cardData.cardType === 'pokemon'
    && (!cardData.stage || BASIC_STAGE_RE.test(String(cardData.stage)))
    && !cardData.evolvesFrom;
}

/** 是否能量卡（含特殊能量） */
export function isEnergyCard(cardData) {
  return !!cardData && (cardData.cardType === 'energy' || cardData.cardType === 'specialEnergy');
}

function cardLabel(cardData, id) {
  return cardData?.name || String(id ?? '?');
}

/**
 * 估算一次攻击对目标的实际伤害（复用引擎已经算好的数值，不做额外猜测）
 * 只覆盖「基础伤害 + 弱点/抵抗 + 已建模的条件/被动修正」；
 * 硬币、随机类效果不会被计入（因此 mayVary = true）。
 */
export function estimateAttackDamage(gs, attacker, defender, move, attackPlayer) {
  let damage = parseInt(String(move?.damage ?? '').match(/\d+/)?.[0] || '0', 10) || 0;
  let mayVary = /[×xX*+]|硬币|掷/.test(String(move?.damage ?? '')) || !/\d/.test(String(move?.damage ?? ''));
  if (damage > 0 && defender) {
    if (defender.weakness && defender.weakness === attacker?.element
      && !(attacker?.ignore || []).includes('weakness')
      && !gs._hasPassive?.(defender, 'weakness_null')) {
      damage *= (defender.weaknessMultiplier || 2);
    }
    if (defender.resistance && defender.resistance === attacker?.element
      && !(attacker?.ignore || []).includes('resistance')) {
      damage = Math.max(0, damage + (defender.resistanceValue ?? -30));
    }
  }
  damage += (attacker?.damageMod || 0);
  damage += gs.getConditionalDamageModifier?.(attacker, defender, move, attackPlayer) || 0;
  damage += gs.getPassiveDamageModifier?.(attacker, defender, move, attackPlayer) || 0;
  damage += (attacker?.nextOwnTurnDamageBoost || 0);
  if ((attacker?.attackDamageReduction || 0) > 0) damage = Math.max(0, damage - attacker.attackDamageReduction);
  return { damage: Math.max(0, damage), mayVary };
}

function energyLabel(cardData, id) {
  return cardData?.name || String(id ?? '能量');
}

/**
 * 训练家「丢弃手牌费用」是否可支付（枚举阶段先排除付不起的）。
 * 背景：canUseTrainer 不检查 discard_cost 类实际费用，曾导致 AI 反复尝试一张
 * 「需要丢弃 2 张手牌」但手里只有 1 张的卡，日志刷屏且浪费回合步数。
 * 注：这里只判断张数是否够（保守）；具体 filter 匹配由执行层再校验。
 */
function discardCostFeasible(player, handIndex, cardData) {
  const costs = (cardData?.effects || []).filter(e => e.action === 'trainer_prerequisite' && e.params?.kind === 'discard_cost');
  if (!costs.length) return true;
  let available = Math.max(0, (player?.hand || []).length - 1); // 使用中的这张不能当费用
  for (const cost of costs) {
    const raw = cost.params?.count;
    const need = raw === 'all' ? available : (Number(raw) || 1);
    if (available < need) return false;
    available -= need;
  }
  return true;
}

/**
 * 枚举当前玩家（默认 gs.currentPlayer）的合法动作。
 * @param {object} gs GameState
 * @param {object} resolver CardResolver（用于 getCard）
 * @param {object} player 目标玩家
 * @returns {Array<{id:string,kind:string,params:object,desc:string,facts:object,priority:number}>}
 */
export function getLegalActions(gs, resolver, player = gs.currentPlayer) {
  const actions = [];
  const card = (id) => resolver?.getCard?.(id) || null;
  const push = (kind, params, desc, facts = {}) => {
    const action = {
      id: `a${actions.length + 1}`,
      kind,
      params,
      desc,
      facts,
      priority: ACTION_PRIORITY[kind] ?? 0,
    };
    actions.push(action);
    return action;
  };

  if (!gs || !player || gs.phase === PHASE.GAME_OVER) return actions;
  const opp = gs.getOpponent(player);
  const handSlots = () => {
    const slots = [];
    if (player.active) slots.push({ slot: 'active', mon: player.active });
    (player.bench || []).forEach((mon, i) => { if (mon) slots.push({ slot: `bench-${i}`, mon }); });
    return slots;
  };

  // === 起手布置 ===
  if (gs.phase === PHASE.SETUP) {
    const basics = [];
    (player.hand || []).forEach((id, idx) => {
      const cd = card(id);
      if (isBasicPokemon(cd)) basics.push({ idx, cd, id });
    });
    const hasBasic = basics.length > 0;
    // 手里没有基础宝可梦 → 允许重新抽（对手额外抽 1 张）；
    // 若整副牌（手牌 + 牌库）都没有基础宝可梦，重抽也没有意义
    const poolHasBasic = [...(player.hand || []), ...(player.deck || [])].some(id => isBasicPokemon(card(id)));
    if (!hasBasic && !player.active && poolHasBasic) {
      push(ACTION.MULLIGAN, {}, '重新抽起始手牌（对手额外抽 1 张）', {});
    }
    if (!player.active) {
      for (const b of basics) {
        push(ACTION.PUT_ACTIVE, { handIndex: b.idx }, `放置 ${cardLabel(b.cd, b.id)} 到战斗场`, {
          hp: b.cd.hp || 0,
          stage: b.cd.stage || '基础',
        });
      }
    } else {
      for (const b of basics) {
        if ((player.bench || []).length >= 5) break;
        push(ACTION.PUT_BENCH, { handIndex: b.idx }, `放置 ${cardLabel(b.cd, b.id)} 到备战区`, {
          hp: b.cd.hp || 0,
        });
      }
      push(ACTION.CONFIRM_SETUP, {}, '确认布置，开始对战', {});
    }
    return actions;
  }

  if (gs.phase !== PHASE.MAIN && gs.phase !== PHASE.BATTLE) return actions;

  const slots = handSlots();

  // === 进化（每只宝可梦每回合一次；刚出场当回合不能进化） ===
  const evolveTargets = (cd) => slots.filter(({ mon }) => (
    cd?.evolvesFrom && mon.name === cd.evolvesFrom && !mon.placedThisTurn && !mon.evolvedThisTurn
  ));

  // === 附能（每回合 1 次） ===
  const energyTargets = slots;

  (player.hand || []).forEach((id, idx) => {
    const cd = card(id);
    if (!cd) return;

    if (isEnergyCard(cd) && !player.energyAttached) {
      for (const { slot, mon } of energyTargets) {
        // 事实：附上后能否让某个招式变为可打
        const preview = previewAttach(gs, mon, cd, opp?.active);
        push(ACTION.ATTACH_ENERGY, { handIndex: idx, targetSlot: slot },
          `为 ${mon.name} 附着 ${cardLabel(cd, id)}`, preview);
      }
    }

    if (cd.cardType === 'pokemon' && cd.evolvesFrom) {
      for (const { slot, mon } of evolveTargets(cd)) {
        push(ACTION.EVOLVE, { handIndex: idx, targetSlot: slot },
          `${mon.name} 进化为 ${cardLabel(cd, id)}`, {
            hp: cd.hp || 0,
            fromHp: mon.hp,
            damageKept: mon.maxHp - mon.hp,
          });
      }
    }

    if (cd.cardType === 'trainer') {
      const legal = gs.canUseTrainer ? gs.canUseTrainer(player, cd, null) : { ok: true };
      const type = cd.trainerType || 'item';
      const affordable = discardCostFeasible(player, idx, cd);
      if (legal.ok && affordable) {
        push(ACTION.USE_TRAINER, { handIndex: idx, targetSlot: null },
          `使用${trainerTypeLabel(type)} ${cardLabel(cd, id)}`, { trainerType: type });
      } else if (type === 'tool') {
        // 道具需要目标宝可梦
        for (const { slot, mon } of slots) {
          const check = gs.canUseTrainer(player, cd, slot);
          if (!check.ok) continue;
          push(ACTION.USE_TRAINER, { handIndex: idx, targetSlot: slot },
            `为 ${mon.name} 装备 ${cardLabel(cd, id)}`, { trainerType: type });
        }
      }
    }
  });

  // === 特性 ===
  for (const { mon } of slots) {
    if (!mon?.ability) continue;
    const zone = gs.inferAbilityZone ? gs.inferAbilityZone(player, mon) : 'field';
    const check = gs.canUseAbility ? gs.canUseAbility(player, mon, mon.ability, zone) : { ok: false };
    if (!check.ok) continue;
    push(ACTION.USE_ABILITY, { source: mon, ability: check.ability || mon.ability, zone: check.zone || zone },
      `使用特性「${mon.ability.name || '特性'}」（${mon.name}）`, { zone: check.zone || zone });
  }

  // === 竞技场（仅主要阶段，且本回合未用过该竞技场） ===
  if (gs.phase === PHASE.MAIN && gs.canActivateStadium) {
    const check = gs.canActivateStadium(player);
    if (check.ok) {
      push(ACTION.ACTIVATE_STADIUM, {}, `发动竞技场「${check.stadium?.name || '竞技场'}」`, {});
    }
  }

  // === 撤退 ===
  const active = player.active;
  if (active && !player.retreatUsed && (player.bench || []).length > 0) {
    const st = String(active.status || '');
    const blocked = st.includes('sleep') || st.includes('paralysis') || active.cannotRetreat
      || gs._hasPassive?.(opp?.active, 'cannot_retreat_passive');
    const cost = gs.effectiveRetreatCost ? gs.effectiveRetreatCost(active) : 1;
    const payable = gs._canPayRetreatCost ? gs._canPayRetreatCost(active, cost) : false;
    if (!blocked && payable) {
      (player.bench || []).forEach((mon, i) => {
        if (!mon) return;
        push(ACTION.RETREAT, { benchIndex: i, energyIndices: null },
          `撤退：${active.name} → ${mon.name}`, {
            cost,
            activeHp: active.hp,
            activeMaxHp: active.maxHp,
            incomingHp: mon.hp,
            incomingMaxHp: mon.maxHp,
          });
      });
    }
  }

  // === 攻击（仅战斗阶段；先攻玩家最初回合不能攻击） ===
  if (gs.phase === PHASE.BATTLE && active && opp?.active) {
    const st = String(active.status || '');
    const statusBlocked = st.includes('sleep') || st.includes('paralysis');
    const firstTurnBlock = gs.firstPlayerFirstTurnInProgress && player === gs.firstPlayer;
    if (!statusBlocked && !firstTurnBlock && !active.cannotAttackNext) {
      (active.attacks || []).forEach((move, i) => {
        const canPay = active.costEliminated || (gs.checkEnergy ? gs.checkEnergy(active, i) : false);
        if (!canPay) return;
        const { damage, mayVary } = estimateAttackDamage(gs, active, opp.active, move, player);
        const canKO = damage >= (opp.active.hp || 0);
        let prizes = gs.prizesForKnockout ? gs.prizesForKnockout(opp.active) : 1;
        if (!canKO) prizes = 0;
        push(ACTION.ATTACK, { attackIndex: i },
          `${active.name} 使用「${move.name || '招式'}」（${damage} 伤害${canKO ? '，可击倒' : ''}）`, {
            damage,
            mayVary,
            canKO,
            prizes,
            cost: (gs.adjustedAttackCost ? gs.adjustedAttackCost(active, move) : (move.cost || [])).join('+') || '无',
            defenderHp: opp.active.hp,
            defenderName: opp.active.name,
          });
      });
    }
  }

  // === 进入战斗阶段（MAIN → BATTLE；否则永远无法攻击） ===
  if (gs.phase === PHASE.MAIN) {
    push(ACTION.PASS_PHASE, {}, '进入战斗阶段', {});
  }

  // === 结束回合 ===
  push(ACTION.END_TURN, {}, '结束回合', {});

  return actions;
}

/** 附能预览：附上后是否让某个招式变为可打（用于「认真打」的事实标注） */
function previewAttach(gs, mon, energyCardData, defender) {
  const out = { targetHp: mon?.hp, targetName: mon?.name };
  try {
    const simulated = {
      ...mon,
      energy: [...(mon.energy || []), {
        cardId: null,
        name: energyCardData?.name,
        provides: energyCardData?.provides || null,
        specialRules: energyCardData?.specialRules || null,
      }],
    };
    const nowPlayable = [];
    (mon.attacks || []).forEach((move, i) => {
      const before = mon.costEliminated || gs.checkEnergy?.(mon, i);
      const after = simulated.costEliminated || gs.checkEnergy?.(simulated, i);
      if (!before && after) {
        const { damage, canKO } = estimateAttackDamage(gs, simulated, defender, move, gs.currentPlayer);
        nowPlayable.push({ name: move.name || '招式', damage, canKO });
      }
    });
    if (nowPlayable.length) {
      out.enablesAttack = nowPlayable.map(a => `${a.name}(${a.damage}${a.canKO ? ',可击倒' : ''})`).join('、');
    }
  } catch (e) {
    // 预览失败不影响动作合法性
  }
  return out;
}

function trainerTypeLabel(type) {
  return ({ supporter: '支援者', stadium: '竞技场', tool: '宝可梦道具', item: '物品' })[type] || '训练家卡';
}

/** 动作的可读摘要（日志 / 调试用） */
export function describeAction(action) {
  if (!action) return '';
  const f = action.facts || {};
  const extra = [];
  if (action.kind === ACTION.ATTACK && f.damage != null) extra.push(`${f.damage} 伤害`);
  if (f.canKO) extra.push('可击倒');
  if (action.kind === ACTION.ATTACH_ENERGY && f.enablesAttack) extra.push(`解锁 ${f.enablesAttack}`);
  if (action.kind === ACTION.RETREAT && f.cost != null) extra.push(`撤退费 ${f.cost}`);
  return extra.length ? `${action.desc}（${extra.join('，')}）` : action.desc;
}
