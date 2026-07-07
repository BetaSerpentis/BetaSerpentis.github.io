// ptcg/js/services/AIChatService.js
import { CONFIG_AI, STORAGE_KEYS } from '../utils/constants.js';

const SYSTEM_PROMPT = `你是 PTCG 简中环境（F/G/H/I标）卡牌分析专家。

## 工作流（极简）

1. 用户问某张卡的配合 → 调用 **deep_analysis(卡牌名)**，一次性获取完整协同分析报告（搜索/验证/打分已完成）
2. 基于报告中的数据，**逐张分析推荐的卡**，写1500字以上的详细报告
3. 也可以使用 search_cards/grep_cards/get_card_detail 做补充搜索

## 工具

- **deep_analysis(card_name)**: 【主力】一键分析。输入卡牌名即可获取：目标卡详情+多方向搜索+综合排名+顶级候选完整效果验证。
- **search_cards(query, type?, limit?)**: 快速搜索
- **grep_cards(patterns, type?, limit?)**: 正则精确搜索

## 输出结构

### 1. 目标卡拆解
特性、招式（能量+伤害+效果）、HP/弱点/撤退。提供什么/需要什么。

### 2. 最佳打手（逐张详细，100-200字/张）
卡名+ID → 关键效果原文 → 协同逻辑链 → 战略评价（部署/奖品/上限）
优先分析⭐标记的卡。基础+1奖+缩放 > 进化+2奖+固定。

### 3. 优质泛用卡
检索/过牌/干扰/保护类。

### 4. 战略总结
协同强度、环境适应、弱点、补强方向。

要求：1500字以上。引用具体卡名ID。从报告数据中引用，不要编造。

## PTCG 规则（必须遵守）
- 每回合只能使用1次招式（无特殊效果时）
- 每回合只能手贴1张能量
- 1个伤害指示物=10点伤害
- 同名卡全卡组最多4张。ACE SPEC 1张。卡组60张整
- 基础宝可梦第一回合不能进化。刚上场的宝可梦当回合不能进化

## 分析注意事项
- 伤指物转移方向很重要：把**对手**的伤指物转移=进攻（不需要沙奈朵）。把**自己**的伤指物转移给对手=利用沙奈朵放的伤指物。仔细读效果文本判断方向
- 自身有填能/能量减免能力的卡不需要沙奈朵ex辅助
- 低HP(≤70)+伤指物缩放的卡有HP上限问题：例如50HP的卡只能承受4次沙奈朵ex的伤指物（4×10=40），第5次就昏厥。必须在分析中指出
- 后排攻击有战略价值——可以狙杀备战区关键卡，即使伤害不高也值得加分

## 特征标签说明
每张卡附带标签如：伤指物缩放、能量缩放、后排攻击、伤指物转移-进攻、自填能、能量减免、检索、过牌、手牌干扰。优先推荐有"伤指物缩放""能量缩放""后排攻击"标签的卡。

## PTCG 知识
- 特性引擎最优。从弃牌区填能稳定。基础宝可梦比进化好调度。1奖小人牌奖品高效
- 伤害阈值：70(基础)|120-150(1阶)|210-230(VSTAR)|280(多龙ex)|310(沙奈朵ex)
- 常用泛用卡：老大的指令(抓枪)、朋友手册(回收)、夜游记(回收)、钥圈儿(锁特性)、玛纳霏(备战保护)
- 环境：F-I标。

## 组卡组（严格规则）
1. 宝可梦从报告中选（进化链已在）
2. 支援者/物品/道具/竞技场从报告末尾📦索引选——**不在索引里的卡就不存在**
3. 搜1-2轮确认ID即开始写卡组，2000字以上。第5轮起必须输出
3. 搜索例：search_cards("好友宝芬","物品") 或 search_cards("老大的指令","支援者")
4. 搜不到的卡不要放进卡组。绝对不编造ID
5. 卡组必须60张

## 出卡组格式
\`\`\`json deck
{"name":"卡组名","cards":[{"id":"ID","quantity":4}]}
\`\`\``;

export class AIChatService {
    constructor(cardManager, apiKeyManager) {
        this.cardManager = cardManager;
        this.apiKeyManager = apiKeyManager;
        this._history = [];
        this._searchDataLoaded = false;
        // JSON 完整卡牌数据缓存: Map<cardId, fullCardObject>
        this._jsonCache = new Map();
        this._jsonLoading = new Map();  // Map<cardType, Promise> 防止重复加载
        this._loadHistory();
    }

    // 获取卡牌类型对应的 JSON 文件名
    _getJsonFileForType(cardType) {
        const map = {
            '宝可梦': 'pokemon-cards.json',
            '支援者': 'Supporter-cards.json',
            '物品': 'Item-cards.json',
            '宝可梦道具': 'PokemonTool-cards.json',
            '竞技场': 'Stadium-cards.json',
            '基本能量': 'BasicEnergy-cards.json',
            '特殊能量': 'SpecialEnergy-cards.json'
        };
        return map[cardType] || null;
    }

