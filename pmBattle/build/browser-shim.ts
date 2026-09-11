// build/browser-shim.ts — 浏览器端 PS 数据加载器
//
// PS 引擎（sim/dex.ts 等）在 Node 端用 require(filePath) 动态加载 data/*.ts。
// 这里把所有 data + text（含效果函数）静态 import 进来，用 globalThis.__psRequire
// / __psRequireText 替代 require，从而让引擎在浏览器端可运行（esbuild 打包）。

// ---- 基础战斗数据（Gen 9 base，含效果函数，勿 JSON 化） ----
import { Pokedex } from '../../.pi/cache/pokemon-showdown/data/pokedex';
import { Moves } from '../../.pi/cache/pokemon-showdown/data/moves';
import { Abilities } from '../../.pi/cache/pokemon-showdown/data/abilities';
import { Items } from '../../.pi/cache/pokemon-showdown/data/items';
import { Learnsets } from '../../.pi/cache/pokemon-showdown/data/learnsets';
import { TypeChart } from '../../.pi/cache/pokemon-showdown/data/typechart';
import { Natures } from '../../.pi/cache/pokemon-showdown/data/natures';
import { FormatsData } from '../../.pi/cache/pokemon-showdown/data/formats-data';
import { Rulesets } from '../../.pi/cache/pokemon-showdown/data/rulesets';
import { Conditions } from '../../.pi/cache/pokemon-showdown/data/conditions';
import { Scripts } from '../../.pi/cache/pokemon-showdown/data/scripts';
import { PokemonGoData } from '../../.pi/cache/pokemon-showdown/data/pokemongo';
import { Aliases, CompoundWordNames } from '../../.pi/cache/pokemon-showdown/data/aliases';
import { Formats } from '../../.pi/cache/pokemon-showdown/config/formats';

// 注入自定义格式：Gen 8 NatDex + 极巨化（Standard NatDex 不含 Dynamax Clause → 极巨化可用），
// 同时 NatDex Mod（+Past）允许 Mega 进化与 Z 技能。
Formats.push({
  name: '[Gen 8] NatDex Dynamax',
  mod: 'gen8',
  ruleset: ['Standard NatDex'],
  banlist: ['Arena Trap', 'Moody', 'Power Construct', 'Shadow Tag', "King's Rock", 'Quick Claw', 'Razor Fang', 'Assist', 'Baton Pass'],
});

// ---- Gen 8 mod（极巨化机制）----
import { Pokedex as gen8Pokedex } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/pokedex';
import { Moves as gen8Moves } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/moves';
import { Abilities as gen8Abilities } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/abilities';
import { Items as gen8Items } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/items';
import { Learnsets as gen8Learnsets } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/learnsets';
import { TypeChart as gen8TypeChart } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/typechart';
import { FormatsData as gen8FormatsData } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/formats-data';
import { Rulesets as gen8Rulesets } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/rulesets';
import { Scripts as gen8Scripts } from '../../.pi/cache/pokemon-showdown/data/mods/gen8/scripts';

// ---- 英文文本 ----
import { PokedexText } from '../../.pi/cache/pokemon-showdown/data/text/pokedex';
import { MovesText } from '../../.pi/cache/pokemon-showdown/data/text/moves';
import { AbilitiesText } from '../../.pi/cache/pokemon-showdown/data/text/abilities';
import { ItemsText } from '../../.pi/cache/pokemon-showdown/data/text/items';
import { DefaultText } from '../../.pi/cache/pokemon-showdown/data/text/default';
import { TagsText } from '../../.pi/cache/pokemon-showdown/data/text/tags';
import * as enNames from '../../.pi/cache/pokemon-showdown/data/text/names';

// ---- 简体中文文本 ----
import { PokedexText as zhPokedexText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/pokedex';
import { MovesText as zhMovesText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/moves';
import { AbilitiesText as zhAbilitiesText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/abilities';
import { ItemsText as zhItemsText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/items';
import { DefaultText as zhDefaultText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/default';
import { TagsText as zhTagsText } from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/tags';
import * as zhNames from '../../.pi/cache/pokemon-showdown/data/text/zh-cn/names';

// 数据表：data/ 相对路径（去扩展名）→ 导出对象（loadDataFile 用 dataObject[dataType] 取值）
const DATA: Record<string, any> = {
  pokedex: { Pokedex },
  moves: { Moves },
  abilities: { Abilities },
  items: { Items },
  learnsets: { Learnsets },
  typechart: { TypeChart },
  natures: { Natures },
  'formats-data': { FormatsData },
  rulesets: { Rulesets },
  conditions: { Conditions },
  scripts: { Scripts },
  pokemongo: { PokemonGoData },
  aliases: { Aliases, CompoundWordNames },
  formats: { Formats },
  // gen8 mod
  'mods/gen8/pokedex': { Pokedex: gen8Pokedex },
  'mods/gen8/moves': { Moves: gen8Moves },
  'mods/gen8/abilities': { Abilities: gen8Abilities },
  'mods/gen8/items': { Items: gen8Items },
  'mods/gen8/learnsets': { Learnsets: gen8Learnsets },
  'mods/gen8/typechart': { TypeChart: gen8TypeChart },
  'mods/gen8/formats-data': { FormatsData: gen8FormatsData },
  'mods/gen8/rulesets': { Rulesets: gen8Rulesets },
  'mods/gen8/scripts': { Scripts: gen8Scripts },
};

// 文本表：data/text/ 相对路径 → 导出对象（loadTextFile 用 [exportName] 取值）
const TEXT: Record<string, any> = {
  pokedex: { PokedexText },
  moves: { MovesText },
  abilities: { AbilitiesText },
  items: { ItemsText },
  default: { DefaultText },
  tags: { TagsText },
  names: { ...enNames },
  'zh-cn/pokedex': { PokedexText: zhPokedexText },
  'zh-cn/moves': { MovesText: zhMovesText },
  'zh-cn/abilities': { AbilitiesText: zhAbilitiesText },
  'zh-cn/items': { ItemsText: zhItemsText },
  'zh-cn/default': { DefaultText: zhDefaultText },
  'zh-cn/tags': { TagsText: zhTagsText },
  'zh-cn/names': { ...zhNames },
};

// 从 filePath 提取 data 相对路径（如 '/data/mods/gen8/pokedex' → 'mods/gen8/pokedex'）；
// config 等非 data 路径（如 '/../config/formats'）fallback 到 basename。
function dataKey(filePath: string): string {
  const s = String(filePath).replace(/\.(ts|js)$/, '');
  if (s.includes('/data/')) return s.split('/data/').pop() || '';
  return s.split('/').filter(Boolean).pop() || '';
}

export function installBrowserShim() {
  const g = globalThis as any;
  g.__psRequire = (filePath: string) => {
    const key = dataKey(filePath);
    if (!(key in DATA)) {
      const err: any = new Error(`Cannot find module '${filePath}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return DATA[key];
  };
  g.__psRequireText = (filePath: string) => {
    const key = String(filePath).replace(/\.(ts|js)$/, '').split('/data/text/').pop() || '';
    return TEXT[key] || {};
  };
  g.__psResolve = (filePath: string) => filePath;
}
