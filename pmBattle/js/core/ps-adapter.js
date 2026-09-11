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
// 持久 HP 追踪（模块级）：跨 flushLog 批次存活，避免 -damage 行在跨批次时拿不到 prev 被丢弃
const persistentHpMap = new Map();

export function parseEvents(logLines, dex = DEX) {
  const out = [];
  const hpMap = persistentHpMap;
  for (const raw of logLines) {
    if (typeof raw !== 'string' || !raw) continue;
    const line = raw.startsWith('|') ? raw : `|${raw}`;
    const parts = line.split('|').slice(1);
    const [evt, ...args] = parts;

    // HP Percentage Mod 会让 switch/-damage 等事件发两次（真实 HP + 百分比 /100），跳过百分比重复
    if ((evt === 'switch' || evt === 'drag') && isPercentHp(args[2])) continue;
    if ((evt === '-damage' || evt === '-heal' || evt === '-sethp') && isPercentHp(args[1])) continue;

    const ev = translateEvent(evt, args, dex, hpMap);
    if (ev) out.push(ev);
  }
  return out;
}

// 旧接口：只返回文本数组（单测兼容）
export function parseLog(logLines, dex = DEX) {
  return parseEvents(logLines, dex).map(e => e.text);
}

// ident（如 p1a: Gyarados / p2: Dragonite）→ 所属方 'p1' | 'p2' | null
function sideOfIdent(ident) {
  const m = String(ident || '').match(/^p([12])/);
  return m ? `p${m[1]}` : null;
}

function isPercentHp(hpStr) {
  const m = String(hpStr || '').match(/(\d+)\s*\/(\d+)/);
  return !!m && parseInt(m[2]) === 100;
}

