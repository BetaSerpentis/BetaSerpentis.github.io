# pmBattle 路线图

> 目标：复刻一版宝可梦单打（Singles）回合制战斗。Gen 9、全量数据与效果、玩家 vs AI、中文。

## 一、架构

```
smogon/pokemon-showdown（.pi/cache/，MIT）
  ├─ sim/*.ts        完整战斗引擎（Battle/Pokemon/Side/TeamValidator/Dex）
  ├─ data/*.ts       全量数据（含效果函数：特性 onModify*、道具、招式 onHit 等）
  └─ data/text/zh-cn 简体中文名称与战斗文本
          │
          │  build/bundle.mjs（esbuild）
          │  - alias fs/path/node:crypto/node:util/ts-chacha20 → shims/
          │  - plugin 替换 require() → globalThis.__psRequire（静态数据表）
          │
          ▼
js/vendor/ps-engine.js（8.4MB，全量引擎 + 全量数据 + 中文文本）
          │
          ▼
js/core/ps-adapter.js   战斗创建/决策/中文名/日志解析
js/core/ai.js           AI 决策（伤害预估 × 相克 + 击杀加成 + 换人评估）
js/data/teams.js        预设队伍（PS PokemonSet 格式）
js/ui/BattleField.js    渲染
js/main.js              主流程（team preview → 选招/换人 → 濒死换人 → 胜负）
```

## 二、进度

- [x] 调研：机制、数值、数据来源、中文名、Gen9 过滤（docs/RESEARCH.md）
- [x] PS 引擎浏览器打包：build/bundle.mjs → js/vendor/ps-engine.js（8.1MB）
- [x] 全量数据与效果（1518 宝可梦 / 954 招式 / 321 特性 / 583 道具，效果函数保留）
- [x] 适配层 + AI + UI + 中文日志解析
- [x] Mega 进化 / Z 技能 / 极巨化（Gen 8 NatDex Dynamax 自定义格式）
- [x] iPhone 竖屏刘海适配 + 四角布局（己方左下/血条右下/对方右上/血条左上）
- [x] 己方宝可梦背面形象（PokeAPI back sprite）
- [x] 濒死自动换人（advance 统一推进）
- [x] CSS 动画（攻击前冲/受击闪烁/登场放大/退场缩小）
- [x] 自动化测试（21 项通过）
- [ ] 后续可选增强
  - [ ] 格式切换 UI（gen9ou / Gen9 NatDex / Gen8 NatDex Dynamax）
  - [ ] 太晶化 UI 交互（Gen 9 NatDex 格式下）
  - [ ] 更多中文日志事件翻译
  - [ ] AI 使用 Mega/Z/极巨化决策
  - [ ] 队伍编辑器 / 随机队伍生成

## 三、关键决策

| 决策 | 结论 |
|------|------|
| 实现方式 | 复用 smogon/pokemon-showdown 完整引擎（esbuild 打包到浏览器），非逐条重写 |
| 世代 | Gen 9 默认；额外打包 gen8 mod 支持极巨化 |
| 对战 | 6v6 单打，100 级；格式 gen9ou / gen9nationaldex / gen8natdexdynamax |
| Mega/Z/极巨化 | Gen 8 NatDex Dynamax 自定义格式（Standard NatDex 无 Dynamax Clause） |
| 语言 | 简体中文（data/text/zh-cn，dex.text.get(x, 'zh-cn')） |
| 数据源 commit | d849b220082e |

## 四、如何构建与运行

```bash
npm run build   # 重新打包 PS 引擎（修改 shim/入口后需要）
npm test        # 运行适配层测试
npm run serve   # 启动本地服务器 http://localhost:8080
```
