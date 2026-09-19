# ptcgBattle 开发进度

## 并入 ptcg（2026-09-16）

ptcgBattle 已整体并入 ptcg，不再是独立项目：

- **路径**：`ptcgBattle/` → `ptcg/battle/`（`git mv`，保留重命名历史）
- **入口**：唯一入口为 ptcg 首页（`/ptcg/`）的「⚔ 进入对战」按钮；原独立页已删除
- **切换方式**：同页切换 `#battle-app` 的 `.active` class —— SPA 嵌入，不刷新页面、不丢对战状态
  - ptcg 侧：`ptcg/js/main.js` → `_initBattleEntry()` 动态 `import('../battle/js/main.js')` 后调用 `showBattleApp()`
  - battle 侧：`ptcg/battle/js/main.js` 导出 `mountBattleApp()` / `showBattleApp()` / `hideBattleApp()`（单例）
  - 返回卡牌库：卡组选择页「← 返回卡牌库」→ `window.__ptcgReturnToLibrary`
- **样式隔离**：`style.css` 的 `*` / `html, body` / `body` 三条全局规则已作用域化为
  `#battle-app, #battle-app *` / `body.ptcg-battle-active` / `#battle-app`。
  实测两边 CSS 顶层选择器 47 × 118 **交集为空**、DOM id **交集为空**、ptcg 未使用 CSS 变量（battle 的 `:root` 变量无冲突）
- **资源路径**：`CardResolver` 数据目录改为 `new URL('../../../data/battle/', import.meta.url)`（与页面 URL 解耦）；
  `SpriteUtils` 的 `SPRITE_BASE = '/ddp/images/'`、`CARD_IMAGE_BASE = '/ptcg/images/'`（站点绝对路径，两种页面 URL 都正确）；
  脚踏台 `src="/ptcg/battle/assets/platform.png"`
- **卡组来源**：不再内置，`js/core/DeckSource.js` 读 ptcg 卡牌库的 localStorage（key `ptcg_decks`）；
  **玩家与对手共用同一份可用列表**，各选一套；不可用时回退内置卡组
- **AI 配置**：`js/core/AiSettings.js` 读取 ptcg 已配置的 `ptcg_ai_api_key`（供后续 AI 模拟对战复用，只读不写）
- **SW**：沿用远端 v30 策略（html/js/css 网络优先），`/ptcg/battle/` 资源走网络，无需额外改动

### 数据层去冗余

- 卡牌数据本就同源（`ptcg/data/battle/*.json` 由 `build-battle-data.py` 从 CN-Sync 生成，与 `data_fast/*.tsv` 同源），ptcgBattle 未持有副本
- 真正的冗余在 ptcg 内部：`ptcg/data/*.json`（**旧数字 ID** 体系，10669 个 ID）与 `ptcg/data/battle/*.json`（**set-code ID** 体系，12346 个 ID）**交集为 0**
- 处置：停用 `AICardDataService._loadJsonCache()`（原为回退加载，会污染 AI 检索并多加载 4.7MB），并删除 7 个旧 JSON（4.7 MB）
- 效果：AI 数据源日志由 `Ready — TSV: N cards, JSON: 10669 cards` 变为 `Ready — TSV: 12346 cards`，单一 set-code ID 体系
- 另清理：`convert.js` + `data_txt/`（1.1 MB，旧繁中数据转换链路，已被 `ptcg/tools/build-battle-data.py` 取代）

### 顺带修复

- `ptcg/js/core/DeckManager.js`：导入/清理卡组时的 `Math.min(card.quantity, 4)` 会**误截断基本能量**。
  新增 `_maxQuantityFor()`：基本能量不限（99），其他类型仍限 4；类型查不到时保守按 4。

### 跨项目契约（测试锁定）

| key | 定义处 | 用途 |
|---|---|---|
| `ptcg_decks` | `ptcg/js/utils/constants.js` → `STORAGE_KEYS.DECKS` | 卡组共享 |
| `ptcg_ai_api_key` | `STORAGE_KEYS.AI_API_KEY` | AI Key 共享 |
| `ptcg_ai_settings` | `STORAGE_KEYS.AI_SETTINGS` | AI 设置共享 |
| `ptcg_ai_chat_history` | `STORAGE_KEYS.AI_CHAT_HISTORY` | AI 历史（预留） |

