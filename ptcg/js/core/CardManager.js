import { CARD_TYPES } from '../utils/constants.js';
import { generateImageFilename } from '../utils/helpers.js';

export class CardManager {
    constructor(storageService) {
        this.storageService = storageService;
        this.cards = [];
        this.filteredCards = [];
        this.currentTab = '宝可梦';
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
            
            console.log(`成功加载 ${this.cards.length} 张${cardType}卡牌`);
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
                            image: `${CARD_TYPES[cardType].imagePath}${generateImageFilename(cardId)}`
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
}