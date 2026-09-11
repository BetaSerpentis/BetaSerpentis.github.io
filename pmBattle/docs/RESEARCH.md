# 宝可梦单打回合制战斗系统调研报告

> 目标：复刻一版宝可梦单打（Singles）回合制战斗，本报告梳理战斗系统的具体机制、数值，以及完整宝可梦数据库的获取来源。

---

## 一、完整数据库来源（重要）

### 1.1 Pokémon Showdown —— 首选，权威且完整 ✅

**仓库**：`https://github.com/smogon/pokemon-showdown`（MIT 许可）

这是全球最大的宝可梦对战模拟器（Pokémon Showdown）的完整源代码，包含**全部战斗数据 + 完整战斗引擎**。数据文件全部为 TypeScript 源码（本质是带类型标注的对象字面量，可直接解析），已通过 `raw.githubusercontent.com` 逐一验证可访问（HTTP 200）。

**数据目录 `data/`（战斗数值全在这里）**：

| 文件 | 内容 | 关键字段 |
|------|------|----------|
| `data/pokedex.ts` | 全宝可梦种族数据（约 1000+ 种 + 形态/地区形态） | `baseStats{hp,atk,def,spa,spd,spe}`、`types[]`、`abilities{0,H}`、`weightkg`、`heightm`、`genderRatio`、`evos/prevo`、`eggGroups`、`formeOrder` |
| `data/moves.ts` | 全招式数据（约 900+） | `basePower`、`accuracy`、`category`(Physical/Special/Status)、`type`、`pp`、`priority`、`target`、`secondary{chance,status}`、`flags`、`drain`、`isZ/isMax` 等 |
| `data/abilities.ts` | 全特性（约 300+） | `name`、`rating`、`onModifyMove` 等效果钩子 |
| `data/items.ts` | 全道具（约 2000+） | `name`、`fling`、`naturalGift`、各类效果 |
| `data/learnsets.ts` | 招式学习面（全宝可梦 × 全招式来源） | `learnset{movename: ["8L1","8M","8T","8E","8S0"...]}`（升级/招式机/教授/遗传/事件） |
| `data/typechart.ts` | 属性相克表（18 属性 + Stellar） | `damageTaken{Type: 0/0.25/0.5/1/2/4}`（0=免疫） |
| `data/natures.ts` | 25 种性格 | `plus`/`minus` 属性 |
| `data/formats-data.ts` | 对战格式/规则、ban list、合法道具/招式 | `tier`、`randomBattleMoves`、`isNonstandard` |
| `data/conditions.ts` | 状态（烧伤/麻痹/睡眠/中毒/冰冻/混乱等） | 状态效果定义 |
| `data/aliases.ts` | 名称别名 | — |

**引擎目录 `sim/`（机制实现参考）**：

| 文件 | 作用 |
|------|------|
| `sim/battle.ts` | 主战场循环、事件系统（runEvent）、回合流程 |
| `sim/battle-actions.ts` | 招式执行、命中判定、**伤害计算 `getDamage`/`modifyDamage`** |
| `sim/battle-abilities.ts` / `battle-moves.ts` / `battle-items.ts` | 特性/招式/道具的具体效果实现 |
| `sim/pokemon.ts` | 宝可梦类、**能力值计算 `getStat`**、`getDamage` 应用 |
| `sim/dex.ts` / `dex-species.ts` / `dex-moves.ts` / `dex-abilities.ts` / `dex-items.ts` / `dex-formats.ts` / `dex-data.ts` | 数据访问层 + 各数据类型的 schema 定义 |
| `sim/team-validator.ts` | 队伍合法性校验 |
| `sim/side.ts` / `field.ts` / `state.ts` / `prng.ts` | 双方/场地/状态/伪随机数 |

**结论**：数据 + 引擎参考全都在一个仓库里，直接用它作为唯一数据源即可，无需拼凑多套数据库。

### 1.2 中文名称数据 —— `data/text/zh-cn/`（已确认）✅

