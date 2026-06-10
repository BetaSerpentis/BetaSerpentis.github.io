// ptcg/js/core/DeckManager.js
import { debugLog } from '../utils/constants.js';

export class DeckManager {
    constructor(storageService, cardManager) {
        this.storageService = storageService;
        this.cardManager = cardManager;
        this.decks = [];
        this.currentDeckIndex = 0;
        this.isEditing = false;
        this.isSelectingCover = false;
    }

    // 初始化卡组数据
    init() {
        this.loadDecks();
        if (this.decks.length === 0) {
            this.createDefaultDeck();
        }
    }

    // 加载卡组数据
    loadDecks() {
        const savedDecks = this.storageService.loadDecks();
        if (savedDecks && savedDecks.length > 0) {
            this.decks = savedDecks;
            // 加载时对每个卡组进行排序
            this.decks.forEach(deck => {
                this.sortDeckCards(deck);
            });
        }
    }

    // 创建默认卡组
    createDefaultDeck() {
        const defaultDeck = {
            id: Date.now().toString(),
            name: '新卡组',
            coverCardId: null,
            cards: [],
            totalCount: 0
        };
        this.decks = [defaultDeck];
        this.saveDecks();
    }

    // 创建新卡组
    createNewDeck() {
        const newDeck = {
            id: Date.now().toString(),
            name: '新卡组',
            coverCardId: null,
            cards: [],
            totalCount: 0
        };
        this.decks.unshift(newDeck);
        this.currentDeckIndex = 0;
        this.saveDecks();
        return newDeck;
    }

    // 获取当前卡组
    getCurrentDeck() {
        return this.decks[this.currentDeckIndex];
    }

    // 切换卡组
    switchDeck(index) {
        if (index >= 0 && index < this.decks.length) {
            this.currentDeckIndex = index;
            return true;
        }
        return false;
    }

    // 卡牌类型排序顺序（与CardManager一致）
    getCardTypeOrder() {
        return {
            '宝可梦': 1,
            '支援者': 2,
            '物品': 3,
            '宝可梦道具': 4,
            '竞技场': 5,
            '基本能量': 6,
            '特殊能量': 7
        };
    }

    // 获取卡牌详细信息
    getCardDetails(cardId) {
        // 首先在当前加载的卡牌中查找
        const card = this.cardManager.cards.find(c => c.id === cardId);
        if (card) {
            return card;
        }
        
        // 然后在全局缓存中查找
        if (this.cardManager.allCardsCache) {
            const cachedCard = this.cardManager.allCardsCache.find(c => c.id === cardId);
            if (cachedCard) {
                // 需要从JSON数据中获取更多信息
                const baseInfo = this.cardManager.getCardBaseInfo(cardId);
                return {
                    ...cachedCard,
                    ...baseInfo
                };
            }
        }
        
        return null;
    }

    // 排序卡组中的卡牌 - 重新设计排序规则
    sortDeckCards(deck) {
        if (!deck || !deck.cards || deck.cards.length === 0) return;
        
        debugLog('🔄 开始对卡组进行排序:', deck.name);
        debugLog('排序前卡牌:', deck.cards.map(c => ({id: c.id, name: c.name})));
        
        const typeOrder = this.getCardTypeOrder();
        
        deck.cards.sort((a, b) => {
            // 获取卡牌详情
            const cardA = this.getCardDetails(a.id);
            const cardB = this.getCardDetails(b.id);
            
            const typeA = (cardA && cardA.type) || a.type || '未知';
            const typeB = (cardB && cardB.type) || b.type || '未知';
            
            const orderA = typeOrder[typeA] || 999;
            const orderB = typeOrder[typeB] || 999;
            
            // 首先按类型排序
            if (orderA !== orderB) {
                debugLog(`类型排序: ${typeA}(${orderA}) vs ${typeB}(${orderB})`);
                return orderA - orderB;
            }
            
            // 同类型下的详细排序规则
            let result = 0;
            
            switch (typeA) {
                case '宝可梦':
                    // 宝可梦：按编号增序 -> 名称增序 -> ID增序
                    result = this.sortPokemonCards(cardA, cardB, a, b);
                    break;
                    
                case '竞技场':
                case '特殊能量':
                    // 竞技场和特殊能量：按编号（版本）增序
                    result = this.sortByNumber(cardA, cardB, a, b);
                    break;
                    
                default:
                    // 其他类型：按名称增序 -> ID增序
                    result = this.sortByName(cardA, cardB, a, b);
                    break;
            }
            
            if (result !== 0) {
                debugLog(`同类型(${typeA})排序结果:`, {
                    cardA: a.name,
                    cardB: b.name, 
                    result 
                });
            }
            
            return result;
        });
        
        debugLog('✅ 排序完成，排序后卡牌:', deck.cards.map(c => ({id: c.id, name: c.name})));
    }

