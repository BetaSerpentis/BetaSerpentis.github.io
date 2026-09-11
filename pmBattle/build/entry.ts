// build/entry.ts — pmBattle 浏览器引擎入口
//
// 导出 PS 引擎核心 API（全量战斗引擎 + 全量数据），先安装浏览器数据 shim。

import { installBrowserShim } from './browser-shim';
installBrowserShim();

export { Dex, toID } from '../../.pi/cache/pokemon-showdown/sim/dex';
export { Battle } from '../../.pi/cache/pokemon-showdown/sim/battle';
export { Pokemon } from '../../.pi/cache/pokemon-showdown/sim/pokemon';
export { Side } from '../../.pi/cache/pokemon-showdown/sim/side';
export { TeamValidator } from '../../.pi/cache/pokemon-showdown/sim/team-validator';
export { PRNG } from '../../.pi/cache/pokemon-showdown/sim/prng';
export { Field } from '../../.pi/cache/pokemon-showdown/sim/field';

// 便捷：默认 Gen 9 Dex 实例
import { Dex } from '../../.pi/cache/pokemon-showdown/sim/dex';
export const gen9Dex = Dex.forFormat('gen9ou');
