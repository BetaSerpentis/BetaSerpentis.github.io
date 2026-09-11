// js/core/ai.js — AI 决策（基于 PS 引擎）
//
// 策略：预估每个可用招式对对手的伤害（基础公式 × STAB × 相克），
//       击杀加成，选最高分；若被严重压制则考虑换入抵抗型宝可梦。

import { DEX, toID, getMoves, activeOf, getSwitchable } from './ps-adapter.js';

// 预估招式伤害（不含随机/道具/特性修正，供排序）
function estimateDamage(attacker, defender, moveId) {
  const mv = DEX.moves.get(moveId);
  if (!mv || !mv.basePower) return 0;
  const isPhysical = mv.category === 'Physical';
  // unmodified=true：不触发特性/道具事件（避免 Blaze 等 onModifySpA 在无 move 上下文时报错）
  const atk = attacker.getStat(isPhysical ? 'atk' : 'spa', false, true);
  const def = defender.getStat(isPhysical ? 'def' : 'spd', false, true);
  let dmg = Math.floor(Math.floor(Math.floor(Math.floor((2 * attacker.level / 5 + 2) * mv.basePower * atk) / def) / 50)) + 2;
  if (attacker.hasType(mv.type)) dmg = Math.floor(dmg * 1.5);
  const eff = DEX.getEffectiveness(mv.type, defender.getTypes());
  dmg = Math.floor(dmg * eff);
  return { dmg, eff };
}

// 选择 AI 行动，返回 { type: 'move'|'switch'|'team', index }
export function chooseAiAction(battle, side) {
  const state = battle[side].requestState;
  const attacker = activeOf(battle, side);
  const defender = activeOf(battle, side === 'p1' ? 'p2' : 'p1');

  if (state === 'teampreview') {
    // 首发：选第一只未濒死
    const team = battle[side].pokemon;
    for (let i = 0; i < team.length; i++) if (!team[i].fainted) return { type: 'team', index: i };
    return { type: 'team', index: 0 };
  }

  if (state === 'switch') {
    return { type: 'switch', index: bestSwitchIndex(battle, side, defender) };
  }

  // move 阶段
  const moves = getMoves(battle, side).filter(m => !m.disabled && m.pp > 0);
  if (moves.length === 0) {
    // 无可用招式：挣扎或换人
    return { type: 'move', index: 0 };
  }

  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const mv = DEX.moves.get(m.id);
    let score = 0;
    if (mv && mv.basePower && defender) {
      const { dmg, eff } = estimateDamage(attacker, defender, m.id);
      score = dmg * (1 + eff);
      if (dmg >= defender.hp) score += 1e6; // 击杀加成
      if (eff === 0) score = -1;
    } else {
      // 变化招式：强化类在血量健康时使用
      score = statusMoveScore(battle, side, mv);
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }

  // 若最优伤害极低且队伍有更抗揍的，换人
  if (bestScore <= 0 && defender) {
    const sw = bestSwitchIndex(battle, side, defender);
    if (sw !== null) return { type: 'switch', index: sw };
  }

  return { type: 'move', index: best ? best.index : 0 };
}

function statusMoveScore(battle, side, mv) {
  if (!mv) return 0;
  let score = 5;
  const active = activeOf(battle, side);
  if (mv.boosts || mv.selfBoost) {
    const buffs = { ...(mv.selfBoost || {}), ...(mv.boosts || {}) };
    const offensive = Object.keys(buffs).some(s => ['atk', 'spa', 'spe'].includes(s));
    if (offensive && active && active.hp / active.maxhp > 0.6) score = 30;
  }
  if (mv.heal) score = active && active.hp / active.maxhp < 0.5 ? 40 : 10;
  return score;
}

// 换入对当前对手属性抗性最好的宝可梦
function bestSwitchIndex(battle, side, defender) {
  const options = getSwitchable(battle, side);
  if (options.length === 0) return null;
  if (!defender) return options[0].index;

  let best = null, bestScore = -Infinity;
  for (const opt of options) {
    const types = opt.pokemon.species.types || [];
    let score = 0;
    for (const t of defender.species.types || []) {
      const eff = DEX.getEffectiveness(t, types);
      score += (2 - eff); // 被克制扣分，抵抗加分
    }
    if (score > bestScore) { bestScore = score; best = opt.index; }
  }
  return best !== null ? best : options[0].index;
}
