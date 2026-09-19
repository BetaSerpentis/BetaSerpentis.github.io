# PTCG 战斗对手接入 LLM（DeepSeek v4.1 flash）可行性评估

## 背景
## 一句话结论

**真正的工作量不在「调用 LLM」，而在三件缺失的基础设施**：合法动作枚举、效果执行中的异步选择路由、状态序列化。API 层（Key/模型/流式/工具调用）已经现成可复用。建议路线：P0 补齐三件套 + 启发式对手（不依赖 LLM 也能完整对局）→ P1 AI 配置 UI → P2 LLM 策略层（function calling + 校验 + 回退）。

## 一、现状盘点（代码事实）

### 1.1 现有「对手 AI」是木桩

`ptcg/battle/js/core/BattleEngine.js` 的 `_aiTurn()`：

- `MAX_AI_ACTIONS = 3`，流程写死：`DRAW` → `MAIN`（只 setPhase，不做任何出牌）→ `BATTLE`（调 `_firstLegalAttackIndex()` 取**第一个**能量够的招式）→ 失败就 `_passAiTurn()`
- **完全不使用**：手牌出牌、进化、附能、训练家、特性、撤退、竞技场、奖赏卡策略
- 即：目前对手 ≈「只会普攻的木桩」

### 1.2 动作原语已经齐全（人类侧在用，AI 可直接复用）

| 原语 | 签名 |
|---|---|
| 布置 | `placeActivePokemon(handIndex, cardData)` / `placeBenchPokemon` / `confirmSetup()` / `mulliganPlayer(pl)` |
| 附能 | `attachEnergy(handIndex, cardData, targetSlot)`，`targetSlot = 'active' \| 'bench-N'` |
| 进化 | `evolvePokemon(handIndex, cardData, targetSlot)` |
| 训练家 | `useTrainer(handIndex, cardData, targetSlot)` |
| 特性 | `useAbility(source, ability, { zone })` |
| 竞技场 | `activateStadium(player)` |
| 撤退 | `gs.retreat(pl, benchIndex, selectedEnergyIndices)` |
| 攻击/推进 | `attack(attackIndex)` / `advancePhase()` |

### 1.3 合法性判定已存在（可用来构建动作枚举器）

`GameState` 已有：`canUseTrainer(pl, cd, targetSlot)`、`canUseAbility(pl, source, ability, zone)`、`canActivateStadium(pl)`、`checkEnergy(mon, ai)`、`effectiveRetreatCost(mon)`、`_canPayRetreatCost`、`inferAbilityZone`、`isAbilityDisabled`。

**但没有任何「合法动作枚举」函数**（`grep getLegalActions\|legalActions\|enumerateActions` → 无结果）。

### 1.4 API 层现成（可直接复用）

| 模块 | 作用 |
|---|---|
| `ptcg/js/utils/constants.js` → `CONFIG_AI` | `model:'deepseek-chat'`、`apiEndpoint:'https://api.deepseek.com/v1/chat/completions'`、`maxTokens`、`maxHistoryMessages` |
| `ptcg/js/core/ApiKeyManager.js` | localStorage：`ptcg_ai_api_key` / `ptcg_ai_settings`（含 `model` 覆盖） |
| `ptcg/js/services/AIChatService.js`（884 行） | tools/function-calling、SSE 流式、`_fetchWithRetry`、历史裁剪（最近 8 条）、Agent 循环（`MAX_LOOPS 8`） |
| `ptcg/battle/js/core/AiSettings.js` | battle 侧**共用同一 key/settings**：`getAiApiKey()` / `getAiSettings()` / `onAiKeyChange()` / `describeAiStatus()` |
| `ptcg/js/services/SearchIntentParser.js` | **LLM → JSON + 白名单校验**范式：`extractJson()` + `sanitizeConditions()` —— 正是「LLM 输出动作 → 校验 → 执行」的模板 |

对手卡组来源：`ptcg/battle/js/core/DeckSource.js`（localStorage `ptcg_decks`，缺省回退内置 `TEST_DECKS`）。

## 二、三个阻塞性缺口（必须先修，否则 LLM 接不上）

### 缺口 1：AI 回合遇到「效果内选择」会永久挂起 ⚠️

`GameState.waitForPick()` / `waitForPokemonPick()` 返回 Promise，回调只服务玩家 UI：

