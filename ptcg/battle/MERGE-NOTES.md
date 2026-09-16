# ptcgBattle 并入 ptcg：评估与实施记录

> 日期：2026-09-16 ｜ 基座：`cf111e23`（含远端 ptcgBattle 竖屏 UI 改造后的最新版本）

## 一、需求与结论

| 需求 | 结论 | 关键依据 |
|---|---|---|
| 项目整体并入 ptcg，入口从 ptcg 进入 | ✅ 可行 | CSS 顶层选择器 47 × 118 **交集为空**、DOM id **交集为空**、ptcg 未使用 CSS 变量 |
| 应用内无缝切换（非页面跳转） | ✅ 可行 | 切换 `#battle-app` 的 `.active` class，单例保留对战状态，无刷新 |
| 卡组不再内置，直接读 ptcg 本地卡组 | ✅ 可行 | 同源 localStorage（key `ptcg_decks`），ptcg 存盘结构与内置结构字段完全一致 |
| 玩家与对手共用同一份卡组列表 | ✅ 已实现 | `DeckSource.load()` 返回单一 `decks`，两列渲染同一列表 |
| 未来 AI 对战共用 ptcg 的 API Key | ✅ 零成本 | 同源 `ptcg_ai_api_key`，`AiSettings.js` 只读复用 |

## 二、集成可行性实测

- 两边 CSS 顶层选择器：battle 47 个 vs ptcg 118 个 → **交集为空**
- DOM id：battle vs ptcg → **交集为空**
- CSS 变量：ptcg **完全未使用** `--xxx` 变量 → battle 的 `:root` 变量可安全共存
- battle 全局规则仅 3 条（`*`、`html, body`、`body`）→ 只需作用域化这 3 条
- battle 无 `@media` → 无需处理响应式分支
- 新版 `#screen` 为 `position: relative; max-width: 520px; height: 100dvh`（竖屏单屏）→ 比旧版 480×320 更易嵌入

## 三、实施清单

| 阶段 | 内容 |
|---|---|
| 目录并入 | `ptcgBattle/` → `ptcg/battle/`（git mv） |
| 路径修正 | `CardResolver` 用 `import.meta.url` 推导数据目录；`SpriteUtils` 改站点绝对路径；脚踏台改 `/ptcg/battle/assets/platform.png`；测试的 `DATA_DIR` / `ID_MAPPING_PATH` / sprite 断言同步 |
| 卡组来源 | 新增 `DeckSource.js`；`main.js` 的 `_showDeckSelect` / `_renderDeckSelect` 改为动态列表 + 来源提示行 |
| AI 配置 | 新增 `AiSettings.js`（只读共用 key） |
| SPA 集成 | 删除 `index.html`，`#screen` 内嵌进 `ptcg/index.html`；`style.css` 作用域化；`main.js` 导出 mount/show/hide；卡组选择页加「返回卡牌库」；ptcg 侧加「进入对战」入口 + `_initBattleEntry()` |
| 数据清理 | 停用 `AICardDataService._loadJsonCache()`；删除旧数字 ID JSON（4.7 MB）；删除 `convert.js` + `data_txt/`（1.1 MB） |
| 顺带修复 | `DeckManager._maxQuantityFor()`：基本能量不被截断到 4 张 |

## 四、实施中遇到的问题与修复

1. **SPA 下相对路径基准变化**：battle 模块的 `fetch` 与 `<img>` 相对路径以**页面 URL** 为基准。
   嵌入 `/ptcg/` 后 `../ptcg/data/battle/`、`../ptcg/images/` 会被解析到错误位置。
   修复：`CardResolver` 用 `import.meta.url`；`SpriteUtils` 与脚踏台改用站点绝对路径。
2. **入口按钮被 fixed header 覆盖**：ptcg 的 `.search-header` 是 `position: fixed`（z-index 1001）且脱离文档流，
   插在其后的按钮会被顶到 `top: 0` 并被 `search-input` 拦截点击。
   修复：入口按钮移入 `.content-wrapper` 内部顶部。
3. **旧数字 ID 数据污染 AI 检索**：`getCardDetail` 优先查 `_jsonCache`（旧数字 ID），而现行查询全用 set-code ID，
   属死负载且可能返回无效 ID。修复：停用 `_loadJsonCache`。

## 五、验证结果

- 单元测试：**284 项全部通过**（新增 14 项：DeckSource 10 + AiSettings 2 + 跨项目 key 契约 2）
- 解析覆盖率：**15394/15394 (100%)**，残留 0
- 浏览器端到端（Playwright）：
  - 卡牌库：100 张卡渲染、7 个页签正常，战斗视图默认隐藏
  - 进入对战：`卡组来自卡牌库（共 2 套可用）`，玩家列与对手列**列表一致**
  - 返回卡牌库：视图隐藏、宿主 `body` class 复原
  - AI 数据源：`[AI Data] Ready — TSV: 12346 cards`（单一 ID 体系）
  - 无 JS 错误、无 404
- `DeckManager` 上限：基本能量 10 张保留、物品 6→4、未知类型保守 4 ✅

## 六、已知约束

- 卡组可用性门槛为「至少 1 张基础宝可梦」；不满 60 张会提示但仍可开战
- 资源使用站点绝对路径（`/ptcg/...`、`/ddp/...`），依赖部署在 `/ptcg/` 子路径（当前 GitHub Pages + 自定义域名满足）
- ptcgBattle 侧仍有测试在 node 环境无法加载真实卡牌数据（`CardResolver.load()` 依赖 fetch），
  真实数据联通由浏览器端验证覆盖
