# ptcgBattle 战斗 UI 移植方案（对标 pmBattle）

## 背景
研究结论（两侧实现与资源）：

【pmBattle（对标源）】
- index.html：竖屏单屏 #battle-screen（max-width 520px）；结构=左上 #battle-log、右上对手 .info-box、对方 .sprite-slot（血条正下方）、我方 .sprite-slot（血条正上方）、左下我方 .info-box、右下 #menu-area（menu-moves/menu-switch/menu-message）
- js/ui/BattleField.js：spriteUrl() 用 PokeAPI（我方 back/ 背面、对方正面）；renderActive() 渲染名字/HP 文本/血条宽度与颜色(css var hp-green/yellow/red)/状态标签；setHpDisplay() 单独按事件 HP 掉血；animateAttack/animateHit/animateEnter/animateExit 用 CSS class；renderLog() 保留 6 行；renderMoveMenu()=顶部行(强化+换人)+招式竖排(名 + 属性·类别·威力 PP)；renderSwitchMenu()=2 列网格；showMessage()=点击继续
- style.css：草原 CSS 渐变背景、platform.png 脚踏台（我方近处更大/对方远处更小）、menu-item 半透明无底板、hover/active/disabled、5 组 keyframes（lunge-pl/lunge-opp/hitFlash/enterScale/exitScale）、.sprite image-rendering: pixelated
- js/main.js：逐条日志播放（move→攻击动画→sleep；-damage→受击闪烁→setHpDisplay→sleep；switch/drag→animateEnter+HP快照；faint→animateExit），播放中 hideMenus() 锁操作，播完 renderBoth() 同步

【ptcgBattle（改造目标）】
- index.html：480×320 FRLG 像素风 DOM；#battle-scene(75%) 含两个 .info-box（名字/HP 条/能量+状态图标）与两个 .sprite-slot（72px/88px 方框）；#dialog-area(25%) 含 4 个 .dialog-panel（panel-main 2×2 菜单、panel-fight 列表、panel-message、panel-target）；overlay：#screen-cards（卡牌浏览）、#screen-pokemon（队伍）、#screen-deck-select
- js/main.js（1109 行，class PTCGBattleApp）：_renderScene/_renderMon 只渲染双方 active（无备战区显示、无牌库/弃牌/奖赏计数）；_updateMainMenu 更新 4 项菜单禁用态与 main-text；_showPanel/_showMessage(1.2s 自动返回)/_openOverlay/_closeOverlay；_playAttackAnim 简单 class 动画；_fitScreen 等比缩放
- js/ui/BattleField.js（143 行 Canvas 版，含 bench 5 槽 + 牌库/弃牌/奖品统计 + 点击命中）未被 main.js 引用 → 即"之前放弃的显示效果"
- js/ui/SpriteUtils.js：sprite 取 ../ddp/images/NNN.png（3 位图鉴号）；ddp/images 仅 131 张，覆盖率严重不足
- js/ui/CardView.js：手牌 DOM（宝可梦卡显示 sprite + 名字；非宝可梦显示"训/道"标签），无真实卡图
- automation.mjs：270 项测试，其中大量 UI 测试直接依赖现有 DOM 契约（#screen-cards、#screen-pokemon、.dialog-panel、#main-menu .menu-item、pokemonPickerSlotClass/pokemonPickerSlotAllowed 等导出函数）

【可用资源（关键）】
- 真实卡图：ptcg/images 下 24692 张 webp（12346 张卡 × 大图+缩略图），路径规则 images/{setCode}/{cardIndex}.webp 与 .thumb.webp（如 151C-001 → images/151C/001.thumb.webp），ptcg/js/utils/helpers.js 已有 generateImageFilename/generateFullImageFilename
- 图鉴号：ptcg/data/battle/pokemon-cards.json 9248 张中 9235 张有「编号」（全国图鉴号）→ 可直接喂 PokeAPI sprite 或本地图
- pmBattle assets：platform.png、多张 bg-*.png、gen6bgs、fx-gen（可复用）
- pmBattle 依赖的 ps-engine.js（254676 行）与 ps-adapter 属对战引擎，不在移植范围

【关键差异（TCG vs 传统对战）】
- 场地对象更多：出战 + 备战区（5 槽，竞技场卡可能 8）+ 竞技场卡 + 附着能量/道具 + 状态
- 无等级：以 HP/属性/进化阶段/规则标记（ex、GX、V、VSTAR、VMAX）替代 Lv
- 动作集不同：战斗（招式）/ 卡牌（手牌）/ 宝可梦（进化·附能·撤退·特性）/ 结束

## 相关代码
- 暂无。

## 相关文档
- 暂无。