```js
// GameState.js:30-31
waitForPick(cards,count,options={}){ ... this._onPendingPick?.(this.pendingPick); }
// main.js:131-132
this.gs._onPendingPick = pick => this._handlePick(pick);   // → _showPickCards(pick) 弹玩家 UI
```

`EffectExecutor.js` 中有 **10+ 处** `await gs.waitForPick(...)`（`source` 覆盖：`attack`、`peek`、`attached-energy`、`hand-discard`、`discard-energy`、`manipulate-deck-top-*`、`rare-candy-evolution-card`、`prize-deck-top-swap`、`hikers-shoes`、`hand-pokemon-return` 等）。

后果：AI 的 `attack()` / `useTrainer()` 若触发这类效果，`await` 永不 resolve → **回合卡死**；同时玩家会看到「替对手选牌」的错误 UI。

→ 必须引入**决策者路由（DecisionRouter）**：玩家 → UI；AI → `AiPolicy.choose(pick)`。

### 缺口 2：没有合法动作枚举（`getLegalActions`）

LLM 必须**只在合法集合里选**，否则幻觉动作会让引擎崩。需新增确定性枚举器，输出形如：

```
[{ id:'a1', kind:'attach_energy', handIndex:3, targetSlot:'bench-1', desc:'给 皮卡丘ex 附着 基本雷能量' }, ...]
```

### 缺口 3：没有状态序列化（prompt 契约）

需要把 `GameState` 压缩成**视角隔离**的紧凑文本/JSON（AI 只能看自己的手牌；对手手牌/双方牌库/奖赏卡只给数量），并控制在 ≤1.2k tokens 内（每行动一次调用，prompt 必须极小）。

## 三、开源方案调研（结论：没有可直接复用的 LLM+PTCG 方案，但有三条成熟路线）

### 3.1 最相关（Kaggle 官方赛事生态）

Kaggle「Pokémon TCG AI Battle Challenge」（The Pokémon Company × Matsuo Lab × HEROZ），官方引擎名为 **CABT**，生态里有大量开源提交：

| 仓库 | 价值 |
|---|---|
| `git-disl/PokeLLMon`（206⭐） | **LLM 对战 agent 方法论**：状态 grounding、知识检索注入、动作一致性校验、历史摘要（原论文 PokeLLMon: A Human-Parity Agent for Pokémon Battles with LLMs） |
| `tawdesangeeta1973-coder/ptcg-belief-mcts`（31⭐, MIT） | **Information-Set MCTS + belief policy**（处理不完全信息），含参考 simulation |
| `yijieyuan/kaggle-pokemon-tcg` | Kaggle **第 1 名**方案 |
| `squidistaken/pokemon-tcg-ai` | 银牌：behavior cloning + KL-anchored PPO self-play |
| `muran169633/ptcg-ai-battle-simulation` | 银牌：纯 JAX 规则引擎 + BC + PPO（8×A100 训练，重型） |
| `wmh/ptcg-abc`、`rahulsiiitm/ptcg-rl-agent`、`dragonbra/pokemon-tcg-ai-battle` | **rule-based agents**（轻量启发式，最贴近「快速可用」） |
| `sarwadnyjawale/...strategy` | **deterministic agent**：语义状态提取 + 动作排序 + 安全约束，**零非法动作**（与我们要做的启发式 AI 最像） |
| `Leundai/cabt-replay-viewer` | CABT replay 格式（参考观战/日志设计） |

### 3.2 其它参考

| 仓库 | 价值 |
|---|---|
| `keeshii/ryuu-play`（MIT） | PTCG 模拟器（规则实现参考） |
| `pret/poketcg` | GBC 版反汇编（老游戏 AI 逻辑） |
| `PokemonTCG/pokemon-tcg-data`、`tcgdex/cards-database` | 卡数据源 |
| LinkTokenView（聚合平台，OpenAI 兼容） | **确认 `deepseek-v4.1-flash` 已上线** |

### 3.3 路线对比

| 路线 | 代表 | 成本 | 拟人度 | 适合度 |
|---|---|---|---|---|
| A 规则/启发式 | ptcg-abc、deterministic agent | 极低（无训练） | 中 | ★★★★★ 起步必做（兜底） |
| B 搜索（IS-MCTS+belief） | ptcg-belief-mcts | 中 | 高（棋力强） | ★★★☆ 后续增强 |
| C 学习（BC+PPO） | 银牌/金牌方案 | 极高（需算力+官方引擎） | 最高 | ★☆ 不建议自研 |
| D LLM 策略层 | PokeLLMon | 低-中（按量付费） | 高（拟人/有"思路"） | ★★★★ 本次目标 |

