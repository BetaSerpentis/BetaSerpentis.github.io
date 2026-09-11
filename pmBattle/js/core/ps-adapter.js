// js/core/ps-adapter.js — Pokémon Showdown 引擎适配层
//
// 封装 PS 引擎（js/vendor/ps-engine.js）的 Battle 创建、决策、中文名与日志解析。

import { Battle, Dex, TeamValidator, toID } from '../vendor/ps-engine.js';

// 可用格式：gen9ou（标准单打）/ gen9nationaldex（Mega+Z+太晶化）/ gen8natdexdynamax（Mega+Z+极巨化）
export const FORMATS = {
  ou: 'gen9ou',
  natdex9: 'gen9nationaldex',
  natdex8dynamax: 'gen8natdexdynamax',
};
export let FORMAT = FORMATS.ou;

export function setFormat(id) { FORMAT = id; }

const DEX = Dex.mod('gen9');
export { DEX, toID };

// 中文名（宝可梦/招式/特性/道具/属性）
export function zhName(effect, dex = DEX) {
  if (!effect) return '';
  try {
    return dex.text.get(effect, 'zh-cn').name || effect.name || '';
  } catch {
    return effect.name || '';
  }
}

export function speciesName(id, dex = DEX) {
  const s = dex.species.get(id);
  return s ? zhName(s, dex) : String(id);
}
export function moveName(id, dex = DEX) {
  const m = dex.moves.get(id);
  return m ? zhName(m, dex) : String(id);
}
export function typeName(type, dex = DEX) {
  return zhName({ name: type, effectType: 'Type' }, dex);
}

// 创建对战（双方队伍，PokemonSet[] 格式）
export function createBattle(team1, team2, name1 = '玩家', name2 = '对手', formatid = FORMAT) {
  const battle = new Battle({ formatid });
  battle.setPlayer('p1', { name: name1, team: team1 });
  battle.setPlayer('p2', { name: name2, team: team2 });
  return battle;
}

// 当前请求状态：'teampreview' | 'move' | 'switch' | ''（结束）
export function requestState(battle, side) {
  return battle[side].requestState;
}

// 获取某侧当前场上的宝可梦（active）
export function activeOf(battle, side) {
  return battle[side].active[0] || null;
}

// 获取可用的强化选项（Mega / Z / 极巨化）
export function getEnhancements(battle, side) {
  const active = activeOf(battle, side);
  if (!active) return { canMegaEvo: null, canZMove: [], canDynamax: false, canGigantamax: null };
  let req = null;
  try { req = active.getMoveRequestData(); } catch {}
  // canDynamax 用 Pokemon 级判断（带 Mega 石/Z 晶石的宝可梦不能极巨化，side.canDynamaxNow 是 side 级不准）
  return {
    canMegaEvo: active.canMegaEvo || null,
    canZMove: ((req && req.canZMove) || []).map((z, i) => z ? i : -1).filter(i => i >= 0),
    canDynamax: !!(req && req.canDynamax),
    canGigantamax: active.canGigantamax || null,
  };
}

// 获取可用的招式（含 id/中文名/pp/威力）
export function getMoves(battle, side) {
  const active = activeOf(battle, side);
  if (!active) return [];
  const req = active.getMoveRequestData();
  return (req.moves || []).map((m, i) => {
    const mv = DEX.moves.get(m.id);
    return {
      index: i,
      id: m.id,
      name: mv ? zhName(mv) : m.move,
      pp: m.pp,
      maxpp: m.maxpp,
      disabled: !!m.disabled,
      basePower: mv ? mv.basePower : 0,
      category: mv ? mv.category : 'Status',
      type: mv ? mv.type : '???',
      priority: mv ? mv.priority : 0,
    };
  });
}

// 获取可换入的宝可梦（非场上、未濒死）
export function getSwitchable(battle, side) {
  return battle[side].pokemon
    .map((p, i) => ({ index: i, pokemon: p }))
    .filter(x => !battle[side].active.includes(x.pokemon) && !x.pokemon.fainted);
}

// 队伍快照（用于 UI 显示）
export function teamSnapshot(battle, side, dex = DEX) {
  return battle[side].pokemon.map(p => ({
    speciesId: p.species.id,
    name: zhName(p.species, dex),
    hp: p.hp,
    maxhp: p.maxhp,
    fainted: p.fainted,
    active: battle[side].active.includes(p),
    status: p.status || null,
    types: p.species.types || [],
  }));
}

// 活跃宝可梦快照
export function activeSnapshot(battle, side, dex = DEX) {
  const p = activeOf(battle, side);
  if (!p) return null;
  return {
    speciesId: p.species.id,
    name: zhName(p.species, dex),
    hp: p.hp,
    maxhp: p.maxhp,
    fainted: p.fainted,
    status: p.status || null,
    types: p.species.types || [],
    level: p.level,
    boosts: { ...p.boosts },
    ability: zhName(p.ability, dex),
    item: p.item ? zhName(p.item, dex) : null,
  };
}

// 阵营 key：'p1' / 'p2'
export const PLAYER = 'p1';
export const OPPONENT = 'p2';

// 状态中文
const STATUS_ZH = { par: '麻痹', brn: '烧伤', frz: '冰冻', slp: '睡眠', psn: '中毒', tox: '剧毒' };
export function statusZh(s) { return STATUS_ZH[s] || s; }

