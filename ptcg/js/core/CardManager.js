import { CARD_TYPES } from '../utils/constants.js';
import { generateImageFilename } from '../utils/helpers.js';
import { TsvCardDataLoader } from './TsvCardDataLoader.js';

// 在 CardManager.js 的导入部分添加：
import { STORAGE_KEYS } from '../utils/constants.js';

export class CardManager {
    constructor(storageService) {
        this.storageService = storageService;
        this.cards = [];
        this.filteredCards = [];
        this.currentTab = '宝可梦';
        this.isShowingAllCards = true;
        this.hasActiveSearch = false;
        
        // 新增：全局卡牌缓存，存储所有卡牌的基础信息
        this.allCardsCache = null;
        this.tsvLoader = new TsvCardDataLoader({
            generateImage: cardId => this.generateDefaultImage(cardId)
        });
        this.supplementalLoadToken = 0;
        
        // 新增：世代筛选相关
        this.generationManager = null;
        this.currentGeneration = 'all';

        // 卡包筛选
        this.currentSetCode = 'all';
        this.isSetFiltered = false;
        this.generationRanges = {
            '1': { start: 1, end: 151, name: '第一世代' },
            '2': { start: 152, end: 251, name: '第二世代' },
            '3': { start: 252, end: 386, name: '第三世代' },
            '4': { start: 387, end: 493, name: '第四世代' },
            '5': { start: 494, end: 649, name: '第五世代' },
            '6': { start: 650, end: 721, name: '第六世代' },
            '7': { start: 722, end: 809, name: '第七世代' },
            '8': { start: 810, end: 905, name: '第八世代' },
            '9': { start: 906, end: 1025, name: '第九世代' }
        };
    }

    // 新增：设置世代管理器
    setGenerationManager(generationManager) {
        this.generationManager = generationManager;
    }

    // 新增：获取当前世代
    getCurrentGeneration() {
        return this.currentGeneration;
    }

    // 新增：设置当前世代
    setCurrentGeneration(generation) {
        this.currentGeneration = generation;
    }

    // 新增：应用世代筛选
    applyGenerationFilter(generation = this.currentGeneration) {
        this.currentGeneration = generation;
        
        if (generation === 'all' || this.currentTab !== '宝可梦') {
            this.filteredCards = [...this.cards];
        } else {
            this.filteredCards = this.filterByGeneration(this.cards, generation);
        }
        
        return this.filteredCards;
    }

    // 新增：根据世代筛选卡牌
    filterByGeneration(cards, generation) {
        if (generation === 'all' || this.currentTab !== '宝可梦') {
            return cards;
        }

        const range = this.generationRanges[generation];
        if (!range) return cards;

        return cards.filter(card => {
            // 只筛选宝可梦卡牌
            if (card.type !== '宝可梦') return false;
            
            // 提取宝可梦编号
            const number = this.extractPokemonNumber(card);
            if (!number) return false;
            
            return number >= range.start && number <= range.end;
        });
    }

    // 新增：提取宝可梦编号
    extractPokemonNumber(card) {
        if (!card.number || card.number === '未知') return null;
        
        // 处理不同格式的编号，如 "001"、"25" 等
        const match = card.number.match(/\d+/);
        return match ? parseInt(match[0], 10) : null;
    }

    // 新增：获取世代名称
    getGenerationName(generation) {
        if (generation === 'all') return '全部';
        return this.generationRanges[generation]?.name || generation;
    }

    // 新增：重置世代筛选
    resetGenerationFilter() {
        this.currentGeneration = 'all';
        this.filteredCards = [...this.cards];
        this.isShowingAllCards = true;
    }

    // ── 卡包筛选 ──
    resetSetFilter() {
        this.currentSetCode = 'all';
        this.isSetFiltered = false;
    }

    setSetCode(code) {
        this.currentSetCode = code || 'all';
        this.isSetFiltered = code && code !== 'all';
    }

    // Apply set code filter to a card list
    filterBySetCode(cards, setCode) {
        if (!setCode || setCode === 'all') return cards;
        const prefix = setCode + '-';
        return cards.filter(c => c.id && c.id.startsWith(prefix));
    }

    // 新增：获取宝可梦的世代
    getPokemonGeneration(card) {
        if (card.type !== '宝可梦') return null;
        
        const number = this.extractPokemonNumber(card);
        if (!number) return null;
        
        for (const [genKey, range] of Object.entries(this.generationRanges)) {
            if (number >= range.start && number <= range.end) {
                return genKey;
            }
        }
        return null;
    }

