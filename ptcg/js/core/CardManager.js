import { CARD_TYPES } from '../utils/constants.js';
import { generateImageFilename } from '../utils/helpers.js';

// 在 CardManager.js 的导入部分添加：
import { STORAGE_KEYS } from '../utils/constants.js';

export class CardManager {
    constructor(storageService) {
        this.storageService = storageService;
        this.cards = [];
        this.filteredCards = [];
        this.currentTab = '宝可梦';
        this.isShowingAllCards = true;
        
        // 新增：全局卡牌缓存，存储所有卡牌的基础信息
        this.allCardsCache = null;
    }

    // 新增：预加载所有卡牌的基础信息
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
                const response = await fetch(config.jsonFile);
                
                if (!response.ok) {
                    console.warn(`加载${cardType}基础信息失败: HTTP ${response.status}`);
                    continue;
                }
                
                const jsonData = await response.json();
                const baseCards = this.extractBaseCardInfo(jsonData, cardType);
                this.allCardsCache.push(...baseCards);
                
                // console.log(`✅ 预加载 ${baseCards.length} 张${cardType}卡牌基础信息`);
                
            } catch (error) {
                console.error(`预加载${cardType}基础信息失败:`, error);
            }
        }
        
        // console.log(`✅ 预加载完成，共 ${this.allCardsCache.length} 张卡牌基础信息`);
        return this.allCardsCache;
    }

    // 修改 extractBaseCardInfo 方法，确保图片路径正确
    extractBaseCardInfo(jsonData, cardType) {
        const baseCards = [];
        
        jsonData.forEach(card => {
            const cardIds = card['卡牌ID'];
            if (cardIds && cardIds.length > 0) {
                cardIds.forEach(cardId => {
                    if (cardId) {
                        baseCards.push({
                            id: cardId,
                            name: card['卡牌名字'] || card['宝可梦名字'] || '未知',
                            type: cardType,
                            image: `images/hk${cardId.toString().padStart(8, '0')}.webp` // 直接使用固定路径
                        });
                    }
                });
            }
        });
        
        return baseCards;
    }

    getCardBaseInfo(cardId) {
        // 首先在当前加载的卡牌中查找
        const currentCard = this.cards.find(c => c.id === cardId);
        if (currentCard) {
            // console.log(`🔍 从当前卡牌找到: ${cardId}, 图片: ${currentCard.image}`);
            return {
                name: currentCard.name,
                image: currentCard.image,
                type: currentCard.type
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
                    type: cachedCard.type
                };
            }
        }
        
        // 都找不到，返回默认信息
        const defaultImage = this.generateDefaultImage(cardId);
        // console.log(`⚠️ 未找到卡牌基础信息: ${cardId}, 使用默认图片: ${defaultImage}`);
        return {
            name: `卡牌 ${cardId}`,
            image: defaultImage,
            type: '未知'
        };
    }

    // 新增：生成默认图片（确保路径正确）
    generateDefaultImage(cardId) {
        const paddedId = cardId.toString().padStart(8, '0');
        return `images/hk${paddedId}.webp`;
    }

    // 加载指定类型的卡牌数据
    async loadCardData(cardType) {
        const config = CARD_TYPES[cardType];
        if (!config) {
            throw new Error(`未知的卡牌类型: ${cardType}`);
        }

        try {
            const response = await fetch(config.jsonFile);
            
            if (!response.ok) {
                throw new Error(`HTTP错误! 状态: ${response.status}`);
            }
            
            const jsonData = await response.json();
            let processedCards = this.processCardData(jsonData, cardType);
            
            // 从本地存储加载数量数据
            processedCards = this.storageService.loadCardQuantities(processedCards, cardType);
            
            this.cards = processedCards;
            this.filteredCards = [...processedCards];
            this.currentTab = cardType;
            
            // console.log(`成功加载 ${this.cards.length} 张${cardType}卡牌`);
            return this.cards;
            
        } catch (error) {
            console.error(`加载${cardType}JSON数据失败:`, error);
            throw error;
        }
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
                            image: this.generateDefaultImage(cardId) // 使用统一的图片路径生成
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
            return card.quantity;
        }
        return 0;
    }

    // 搜索卡牌
    searchCards(searchText) {
        if (!searchText.trim()) {
            this.filteredCards = [...this.cards];
            this.isShowingAllCards = true; // 空搜索时显示所有卡牌
            return this.filteredCards;
        }

        const searchLower = searchText.toLowerCase().trim();
        this.filteredCards = this.cards.filter(card => {
            const searchFields = [card.name];
            
            // 宝可梦卡牌特有搜索字段
            if (this.currentTab === '宝可梦') {
                searchFields.push(
                    card.abilityName,
                    card.abilityEffect,
                    card.skill1.名字,
                    card.skill1.效果,
                    card.skill2.名字,
                    card.skill2.效果,
                    card.skill3.名字,
                    card.skill3.效果,
                    card.skill4.名字,
                    card.skill4.效果
                );
            } else {
                // 其他卡牌类型搜索效果字段
                searchFields.push(card.effect);
            }
            
            return searchFields.some(field => 
                field && field.toLowerCase().includes(searchLower)
            );
        });

        this.isShowingAllCards = false; // 搜索时显示部分卡牌
        return this.filteredCards;
    }

    // 新增方法：强制显示所有卡牌
    showAllCards() {
        this.filteredCards = [...this.cards];
        this.isShowingAllCards = true;
        return this.filteredCards;
    }
    
    // 获取当前显示的卡牌
    getDisplayCards() {
        return this.filteredCards.length > 0 ? this.filteredCards : this.cards;
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

    // 在 CardManager 类中添加这些方法：

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
                const config = CARD_TYPES[cardType];
                const response = await fetch(config.jsonFile);
                
                if (!response.ok) {
                    console.warn(`加载${cardType}数据失败: HTTP ${response.status}`);
                    continue;
                }
                
                const jsonData = await response.json();
                let processedCards = this.processCardData(jsonData, cardType);
                
                // 从本地存储加载数量数据
                processedCards = this.storageService.loadCardQuantities(processedCards, cardType);
                
                allCards.push(...processedCards);
                // console.log(`✅ 成功加载 ${processedCards.length} 张${cardType}卡牌`);
                
            } catch (error) {
                console.error(`❌ 加载${cardType}数据失败:`, error);
            }
        }
        
        return allCards;
    }

    // 获取所有卡牌的数量数据（用于导出）
    async getAllCardQuantities() {
        let quantitiesByType = {}; // 改为 let
        const cardTypes = this.getAllCardTypes();
        
        // 初始化所有类型
        cardTypes.forEach(type => {
            quantitiesByType[type] = [];
        });
        
        try {
            // 方法1：从本地存储获取所有数据（推荐，性能更好）
            const allQuantities = await this.getAllQuantitiesFromStorage();
            
            // 按类型分组
            cardTypes.forEach(cardType => {
                if (allQuantities[cardType]) {
                    quantitiesByType[cardType] = allQuantities[cardType]
                        .filter(card => card.quantity > 0)
                        .map(card => ({
                            id: card.id,
                            quantity: card.quantity
                        }));
                }
            });
            
            // console.log('✅ 从本地存储获取所有卡牌数量数据');
            
        } catch (error) {
            console.warn('❌ 从本地存储获取数据失败，尝试动态加载:', error);
            
            // 方法2：动态加载所有类型（备用方案）
            quantitiesByType = await this.getAllQuantitiesByLoading();
        }
        
        return quantitiesByType;
    }

    // 从本地存储获取所有卡牌数量数据
    async getAllQuantitiesFromStorage() {
        const localData = localStorage.getItem(STORAGE_KEYS.CARD_QUANTITIES);
        if (!localData) {
            // console.log('📦 本地存储中没有卡牌数量数据');
            return this.initializeEmptyQuantities();
        }

        try {
            const allQuantities = JSON.parse(localData);
            // console.log('📦 从本地存储读取到卡牌数据:', allQuantities.length, '条记录');
            return this.groupQuantitiesByType(allQuantities);
        } catch (e) {
            console.warn('❌ 解析本地存储数据失败:', e);
            return this.initializeEmptyQuantities();
        }
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

    // 新增：按类型分组卡牌数量数据
    groupQuantitiesByType(flatQuantities) {
        const grouped = this.initializeEmptyQuantities();
        
        flatQuantities.forEach(item => {
            if (item.type && grouped[item.type] !== undefined) {
                grouped[item.type].push({
                    id: item.id,
                    quantity: item.quantity
                });
            }
        });
        
        return grouped;
    }

    // 新增：初始化空的卡牌数量结构
    initializeEmptyQuantities() {
        const quantities = {};
        const cardTypes = this.getAllCardTypes();
        cardTypes.forEach(type => {
            quantities[type] = [];
        });
        return quantities;
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