PS 仓库自带简体中文翻译，位于 **`data/text/zh-cn/`** 目录（已浅克隆到本地 `.pi/cache/pokemon-showdown/` 验证）：

| 文件 | 内容 | 说明 |
|------|------|------|
| `data/text/zh-cn/pokedex.ts` | `PokedexText`：全宝可梦中文名 | 少量形态 `name: null // NEEDS TRANSLATION`，需 fallback 英文 |
| `data/text/zh-cn/moves.ts` | `MovesText`：全招式中文名 | 含 `desc`/`shortDesc`（部分为 null） |
| `data/text/zh-cn/abilities.ts` | `AbilitiesText`：全特性中文名 | 同上 |
| `data/text/zh-cn/items.ts` | `ItemsText`：全道具中文名 | 同上 |
| `data/text/zh-cn/names.ts` | `StatNames`/`TypeNames`：能力/属性中文名 | 完整 |
| `data/text/zh-cn/default.ts` | 战斗文本（回合提示等） | 可复用到战斗日志 |
| `data/text/zh-cn/tags.ts` | 标签中文 | — |

> 注意：UI 界面翻译在 `translations/zh-cn/`（main.ts 等），图鉴数据翻译在 `data/text/zh-cn/`，两者不同，本次用的是后者。

### 1.3 Gen 9 过滤规则（已从源码确认）

`mod: 'gen9'` + `ruleset: ['Standard']`（config/formats.ts、data/rulesets.ts），`obtainable` ruleset 的 `banlist: ['Unreleased', 'Unobtainable', 'Nonexistent']`，以及 `sim/team-validator.ts` 中 `isNonstandard` 的判定（`'Past'/'Future'/'CAP'/'LGPE'/'Unobtainable'/'Gmax'` 均不存在于当前世代）：

- **宝可梦**：排除 `tags` 含 `True Past` / `Past Unobtainable` / `Pokestar` 的条目（过去形态、电影形态，Gen 9 不可用）
- **招式**：排除 `isNonstandard` ∈ { Past, Gmax, LGPE, Unobtainable, CAP, Future }（约 256 条）
- **特性**：排除 `isNonstandard` ∈ { Past, Future, CAP }（约 11 条）
- **道具**：排除 `isNonstandard` ∈ { Past, Future, Unobtainable, CAP }（约 334 条）

### 1.4 PokeAPI —— 备选 / 图片资源

**REST API**：`https://pokeapi.co/api/v2/...`（已验证可访问，返回 JSON）

- ✅ 有：`pokemon`（种族值/属性/特性/身高体重）、`move`、`ability`、`item`、`type`、`species`、官方插画 sprite
- ❌ 缺/弱：招式威力/命中率精度、结构化相克表、learnset 格式、对战格式规则
- 用途：官方图鉴图片、二次校验

### 1.3 机制说明参考

- **Bulbapedia**（bulbagarden）：机制条目最详尽（伤害公式、命中、能力值等）
- **Veekun**（veekun.com/dex）：另一套结构化图鉴数据
- **Smogon**（smogon.com）：对战环境/分级/常用配置

---

## 二、战斗系统核心机制与数值

### 2.1 能力值（Stats）计算

6 项能力：HP / 攻击(Atk) / 防御(Def) / 特攻(SpA) / 特防(SpD) / 速度(Spe)

```
HP   = floor((2×种族值 + IV + floor(EV/4)) × 等级 / 100) + 等级 + 10
其他 = floor((floor((2×种族值 + IV + floor(EV/4)) × 等级 / 100) + 5) × 性格修正)
```

- **个体值 IV**：0 ~ 31
- **努力值 EV**：单项目上限 252，每 4 点 EV = 1 点能力值（等级 100 时）；总和上限 510
- **性格修正**：+10% 一项 / −10% 一项（25 种性格，`natures.ts`）
- **等级**：标准单打 flat 规则为 **50 级**
- 能力阶级（boost stages）：−6 ~ +6，倍率 `[1, 1.5, 2, 2.5, 3, 3.5, 4]`（正阶相乘，负阶相除）—— 与 `sim/pokemon.ts` 的 `boostTable` 一致