**关键判断**：D 必须搭在 A 之上 —— LLM 负责「策略选择 + 拟人化」，A 负责「合法性 + 回退 + 兜底」。

## 四、目标架构（建议）

```
                 ┌─────────────────────────────┐
 玩家操作 ──────►│ ActionApplier（唯一执行入口）│◄────── AI 决策
                 └──────────────┬──────────────┘
                                │ waitForPick / waitForPokemonPick
                        ┌───────▼────────┐
                        │ DecisionRouter │──► 玩家 → UI 列表
                        └───────┬────────┘──► AI   → AiPolicy.choose()
                                │
              ┌─────────────────▼──────────────────┐
              │ ActionSpace.getLegalActions(gs)     │  确定性枚举 + 合法性校验
              └─────────────────┬──────────────────┘
                                │
                 ┌──────────────▼──────────────┐
                 │ AiPolicy                     │
                 ├─ HeuristicPolicy（默认/兜底） │
                 └─ LlmPolicy（DeepSeek v4.1 flash）│
                    └ StateSerializer → prompt → function call → 校验 → 回退
```

**核心原则**：LLM 只输出「动作 id（从枚举器给出的候选里选）+ 简短理由」；执行前必须过 `ActionSpace` 校验；校验失败 → 重试 1 次 → 回退启发式。随机数（硬币/洗牌）永远由引擎决定，LLM 不参与。

## 五、关键设计点

### 5.1 决策粒度（已定：按可见行动走，1 次调用/行动，目标 1s）

用户决策：**以「输出窗口能看到的行动」为粒度，每个行动 1 次 LLM 调用，暂定 1 秒**。

实现要点：

- 每次调用只解决「这一步做什么」：`ATTACH_ENERGY` / `EVOLVE` / `USE_TRAINER` / `USE_ABILITY` / `RETREAT` / `ATTACK` / `END_TURN`
- prompt 必须**极小**（建议 ≤ 1.2k tokens）：候选动作列表（含事实标注）+ 视角隔离状态摘要 + 最近 1–2 条日志
- 输出必须**极短**：只回候选 `id`（≤ 20 tokens），禁止长篇解释（可给 ≤ 20 字理由）
- 一回合调用次数 ≈ 该回合可见行动数（通常 2–6 次），成本与延迟按此估算
- 折中建议：把「连续同类且无争议」的动作（如多只宝可梦各附 1 能）合并为一次调用（候选里给出组合项），可把调用数压到 2–3 次/回合
- 效果内选择（`pendingPick`）默认启发式，仅高价值选择（奖赏卡、关键检索）才上调 LLM

### 5.2 状态序列化（视角隔离，防作弊）

- AI 只能看到：自己的手牌全文、双方场地（宝可梦/HP/能量/状态/道具）、双方牌库与奖赏卡**数量**、最近 3 回合日志
- 不能给：玩家手牌、玩家牌库内容、奖赏卡内容（AI 看不到的不给）
- token 预算 ~1.5–2k；手牌只附「卡名 + 关键效果摘要」（复用已有 `effects.tsv` / `abilities.tsv` / `attacks.tsv`，不必塞全卡表）

### 5.3 动作空间（宏动作）

`PLAY_BASIC` / `EVOLVE` / `ATTACH_ENERGY` / `USE_TRAINER` / `USE_ABILITY` / `RETREAT` / `ATTACK` / `END_TURN`，附目标 id。枚举器为每个候选生成 `id + desc`，LLM 只回 id。

### 5.4 输出约束与校验（复用现成范式）

- 首选 **function calling**（`AIChatService` 的 tools 写法已在用）；若模型/网关不支持则退化为「JSON + `extractJson` + schema 校验」
- 三道闸：① JSON 可解析 → ② id 在本次候选集合内 → ③ 引擎 `canUse*` 复检通过
- 失败重试 1 次（附错误信息）；仍失败 → `HeuristicPolicy`

### 5.5 延迟与体验（1s 目标下的策略）

