#!/usr/bin/env node
/**
 * 审计「假建模 / 静默归零」：解析端记了 usage_condition 标记，但引擎端没有任何代码读它。
 *
 * 背景：这类问题会让玩家以为效果生效、实际什么都没发生。已发现两例：
 *   · __zero（catch-all 把伤害计数映射成恒 0 的占位符）—— 39da8aa2 已修
 *   · conditional_damage_mod 缺兜底（没有 condition 的项恒加 0）—— 8f494ff5 已修
 *   · gx_once_per_game / vstar_power_once（GX/VSTAR 每局一次从未限制）—— 本轮已修
 *
 * 用法：
 *   node ptcg/tools/audit-inert-markers.mjs            # 打印分类报告
 *   node ptcg/tools/audit-inert-markers.mjs --check    # 只检查「已知缺口清单」是否缩小；有新增缺口则退出码 1
 *
 * 说明：
 *   · 判定依据只是「四个引擎文件里有没有出现该 kind 字符串」，是**粗筛**；
 *     有些 kind 确实在别处强制（如 once_per_turn 走 GameState.abilityUsedThisTurn），
 *     也有些 kind 本身就是说明性注记。因此分三类：BENIGN（注记/已在别处强制）、KNOWN_GAPS（已确认待修）、其余为「待判定」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const tsvPath = path.join(root, 'ptcg', 'data_fast', 'effects.tsv');
const engineFiles = [
  path.join(root, 'ptcg', 'battle', 'js', 'core', 'GameState.js'),
  path.join(root, 'ptcg', 'battle', 'js', 'core', 'EffectExecutor.js'),
  path.join(root, 'ptcg', 'battle', 'js', 'core', 'BattleEngine.js'),
  path.join(root, 'ptcg', 'battle', 'js', 'main.js'),
];

// 说明性注记 / 已在别处强制：不产生状态变化属于设计如此
const BENIGN = new Set([
  'residual_sentence', 'generic_effect', 'shell_fragment',
  'put_remaining_back', 'put_remaining_back_top',
  'once_per_turn', 'any_times_own_turn', 'vstar_usage_note',
  'no_stack_note', 'energy_supply_desc', 'bench_limit_priority_note', 'bench_limit_expiry_note',
  'prize_face_up_persist', 'legacy_placeholder_text', 'stadium_one_rule', 'energy_second_rule',
  'energy_desc_complex', 'energy_attach_trigger_desc', 'peek_alternative_deck_bottom',

  // 已在别处强制（不通过这个标记本身）：GX/VSTAR 每局一次由招式名后缀（「…GX」/「…VSTAR」）
  // 在 GameState._oncePerGameAttackFailure + BattleEngine.attack 里强制
  'gx_once_per_game', 'vstar_power_once',
]);

// 「待判定」行数基线：--check 用棘轮方式防止**新增**无人读取的标记。
// 每修好一批就把这个数字调小；调大必须写明理由。
const BASELINE_UNCLASSIFIED_ROWS = 253;

// 已确认「该生效却没接线」的缺口（按机制族分批修，修好的从这里删掉）
const KNOWN_GAPS = new Set([
  'ko_next_opp_end', 'place_self_to_bench',
  'draw_matching_opponent_field_count',
  'move_copy', 'select_opponent_move', 'opp_choose_move_copy',
  'extra_turn_vstar',
  'hand_to_deck_like_opp', 'only_single_hand_card',
  'doll_discard', 'doll_wide_first', 'doll_passive', 'doll_as_pokemon',
  'self_counters_damage', 'search_by_coin_heads', 'coin_heads_draw_any',
  'peek_opp_top_back', 'fail_unless_from_bench', 'attack_from_bench_allowed',
  'bonus_damage_extra_energy', 'mirror_last_damage_taken',
  'block_attach_energy_next', 'block_special_attach_next', 'block_special_stadium_next',
  'block_prizes_next', 'block_prizes_next2', 'block_supporter_next',
]);

function readKinds() {
  const rows = fs.readFileSync(tsvPath, 'utf8').split(/\r?\n/);
  const kinds = new Map(); // kind -> {rows, cards:Set}
  for (const line of rows) {
    const f = line.split('\t');
    if (f.length < 6 || f[4] !== 'usage_condition') continue;
    let p;
    try { p = f[5] ? JSON.parse(f[5]) : {}; } catch { continue; }
    const k = p.kind;
    if (!k) continue;
    if (!kinds.has(k)) kinds.set(k, { rows: 0, cards: new Set() });
    const rec = kinds.get(k);
    rec.rows += 1;
    rec.cards.add(f[0]);
  }
  return kinds;
}

const engineSrc = engineFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const reads = k => engineSrc.includes(`'${k}'`) || engineSrc.includes(`"${k}"`);

const kinds = readKinds();
const inert = [...kinds.entries()].filter(([k]) => !reads(k));
const inertBenign = inert.filter(([k]) => BENIGN.has(k));
const inertKnown = inert.filter(([k]) => KNOWN_GAPS.has(k));
const inertUnknown = inert.filter(([k]) => !BENIGN.has(k) && !KNOWN_GAPS.has(k));
const total = k => k.reduce((s, [, v]) => s + v.rows, 0);

console.log(`usage_condition 共 ${[...kinds.values()].reduce((s, v) => s + v.rows, 0)} 行 / ${kinds.size} 种 kind`);
console.log(`无人读取的：${inert.length} 种 / ${total(inert)} 行`);
console.log(`  · 说明性注记（设计如此）：${inertBenign.length} 种 / ${total(inertBenign)} 行`);
console.log(`  · 已知缺口（待按机制族修）：${inertKnown.length} 种 / ${total(inertKnown)} 行`);
console.log(`  · 待判定（新出现，需要人工分到上面两类）：${inertUnknown.length} 种 / ${total(inertUnknown)} 行`);
if (inertUnknown.length) {
  console.log('\n待判定明细：');
  for (const [k, v] of inertUnknown.sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`  ${k.padEnd(38)} ${String(v.rows).padStart(4)} 行 / ${v.cards.size} 卡`);
  }
}

if (process.argv.includes('--check')) {
  // 门禁（棘轮）：待判定的行数**不允许增长**。修好一批后把 BASELINE_UNCLASSIFIED_ROWS 调小。
  const unknownRows = inertUnknown.reduce((s, [, v]) => s + v.rows, 0);
  if (unknownRows > BASELINE_UNCLASSIFIED_ROWS) {
    console.error(`
✗ 「无人读取」的标记比基线多了 ${unknownRows - BASELINE_UNCLASSIFIED_ROWS} 行（基线 ${BASELINE_UNCLASSIFIED_ROWS}，当前 ${unknownRows}）。`);
    console.error('  新增 usage_condition kind 时，请同时接上读取方，或把它加入 BENIGN / KNOWN_GAPS。');
    process.exit(1);
  }
  console.log(`
✓ 「无人读取」未超基线（${unknownRows} <= ${BASELINE_UNCLASSIFIED_ROWS}）。`);
}