## 当前结论
- pmBattle 的显示心脏是「sprite + platform + 独立血条（实体上/下方）+ 状态标签」四件套，操作心脏是「右下无底板浮动 menu-item 竖排 + 播放期锁菜单 + 消息点击继续」，两者都与战斗引擎解耦，可整体搬到 ptcgBattle
- ptcgBattle 已有等价结构（.sprite-slot/.info-box/.dialog-panel/overlay），但缺少：备战区显示、牌库/弃牌/奖赏计数、真实卡图、pmBattle 级动画与逐条日志节奏
- js/ui/BattleField.js 的 Canvas 实现（含备战 5 槽与统计）是死代码；它证明了数据接口齐备（player.active/bench/deck/discard/prizes、resolver.getInfo(number)），移植只需把渲染层从 Canvas 换成 pmBattle 的 DOM+CSS 方案
- sprite 覆盖率是显示效果此前失败的主因之一：ddp/images 仅 131 张；现在有 9235/9248 图鉴号 + 卡图 24692 张可用，显示层可行性已具备
- automation.mjs 有 270 项测试、其中大量 UI 断言绑定现有 DOM 选择器与导出函数；改造必须遵守「换皮不换契约」否则会大面积挂测

## 方案对比
- 屏幕与风格：A) 竖屏现代风（完全对标 pmBattle，520px 竖屏、无底板半透明菜单、PokeAPI sprite）；B) 保留 480×320 像素缩放骨架，只把「宝可梦显示 + 操作区」换成 pmBattle 语言（像素平台 + 半透明菜单）
- 布局：A) 单屏（战场 + 右下浮动菜单，日志左上浮层，pmBattle 原样）；B) 双区（战场 75% + 底部操作区 25%，保留现结构只换视觉）
- sprite 源：A) PokeAPI 在线（back/ 我方，正面对方；清晰且全）；B) 本地 ddp/images 优先（离线但仅 131 张）；C) 在线优先 + 本地 onerror 回退 + 浏览器缓存（推荐）
- 卡面：A) 真实卡图缩略图（.thumb.webp）+ 点击看大图（.webp）；B) 保持名字+类型标签（轻量）；C) 混合：场地/手牌用缩略图，列表用文字
- 备战区：A) 5 槽固定；B) 4/8 槽随竞技场卡动态（崩塌的竞技场、零之大空洞会影响上限）；C) 先做 5 槽，卡面效果后续接
- 动画与节奏：A) 全量对标（前冲/受击/入场/退场 + 逐条日志 + 播放锁）；B) 只做 attack/hit（其余瞬时）；C) 动画全量但日志一次性刷出

## 推荐方案
推荐组合：竖屏现代风（方案 A）+ 单屏浮动菜单（A）+ sprite 在线优先本地回退（C）+ 卡面混合缩略图（C）+ 备战 5 槽起步（C）+ 动画全量但保留「快速模式」开关（A/B）。

理由：pmBattle 的视觉/操作语言本身就是为竖屏手持体验设计，直接对标收益最大；而 ptcgBattle 的数据层（GameState/BattleEngine/resolver）与 pmBattle 无关，UI 层是纯替换，风险集中在「DOM 契约与 270 项测试」而非引擎。

实施严格分 4 步（每步可独立验收，且始终保持测试绿）：
- P1 显示层（战场重排）：改用 pmBattle 布局与视觉；_renderMon 升级为 sprite+platform+独立血条+状态标签+规则标记；新增备战区 5 槽渲染与点击选中；新增牌库/弃牌/奖赏计数徽标；sprite 源切 PokeAPI（ddp 回退）。保留所有现有 id/class 选择器。
- P2 操作层（浮动菜单）：#dialog-area 的 4 个 panel 换皮为 pmBattle menu-item 浮动列（panel-main→主菜单、panel-fight→招式列表带属性/伤害/能量需求、panel-target→目标列表、panel-message→点击继续）；新增「宝可梦」子菜单（进化/附能/撤退/特性）；播放期锁定（AI 回合隐藏菜单并显示"对手回合"提示）。
- P3 卡面层：手牌/场地卡图接入（.thumb.webp 懒加载 + .webp 详情）；#screen-cards / #screen-pokemon 换皮为 pmBattle 深色半透风格（保留 DOM 契约与分页/使用/确认布置按钮）。
- P4 动画与节奏：pmBattle 5 组 keyframes + 逐条日志播放（攻击→受击→掉血顺序，HP 用事件快照）与 sleep 节奏；提供「设置：动画速度/关闭」以兼容性能与快速对局。

每步完成后跑 `npm --silent run test:ptcg-battle`（270 项）+ 手动 iPhone 尺寸走查（setup→出招→受伤→击倒→换人→胜负）。

## 风险与边界
- DOM 契约风险（最高）：automation.mjs 大量 UI 测试绑定 #screen-cards/#screen-pokemon/.dialog-panel/#main-menu .menu-item 与 pokemonPicker* 导出函数；改结构必须先对齐测试（换皮不换契约），否则 270 项会挂
- sprite 依赖：9235/9248 有图鉴号（13 张缺失需文字占位）；PokeAPI 需联网，离线时回退本地 ddp/images 仅 131 张（覆盖率骤降）
- 卡图加载：24692 张 webp 若一次性加载会卡；必须缩略图优先 + 懒加载 + 预取当前手牌/场地
- 备战区数量：现有主界面没有备战 UI，新增 5 槽会挤压 480×320 像素布局；竖屏改造可缓解，但需重新适配 _fitScreen 缩放
- 玩法语义差异：pmBattle 只有「招式/换人/强化」，没有「卡牌/备战/能量附着/奖赏/竞技场」概念；操作菜单需按 TCG 动作集重新设计，不能照搬招式菜单语义
- 死代码清理：js/ui/BattleField.js（Canvas 版）与 pencil.* 已无引用，建议在方案确认后删除或标注 deprecated，避免后续维护混淆

