# ptcgBattle 操作区收敛方案（去全屏二级界面）

## 背景
目标：去掉一切全屏二级界面，把卡牌查看与全部操作集中到右下角操作区（pmBattle 单屏浮动菜单）。图片类（卡面缩略图/宝可梦图标）在操作区不显示，可全部去掉。

【现状：需要移除的全屏界面】
- #screen-cards（overlay-screen）：承载 4 种模式
  1) hand：手牌/弃牌浏览（分页，页 0=手牌、页 1=弃牌）+ 卡牌预览 + 使用按钮 + 初始布置确认
  2) search-deck / search-discard / prize：搜索类效果选卡（cb 回调返回索引数组）
  3) pick-cards：通用选卡（多选/上限/最少，cb 回调）
- #screen-pokemon（overlay-screen）：承载 4 种模式 view/energy/evolve/tool/swap
  - view：查看双方队伍（出战 + 备战列表，含立绘与 HP）
  - energy/evolve/tool：选择目标宝可梦后执行附能/进化/装备（_openPokeScreen(mode,{handIdx,data})）
  - swap：撤退换人选择
- #screen-deck-select：开局卡组选择（建议保留——属于开局一级界面，非对局中二级界面）

【现有 main.js 相关方法与契约】
- _openCardScreen(mode, cb, cards, title, options) / _closeCardScreen / _renderCardList / _renderCardPreview / _selectCardInList / _useSelectedCard / _finishCardPickMode / _confirmSetupFromCardScreen / _getCardPages / _changeCardPage
- _openPokeScreen(mode, targetData) / _closePokeScreen / _renderPokemonScreen / _changePokePage / _onPokeAction / _getSelectedPokeMon
- _handlePick(pick)（→ pick-cards 模式）/ _handlePokemonPick(pick)（→ screen-pokemon）
- 面板系统：#panel-main（4 动作）/ #panel-fight（招式列表）/ #panel-target（目标列表）/ #panel-message（提示，现已隐藏文本）
- automation.mjs 中约 40+ 处断言依赖 pokemonPickerSlotClass/pokemonPickerSlotAllowed/pokemonPickerHasLegalTarget/pokemonPickerConfirmEnabled 导出函数，以及 #screen-cards / #screen-pokemon 的 open/close 行为（如 calls.includes('open:screen-cards')）

【规则侧必须覆盖的操作（PTCG 官方流程）】
1) 开局：洗牌抽 7 → 起手无基础宝可梦则展示并洗回重抽（每重抽一次对手额外抽 1 张）→ 放置基础宝可梦到战斗区、其余基础可放备战（最多 5）→ 双方各放 6 张奖赏卡 → 先攻先行动
2) 回合开始：抽 1 张（牌库空则判负）
3) 主要阶段（任意顺序，除注明外可重复）：
   - 放基础宝可梦到备战（不限次，上限 5）
   - 进化（每只每回合 1 次；当回合出场或刚进化的不能进化）
   - 附着能量（每回合 1 次）
   - 使用物品（不限次）
   - 使用支援者（每回合 1 次）
   - 使用竞技场（每回合 1 次，替换旧场）
   - 装备宝可梦道具（每只 1 个）
   - 使用特性（主动特性：标明次数；手牌/弃牌区特性；被动自动生效）
   - 撤退（每回合 1 次，支付撤退能量）
   - 查看：手牌/弃牌区/牌库（仅卡效果允许时）/奖赏卡（不可查看己方奖赏卡内容）
4) 攻击：选招式 → 能量检查 → 招式效果 → 伤害结算（弱点/抗性/修正）→ 回合结束（先攻第一回合不能攻击；睡眠/麻痹不能攻击）
5) 回合结束：宝可梦检查（中毒/灼伤/睡眠/麻痹结算）→ 切换玩家 → 抽卡
6) 胜负：拿完奖赏卡 / 对手场上无宝可梦 / 牌库抽干
7) 特殊限制：ACE SPEC 每卡组 1 张、ex 拿 2 奖、GX/VSTAR 力量每局 1 次、先攻首回合禁支援者与攻击

