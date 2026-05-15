# 天右五的妙妙游戏盒 — 项目分析文档

> 生成日期：2026-05-15
> 本文件由 DeepSeek TUI 通过全面代码阅读自动生成，用于后续项目优化时的快速参考。

---

## 目录

1. [项目概览](#1-项目概览)
2. [部署与基础设施](#2-部署与基础设施)
3. [主页 (/)](#3-主页-)
4. [子项目 1：COC — 调查员名录](#4-子项目-1coc--调查员名录)
5. [子项目 2：DDP — 宝可梦对对碰](#5-子项目-2ddp--宝可梦对对碰)
6. [子项目 3：PTCG — 宝可梦卡牌库](#6-子项目-3ptcg--宝可梦卡牌库)
7. [Node.js 服务器](#7-nodejs-服务器)
8. [技术栈总结与优化建议](#8-技术栈总结与优化建议)

---

## 1. 项目概览

**项目名称**：天右五的妙妙游戏盒（BetaSerpentis.github.io）
**类型**：GitHub Pages 静态网站 + 可选 Node.js 后端
**域名**：`https://BetaSerpentis.github.io`
**主分支**：`main`

项目是一个个人游戏工具合集，包含一个主页入口和 3 个独立子项目：

| 子项目 | 路径 | 功能 | 完成度 |
|--------|------|------|--------|
| 主页 | `/index.html` | 门户导航页面 | 完成 |
| COC 调查员名录 | `/coc/` | 克苏鲁跑团角色管理 | 早期开发 |
| DDP 宝可梦对对碰 | `/ddp/` | 宝可梦对对碰小游戏 | 功能完整 |
| PTCG 宝可梦卡牌库 | `/ptcg/` | PTCG 卡牌浏览与卡组编辑 | 功能完整 |

---

## 2. 部署与基础设施

### 2.1 GitHub Actions（`.github/workflows/static.yml`）

- 触发器：推送到 `main` 分支自动部署
- 部署方式：GitHub Pages 原生 Actions（`upload-pages-artifact` + `deploy-pages`）
- 部署范围：整个仓库根目录
- 额外步骤：设置 Node.js 环境（当前配置为 v6，与 server.js 的实际 v4 依赖不匹配，但不影响 Pages 部署）

### 2.2 `.gitignore`

忽略以下内容：
- `node_modules/`
- `*.log` / `logs/`
- `.env`
- `*.pid`
- `dist/` / `build/`
- `.vscode/`

---

## 3. 主页 (/)

**文件**：`index.html`（单文件，约 130 行）

### 3.1 功能描述

一个简洁的导航入口页面，标题"天右五的妙妙游戏盒"。

### 3.2 视觉设计

- 背景：紫-红-黄三色对角线渐变 `linear-gradient(135deg, #1a2a6c, #b21f1f, #fdbb2d)`
- 布局：响应式网格（`auto-fit, minmax(300px, 1fr)`），移动端单列
- 卡片样式：白色半透明卡片 + 圆角 + 阴影 + hover 上浮/缩放动画
- 两种卡片样式：`.project-card`（PTCG 链接）和 `.project-card2`（COC 链接）

### 3.3 链接

1. **宝可梦卡牌库** → `/ptcg/` — 描述："卡牌浏览、卡组编辑、对战模拟"
2. **调查员名录** → `/coc/` — 描述："coc跑团车卡、记录、辅助工具"

注意：DDP（宝可梦对对碰）未在主页链接中展示（HTML 中有注释"可以在这里添加其他项目链接"）。

### 3.4 技术特点

- 纯 HTML + 内联 CSS，零依赖
- 无 JavaScript 逻辑
- 响应式设计（`@media max-width: 768px`）

---

## 4. 子项目 1：COC — 调查员名录

**路径**：`coc/` | **入口**：`coc/index.html`
**状态**：早期开发（UI 框架就绪，大量功能为占位符）

### 4.1 文件结构

```
coc/
├── index.html              # 入口：两页面结构（花名册 + 角色详情）
├── css/
│   ├── style.css           # 全局样式、翻页动画
│   ├── roster.css          # 花名册卡片样式
│   └── character.css       # 角色详情页样式（九维图、进度条等）
├── js/
│   ├── app.js              # 主入口（调用 Roster.init + CharacterPage.init）
│   ├── roster.js           # 花名册逻辑（卡片点击、角色数据）
│   ├── character.js        # 角色详情页逻辑（进度条、能力图、按钮事件）
│   └── utils.js            # 工具函数（UUID生成、防抖、LocalStorage 存储）
└── assets/
    └── images/
        └── placeholder-avatar.jpg  # 默认头像
```

### 4.2 页面结构

**页面 1：花名册（`#roster-page`）**
- 角色卡片列表（`.character-card`），展示：头像、姓名、性别符号、年龄、职业、状态印章、活跃年代
- "新增调查员"入口卡片（`#add-character`）
- 翻页动画过渡到角色详情页

**页面 2：角色详情页（`#character-page`）**
- **状态区域**：返回按钮、头像、基本信息、异常状态指示器（疯狂/麻痹等）
- **进度条**：HP（红色）、MP（蓝色）、Sanity（紫色），带百分比填充和数值显示
- **九维能力图**：SVG 九边形雷达图，9 项能力（力量/敏捷/体质/外貌/意志/教育/体型/智力/幸运），标签带数值
- **操作按钮 2x3 网格**：职业技能、兴趣技能、武器、道具、笔记、魔法
  - 支持点击和长按（800ms 判定）
  - 技能类按钮显示名称和数值，道具/武器类只显示名称

**页面 3：调查员创建页（`#creator-page`）** — 空白占位

### 4.3 数据模型

角色模拟数据定义在 `roster.js` 中（硬编码）：

```javascript
{
  id, name, gender, age, profession,
  status: '正常' | '疯狂' | '麻痹' 等,
  activeEra: '1920年代' | '2010年代',
  avatar: 'assets/images/placeholder-avatar.jpg',
  stats: {
    hp: { current, max },
    mp: { current, max },
    sanity: { current, max }
  },
  abilities: {
    str, dex, con, pow, app, luk, siz, int, edu  // 0-100
  },
  skills: {
    occupation: { name, value },
    hobby: { name, value },
    weapon: { name, value },
    item: { name, value },
    note: { name, value },
    magic: { name, value }
  }
}
```

### 4.4 存储方案

- 使用 `localStorage`，key 为 `coc-characters`
- `Storage.getCharacters()` / `saveCharacters()` / `addCharacter()`
- 目前仅定义接口，未实际持久化（数据仍来自硬编码）

### 4.5 翻页动画

- CSS 类 `.turning-in` / `.turning-out` 实现翻页效果
- 动画时长 600ms，通过 `setTimeout` 回调触发页面切换

### 4.6 完成度分析

| 功能 | 状态 |
|------|------|
| 花名册展示 | 完成 |
| 角色详情页 UI | 完成 |
| 九维图渲染 | 完成（SVG + JS 动态坐标计算） |
| 进度条更新 | 完成 |
| 异常状态显示 | 完成 |
| 角色数据持久化 | 接口定义完毕，未接入实际存储 |
| 创建角色页面 | 空白占位 |
| 背景信息/状态信息弹窗 | console.log 占位 |
| 能力判定/技能检定 | console.log 占位 |
| 武器/道具/笔记/魔法详情 | console.log 占位 |
| 长按编辑功能 | console.log 占位 |

### 4.7 技术亮点

- 纯 HTML/CSS/JS，零框架依赖
- SVG 九边形雷达图用三角函数动态计算顶点坐标（9 条边 × cos/sin 角度变换）
- 翻页动画增强移动端体验
- 异常状态支持多标签（空格/逗号分隔解析）

---

## 5. 子项目 2：DDP — 宝可梦对对碰

**路径**：`ddp/` | **入口**：`ddp/index.html`
**状态**：功能完整

### 5.1 文件结构

```
ddp/
├── index.html              # 入口页面（内联样式 + Canvas 容器）
├── main.js                 # 主逻辑（VisualGame 类，约 2474 行）
├── manifest.json           # PWA 清单
├── sw.js                   # Service Worker（缓存策略）
├── style.css               # 外部样式
├── core/
│   ├── PokemonData.js      # 宝可梦数据管理（加载、分类、查询）
│   ├── GameBoard.js        # 游戏核心逻辑（召唤、规则触发、进化）
│   ├── SummonSystem.js     # 召唤系统（概率判定、特殊宝可梦）
│   ├── RuleEngine.js       # 规则引擎（对对碰/三连/全图鉴/命定属性）
│   └── EvolutionManager.js # 进化管理（进化检测与执行）
├── ui/
│   ├── PokemonCell.js      # 格子渲染（Canvas 绘制宝可梦）
│   ├── BallCounter.js      # 精灵球计数器（Canvas）
│   └── MessageBoard.js     # 游戏日志面板（Canvas）
├── utils/
│   ├── ImageLoader.js      # 图片加载器（精灵图、预加载）
│   ├── AnimationManager.js # 动画引擎（抛物线/缩放/闪烁）
│   └── AudioManager.js     # 音效管理（BGM/SFX）
├── data/
│   └── pokemon_config.json # 宝可梦数据库（约 1706 行）
├── images/                 # 宝可梦精灵图
├── icons/                  # PWA 图标（多种尺寸）
└── audio/                  # 音效文件（point.mp3, clear.mp3, summon.mp3, background.mp3）
```

### 5.2 游戏机制

**核心玩法**：3x3 九宫格 + 精灵球召唤 + 属性匹配消除

1. **选择命定属性**：游戏开始时选择一种宝可梦属性（如"火"），该属性的宝可梦在棋盘上会额外奖励精灵球
2. **召唤宝可梦**：消耗 1 个精灵球在随机空位召唤宝可梦
   - 随机选择属性 → 随机选择该属性宝可梦 → 概率判定特殊类型
3. **特殊宝可梦概率**（由 `SummonSystem` 控制）：
   - 变身者：3%（百变怪、梦幻等，会复制相邻宝可梦）
   - 传说宝可梦：2%
   - 幻之宝可梦：1%（累计 3% 区间）
   - 异色宝可梦：由每只宝可梦的 `shinyProb` 决定（万分比）
4. **进化系统**（`EvolutionManager`）：
   - 基础宝可梦：5% 进化概率 → 一阶进化
   - 一阶进化宝可梦：2.5% 进化概率 → 二阶进化
   - 进化奖励：一阶 +1 球，二阶 +2 球
   - 异色状态随进化继承
5. **规则引擎**（`RuleEngine`）：
   - **命定属性**：场上每个玩家选择属性的宝可梦奖励 1 球（不移除）
   - **对对碰**：任意两只宝可梦共享属性 → 奖励 1 球，消除
   - **三连消除**：横/竖/斜线上三只共享属性 → 奖励 5 球，消除
   - **全图鉴**：场地满 9 只且属性全不同 → 奖励 9 球
   - 规则按顺序执行：命定属性 → 对对碰 → 三连 → 全图鉴
6. **动画系统**（`AnimationManager`）：
   - 抛物线动画（球飞行动画，贝塞尔曲线 + 720 度旋转）
   - 缩放动画
   - 闪烁动画（进化效果）
   - 动画队列管理（`animationQueue`），顺序播放避免冲突

### 5.3 数据层（`pokemon_config.json`）

包含约 1000+ 条宝可梦数据，每条结构：

```json
{
  "id": 1,
  "name": "妙蛙种子",
  "type1": "草",
  "type2": null,
  "stage": "基础",
  "evolvesTo": 2,
  "evolutionProb": 0.05,
  "shinyProb": 0.01,
  "isLegendary": false,
  "isMythical": false,
  "isTransformer": false
}
```

尾部包含 `typeColors` 映射（10 种属性 → 颜色码）：

| 属性 | 颜色 |
|------|------|
| 草 | #c0d631 |
| 火 | #f2a057 |
| 水 | #9dd7f5 |
| 斗 | #f7b816 |
| 超 | #e3a1c5 |
| 恶 | #00586e |
| 雷 | #ffe26e |
| 钢 | #d4d5d6 |
| 龙 | #dbc051 |
| 无 | #edeceb |

### 5.4 视听系统

- **BGM**：`audio/background.mp3`（循环播放，46 秒循环点，0.5 音量，淡入效果）
- **音效**：
  - `point.mp3` — 得分
  - `clear.mp3` — 消除
  - `summon.mp3` — 召唤
- 浏览器自动播放限制处理：等待首次用户交互（点击扔球按钮）后播放 BGM

### 5.5 PWA 配置

- `manifest.json`：全屏显示 + 竖屏锁定 + 9 种图标尺寸（72-512px）
- `sw.js`：预缓存核心文件 + 运行时缓存图片资源
- iOS 适配：`viewport-fit=cover`、安全区域 padding、启动屏配置

### 5.6 架构特点

- ES6 模块化（`import`/`export`）
- Canvas 渲染（格子、计数器、消息面板均用 Canvas 绘制）
- 事件驱动：`uiCallback` 回调从 GameBoard 传递消息到 UI
- 动画队列：顺序播放，支持进化后接奖励球飞行
- 实时奖励系统（`immediateRewards`）：独立于主队列，立即触发的奖励

---

## 6. 子项目 3：PTCG — 宝可梦卡牌库

**路径**：`ptcg/` | **入口**：`ptcg/index.html`
**状态**：功能完整

### 6.1 文件结构

```
ptcg/
├── index.html              # 入口页面
├── manifest.json           # PWA 清单（standalone 模式）
├── sw.js                   # Service Worker（网络优先 + 缓存回退）
├── css/
│   ├── main.css            # 全局样式
│   └── ptcg.css            # PTCG 特定样式
├── js/
│   ├── main.js             # 应用入口（PTCGApp 类，约 278 行）
│   ├── core/
│   │   ├── CardManager.js  # 卡牌数据管理（加载、搜索、世代筛选）
│   │   ├── DeckManager.js  # 卡组管理（CRUD、排序、封面）
│   │   ├── SearchEngine.js # 搜索引擎
│   │   ├── StorageService.js # 本地存储 + 导入导出
│   │   └── ImageLoader.js  # 图片懒加载
│   ├── features/
│   │   ├── CardBrowser.js  # 卡牌浏览功能
│   │   └── DeckEditor.js   # 卡组编辑器（约 1524 行，最大文件）
│   ├── ui/
│   │   ├── CardGrid.js     # 卡牌网格渲染（分批加载、触摸事件）
│   │   ├── ModalView.js    # 卡牌大图模态框（滑动切换）
│   │   ├── TabManager.js   # 类型标签页 + 世代筛选
│   │   └── StatsManager.js # 统计模式（数量增减）
│   └── utils/
│       ├── constants.js    # 常量配置（卡牌类型、存储键）
│       ├── helpers.js      # 工具函数（Three.js 背景、防抖、导出）
│       ├── ButtonManager.js # 全局按钮管理（模式切换）
│       └── TouchManager.js  # 移动端触摸优化
├── data/
│   ├── pokemon-cards.json      # 宝可梦卡牌数据
│   ├── Supporter-cards.json    # 支援者卡牌
│   ├── Item-cards.json         # 物品卡牌
│   ├── PokemonTool-cards.json  # 宝可梦道具卡牌
│   ├── Stadium-cards.json      # 竞技场卡牌
│   ├── BasicEnergy-cards.json  # 基本能量卡牌
│   └── SpecialEnergy-cards.json # 特殊能量卡牌
├── images/                 # 卡牌图片（hk 编号格式：hk00000001.webp）
└── icons/                  # PWA 图标
```

### 6.2 功能架构

**应用入口**（`main.js` — `PTCGApp` 类）：
- 初始化所有核心服务和管理器
- 统一的事件分发：`handleCardClick` / `handleQuantityChange`
- 三种模式切换：浏览模式 → 卡组模式 → 统计模式

**卡牌浏览**（`CardBrowser`）：
- 按 7 种类型筛选：宝可梦 / 支援者 / 物品 / 宝可梦道具 / 竞技场 / 基本能量 / 特殊能量
- 宝可梦类型的世代筛选（Gen 1-9），通过编号范围过滤
- 文本搜索（名称、特性、技能名/效果）
- 搜索结果与世代筛选联动

**卡组编辑**（`DeckEditor`）：
- 多卡组管理（创建/切换/删除）
- 查卡模式（在卡组内搜索添加卡牌）
- 卡牌排序规则：类型分组（宝可梦→支援者→物品→道具→竞技场→基本能量→特殊能量）→ 编号增序 → 名称增序
- 卡组封面图片选择
- 卡组内数量编辑

**卡牌网格**（`CardGrid`）：
- 分批渲染（每批 50 张）
- Intersection Observer 懒加载图片
- 移动端触摸优化：区分点击/长按/拖拽
- 数量角标显示

**模态框**（`ModalView`）：
- 三图布局（prev/current/next），支持滑动切换
- 触摸拖拽 + 键盘方向键 + 箭头按钮
- 循环浏览

**数据持久化**（`StorageService`）：
- `localStorage` 存储卡牌数量和卡组
- 完整的导入/导出功能（JSON 格式，含版本号验证）
- 防抖自动保存

### 6.3 数据模型

**卡牌类型配置**（`constants.js`）：

```javascript
CARD_TYPES = {
  '宝可梦':     { jsonFile: 'data/pokemon-cards.json',      hasNumber: true },
  '支援者':     { jsonFile: 'data/Supporter-cards.json',    hasNumber: false },
  '物品':       { jsonFile: 'data/Item-cards.json',         hasNumber: false },
  '宝可梦道具': { jsonFile: 'data/PokemonTool-cards.json',  hasNumber: false },
  '竞技场':     { jsonFile: 'data/Stadium-cards.json',      hasNumber: false },
  '基本能量':   { jsonFile: 'data/BasicEnergy-cards.json',  hasNumber: false },
  '特殊能量':   { jsonFile: 'data/SpecialEnergy-cards.json', hasNumber: false }
}
```

**世代范围**（Gen 1-9，对应宝可梦全国图鉴编号）：
- Gen 1: 1-151, Gen 2: 152-251, Gen 3: 252-386, Gen 4: 387-493
- Gen 5: 494-649, Gen 6: 650-721, Gen 7: 722-809, Gen 8: 810-905, Gen 9: 906-1025

### 6.4 图片策略

- 图片文件命名：`hk` + 8 位补零编号 + `.webp`（如 `hk00000001.webp`）
- 懒加载：Intersection Observer + `data-src` 属性
- 加载占位：SVG data URI（灰色背景 + "加载中..."文字）
- 失败重试：最多 2 次

### 6.5 未完成功能

- **对战模拟**（`data-feature="battle"`）：HTML 占位显示"正在开发中"
- **卡组编辑标签页**（`data-feature="deck"`）：HTML 占位显示"正在开发中"，实际功能在 DeckEditor 中已通过模式切换实现
- **Three.js 背景**：代码存在但已注释（`initThreeJS()` 在 main.js 中被注释）

### 6.6 架构特点

- 完全模块化 ES6（所有文件使用 `import`/`export`）
- 清晰的关注点分离：core（数据/业务） → features（功能） → ui（视图）
- 全局按钮管理器（`ButtonManager`）统一处理左下角和右下角浮动按钮
- 模式切换通过 CSS 类 + DOM 操作实现，无前端路由
- 卡组编辑时保存原始状态，退出时恢复，避免状态污染

---

## 7. Node.js 服务器

**文件**：`server.js`（约 80 行）

### 7.1 用途

一个 Express 服务器，提供卡牌数据的读写 API，用于 PTCG 子项目的后端支持。

### 7.2 依赖

```json
{
  "express": "^4.18.2",
  "express-fileupload": "^1.4.0",
  "xlsx": "^0.18.5",
  "cors": "^2.8.5"
}
```

开发依赖：`nodemon`

### 7.3 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 返回主页 `index.html` |
| GET | `/api/get-data` | 读取 `data/card-data.json`，返回卡牌数据 |
| POST | `/api/save-data` | 保存卡牌数据到 `data/card-data.json` |
| GET | `/api/get-excel` | 重定向到 `/api/get-data`（兼容旧接口） |
| `express.static` | 所有静态文件 | 服务整个仓库根目录的静态文件 |

### 7.4 运行

- 生产：`npm start` → `node server.js`（端口 3000）
- 开发：`npm run dev` → `nodemon server.js`

### 7.5 与 GitHub Pages 的关系

服务器是**可选**的本地开发/测试工具。生产环境中 GitHub Pages 只提供静态文件服务，API 端点不可用。PTCG 使用 `localStorage` 作为前端存储，不依赖后端 API。

---

## 8. 技术栈总结与优化建议

### 8.1 各项目技术栈对比

| 维度 | COC | DDP | PTCG |
|------|-----|-----|------|
| 模块化 | 全局变量 | ES6 Modules | ES6 Modules |
| 渲染方式 | DOM | Canvas | DOM |
| PWA | 无 | 有 | 有 |
| 数据存储 | localStorage（未接入） | JSON 文件（静态） | localStorage |
| 外部依赖 | 无 | 无 | 无（Three.js 已注释） |
| 移动端优化 | 基础 | 完善（安全区域、触摸） | 完善（TouchManager） |
| 代码量（估算） | ~800 行 | ~6000+ 行 | ~5000+ 行 |

### 8.2 短期优化建议

1. **主页添加 DDP 链接**：`index.html` 中 DDP 子项目未展示，可在卡片网格中添加
2. **COC 数据持久化**：`Storage` 工具类已定义但未实际使用，将模拟数据迁移到 localStorage 即可实现最简单的持久化
3. **COC 功能补全**：角色创建页面是所有后续功能的基础，建议优先实现
4. **PTCG 对战模拟**：HTML 中预留了占位，可逐步实现
5. **node_modules 清理**：`package.json` 中的 `xlsx` 和 `express-fileupload` 依赖在 `server.js` 中没有实际使用（代码被注释），可移除

### 8.3 中期优化建议

1. **统一 PWA 配置**：三个子项目中 DDP 和 PTCG 各有独立的 Service Worker 和 manifest，COC 没有。可以考虑统一或至少补全 COC 的 PWA 支持
2. **共享组件提取**：如 `utils/debounce` 在 COC 和 PTCG 中各自实现，可提取为公共模块
3. **Server 端点加固**：当前 `server.js` 没有任何认证/授权，仅适合本地开发使用
4. **图片优化**：PTCG 的 webp 图片和 DDP 的 png 精灵图可根据需要统一格式或添加尺寸变体

### 8.4 架构评价

- **DDP** 和 **PTCG** 架构清晰，模块分离合理，便于维护和扩展
- **COC** 处于早期阶段，代码量小但基础结构良好（翻页动画、九维图、存储接口），后续开发有良好的起点
- 三个项目**零外部运行时依赖**（无 React/Vue/jQuery），加载速度快，适合 GitHub Pages 静态托管

---

*本文档由自动化工具生成，如需更新请在项目变更后重新运行分析。*