---

## 数据同步（2026-08 重要变更）

ptcgBattle 卡牌数据已从旧繁中数字 ID 数据迁移到与 ptcg 完全同源的简中 set-code ID 数据：

- **数据来源**：`ptcg/data/battle/*.json`，由 `ptcg/tools/build-battle-data.py` 从 `E:\PTCG-CN-Sync`（tcg.mik.moe 简中，与 ptcg 的 `data_fast` 同源）生成。
- **卡牌 ID**：统一为 set-code ID（如 `CSVE1C-003`），与 ptcg 主程序一致；旧数字 ID（如 `7970`）通过 `ptcg/tools/id_mapping.json` 迁移（测试里保留反向映射桥）。
- **卡池**：完整 12346 张（9248 宝可梦 + 3098 训练家/能量），覆盖 A–J 标（含 SV10「共逐荣光」），与 `data_fast` 卡 ID 集合 100% 一致。
- **CardResolver** 改读 `ptcg/data/battle/`；`decks.js` 测试卡组已换新 ID；`isEx/isRadiant/hasRuleBox` 改用 `mechanic` 字段判定。
- **弱点/抵抗力**：新增 `弱点倍率`/`抵抗值` 真实数据，BattleEngine 由固定 x2 / -30 改为读取卡牌真实值。
- **数据构建**：`python ptcg/tools/build-battle-data.py`（battle 数据）与 `python ptcg/tools/build-cn-data.py`（data_fast + id_mapping）各自可独立重跑。

### EffectParser 简中迁移（已基本完成）

数据已同步，效果解析器 EffectParser 已加 `normalizeCn()` 简中→繁中归一化层（若→如果、抛掷→掷、放于弃牌区→丢到弃牌区、附着于→附于、回复→恢复、下一个→下个、使/令→将、给对手看过后等）+ 大量高频简中规则适配。

- 现状：解析覆盖率 11257/15394 (**73%**)（迁移前 27%，旧繁中基线 64%）。
- ✅ **2026-09-08 最终：解析覆盖率 15394/15394 = 100%，unparsed 残余 = 0，执行层动作缺口 = 0**（详见 ROADMAP.md 最终状态）。
- 全部 ptcgBattle 自动化测试通过（含真实卡牌效果解析用例）。
- 已接入：条件伤害 per_unit、受到的招式的伤害±N（damage_received_mod）、异常状态合并、特殊能量供能、化石、被动光环（通用伤害光环/撤退费全消/无法撤退/受伤增减/防状态/弱点消除/中毒加伤）。
- 被动层已重构为运行时查询架构：`_passiveEffectsFor` / `_hasPassive` / `getPassiveDamageReceivedModifier`。
- 保护线：`PARSER_COVERAGE_MIN_RATIO=0.45`、`PARSER_RESIDUAL_MAX_COUNT=13000`，随解析迁移推进继续上调。

#### 未覆盖 43% 构成（6653 条）
- 宝可梦技能 4629 / 特性 1159 / 道具 293 / 支援者 281 / 物品 172 / 竞技场 106 / 特殊能量 13。
- 语义类型：条件触发+持续被动 ~1800、能量操作 ~800、牌库操作 ~400、伤害修正/无视 ~300、换位/回手/化石/杂项 ~300。
- 尚未接执行的（仅解析）：dual_type（双属性）、block_heal（无法回复HP）、prevent_effect（不受到招式效果）。

---

