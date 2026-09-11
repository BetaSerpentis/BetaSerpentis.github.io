// tests/adapter.test.mjs — PS 全量引擎适配层测试
// 用法: node tests/adapter.test.mjs
import { DEX, zhName, createBattle, requestState, parseLog, getMoves, PLAYER, OPPONENT } from '../js/core/ps-adapter.js';
import { chooseAiAction } from '../js/core/ai.js';
import { PLAYER_TEAM, AI_TEAM } from '../js/data/teams.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function assertEq(a, b, msg) {
  if (a === b) { pass++; console.log('  ✓', msg, `= ${a}`); }
  else { fail++; console.error('  ✗', msg, `期望 ${b} 实际 ${a}`); }
}
function section(t) { console.log('\n' + t); }

section('1. 全量数据');
{
  const pika = DEX.species.get('pikachu');
  assertEq(zhName(pika), '皮卡丘', '皮卡丘中文名');
  assertEq(zhName(DEX.moves.get('thunderbolt')), '十万伏特', '十万伏特中文名');
  assert(DEX.species.all().length > 1500, `宝可梦 ${DEX.species.all().length} 种`);
  assert(DEX.moves.all().length > 900, `招式 ${DEX.moves.all().length} 个`);
  assert(DEX.abilities.all().length > 300, `特性 ${DEX.abilities.all().length} 个`);
  assert(DEX.items.all().length > 500, `道具 ${DEX.items.all().length} 个`);
}

section('2. 效果函数保留（全量移植核心）');
{
  const hugepower = DEX.abilities.get('hugepower');
  assert(typeof hugepower.onModifyAtk === 'function', '大力士 onModifyAtk 函数');
  const lifeorb = DEX.items.get('lifeorb');
  assert(typeof lifeorb.onModifyDamage === 'function', '生命宝珠 onModifyDamage 函数');
  const thunderbolt = DEX.moves.get('thunderbolt');
  assert(thunderbolt.secondary && thunderbolt.secondary.chance === 10, '十万伏特 10% 麻痹追加效果');
  const swordsdance = DEX.moves.get('swordsdance');
  assert(swordsdance.boosts && swordsdance.boosts.atk === 2, '剑舞 atk+2');
}

section('3. 完整对战（双方 AI，跑到底）');
{
  const battle = createBattle(PLAYER_TEAM, AI_TEAM);
  let guard = 0;
  while (!battle.winner && guard++ < 800) {
    let acted = false;
    for (const side of [PLAYER, OPPONENT]) {
      const s = requestState(battle, side);
      if (s === 'teampreview') { battle.choose(side, 'team 1'); acted = true; }
      else if (s === 'move' || s === 'switch') {
        const a = chooseAiAction(battle, side);
        battle.choose(side, `${a.type} ${a.index + 1}`);
        acted = true;
      }
    }
    if (!acted) break;
  }
  assert(battle.winner !== undefined && battle.winner !== null, `对战有胜负（${battle.winner}）`);
  assert(battle.turn > 1, `对战持续 ${battle.turn} 回合`);
}

section('4. 日志解析');
{
  const battle = createBattle(PLAYER_TEAM, AI_TEAM);
  battle.choose('p1', 'team 1'); battle.choose('p2', 'team 1');
  battle.choose('p1', 'move 1'); battle.choose('p2', 'move 1');
  const zh = parseLog(battle.log);
  assert(zh.some(l => l.includes('使用了')), '日志含"使用了"');
  assert(zh.some(l => l.includes('倒下了') || l.includes('损失') || l.includes('出场')), '日志含伤害/出场');
  assert(!zh.some(l => l.includes('null')), '日志无 null');
}

section('5. 招式菜单数据');
{
  const battle = createBattle(PLAYER_TEAM, AI_TEAM);
  battle.choose('p1', 'team 1'); battle.choose('p2', 'team 1');
  const moves = getMoves(battle, PLAYER);
  assert(moves.length >= 4, `招式菜单 ${moves.length} 个`);
  assert(moves.every(m => m.name && m.name !== m.id), '招式有中文名');
}

section('6. Mega 进化 / Z 技能 / 极巨化（Gen 8 NatDex Dynamax）');
// 无害对手（只会回复，不会击倒测试宝可梦，保证测试稳定）
const harmlessOpp = [{ species: 'Blissey', ability: 'Natural Cure', moves: ['Soft-Boiled'], nature: 'Bold', evs: { hp: 252, def: 252 }, level: 100 }];

// Mega 进化
{
  const b = createBattle([
    { species: 'Charizard', item: 'Charizardite X', ability: 'Blaze', moves: ['Flamethrower', 'Air Slash', 'Dragon Claw', 'Earthquake'], nature: 'Jolly', evs: { atk: 252, spe: 252, hp: 4 }, level: 100 },
  ], harmlessOpp, '玩家', '对手', 'gen8natdexdynamax');
  b.choose('p1', 'team 1'); b.choose('p2', 'team 1');
  b.choose('p1', 'move 1 mega'); b.choose('p2', 'move 1');
  assertEq(b.p1.active[0].species.id, 'charizardmegax', 'Mega 进化 → Charizard-Mega-X');
}

// Z 技能
{
  const b = createBattle([
    { species: 'Pikachu', item: 'Pikanium Z', ability: 'Static', moves: ['Volt Tackle', 'Thunderbolt', 'Surf', 'Quick Attack'], nature: 'Jolly', evs: { atk: 252, spe: 252, hp: 4 }, level: 100 },
  ], harmlessOpp, '玩家', '对手', 'gen8natdexdynamax');
  b.choose('p1', 'team 1'); b.choose('p2', 'team 1');
  b.choose('p1', 'move 1 zmove'); b.choose('p2', 'move 1');
  assert(b.log.some(l => l.includes('Catastropika') || l.includes('zpower')), 'Z 技能 Catastropika');
}

// 极巨化
{
  const b = createBattle([
    { species: 'Gyarados', ability: 'Intimidate', moves: ['Waterfall', 'Crunch', 'Ice Fang', 'Dragon Dance'], nature: 'Jolly', evs: { atk: 252, spe: 252, hp: 4 }, level: 100 },
  ], harmlessOpp, '玩家', '对手', 'gen8natdexdynamax');
  b.choose('p1', 'team 1'); b.choose('p2', 'team 1');
  const maxhpBefore = b.p1.active[0].maxhp;
  b.choose('p1', 'move 1 dynamax'); b.choose('p2', 'move 1');
  assert(b.p1.active[0].maxhp > maxhpBefore, `极巨化 HP 翻倍（${maxhpBefore} → ${b.p1.active[0].maxhp}）`);
}

section('7. Gen 8 NatDex Dynamax 完整对战（双方 AI）');
{
  const b = createBattle(PLAYER_TEAM, AI_TEAM, '玩家', '对手', 'gen8natdexdynamax');
  let guard = 0;
  while (!b.winner && guard++ < 800) {
    let acted = false;
    for (const side of [PLAYER, OPPONENT]) {
      const s = requestState(b, side);
      if (s === 'teampreview') { b.choose(side, 'team 1'); acted = true; }
      else if (s === 'move' || s === 'switch') {
        const a = chooseAiAction(b, side);
        b.choose(side, `${a.type} ${a.index + 1}`);
        acted = true;
      }
    }
    if (!acted) break;
  }
  assert(b.winner !== undefined && b.winner !== null, `Gen8 NatDex Dynamax 对战有胜负（${b.winner}，${b.turn} 回合）`);
}

console.log(`\n========== 测试结果：${pass} 通过，${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