    // 修改：更新搜索方法以结合世代筛选
    searchCards(searchText) {
        if (!searchText.trim()) {
            // 空搜索时显示所有卡牌，但要考虑世代筛选
            let filtered = [...this.cards];

            // 应用世代筛选（如果是宝可梦类型）
            if (this.currentTab === '宝可梦' && this.currentGeneration !== 'all') {
                filtered = this.filterByGeneration(filtered, this.currentGeneration);
            }

            // 应用卡包筛选
            filtered = this.filterBySetCode(filtered, this.currentSetCode);

            this.filteredCards = filtered;
            this.isShowingAllCards = true;
            this.hasActiveSearch = false;
            return this.filteredCards;
        }

        const searchLower = searchText.toLowerCase().trim();
        let filtered = this.cards.filter(card => {
            const searchFields = [card.name, card.searchText];
            return searchFields.some(field =>
                field && field.toLowerCase().includes(searchLower)
            );
        });

        // 应用世代筛选（如果是宝可梦类型）
        if (this.currentTab === '宝可梦' && this.currentGeneration !== 'all') {
            filtered = this.filterByGeneration(filtered, this.currentGeneration);
        }

        // 应用卡包筛选
        filtered = this.filterBySetCode(filtered, this.currentSetCode);

        this.filteredCards = filtered;
        this.isShowingAllCards = false;
        this.hasActiveSearch = true;
        return this.filteredCards;
    }

    // 修改：获取当前显示的卡牌，考虑搜索和世代筛选
    getDisplayCards() {
        if (!this.isShowingAllCards || this.hasActiveSearch) {
            return this.filterBySetCode(this.filteredCards, this.currentSetCode);
        }

        let cards = this.cards;

        // 应用世代筛选
        if (this.currentTab === '宝可梦' && this.currentGeneration !== 'all') {
            cards = this.filterByGeneration(cards, this.currentGeneration);
        }

        // 应用卡包筛选
        cards = this.filterBySetCode(cards, this.currentSetCode);

        return cards;
    }

    unescapeTsvValue(value) {
        return String(value ?? '').replace(/\\([\\trn])/g, (_, ch) => {
            if (ch === 't') return '\t';
            if (ch === 'r') return '\r';
            if (ch === 'n') return '\n';
            return '\\';
        });
    }

    parseTsv(text) {
        const lines = text.split(/\r?\n/).filter(line => line.length > 0);
        if (lines.length === 0) return [];
        const headers = lines[0].split('\t');
        return lines.slice(1).map(line => {
            const values = line.split('\t').map(value => this.unescapeTsvValue(value));
            const row = {};
            headers.forEach((header, index) => { row[header] = values[index] || ''; });
            return row;
        });
    }

    loadCardQuantitiesFromStorage(cards, cardType) {
        return this.storageService.loadCardQuantities(cards, cardType);
    }

    async loadInitialPokemonCards() {
        return this.loadCardIndexData('宝可梦');
    }

    async loadCardIndexData(cardType) {
        const config = CARD_TYPES[cardType];
        if (!config) {
            throw new Error(`未知的卡牌类型: ${cardType}`);
        }

        const cards = await this.tsvLoader.loadIndex(config, cardType);
        return this.loadCardQuantitiesFromStorage(cards, cardType);
    }

    async loadCardSupplementalData(cardType) {
        const config = CARD_TYPES[cardType];
        if (!config) {
            throw new Error(`未知的卡牌类型: ${cardType}`);
        }

        const [searchMap, filterMap] = await Promise.all([
            this.tsvLoader.loadSearch(config),
            this.tsvLoader.loadFilter(config)
        ]);

        return { searchMap, filterMap };
    }

    applyCardSupplementalData(cards, searchMap, filterMap) {
        cards.forEach(card => {
            card.searchText = searchMap.get(card.id) || '';
            card.filter = filterMap.get(card.id) || null;
        });
        return cards;
    }

    startBackgroundSupplementalLoad(cardType, onComplete) {
        const token = ++this.supplementalLoadToken;
        return this.loadCardSupplementalData(cardType)
            .then(({ searchMap, filterMap }) => {
                if (token !== this.supplementalLoadToken || this.currentTab !== cardType) return false;
                this.applyCardSupplementalData(this.cards, searchMap, filterMap);
                if (typeof onComplete === 'function') onComplete(cardType);
                return true;
            })
            .catch(error => {
                console.error(`后台加载${cardType}搜索/筛选数据失败:`, error);
                return false;
            });
    }