## 文件结构
```
ptcg/battle/                # 已并入 ptcg（原 ptcgBattle/，2026-09-16；入口由 ptcg 首页进入）
├── style.css               # 竖屏单屏战斗界面样式（已作用域化到 #battle-app，可嵌入式共存）
├── assets/platform.png     # 脚踏台贴图
├── PROGRESS.md             # 本文件
├── MERGE-NOTES.md          # 并入 ptcg 的评估与实施记录
├── UI-MIGRATION-PLAN.md    # 战斗 UI 对标 pmBattle 的移植方案
├── UI-OPERATION-PLAN.md    # 操作区收敛方案
├── ROADMAP.md / mockup.md  # 覆盖推进路线图 / 早期设计稿
├── tests/automation.mjs    # 自动化测试（284 项，含解析覆盖率报告）
└── js/
    ├── main.js             # 主入口 + UI流程（导出 mountBattleApp / showBattleApp / hideBattleApp）
    ├── core/
    │   ├── GameState.js      # 状态管理（能量/进化/训练家/选择等待）
    │   ├── BattleEngine.js   # 回合/攻击/能力引擎 + AI
    │   ├── CardResolver.js   # 卡牌ID→全量数据编译（数据目录由 import.meta.url 推导）
    │   ├── EffectParser.js   # 效果文本→指令
    │   ├── EffectExecutor.js # 异步指令执行 + 目标/卡牌/能量选择
    │   ├── DeckSource.js     # 卡组来源（读 ptcg 卡牌库 localStorage，玩家与对手共用列表）
    │   └── AiSettings.js     # 与 ptcg 共用的 AI 配置（API Key / 设置）
    ├── ui/
    │   └── SpriteUtils.js    # 立绘/卡图路径与回退链
    └── data/
        └── decks.js          # 内置卡组（卡牌库不可用时的回退）

> 注：原 `index.html` 已删除 —— 战斗视图现内嵌在 `ptcg/index.html` 的 `<div id="battle-app">` 内，
> 由 ptcg 首页的「⚔ 进入对战」按钮切换显示（同一页面内切 class，不重新加载）。
```