    // 宝可梦卡排序规则
    sortPokemonCards(cardA, cardB, deckCardA, deckCardB) {
        // 按编号排序
        const numberA = (cardA && cardA.number) || deckCardA.number || '';
        const numberB = (cardB && cardB.number) || deckCardB.number || '';
        
        if (numberA !== numberB) {
            const numberCompare = this.compareNumbers(numberA, numberB);
            if (numberCompare !== 0) {
                debugLog(`宝可梦编号比较: ${numberA} vs ${numberB} = ${numberCompare}`);
                return numberCompare;
            }
        }
        
        // 同编号按名称排序
        const nameA = deckCardA.name || '';
        const nameB = deckCardB.name || '';
        if (nameA !== nameB) {
            const nameCompare = nameA.localeCompare(nameB, 'zh-CN');
            debugLog(`宝可梦名称比较: ${nameA} vs ${nameB} = ${nameCompare}`);
            return nameCompare;
        }
        
        // 同名称按ID排序
        const idCompare = deckCardA.id.localeCompare(deckCardB.id);
        debugLog(`宝可梦ID比较: ${deckCardA.id} vs ${deckCardB.id} = ${idCompare}`);
        return idCompare;
    }

    // 按编号排序（用于竞技场和特殊能量）
    sortByNumber(cardA, cardB, deckCardA, deckCardB) {
        // 按编号排序
        const numberA = (cardA && cardA.number) || deckCardA.number || '';
        const numberB = (cardB && cardB.number) || deckCardB.number || '';
        
        if (numberA !== numberB) {
            const numberCompare = this.compareNumbers(numberA, numberB);
            if (numberCompare !== 0) {
                debugLog(`${cardA?.type || '未知'}编号比较: ${numberA} vs ${numberB} = ${numberCompare}`);
                return numberCompare;
            }
        }
        
        // 同编号按名称排序
        const nameA = deckCardA.name || '';
        const nameB = deckCardB.name || '';
        if (nameA !== nameB) {
            const nameCompare = nameA.localeCompare(nameB, 'zh-CN');
            debugLog(`${cardA?.type || '未知'}名称比较: ${nameA} vs ${nameB} = ${nameCompare}`);
            return nameCompare;
        }
        
        // 同名称按ID排序
        return deckCardA.id.localeCompare(deckCardB.id);
    }

    // 按名称排序（用于支援者、物品、宝可梦道具、基本能量）
    sortByName(cardA, cardB, deckCardA, deckCardB) {
        // 按名称排序
        const nameA = deckCardA.name || '';
        const nameB = deckCardB.name || '';
        const nameCompare = nameA.localeCompare(nameB, 'zh-CN');
        
        if (nameCompare !== 0) {
            debugLog(`${cardA?.type || '未知'}名称比较: ${nameA} vs ${nameB} = ${nameCompare}`);
            return nameCompare;
        }
        
        // 同名称按ID排序
        return deckCardA.id.localeCompare(deckCardB.id);
    }

    // 比较编号（支持数字和字母混合的编号）
    compareNumbers(numA, numB) {
        if (!numA && !numB) return 0;
        if (!numA) return -1;
        if (!numB) return 1;
        
        // 提取数字部分和字母部分
        const regex = /^(\d*)([A-Za-z]*)$/;
        const matchA = numA.match(regex) || ['', '', ''];
        const matchB = numB.match(regex) || ['', '', ''];
        
        const numPartA = parseInt(matchA[1]) || 0;
        const numPartB = parseInt(matchB[1]) || 0;
        const alphaPartA = matchA[2] || '';
        const alphaPartB = matchB[2] || '';
        
        // 先比较数字部分
        if (numPartA !== numPartB) {
            return numPartA - numPartB;
        }
        
        // 数字部分相同，比较字母部分
        return alphaPartA.localeCompare(alphaPartB);
    }

    // 更新卡组中的卡牌数量 - 确保排序被正确调用
    updateCardQuantity(cardId, change) {
        debugLog('🔄 DeckManager: 更新卡牌数量', { cardId, change });
        
        const deck = this.getCurrentDeck();
        if (!deck) {
            debugLog('❌ 没有找到当前卡组');
            return null;
        }

        const existingCard = deck.cards.find(card => card.id === cardId);
        
        if (existingCard) {
            existingCard.quantity = Math.max(0, existingCard.quantity + change);
            debugLog('更新现有卡牌数量:', { id: cardId, quantity: existingCard.quantity });
            
            if (existingCard.quantity === 0) {
                deck.cards = deck.cards.filter(card => card.id !== cardId);
                debugLog('卡牌数量为0，从卡组移除');
            }
        } else if (change > 0) {
            const cardData = this.cardManager.cards.find(card => card.id === cardId);
            if (cardData) {
                const newCard = {
                    id: cardId,
                    name: cardData.name,
                    image: cardData.image,
                    type: cardData.type || '未知',
                    number: cardData.number || '',
                    quantity: change
                };
                deck.cards.push(newCard);
                debugLog('添加新卡牌到卡组:', newCard);
            } else {
                debugLog('❌ 没有找到卡牌数据');
            }
        }

        deck.totalCount = deck.cards.reduce((total, card) => total + card.quantity, 0);
        debugLog('卡组总数量:', deck.totalCount);
        
        // 自动排序 - 确保每次更新后都重新排序
        debugLog('🔄 执行卡组排序...');
        this.sortDeckCards(deck);
        
        this.saveDecks();
        
        const result = deck.cards.find(card => card.id === cardId);
        debugLog('最终结果:', result);
        return result;
    }

