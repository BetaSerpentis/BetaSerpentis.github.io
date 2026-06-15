# ptcgBattle 开发进度

## 文件结构
```
ptcgBattle/
├── index.html              # 主界面（Canvas场地 + 4按钮 + 日志）
├── style.css               # FRLG像素风界面 + 弹窗样式
├── PROGRESS.md             # 本文件
└── js/
    ├── main.js             # 主入口 + UI流程
    ├── core/
    │   ├── GameState.js    # 状态管理（能量/进化/训练家/选择等待）
    │   ├── BattleEngine.js # 回合/攻击/能力引擎 + AI
    │   ├── CardResolver.js # 卡牌ID→全量数据编译
    │   ├── EffectParser.js # 效果文本→指令
    │   └── EffectExecutor.js # 异步指令执行 + 目标/卡牌/能量选择
    ├── ui/
    │   ├── BattleField.js  # Canvas渲染 + 点击检测
    │   ├── CardView.js     # 卡牌列表/卡牌DOM
    │   └── CardPicker.js   # 选卡弹窗
    └── data/
        └── decks.js        # 测试卡组
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
- [x] WP2：扩展训练家前置条件正式校验，覆盖first_turn（含后攻玩家最初回合）、opponent_prizes_at_most、own_prizes_more_than_opponent，并区分先攻首回合支援者例外；非法时不消耗卡牌/费用或使用标记
- [x] WP3：为useTrainer增加最小事务边界，required picker/目标失败时回滚训练家消耗、费用、使用标记和相关场上状态，并修复回滚后竞技场owner/共享对象身份
- [x] WP4：switch_pokemon支持解析出的choose:'opponent'语义；目标方为玩家时走现有宝可梦选择器，AI/no-UI对手选择时确定性选择首个可用备战位
- [x] WP5：manipulate_deck_top窄口径执行支持；覆盖查看牌库顶原样放回、可选丢弃/置底/洗牌、匹配物品丢弃、选择置顶其余置底与任意顺序原序fallback；lost_zone/fossil_place仍未扩展。

## 当前限制
- [ ] 规则不是完整PTCG实现：弱点/抵抗力、烧伤、睡眠恢复、攻击效果顺序仍为简化模型
- [ ] 能力/特性层规则仍是窄模式实现，复杂触发时点、once-per-game、VSTAR/GX等未完整支持
- [ ] 特殊能量部分标记（回收、回合末弃置等）已解析但未接入所有弃置/回合末路径
- [ ] 目标/卡牌/能量选择已部分泛化，但仍有部分效果保留自动选择或简化fallback；optional与max-count语义仍主要依赖picker空选择/取消/数量限制，并非完整规则级可选动作系统
- [ ] 卡牌过滤依赖结构化元数据、分类标签与启发式文本标签，不是完整自然语言规则解析；缺失元数据时仍可能走安全ID fallback
- [ ] trainer_prerequisite已执行discard_cost、first_turn、opponent_prizes_at_most、own_prizes_more_than_opponent等高置信前置，并将先攻首回合支援者例外作为规则例外处理；其他未结构化condition仍主要作为metadata/no-op保留，未纳入统一规则执行
- [ ] 训练家事务边界只覆盖useTrainer在前置合法性/费用之后的训练家消耗与效果执行；未扩展到攻击/特性/竞技场激活或完整全引擎事务，也不把未实现/no-op效果一概视为失败
- [ ] 竞技场已支持上场、共享状态和每回合激活入口，但激活效果仍是最小实现，持续效果/离场触发/复杂替换规则未完整接入
- [ ] 对手AI能完成基础回合推进，但仍是简单自动策略，缺少高级换位、资源规划和复杂效果选择
- [ ] 完整卡牌详情、UI动画、音效仍待完善

## 最新测试基线
- `npm --prefix e:/BetaSerpentis.github.io run test:ptcg-battle`：全部自动化测试通过（2026-06-15，Work Package 5：manipulate_deck_top executor support）。
- 解析覆盖率：4518/7208（63%）；仍有残留文本：4499。当前残留集中在复杂/多分支道具、化石类、未结构化前提文本与未完全映射的选择/交换/回收效果。

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
- [ ] 继续迁移剩余自动选目标/选卡效果到统一picker，并补齐optional/max-count动作的规则级表达与测试
- [ ] 扩展trainer_prerequisite执行范围，优先覆盖高频前置条件（如特定场面/对象/次数限制），避免把metadata误当已执行规则
- [x] WP3训练家轻量事务/回滚边界已覆盖必需选卡取消、必需宝可梦无目标和必需效果失败；后续只在发现具体卡牌需求时扩展更多必需效果信号
- [ ] 扩展竞技场效果模型，从最小激活入口推进到持续效果、离场触发与完整替换规则