- **目标 p50 ≤ 1s**：靠 ① 小 prompt ② 短输出（只回 id）③ 不渲染流式增量 ④ HTTP keep-alive 复用连接 ⑤ AI 回合开始前预热连接（发一次极小请求）
- **超时阈值**：单次调用 1.5–2s 未返回即放弃并回退启发式（节奏优先，不让玩家等）
- **降级链**：LLM 超时/报错 → 同位置启发式动作（玩家几乎无感）→ 记入日志便于排查
- 思考态：AI 回合显示「对手思考中…」，动作逐个播放（复用现有动画/日志浮层）
- 可选优化：局面指纹缓存（相同局面复用上次决策）

### 5.6 模型与端点（已定：直连）

- **已定走直连**：`CONFIG_AI.apiEndpoint = https://api.deepseek.com/v1/chat/completions` 保持不变，**无需**把 endpoint 做成可配置
- **模型名已核实（2026-09 官方文档）**：`deepseek-chat` / `deepseek-reasoner` 两个遗留名已于 **2026-07-24 停止服务**；现行模型名为 **`deepseek-flash`**（= DeepSeek-V4.1-Flash，即用户预期的那个）与 `deepseek-v4-pro`。项目常量已同步为 `deepseek-flash`，并在读取设置时自动迁移 localStorage 里的遗留名
- **thinking 模式**：默认开启且 `effort=high`（会产生大量 CoT token，拖慢响应）。战斗决策建议 `{"thinking":{"type":"disabled"}}`（或 `reasoning_effort:"none"`）；带 `tools` 时所有历史轮 `reasoning_content` 必须回传
- 预留：将来若要切聚合平台，再补 `settings.endpoint` 字段即可，不阻塞当前开发
- battle 侧设置项：启用开关 / 是否使用 LLM / 模型名 / 难度档

### 5.7 启发式 vs LLM：能力边界与分工（重要）

| 能力 | 启发式 | LLM | 结论 |
|---|---|---|---|
| 伤害/能量/KO/奖赏卡计算 | ★★★★★ | ★★☆ | **算术交给代码** |
| 规则细节（每回合限 1 次附能、弱点、抵抗、状态） | ★★★★★ | ★★☆ | 代码更可靠 |
| 铺场/附能/进化常规顺序 | ★★★★☆ | ★★★★ | 差距不大 |
| 组合技识别（跨卡配合） | ★★★☆ | ★★★★ | LLM 略优 |
| 长线规划（2–3 回合铺垫） | ★★☆ | ★★★★ | **LLM 主要优势** |
| 随机应变/创造性 | ★★☆ | ★★★★ | LLM 主要优势 |
| 延迟/成本/稳定性 | ★★★★★ | ★★☆ | 启发式完胜 |

参考：Kaggle CABT 的「零非法动作」确定性 agent 约 29.2% 胜率（120 局本地对战），说明**启发式足以「像个正常对手」**；LLM 带来的是「有想法」，而不是「不犯错」。

**推荐分工（认真打）**：启发式为每个候选**算好事实并标注**，LLM 只做取舍：

```
[候选] a3 ATTACH_ENERGY 基本雷能量 → 皮卡丘ex(战斗场)
       事实：附能后可打「十万伏特 130」，可 KO 对手当前 120HP，拿 1 奖赏；本回合附能次数用尽
[候选] a5 USE_TRAINER 博士的研究 → 弃手牌抽 7 张
[候选] a8 ATTACK 十万伏特（130 伤害，可 KO）
[候选] a9 END_TURN
```

这样既保留 LLM 的长线取舍能力，又消除它在算术与规则上的失误。

## 六、分阶段落地建议

| 阶段 | 内容 | 预估 | 产出 |
|---|---|---|---|
| **P0** | `DecisionRouter` + `ActionSpace.getLegalActions()` + `HeuristicPolicy`（会附能/进化/用训练家/特性/撤退/择优攻击） | 1–2 天 | AI 不依赖 LLM 也能完整对战、不挂起 |
| **P1** | AI 设置 UI（开关/模型/难度）、思考态提示、对手动作逐个播放 | 0.5–1 天 | 可交互体验 |
| **P2** | `StateSerializer`（视角隔离、≤1.2k tokens）+ `LlmPolicy`（每可见行动 1 次调用、1s 超时回退、function calling）+ 三道闸校验 + **候选事实标注**（伤害/KO/奖赏/剩余能量） | 2–3 天 | LLM 对手可用 |
| **P3** | 增强：知识注入（复用 `data/knowledge/rulings.md` + `effects.tsv`，PokeLLMon 式）、难度档位、观战日志、IS-MCTS 试点 | 按需 | 更聪明/更拟人 |