## 已完成
- [x] FRLG风格4:3战斗UI、卡牌/宝可梦模板界面、卡组选择入口、状态图标
- [x] 真实HP/技能/伤害、奖赏卡、基础宝可梦放置、进化继承伤害&能量
- [x] 能量附着、对象化能量存储、特殊能量供能/附着规则、能量消耗检查
- [x] 攻击索引直连、简化弱点/抵抗力、失败前置判定、部分攻击附加效果执行
- [x] 训练家/能力/常见效果解析与执行：抽牌、查看/保留、检索、切换、异常、放置伤害指示物、弃牌/回收、能量附着/弃置/移动、洗牌、投币等
- [x] 撤退费用正式选择：显式能量索引、UI多选、可取消、支持多供能特殊能量支付，能量图标按对象渲染
- [x] damage_place目标选择泛化：支持对手出战/备战任意目标，UI effect-target选择修复，备战气绝处理
- [x] peek_and_keep余牌处理：支持shuffle/top余牌解析与执行，并清理代表性残留文本
- [x] 解析残留清理：trainer_prerequisite/usage_condition元数据或no-op处理、安全条件投币包装、修正过度声明
- [x] 对手能量弃置目标选择：支持出战/备战/场上目标、指定附着能量选择、解析对齐；无picker时跳过无匹配能量目标
- [x] return_to_hand选择迁移：target:'choose'走宝可梦选择器并支持主动替换；target:'self'保持仅作用于出战位
- [x] 宝可梦通信/手牌宝可梦回卡组检索迁移到手牌宝可梦选择器；修复“宝可梦道具”误判，并记录元数据/标签过滤启发式
- [x] search_deck_to_hand迁移到按过滤条件生成牌库候选；缺少完整数据时保留安全ID fallback
- [x] 轻量区域卡牌元数据解析：BattleEngine向GameState挂接resolver，EffectExecutor在可用时解析ID-only卡牌用于过滤；未知fallback保留，并修正Pokemon+energy组合过滤语义
- [x] 奖赏卡与手牌弃置选择继续迁移到picker：prize_deck_top_swap（阿尔宙斯手机）支持奖赏卡选择、指定索引交换、空/无奖赏no-op、确定性fallback与可选取消；non-random discard_hand支持按数量/过滤条件/取消/fallback选择弃牌，discard_all_hand与discard_opponent_hand_random保持原语义
- [x] 训练家 discard_cost 前置费用：GameState.canUseTrainer支持dry-run合法性检查，使用训练家前先校验/支付手牌弃牌费用；失败、取消或费用不足时不消耗训练家且不改变支援者状态
- [x] WP3训练家轻量事务边界：useTrainer在前置合法性/费用后为训练家消耗与效果执行建立snapshot/rollback；必需picker取消、必需宝可梦目标失败与必需效果失败会回滚手牌/弃牌/牌库/奖赏/场上附加卡/支援者与竞技场等状态，可选allowEmpty/allowFewer保留成功no-op语义
- [x] setup/addLog RangeError修复：autoSetup扫描基础宝可梦、日志长度受限、放置函数返回结果值、缺失sprite时安全fallback
- [x] setup卡死修复：对手无基础宝可梦时mulligan/redeal恢复，confirmSetup失败时在可见UI中反馈并保持可操作状态
- [x] Task A：executor侧过滤peek_and_keep与search_deck_to_bench；宝可装置/宝可齿轮限定支援者；巢穴球按基础宝可梦过滤并使用真实resolver放置
- [x] Task B/E：先攻玩家第一回合禁止使用支援者、禁止攻击
- [x] Task C：竞技场上场时跳过立即执行；Pokemon Tool按道具过滤，不再误走普通训练家效果
- [x] Task D：玩家攻击后对手AI回合能继续推进并回到玩家回合
- [x] Task F：非法/无效果操作不再显示假成功，追加明确no-op/失败反馈日志
- [x] 杜娟/水莲的照顾修复：杜娟按奖赏落后条件执行非对称洗手重抽；水莲的照顾按弃牌区恢复对象过滤
- [x] Task G：竞技场激活入口、共享当前竞技场状态、每方每回合一次激活限制、竞技场替换/弃置按owner归属处理
- [x] Task H：初始setup从手牌卡牌界面开始，并在卡牌界面内确认设置
- [x] WP2：扩展训练家前置条件正式校验，覆盖first_turn（含后攻玩家最初回合）、opponent_prizes_at_most、own_prizes_more_than_opponent，并区分先攻首回合支援者例外；非法时不消耗卡牌/费用或使用标记；2026-06-16验证通过
- [x] WP3：为useTrainer增加最小事务边界，required picker/目标失败时回滚训练家消耗、费用、使用标记和相关场上状态，并修复回滚后竞技场owner/共享对象身份
- [x] WP4：switch_pokemon支持解析出的choose:'opponent'语义；目标方为玩家时走现有宝可梦选择器，AI/no-UI对手选择时确定性选择首个可用备战位
- [x] WP5：manipulate_deck_top窄口径执行支持；覆盖查看牌库顶原样放回、可选丢弃/置底/洗牌、匹配物品丢弃、选择置顶其余置底与任意顺序原序fallback；lost_zone/fossil_place仍未扩展。
- [x] WP6：解析覆盖率报告加入趋势性保护线（覆盖率>=60%、残留<=4650）与确定性残留分类Top输出，避免低阈值掩盖大面积退化
- [x] WP6 final automation polish：酷豹「交易」需弃1手牌再抽2且失败不标记使用；顶尖捕捉器按对手换位后己方换位的必需顺序执行并回滚取消/缺目标；神奇糖果禁止自己的最初回合且必需失败不消耗
- [x] WP7：弃牌区附能解析扩展，支持从自己的弃牌区选择/抽出精确或最多N张带引号/不带引号的能量卡，并附于单一己方出战/备战/任意宝可梦；复用既有执行器按能量与目标属性过滤
- [x] WP8：return_to_hand按with_attachments真实回收当前模型可表示的附加能量/道具，收窄回手解析避免把“非宝可梦卡丢弃”误当成附加卡回手
- [x] WP9：Pokemon Tool新附着保存精确手牌卡id并保持日志/失败提示可读；discard_field_attachments与return_to_hand(with_attachments)按精确id移动对象道具，兼容旧字符串道具。
- [x] WP1：补齐高频训练家/物品窄口径效果：上回合己方宝可梦被击倒前提、手牌弃牌费用、HP上限/规则盒排除的基础宝可梦检索、弃牌区火能附着、抽到指定手牌数与弃牌区宝可梦/基本能量回牌库洗牌。
- [x] WP3 Skeledirge deck core：骨纹巨声鳄ex「爆热高歌」改为主动特性，需从手牌丢弃基本【火】能量后才获得本回合己方招式+60，避免旧的无费用被动+60；小陨星「重力冲撞」按对手撤退费用动态伤害；虫甲圣「球形盾牌」保护己方备战免受对手招式伤害/效果且「精神强念」按对手出战能量增伤；吉雉鸡ex「扭转乾坤」复用既有上个对手回合己方KO历史并加名字级本回合一次限制，「残酷箭」可选对手出战或备战。
- [x] WP4 Tool core：真实道具解析覆盖大气球/幸存锻炼器/超群眼镜；幸存锻炼器在满HP出战宝可梦受到直接招式致命伤害时保留10HP并丢弃精确道具；超群眼镜当前按宝可梦道具附加，不额外改写伤害。
- [x] WP5 preset safe fixes：扒手猫「乱抓」按正面次数×10执行且兼容单硬币damage参数；几何雪花「快速冻凝」麻痹仅在后攻玩家最初回合生效；梅洛可本地“必须在上个对手的回合自己的宝可梦【昏厥】了才可使用”前提解析为既有KO门槛。