    // 设置卡组封面
    setDeckCover(cardId) {
        const deck = this.getCurrentDeck();
        if (deck) {
            const cardInDeck = deck.cards.find(card => card.id === cardId);
            if (cardInDeck) {
                deck.coverCardId = cardId;
                this.saveDecks();
                return true;
            }
        }
        return false;
    }

    // 更新卡组名称
    updateDeckName(name) {
        const deck = this.getCurrentDeck();
        if (deck) {
            deck.name = name || '新卡组';
            this.saveDecks();
            return true;
        }
        return false;
    }

    // 保存卡组数据
    saveDecks() {
        // 保存前确保所有卡组都排序
        this.decks.forEach(deck => {
            this.sortDeckCards(deck);
        });
        this.storageService.saveDecks(this.decks);
    }

    // 导出卡组数据
    exportDecks() {
        return JSON.stringify(this.decks, null, 2);
    }

    // 验证并清理卡组数据
    validateAndCleanDecks(importedDecks) {
        if (!Array.isArray(importedDecks)) {
            console.error('❌ 卡组数据格式错误：不是数组');
            return [];
        }
        
        const validDecks = [];
        
        importedDecks.forEach((deck, index) => {
            if (!deck.id || !deck.name || !Array.isArray(deck.cards)) {
                console.warn(`⚠️ 跳过无效卡组 [${index}]: 缺少必要字段`);
                return;
            }
            
            const cleanedDeck = this.cleanMinimizedDeckData(deck);
            if (cleanedDeck) {
                validDecks.push(cleanedDeck);
            }
        });
        
        return validDecks;
    }

    // 清理精简格式的卡组数据
    cleanMinimizedDeckData(deck) {
        try {
            const cleanedDeck = {
                id: deck.id.toString(),
                name: deck.name.toString().substring(0, 50),
                coverCardId: deck.coverCardId ? deck.coverCardId.toString() : null,
                cards: [],
                totalCount: 0
            };
            
            if (Array.isArray(deck.cards)) {
                deck.cards.forEach(card => {
                    if (card.id && typeof card.quantity === 'number' && card.quantity > 0) {
                        cleanedDeck.cards.push({
                            id: card.id.toString(),
                            quantity: Math.min(card.quantity, 4)
                        });
                    }
                });
            }
            
            cleanedDeck.totalCount = cleanedDeck.cards.reduce((total, card) => total + card.quantity, 0);
            
            return cleanedDeck;
            
        } catch (error) {
            console.error(`❌ 清理卡组数据失败:`, error);
            return null;
        }
    }

    // 清理单个卡组数据
    cleanDeckData(deck) {
        try {
            const cleanedDeck = {
                id: deck.id.toString(),
                name: deck.name.toString().substring(0, 50),
                coverCardId: deck.coverCardId ? deck.coverCardId.toString() : null,
                cards: [],
                totalCount: 0
            };
            
            if (Array.isArray(deck.cards)) {
                deck.cards.forEach(card => {
                    if (card.id && typeof card.quantity === 'number' && card.quantity > 0) {
                        const cardDetails = this.getCardDetails(card.id);
                        if (cardDetails) {
                            cleanedDeck.cards.push({
                                id: card.id.toString(),
                                name: cardDetails.name || '未知卡牌',
                                image: cardDetails.image || '',
                                quantity: Math.min(card.quantity, 4)
                            });
                        }
                    }
                });
            }
            
            cleanedDeck.totalCount = cleanedDeck.cards.reduce((total, card) => total + card.quantity, 0);
            
            // 排序清理后的卡组
            this.sortDeckCards(cleanedDeck);
            
            return cleanedDeck;
            
        } catch (error) {
            console.error(`❌ 清理卡组数据失败:`, error);
            return null;
        }
    }