## 七、风险

1. **幻觉/非法动作**：必须校验+回退；否则引擎异常。风险可控（三道闸）
2. **不完全信息**：若把玩家手牌/牌库喂给 LLM，等于 AI 作弊 → 必须视角隔离
3. **延迟（1s 目标偏紧）**：flash 级模型单次往返通常 0.8–2.5s，1s 是 p50 目标而非保证；靠小 prompt + 短输出 + 连接预热缓解，超 1.5–2s 一律回退启发式
4. **成本（按行动计费）**：每回合 2–6 次调用 × 长对局，成本高于「每回合 1 次」方案；缓解：合并无争议的连续动作、局面指纹缓存、必要时降为「仅关键决策用 LLM」
5. **`pendingPick` 语义复杂**：10+ 处、含 `allowFewer`/`allowEmpty`/`optional`/`filter` → 启发式需按 `source` 分类实现，是 P0 的主要工作量
6. **执行层仍有未实现效果**：`ROADMAP.md` 记载「持续被动/限制 544」类未接入，AI 决策可能遇到「解析了但没执行」的效果 → 观感问题（与 LLM 无关，但会被放大）
7. **模型名**：`deepseek-v4.1-flash` 见于第三方聚合平台；直连 DeepSeek 官方时需用官方模型名（常量当前为 `deepseek-chat`），通过 `settings.model` 可切换；若 API 不认该模型名会报错 → 设置里需做可用性校验与回退

## 八、验收方式（建议）

1. **无 LLM 可完赛**：启发式 AI 完成整局，无异常、无挂起
2. **零非法动作**：批量自动对战（扩展 `ptcg/battle/tests/automation.mjs`）中 AI 动作 100% 通过引擎校验
3. **零挂起**：AI 回合触发 `pendingPick` 场景（招式选择、检索、弃牌等）均有决策返回
4. **延迟**：每个可见行动的决策 p50 ≤ 1s、p95 ≤ 3s；超过 2s 必须已回退启发式（不阻塞节奏）
5. **拟人度主观验收**：能完成"布置→铺场→附能→进化→攻击/撤退"的连贯操作，而非只普攻

## 九、结论与建议

**已确认决策**（2026-09-19 用户确认）：

1. 接入方式：**直连** `api.deepseek.com`（endpoint 无需改造）
2. AI 风格：**认真打**（强度优先，需启发式算好伤害/KO/奖赏事实，LLM 做取舍）
3. 决策粒度：**按可见行动走，每个行动 1 次调用，目标 1s**（超时回退启发式）
4. 能力分工：**启发式算数 + LLM 取舍** —— 不追求让 LLM 做算术

- **推荐**：先做 **P0（启发式 + 三件套基础设施）**，这一步本身就能把对手从「木桩」变成「会打牌的对手」，且是 LLM 的前提；再上 **P2 LLM 策略层** 提升「有想法」的程度。
- **不建议**：直接端到端让 LLM 从原始状态「直接输出动作」——没有枚举器与校验，稳定性和成本都不可控；也不建议让 LLM 承担伤害计算。
- **可选增强**：IS-MCTS（路线 B）作为「高难度 AI」，无需外部 API、延迟可控，适合做难度档位。


## 相关代码
- ptcg/battle/js/core/BattleEngine.js（_aiTurn/_firstLegalAttackIndex/_passAiTurn/attack/useTrainer/useAbility/attachEnergy/evolvePokemon）
- ptcg/battle/js/core/GameState.js（waitForPick:30 / waitForPokemonPick:31 / _onPendingPick:30 / canUseTrainer:239 / canUseAbility:375 / canActivateStadium:347 / checkEnergy:117 / effectiveRetreatCost:174 / retreat:212）
- ptcg/battle/js/core/EffectExecutor.js（10+ 处 await gs.waitForPick）
- ptcg/battle/js/main.js（_onPendingPick 注册:131 / _handlePick:383 / _handlePokemonPick:388 / _updateMainMenu:动作面板 / _afterAction:1065）
- ptcg/battle/js/core/AiSettings.js（getAiApiKey/getAiSettings/onAiKeyChange/describeAiStatus/AI_STORAGE_KEYS）
- ptcg/battle/js/core/DeckSource.js（loadDecks/PTCG_DECKS_STORAGE_KEY）
- ptcg/battle/js/core/CardResolver.js（getCard）
- ptcg/js/utils/constants.js（CONFIG_AI:66-70）
- ptcg/js/core/ApiKeyManager.js
- ptcg/js/services/AIChatService.js（sendMessage:733 / _fetchWithRetry:688 / _getTools:57）
- ptcg/js/services/SearchIntentParser.js（extractJson:121 / sanitizeConditions:61 / parse:151）
- ptcg/battle/tests/automation.mjs（可用作批量自动对战验收基础）