// ---------------------------------------------------------------------------
// 战斗日志解析：PS 协议（|event|args）→ 中文可读文本
// ---------------------------------------------------------------------------
export function parseLog(logLines, dex = DEX) {
  const out = [];
  const hpMap = new Map(); // ident → 上次真实 HP，用于计算伤害差值
  for (const raw of logLines) {
    if (typeof raw !== 'string' || !raw) continue;
    const line = raw.startsWith('|') ? raw : `|${raw}`;
    const parts = line.split('|').slice(1);
    const [evt, ...args] = parts;

    // HP Percentage Mod 会让 switch/-damage 等事件发两次（真实 HP + 百分比 /100），跳过百分比重复
    if ((evt === 'switch' || evt === 'drag') && isPercentHp(args[2])) continue;
    if ((evt === '-damage' || evt === '-heal' || evt === '-sethp') && isPercentHp(args[1])) continue;

    const text = translateEvent(evt, args, dex, hpMap);
    if (text) out.push(text);
  }
  return out;
}

function isPercentHp(hpStr) {
  const m = String(hpStr || '').match(/(\d+)\s*\/\s*(\d+)/);
  return !!m && parseInt(m[2]) === 100;
}

function translateEvent(evt, args, dex, hpMap) {
  switch (evt) {
    case 'turn': return `— 第 ${args[0]} 回合 —`;
    case 'switch': case 'drag': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[2]);
      if (hp) hpMap.set(args[0], hp.cur);
      return `${p.name}${evt === 'drag' ? '被强制' : ''}出场了！`;
    }
    case 'move': {
      const p = parsePokemonIdent(args[0]);
      const mv = moveName(args[1], dex);
      return `${p.name}使用了 ${mv}！`;
    }
    case '-damage': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null) return null;
      const ident = args[0];
      const prev = hpMap.get(ident);
      const damage = prev !== undefined ? prev - hp.cur : null;
      hpMap.set(ident, hp.cur);
      if (damage === null || damage <= 0) return null;
      return `${p.name}损失了 ${damage} HP！（${hp.cur}/${hp.max}）`;
    }
    case '-heal': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null) return null;
      const ident = args[0];
      const prev = hpMap.get(ident);
      const healed = prev !== undefined ? hp.cur - prev : null;
      hpMap.set(ident, hp.cur);
      return `${p.name}回复了${healed !== null && healed > 0 ? ` ${healed} HP` : ' HP'}！（${hp.cur}/${hp.max}）`;
    }
    case '-sethp': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null) return null;
      hpMap.set(args[0], hp.cur);
      return `${p.name}的 HP 变为 ${hp.cur}/${hp.max}。`;
    }
    case 'faint': return `${parsePokemonIdent(args[0]).name}倒下了！`;
    case '-supereffective': return '效果绝佳！';
    case '-resisted': case '-notveryeffective': return '效果不理想……';
    case '-immune': {
      if (args[1] && args[1].startsWith('[from] ability')) return null;
      return '没有效果……';
    }
    case '-crit': return '击中要害！';
    case '-status': {
      const p = parsePokemonIdent(args[0]);
      return `${p.name}陷入了${statusZh(args[1])}状态！`;
    }
    case '-curestatus': {
      const p = parsePokemonIdent(args[0]);
      return `${p.name}解除了${statusZh(args[1])}状态。`;
    }
    case '-boost': {
      const p = parsePokemonIdent(args[0]);
      const stat = args[2] ? statZh(args[2], dex) : '能力';
      return `${p.name}的${stat}提升了！`;
    }
    case '-unboost': {
      const p = parsePokemonIdent(args[0]);
      const stat = args[2] ? statZh(args[2], dex) : '能力';
      return `${p.name}的${stat}降低了！`;
    }
    case '-weather': return weatherZh(args[0]);
    case '-fieldstart': return `场地被${args[0]}覆盖了。`;
    case '-fieldend': return '场地效果消失了。';
    case '-sidestart': {
      const side = args[0].startsWith('p1') ? '我方' : '对手';
      return `${side}场地出现了${args[1]}！`;
    }
    case '-activate': {
      const p = parsePokemonIdent(args[0]);
      if (args[1] && args[1].includes('ability')) return `${p.name}的特性发动了！`;
      if (args[1] && args[1].includes('item')) return `${p.name}的道具发动了！`;
      return null;
    }
    case '-ability': {
      const p = parsePokemonIdent(args[0]);
      return `${p.name}的特性${args[1]}发动了！`;
    }
    case '-enditem': case '-endability': return null;
    case '-item': return null;
    case '-fail': case '-miss': {
      const p = parsePokemonIdent(args[0]);
      return evt === '-miss' ? `${p.name}的攻击没有命中！` : null;
    }
    case '-hint': return null;
    case '-start': return null; // 挥发性状态（替身等），略
    case '-end': return null;
    case 'win': return args[0] === '玩家' || args[0] === 'p1' ? '🎉 玩家获胜！' : '💔 玩家败北...';
    case 'tie': return '平局！';
    case '': case 'c': case 'c:': case 'j': case 'j:': case 'split': case 'upkeep': case 'done': return null;
    default:
      if (evt.startsWith('-')) return null;
      return null;
  }
}

function parsePokemonIdent(ident) {
  const m = String(ident || '').match(/(?:p[12][ab]?:\s*)?([^|]+)/);
  return { name: m ? m[1].trim() : (ident || '???') };
}
function parseHp(str) {
  const m = String(str || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const cur = parseInt(m[1]), max = parseInt(m[2]);
  return { cur, max, damage: null };
}
function statZh(s, dex) {
  return zhName({ name: s, effectType: 'Type' }, dex) || s;
}
function weatherZh(w) {
  return ({ rain: '开始下雨了！', sun: '阳光变强了！', sand: '刮起了沙暴！', snow: '开始下雪了！', hail: '开始下冰雹了！' })[w] || `天气变为${w}`;
}