## 当前限制
- [ ] 规则不是完整PTCG实现：弱点/抵抗力、烧伤、睡眠恢复、攻击效果顺序与伤害来源仍为简化模型；超群眼镜暂未实现“攻击弱点时+30”等伤害修正，仅作为可附加宝可梦道具保留在场；本轮未根据缺失本地数据发明额外效果。
- [ ] 能力/特性层规则仍是窄模式实现，复杂触发时点、once-per-game、VSTAR/GX、完整能力层/来源处理等未完整支持；吉雉鸡ex「扭转乾坤」当前使用既有KO历史近似“上个对手回合自己的宝可梦昏厥”，尚不能区分是否严格由招式伤害造成。
- [ ] 特殊能量部分标记（回收、回合末弃置等）已解析但未接入所有弃置/回合末路径；幸存锻炼器为窄实现，仅覆盖满HP出战位受到直接招式伤害而即将气绝的场景，不覆盖伤害指示物、招式效果备战伤害或其他非直接伤害路径。
- [ ] 目标/卡牌/能量选择已部分泛化，但仍有部分效果保留自动选择或简化fallback；optional与max-count语义仍主要依赖picker空选择/取消/数量限制，并非完整规则级可选动作系统
- [ ] 卡牌过滤依赖结构化元数据、分类标签与启发式文本标签，不是完整自然语言规则解析；缺失元数据时仍可能走安全ID fallback；完整牌组合法性/构筑规则仍属未来工作
- [ ] trainer_prerequisite已执行discard_cost、first_turn、opponent_prizes_at_most、own_prizes_more_than_opponent、上个对手回合己方宝可梦KO等高置信前置，并将先攻首回合支援者例外作为规则例外处理；其他未结构化condition仍主要作为metadata/no-op保留，未纳入统一规则执行
- [ ] 训练家事务边界只覆盖useTrainer在前置合法性/费用之后的训练家消耗与效果执行；未扩展到攻击/特性/竞技场激活或完整全引擎事务，也不把未实现/no-op效果一概视为失败
- [ ] 竞技场已支持上场、共享状态和每回合激活入口，但激活效果仍是最小实现，持续效果/离场触发/复杂替换规则未完整接入
- [ ] 对手AI能完成基础回合推进，但仍是简单自动策略，缺少高级换位、资源规划和复杂效果选择
- [ ] 完整卡牌详情、UI动画、音效仍待完善