## 相关文档
- ptcg/battle/ROADMAP.md
- ptcg/battle/PROGRESS.md
- ptcg/battle/MERGE-NOTES.md
- ptcg/battle/UI-OPERATION-PLAN.md
- ptcg/data/knowledge/rulings.md
- ptcg/data_fast/effects.tsv
- ptcg/data_fast/abilities.tsv
- ptcg/data_fast/attacks.tsv

## 当前结论
- 现有对手 AI 是木桩：BattleEngine._aiTurn 只有 DRAW→MAIN→BATTLE 三步（MAX_AI_ACTIONS=3），MAIN 阶段不出牌，BATTLE 阶段取第一个能量足够的招式（_firstLegalAttackIndex），不使用手牌/进化/附能/训练家/特性/撤退/竞技场
- 动作原语齐全可复用：placeActivePokemon/placeBenchPokemon/confirmSetup/mulliganPlayer/attachEnergy/evolvePokemon/useTrainer/useAbility/activateStadium/gs.retreat/attack/advancePhase
- 合法性判定函数已存在，足以构建枚举器：canUseTrainer/canUseAbility/canActivateStadium/checkEnergy/effectiveRetreatCost/_canPayRetreatCost/inferAbilityZone/isAbilityDisabled
- 阻塞缺口1：AI 回合遇到效果内选择会永久挂起。waitForPick/waitForPokemonPick 的 Promise 回调只服务玩家 UI（main.js:131-132 → _handlePick → _showPickCards），EffectExecutor 中有 10+ 处 await gs.waitForPick（source 覆盖 attack/peek/attached-energy/hand-discard/discard-energy/manipulate-deck-top-*/rare-candy/prize-deck-top-swap/hikers-shoes 等）
- 阻塞缺口2：没有任何合法动作枚举函数（grep getLegalActions/legalActions/enumerateActions 无结果），LLM 无法安全地只在合法集合内选择
- 阻塞缺口3：没有状态序列化层，需要新增视角隔离（AI 只能看自己手牌，对手手牌/双方牌库/奖赏卡只给数量）且控制在 ≤1.2k tokens（每行动一次调用，prompt 必须极小）
- API 层已现成：CONFIG_AI（model:'deepseek-chat'、apiEndpoint 硬编码 api.deepseek.com、maxTokens）、ApiKeyManager（localStorage ptcg_ai_api_key / ptcg_ai_settings 含 model 覆盖）、AIChatService（884 行，tools/function-calling、SSE 流式、_fetchWithRetry、历史裁剪）、battle 侧 AiSettings.js 共用同一 key/settings
- SearchIntentParser 提供现成的「LLM→JSON+白名单校验」范式（extractJson + sanitizeConditions），可直接改造为「LLM→动作+校验」模板
- 对手卡组来源为 DeckSource（localStorage ptcg_decks + 内置 TEST_DECKS 回退）
- 开源生态：Kaggle「Pokémon TCG AI Battle Challenge」官方引擎为 CABT，生态含第 1 名（yijieyuan/kaggle-pokemon-tcg）、银牌（squidistaken/pokemon-tcg-ai、muran169633/ptcg-ai-battle-simulation）、信息集 MCTS（tawdesangeeta1973-coder/ptcg-belief-mcts）、rule-based（wmh/ptcg-abc、rahulsiiitm/ptcg-rl-agent）、零非法动作的确定性 agent（sarwadnyjawale/...strategy）
- LLM 路线参考：git-disl/PokeLLMon（206⭐）提供状态 grounding、知识检索注入、动作一致性校验、历史摘要等方法论；不存在可直接复用的「LLM 打 PTCG」开源方案
- 模型：deepseek-v4.1-flash 由 LinkTokenView 等聚合平台（OpenAI 兼容接口）提供；**已定直连 api.deepseek.com**，因此 endpoint 无需改造，模型名通过 settings.model 覆盖（官方模型名当前为 deepseek-chat）
- ROADMAP.md 记载执行层仍有未接入的效果（持续被动/限制 544 类），AI 决策可能遇到「解析了但没执行」的效果，属观感风险