### 2.2 伤害公式（Gen 5 起至今）

源码（`sim/battle-actions.ts` `getDamage`）：

```
baseDamage = floor(floor(floor(floor((2×等级/5 + 2) × 威力 × 攻击 / 防御) / 50)))
伤害       = floor(baseDamage + 2) × 修正1 × 修正2 × ...
```

修正项（按 `modifyDamage` 顺序）：
- **随机**：0.85 ~ 1.00（16 档）
- **STAB**：本系 ×1.5（适应力特性 ×2）
- **属性相克**：0 / 0.25 / 0.5 / 1 / 2 / 4
- **会心一击**：×1.5（Gen 6+，狙击手特性 ×2.25）
- **烧伤**：物理招式伤害 ×0.5（毅力特性免疫该减半）
- 天气、场地、道具、特性、招式二段效果等

### 2.3 属性相克（18 属性）

倍率直接来自 `data/typechart.ts` 的 `damageTaken`：`0`=免疫、`0.25`=双重抵抗、`0.5`=抵抗、`1`=普通、`2`=克制、`4`=双重克制。

例（电属性打水系）：Water 对 Electric 的 damageTaken=2，即电克水。

### 2.4 回合流程（单打）

1. **选择阶段**：双方选择招式或交换宝可梦（交换优先于出招判定，但同一优先级内按速度）
2. **先手判定**：招式优先度（priority）→ 速度值 → 随机；「戏法空间」反转速度顺序
3. **招式执行**：命中判定 → 会心判定 → 计算伤害/效果 → 附加状态 → 结算（濒死处理）
4. **回合结束结算**：天气/场地/烧伤/中毒/种子/束缚等持续性效果
5. **濒死替换**：换上新宝可梦，触发入场特性（如威吓）

### 2.5 优先度（priority）

范围约 −7 ~ +5，例：先制 +1（电光石火）、守住 +4、戏法空间 −7。优先度越高越先动。

### 2.6 命中与回避

```
命中判定 = 招式命中率 × 使用者命中修正 × 目标回避修正
```

- `accuracy: true` 表示必中（如燕返）；`accuracy: 100` 表示 100%
- 命中/回避阶级同样 ±6，倍率 `[3/9, 3/8, 3/7, 3/6, 3/5, 3/4, 1, 4/3, 5/3, 6/3, 7/3, 8/3, 9/3]`

### 2.7 会心一击（Critical Hit）

- 基础概率 1/24（约 4.17%）；伤害 ×1.5（Gen 6+）
- 无视攻击方攻击降低/防御方防御提升（能力阶级层面）

### 2.8 主要状态异常（`data/conditions.ts`）

| 状态 | 效果 |
|------|------|
| 烧伤 burn | 每回合损失 1/8 最大 HP；物理招式伤害减半 |
| 麻痹 paralysis | 速度减半；25% 概率无法行动 |
| 睡眠 sleep | 1~3 回合无法行动 |
| 中毒 poison | 每回合损失 1/8 最大 HP（剧毒 toxic 逐回合递增 1/16→2/16→…） |
| 冰冻 freeze | 无法行动，每回合 20% 概率自行解冻（Gen 2+） |
| 混乱 confusion | 1~4 回合，每回合 1/3 概率以 40 威力自伤 |

### 2.9 天气（weather）

| 天气 | 主要效果 |
|------|----------|
| 雨天 | 水系招式 ×1.5，火系 ×0.5 |
| 晴天 | 火系 ×1.5，水系 ×0.5 |
| 沙暴 | 每回合损失 1/16（岩石/地面/钢系免疫）；岩石系特防 ×1.5 |
| 雪天（Gen 9 后） | 每回合损失 1/16（冰系免疫）；冰系物防 ×1.5 |
| 冰雹（旧） | 每回合损失 1/16（冰系免疫） |

### 2.10 场地（terrain）

