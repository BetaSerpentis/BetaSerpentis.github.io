#!/usr/bin/env node
/**
 * 构建期效果索引生成器。
 *
 * 目的：把「卡牌效果文本 → 结构化动作」的解析结果预先算好，落成一个静态文件
 *      （ptcg/data_fast/effects.tsv），供 pi 侧工具与应用内共用同一份数据。
 *
 * 为什么这么做：
 *   - 应用现在是在 getCard() 时按需解析（单卡约 0.1ms），所以这不是省启动时间的问题；
 *     真正的问题是「没有全量索引就没法按效果检索/统计」——应用想查「哪些卡能抽3张以上」
 *     就得先把两万条文本全解析一遍，运行时不可接受。
 *   - 解析器只有一份实现（ptcg/battle/js/core/EffectParser.js），在这里被 node 调用；
 *     应用与 pi 都只读产物，不会出现两套实现漂移。
 *
 * 输出格式（沿用 data_fast/*.tsv 的约定：首行是 schema 标记）：
 *   #eff1
 *   card_key \t scope \t slot \t seq \t action \t params_json
 *     scope: trainer | ability | attack
 *     slot : attack 的序号 1..4；trainer/ability 为空
 *     seq  : 该条效果文本内的动作顺序（0 基，保证顺序可还原）
 *   注：action='usage_condition' 的行是元数据（前提条件 / 未建模残余），统计时可按需过滤。
 *
 * 用法：
 *   node ptcg/tools/build-effect-index.mjs            # 生成
 *   node ptcg/tools/build-effect-index.mjs --check    # 只校验，不写文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffect } from '../battle/js/core/EffectParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PTCG = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PTCG, 'data', 'battle');
const OUT_FILE = path.join(PTCG, 'data_fast', 'effects.tsv');
const CHECK_ONLY = process.argv.includes('--check');

// 与其它构建步骤保持一致的卡池顺序，便于 diff
const FILES = [
  ['pokemon-cards', 'pokemon'],
  ['Item-cards', 'item'],
  ['Supporter-cards', 'supporter'],
  ['Stadium-cards', 'stadium'],
  ['PokemonTool-cards', 'pokemon-tool'],
  ['BasicEnergy-cards', 'basic-energy'],
  ['SpecialEnergy-cards', 'special-energy'],
];

/** TSV 字段转义：与 build-cn-data.py 的 tsv_escape 保持一致 */
function esc(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** 收集一张卡的全部效果文本：{ scope, slot, text } */
function effectTextsOf(card) {
  const out = [];
  if (typeof card['效果'] === 'string' && card['效果']) out.push({ scope: 'trainer', slot: '', text: card['效果'] });
  if (typeof card['特性效果'] === 'string' && card['特性效果']) out.push({ scope: 'ability', slot: '', text: card['特性效果'] });
  for (let i = 1; i <= 4; i++) {
    const atk = card['技能' + i];
    if (atk && typeof atk === 'object' && typeof atk['效果'] === 'string' && atk['效果']) {
      out.push({ scope: 'attack', slot: String(i), text: atk['效果'] });
    }
  }
  return out;
}

function build() {
  const rows = [];
  const stats = { cards: 0, texts: 0, actions: 0, unparsed: 0, residual: 0, byAction: new Map(), byScope: new Map() };
  const hashInputs = [];

  for (const [file] of FILES) {
    const full = path.join(SRC_DIR, file + '.json');
    if (!fs.existsSync(full)) {
      console.error(`  !! 缺少数据文件: ${full}`);
      process.exitCode = 1;
      continue;
    }
    const cards = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const card of cards) {
      const cardKey = (card['卡牌ID'] || [])[0] || '';
      if (!cardKey) continue;
      stats.cards++;
      for (const { scope, slot, text } of effectTextsOf(card)) {
        stats.texts++;
        hashInputs.push(cardKey, scope, slot, text);
        const parsed = parseEffect(text);
        if (parsed.unparsed) stats.unparsed++;
        parsed.effects.forEach((e, seq) => {
          stats.actions++;
          if (e.action === 'usage_condition') stats.residual++;
          stats.byAction.set(e.action, (stats.byAction.get(e.action) || 0) + 1);
          stats.byScope.set(scope, (stats.byScope.get(scope) || 0) + 1);
          rows.push([cardKey, scope, slot, String(seq), e.action, JSON.stringify(e.params || {})]);
        });
      }
    }
  }
  return { rows, stats, hashInputs };
}

const { rows, stats, hashInputs } = build();

// 输入指纹：便于判断索引是否与当前数据不同步
const { createHash } = await import('node:crypto');
// 指纹必须覆盖「解析器源码 + 输入文本」：只算输入文本的话，
// 单独改了 EffectParser 的规则时指纹不变，--check 会误判为一致，索引就悄悄陈旧了。
const parserSrc = fs.readFileSync(path.resolve(__dirname, '..', 'battle', 'js', 'core', 'EffectParser.js'), 'utf8');
const inputHash = createHash('sha1')
  .update(parserSrc).update('\u0000').update(hashInputs.join('\u0001'))
  .digest('hex').slice(0, 16);

console.log('=== PTCG 效果索引生成器 ===');
console.log(`  卡牌: ${stats.cards} 张 | 效果文本: ${stats.texts} 条 | 动作: ${stats.actions} 条`);
console.log(`  其中 usage_condition（元数据/前提/残余）: ${stats.residual} 条`);
console.log(`  unparsed 非空: ${stats.unparsed} 条`);
console.log(`  动作种类: ${stats.byAction.size} 种`);
console.log(`  scope 分布: ${[...stats.byScope].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  输入指纹(sha1-16): ${inputHash}`);

// 校验模式：核对已生成文件是否与当前输入一致
if (CHECK_ONLY) {
  if (!fs.existsSync(OUT_FILE)) { console.error('  !! 索引文件不存在'); process.exit(1); }
  const lines = fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean);
  const marker = lines[0];
  const bodyRows = lines.length - 1;
  const storedHash = (marker.match(/hash=([0-9a-f]{16})/) || [])[1] || '';
  console.log(`  已存在索引: ${bodyRows} 行, 指纹 ${storedHash || '(无)'}`);
  if (bodyRows !== rows.length) { console.error(`  !! 行数不一致: ${bodyRows} != ${rows.length}`); process.exit(1); }
  if (storedHash !== inputHash) { console.error(`  !! 指纹不一致，索引已过期`); process.exit(1); }
  console.log('  索引与当前数据一致 ✓');
  process.exit(0);
}

// 写入：首行 #eff1 标记并带上输入指纹，便于应用/工具判断是否过期
const out = ['#eff1 hash=' + inputHash];
for (const r of rows) out.push(r.map(esc).join('\t'));
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, out.join('\n') + '\n', 'utf8');

const size = fs.statSync(OUT_FILE).size;
console.log(`  已写出: ${path.relative(PTCG, OUT_FILE)}  ${rows.length} 行  ${(size / 1048576).toFixed(2)} MB`);