## 方案对比
- 路线A 规则/启发式（rule-based）：零训练、零成本、可解释、零延迟；代表 wmh/ptcg-abc、sarwadnyjawale 确定性 agent；★★★★★ 起步必做（也是 LLM 的兜底）
- 路线B 搜索（Information-Set MCTS + belief）：处理不完全信息、棋力强、无外部依赖；代表 tawdesangeeta1973-coder/ptcg-belief-mcts；★★★☆ 适合做高难度档位
- 路线C 学习（BC + PPO / JAX 引擎）：拟人度最高但需大量算力与官方 CABT 引擎；代表银牌 squidistaken/pokemon-tcg-ai、muran169633/ptcg-ai-battle-simulation；★☆ 不建议自研
- 路线D LLM 策略层（PokeLLMon 式）：按量付费、可解释可拟人、易迭代；必须有 A 做合法性与回退；★★★★ 本次目标
- 决策粒度：**已定选项②** —— 按可见行动走，每个行动 1 次调用，目标 1s（超时 1.5–2s 回退启发式）；无争议的连续同类动作可合并，压到 2–3 次/回合
- 模型接入：**已定选项①直连** api.deepseek.com（endpoint 无需改造；模型名走 settings.model）

## 推荐方案
按 P0 → P1 → P2 推进，LLM 建在启发式之上，核心分工是**启发式算数 + LLM 取舍**。P0（1–2 天）：新增 DecisionRouter（pendingPick 路由：玩家→UI、AI→AiPolicy）、ActionSpace.getLegalActions() 确定性枚举器、HeuristicPolicy（会布置/附能/进化/用训练家与特性/撤退/择优攻击，且会算伤害—KO—奖赏），完成后对手即从木桩变为会打牌的对手（完全不依赖 LLM）。P1（0.5–1 天）：AI 设置 UI（启用开关、是否用 LLM、模型名、难度）+ 思考态提示 + 动作逐个播放。P2（2–3 天）：StateSerializer（视角隔离、≤1.2k tokens）+ LlmPolicy（每可见行动 1 次调用、1s 目标、1.5–2s 超时回退、function calling，复用 AIChatService 的 tools 写法与 SearchIntentParser 的 extractJson+sanitize 校验范式）+ 三道闸校验（JSON 可解析 → id 在候选集内 → canUse* 复检）+ 候选事实标注（伤害/KO/奖赏/剩余能量）。P3 可选：知识注入（复用 data/knowledge/rulings.md 与 effects.tsv）、难度档位、IS-MCTS 试点。核心原则：LLM 只输出候选动作 id（+≤ 20 字理由），随机数与合法性永远由引擎负责。

## 风险与边界
- AI 回合遇 pendingPick 会永久挂起（当前代码缺陷）：必须先做 DecisionRouter，否则任何超出「普攻」的 AI 行为都可能卡死回合，且会弹出「替对手选牌」的错误 UI
- LLM 幻觉/非法动作：必须三道闸校验（JSON 可解析 → id 在本次候选集内 → canUse* 复检）+ 重试 1 次 + 启发式回退，否则引擎会异常
- 不完全信息博弈：状态序列化必须视角隔离（AI 看不到玩家手牌/牌库/奖赏卡内容），否则等于作弊，也污染训练/评估
- 延迟与体验：按每行动 1 次调用计，一回合 2–6 次往返；1s 为 p50 目标（flash 级单次通常 0.8–2.5s），超 1.5–2s 必须回退启发式并显示「对手思考中」
- 成本：长对局每回合调用累积；建议启发式优先、LLM 只做关键决策，并考虑局面指纹缓存
- pendingPick 语义复杂（10+ 处，含 allowFewer/allowEmpty/optional/filter），启发式需按 source 分类实现，是 P0 主要工作量与出错点
- 执行层仍有未实现效果（ROADMAP 记载持续被动/限制 544 类），AI 决策会遇到「解析了但没执行」的效果，影响观感（与 LLM 无关但会被放大）
- 模型名：直连 DeepSeek 官方时需用官方模型名（当前 deepseek-chat）；deepseek-v4.1-flash 见于聚合平台，若 API 不认该模型名会报错 → 设置里需做可用性校验与回退
- 无 Key 或 API 故障时必须能降级为启发式对手（不能让对战不可用）