## 相关代码
- ptcgBattle/js/main.js
- ptcgBattle/index.html
- ptcgBattle/js/core/GameState.js
- ptcgBattle/js/core/BattleEngine.js
- ptcgBattle/js/core/EffectExecutor.js
- ptcgBattle/tests/automation.mjs

## 相关文档
- ptcgBattle/UI-MIGRATION-PLAN.md
- ptcgBattle/ROADMAP.md
- ptcgBattle/PROGRESS.md

## 当前结论
- 全屏界面的本质是“列表 + 目标选择”两种交互，完全可以用操作区的分页文本列表替代（pmBattle 的 menu-item 列表）；去掉图片后列表更紧凑，且信息（卡名/类型/HP/状态/能量数）足以决策
- 现有 picker 逻辑（_handlePick/_handlePokemonPick + pokemonPicker* 导出函数 + waitForPick 契约）是引擎与 UI 的解耦层，重构时应保留这层契约，只替换“呈现层”（把 overlay 列表换成操作区列表），这样 40+ 处测试断言不用重写
- 撤退支付（retreat-energy pick）与其他选卡共用 waitForPick，但其语义是“选能量丢弃”，需要在操作区列表里显示能量条目（属性 + 数量），并允许确定/取消
- 搜索类效果（search-deck/search-discard/prize）候选可能很多（牌库 60 张），操作区列表必须分页（建议 6-8 条/页 + 上一页/下一页/确定）
- 卡牌操作需要按类型分发动作（放置/进化/附能/装备/使用/特性/查看），并与规则前提校验联动（每回合 1 次能量/支援者、备战上限 5、道具 1 个、进化限制），这些校验已在 GameState/BattleEngine 内实现，UI 只需展示可用/禁用并给出拒绝原因
- 操作区空间有限（竖屏右下 46% 宽），建议列表项单行显示“名称 + 关键标签”，详情用同一区域的“详情视图”（滚动文本）而不是弹窗

## 方案对比
- 列表呈现：A) 单行“名称+标签”+ 分页（推荐，窄屏可读）；B) 两行（名称 + 元信息）；C) 图标+文字（用户已要求去图，排除）
- 列表分页策略：A) 固定 6 条/页 + ◀▶ 翻页（推荐）；B) 滚动列表（需要容器高度，窄屏易被菜单撑破）
- 详情查看：A) 操作区内“详情视图”（返回上一级，显示卡牌文本/效果说明，推荐）；B) 完全不提供详情（仅名称与标签）；C) 长按显示 tooltip
- 卡牌动作入口：A) 点卡 → 动作子菜单（推荐，清晰）；B) 列表内直接列出所有可用动作（条目会膨胀）
- 宝可梦动作入口：A) 选宝可梦 → 动作子菜单（推荐）；B) 先选动作再选目标（适合“撤退/进化”这类定向操作）
- 全屏界面处置：A) 保留 DOM 但不再展示（最小风险）；B) 彻底删除 DOM 与相关代码（最干净，需同步改测试，推荐在 P6-5 执行）

## 推荐方案
推荐组合：单行“名称+标签”+固定分页（6 条/页）+ 操作区内详情视图 + “点卡→动作子菜单”与“选宝可梦→动作子菜单”双入口；全屏界面在 P6-5 彻底删除并同步测试。