| 场地 | 主要效果 |
|------|----------|
| 电气 | 电系 ×1.3；地面宝可梦无法睡眠 |
| 青草 | 草系 ×1.3；地面系招式威力减半；每回合回复 1/16 |
| 薄雾 | 龙系 ×0.5；免疫状态异常 |
| 精神 | 超能 ×1.3；先制招式对地面目标无效 |

### 2.11 道具与特性（海量，仅列常见）

- **讲究系列**（讲究头带/眼镜/围巾）：对应攻击/特攻/速度 ×1.5，但锁招
- **生命宝珠**：伤害 ×1.3，但每次攻击损失 1/10 HP
- **剩饭**：每回合回复 1/16 HP
- **突击背心**：特防 ×1.5，但禁用变化招式
- **特性**：威吓（出场降对方物攻）、加速（每回合速度+1）、威压、大力士（物攻翻倍）等约 300 种

### 2.12 入场危害（Entry Hazards）

- **隐形岩**：按岩石相克倍率，1/8 × 倍率 的伤害
- **撒菱**：1/8（1 层）~ 1/4（3 层）
- **毒菱**：1 层=中毒、2 层=剧毒
- **粘网**：速度 −1

### 2.13 换人 / 濒死 / PP / 挣扎

- 每个招式有 PP，耗尽后使用「挣扎」（Struggle）：50 威力、无属性、自伤 1/4 最大 HP

---

## 三、数据规模预估

- 宝可梦：约 1025 种（+ 数百形态/地区形态/超级进化等）
- 招式：约 900+
- 特性：约 300+
- 道具：约 2000+
- 学习面：全宝可梦 × 全招式来源（learnsets 是最大的一张表）

---

## 四、建议的复刻范围

**MVP（第一版）**：
- 单打、50 级 flat 规则
- 能力值计算（种族/IV/EV/性格）
- 伤害公式 + STAB + 属性相克 + 会心 + 随机区间
- 优先度 + 速度先手判定
- 状态异常（烧伤/麻痹/睡眠/中毒/冰冻）+ 混乱
- 天气（雨/晴/沙/雪）
- 常用道具（讲究系列、生命宝珠、剩饭、突击背心）
- 常用特性（威吓、加速、大力士等核心影响伤害/速度的）
- 隐形岩等入场危害
- 换人、濒死替换、PP 与挣扎

**后续迭代**：
- 全特性/全道具/全招式效果（可对照 `sim/battle-abilities.ts` 等逐条移植）
- 场地、Z 招式/极巨化等世代特性
- AI 对手 / 队伍构建 / 分级规则

---

## 五、建议的技术方案（对齐现有 ptcgBattle 结构）

1. **纯前端 + Node 脚本**，目录结构对齐 `ptcgBattle/`：
   - `data_txt/` 或 `data/`：存放转换后的 JSON 数据
   - `convert.js`：从 Pokémon Showdown 的 `.ts` 数据文件解析生成 JSON（可参考 `ptcgBattle/convert.js`）
   - `js/core/`：`BattleEngine.js`、`GameState.js` 等
   - `js/data/`：队伍/图鉴等运行时数据
   - `js/ui/`：`BattleField.js` 等渲染
   - `tests/`：自动化测试
2. **数据导入策略**：抓取 Pokémon Showdown `master` 分支的 `data/*.ts`，用 Node 脚本剥离 TypeScript 类型标注、提取对象字面量，生成 `pokemon.json / moves.json / abilities.json / items.json / learnsets.json / typechart.json / natures.json`。

---

## 六、已确认的需求方向

1. **世代范围**：只做最新 **Gen 9**（机制按 Gen 9 结算，含太晶化；可用池按 Gen 9 标准环境过滤，见 1.3）
2. **范围**：**全量移植**（全特性/全道具/全招式效果，对照 `sim/battle-abilities.ts` 等逐条移植）
3. **对战对象**：**玩家 vs AI**
4. **语言**：**只考虑中文**（名称用 `data/text/zh-cn/`，缺失条目 fallback 英文）