## 已确认决策与下一步
- 接入方式：**直连** api.deepseek.com（endpoint 不改造，模型名用 settings.model；现行模型名 `deepseek-flash`）
- AI 风格：**认真打**（强度优先，启发式需算好伤害/KO/奖赏事实）
- 决策粒度：**按可见行动走**，每个行动 1 次决策；**1 秒不是刚需，动作可见性优先**
- 能力分工：**启发式算数 + LLM 取舍**
- 待确认：P0 已完成（见下），是否继续 P1（AI 设置 UI）/ P2（LLM 策略层）

## 十、P0 实施记录（2026-09-19 已完成）

### 交付物

| 文件 | 内容 |
|---|---|
| `ptcg/battle/js/core/ActionSpace.js`（新） | `getLegalActions(gs, resolver, player)` 确定性枚举；`estimateAttackDamage` 事实标注（伤害/能否 KO/几奖赏/附能解锁哪个招式） |
| `ptcg/battle/js/core/AiPolicy.js`（新） | `HeuristicPolicy`：打分式取舍 + `choosePick`/`choosePokemonPick` 选择应答；`LlmPolicy` 预留同接口 |
| `ptcg/battle/js/core/BattleEngine.js` | `_aiTurn` 重写为「逐动作循环 + 间隔播放」；新增 `_applyAiAction`（人类/AI 共用执行路径）、`retreat()`、`runAiTurn()`；失败动作去重 + 无变化检测（防死循环） |
| `ptcg/battle/js/core/GameState.js` | `waitForPick`/`waitForPokemonPick` 支持 `aiPickHandler`/`aiPokemonPickHandler` 路由；`derivePickBounds` 抽为导出（AI 与玩家 UI 共用同一套边界推导） |
| `ptcg/battle/js/main.js` | AI 动作逐个播报（`对手：<动作>` + 刷新）；`onAiThinking` → 「对手思考中…」；pick 回调加 AI 守卫 |
| `ptcg/js/utils/constants.js`、`ApiKeyManager.js`、`battle/js/core/AiSettings.js` | 模型名 `deepseek-chat`（已停服）→ `deepseek-flash`，并自动迁移 localStorage 遗留名 |

### 关键行为变化

1. **修掉挂起**：以前 AI 回合遇到 `waitForPick` 会永久卡住（回调只服务玩家 UI）。现由策略应答 —— 实测 AI 打出「巢穴球」「宝可装置3.0」「老大的指令」等需要选牌/选目标的卡都能正常走完。
2. **动作可见（本次重点）**：每个动作之间有间隔（`engine.aiActionDelayMs`，默认 850ms）+ 逐条日志 + 每次都刷新，不再「一瞬间结束回合」。
3. **不再只普攻**：实测 20 回合对局中对手动作统计：**附能×8、训练家×28、攻击×10、竞技场×7、进化×2、撤退×1**。

### 逐动作循环的两条关键规则

- 攻击会**立即结束回合** → 策略规定「先做完善准备动作（附能/进化/特性/训练家/竞技场）再攻击」（`PREP_KINDS` + 攻击降权）
- 主要阶段必须能 `PASS_PHASE` 进入战斗阶段，否则永远打不出攻击

### 已知限制（P0 范围内接受）

1. AI 仍可能打出「当前没有有效目标」的物品卡（如神奇糖果），只是浪费一张牌，不会卡住 —— P2 可结合卡牌效果做前置条件判断。
2. 伤害估算不含硬币/随机分支（标注 `mayVary`），对随机招式的把握偏保守。
3. 能量附着目标选择较简单（优先战斗宝可梦 + 能解锁招式者），没有长期能量规划。
4. 未接入 LLM（`LlmPolicy` 目前直接复用启发式）；接入见 P2 计划。

### 验证

- `npm run test:ptcg-battle`：新增 3 条用例（动作枚举 / 选择边界 / 整局自动对战），使用固定随机种子，连续 4 次运行全通过
- 整局自动对战断言：无异常、无挂起（回合停滞检测）、回合结束交回玩家、对手会做附能/进化/训练家等操作
- `npm run test:ptcg-query` 26 项、`npm run ptcg:check-syntax` 41/41 全通过