    // 加载指定卡牌类型的 JSON 数据，构建 cardId→data 的映射
    async _loadJsonCache(cardType) {
        const filename = this._getJsonFileForType(cardType);
        if (!filename) return;

        // 防止重复加载
        if (this._jsonLoading.has(cardType)) {
            return this._jsonLoading.get(cardType);
        }

        const promise = (async () => {
            try {
                const url = `data/${filename}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const jsonData = await response.json();
                if (!Array.isArray(jsonData)) return;

                // 为每个 ID 建立索引
                for (const card of jsonData) {
                    const ids = card['卡牌ID'];
                    if (!ids || !Array.isArray(ids)) continue;
                    for (const id of ids) {
                        if (id && !this._jsonCache.has(id)) {
                            this._jsonCache.set(id, card);
                        }
                    }
                }
                console.log(`[AI JSON] Loaded ${filename}: ${jsonData.length} cards indexed`);
            } catch (e) {
                console.warn(`[AI JSON] Failed to load ${filename}:`, e.message);
            }
        })();

        this._jsonLoading.set(cardType, promise);
        return promise;
    }

    // 获取指定 ID 的完整 JSON 数据（自动触发按需加载）
    async _getFullCardData(cardId) {
        // 先检查缓存
        if (this._jsonCache.has(cardId)) {
            return this._jsonCache.get(cardId);
        }

        // 确定卡牌类型
        let cardType = null;
        const cache = this.cardManager.allCardsCache;
        if (cache) {
            const basic = cache.find(c => c.id === cardId);
            if (basic) cardType = basic.type;
        }
        if (!cardType) {
            const current = this.cardManager.cards || [];
            const found = current.find(c => c.id === cardId);
            if (found) cardType = found.type;
        }
        if (!cardType) return null;

        // 加载 JSON
        await this._loadJsonCache(cardType);
        return this._jsonCache.get(cardId) || null;
    }

    // 批量获取完整数据（并发加载需要的类型）
    async _getFullCardDataBatch(cardIds) {
        // 收集需要的类型
        const typesNeeded = new Set();
        const cache = this.cardManager.allCardsCache || [];
        const current = this.cardManager.cards || [];
        const allBasic = cache.length > 0 ? cache : current;

        for (const id of cardIds) {
            if (this._jsonCache.has(id)) continue;
            const basic = allBasic.find(c => c.id === id);
            if (basic && basic.type) typesNeeded.add(basic.type);
        }

        // 并发加载
        if (typesNeeded.size > 0) {
            await Promise.all([...typesNeeded].map(t => this._loadJsonCache(t)));
        }

        // 返回结果
        const result = new Map();
        for (const id of cardIds) {
            const data = this._jsonCache.get(id);
            if (data) result.set(id, data);
        }
        return result;
    }

    // 使用 JSON 数据格式化单张卡为结构化上下文
    _formatRichCardContext(cardId, jsonData, basicData) {
        const parts = [];
        const version = basicData ? this._extractVersion(basicData) : null;
        const isLegal = this._isCurrentFormat(version);
        const envTag = version ? (isLegal ? ` [${version}标✓]` : ` [${version}标·已退环境]`) : '';

        const name = jsonData['宝可梦名字'] || jsonData['卡牌名字'] || basicData?.name || '未知';
        parts.push(`**${name}**${envTag}`);
        parts.push(`- ID: \`${cardId}\``);

        // 宝可梦
        if (jsonData['宝可梦名字']) {
            const attr = jsonData['属性'] || '';
            parts.push(`- 类型: 宝可梦 | 属性: ${attr} | HP: ${jsonData['HP'] || '?'} | 阶段: ${jsonData['进化阶段'] || '基础'}`);
            if (jsonData['进化自']) parts.push(`- 进化自: ${jsonData['进化自']}`);
            if (jsonData['规则']) parts.push(`- 规则: ${jsonData['规则']}`);
            if (jsonData['弱点']) parts.push(`- 弱点: ${jsonData['弱点']}`);
            if (jsonData['抵抗力']) parts.push(`- 抵抗力: ${jsonData['抵抗力']}`);
            if (jsonData['撤退'] != null) parts.push(`- 撤退: ${jsonData['撤退']}`);

            // 特性
            if (jsonData['特性名字']) {
                parts.push(`- 特性「${jsonData['特性名字']}」: ${jsonData['特性效果'] || '(无描述)'}`);
            }

            // 招式
            for (let i = 1; i <= 4; i++) {
                const skill = jsonData[`技能${i}`];
                if (skill && skill['名字']) {
                    const cost = Array.isArray(skill['消耗']) ? skill['消耗'].join(' ') : (skill['消耗'] || '无');
                    const dmg = skill['伤害'] ? ` ${skill['伤害']}伤害` : '';
                    const eff = skill['效果'] && skill['效果'] !== '无' ? `。${skill['效果']}` : '';
                    parts.push(`- 招式「${skill['名字']}」[${cost}]:${dmg}${eff}`);
                }
            }
        } else {
            // 支援者/物品/道具/竞技场/能量
            const cardType = jsonData['卡牌类型'] || basicData?.type || '';
            parts.push(`- 类型: ${cardType}`);
            if (Array.isArray(jsonData['卡牌版本'])) {
                parts.push(`- 版本: ${jsonData['卡牌版本'].join(', ')}`);
            }
            if (jsonData['效果']) {
                parts.push(`- 效果: ${jsonData['效果']}`);
            }
        }

        return parts.join('\n');
    }

    // 确保所有卡牌类型的 searchText 已加载 + JSON 完整数据已预加载
    async ensureSearchDataLoaded() {
        if (this._searchDataLoaded) return;
        const cache = this.cardManager.allCardsCache;
        if (!cache || cache.length === 0) return;

        // TSV searchText
        const cardTypes = this.cardManager.getAllCardTypes();
        const typeConfigs = this.cardManager.getCardTypes();
        for (const cardType of cardTypes) {
            const config = typeConfigs[cardType];
            if (!config || !config.searchFile) continue;
            try {
                const searchMap = await this.cardManager.tsvLoader.loadSearch(config);
                for (const card of cache) {
                    if (card.type === cardType && !card.searchText) {
                        card.searchText = searchMap.get(card.id) || '';
                    }
                }
            } catch (e) { /* skip */ }
        }

        // 预加载所有 JSON 文件，构建完整可搜索数据库
        for (const cardType of cardTypes) {
            await this._loadJsonCache(cardType);
        }
        console.log('[AI Init] JSON cache total:', this._jsonCache.size, 'cards across all types');

        this._searchDataLoaded = true;
    }

    // 加载聊天历史
    _loadHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.AI_CHAT_HISTORY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    // 只保留最近的 N 条
                    this._history = parsed.slice(-CONFIG_AI.maxHistoryMessages);
                }
            }
        } catch (e) {
            this._history = [];
        }
    }

    // 保存聊天历史
    _saveHistory() {
        try {
            const toSave = this._history.slice(-CONFIG_AI.maxHistoryMessages);
            localStorage.setItem(STORAGE_KEYS.AI_CHAT_HISTORY, JSON.stringify(toSave));
        } catch (e) { /* ignore */ }
    }

    // 清除聊天历史
    clearHistory() {
        this._history = [];
        try {
            localStorage.removeItem(STORAGE_KEYS.AI_CHAT_HISTORY);
        } catch (e) { /* ignore */ }
    }

    // 获取历史
    getHistory() {
        return [...this._history];
    }

    // 从用户消息中提取卡牌相关的搜索词（宽松提取，搜索时再验证）
    _extractKeywords(message) {
        const keywords = new Set();

        // 1. 属性关键词（雷→搜雷属性卡牌）
        const typeAliases = {
            '雷系': '雷', '雷属性': '雷', '电系': '雷', '电属性': '雷',
            '火系': '火', '火属性': '火', '水系': '水', '水属性': '水',
            '草系': '草', '草属性': '草', '斗系': '斗', '格斗系': '斗', '斗属性': '斗',
            '超系': '超', '超能系': '超', '超属性': '超', '恶系': '恶', '恶属性': '恶',
            '钢系': '钢', '钢属性': '钢', '妖系': '妖', '妖精系': '妖',
            '龙系': '龙', '龙属性': '龙', '无色': '无', '一般系': '无'
        };
        for (const [alias, attr] of Object.entries(typeAliases)) {
            if (message.includes(alias)) {
                keywords.add(attr);
            }
        }

        // 2. 带标记的卡牌名：从 ex/VSTAR/VMAX/V/GX 标记向前扫描中文名
        const markerFindPattern = /(ex|VSTAR|VMAX|V-UNION|GX)(?!\w)/gi;
        let match;
        while ((match = markerFindPattern.exec(message)) !== null) {
            // 从标记位置向前扫描中文
            const markerPos = match.index;
            let nameStart = markerPos - 1;
            while (nameStart >= 0 && /[一-鿿]/.test(message[nameStart])) {
                nameStart--;
            }
            nameStart++;
            const name = message.substring(nameStart, markerPos);
            if (name.length >= 2 && name.length <= 6 && /^[一-鿿]+$/.test(name)) {
                if (!this._isGenericWord(name)) {
                    keywords.add(name);
                }
            }
        }
        // 也匹配独立的 " V"（如"皮卡丘 V"）
        const vPattern = /\s(V)(?!\w)/gi;
        while ((match = vPattern.exec(message)) !== null) {
            let nameStart = match.index - 1;
            while (nameStart >= 0 && /[一-鿿]/.test(message[nameStart])) {
                nameStart--;
            }
            nameStart++;
            const name = message.substring(nameStart, match.index).trim();
            if (name.length >= 2 && name.length <= 6 && /^[一-鿿]+$/.test(name)) {
                if (!this._isGenericWord(name)) {
                    keywords.add(name);
                }
            }
        }

        // 3. 纯中文名称：提取 2-6 字中文 n-gram，仅保留能匹配到数据库卡名的
        for (let len = 6; len >= 2; len--) {
            for (let i = 0; i <= message.length - len; i++) {
                const substr = message.substring(i, i + len);
                if (/^[一-鿿]+$/.test(substr) && !this._isGenericWord(substr)) {
                    // 只有能匹配到实际卡名时才加入（减少噪音搜索）
                    if (this._matchesAnyCard(substr)) {
                        keywords.add(substr);
                    }
                }
            }
        }

        return [...keywords];
    }

    // 检查是否能在数据库中匹配到卡牌名
    _isRealCardName(name) {
        if (!name || name.length < 2) return false;
        const cache = this.cardManager.allCardsCache;
        if (!cache || cache.length === 0) return false;
        return cache.some(c => c.name && c.name.includes(name));
    }

    // 快速检查字符串是否能匹配到任何卡牌名（用于过滤 n-gram 关键词）
    _matchesAnyCard(name) {
        if (!name || name.length < 2) return false;
        // 优先用全局缓存，fallback 到当前页签
        const pool = (this.cardManager.allCardsCache && this.cardManager.allCardsCache.length > 0)
            ? this.cardManager.allCardsCache : (this.cardManager.cards || []);
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].name && pool[i].name.includes(name)) return true;
        }
        return false;
    }

    // 常见非卡牌游戏术语/普通词汇，不应作为搜索关键词
    _isGenericWord(word) {
        const generics = new Set([
            '帮我', '一套', '分析', '推荐', '卡组', '怎么', '为什么', '什么',
            '可以', '应该', '有没有', '能不能', '如何', '构筑', '建议', '谢谢',
            '请问', '我想', '想要', '组一', '组个', '组合', '这个', '那个',
            '哪些', '哪个', '这是', '是一个', '还是', '或者', '以及', '还有',
            '一下', '现在', '已经', '不是', '因为', '所以', '但是',
            '如果', '可能', '觉得', '认为', '需要', '比较', '主要',
            '用来', '作为', '比如', '包括', '就是', '的话', '那么',
            '厉害', '特别', '非常', '大概', '左右', '以上', '不如',
            '目前', '之前', '之后', '最近', '一直', '其实', '基本',
            '问题', '方面', '情况', '能力', '效果', '使用', '对方',
            '自己', '我们', '他们', '开始', '结束', '游戏',
            '注意', '补充', '参考', '说明', '特点', '优势', '劣势',
            '配合', '协同', '适合', '相关', '辅助', '帮忙', '帮我看',
            '找一', '找些', '有没有', '哪些卡', '有什么', '包括',
            '分析一下', '能帮', '好不', '行不', '可以吗', '怎么配',
            '作战', '对局', '环境', '主流', '常见', '推荐些',
            '最好', '最强', '厉害', '合理', '合适'
        ]);
        return generics.has(word);
    }

    // 属性名→字母代码映射
    _attrNameToCode(name) {
        const map = { '雷': 'L', '火': 'R', '水': 'W', '草': 'G',
            '斗': 'F', '超': 'P', '恶': 'D', '钢': 'M',
            '妖': 'Y', '龙': 'N', '无': 'C' };
        return map[name] || null;
    }

    // 构建卡牌上下文
    async buildCardContext(userMessage) {
        const keywords = this._extractKeywords(userMessage);
        console.log('[AI Search] Keywords extracted:', keywords);
        if (keywords.length === 0) {
            console.log('[AI Search] No keywords extracted — returning empty context');
            return '';
        }

        // 搜索源：allCardsCache（全局）+ 当前页签（作为补充）
        const globalCache = this.cardManager.allCardsCache || [];
        const currentCards = this.cardManager.cards || [];
        const allCards = globalCache.length > 0 ? globalCache : currentCards;
        console.log('[AI Search] globalCache:', globalCache.length, 'cards, currentCards:', currentCards.length, 'cards, using:', allCards.length, 'cards');

        if (allCards.length === 0) {
            console.log('[AI Search] No cards loaded at all — returning warning');
            return '> ⚠ 卡牌数据库尚未加载完成，无法提供卡牌数据。请基于通用 PTCG 知识回答，**不要编造具体的卡牌 ID**。如果用户问的是具体卡牌效果，请诚实说明你无法查证。';
        }

        // matchedById: Map<id, formattedString>
        // matchedCards: Map<id, rawCardObject> (for mechanic extraction)
        const matchedById = new Map();
        const matchedCards = new Map();
        const attrCodes = [];
        const nameKeywords = [];

        for (const kw of keywords) {
            const code = this._attrNameToCode(kw);
            if (code) {
                attrCodes.push(code);
            } else {
                nameKeywords.push(kw);
            }
        }

        // 添加匹配结果（双存储：格式化文本 + 原始对象）
        const _addMatch = (card, formatted) => {
            if (matchedById.has(card.id)) return false;
            matchedById.set(card.id, formatted);
            // 优先保留有 searchText 的版本
            if (!matchedCards.has(card.id) || (card.searchText && !matchedCards.get(card.id).searchText)) {
                matchedCards.set(card.id, card);
            }
            return true;
        };

        // 1. 按卡名搜索
        for (const keyword of nameKeywords) {
            const searchLower = keyword.toLowerCase();
            for (const card of allCards) {
                if (matchedById.size >= CONFIG_AI.maxContextCards) break;
                if (card.name && card.name.toLowerCase().includes(searchLower)) {
                    const enriched = this._enrichFromCurrentCards(card);
                    const richCard = currentCards.find(c => c.id === card.id) || card;
                    _addMatch(richCard, enriched);
                }
            }
            if (matchedById.size >= CONFIG_AI.maxContextCards) break;
        }

        // 2. 按属性搜索（限全局缓存，过滤只留 F/G/H/I）
        if (matchedById.size < CONFIG_AI.maxContextCards && attrCodes.length > 0 && globalCache.length > 0) {
            for (const card of globalCache) {
                if (matchedById.size >= CONFIG_AI.maxContextCards) break;
                const cardAttr = (card.attribute || '').toUpperCase();
                if (attrCodes.includes(cardAttr) && card.type === '宝可梦') {
                    const richCard = currentCards.find(c => c.id === card.id) || card;
                    const version = this._extractVersion(richCard);
                    if (version && !this._isCurrentFormat(version)) continue;
                    const enriched = this._enrichFromCurrentCards(card);
                    _addMatch(richCard, enriched);
                }
            }
        }

        if (matchedById.size === 0) {
            console.log('[AI Search] No matches found for keywords:', keywords);
            return `> ⚠ 在数据库中以关键词「${keywords.join(', ')}」未搜索到匹配的卡牌。请基于通用 PTCG 知识回答用户的问题，**绝对不要编造任何卡牌 ID 或精确效果文本**。如果用户的问题需要具体卡牌数据才能准确回答，请告知用户。`;
        }

        // 3. 选最丰富的主目标卡（优先有特性的），加载 JSON 提取专属搜索词
        let primaryCardId = null;
        let primaryJson = null;
        for (const [id, card] of matchedCards) {
            const json = await this._getFullCardData(id);
            if (json && (json['特性名字'] || json['特性效果'] || json['技能1']?.['名字'])) {
                primaryCardId = id;
                primaryJson = json;
                break;
            }
        }
        if (!primaryCardId) {
            primaryCardId = [...matchedCards.keys()][0];
            primaryJson = await this._getFullCardData(primaryCardId);
        }
        const targetTerms = primaryJson ? this._extractTargetSpecificTerms(primaryJson) : [];
        console.log('[AI Search] Primary card:', primaryCardId, '| Target-specific terms:', targetTerms);

        // 4. 扩展搜索：直接在 JSON 缓存中搜（精确 + 通用双通道）
        const genericTerms = ['伤害指示物', '弃牌区', '附着', '放置', '备战区', '备战宝可梦',
            '中毒', '麻痹', '混乱', '牌库', '手牌', '丢弃', '恢复', '抽出', '重洗'];
        const allTerms = [...new Set([...targetTerms, ...genericTerms])];
        if (allTerms.length > 0 && this._jsonCache.size > 0) {
            const scored = this._searchJsonCache(allTerms, [...matchedCards.keys()]);
            const limit = Math.min(25, CONFIG_AI.maxContextCards - matchedCards.size);
            let added = 0;
            for (const s of scored) {
                if (added >= limit) break;
                const basicCard = globalCache.find(c => c.id === s.id) || currentCards.find(c => c.id === s.id);
                if (basicCard) {
                    const version = this._extractVersion(basicCard);
                    if (version && !this._isCurrentFormat(version)) continue;
                }
                matchedCards.set(s.id, basicCard || { id: s.id });
                added++;
            }
            console.log('[AI Search] JSON expansion added', added, 'cards, top:', scored.slice(0, 5).map(s => `${s.id}=${s.score}`));
        }

        // 5. JSON 富化 + 相关性标注
        const matchedIds = [...matchedCards.keys()];
        const jsonDataMap = await this._getFullCardDataBatch(matchedIds);
        const scoredCards = []; // {id, formatted, score}
        if (jsonDataMap.size > 0) {
            console.log('[AI Search] JSON rich data loaded for', jsonDataMap.size, 'cards');
            for (const [id, jsonData] of jsonDataMap) {
                const basic = matchedCards.get(id);
                if (!basic) continue;
                let header = '';
                // 给目标卡本身加标记
                if (id === primaryCardId) {
                    header = '🎯 **【用户询问的目标卡】**\n';
                } else {
                    // 计算这张卡与目标卡的机制重叠度
                    const cardTerms = this._extractTargetSpecificTerms(jsonData);
                    const overlap = targetTerms.filter(t => cardTerms.includes(t));
                    if (overlap.length >= 3) {
                        header = `🔗 **【高度协同 · 机制重叠: ${overlap.slice(0, 3).join('、')}】**\n`;
                    } else if (overlap.length >= 1) {
                        header = `📎 **【可能协同 · ${overlap[0]}】**\n`;
                    }
                }
                const formatted = this._formatRichCardContext(id, jsonData, basic);
                scoredCards.push({ id, formatted: header + formatted, score: id === primaryCardId ? 999 : 0 });
            }
        } else {
            // fallback: 无 JSON 数据时用 TSV
            for (const [id, formatted] of matchedById) {
                scoredCards.push({ id, formatted, score: id === primaryCardId ? 999 : 0 });
            }
        }

        // 目标卡排第一，其余按 formatted 中的标注排列
        scoredCards.sort((a, b) => b.score - a.score);
        const cardsList = scoredCards.slice(0, 30).map(c => c.formatted);
        console.log('[AI Search] Final output:', cardsList.length, 'cards (ranked by relevance)');

        return [
            '## 相关卡牌数据（本地数据库 · JSON完整数据 · 按协同度排序）',
            '> 标记说明：🎯=你问的目标卡 | 🔗=高度协同 | 📎=可能相关',
            `> 共 ${cardsList.length} 张。当前简中标准环境 **F/G/H/I 标**——[A-E标·已退环境] 卡不可使用。`,
            '> ⚠ 仅推荐 [F/G/H/I标✓] 的卡，有 [A-E标·已退环境] 标记的卡**绝对不能使用**。',
            '',
            cardsList.join('\n\n')
        ].join('\n');
    }

    // 从已匹配卡牌的效果文本中提取机制关键词，用于扩展搜索配合卡
    _extractMechanicTerms(matchedCards) {
        const termFreq = new Map();
        const knownNames = new Set();
        for (const card of matchedCards.values()) {
            if (card.name) knownNames.add(card.name);
        }

        // 这些是每张卡都有的通用词，不能用作扩展搜索
        const tooCommon = new Set([
            '能量', '特性', '进化', '基础', '招式', 'HP', '撤退',
            '选择', '查看', '使用', '可以', '自己', '对方',
            '弱点', '抵抗力', '奖品', '额外',
        ]);

        // 高价值机制词——能真正反映卡牌独特功能
        const mechanics = [
            '伤害指示物', '弃牌区', '放置', '附着', '中毒', '麻痹', '混乱',
            '牌库', '手牌', '备战区', '战斗场', '丢弃', '恢复',
            '抽出', '重洗', '宝可梦道具', '支援者', '竞技场',
            '烧伤', '睡眠', '特殊状态', '无法',
        ];

        for (const card of matchedCards.values()) {
            const text = (card.searchText || '') + ' ' + (card.name || '');
            if (!text) continue;

            for (const term of mechanics) {
                if (text.includes(term)) {
                    termFreq.set(term, (termFreq.get(term) || 0) + 1);
                }
            }
        }

        // 按特异性排序：长词优先（更具体），频率打破平局，过滤通用词和卡名
        const sorted = [...termFreq.entries()]
            .filter(([term]) => !knownNames.has(term) && !tooCommon.has(term))
            .sort((a, b) => {
                // 长词（更具体）优先
                const lenDiff = b[0].length - a[0].length;
                if (lenDiff !== 0) return lenDiff;
                return b[1] - a[1];
            })
            .map(e => e[0])
            .slice(0, 8);

        console.log('[AI Search] Mechanic terms extracted:', sorted);
        this._lastMechanicTerms = sorted.join(', ');
        return sorted;
    }

    // 从 JSON 数据中提取卡牌专属的机制关键词（用于针对性扩展搜索）
    _extractTargetSpecificTerms(jsonData) {
        const terms = new Set();
        // 收集所有效果文本
        const textParts = [];
        if (jsonData['特性效果']) textParts.push(jsonData['特性效果']);
        for (let i = 1; i <= 4; i++) {
            const skill = jsonData[`技能${i}`];
            if (skill && skill['效果'] && skill['效果'] !== '无') {
                textParts.push(skill['效果']);
            }
            if (skill && skill['名字']) {
                textParts.push(skill['名字']); // 招式名也作为搜索词
            }
        }
        if (jsonData['特性名字']) textParts.push(jsonData['特性名字']);
        if (jsonData['效果']) textParts.push(jsonData['效果']); // 支援者/物品等
        const allText = textParts.join(' ');

        // 需要能量的类型
        if (jsonData['属性']) {
            terms.add(jsonData['属性'] + '能量');
        }
        // 提取招式消耗中的能量类型
        for (let i = 1; i <= 4; i++) {
            const skill = jsonData[`技能${i}`];
            if (skill && Array.isArray(skill['消耗'])) {
                for (const cost of skill['消耗']) {
                    if (cost !== '无') terms.add(cost + '能量');
                }
            }
        }
        // 进化链
        if (jsonData['进化自']) terms.add(jsonData['进化自']);

        // 从效果文本中提取关键机制词组
        const keyPatterns = [
            '弃牌区', '伤害指示物', '备战区', '备战宝可梦', '战斗场', '战斗宝可梦',
            '牌库', '手牌', '附着', '放置', '丢弃', '恢复', '抽出',
            '中毒', '麻痹', '混乱', '烧伤', '睡眠',
            '进化', '基础宝可梦', '1阶进化', '2阶进化',
            '宝可梦道具', '支援者', '竞技场', '特殊能量', '基本能量',
            '奖赏卡', '奖品', '弱点', '抵抗力', '撤退',
            '特性', '招式',
            '查看', '选择', '重洗', '无法',
        ];
        for (const pattern of keyPatterns) {
            if (allText.includes(pattern)) {
                terms.add(pattern);
            }
        }

        // 招式名和特性名（这些是卡牌的核心标识特征）
        if (jsonData['特性名字']) terms.add(jsonData['特性名字']);
        for (let i = 1; i <= 4; i++) {
            const skill = jsonData[`技能${i}`];
            if (skill && skill['名字']) terms.add(skill['名字']);
        }
        // 支援者/物品/道具的名字
        if (jsonData['卡牌名字']) terms.add(jsonData['卡牌名字']);

        return [...terms];
    }

    // 在 JSON 缓存中搜索匹配指定关键词的卡，按命中数排序
    _searchJsonCache(terms, excludeIds = []) {
        const exclude = new Set(excludeIds);
        const scored = [];
        for (const [id, data] of this._jsonCache) {
            if (exclude.has(id)) continue;
            const text = this._jsonCardToSearchText(data);
            let score = 0;
            for (const term of terms) {
                if (text.includes(term)) score++;
            }
            if (score > 0) {
                scored.push({ id, score });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    // 将 JSON 卡牌数据转为可搜索的纯文本
    _jsonCardToSearchText(data) {
        const parts = [];
        if (data['宝可梦名字']) parts.push(data['宝可梦名字']);
        if (data['卡牌名字']) parts.push(data['卡牌名字']);
        if (data['进化阶段']) parts.push(data['进化阶段']);
        if (data['进化自']) parts.push(data['进化自']);
        if (data['属性']) parts.push(data['属性']);
        if (data['特性名字']) parts.push(data['特性名字']);
        if (data['特性效果']) parts.push(data['特性效果']);
        if (data['卡牌类型']) parts.push(data['卡牌类型']);
        for (let i = 1; i <= 4; i++) {
            const skill = data[`技能${i}`];
            if (skill) {
                if (skill['名字']) parts.push(skill['名字']);
                if (skill['效果'] && skill['效果'] !== '无') parts.push(skill['效果']);
                if (Array.isArray(skill['消耗'])) parts.push(skill['消耗'].join(' '));
            }
        }
        if (data['效果']) parts.push(data['效果']);
        if (data['规则']) parts.push(data['规则']);
        if (data['弱点']) parts.push(data['弱点']);
        return parts.join(' ');
    }

    // 尝试从当前加载的卡牌中补全 searchText/filter 数据
    _enrichFromCurrentCards(cacheCard) {
        const currentCards = this.cardManager.cards || [];
        const enriched = currentCards.find(c => c.id === cacheCard.id);
        if (enriched && (enriched.searchText || enriched.filter)) {
            return this._formatCardContext(enriched, true);
        }
        return this._formatCardContext(cacheCard, false);
    }

    // 从 searchText 中提取版本/赛标字母
    _extractVersion(card) {
        if (!card.searchText) return null;
        // searchText 格式:
        //   宝可梦:    "name version number attr hp stage attacks..."
        //   支援者/物品/道具/竞技场/能量: "name type_label version effect..."
        // 版本字母位置：
        //   宝可梦 → index 1 (第二个 token)
        //   其他   → index 2 (第三个 token)
        const parts = card.searchText.split(/\s+/);
        if (parts.length < 2) return null;
        const idx = card.type === '宝可梦' ? 1 : 2;
        if (parts.length > idx) {
            const v = parts[idx].toUpperCase();
            if (/^[A-I]$/.test(v)) return v;
        }
        return null;
    }

    // 当前简中标准环境（F/G/H/I 标）
    _isCurrentFormat(version) {
        return version && /^[FGHI]$/i.test(version);
    }

    // 格式化单张卡牌为上下文文本
    _formatCardContext(card, hasSupplementalData) {
        const parts = [];
        // 提取版本标记
        const version = this._extractVersion(card);
        const isLegal = this._isCurrentFormat(version);
        const envTag = version ? (isLegal ? ` [${version}标✓]` : ` [${version}标·已退环境]`) : '';

        parts.push(`**${card.name}**${envTag}`);
        parts.push(`- ID: \`${card.id}\``);
        parts.push(`- 类型: ${card.type || '未知'}`);

        // 属性信息
        const attr = card.attribute || '';
        if (attr) {
            const attrNames = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷',
                'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
            const attrName = attrNames[attr] || attr;
            parts.push(`- 属性: ${attrName}`);
        }
        if (card.number && card.number !== '未知') {
            parts.push(`- 编号: ${card.number}`);
        }

        // 筛选数据（HP、阶段等）
        if (hasSupplementalData && card.filter) {
            const f = card.filter;
            if (f.hp != null) {
                parts.push(`- HP: ${f.hp}`);
            }
            if (f.stage != null && f.stage !== undefined) {
                const stages = { 0: '基础', 1: '一阶进化', 2: '二阶进化' };
                parts.push(`- 阶段: ${stages[f.stage] || f.stage}`);
            }
            if (f.retreat != null) {
                parts.push(`- 撤退: ${f.retreat}`);
            }
            if (f.costs) {
                parts.push(`- 招式能量需求: ${f.costs}`);
            }
            if (f.dmg) {
                parts.push(`- 招式伤害: ${f.dmg}`);
            }
        }

        // 搜索文本（包含技能名、特性名等关键信息）
        if (hasSupplementalData && card.searchText) {
            parts.push(`- 文本: ${card.searchText}`);
        }

        return parts.join('\n');
    }

    // 构建系统提示词
    buildSystemPrompt() {
        return SYSTEM_PROMPT;
    }

    // Agent 工具定义
    _getTools() {
        return [{
            type: 'function',
            function: {
                name: 'search_cards',
                description: '快速关键词搜索卡牌。支持卡名、效果词、属性。多个关键词空格分隔（AND逻辑）。用于快速找到目标卡或初步探索。如需精确模式匹配用grep_cards。',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '搜索关键词，空格分隔。例："沙奈朵ex"、"伤害指示物 弃牌区"、"超 无 无"' },
                        card_type: { type: 'string', enum: ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'], description: '限定类型。不传=全部' },
                        limit: { type: 'integer', description: '返回数量，默认20，最大50' }
                    },
                    required: ['query']
                }
            }
        }, {
            type: 'function',
            function: {
                name: 'grep_cards',
                description: '【精准搜索】使用正则表达式搜索卡牌数据库的全部文本字段（卡名、特性效果、招式效果、规则等）。返回匹配卡牌+命中原文片段。适合精确查找特定效果模式，如：找所有"伤害随伤害指示物增加"的卡、找所有"从弃牌区附着能量"的卡。可同时传多个pattern批量搜索不同方向。',
                parameters: {
                    type: 'object',
                    properties: {
                        patterns: { type: 'string', description: '正则表达式。可传多个pattern用||分隔，同时搜多个方向。例："伤害指示物.*[×xX]|[×xX].*伤害指示物|每有.*伤害指示物"、"(弃牌区|坟场).*(能量|附着)"、"(备战|后场).*特性"' },
                        card_type: { type: 'string', enum: ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'], description: '限定类型，不传=全部' },
                        limit: { type: 'integer', description: '每方向返回上限，默认10，最大20' }
                    },
                    required: ['patterns']
                }
            }
        }, {
            type: 'function',
            function: {
                name: 'deep_analysis',
                description: '【一键深度分析】输入卡牌名即可。自动完成：找卡→识别机制→多方向搜索→验证候选→打分排序→生成分析报告。一次调用返回完整的协同分析数据，你只需基于报告写分析。',
                parameters: {
                    type: 'object',
                    properties: {
                        card_name: { type: 'string', description: '卡牌名称，如"沙奈朵ex"、"喷火龙VSTAR"' }
                    },
                    required: ['card_name']
                }
            }
        }, {
            type: 'function',
            function: {
                name: 'search_synergies',
                description: '快速初步协同分析。如需完整深度分析请用 deep_analysis。',
                parameters: {
                    type: 'object',
                    properties: {
                        card_id: { type: 'string', description: '目标卡ID，从search_cards获取' }
                    },
                    required: ['card_id']
                }
            }
        }, {
            type: 'function',
            function: {
                name: 'get_card_detail',
                description: '获取单卡完整数据。**在将任何卡写入最终分析前必须调用此工具确认其效果。**不要仅凭搜索摘要就下结论。',
                parameters: {
                    type: 'object',
                    properties: {
                        card_id: { type: 'string', description: '卡牌ID' }
                    },
                    required: ['card_id']
                }
            }
        }];
    }

    // 执行工具调用（toolCall 是已解析的 {id, name, arguments} 格式）
    async _executeToolCall(toolCall) {
        const name = toolCall.name;
        const argStr = toolCall.arguments || toolCall.args || '{}';
        let args = {};
        try { args = JSON.parse(argStr); } catch (e) { /* */ }

        console.log('[AI Agent] Tool call:', name, 'raw:', toolCall.arguments?.slice(0, 100), 'parsed:', JSON.stringify(args));

        switch (name) {
            case 'search_cards':
                return this._toolSearchCards(args.query, args.card_type, args.limit || 15);
            case 'grep_cards':
                return this._toolGrepCards(args.patterns, args.card_type, args.limit || 10);
            case 'deep_analysis':
                return await this._toolDeepAnalysis(args.card_name);
            case 'search_synergies':
                return this._toolSearchSynergies(args.card_id);
            case 'get_card_detail':
                return this._toolGetCardDetail(args.card_id);
            default:
                return JSON.stringify({ error: `未知工具: ${name}` });
        }
    }

    // search_cards 实现：在 JSON 缓存和 TSV 缓存中搜索
    _toolSearchCards(query, cardType, limit) {
        if (!query || query.trim().length === 0) return '错误：请提供搜索关键词。例：search_cards("好友宝芬", "支援者")';
        limit = Math.min(limit || 20, 50);

        const terms = query.split(/\s+/).filter(t => t.length > 0);
        const results = [];

        // 搜索 JSON 缓存（有完整结构化数据）
        for (const [id, data] of this._jsonCache) {
            if (cardType) {
                let type = data['卡牌类型'] || '';
                if (!type && data['宝可梦名字']) type = '宝可梦';
                // 标准化：去掉「卡」后缀
                if (type.endsWith('卡')) type = type.slice(0, -1);
                if (type !== cardType) continue;
            }
            const text = this._jsonCardToSearchText(data);
            let score = 0;
            for (const term of terms) {
                if (text.includes(term)) score++;
            }
            if (score > 0) {
                results.push({ id, score, data });
            }
        }

        // 如果 JSON 缓存没结果，fallback 到 TSV 缓存
        if (results.length === 0) {
            const cache = this.cardManager.allCardsCache || [];
            for (const card of cache) {
                if (cardType && card.type !== cardType) continue;
                const searchField = (card.searchText || '') + ' ' + (card.name || '');
                let score = 0;
                for (const term of terms) {
                    if (searchField.toLowerCase().includes(term.toLowerCase())) score++;
                }
                if (score > 0) results.push({ id: card.id, score, data: null });
            }
        }

        results.sort((a, b) => b.score - a.score);
        const top = results.slice(0, limit);

        // 格式化为 AI 可读的文本
        const formatted = top.map(r => {
            if (r.data) {
                const detail = this._summarizeCardQuick(r.data);
                const name = r.data['宝可梦名字'] || r.data['卡牌名字'] || '未知';
                const type = r.data['卡牌类型'] || (r.data['宝可梦名字'] ? '宝可梦' : '');
                return `- **${name}** [ID:${r.id}] [${type}]\n  ${detail}`;
            } else {
                return `- **${r.id}** (相关度:${r.score})`;
            }
        }).join('\n');

        return `找到 ${results.length} 张卡，返回前 ${top.length} 张:\n\n${formatted}\n\n---\n提示: 用 get_card_detail(ID) 查看完整效果。需更精确搜索用 grep_cards。`;
    }

    // grep_cards 实现：正则精准搜索
    _toolGrepCards(patterns, cardType, limit) {
        if (!patterns) return JSON.stringify({ error: '请提供正则表达式' });
        limit = Math.min(limit || 10, 20);

        // 支持多个 pattern 用 || 分隔（每个 pattern 独立搜索，结果合并去重）
        const patternList = patterns.split('||').map(p => p.trim()).filter(p => p.length > 0);
        const allResults = new Map(); // id -> {score, matches}

        for (const patternStr of patternList) {
            let regex;
            try {
                regex = new RegExp(patternStr, 'i');
            } catch (e) {
                return JSON.stringify({ error: `正则表达式错误: ${e.message}。pattern: "${patternStr}"。请修正后重试。` });
            }

            for (const [id, data] of this._jsonCache) {
                if (cardType) {
                    let type = data['卡牌类型'] || '';
                    if (!type && data['宝可梦名字']) type = '宝可梦';
                    if (type.endsWith('卡')) type = type.slice(0, -1);
                    if (type !== cardType) continue;
                }
                // 版本过滤
                const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
                if (version && !'FGHI'.includes(version.toUpperCase())) continue;

                const text = this._jsonCardToSearchText(data);
                const matches = [];
                let match;
                const regexClone = new RegExp(patternStr, 'gi');
                while ((match = regexClone.exec(text)) !== null) {
                    const ctx = this._extractMatchContext(text, match.index, match[0]);
                    matches.push(ctx);
                    if (matches.length >= 3) break; // 最多3个匹配片段
                }

                if (matches.length > 0) {
                    const existing = allResults.get(id);
                    if (existing) {
                        existing.score += matches.length;
                        existing.matches.push(...matches);
                    } else {
                        const name = data['宝可梦名字'] || data['卡牌名字'] || id;
                        allResults.set(id, { id, name, data, score: matches.length, matches });
                    }
                }
            }
        }

        if (allResults.size === 0) {
            return `grep_cards("${patterns}"): 未找到匹配的卡牌。建议：\n- 简化正则（去掉复杂的前后断言）\n- 用更宽泛的关键词\n- 换个方向搜索`;
        }

        // 排序：匹配数降序
        const sorted = [...allResults.values()].sort((a, b) => b.score - a.score);
        const top = sorted.slice(0, limit);
        const formatted = top.map(c => {
            const snippets = [...new Set(c.matches)].slice(0, 2).map(m => `"${m}"`).join('\n    ');
            const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
            const detail = this._summarizeCardQuick(c.data);
            return `- **${c.name}** [ID:${c.id}] [${type}]\n  ${detail}\n  命中: ${snippets}`;
        }).join('\n');

        return [
            `## grep_cards 结果: \`${patterns}\``,
            `> 共 ${allResults.size} 张卡匹配，返回前 ${top.length} 张（仅F/G/H/I标）`,
            '',
            formatted,
            '',
            '---',
            '> 对匹配的卡用 get_card_detail(ID) 确认效果后再写入分析。'
        ].join('\n');
    }

    // 从文本中提取匹配位置的上下文（前后各30字符）
    _extractMatchContext(text, matchIndex, matchText) {
        const start = Math.max(0, matchIndex - 30);
        const end = Math.min(text.length, matchIndex + matchText.length + 30);
        let ctx = text.slice(start, end);
        if (start > 0) ctx = '…' + ctx;
        if (end < text.length) ctx = ctx + '…';
        return ctx;
    }

    // deep_analysis 实现：一键深度分析 — 找到卡 → 全方向搜索 → 验证 → 打分 → 生成报告
    async _toolDeepAnalysis(cardName, filters = {}) {
        if (!cardName) return '错误：请提供卡牌名称';

        // 1. 找到目标卡
        const searchResult = this._toolSearchCards(cardName, null, 5);
        // 解析第一个匹配的卡ID
        const idMatch = searchResult.match(/\*\*(.+?)\*\*\s*\[ID:(\d+)\]/);
        if (!idMatch) return `未找到"${cardName}"。请检查卡名拼写。`;
        const targetId = idMatch[2];
        const targetData = this._jsonCache.get(targetId);
        if (!targetData) return `找到ID ${targetId} 但无JSON数据。`;

        const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || cardName;
        const results = [];

        // 2. 目标卡详情
        results.push(this._formatRichCardContext(targetId, targetData, {}));
        const props = this._getCardStrategicProps(targetData);
        results.push(`\n🏷 战略属性: ${props.prizes}奖品 | ${props.stage} | ${props.scaling} | 最高${props.maxEnergy}能`);

        // 3. 多方向搜索
        // 提取目标卡提供的能量类型和属性
        const targetAttr = targetData['属性'] || '';
        const abilityText = (targetData['特性效果'] || '').toLowerCase();

        // 判断目标卡特性是否限定宝可梦类型（如"给超宝可梦附着"）
        const attrNames = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
        const targetAttrName = attrNames[targetAttr] || targetAttr;
        const restrictedToType = abilityText.includes(targetAttrName + '宝可梦') || abilityText.includes('基本' + targetAttrName + '能量');

        // 判断目标卡是"提供能量"还是"消耗能量"
        const targetEffects = (targetData['特性效果'] || '') + ' ' + (targetData['效果'] || '');
        const providesEnergy = /附着.*能量|能量.*附着|填能/.test(targetEffects) &&
            /弃牌区|牌库|手牌|特性/.test(targetEffects);

        const allCards = new Map();

        // 0. 基础池：所有同属性 + 所有伤指物相关的宝可梦（不管有没有被后续搜索命中）
        for (const [id, data] of this._jsonCache) {
            if (!data['宝可梦名字']) continue;
            const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
            if (version && !'FGHI'.includes(version.toUpperCase())) continue;
            const isTargetType = data['属性'] === targetAttr;
            const text = this._jsonCardToSearchText(data);
            const hasDmgCtr = text.includes('伤害指示物');
            if (isTargetType || hasDmgCtr) {
                allCards.set(id, { data, grepScore: 0, grepMatches: isTargetType ? ['同属性'] : ['伤指物相关'] });
            }
        }

        // 高能量需求打手：仅在目标卡提供能量时推荐（否则是抢能量，不是协同）
        if (providesEnergy) {
            const highEnergyCards = this._findHighEnergyAttackers(targetData);
            if (highEnergyCards.length > 0) {
                results.push(`\n## 高能量需求打手\n(目标卡可提供能量加速，需3能以上+${targetAttr}能量，${highEnergyCards.length}张)\n`);
            results.push(highEnergyCards.slice(0, 40).map((c, i) => {
                const existing = allCards.get(c.id);
                if (existing) {
                    existing.grepScore += (highEnergyCards.length - i);
                    existing.grepMatches.push('高能量需求打手');
                } else {
                    allCards.set(c.id, { data: c.data, grepScore: highEnergyCards.length - i, grepMatches: ['高能量需求打手'] });
                }
                const props = this._getCardStrategicProps(c.data);
                const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
                const incompat = this._getIncompatibilityReason(targetData, c.data);
                const warn = incompat ? ` ⚠${incompat}` : '';
                return `- **${c.name}** [ID:${c.id}] [${type}] (${props.prizes}奖|${props.stage}|${props.scaling})${warn}`;
            }).join('\n'));
        }

        const grepPatterns = [
            { label: '伤害指示物协同', pattern: '伤害指示物.*[×xX*]|[×xX*].*伤害指示物|每有.*伤害指示物|伤害指示物.*数量|伤害指示物.*增加', type: null },
            { label: '弃牌区能量利用', pattern: '弃牌区.*能量.*(附着|选择|加入)|能量.*弃牌区', type: null },
            { label: '备战区协同', pattern: '(备战区|备战宝可梦).*(特性|触发|效果)|附着.*备战', type: '宝可梦' },
            { label: '进化辅助', pattern: '进化.*(牌库|选择|糖果)|糖果', type: null },
        ];

        for (const gp of grepPatterns) {
            try {
                const result = this._toolGrepCardsInternal(gp.pattern, gp.type, 30);
                let section = `\n## ${gp.label}\n`;
                if (result.length === 0) {
                    section += '(未找到匹配卡牌)\n';
                } else {
                    // 过滤不兼容的卡
                    const compatible = result.filter(c => this._isCompatibleSynergy(targetData, c.data));
                    const skipped = result.length - compatible.length;
                    if (compatible.length === 0) {
                        section += `(找到${result.length}张但均不兼容——能量类型不匹配或其他)\n`;
                    } else {
                        if (skipped > 0) section += `(已过滤${skipped}张不兼容卡)\n`;
                        section += compatible.map((c, i) => {
                            const existing = allCards.get(c.id);
                            if (existing) {
                                existing.grepScore += (compatible.length - i);
                                existing.grepMatches.push(gp.label);
                            } else {
                                allCards.set(c.id, { data: c.data, grepScore: compatible.length - i, grepMatches: [gp.label] });
                            }
                            const props = this._getCardStrategicProps(c.data);
                            const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
                            const incompat = this._getIncompatibilityReason(targetData, c.data);
                            const warn = incompat ? ` ⚠${incompat}` : '';
                            return `- **${c.name}** [ID:${c.id}] [${type}] (${props.prizes}奖|${props.stage}|${props.scaling})${warn}`;
                        }).join('\n');
                    }
                }
                results.push(section);
            } catch (e) { /* skip failed pattern */ }
            }
        } else {
            // 目标卡不提供能量 → 搜索能量加速辅助卡
            results.push(`\n## 能量加速辅助 (目标卡需要大量${targetAttr}能量)\n`);
            const accelCards = [];
            for (const [id, data] of this._jsonCache) {
                if (!data['宝可梦名字'] && data['卡牌类型'] && !data['卡牌类型'].includes('宝可梦')) continue;
                const text = this._jsonCardToSearchText(data);
                const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
                if (version && !'FGHI'.includes(version.toUpperCase())) continue;
                if (text.includes('能量') && (text.includes('附着') || text.includes('填能') || text.includes('弃牌区')) &&
                    (text.includes(targetAttr) || data['属性'] === targetAttr)) {
                    accelCards.push({ id, name: data['宝可梦名字'] || data['卡牌名字'] || id, data });
                }
            }
            if (accelCards.length > 0) {
                results.push(accelCards.slice(0, 8).map(c => `- **${c.name}** [ID:${c.id}]`).join('\n'));
            } else {
                results.push('(未找到专用能量加速卡，可考虑通用填能支援者如赤松等)');
            }
        }

        // 4. 统一打分 + 去重 (v6 新评分引擎)
        console.log('[AI DeepAnalysis] v6 scoring engine active. Cards to score:', allCards.size);
        const ranked = [...allCards.entries()]
            .map(([id, info]) => {
                const data = info.data;
                if (!data['宝可梦名字']) return null; // 跳过非宝可梦

                // === 硬性门槛 ===
                // 目标卡提供的能量只能给同属性宝可梦用
                const axes = this._scoreSynergyAxes(targetData, data);
                const sameType = data['属性'] === targetAttr;
                if (!sameType) return null; // 异属性直接排除
                // 应用阶段/规则过滤
                if (filters.stage === 'basic' && !(data['进化阶段'] || '').includes('基础')) return null;
                if (filters.noEx && data['规则'] && /ex|VSTAR|VMAX|V/.test(data['规则'])) return null;

                // === 统一打分 (v7 协同优先) ===
                const props = this._getCardStrategicProps(data);
                let score = 0;
                const reasons = [];

                // 计算伤害（含缩放估算）
                let maxDamage = 0;
                let hasScaling = false;
                for (let i = 1; i <= 4; i++) {
                    const s = data[`技能${i}`];
                    if (s && s['伤害']) {
                        const raw = parseInt(s['伤害']) || 0;
                        if (/[×xX*]/.test(String(s['伤害']) + (s['效果'] || ''))) {
                            hasScaling = true;
                            const m = (String(s['伤害']) + (s['效果'] || '')).match(/([0-9]+)\s*[×xX*]/);
                            const base = m ? parseInt(m[1]) : raw;
                            maxDamage = Math.max(maxDamage, Math.min(base * 6, 300));
                        } else {
                            maxDamage = Math.max(maxDamage, raw);
                        }
                    }
                }

                // 能量需求
                let energyNeed = 0;
                for (let i = 1; i <= 4; i++) {
                    const s = data[`技能${i}`];
                    if (s && Array.isArray(s['消耗'])) {
                        energyNeed += s['消耗'].filter(c => c === targetAttr).length;
                    }
                }
                const cardFullText = this._jsonCardToSearchText(data);
                const selfAccel = /附着.*能量|能量.*附着/.test(cardFullText) &&
                    /弃牌区|牌库/.test(cardFullText);

                // 特征标签
                const tags = this._generateCardTags(data);

                // === 核心：协同质量分 (0-55) ===
                if (tags.includes('伤指物缩放')) {
                    // 伤害随"自己身上"的伤指物增长 → 沙奈朵每回合+2 → 天花板极高
                    score += 55; reasons.push('伤指物缩放');
                } else if (tags.includes('伤指物转移-进攻')) {
                    // 把自己身上的伤指物转给对手 → 沙奈朵放的伤指物变成武器
                    score += 45; reasons.push('伤指物转攻');
                } else if (tags.includes('伤指物治疗')) {
                    // 回复伤指物 → 可以消除沙奈朵的副作用
                    score += 25; reasons.push('伤指物治疗');
                } else if (tags.includes('能量缩放') && !tags.includes('自填能') && !tags.includes('能量减免')) {
                    score += 35; reasons.push('能量缩放');
                } else if (tags.includes('伤指物操作-对手') || tags.includes('铺伤-对手')) {
                    // 操作对手的伤指物 → 跟沙奈朵无关
                    score += 5; reasons.push('对手伤指物(无关)');
                } else if (tags.includes('伤指物相关')) {
                    // 伤指物和×都出现但方向不明 → 低分
                    score += 10; reasons.push('伤指物弱关联');
                } else if (energyNeed >= 3 && !tags.includes('自填能') && !tags.includes('能量减免')) {
                    score += 20; reasons.push('高能需求');
                } else if (energyNeed >= 2 && !tags.includes('自填能') && !tags.includes('能量减免')) {
                    score += 10; reasons.push('需能');
                } else {
                    score += 3; reasons.push('同属');
                }

                // 战略价值加分 + 惩罚
                score += this._getStrategicBonus(data, tags);
                if (tags.some(t => t.startsWith('需') && t.endsWith('能前提'))) {
                    score -= 15; reasons.push('需异色能');
                }
                if (tags.includes('副作用-无法连攻')) { score -= 12; reasons.push('无法连攻'); }
                if (tags.includes('副作用-自伤')) { score -= 6; reasons.push('自伤'); }
                if (tags.includes('后排攻击')) reasons.push('后排攻击');
                if (tags.includes('手牌干扰')) reasons.push('干扰');
                if (tags.includes('伤指物转移-进攻')) reasons.push('转伤指物');

                // === 伤害输出分 (0-20) ===
                if (maxDamage >= 180) score += 20;
                else if (maxDamage >= 120) score += 14;
                else if (maxDamage >= 70) score += 8;
                else score += 3;

                // === 卡牌质量分 (0-25) ===
                // 部署
                score += props.deployScore * 3;
                if (props.stage === '基础') reasons.push('基础');
                // 奖品
                score += props.prizeScore * 3;
                if (props.prizes === 1) reasons.push('1奖');
                // HP
                const hp = parseInt(data['HP']) || 0;
                if (hp > 120) { score += 7; reasons.push(`HP${hp}`); }
                else if (hp > 80) score += 4;
                else score += 1;

                // 协同乘数：目标卡填能的核心受益者是"需要大量同色能量的打手"和"伤指物缩放卡"
                // 自我填能惩罚
                if (selfAccel) { score = Math.floor(score * 0.5); reasons.push('自填能'); }

                return {
                    id, name: data['宝可梦名字'] || id, data,
                    score, reasons, props,
                    grepMatches: info.grepMatches,
                };
            })
            .filter(r => r !== null)
            .sort((a, b) => b.score - a.score);

        // 去重
        const seenNames = new Set();
        const deduped = [];
        for (const r of ranked) {
            if (!seenNames.has(r.name)) {
                seenNames.add(r.name);
                deduped.push(r);
            }
        }
        console.log('[AI DeepAnalysis] Top 5 scores:', JSON.stringify(deduped.slice(0, 5).map(r => ({ name: r.name, score: r.score, reasons: r.reasons }))));

        // 5. 最佳打手
        const best = deduped.slice(0, 8);
        results.push('\n---\n## 🏆 综合排名（按部署难度/奖品效率/缩放上限/能量协同打分）\n');
        best.forEach((c, i) => {
            const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
            const marker = i < 3 ? '⭐' : '';
            results.push(`${marker} **${c.name}** [ID:${c.id}] [${type}] 得分:${c.score}`);
            results.push(`  战略: ${c.props.prizes}奖|${c.props.stage}|${c.props.scaling}|最高${c.props.maxEnergy}能`);
            results.push(`  匹配: ${c.grepMatches.join('、')} | 评分: ${c.reasons.join('; ')}`);
            const detail = this._summarizeCardQuick(c.data);
            results.push(`  效果: ${detail}`);
        });

        // 6. get_card_detail 验证前3名
        results.push('\n---\n## 🔍 顶级候选卡完整效果验证\n');
        for (const c of best.slice(0, 3)) {
            const detail = this._toolGetCardDetail(c.id);
            results.push(`### ${c.name} [ID:${c.id}]\n${detail}\n`);
        }

        return results.join('\n');
    }

    // grep_cards 内部版本（不格式化输出，返回原始数据供 deep_analysis 使用）
    _toolGrepCardsInternal(patterns, cardType, limit) {
        const patternList = patterns.split('||').map(p => p.trim()).filter(p => p.length > 0);
        const allResults = new Map();
        for (const patternStr of patternList) {
            let regex;
            try { regex = new RegExp(patternStr, 'i'); } catch (e) { continue; }
            for (const [id, data] of this._jsonCache) {
                if (cardType) {
                    let type = data['卡牌类型'] || '';
                    if (!type && data['宝可梦名字']) type = '宝可梦';
                    if (type.endsWith('卡')) type = type.slice(0, -1);
                    if (type !== cardType) continue;
                }
                const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
                if (version && !'FGHI'.includes(version.toUpperCase())) continue;
                const text = this._jsonCardToSearchText(data);
                if (regex.test(text)) {
                    if (!allResults.has(id)) {
                        const name = data['宝可梦名字'] || data['卡牌名字'] || id;
                        allResults.set(id, { id, name, data, score: 0 });
                    }
                    allResults.get(id).score++;
                }
            }
        }
        return [...allResults.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    }

    // search_synergies 实现：通用版 —— 适用于任何卡牌，自动分析机制并搜索协同
    _toolSearchSynergies(cardId) {
        if (!cardId) return '错误：请提供卡牌ID。从search_cards结果中复制ID再试。';
        const targetData = this._jsonCache.get(cardId);
        if (!targetData) {
            // 尝试模糊匹配
            for (const [id, data] of this._jsonCache) {
                const name = data['宝可梦名字'] || data['卡牌名字'] || '';
                if (name && cardId.includes(name)) {
                    return `未找到ID "${cardId}"，但你可能是想搜索"${name}"。请用search_cards("${name}")重新获取正确ID。在结果中已有ID的格式为准。`;
                }
            }
            return `未找到卡牌ID: "${cardId}"。请检查：1)ID是否从search_cards结果中复制？ 2)ID是否完整？建议重新search_cards获取正确ID。`;
        }

        const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || cardId;
        const seenIds = new Set([cardId]);
        const sections = [];

        // 版本过滤 helper
        const isLegal = (data) => {
            const v = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
            return !v || 'FGHI'.includes(v.toUpperCase());
        };

        // 收集目标卡的效果文本
        const abilityText = targetData['特性效果'] || '';
        const skillTexts = [];
        for (let i = 1; i <= 4; i++) {
            const s = targetData[`技能${i}`];
            if (s && s['名字']) {
                const cost = Array.isArray(s['消耗']) ? s['消耗'].join(' ') : '';
                const dmg = s['伤害'] || '';
                const eff = s['效果'] && s['效果'] !== '无' ? s['效果'] : '';
                skillTexts.push(`${s['名字']} ${cost} ${dmg} ${eff}`);
            }
        }
        const targetEffectText = (abilityText + ' ' + skillTexts.join(' ') + ' ' + (targetData['效果'] || '')).toLowerCase();

        // ===== 通用机制检测规则 =====
        // 规则格式: { detect: 检测目标卡是否含此机制, provides: 描述目标卡提供了什么,
        //             searchFor: 找受益卡的关键词, searchHow: 额外过滤条件 }
        const rules = [];

        // 能量附着
        if (targetEffectText.includes('附着') && targetEffectText.includes('能量')) {
            const energyTypes = new Set();
            for (let i = 1; i <= 4; i++) {
                const s = targetData[`技能${i}`];
                if (s && Array.isArray(s['消耗'])) {
                    s['消耗'].forEach(c => { if (c !== '无') energyTypes.add(c); });
                }
            }
            if (targetData['属性']) energyTypes.add(targetData['属性']);
            const typeList = [...energyTypes].slice(0, 3);
            rules.push({
                label: '高能量需求打手（受益于填能加速）',
                provides: '给宝可梦附着能量',
                search: (data) => {
                    if (!data['宝可梦名字']) return 0;
                    for (let i = 1; i <= 4; i++) {
                        const s = data[`技能${i}`];
                        if (s && Array.isArray(s['消耗'])) {
                            const cnt = s['消耗'].filter(c => c !== '无').length;
                            const hasType = typeList.some(t => s['消耗'].includes(t));
                            if (cnt >= 3 && hasType) return cnt;
                        }
                    }
                    return 0;
                },
                max: 8
            });
        }

        // 伤害指示物
        if (targetEffectText.includes('伤害指示物')) {
            rules.push({
                label: '伤害指示物协同（伤害随指示物变化或触发效果）',
                provides: '涉及伤害指示物机制',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    if (!text.includes('伤害指示物')) return 0;
                    let score = 1;
                    if (/[0-9]+\s*[xX×]/.test(text)) score += 2;  // 缩放伤害
                    if (text.includes('数量') || text.includes('每有')) score += 2;
                    if (text.includes('放置') || text.includes('移除') || text.includes('回复')) score += 1;
                    return score;
                },
                max: 8
            });
        }

        // 弃牌区利用
        if (targetEffectText.includes('弃牌区')) {
            rules.push({
                label: '弃牌区资源利用（回收能量/卡牌）',
                provides: '从弃牌区回收资源',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    if (!text.includes('弃牌区')) return 0;
                    let score = 1;
                    if (text.includes('能量')) score += 2;
                    if (text.includes('附着') || text.includes('加入手牌')) score += 1;
                    return score;
                },
                max: 6
            });
        }

        // 备战区
        if (targetEffectText.includes('备战')) {
            rules.push({
                label: '备战区协同（备战区触发效果或受益）',
                provides: '影响备战区',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    if (!text.includes('备战')) return 0;
                    let score = 1;
                    if (text.includes('特性')) score += 2;
                    if (text.includes('伤害') || text.includes('能量') || text.includes('效果')) score += 1;
                    return score;
                },
                max: 6
            });
        }

        // 进化（2阶）
        if ((targetData['进化阶段'] || '').includes('2')) {
            rules.push({
                label: '进化辅助（2阶进化需要加速）',
                provides: '是2阶进化宝可梦',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    const type = data['卡牌类型'] || (data['宝可梦名字'] ? '宝可梦' : '');
                    if (type === '宝可梦') return 0; // 只搜非宝可梦的辅助卡
                    if (!text.includes('进化') && !text.includes('牌库')) return 0;
                    let score = 1;
                    if (text.includes('糖果') || text.includes('学习器')) score += 2;
                    if (text.includes('选择')) score += 1;
                    return score;
                },
                max: 6
            });
        }

        // 牌库检索
        if (targetEffectText.includes('牌库') && (targetEffectText.includes('选择') || targetEffectText.includes('查看') || targetEffectText.includes('抽出'))) {
            rules.push({
                label: '牌库检索协同（互补检索体系）',
                provides: '从牌库检索卡牌',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    if (!text.includes('牌库')) return 0;
                    let score = 1;
                    if (text.includes('选择')) score += 2;
                    if (text.includes('加入手牌')) score += 1;
                    return score;
                },
                max: 5
            });
        }

        // 特殊状态
        if (targetEffectText.includes('中毒') || targetEffectText.includes('麻痹') || targetEffectText.includes('混乱') || targetEffectText.includes('烧伤') || targetEffectText.includes('睡眠')) {
            rules.push({
                label: '特殊状态协同（放大异常状态收益）',
                provides: '施加特殊状态',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    const states = ['中毒', '麻痹', '混乱', '烧伤', '睡眠'];
                    const hits = states.filter(s => text.includes(s));
                    return hits.length > 0 ? hits.length : 0;
                },
                max: 5
            });
        }

        // 奖赏卡
        if (targetEffectText.includes('奖赏卡') || targetEffectText.includes('奖品')) {
            rules.push({
                label: '奖赏卡相关协同',
                provides: '涉及奖赏卡机制',
                search: (data) => {
                    const text = this._jsonCardToSearchText(data);
                    return (text.includes('奖赏卡') || text.includes('奖品')) ? 1 : 0;
                },
                max: 4
            });
        }

        // ===== 执行所有规则 =====
        for (const rule of rules) {
            const scored = [];
            for (const [id, data] of this._jsonCache) {
                if (seenIds.has(id)) continue;
                if (!isLegal(data)) continue;
                const score = rule.search(data);
                if (score > 0) {
                    const evidence = this._findMatchEvidence(targetData, data, rule.label);
                    // 宝可梦类：计算战略得分
                    let stratScore = 0;
                    let stratReasons = [];
                    if (data['宝可梦名字']) {
                        const strat = this._scoreAttacker(targetData, data, rule.label);
                        stratScore = strat.score;
                        stratReasons = strat.reasons;
                    }
                    scored.push({ id, name: data['宝可梦名字'] || data['卡牌名字'] || id, score, data, evidence, stratScore, stratReasons });
                }
            }
            if (scored.length > 0) {
                // 按战略得分排序（宝可梦优先），机制匹配分次之
                scored.sort((a, b) => {
                    if (a.stratScore !== b.stratScore) return b.stratScore - a.stratScore;
                    return b.score - a.score;
                });
                const cards = scored.slice(0, rule.max).map((c, idx) => {
                    seenIds.add(c.id);
                    const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
                    const detail = this._summarizeCardQuick(c.data);
                    const marker = idx < 3 ? '⭐' : ''; // 前3名高亮
                    const stratInfo = c.stratReasons.length > 0 ? ` | 评分依据: ${c.stratReasons.join('; ')}` : '';
                    return `${marker} **${c.name}** [ID:${c.id}] [${type}]\n  效果: ${detail}\n  **匹配依据**: ${c.evidence}${stratInfo}`;
                });
                sections.push(`### ${rule.label}\n目标卡提供: ${rule.provides}\n${cards.join('\n')}`);
            }
        }

        // 追加非宝可梦索引（按目标卡需求打分排序）
        const nonPokeScored = [];
        const seenNpNames = new Set();
        const targetText = this._jsonCardToSearchText(targetData);
        const isEvo = (targetData['进化阶段'] || '').includes('2');
        const hasDmg = targetText.includes('伤害指示物');
        const hasEnergy = targetText.includes('能量') && targetText.includes('附着');
        const targetType = targetData['属性'] || '';

        for (const [id, data] of this._jsonCache) {
            if (data['宝可梦名字']) continue;
            const name = data['卡牌名字'] || '';
            if (!name || seenNpNames.has(name)) continue;
            const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
            if (version && !'FGHI'.includes(version.toUpperCase())) continue;
            seenNpNames.add(name);
            const type = (data['卡牌类型'] || '').replace('卡', '');
            const eff = (data['效果'] || '');
            const text = eff + (data['特性效果'] || '');

            // 按目标卡需求打分
            let score = 1; // 基础分
            if (isEvo && (text.includes('进化') && (text.includes('牌库') || text.includes('糖果')))) score += 5;
            if (isEvo && (text.includes('基础') && text.includes('牌库'))) score += 3;
            if (hasDmg && text.includes('伤害指示物')) score += 4;
            if (hasEnergy && text.includes('弃牌区') && text.includes('能量')) score += 3;
            if (text.includes('牌库') && text.includes('抽出')) score += 2;
            if (text.includes('回收') || text.includes('加入手牌')) score += 2;
            if (text.includes('抓') || text.includes('战斗场')) score += 2;
            if (text.includes(targetType + '能量')) score += 3;

            nonPokeScored.push({ name, id, type, eff: eff.slice(0, 50), score });
        }
        nonPokeScored.sort((a, b) => b.score - a.score);

        if (nonPokeScored.length > 0) {
            results.push(`\n---\n## 📦 推荐泛用卡 (按${targetName}需求打分，仅F-I标)`);
            results.push(`> 前20张最相关的支援者/物品/道具/竞技场。组卡组时优先从前10选。\n`);
            const top20 = nonPokeScored.slice(0, 20);
            top20.forEach((s, i) => {
                const star = i < 5 ? '⭐' : (i < 10 ? '★' : '');
                results.push(`${star}[${s.type}] **${s.name}** ID:${s.id} (${s.score}分) ${s.eff}`);
            });
            results.push(`\n> 更多卡请用 search_cards 按类型搜索。`);
        }

        if (sections.length === 0) {
            return [
                `## 🔗 协同搜索: ${targetName}`,
                '',
                '未检测到明确的协同机制。该卡可能是独立作战型，或其效果文本中的机制在当前数据库中没有找到匹配的协同卡。',
                '',
                '建议：用 search_cards 手动搜索相关卡牌类型或关键词。'
            ].join('\n');
        }

        return [
            `## 🔗 协同搜索结果: ${targetName}`,
            `> 自动检测到 ${rules.length} 种机制，在 ${this._jsonCache.size} 张卡中分类搜索（仅F/G/H/I标）。`,
            '',
            ...sections,
            '',
            '---',
            '> 对上面列出的卡可以用 get_card_detail(ID) 查看完整效果。',
            '> 如果某个方面的协同卡不够，告诉我要针对哪个机制深入搜索。'
        ].join('\n');
    }

    // get_card_detail 实现（含协同分析提示）
    _toolGetCardDetail(cardId) {
        if (!cardId) return JSON.stringify({ error: '请提供卡牌ID' });

        const jsonData = this._jsonCache.get(cardId);
        if (jsonData) {
            const cardText = this._formatRichCardContext(cardId, jsonData, {});
            const hints = this._generateSynergyHints(jsonData);
            if (hints) {
                return cardText + '\n\n' + hints;
            }
            return cardText;
        }

        const basicCard = (this.cardManager.allCardsCache || []).find(c => c.id === cardId)
            || (this.cardManager.cards || []).find(c => c.id === cardId);
        if (basicCard) {
            return this._formatCardContext(basicCard, !!(basicCard.searchText || basicCard.filter));
        }

        return JSON.stringify({ error: `未找到卡牌ID: ${cardId}` });
    }

    // 分析两张卡之间的协同依据
    _findMatchEvidence(targetData, cardData, ruleLabel) {
        const targetText = this._jsonCardToSearchText(targetData);
        const cardText = this._jsonCardToSearchText(cardData);
        const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || '目标卡';
        const cardName = cardData['宝可梦名字'] || cardData['卡牌名字'] || '此卡';

        // 检测具体互动点
        const evidences = [];

        // 高能量需求
        for (let i = 1; i <= 4; i++) {
            const skill = cardData[`技能${i}`];
            if (skill && Array.isArray(skill['消耗'])) {
                const cnt = skill['消耗'].filter(c => c !== '无').length;
                if (cnt >= 3) {
                    evidences.push(`招式「${skill['名字']}」需要${cnt}个能量，${targetName}可加速填能满足需求`);
                    break;
                }
            }
        }

        // 伤害指示物互动
        if (cardText.includes('伤害指示物')) {
            const hasScaling = /[0-9]+\s*[xX×]/.test(cardText) || cardText.includes('数量') || cardText.includes('每有');
            const hasPlacement = cardText.includes('放置') || cardText.includes('移除') || cardText.includes('回复');
            if (hasScaling) {
                // 找到缩放相关的具体文本
                const scalingMatch = cardText.match(/[^。]*伤害指示物[^。]*(?:×|数量|每有|增加|伤害)[^。]*/);
                const snippet = scalingMatch ? scalingMatch[0].slice(0, 50) : '伤害随伤害指示物变化';
                evidences.push(`伤害缩放: ${snippet}`);
            } else if (hasPlacement) {
                evidences.push(`与伤害指示物互动——${targetName}每回合放置2个伤害指示物可触发此效果`);
            } else {
                evidences.push(`效果涉及伤害指示物，${targetName}可为此卡提供伤害指示物来源`);
            }
        }

        // 弃牌区互动
        if (targetText.includes('弃牌区') && cardText.includes('弃牌区')) {
            if (cardText.includes('能量') && cardText.includes('弃牌区')) {
                evidences.push(`也从弃牌区利用能量，与${targetName}形成双重坟场资源体系`);
            } else {
                evidences.push(`与弃牌区互动，${targetName}可为此卡持续提供弃牌区资源`);
            }
        }

        // 备战区互动
        if (targetText.includes('备战') && cardText.includes('备战')) {
            const hasAbility = cardText.includes('特性');
            if (hasAbility) {
                evidences.push(`在备战区拥有特性效果，${targetName}可在备战区为其填能`);
            } else {
                evidences.push(`涉及备战区机制，${targetName}的备战区填能可支援此卡`);
            }
        }

        // 进化
        if (cardText.includes('进化') && !cardData['宝可梦名字']) {
            if (cardText.includes('糖果')) {
                evidences.push('神奇糖果可跳过1阶直接进化，加速2阶进化链');
            } else {
                evidences.push(`进化辅助卡，可帮${targetName}快速完成进化`);
            }
        }

        // 牌库检索
        if (targetText.includes('牌库') && cardText.includes('牌库')) {
            if (cardText.includes('选择')) {
                evidences.push(`从牌库精确检索，互补${targetName}的检索体系`);
            } else if (cardText.includes('抽出')) {
                evidences.push(`过牌能力，可帮${targetName}更快找到关键组件`);
            }
        }

        // 特殊状态
        const states = ['中毒', '麻痹', '混乱', '烧伤', '睡眠'];
        const matchedStates = states.filter(s => cardText.includes(s));
        if (matchedStates.length > 0) {
            evidences.push(`涉及${matchedStates.join('/')}状态，${targetName}施加的状态可触发额外效果`);
        }

        // 奖赏卡
        if (cardText.includes('奖赏卡') || cardText.includes('奖品')) {
            evidences.push(`涉及奖赏卡机制，与${targetName}的奖品交换策略协同`);
        }

        return evidences.length > 0 ? evidences.join('；') : `${ruleLabel}相关`;
    }

    // 快速生成卡牌效果摘要（一行）
    // 获取卡牌的战略属性（奖品数、阶段、缩放类型）
    _getCardStrategicProps(data) {
        const props = { prizes: 1, stage: '基础', isRuleBox: false, scaling: 'fixed', maxEnergy: 0 };
        const stage = data['进化阶段'] || '';
        if (stage.includes('基础')) { props.stage = '基础'; props.deployScore = 3; }
        else if (stage.includes('1阶') || stage.includes('一阶')) { props.stage = '1阶进化'; props.deployScore = 2; }
        else if (stage.includes('2阶') || stage.includes('二阶')) { props.stage = '2阶进化'; props.deployScore = 1; }
        else { props.deployScore = 3; }

        const rule = (data['规则'] || '') + (data['规则2'] || '');
        if (rule.includes('ex') || rule.includes('VSTAR') || rule.includes('VMAX')) { props.prizes = 2; props.isRuleBox = true; props.prizeScore = 1; }
        else if (rule.includes('V-UNION')) { props.prizes = 3; props.isRuleBox = true; props.prizeScore = 0; }
        else if (rule.includes('V')) { props.prizes = 2; props.isRuleBox = true; props.prizeScore = 1; }
        else { props.prizeScore = 2; } // 1奖小人牌最优

        // 检测缩放类型
        const text = this._jsonCardToSearchText(data);
        if (/[×xX*]\s*[0-9]+/.test(text) || /[0-9]+\s*[×xX*]/.test(text)) {
            if (text.includes('伤害指示物')) props.scaling = '伤指物缩放';
            else if (text.includes('能量')) props.scaling = '能量缩放';
            else props.scaling = '条件缩放';
            props.scaleScore = 3;
        } else if (text.includes('每有') || text.includes('数量')) {
            if (text.includes('伤害指示物')) { props.scaling = '伤指物缩放'; props.scaleScore = 3; }
            else if (text.includes('能量')) { props.scaling = '能量缩放'; props.scaleScore = 3; }
            else { props.scaling = '条件缩放'; props.scaleScore = 2; }
        } else {
            props.scaling = '固定伤害';
            props.scaleScore = 1;
        }

        // 最大能量需求
        for (let i = 1; i <= 4; i++) {
            const s = data[`技能${i}`];
            if (s && Array.isArray(s['消耗'])) {
                const cnt = s['消耗'].filter(c => c !== '无').length;
                if (cnt > props.maxEnergy) props.maxEnergy = cnt;
            }
        }

        return props;
    }

    // 结构化搜索高能量需求打手（不靠文本正则，直接读招式消耗数据）
    _findHighEnergyAttackers(targetData) {
        const targetAttr = targetData['属性'] || '';
        const results = [];
        for (const [id, data] of this._jsonCache) {
            if (!data['宝可梦名字']) continue;
            const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
            if (version && !'FGHI'.includes(version.toUpperCase())) continue;
            // 跳过目标卡本身
            if (id === Object.keys(targetData).length ? false : false) continue; // skip self (handled by seenIds elsewhere)

            let usesTargetEnergy = false;
            let maxCost = 0;
            for (let i = 1; i <= 4; i++) {
                const skill = data[`技能${i}`];
                if (skill && Array.isArray(skill['消耗'])) {
                    const cnt = skill['消耗'].filter(c => c !== '无').length;
                    if (cnt > maxCost) maxCost = cnt;
                    if (skill['消耗'].some(c => c === targetAttr)) usesTargetEnergy = true;
                }
            }
            // 需要2能以上 且 使用目标卡提供的能量类型
            if (maxCost >= 2 && usesTargetEnergy) {
                const name = data['宝可梦名字'] || id;
                results.push({ id, name, data, score: maxCost });
            }
        }
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    // 双轴协同评分：能量轴 + 伤指物轴
    _scoreSynergyAxes(targetData, cardData) {
        const targetAttr = targetData['属性'] || '';
        const targetEffects = (targetData['特性效果'] || '') + ' ' + (targetData['效果'] || '');
        const targetText = targetEffects.toLowerCase();
        const cardText = this._jsonCardToSearchText(cardData);
        const cardAttr = cardData['属性'] || '';

        // === 轴1：能量协同（0-10分）===
        let energyScore = 0;
        const providesEnergy = targetText.includes('能量') && (targetText.includes('附着') || targetText.includes('填'));
        if (providesEnergy) {
            // 检查候选卡是否使用了目标卡提供的能量
            let targetEnergyInCost = 0;
            for (let i = 1; i <= 4; i++) {
                const skill = cardData[`技能${i}`];
                if (skill && Array.isArray(skill['消耗'])) {
                    targetEnergyInCost += skill['消耗'].filter(c => c === targetAttr).length;
                }
            }
            if (targetEnergyInCost > 0) {
                energyScore = Math.min(10, 3 + targetEnergyInCost * 2); // 基础3 + 每需1个目标能量+2
            } else if (cardAttr === targetAttr) {
                energyScore = 2; // 同属性但当前招式不需要（可能是填能目标/辅助）
            } else {
                energyScore = 0; // 既不需要目标能量也不是同属性 → 填能对此卡无用
            }
        }

        // === 轴2：伤指物协同（0-10分）===
        let dmgCounterScore = 0;
        const placesDmg = targetText.includes('伤害指示物') && targetText.includes('放置');
        if (placesDmg && cardText.includes('伤害指示物')) {
            // 检测伤指物是否在×/每有/数量的上下文附近（30字符内）
            const dmgIdx = cardText.indexOf('伤害指示物');
            const nearby = cardText.slice(Math.max(0, dmgIdx - 30), dmgIdx + 35);
            if (/[0-9]+\s*[×xX]/.test(nearby) || nearby.includes('每有') || nearby.includes('数量')) {
                dmgCounterScore = 8;
            } else if (cardText.includes('转移') || cardText.includes('移动')) {
                dmgCounterScore = 6;
            } else if (cardText.includes('移除') || cardText.includes('回复')) {
                dmgCounterScore = 3;
            }
        }

        return { energy: energyScore, dmgCounter: dmgCounterScore, total: energyScore + dmgCounterScore };
    }

    // 兼容性：至少一个轴有实质匹配
    _isCompatibleSynergy(targetData, cardData) {
        if (!cardData['宝可梦名字']) return true;
        const axes = this._scoreSynergyAxes(targetData, cardData);
        return axes.energy >= 2 || axes.dmgCounter >= 3;
    }

    // 不兼容原因
    _getIncompatibilityReason(targetData, cardData) {
        if (!cardData['宝可梦名字']) return '';
        const targetAttr = targetData['属性'] || '';
        let usesE = false;
        for (let i = 1; i <= 4; i++) {
            const s = cardData[`技能${i}`];
            if (s && Array.isArray(s['消耗']) && s['消耗'].includes(targetAttr)) { usesE = true; break; }
        }
        const reasons = [];
        if (!usesE && cardData['属性'] !== targetAttr) reasons.push(`无需${targetAttr}能`);
        const hp = parseInt(cardData['HP']) || 0;
        if (hp > 0 && hp < 70) reasons.push('HP<70');
        return reasons.join(';');
    }

    // 兼容性加分（同属性加成大幅提高）
    _compatibilityBonus(targetData, cardData) {
        const axes = this._scoreSynergyAxes(targetData, cardData);
        const targetAttr = targetData['属性'] || '';
        let bonus = axes.total;

        // 同属性：填能直接生效。异属性且无实质伤指物协同 → 强制排名靠后（-50分）
        if (cardData['属性'] === targetAttr) {
            bonus += 15;
        } else if (axes.dmgCounter < 6) {
            return -50; // 异属性填能收益有限，确保排在同属性之后
        }

        // HP惩罚
        const hp = parseInt(cardData['HP']) || 0;
        if (hp > 0 && hp < 70) bonus -= 8;
        else if (hp < 90) bonus -= 3;

        // 进化竞争
        if ((targetData['进化阶段'] || '').includes('2') && (cardData['进化阶段'] || '').includes('2')) {
            bonus -= 3;
        }
        return bonus;
    }

    // 计算协同卡的战略得分
    _scoreAttacker(targetData, cardData, ruleLabel) {
        const props = this._getCardStrategicProps(cardData);
        let score = 0;
        const reasons = [];

        // 部署难度分（基础3 > 1阶2 > 2阶1）
        score += props.deployScore * 3;
        if (props.stage === '基础') reasons.push('基础宝可梦，起手即可用');
        else if (props.stage === '2阶进化') reasons.push('2阶进化需额外进化辅助');

        // 奖品效率分（1奖2 > 2奖1 > 3奖0）
        score += props.prizeScore * 3;
        if (props.prizes === 1) reasons.push('1奖品，奖品交换高效');
        else if (props.prizes >= 2) reasons.push(`${props.prizes}奖品，奖品交换风险较高`);

        // 缩放上限分（缩放3 > 条件2 > 固定1）
        score += props.scaleScore * 4;
        if (props.scaling.includes('缩放')) reasons.push('伤害可随条件无限增长');
        else if (props.scaling === '固定伤害') reasons.push('固定伤害，上限有限');

        // 能量协同加分
        const targetAttr = targetData['属性'] || '';
        let hasTargetEnergy = false;
        for (let i = 1; i <= 4; i++) {
            const s = cardData[`技能${i}`];
            if (s && Array.isArray(s['消耗'])) {
                if (s['消耗'].includes(targetAttr)) { hasTargetEnergy = true; break; }
            }
        }
        if (hasTargetEnergy) { score += 3; reasons.push(`需要${targetAttr}能量，直接受益于目标卡填能`); }

        // 高能量需求加分（3能以上 → 目标卡填能收益大）
        if (props.maxEnergy >= 3) { score += 3; reasons.push(`最高${props.maxEnergy}能需求，目标卡填能可大幅加速`); }

        return { score, reasons };
    }

    // 给卡牌打特征标签（v8 方向感知版）
    _generateCardTags(data) {
        const tags = [];
        const text = this._jsonCardToSearchText(data);
        const effects = [data['特性效果'] || ''];
        for (let i = 1; i <= 4; i++) {
            const s = data[`技能${i}`];
            if (s && s['效果'] && s['效果'] !== '无') effects.push(s['效果']);
        }
        if (data['效果']) effects.push(data['效果']);
        const allEffects = effects.join(' ');

        // === 伤害指示物：严格区分方向 ===
        if (allEffects.includes('伤害指示物')) {
            // 判断伤指物的归属：检查"伤害指示物"前面是否有"对手/对方"限定
            const dmgPhrases = allEffects.match(/[^。]{0,30}伤害指示物[^。]{0,30}/g) || [allEffects];
            let onSelf = false, onOpponent = false;
            for (const phrase of dmgPhrases) {
                // 自己的：这只宝可梦/自身/自己/给这只/此卡/该宝可梦 后面出现伤指物
                if (/(?:这只宝可梦|自身|自己|给这只|此卡|该宝可梦).{0,15}伤害指示物|伤害指示物.{0,15}(?:这只宝可梦|自身|自己)/.test(phrase)) {
                    onSelf = true;
                }
                // 对手的：对手/对方/战斗宝可梦 后面出现伤指物
                if (/(?:对手|对方|战斗宝可梦).{0,15}伤害指示物|伤害指示物.{0,15}(?:对手|对方|战斗宝可梦)/.test(phrase)) {
                    onOpponent = true;
                }
            }
            // 如果没明确归属，"身上"默认指自己
            if (!onSelf && !onOpponent) {
                if (/(?:身上).{0,10}伤害指示物/.test(allEffects) && !/对手|对方/.test(allEffects)) {
                    onSelf = true;
                }
            }

            // 转移/移动
            if (/转移|移动/.test(allEffects)) {
                if (onSelf && onOpponent) tags.push('伤指物转移-进攻');
                else if (onOpponent && !onSelf) tags.push('伤指物操作-对手');
                else if (onSelf) tags.push('伤指物转移');
                else tags.push('伤指物移动');
            }

            // 缩放：伤害随自己身上的伤指物增长
            if (/[×xX*]/.test(allEffects) || /每有/.test(allEffects) || /数量/.test(allEffects)) {
                if (onSelf && /[×xX*]/.test(allEffects)) {
                    tags.push('伤指物缩放');
                } else if (/[×xX*]/.test(allEffects) && allEffects.includes('伤害指示物')) {
                    tags.push('伤指物相关'); // ×和伤指物同在但归属不明
                }
            }

            // 放置/回复/移除
            if (/放置/.test(allEffects) && onOpponent && !onSelf) tags.push('铺伤-对手');
            else if (/放置/.test(allEffects) && onSelf) tags.push('自放伤指物');
            if (/回复|移除/.test(allEffects) && onSelf) tags.push('伤指物治疗');
        }

        // === 伤害缩放（非伤指物）===
        if (/[×xX*]\s*[0-9]+|[0-9]+\s*[×xX*]/.test(text) && !tags.some(t => t.includes('伤指物'))) {
            if (/能量/.test(text) && /附着|数量|每有/.test(text)) tags.push('能量缩放');
            else if (/备战|后场/.test(text)) tags.push('备战缩放');
        }

        // === 能量相关 ===
        const selfAccel = /附着.*能量|能量.*附着/.test(allEffects) &&
            (/弃牌区|牌库/.test(allEffects) || /从.*选择/.test(allEffects));
        if (selfAccel) tags.push('自填能');
        if (/能量.*减少|减少.*能量|改为\d.*能量|能量.*改为\d|所需能量.*改为/.test(allEffects)) tags.push('能量减免');
        if (/从弃牌区.*能量|能量.*弃牌区/.test(allEffects) && !selfAccel) tags.push('坟场填能');

        // === 攻击模式 ===
        if (/备战|后场/.test(allEffects) && /伤害/.test(allEffects)) tags.push('后排攻击');
        if (/对手.*手牌|丢弃.*手牌|查看.*手牌/.test(allEffects)) tags.push('手牌干扰');

        // === 检索/过牌 ===
        if (/牌库.*选择|从.*牌库.*加入/.test(allEffects)) tags.push('检索');
        if (/抽出|抽.*张/.test(allEffects)) tags.push('过牌');

        // 检查是否需要非目标能量类型（能力/招式的能量前提）
        const otherEnergyNeeded = [];
        const attrChars = ['草','火','水','雷','超','斗','恶','钢','妖','龙','无'];
        // 从效果文本中检测"附有X能量"这类能量前提
        for (const attr of attrChars) {
            if (attr === (data['属性'] || '')) continue; // 同属性跳过
            if (new RegExp(`附有.*${attr}.*能量|${attr}.*能量.*附有`).test(allEffects)) {
                otherEnergyNeeded.push(attr);
            }
        }
        if (otherEnergyNeeded.length > 0) {
            tags.push(`需${otherEnergyNeeded.join('/')}能前提`);
        }

        // 回复能力评估
        const healMatch = allEffects.match(/恢复\s*[“"]?\s*(\d+)\s*[”"]?\s*HP|HP\s*恢复\s*(\d+)|回复\s*(\d+)/);
        if (healMatch) {
            const healAmt = parseInt(healMatch[1] || healMatch[2] || healMatch[3]) || 0;
            if (healAmt > 0) {
                const hp = parseInt(data['HP']) || 100;
                if (healAmt <= 20) tags.push(`微量回复${healAmt}`);
                else if (healAmt <= 60) tags.push(`回复${healAmt}`);
                else tags.push(`大量回复${healAmt}`);
            }
        }

        // 副作用
        if (/无法使用招式|不能.*攻击|无法.*攻击|下.*回合.*无法/.test(allEffects)) tags.push('副作用-无法连攻');
        if (/也受到.*伤害/.test(allEffects)) tags.push('副作用-自伤');

        return tags;
    }

    // 战略价值加分（非伤害性价值）
    _getStrategicBonus(data, tags) {
        let bonus = 0;
        if (tags.includes('后排攻击')) bonus += 8; // 可狙杀备战区关键卡
        if (tags.includes('手牌干扰')) bonus += 5;
        if (tags.includes('检索')) bonus += 4;
        if (tags.includes('过牌')) bonus += 3;
        if (tags.includes('伤指物转移-进攻')) bonus += 6; // 把沙奈朵放的伤指物转给对手
        if (tags.includes('铺伤')) bonus += 4; // 伤害指示物扩散
        if (tags.includes('低HP伤指物-需保护')) bonus -= 5; // 太脆，注意HP上限
        return bonus;
    }

    // 快速生成卡牌效果摘要（含战略属性 + 标签）
    _summarizeCardQuick(data) {
        const tags = this._generateCardTags(data);
        const tagStr = tags.length > 0 ? ` [${tags.join('|')}]` : '';
        const props = this._getCardStrategicProps(data);
        const strategic = [];
        if (props.prizes > 1) strategic.push(`${props.prizes}奖`);
        else strategic.push('1奖');
        strategic.push(props.stage);
        if (props.scaling !== '固定伤害') strategic.push(props.scaling);
        const stratStr = `[${strategic.join('|')}]`;

        const parts = [stratStr];
        if (data['宝可梦名字']) {
            if (data['HP']) parts.push(`HP${data['HP']}`);
            if (data['属性']) parts.push(data['属性']);
            if (data['特性名字']) {
                const eff = (data['特性效果'] || '').slice(0, 40);
                parts.push(`特性「${data['特性名字']}」${eff}${eff.length >= 40 ? '...' : ''}`);
            }
            for (let i = 1; i <= 4; i++) {
                const s = data[`技能${i}`];
                if (s && s['名字']) {
                    const cost = Array.isArray(s['消耗']) ? s['消耗'].join('') : '';
                    const dmg = s['伤害'] ? ` ${s['伤害']}` : '';
                    const eff = (s['效果'] && s['效果'] !== '无') ? `(${s['效果'].slice(0, 30)})` : '';
                    parts.push(`[${cost}]${s['名字']}${dmg}${eff}`);
                }
            }
        } else {
            const eff = (data['效果'] || '').slice(0, 80);
            parts.push(eff);
            if (eff.length >= 80) parts[parts.length - 1] += '...';
        }
        if (data['规则']) parts.push(`规则:${data['规则']}`);
        if (tags.length > 0) parts.push(`🏷${tags.join(',')}`);
        return parts.join(' | ');
    }

    // 分析卡牌效果，生成协同搜索建议
    _generateSynergyHints(jsonData) {
        const hints = [];
        const provides = [];
        const searchDirections = [];

        // 收集所有效果文本
        const allEffects = [];
        if (jsonData['特性效果']) allEffects.push(jsonData['特性效果']);
        for (let i = 1; i <= 4; i++) {
            const skill = jsonData[`技能${i}`];
            if (skill && skill['效果'] && skill['效果'] !== '无') allEffects.push(skill['效果']);
        }
        if (jsonData['效果']) allEffects.push(jsonData['效果']);
        const combinedText = allEffects.join(' ');

        // 检测机制并提供搜索建议
        if (combinedText.includes('弃牌区') && (combinedText.includes('能量') || combinedText.includes('附着'))) {
            provides.push('从弃牌区回收/附着能量');
            searchDirections.push('🔍 需要大量能量的打手 → search_cards("超 无 无 伤害", "宝可梦")，查看哪些宝可梦的招式需要3个以上能量');
            searchDirections.push('🔍 能利用弃牌区能量的卡 → search_cards("弃牌区 能量", "宝可梦")');
        }

        if (combinedText.includes('伤害指示物') && combinedText.includes('放置')) {
            provides.push('给宝可梦放置伤害指示物');
            searchDirections.push('🔍 **伤害指示物越多伤害越高的卡** → search_cards("伤害指示物 伤害 增加", "宝可梦")');
            searchDirections.push('🔍 放置伤害指示物时触发效果的卡 → search_cards("放置 伤害指示物 特性")');
        }

        if (combinedText.includes('伤害指示物') && !combinedText.includes('放置')) {
            provides.push('涉及伤害指示物机制');
            searchDirections.push('🔍 伤害指示物相关卡 → search_cards("伤害指示物")');
        }

        if (combinedText.includes('备战区') || combinedText.includes('备战宝可梦')) {
            provides.push('影响备战区宝可梦');
            searchDirections.push('🔍 备战区触发效果或受益的卡 → search_cards("备战区 特性", "宝可梦")');
        }

        if (combinedText.includes('附着') && combinedText.includes('能量')) {
            if (!provides.includes('从弃牌区回收/附着能量')) {
                provides.push('给宝可梦附着能量');
            }
            // 检测能量类型
            const attrName = jsonData['属性'] || '';
            if (attrName) {
                searchDirections.push(`🔍 需要${attrName}能量的高伤害打手 → search_cards("${attrName} 无", "宝可梦") 查看消耗多个${attrName}能量的招式`);
            }
        }

        // 进化相关
        if (jsonData['进化阶段'] === '2阶进化' || jsonData['进化阶段'] === '二阶进化') {
            provides.push('是2阶进化宝可梦（需要进化链支持）');
            searchDirections.push('🔍 进化辅助卡 → search_cards("进化 牌库 选择", "物品") 或 search_cards("进化", "支援者")');
            searchDirections.push('🔍 糖果类进化道具 → search_cards("糖果", "物品")');
        }

        if (jsonData['进化自']) {
            if (!provides.some(p => p.includes('进化'))) {
                provides.push(`进化自${jsonData['进化自']}（需基础和一阶进化）`);
            }
        }

        // 特性相关
        if (jsonData['特性名字'] && jsonData['特性效果']) {
            if (!provides.length) {
                provides.push(`拥有特性「${jsonData['特性名字']}」`);
            }
            // 特性类协同
            searchDirections.push('🔍 与特性协同的卡 → search_cards("特性", "宝可梦道具") 或 search_cards("特性", "竞技场")');
        }

        // 高能量需求打手检测
        let maxEnergy = 0;
        let energyTypes = new Set();
        for (let i = 1; i <= 4; i++) {
            const skill = jsonData[`技能${i}`];
            if (skill && Array.isArray(skill['消耗'])) {
                const costCount = skill['消耗'].filter(c => c !== '无').length;
                if (costCount > maxEnergy) maxEnergy = costCount;
                skill['消耗'].forEach(c => { if (c !== '无') energyTypes.add(c); });
            }
        }
        if (maxEnergy >= 3) {
            provides.push(`需要${maxEnergy}个能量才能使用招式`);
            searchDirections.push(`🔍 **提供能量加速的卡** → search_cards("能量 附着 备战", "宝可梦") 或 search_cards("能量", "支援者")`);
        }

        // 特殊机制检测
        if (combinedText.includes('中毒') || combinedText.includes('麻痹') || combinedText.includes('混乱') || combinedText.includes('烧伤') || combinedText.includes('睡眠')) {
            provides.push('涉及特殊状态');
            searchDirections.push('🔍 特殊状态相关卡 → search_cards("中毒 麻痹 混乱", "宝可梦")');
        }

        if (combinedText.includes('奖赏卡') || combinedText.includes('奖品')) {
            provides.push('涉及奖赏卡机制');
            searchDirections.push('🔍 奖赏卡相关卡 → search_cards("奖赏卡")');
        }

        if (provides.length === 0) return '';

        return [
            '---',
            '## 🧠 协同分析提示',
            '**这张卡提供:** ' + provides.join('；'),
            '',
            '**建议搜索方向 (请用 search_cards 工具逐一搜索):**',
            ...searchDirections,
            '',
            '> 注意: 这只是提示方向。请实际调用 search_cards 验证每类卡是否存在于当前环境 (F/G/H/I标)。搜到的卡要逐张分析其效果是否真的与目标卡协同，不要看到卡名就下结论。'
        ].join('\n');
    }

    // 单次 API 调用（流式），返回 {text, toolCalls}
    async _callApi(messages, onTextChunk, forceOutput = false) {
        const apiKey = this.apiKeyManager.getApiKey();
        const settings = this.apiKeyManager.getSettings();

        const maxTok = forceOutput ? 8192 : (settings.maxTokens || CONFIG_AI.maxTokens);
        const body = {
            model: settings.model || CONFIG_AI.model,
            max_tokens: maxTok,
            messages: messages,
            tools: forceOutput ? undefined : this._getTools(),
            tool_choice: forceOutput ? 'none' : 'auto',
            stream: true
        };

        const response = await fetch(CONFIG_AI.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            let errorMsg;
            if (response.status === 401) errorMsg = 'API Key 无效或已过期。';
            else if (response.status === 429) errorMsg = '请求频率过高，请稍后再试。';
            else if (response.status === 402) errorMsg = '账户余额不足，请充值。';
            else errorMsg = `API 请求失败 (${response.status}): ${errorText}`;
            throw new Error(errorMsg);
        }

        // 流式解析
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        const toolCalls = {}; // index -> {id, name, arguments}

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    // 文本输出
                    if (delta.content) {
                        fullText += delta.content;
                        if (onTextChunk) onTextChunk(delta.content, fullText);
                    }

                    // 工具调用
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
                            if (tc.id) toolCalls[idx].id = tc.id;
                            if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                        }
                    }
                } catch (e) { /* skip */ }
            }
        }

        return {
            text: fullText,
            toolCalls: Object.values(toolCalls).filter(tc => tc.name)
        };
    }

    // 从用户消息中提取卡牌名
    _extractCardNames(message) {
        // 遍历卡库找消息中包含的卡名（比正则可靠得多）
        const seen = new Set();
        const matches = [];
        const cache = this.cardManager.allCardsCache || [];
        const pool = cache.length > 0 ? cache : (this.cardManager.cards || []);
        for (const card of pool) {
            const n = card.name || '';
            if (n.length >= 2 && !seen.has(n) && message.includes(n)) { seen.add(n); matches.push(n); }
        }
        for (const [id, data] of this._jsonCache) {
            const n = data['宝可梦名字'] || data['卡牌名字'] || '';
            if (n.length >= 2 && !seen.has(n) && message.includes(n)) { seen.add(n); matches.push(n); }
        }
        matches.sort((a, b) => b.length - a.length);
        return matches.slice(0, 3);
    }

    async sendMessage(userMessage, onChunk, onComplete, onError) {
        const apiKey = this.apiKeyManager.getApiKey();
        if (!apiKey) {
            onError(new Error('NO_API_KEY'));
            return;
        }

        try {
            // 确保数据已加载
            if (!this._searchDataLoaded) {
                await this.ensureSearchDataLoaded();
            }

            // 保存到历史
            this._history.push({ role: 'user', content: userMessage });

            // 自动检测卡名 + 约束，运行 deep_analysis
            const cardNames = this._extractCardNames(userMessage);
            const searchName = cardNames.length > 0 ? cardNames[0] : (this._lastCardName || '');
            if (cardNames.length > 0) this._lastCardName = cardNames[0];

            // 检测筛选条件
            const filters = {};
            if (/基础|basic/i.test(userMessage)) filters.stage = 'basic';
            if (/非ex|非V|非规则|小人牌|1奖/.test(userMessage)) filters.noEx = true;

            let analysisReport = '';
            if (searchName) {
                console.log('[AI Agent] Deep analysis for:', searchName, 'filters:', filters);
                analysisReport = await this._toolDeepAnalysis(searchName, filters);
            } else {
                // 无卡名 → 把整条消息当做分析主题，直接给AI工具让它自己搜
                console.log('[AI Agent] No card name detected, AI will search freely');
            }

            // 构建消息：系统提示 + 分析报告 + 用户消息
            const settings = this.apiKeyManager.getSettings();
            const messages = [
                { role: 'system', content: this.buildSystemPrompt() }
            ];
            const recentHistory = this._history.slice(-CONFIG_AI.maxHistoryMessages);
            for (const msg of recentHistory.slice(0, -1)) { // 排除最后一条（刚加的）
                messages.push(msg);
            }

            const enrichMsg = analysisReport
                ? `${analysisReport}\n\n---\n## 用户问题\n${userMessage}\n\n请写一份详细的卡牌协同分析（2000字以上）。\n\n### 要求\n1. 拆解目标卡效果（特性+招式）\n2. 逐张分析排名前5的协同卡（卡名+ID+效果+协同逻辑）\n3. 战略总结\n4. 如需组卡组，宝可梦从排名选，支援者/物品从📦索引选\n5. 只引用报告中的数据，不要编造`
                : userMessage;
            messages.push({ role: 'user', content: enrichMsg });

            // 带工具的单轮/双轮对话：AI 可以搜索需要的卡
            // 一次性 API 调用（无工具循环），报告已包含全部所需数据
            try {
                const resp = await fetch(CONFIG_AI.apiEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: settings.model || CONFIG_AI.model, max_tokens: 8192, messages: messages, stream: true })
                });
                if (!resp.ok) { const e = await resp.text().catch(()=>''); const m={401:'Key无效',429:'频率过高',402:'余额不足'}; onError(new Error(m[resp.status]||`API错误${resp.status}`)); return; }
                const reader = resp.body.getReader(), decoder = new TextDecoder();
                let fullText = '', buf = '';
                while (true) { const {done,value}=await reader.read(); if(done)break; buf+=decoder.decode(value,{stream:true}); const ls=buf.split('\n'); buf=ls.pop()||''; for(const l of ls){ const d=l.trim(); if(!d.startsWith('data: '))continue; const j=d.slice(6); if(j==='[DONE]')continue; try{const c=JSON.parse(j)?.choices?.[0]?.delta?.content; if(c){fullText+=c; if(onChunk)onChunk(c,fullText);}}catch(e){}} }
                console.log(`[AI Agent] Analysis: ${fullText.length} chars`);
                this._history.push({ role: 'assistant', content: fullText }); this._saveHistory();
                const deck = this.parseDeckFromResponse(fullText);
                if (onComplete) onComplete(fullText, deck);
                return;
            } catch (fetchErr) { onError(new Error('网络错误：'+(fetchErr.message||'连接失败'))); return; }

            // ---- 下面是旧代码，不应到达 ----
            const MAX_LOOPS = 6;
            let fullText = '';

            for (let loop = 0; loop < MAX_LOOPS; loop++) {
                const forceText = loop >= 4;
                const streamChunk = forceText ? onChunk : null;
                const resp = await fetch(CONFIG_AI.apiEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: settings.model || CONFIG_AI.model,
                        max_tokens: 8192,
                        messages: messages,
                        tools: forceText ? undefined : this._getTools(),
                        tool_choice: forceText ? 'none' : 'auto',
                        stream: true
                    })
                });
                if (!resp.ok) { const e = await resp.text().catch(()=>''); const m={401:'Key无效',429:'频率过高',402:'余额不足'}; onError(new Error(m[resp.status]||`API错误${resp.status}`)); return; }

                // 解析流式响应
                const reader = resp.body.getReader(), decoder = new TextDecoder();
                let buf = '', tcMap = {};
                fullText = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const ls = buf.split('\n'); buf = ls.pop() || '';
                    for (const l of ls) {
                        const d = l.trim(); if (!d.startsWith('data: ')) continue;
                        const j = d.slice(6); if (j === '[DONE]') continue;
                        try {
                            const p = JSON.parse(j); const delta = p.choices?.[0]?.delta;
                            if (!delta) continue;
                            if (delta.content) { fullText += delta.content; if (streamChunk) streamChunk(delta.content, fullText); }
                            if (delta.tool_calls) for (const tc of delta.tool_calls) {
                                const i = tc.index; if (!tcMap[i]) tcMap[i] = { id: '', name: '', args: '' };
                                if (tc.id) tcMap[i].id = tc.id;
                                if (tc.function?.name) tcMap[i].name += tc.function.name;
                                if (tc.function?.arguments) tcMap[i].args += tc.function.arguments;
                            }
                        } catch (e) { /* */ }
                    }
                }

                const toolCalls = Object.values(tcMap).filter(tc => tc.name);
                if (toolCalls.length === 0) break; // 纯文本，完成

                // 执行工具调用
                console.log(`[AI Agent] Loop ${loop+1}: ${toolCalls.length} tool calls`);
                messages.push({ role: 'assistant', content: fullText || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
                for (const tc of toolCalls) {
                    const result = await this._executeToolCall(tc);
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
                    console.log(`[AI Agent] ${tc.name}: ${result.length} chars`);
                }
            }

            // 过滤DSML等内部标签
            fullText = fullText.replace(/<DSML[^>]*>/gi, '').replace(/<\/?function_calls>/gi, '').replace(/<\/?invoke>/gi, '').replace(/<\/?parameter[^>]*>/gi, '');
            console.log(`[AI Agent] Analysis: ${fullText.length} chars`);

            // 校验卡组中的ID，过滤无效卡
            let deck = this.parseDeckFromResponse(fullText);
            if (deck && deck.invalidCards && deck.invalidCards.length > 0) {
                const badNames = deck.invalidCards.map(c => c.id || c.name || '?').join(', ');
                console.log(`[AI Agent] Deck has ${deck.invalidCards.length} invalid cards: ${badNames}`);
                // 追加警告消息，让AI修
                messages.push({ role: 'assistant', content: fullText });
                messages.push({ role: 'user', content: `以下卡牌ID验证失败，不在数据库中：${badNames}。请用search_cards找到正确的卡替换，然后重新输出完整卡组JSON。` });
                // 再给AI一轮修正
                const fixResp = await fetch(CONFIG_AI.apiEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: settings.model || CONFIG_AI.model, max_tokens: 4096, messages: messages, tools: this._getTools(), tool_choice: 'auto', stream: true })
                });
                if (fixResp.ok) {
                    const r2 = fixResp.body.getReader(), d2 = new TextDecoder();
                    let fixText = '', b2 = '', tcMap2 = {}; // 修正阶段不流式输出
                    while (true) {
                        const { done, value } = await r2.read(); if (done) break;
                        b2 += d2.decode(value, { stream: true }); const ls = b2.split('\n'); b2 = ls.pop() || '';
                        for (const l of ls) {
                            const d = l.trim(); if (!d.startsWith('data: ')) continue; const j = d.slice(6); if (j === '[DONE]') continue;
                            try {
                                const p = JSON.parse(j); const delta = p.choices?.[0]?.delta;
                                if (!delta) continue;
                                if (delta.content) { fixText += delta.content; if (onChunk) onChunk(delta.content, fixText); }
                                if (delta.tool_calls) for (const tc of delta.tool_calls) {
                                    const i = tc.index; if (!tcMap2[i]) tcMap2[i] = { id: '', name: '', args: '' };
                                    if (tc.id) tcMap2[i].id = tc.id; if (tc.function?.name) tcMap2[i].name += tc.function.name; if (tc.function?.arguments) tcMap2[i].args += tc.function.arguments;
                                }
                            } catch (e) { /* */ }
                        }
                    }
                    const tcs2 = Object.values(tcMap2).filter(tc => tc.name);
                    if (tcs2.length > 0) {
                        messages.push({ role: 'assistant', content: fixText || null, tool_calls: tcs2.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
                        for (const tc of tcs2) {
                            const res = await this._executeToolCall(tc);
                            messages.push({ role: 'tool', tool_call_id: tc.id, content: res });
                        }
                        // 再给AI一轮输出最终卡组
                        const finalResp = await fetch(CONFIG_AI.apiEndpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                            body: JSON.stringify({ model: settings.model || CONFIG_AI.model, max_tokens: 4096, messages: messages, stream: true })
                        });
                        if (finalResp.ok) {
                            const fr = finalResp.body.getReader(); const fd = new TextDecoder();
                            fullText = ''; let fb = '';
                            while (true) { const { done, value } = await fr.read(); if (done) break; fb += fd.decode(value, { stream: true }); const ls = fb.split('\n'); fb = ls.pop() || ''; for (const l of ls) { const d = l.trim(); if (!d.startsWith('data: ')) continue; const j = d.slice(6); if (j === '[DONE]') continue; try { const c = JSON.parse(j)?.choices?.[0]?.delta?.content; if (c) { fullText += c; if (onChunk) onChunk(c, fullText); } } catch (e) { /* */ } } } // 修正后流式输出
                        }
                    } else {
                        fullText = fixText;
                    }
                }
                deck = this.parseDeckFromResponse(fullText);
            }

            this._history.push({ role: 'assistant', content: fullText }); this._saveHistory();
            if (onComplete) onComplete(fullText, deck);
            return;

        } catch (error) {
            if (error.message === 'NO_API_KEY') {
                onError(error);
            } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
                onError(new Error('网络连接失败，请检查网络后重试。'));
            } else {
                onError(error);
            }
        }
    }

    // 从 AI 回复中解析卡组 JSON
    parseDeckFromResponse(text) {
        if (!text) return null;

        // 匹配 ```json deck ... ``` 代码块
        const patterns = [
            /```json\s*deck\s*\n([\s\S]*?)\n```/i,
            /```json\s*\n?([\s\S]*?)```\s*(?:$|\n)/i,
            /```\s*\n?\{[\s\S]*?"cards"[\s\S]*?\}\s*\n```/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                try {
                    const jsonStr = match[1] || match[0];
                    // 提取 JSON 对象
                    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const deck = JSON.parse(jsonMatch[0]);
                        if (deck && Array.isArray(deck.cards)) {
                            return this.validateDeckCards(deck);
                        }
                    }
                } catch (e) {
                    // 继续尝试下一个模式
                }
            }
        }

        return null;
    }

    // 校验卡组中的卡牌 ID
    validateDeckCards(deck) {
        if (!deck || !Array.isArray(deck.cards)) return null;

        const validCards = [];
        const invalidCards = [];

        for (const card of deck.cards) {
            if (!card.id || typeof card.id !== 'string') {
                invalidCards.push(card);
                continue;
            }

            // 检查卡牌是否存在于数据库中
            const baseInfo = this.cardManager.getCardBaseInfo(card.id);
            if (baseInfo && baseInfo.name && !baseInfo.name.startsWith('卡牌 ')) {
                // 限制数量 1-4
                const quantity = Math.min(Math.max(1, parseInt(card.quantity) || 1), 4);
                validCards.push({
                    id: card.id,
                    name: baseInfo.name,
                    image: baseInfo.image,
                    type: baseInfo.type,
                    quantity: quantity
                });
            } else {
                invalidCards.push(card);
            }
        }

        if (validCards.length === 0) return null;

        return {
            name: deck.name || 'AI 推荐卡组',
            cards: validCards,
            invalidCards: invalidCards.length > 0 ? invalidCards : [],
            totalCount: validCards.reduce((sum, c) => sum + c.quantity, 0)
        };
    }
}