function translateEvent(evt, args, dex, hpMap) {
  const base = { evt };
  switch (evt) {
    case 'turn': return { ...base, text: `— 第 ${args[0]} 回合 —` };
    case 'switch': case 'drag': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[2]);
      if (hp) hpMap.set(args[0], { cur: hp.cur, max: hp.max });
      return { ...base, side: sideOfIdent(args[0]), hp: hp ? { cur: hp.cur, max: hp.max } : null,
        text: `${p.name}${evt === 'drag' ? '被强制' : ''}出场了！` };
    }
    case 'move': {
      const p = parsePokemonIdent(args[0]);
      const mv = moveName(args[1], dex);
      return { ...base, side: sideOfIdent(args[0]), text: `${p.name}使用了 ${mv}！` };
    }
    case '-damage': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null) return null;
      const ident = args[0];
      // [from] 参数：伤害来源标记（ability:/item:/recoil/confusion/burn 等）→ 非招式直伤
      const fromArg = args.slice(2).find(a => a.startsWith('[from]'));
      const from = fromArg ? fromArg.slice(6).trim() : null;
      const rec = hpMap.get(ident);
      const prev = rec ? rec.cur : undefined;
      const max = hp.max ?? (rec ? rec.max : null);
      const damage = prev !== undefined ? prev - hp.cur : null;
      // 濒死行不能丢：击倒序列 = 受击 → 血量归0 → faint 倒下
      // （引擎会把 0 fnt 发两次，第二条 damage<=0 观点为重复丢弃）
      if (hp.fnt) {
        if (damage !== null && damage <= 0) return null;
        if (max !== null) hpMap.set(ident, { cur: 0, max }); // 记录归零，重复 fnt 行才会被去重
        return { ...base, side: sideOfIdent(ident), hp: { cur: 0, max }, from,
          text: `${p.name}损失了 ${damage !== null ? damage : ''} HP！（0/${max ?? '??'}）` };
      }
      hpMap.set(ident, { cur: hp.cur, max });
      if (damage === null || damage <= 0) {
        if (hp.cur > 0) return null; // 没变化的普通行仍丢弃
        return { ...base, side: sideOfIdent(ident), hp: { cur: 0, max }, from,
          text: `${p.name}倒下了！` };
      }
      return { ...base, side: sideOfIdent(ident), hp: { cur: hp.cur, max }, from,
        text: `${p.name}损失了 ${damage} HP！（${hp.cur}/${max ?? '??'}）` };
    }
    case '-heal': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null || hp.fnt) return null;
      const ident = args[0];
      const rec = hpMap.get(ident);
      const prev = rec ? rec.cur : undefined;
      const max = hp.max ?? (rec ? rec.max : null);
      const healed = prev !== undefined ? hp.cur - prev : null;
      hpMap.set(ident, { cur: hp.cur, max });
      return { ...base, side: sideOfIdent(ident), hp: { cur: hp.cur, max },
        text: `${p.name}回复了${healed !== null && healed > 0 ? ` ${healed} HP` : ' HP'}！（${hp.cur}/${max ?? '??'}）` };
    }
    case '-sethp': {
      const p = parsePokemonIdent(args[0]);
      const hp = parseHp(args[1]);
      if (hp === null || hp.fnt) return null;
      const rec = hpMap.get(args[0]);
      const max = hp.max ?? (rec ? rec.max : null);
      hpMap.set(args[0], { cur: hp.cur, max });
      return { ...base, side: sideOfIdent(args[0]), hp: { cur: hp.cur, max },
        text: `${p.name}的 HP 变为 ${hp.cur}/${max ?? '??'}。` };
    }
    case 'faint': {
      const p = parsePokemonIdent(args[0]);
      return { ...base, side: sideOfIdent(args[0]), text: `${p.name}倒下了！` };
    }
    case '-status': {
      const p = parsePokemonIdent(args[0]);
      return { ...base, side: sideOfIdent(args[0]), statusKey: args[1], text: `${p.name}陷入了${statusZh(args[1])}状态！` };
    }
    case '-curestatus': {
      const p = parsePokemonIdent(args[0]);
      return { ...base, side: sideOfIdent(args[0]), statusKey: null, text: `${p.name}的${statusZh(args[1])}状态治好了` };
    }
    case '-boost': case '-unboost': {
      const p = parsePokemonIdent(args[0]);
      const stat = statZh(args[1], dex);
      const dir = evt === '-boost' ? '提升' : '降低';
      const n = Number(args[2]) || 1;
      const nZh = ['', '', '大幅', '急剧', '急剧'][Math.min(Math.abs(n), 4)] || '';
      return { ...base, side: sideOfIdent(args[0]), text: `${p.name}的${stat}${nZh}${dir}了${n >= 2 ? '！' : '！'}` };
    }
    default: {
      // 其余事件沿用旧文本逻辑（不带 side，播放时按普通行处理）
      const text = translateEventMisc(evt, args, dex, hpMap);
      return text ? { ...base, text } : null;
    }
  }
}

function translateEventMisc(evt, args, dex, hpMap) {
  switch (evt) {
    case '-supereffective': return '效果绝佳！';
    case '-resisted': case '-notveryeffective': return '效果不理想……';
    case '-immune': {
      if (args[1] && args[1].startsWith('[from] ability')) return null;
      return '没有效果……';
    }
    case '-crit': return '击中要害！';
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
  const raw = m ? m[1].trim() : (ident || '???');
  // 日志行内宝可梦名用中文（与 activeSnapshot().name 一致，供 UI 判定动画归属方）
  return { name: speciesName(raw), rawName: raw };
}
function parseHp(str) {
  const s = String(str || '');
  const m = s.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) {
    const cur = parseInt(m[1]), max = parseInt(m[2]);
    return { cur, max, fnt: false };
  }
  // 濒死格式 '0 fnt'：cur=0，max 未知（由 hpMap 记录恢复）
  const f = s.match(/^(\d+)\s+fnt/);
  if (f) return { cur: parseInt(f[1]), max: null, fnt: true };
  return null;
}
function statZh(s, dex) {
  return zhName({ name: s, effectType: 'Type' }, dex) || s;
}
function weatherZh(w) {
  return ({ rain: '开始下雨了！', sun: '阳光变强了！', sand: '刮起了沙暴！', snow: '开始下雪了！', hail: '开始下冰雹了！' })[w] || `天气变为${w}`;
}