## 验证方式
- 暂无。

---

## 实施进度（2026-09-13 开工，决策已确认）

用户确认口径：**1.a 完全对标 pmBattle｜2 单屏｜3 在线优先+本地缓存（后续可转纯本地）｜4 先混合卡面（后续可只留名字标签）｜5 备战区不常显（仅查看/选择时列表）｜6 全量动画对标**

### 已完成

- **P1 显示层（竖屏单屏 + pmBattle 视觉）**
  - `index.html`：改为竖屏单屏结构（`#battle-scene` 铺满 + `#dialog-area` 右下浮动 + 左上 `#battle-log`）；新增 `.platform`（脚踏台，`assets/platform.png`）、`#pl-status/#opp-status`（状态标签）、`#pl-tags/#opp-tags`（规则标记）；保留全部既有 id/class 契约
  - `style.css`：整体重写为 pmBattle 语言（草原渐变场地、无底板半透明菜单、加厚圆角 HP 条 + 血量居中、立绘 drop-shadow + pixelated、日志浮层、深色半透 overlay）；动画 keyframes 5 组（lunge-pl/lunge-opp/hitFlash/enterScale/exitScale）
  - `js/ui/SpriteUtils.js`：新增在线优先资源层（PokeAPI 正面/背面）→ 本地 `ddp/images` → 隐藏占位；`data-fb` 回退链 + `window.__spriteFallback`；`warmSpriteCache()`（Cache Storage 预热，供后续纯本地化/SW 使用）
  - `js/main.js`：`_renderMon` 升级（在线优先立绘 + 我方背面、规则标记 ex/GX/V/VSTAR/VMAX/进化阶段、状态标签、附着能量与道具图标）；`_fitScreen` 改为竖屏自适应（移除 480×320 等比缩放）；`_showMessage` 同步写入 `#battle-log`（保留最近 6 行）
- **P2 操作层（浮动菜单对标）**
  - 主菜单/招式/目标/消息沿用既有面板结构但换为 pmBattle 浮动菜单视觉；`_showFightPanel` 升级为「招式名 + 属性·伤害·能量需求（无需能量/需 X）」两行式（`.mv-name` / `.mv-meta`）
  - 新增 `_elementLabel()`（英文属性 → 中文，兼容中文 cost）
  - 队伍/备战/卡组封面立绘统一改为在线优先（我方背面）
- **P3 卡面层（混合显示，可降级）**
  - 新增开关 `SHOW_CARD_ART`（`window.PTCG_SHOW_CARD_ART=false` 可运行时关闭 → 只留名字与标签）
  - 卡牌列表项插入 `.card-art` 缩略图；卡牌预览使用真实卡面大图（`ptcg/images/{set}/{idx}.webp`）+ `.card-art-fallback` 文字兜底
- **P4 动画与节奏（全量对标）**
  - `_playAttackAnim/_playAttackAnimAsync`（攻方前冲 + 对方受击闪烁）、`_animateHit`、`_animateEnter`（起始态后换图，避免旧图闪现）、`_animateExit`
  - `_doAttack` 串联节奏：前冲 → 引擎结算 → 受击闪烁 → 血条过渡 → 换人/击倒登场动画
  - `_animEnabled()`：Node 测试环境或无 `document.body` 时自动跳过等待；`window.PTCG_ANIM='off'` 可关闭

### 验证

- `npm --silent run test:ptcg-battle` → **270/270 通过**（每步改完均跑；覆盖率报告 15394/15394，unparsed 0）
- 静态契约自检：`main.js` 查询的 33 个 id 全部存在于 `index.html`；CSS 关键类无缺失

### 待办 / 下一步

- 真机（iPhone 尺寸）走查：setup → 出招 → 受击 → 击倒 → 换人 → 胜负 全流程动画与布局
- 精灵图本地化（用户可能后续要求）：把 PokeAPI 1025 只（正面+背面）下载到 `ptcgBattle/assets/sprites/`，并把 `SPRITE_ONLINE_BASE` 指向本地目录（调用方无需改动）
- 备战区：按确认口径保持「不常显」，仅通过宝可梦界面（`#screen-pokemon`，已换皮为立绘列表）查看/选择
- 可选：日志逐条播放队列（当前为即时追加 + panel-message 1.2s 提示）、卡面开关默认值调优
- 死代码清理：`js/ui/BattleField.js`（Canvas 版）、`js/ui/CardView.js`、`pencil.*` 已无引用，可确认后删除
