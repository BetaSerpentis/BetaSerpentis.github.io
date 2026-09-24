# PTCG 效果建模审计：假建模 / 静默归零清单（usage_condition 无人读取专项）

## 背景
审计目的：找出「假建模 / 静默归零」——即**解析端记了标记、但引擎端没有任何代码读它**的效果。方法：枚举 `ptcg/data_fast/effects.tsv` 里全部 `usage_condition` 行，取其 `kind`，再在 js/core/GameState.js、EffectExecutor.js、BattleEngine.js、js/main.js 里搜索该 kind 字符串；四者都没有的即「无人读」。

背景：本会话已发现两例同类问题（都会让玩家以为效果生效、实际什么都没发生）：
- `__zero`：catch-all 把一切伤害计数映射成恒为 0 的占位符（126 行，已修 39da8aa2）
- `conditional_damage_mod` 缺兜底：没有 condition 的项恒加 0（`bonus_damage_optional` 是假标记，伤害从未加上，已修 8f494ff5）

## 相关代码
- 暂无。

## 相关文档
- ptcg/ROADMAP.md

## 当前结论
- 全库 usage_condition 共 4869 行 / 155 种 kind；其中 141 种 / 4571 行在四个引擎文件里都搜不到被读取
- 这 141 种里，最大的一族是「使用次数限制」：once_per_turn 735 行、gx_once_per_game 493 行、any_times_own_turn 65 行、vstar_power_once 53 行、vstar_usage_note 29 行
- 经核验：once_per_turn / any_times_own_turn 等**已被别处强制**（GameState 的 abilityUsedThisTurn 与 CardResolver 的 oncePerTurn 双重），属于冗余标记，不是缺口
- 但 gx_once_per_game（493 行 / 490 卡）与 vstar_power_once（53 行）**确认是真缺口**：卡面写「[对战中，己方的GX招式只能使用1次。]」，引擎此前没有任何 GX/VSTAR 次数校验 → 同一局能用出多个 GX 招式。本轮已修（按招式名后缀 GX/VSTAR 识别 + canUseAttack 置灰 + BattleEngine 拦截 + 成功后打标记）
- 另外一批是**说明性注记**，不产生状态变化属于设计如此：residual_sentence 1442、generic_effect 436、shell_fragment 380（这三个本身就是「未建模」标记）、put_remaining_back 166、no_stack_note 30、energy_supply_desc 29、*_note / *_desc / *_persist / *_rule 等
- 去掉上述三类后，**真正「该生效却没接线」的缺口约 956 行 / 133 种**（其中约 700~800 行是明确的真实效果）
- 高频缺口（按行数）：evolve_from_this_from_deck 42（从牌库选进化卡直接进化）、coin_fail_attack_next 39（下个对手回合其招式掷硬币出现反面则失败）、attachments_to_discard 32、return_self_deck_all 24 + return_self_deck_opt 17 + return_self_deck_with_cards 3（自身与身上卡牌回牌库）、ko_next_opp_end 22（下个对手回合结束时昏厥）、place_self_to_bench 19（卡牌自身放置到备战区）、draw_matching_opponent_field_count 18（按对手场上数量抽牌）、move_copy 17 + select_opponent_move 16 + opp_choose_move_copy 4（复制对手招式）
- 次级缺口：extra_turn_vstar 16（回合结束后再开始 1 次自己的回合）、hand_to_deck_like_opp 12、only_single_hand_card 11、evolve_move_inherit 10（进化后仍可用进化前招式）、玩偶族 doll_discard 10 + doll_wide_first 9 + doll_passive 7 + doll_as_pokemon 5、self_counters_damage 8、search_by_coin_heads 7 + coin_heads_draw_any 6（按硬币正面数检索）、peek_opp_top_back 7、fail_unless_from_bench 7、attack_from_bench_allowed 5、bonus_damage_extra_energy 5、mirror_last_damage_taken 5、block_* 家族（block_attach_energy_next 5 / block_special_attach_next 3 / block_special_stadium_next 4 / block_prizes_next 3 / block_supporter_next 1）
- 还有 ~90 种 ×1~4 行的单例缺口（immune_gx_attacks 4、both_immune_trainer 5、bench_basic_immune_supporter 4、instant_win_at_prize 4、prize_hand_swap 4、revive_self_from_discard 2、guess_game 2、quiz_game 1 等）
- 值得注意的规律：缺口集中在**几类结构性机制**上——进化相关、招式复制、免疫/封锁（block_*）、玩偶（doll_*）、自身回牌库、延迟昏厥、额外回合。这些是「一个机制、多张卡」的形态，修一个机制能一次覆盖多行
- 另一条规律：这些缺口里的效果**大多是「持续/延迟/被动」类**，而现有引擎的强项是「即时动作」——说明被动与延迟状态的建模是当前的系统性薄弱面

## 方案对比
- 方案 A：逐个 kind 修（散点推进）—— 每条都要动解析+执行两端，碎片化且容易遗漏同类
- 方案 B（推荐）：按**机制族**修 —— 先补引擎能力（如「从牌库进化」「延迟昏厥」「招式复制」），再一次性把该族的 kind 接上；每族一个提交、一份测试
- 方案 C：先只修高频（>=18 行）的 8 个 kind，其余留作长尾

## 推荐方案
采用方案 B（按机制族修），并先把审计脚本固化进 tools/ 作为回归门禁。理由：缺口高度集中在「一个机制、多张卡」的形态（进化、招式复制、封锁、玩偶、延迟昏厥等），按族修一次能覆盖多行；同时固化脚本能防止修完后又出现新的假建模。

## 风险与边界
- 部分 kind 可能确实已在别处强制（如 once_per_turn 走 abilityUsedThisTurn）：修复前必须先核验，否则会重复实现
- 「说明性注记」与「真缺口」的边界需要人工判断，仅凭「有没有字符串读取方」会误判
- 延迟/被动类机制（额外回合、延迟昏厥、封锁）改动面较大，需要配套的回合流转测试，风险高于即时动作
- extra_turn_vstar（额外回合）会改变回合流转基本假设，AI 与阶段状态机都要复查

## 验证方式
- 按「一个机制覆盖多张卡」的优先级修缺口：① 进化机制（evolve_from_this_from_deck 42 + evolve_from_any_field_pokemon 6 + evolve_move_inherit 10 = 58 行）② coin_fail_attack_next 39 ③ attachments_to_discard 32 ④ 自身回牌库族 44 ⑤ ko_next_opp_end 22 ⑥ 玩偶族 31 + place_self_to_bench 19 ⑦ 复制对手招式族 37 ⑧ 延迟封锁 block_* 族 16 ⑨ extra_turn_vstar 16 ⑩ 按硬币正面数检索族 13
- 每修一个机制后重新跑本审计脚本，确认该 kind 从「无人读」列表消失（把审计脚本固化成 tools/audit-inert-markers.mjs，纳入 npm scripts）
- 把「解析端新增某个 usage_condition kind 时，必须同时接上读取方或明确标注为说明性注记」写成规范，避免继续产生假建模
- 保留一份「说明性注记」白名单在审计脚本里，避免每次都要人工重新判断