    // 获取精简的卡组数据（用于导出）
    getMinimizedDecks() {
        // 导出前确保排序
        this.decks.forEach(deck => {
            this.sortDeckCards(deck);
        });
        
        return this.decks.map(deck => ({
            id: deck.id,
            name: deck.name,
            coverCardId: deck.coverCardId,
            cards: deck.cards.map(card => ({
                id: card.id,
                quantity: card.quantity
            })),
            totalCount: deck.totalCount
        }));
    }

    // 从精简数据恢复完整卡组
    async restoreDecksFromMinimized(minimizedDecks) {
        const restoredDecks = [];
        
        await this.cardManager.preloadAllCardBaseInfo();
        
        for (const minimizedDeck of minimizedDecks) {
            try {
                const restoredDeck = {
                    id: minimizedDeck.id,
                    name: minimizedDeck.name,
                    coverCardId: minimizedDeck.coverCardId,
                    cards: [],
                    totalCount: minimizedDeck.totalCount || 0
                };
                
                if (Array.isArray(minimizedDeck.cards)) {
                    for (const minimizedCard of minimizedDeck.cards) {
                        const cardInfo = this.cardManager.getCardBaseInfo(minimizedCard.id);
                        restoredDeck.cards.push({
                            id: minimizedCard.id,
                            name: cardInfo.name,
                            image: cardInfo.image,
                            quantity: minimizedCard.quantity
                        });
                    }
                }
                
                restoredDeck.totalCount = restoredDeck.cards.reduce((total, card) => total + card.quantity, 0);
                
                // 排序恢复的卡组
                this.sortDeckCards(restoredDeck);
                
                restoredDecks.push(restoredDeck);
                
            } catch (error) {
                console.error(`❌ 恢复卡组 ${minimizedDeck.name} 失败:`, error);
            }
        }
        
        debugLog(`✅ 成功恢复 ${restoredDecks.length} 个卡组，并已排序`);
        return restoredDecks;
    }

    // 生成卡牌信息
    async generateCardInfo(cardId) {
        const existingCard = this.cardManager.cards.find(c => c.id === cardId);
        const cardName = existingCard ? existingCard.name : `卡牌 ${cardId}`;
        
        return {
            name: cardName,
            image: this.generateCardImage(cardId)
        };
    }

    // 生成卡牌图片路径
    generateCardImage(cardId) {
        const paddedId = cardId.toString().padStart(8, '0');
        return `images/hk${paddedId}.webp`;
    }

    // 生成占位符图片
    generatePlaceholderImage(cardId) {
        return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23f0f0f0"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23666">卡牌 ${cardId}</text></svg>`;
    }

    // 导入卡组数据
    importDecks(data) {
        try {
            const importedDecks = JSON.parse(data);
            const validatedDecks = this.validateAndCleanDecks(importedDecks);
            
            if (validatedDecks.length > 0) {
                this.decks = this.restoreDecksFromMinimized(validatedDecks);
                this.currentDeckIndex = 0;
                this.saveDecks();
                debugLog(`✅ 成功导入 ${validatedDecks.length} 个卡组并排序`);
                return true;
            } else {
                console.warn('⚠️ 没有有效的卡组数据可导入');
                return false;
            }
        } catch (error) {
            console.error('导入卡组数据失败:', error);
            return false;
        }
    }

    // 获取卡组统计信息
    getDeckStats() {
        const stats = {
            totalDecks: this.decks.length,
            totalCardsInDecks: 0,
            decksBySize: {
                standard: 0,
                expanded: 0
            }
        };
        
        this.decks.forEach(deck => {
            stats.totalCardsInDecks += deck.totalCount;
            if (deck.totalCount === 60) {
                stats.decksBySize.standard++;
            } else {
                stats.decksBySize.expanded++;
            }
        });
        
        return stats;
    }

    // 获取卡组显示卡片
    getDeckDisplayCards() {
        const deck = this.getCurrentDeck();
        if (deck) {
            // 确保返回前已经排序
            this.sortDeckCards(deck);
        }
        return deck ? deck.cards : [];
    }

    // 设置编辑模式
    setEditingMode(editing) {
        this.isEditing = editing;
        if (!editing) {
            this.isSelectingCover = false;
        }
    }

    // 设置封面选择模式
    setSelectingCoverMode(selecting) {
        this.isSelectingCover = selecting;
    }

    // 删除当前卡组
    deleteCurrentDeck() {
        if (this.decks.length <= 1) {
            return false;
        }
        
        const deckToDelete = this.getCurrentDeck();
        if (!deckToDelete) {
            return false;
        }
        
        this.decks.splice(this.currentDeckIndex, 1);
        this.currentDeckIndex = 0;
        this.saveDecks();
        
        return true;
    }

    // 获取卡组统计信息
    getDeckStatsForDelete(deck) {
        return {
            name: deck.name,
            cardCount: deck.totalCount,
            deckCount: this.decks.length
        };
    }
}