    async fetchProcessedCardData(cardType) {
        let processedCards = await this.loadCardIndexData(cardType);
        const { searchMap, filterMap } = await this.loadCardSupplementalData(cardType);
        return this.applyCardSupplementalData(processedCards, searchMap, filterMap);
    }

    // 修改：加载卡牌数据时重置世代筛选
    async loadCardData(cardType, options = {}) {
        const { loadSupplemental = true, onSupplementalLoaded = null } = options;

        try {
            this.supplementalLoadToken++;
            this.cards = await this.loadCardIndexData(cardType);
            this.currentTab = cardType;

            // 重置筛选状态（世代重置，卡包保持）
            this.resetGenerationFilter();
            this.filteredCards = [...this.cards];
            this.hasActiveSearch = false;

            if (loadSupplemental) {
                this.startBackgroundSupplementalLoad(cardType, onSupplementalLoaded);
            }

            // console.log(`成功加载 ${this.cards.length} 张${cardType}卡牌索引`);
            return this.cards;

        } catch (error) {
            console.error(`加载${cardType}TSV数据失败:`, error);
            throw error;
        }
    }

    // 预加载所有卡牌的基础信息
    async preloadAllCardBaseInfo() {
        if (this.allCardsCache) {
            return this.allCardsCache; // 已经加载过，直接返回缓存
        }
        
        // console.log('🔄 预加载所有卡牌基础信息...');
        this.allCardsCache = [];
        const cardTypes = this.getAllCardTypes();
        
        for (const cardType of cardTypes) {
            try {
                const config = CARD_TYPES[cardType];
                const baseCards = await this.tsvLoader.loadIndex(config, cardType);
                const cardsWithQuantities = this.storageService.loadCardQuantities(baseCards, cardType);
                this.allCardsCache.push(...cardsWithQuantities);

                // console.log(`✅ 预加载 ${cardsWithQuantities.length} 张${cardType}卡牌基础信息`);

            } catch (error) {
                console.error(`预加载${cardType}基础信息失败:`, error);
            }
        }
        
        // console.log(`✅ 预加载完成，共 ${this.allCardsCache.length} 张卡牌基础信息`);
        return this.allCardsCache;
    }