## 最新测试基线
- 2026-06-22 WP6 final polish验证：`node --check`（EffectParser.js、EffectExecutor.js、BattleEngine.js）与 `npm --prefix E:/BetaSerpentis.github.io run test:ptcg-battle` 全部通过。
- 自动化基线：全部 ptcgBattle 自动化测试通过；解析覆盖率 4631/7208 (64%)，仍有残留文本 4342；残留Top7为复杂/多分支 1649、未知/其他 820、选择/交换/回收 796、前提/条件 475、能量移动 359、牌库顶/牌库操作 212、化石 31。

## PM浏览器复测清单
1. Setup流程：进入对局后应先显示手牌卡牌界面；选择基础宝可梦并在卡牌界面确认；无基础手牌/对手mulligan时不应卡死；confirm失败应有可见反馈。
2. 日志/渲染稳定性：重复setup、自动setup、sprite缺失牌面不应触发RangeError；日志应截断在受控长度内。
3. 先攻首回合规则：先攻玩家第一回合尝试使用支援者与攻击都应被禁止并显示失败/no-op日志；后续回合恢复正常。
4. 检索/查看过滤：宝可装置、宝可齿轮只展示/保留支援者；巢穴球只可从牌库选基础宝可梦并真实放到备战；search_deck_to_bench与peek_and_keep候选不应混入非法类别。
5. 道具/宝可梦道具/竞技场：Pokemon Tool只按道具流程处理；竞技场打出时不立即执行激活效果；替换竞技场时旧竞技场进owner正确的弃牌区。
6. 竞技场激活：当前竞技场有可见激活入口；双方各自每回合最多激活一次；回合切换后次数重置。
7. 对手回合推进：玩家攻击结束后对手AI应能行动、攻击/结束并回到玩家回合，不能停在对手回合无响应。
8. 杜娟/水莲的照顾：杜娟只在奖赏落后条件满足时执行非对称洗手重抽；水莲的照顾只显示/回收符合条件的弃牌区目标。
9. 假成功反馈：无合法目标、选择取消、非法使用时不应消耗卡或显示成功，应有明确失败/no-op日志。

## 下一步建议
- [ ] 优先进行手机/浏览器手动复测，确认WP6自动化路径在实际UI中没有目标选择、取消、卡牌消耗与日志显示异常
- [ ] 继续迁移剩余自动选目标/选卡效果到统一picker，并补齐optional/max-count动作的规则级表达与测试
- [ ] 扩展trainer_prerequisite执行范围，优先覆盖高频前置条件（如特定场面/对象/次数限制），避免把metadata误当已执行规则
- [x] WP3训练家轻量事务/回滚边界已覆盖必需选卡取消、必需宝可梦无目标和必需效果失败；后续只在发现具体卡牌需求时扩展更多必需效果信号
- [ ] 扩展竞技场效果模型，从最小激活入口推进到持续效果、离场触发与完整替换规则

## AI 对手（P0，2026-09-19）