操作树（目标形态，全部在右下操作区）：
【主菜单】战斗 / 卡牌 / 宝可梦 / 结束（+ 起手无基础时的「重新抽牌」）
├ 战斗 → 招式列表（名称 + 属性·伤害·需能量；禁用灰显）→ 确认攻击（攻击后回合结束）/ 返回
├ 卡牌 → 手牌列表（分页：名称 + 类型标签）→ 点击进入【卡牌操作】
│    ├ 宝可梦(基础) → 放到战斗区 / 放到备战区（上限5禁用）
│    ├ 宝可梦(进化) → 选择目标宝可梦（列表）→ 进化
│    ├ 能量 → 选择目标宝可梦 → 附着
│    ├ 道具 → 选择目标宝可梦 → 装备
│    ├ 训练家 → 使用（需要目标时进入目标列表）
│    ├ 主动特性 → 使用特性
│    └ 查看 → 详情文本 / 返回
├ 宝可梦 → 场上列表（出战 + 备战：名称 HP 状态 能量数）→【宝可梦操作】
│    ├ 进化（手牌有对应进化卡时可用）
│    ├ 附能量（手牌能量或卡效果允许的弃牌区能量）
│    ├ 装备道具（手牌道具）
│    ├ 使用特性（主动特性）
│    ├ 撤退（选择要丢弃的撤退能量 → 确定/取消）
│    └ 查看 → 详情
└ 结束 → 结束回合（状态结算 → 切换玩家）
【系统触发】搜索/回收/奖赏选择 → 操作区候选列表（分页 + 确定/取消），复用 waitForPick 回调；目标选择 → 操作区宝可梦列表

规则完整性核对（实现后逐项验收）：起手 mulligan 与对手补抽、每回合能量 1 次、支援者 1 次、竞技场 1 次、撤退 1 次、进化限制、备战上限 5、道具 1 个、主动特性次数、先攻首回合禁支援者/攻击、攻击后结束回合、状态结算、奖赏卡胜负、牌库抽干判负、ACE SPEC/ ex 规则。

测试策略：保留 pokemonPicker* 与 waitForPick 契约（40+ 断言不动）；P6-5 删除全屏界面时同步更新约 10-20 处 open/close(#screen-cards|#screen-pokemon) 断言为新操作区路径断言。

## 风险与边界
- 测试契约：automation 中约 10-20 处断言依赖 #screen-cards / #screen-pokemon 的 open/close 行为，P6-5 删除界面时必须同步改断言；pokemonPicker* 导出函数与 waitForPick 契约必须保留（40+ 断言）
- 空间风险：竖屏右下 46% 宽度 + 长列表（牌库搜索最多 60 张）需要分页；分页状态与 cb 回调索引映射（页内索引 → 全局索引）容易出错，需专门测试
- 流程耦合：搜索类效果（search-deck/prize/pick-cards）在效果执行中途 await waitForPick，若此时玩家打开别的菜单/结束回合会造成状态错乱；需要“效果选择期间锁定主菜单”
- 撤退支付与附着能量选择共用选卡路径但语义不同（丢弃 vs 移动），提示文本与可选项必须区分
- 删除全屏界面涉及较多历史代码（pencil.html/pencil.js/CardView/BattleField Canvas），删错可能影响静态页面或测试的其它断言
- 操作层级过深（主菜单→列表→操作→目标）在窄屏点击效率低，需要每层都有明确的“返回”与当前上下文标题（标题放在操作区顶部一行，不显示长提示语）

## 验证方式
- P6-1 操作区列组件：在 #dialog-area 内实现可复用列表（分页/滚动、选中态、返回/确定），替换现有 4 个 panel 的静态结构
- P6-2 手牌与卡牌操作：手牌列表（单行文字 + 类型标签）→ 卡牌操作菜单（放置/进化/附能/装备/使用/特性/查看），按类型与规则前提启用/禁用
- P6-3 宝可梦列表与操作：出战+备战列表（名称/HP/状态/能量数）→ 进化/附能量/装备道具/特性/撤退/查看
- P6-4 目标与选卡统一：_handlePick 与 _handlePokemonPick 改为渲染操作区列表（宝可梦目标 / 卡牌候选分页 / 撤退能量），保留 pokemonPicker* 契约与 cb 语义
- P6-5 移除全屏界面与死代码：#screen-cards、#screen-pokemon、pencil.*、js/ui/BattleField.js（Canvas）、js/ui/CardView.js；同步更新 automation 中依赖 open/close screen-cards 的断言；补操作区路径测试
- P6-6 规则完整性回归：按核对表逐项手动走查（开局 mulligan、每回合限次、进化限制、备战上限、撤退支付、搜索分页、攻击结束回合、胜负判定）