    normalizeCardText(value) {
        if (value == null) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value).replace(/\s+/g, '').trim();
    }

    buildCardEquivalenceKeyFromRaw(card, cardType) {
        const name = card['卡牌名字'] || card['宝可梦名字'] || '未知';
        const parts = [cardType, name];

        if (cardType === '宝可梦') {
            parts.push(card['特性名字'] || '');
            parts.push(card['特性效果'] || '');
            for (let i = 1; i <= 4; i++) {
                const skill = card[`技能${i}`] || {};
                parts.push(skill['名字'] || '');
                parts.push(Array.isArray(skill['消耗']) ? skill['消耗'].join(',') : (skill['消耗'] || ''));
                parts.push(skill['伤害'] || '');
                parts.push(skill['效果'] || '');
            }
        } else {
            parts.push(card['效果'] || '');
        }

        return parts.map(part => this.normalizeCardText(part)).join('|');
    }

    buildCardEquivalenceKey(card) {
        const parts = [card.type || this.currentTab, card.name || '未知'];

        if ((card.type || this.currentTab) === '宝可梦') {
            parts.push(card.abilityName || '');
            parts.push(card.abilityEffect || '');
            for (let i = 1; i <= 4; i++) {
                const skill = card[`skill${i}`] || {};
                parts.push(skill['名字'] || '');
                parts.push(Array.isArray(skill['消耗']) ? skill['消耗'].join(',') : (skill['消耗'] || ''));
                parts.push(skill['伤害'] || '');
                parts.push(skill['效果'] || '');
            }
        } else {
            parts.push(card.effect || '');
        }

        return parts.map(part => this.normalizeCardText(part)).join('|');
    }

    getCardBaseInfo(cardId) {
        // 首先在当前加载的卡牌中查找
        const currentCard = this.cards.find(c => c.id === cardId);
        if (currentCard) {
            // console.log(`🔍 从当前卡牌找到: ${cardId}, 图片: ${currentCard.image}`);
            return {
                name: currentCard.name,
                image: currentCard.image,
                type: currentCard.type,
                equivalenceKey: currentCard.equivalenceKey || this.buildCardEquivalenceKey(currentCard)
            };
        }
        
        // 然后在全局缓存中查找
        if (this.allCardsCache) {
            const cachedCard = this.allCardsCache.find(c => c.id === cardId);
            if (cachedCard) {
                // console.log(`🔍 从缓存找到: ${cardId}, 图片: ${cachedCard.image}`);
                return {
                    name: cachedCard.name,
                    image: cachedCard.image,
                    type: cachedCard.type,
                    equivalenceKey: cachedCard.equivalenceKey
                };
            }
        }
        
        // 都找不到，返回默认信息
        const defaultImage = this.generateDefaultImage(cardId);
        // console.log(`⚠️ 未找到卡牌基础信息: ${cardId}, 使用默认图片: ${defaultImage}`);
        return {
            name: `卡牌 ${cardId}`,
            image: defaultImage,
            type: '未知',
            equivalenceKey: `未知|卡牌${cardId}`
        };
    }

    // 新增：生成默认图片（确保路径正确）
    generateDefaultImage(cardId) {
        return generateImageFilename(cardId);
    }

    // 处理卡牌数据
    processCardData(jsonData, cardType) {
        const processedCards = [];
        
        jsonData.forEach(card => {
            const cardIds = card['卡牌ID'];
            
            if (cardIds && cardIds.length > 0) {
                cardIds.forEach(cardId => {
                    if (cardId) {
                        const processedCard = {
                            id: cardId,
                            name: card['卡牌名字'] || card['宝可梦名字'] || '未知',
                            type: cardType,
                            quantity: parseInt(card['拥有数量']) || 0,
                            image: this.generateDefaultImage(cardId), // 使用统一的图片路径生成
                            equivalenceKey: this.buildCardEquivalenceKeyFromRaw(card, cardType)
                        };

                        // 宝可梦卡牌特有字段
                        if (cardType === '宝可梦') {
                            processedCard.number = card['编号'] || '未知';
                            processedCard.attribute = card['属性'] || '未知';
                            processedCard.abilityName = card['特性名字'] || '';
                            processedCard.abilityEffect = card['特性效果'] || '';
                            processedCard.skill1 = card['技能1'] || {};
                            processedCard.skill2 = card['技能2'] || {};
                            processedCard.skill3 = card['技能3'] || {};
                            processedCard.skill4 = card['技能4'] || {};
                        } else {
                            // 其他卡牌类型
                            processedCard.effect = card['效果'] || '';
                        }
                        
                        processedCards.push(processedCard);
                    }
                });
            }
        });
        
        return processedCards;
    }

    // 更新卡牌数量
    updateCardQuantity(cardId, change) {
        const card = this.cards.find(c => c.id === cardId);
        if (card) {
            card.quantity = Math.max(0, card.quantity + change);
            this.updateCachedCardQuantity(cardId, card.quantity);
            return card.quantity;
        }
        return 0;
    }

    updateCachedCardQuantity(cardId, quantity) {
        if (!this.allCardsCache) return;
        const cachedCard = this.allCardsCache.find(c => c.id === cardId);
        if (cachedCard) {
            cachedCard.quantity = quantity;
        }
    }

    // 强制显示所有卡牌
    showAllCards() {
        this.filteredCards = [...this.cards];
        this.isShowingAllCards = true;
        this.hasActiveSearch = false;
        return this.filteredCards;
    }

    // 获取卡牌类型配置
    getCardTypes() {
        return CARD_TYPES;
    }

    // 获取当前标签
    getCurrentTab() {
        return this.currentTab;
    }

    // 保存数据
    saveData() {
        return this.storageService.saveCardQuantities(this.cards, this.currentTab);
    }

    // 导出数据
    exportData() {
        this.storageService.exportData(this.cards, this.currentTab);
    }

    // 导入数据
    importData(onImportComplete) {
        this.storageService.importData(this.cards, this.currentTab, onImportComplete);
    }

    // 防抖保存
    debouncedSave() {
        this.storageService.debouncedSave(this.cards, this.currentTab);
    }

    // 获取所有卡牌类型的配置
    getAllCardTypes() {
        return Object.keys(CARD_TYPES);
    }

    // 批量加载所有卡牌数据
    async loadAllCardData() {
        const allCards = [];
        const cardTypes = this.getAllCardTypes();
        
        for (const cardType of cardTypes) {
            try {
                let processedCards = await this.fetchProcessedCardData(cardType);

                allCards.push(...processedCards);
                // console.log(`✅ 成功加载 ${processedCards.length} 张${cardType}卡牌`);

            } catch (error) {
                console.error(`❌ 加载${cardType}数据失败:`, error);
            }
        }
        
        return allCards;
    }

    // 获取所有卡牌的数量数据（用于导出）
    // 委托给 StorageService，额外提供动态加载后备
    async getAllCardQuantities() {
        const cardTypes = this.getAllCardTypes();

        // 方法1：从 StorageService 同步读取（涵盖初始化/分组）
        const stored = this.storageService.getAllCardQuantities();
        const hasAny = cardTypes.some(type => (stored[type] || []).length > 0);

        if (hasAny) {
            // 过滤掉数量为 0 的条目，只返回有数量的
            const result = {};
            cardTypes.forEach(type => {
                result[type] = (stored[type] || []).filter(c => c.quantity > 0);
            });
            return result;
        }

        // 方法2：localStorage 为空则动态加载所有类型（备用方案）
        return this.getAllQuantitiesByLoading();
    }

    // 动态加载所有卡牌类型数据
    async getAllQuantitiesByLoading() {
        const quantitiesByType = {};
        const cardTypes = this.getAllCardTypes();
        
        // 初始化所有类型
        cardTypes.forEach(type => {
            quantitiesByType[type] = [];
        });
        
        // 保存当前状态
        const originalCards = [...this.cards]; // 深拷贝
        const originalTab = this.currentTab;
        const originalFiltered = [...this.filteredCards];
        
        try {
            // 逐个加载所有卡牌类型
            for (const cardType of cardTypes) {
                try {
                    // console.log(`🔄 动态加载 ${cardType} 数据...`);
                    await this.loadCardData(cardType);
                    
                    // 收集当前类型的卡牌数量
                    this.cards.forEach(card => {
                        if (card.quantity > 0) {
                            quantitiesByType[cardType].push({
                                id: card.id,
                                quantity: card.quantity
                            });
                        }
                    });
                    
                    // console.log(`✅ 加载 ${cardType} 数量数据: ${quantitiesByType[cardType].length} 张`);
                    
                } catch (error) {
                    console.error(`❌ 加载 ${cardType} 数据失败:`, error);
                }
            }
            
        } finally {
            // 恢复原始状态
            this.cards = originalCards;
            this.currentTab = originalTab;
            this.filteredCards = originalFiltered;
            // console.log('🔄 恢复原始卡牌显示状态');
        }
        
        return quantitiesByType;
    }

    // 批量更新所有卡牌数量（用于导入）- 简化版
    async updateAllCardQuantities(importedQuantities) {
        // console.log('🔄 更新卡牌数量到本地存储...');
        
        // 1. 清空本地存储中的所有数量
        this.storageService.clearAllQuantities();
        
        // 2. 保存导入的数量到本地存储
        let totalSaved = 0;
        const cardTypes = this.getAllCardTypes();
        
        for (const cardType of cardTypes) {
            const typeCards = importedQuantities[cardType] || [];
            if (typeCards.length > 0) {
                await this.storageService.saveCardQuantitiesForImport(cardType, typeCards);
                totalSaved += typeCards.length;
                // console.log(`💾 ${cardType}: 保存了 ${typeCards.length} 张卡牌数量`);
            }
        }
        
        // console.log(`✅ 总共保存了 ${totalSaved} 张卡牌数量到本地存储`);
        return totalSaved;
    }

    // 保存所有卡牌数据到本地存储
    saveAllData() {
        const cardTypes = this.getAllCardTypes();
        let totalSaved = 0;
        
        cardTypes.forEach(cardType => {
            const typeCards = this.cards.filter(card => card.type === cardType);
            if (typeCards.length > 0) {
                const success = this.storageService.saveCardQuantities(typeCards, cardType);
                if (success) totalSaved++;
            }
        });
        
        return totalSaved;
    } 
    
    // 根据卡牌ID查找卡牌详情
    findCardById(cardId) {
        return this.cards.find(c => c.id === cardId);
    }

    // 重新加载当前卡牌数据（从本地存储读取最新数量）
    async reloadCurrentCardData() {
        const currentTab = this.currentTab;
        // console.log(`🔄 重新加载当前页签数据: ${currentTab}`);
        
        // 重新加载当前页签数据，这会从本地存储读取最新数量
        await this.loadCardData(currentTab);
        // console.log(`✅ 重新加载完成: ${this.cards.length} 张卡牌`);
    }    
}