### 已完成
- [x] 合法动作枚举 `ActionSpace.getLegalActions(gs, resolver, player)`：布置/附能/进化/训练家/特性/竞技场/撤退/攻击/推进阶段/结束回合，并给攻击标注事实（伤害、能否 KO、几奖赏）与附能解锁的招式
- [x] 启发式策略 `AiPolicy.HeuristicPolicy`：打分式取舍（优先 KO 与高伤害、先做完善准备动作再攻击、濒危才撤退）+ `choosePick`/`choosePokemonPick` 选择应答（遵守 `derivePickBounds` 边界）
- [x] 修掉「AI 回合遇效果内选择永久挂起」：`GameState.waitForPick`/`waitForPokemonPick` 支持策略路由（`aiPickHandler`/`aiPokemonPickHandler`）
- [x] `BattleEngine._aiTurn` 重写为「逐动作循环 + 间隔播放」：每轮重新枚举 → 选一个 → 执行 → 停顿（默认 850ms）→ 下一轮；新增 `_applyAiAction` 统一执行路径、失败动作去重、无变化检测（防死循环）、`runAiTurn()` 供测试
- [x] 动作可见性：main.js 逐个播报「对手：<动作>」并刷新，AI 思考时显示「对手思考中…」
- [x] 模型名修正：`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停止服务 → 统一为 `deepseek-flash`，并自动迁移 localStorage 遗留名
- [x] 测试：新增 3 条用例（动作枚举 / 选择边界 / 整局自动对战），固定随机种子，连续 4 次全通过

### 实测（内置卡组自动对战）
- 对手动作统计：附能×8、训练家×28、攻击×10、竞技场×7、进化×2、撤退×1；20 回合分出胜负
- 使用「巢穴球」「宝可装置3.0」「老大的指令」等需要选牌/选目标的卡均正常完成（验证挂起已修复）

### 待办
- [ ] P1：AI 设置 UI（启用开关 / 是否用 LLM / 模型名 / 难度）+ 动作播放节奏可调
- [ ] P2：`StateSerializer` + `LlmPolicy`（deepseek-flash，关闭 thinking 模式）+ 三道闸校验 + 超时回退启发式
- [ ] 策略细化：训练家前置条件判断（避免打出无有效目标的卡）、能量长期规划、硬币分支期望值

## 本次修复与 P2 混合 AI（2026-09-19）

### 修复项
- [x] 战斗日志可拖动回看：`#battle-log` 限高 40vh + `overflow-y:auto` + 鼠标拖拽滚动；保留行数 6 → 200；用户上翻查看历史时不强行拉回底部
- [x] 对手动作间隔 850ms → 2000ms（看得更清楚）
- [x] 「夜间担架」回收三类根因（用户报告）：
  1. 解析 filter 残留数量词（`宝可梦或1张基本能量`）→ 修正则捕获 + `_cardMatchesFilter` 兜底清理 `\d+张`
  2. `GameState.useTrainer` 把**卡名**推进弃牌区（应为卡牌 ID）→ 回收后手牌是卡名，UI 显示「未知」
  3. 弃能量时把**能量对象**推进弃牌区 → 新增 `toCardRef()` 统一规范化为 ID；`recover_from_discard` 取出时再规范一次
  - 另：回收类效果「弃牌区没有合法目标时不得发动」（抛必需失败 → 训练家事务回滚），不再「白用一张卡」
  - 顺手修：`_isPokemonCard` 对未解析的中文卡名不再默认当作宝可梦（否则弃牌区卡名会被当成合法目标）
- [x] 启发式枚举不再产出「付不起丢弃费用」的训练家动作（`discardCostFeasible`，修掉 AI 反复尝试并刷屏日志）

### P2：混合 AI（默认模式，无需开关）
- [x] 新增 `js/core/StateSerializer.js`：视角隔离（只看得到自己手牌；对手手牌/双方牌库/奖赏卡只给数量）+ ≤1.2k tokens 紧凑文本 + 候选动作事实清单
- [x] `LlmPolicy`（`AiPolicy.js`）：**启发式算数 + LLM 取舍**
  - 只在关键决策点问模型（攻击/训练家/特性/撤退/进化，且候选 ≥2）
  - 每回合最多 2 次模型调用（`maxLlmCallsPerTurn`），其余动作走启发式
  - 关闭 thinking 模式（`thinking.type=disabled`）压低延迟
  - 三道闸：① 输出可解析 ② id 在候选集合内 ③ 执行层再校验；失败回退启发式并冷却 60s（避免每个动作都白等超时）
  - 无 API Key 时完全等同纯启发式（零额外开销）
- [x] `BattleEngine` 默认 `aiMode: 'hybrid'`；`aiAutoplayDelayMs` 可配置（<0 表示禁用自动触发，供批量测试）
- [x] 模型名：`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停服 → `deepseek-flash`（含 localStorage 遗留名自动迁移）
- 实测：整局 16 回合，模型参与 14 次决策（全部采纳），无异常/无挂起

### 测试
- 新增/更新用例：动作枚举、选择边界、整局自动对战（同时模拟模型参与）、LLM 三道闸与降级、夜间担架回收语义、弃牌区存卡牌 ID（17 处旧断言随行为修正）
- 全绿：`test:ptcg-battle` 全通过（连续 3 次稳定）、`test:ptcg-query` 26/26、`ptcg:check-syntax` 42/42
