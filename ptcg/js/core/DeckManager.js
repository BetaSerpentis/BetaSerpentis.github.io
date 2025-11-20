// 在 DeckManager.js 的导入部分添加：
import { generateImageFilename } from '../utils/helpers.js';

// ptcg/js/core/DeckManager.js
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

    // DeckManager.js - 添加卡牌类型排序功能
// 卡牌类型排序顺序
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

    // 获取卡牌类型
    getCardType(cardId) {
        const card = this.cardManager.cards.find(c => c.id === cardId);
        return card ? card.type : '未知';
    }

    // 获取卡牌详细信息
    getCardDetails(cardId) {
        const card = this.cardManager.cards.find(c => c.id === cardId);
        return card || null;
    }

    // 排序卡组中的卡牌 - 优化排序规则
    sortDeckCards(deck) {
        if (!deck || !deck.cards) return;
        
        const typeOrder = this.getCardTypeOrder();
        
        deck.cards.sort((a, b) => {
            const cardA = this.getCardDetails(a.id);
            const cardB = this.getCardDetails(b.id);
            
            const typeA = cardA ? cardA.type : '未知';
            const typeB = cardB ? cardB.type : '未知';
            
            const orderA = typeOrder[typeA] || 999;
            const orderB = typeOrder[typeB] || 999;
            
            // 首先按类型排序
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            
            // 同类型下的排序规则
            if (typeA === '宝可梦') {
                // 宝可梦卡：按编号增序 -> 名称增序 -> ID增序
                return this.sortPokemonCards(cardA, cardB, a, b);
            } else {
                // 非宝可梦卡：按名称增序
                return this.sortNonPokemonCards(cardA, cardB, a, b);
            }
        });
    }

    // 宝可梦卡排序规则
    sortPokemonCards(cardA, cardB, deckCardA, deckCardB) {
        // 按编号排序
        const numberA = cardA ? cardA.number || '' : '';
        const numberB = cardB ? cardB.number || '' : '';
        
        if (numberA !== numberB) {
            return this.compareNumbers(numberA, numberB);
        }
        
        // 同编号按名称排序
        const nameA = deckCardA.name || '';
        const nameB = deckCardB.name || '';
        if (nameA !== nameB) {
            return nameA.localeCompare(nameB, 'zh-CN');
        }
        
        // 同名称按ID排序
        return deckCardA.id.localeCompare(deckCardB.id);
    }

    // 非宝可梦卡排序规则
    sortNonPokemonCards(cardA, cardB, deckCardA, deckCardB) {
        // 按名称排序
        const nameA = deckCardA.name || '';
        const nameB = deckCardB.name || '';
        return nameA.localeCompare(nameB, 'zh-CN');
    }

    // 比较编号（支持数字和字母混合的编号）
    compareNumbers(numA, numB) {
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

    // 更新卡组中的卡牌数量
    // 在 updateCardQuantity 方法中确保排序被调用
    updateCardQuantity(cardId, change) {
        // console.log('🔄 DeckManager: 更新卡牌数量');
        
        const deck = this.getCurrentDeck();
        if (!deck) {
            // console.log('❌ 没有找到当前卡组');
            return null;
        }

        // console.log('当前卡组:', deck.name);
        // console.log('卡组中的卡牌:', deck.cards);

        const existingCard = deck.cards.find(card => card.id === cardId);
        // console.log('找到现有卡牌:', existingCard);
        
        if (existingCard) {
            existingCard.quantity = Math.max(0, existingCard.quantity + change);
            // console.log('更新后数量:', existingCard.quantity);
            
            if (existingCard.quantity === 0) {
                deck.cards = deck.cards.filter(card => card.id !== cardId);
                // console.log('卡牌数量为0，从卡组移除');
            }
        } else if (change > 0) {
            // console.log('添加新卡牌到卡组');
            const cardData = this.cardManager.cards.find(card => card.id === cardId);
            if (cardData) {
                const newCard = {
                    id: cardId,
                    name: cardData.name,
                    image: cardData.image,
                    quantity: change
                };
                deck.cards.push(newCard);
                // console.log('新卡牌添加成功:', newCard);
            } else {
                // console.log('❌ 没有找到卡牌数据');
            }
        }

        deck.totalCount = deck.cards.reduce((total, card) => total + card.quantity, 0);
        // console.log('卡组总数量:', deck.totalCount);
        
        // 自动排序 - 确保每次更新后都重新排序
        this.sortDeckCards(deck);
        
        this.saveDecks();
        
        const result = deck.cards.find(card => card.id === cardId);
        // console.log('最终结果:', result);
        return result;
    }

    // 确保 setDeckCover 方法正确工作
    setDeckCover(cardId) {
        const deck = this.getCurrentDeck();
        if (deck) {
            // 验证卡牌是否存在于卡组中
            const cardInDeck = deck.cards.find(card => card.id === cardId);
            if (cardInDeck) {
                deck.coverCardId = cardId;
                this.saveDecks();
                // console.log(`✅ 成功设置封面: 卡牌ID ${cardId}`);
                return true;
            } else {
                // console.log('❌ 卡牌不在当前卡组中，无法设置为封面');
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
            // 基本验证（适应精简格式）
            if (!deck.id || !deck.name || !Array.isArray(deck.cards)) {
                console.warn(`⚠️ 跳过无效卡组 [${index}]: 缺少必要字段`);
                return;
            }
            
            // 清理卡组数据（适应精简格式）
            const cleanedDeck = this.cleanMinimizedDeckData(deck);
            if (cleanedDeck) {
                validDecks.push(cleanedDeck);
            }
        });
        
        // console.log(`✅ 验证通过 ${validDecks.length} 个卡组`);
        return validDecks;
    }

    // 清理精简格式的卡组数据
    cleanMinimizedDeckData(deck) {
        try {
            const cleanedDeck = {
                id: deck.id.toString(),
                name: deck.name.toString().substring(0, 50), // 限制名称长度
                coverCardId: deck.coverCardId ? deck.coverCardId.toString() : null,
                cards: [],
                totalCount: 0
            };
            
            // 清理卡组内的卡牌（精简格式）
            if (Array.isArray(deck.cards)) {
                deck.cards.forEach(card => {
                    if (card.id && typeof card.quantity === 'number' && card.quantity > 0) {
                        // 精简格式只需要验证 ID 和数量
                        cleanedDeck.cards.push({
                            id: card.id.toString(),
                            quantity: Math.min(card.quantity, 4) // 限制单卡数量
                        });
                    }
                });
            }
            
            // 计算总数量
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
                name: deck.name.toString().substring(0, 50), // 限制名称长度
                coverCardId: deck.coverCardId ? deck.coverCardId.toString() : null,
                cards: [],
                totalCount: 0
            };
            
            // 清理卡组内的卡牌
            if (Array.isArray(deck.cards)) {
                deck.cards.forEach(card => {
                    if (card.id && typeof card.quantity === 'number' && card.quantity > 0) {
                        // 验证卡牌是否存在
                        const cardDetails = this.getCardDetails(card.id);
                        if (cardDetails) {
                            cleanedDeck.cards.push({
                                id: card.id.toString(),
                                name: cardDetails.name || '未知卡牌',
                                image: cardDetails.image || '',
                                quantity: Math.min(card.quantity, 4) // 限制单卡数量
                            });
                        } else {
                            console.warn(`⚠️ 卡组 ${deck.name} 中包含不存在的卡牌: ${card.id}`);
                        }
                    }
                });
            }
            
            // 计算总数量
            cleanedDeck.totalCount = cleanedDeck.cards.reduce((total, card) => total + card.quantity, 0);
            
            // 自动排序
            this.sortDeckCards(cleanedDeck);
            
            return cleanedDeck;
            
        } catch (error) {
            console.error(`❌ 清理卡组数据失败:`, error);
            return null;
        }
    }

    // 获取精简的卡组数据（用于导出）
    getMinimizedDecks() {
        return this.decks.map(deck => ({
            id: deck.id,
            name: deck.name,
            coverCardId: deck.coverCardId,
            cards: deck.cards.map(card => ({
                id: card.id,           // 只保留 ID
                quantity: card.quantity // 只保留数量
            })),
            totalCount: deck.totalCount
        }));
    }

    // 从精简数据恢复完整卡组
    async restoreDecksFromMinimized(minimizedDecks) {
        const restoredDecks = [];
        
        // 确保卡牌管理器已经预加载了基础信息
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
                
                // 恢复卡组内的卡牌完整信息 - 统一使用卡牌管理器的图片路径
                if (Array.isArray(minimizedDeck.cards)) {
                    for (const minimizedCard of minimizedDeck.cards) {
                        const cardInfo = this.cardManager.getCardBaseInfo(minimizedCard.id);
                        restoredDeck.cards.push({
                            id: minimizedCard.id,
                            name: cardInfo.name,
                            image: cardInfo.image, // 统一使用卡牌管理器生成的图片路径
                            quantity: minimizedCard.quantity
                        });
                    }
                }
                
                // 重新计算总数量
                restoredDeck.totalCount = restoredDeck.cards.reduce((total, card) => total + card.quantity, 0);
                
                // 自动排序
                this.sortDeckCards(restoredDeck);
                
                restoredDecks.push(restoredDeck);
                
            } catch (error) {
                console.error(`❌ 恢复卡组 ${minimizedDeck.name} 失败:`, error);
            }
        }
        
        // console.log(`✅ 成功恢复 ${restoredDecks.length} 个卡组`);
        return restoredDecks;
    }

    // 生成卡牌信息（最简化）
    async generateCardInfo(cardId) {
        // 首先尝试在当前卡牌中查找名称
        const existingCard = this.cardManager.cards.find(c => c.id === cardId);
        const cardName = existingCard ? existingCard.name : `卡牌 ${cardId}`;
        
        return {
            name: cardName,
            image: this.generateCardImage(cardId)
        };
    }

    // 生成卡牌图片路径（最简化）
    generateCardImage(cardId) {
        const paddedId = cardId.toString().padStart(8, '0');
        return `images/hk${paddedId}.webp`;
    }

    // 新增：生成占位符图片
    generatePlaceholderImage(cardId) {
        // 使用一个通用的占位符图片，或者根据卡牌ID生成
        return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23f0f0f0"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23666">卡牌 ${cardId}</text></svg>`;
    }

    // 修改导入卡组数据方法，使用精简格式
    importDecks(data) {
        try {
            const importedDecks = JSON.parse(data);
            const validatedDecks = this.validateAndCleanDecks(importedDecks);
            
            if (validatedDecks.length > 0) {
                // 从精简数据恢复完整卡组
                this.decks = this.restoreDecksFromMinimized(validatedDecks);
                this.currentDeckIndex = 0;
                this.saveDecks();
                // console.log(`✅ 成功导入 ${validatedDecks.length} 个卡组`);
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
                standard: 0, // 60张
                expanded: 0  // 其他数量
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

    // 获取卡组显示卡片（用于卡组编辑界面）
    getDeckDisplayCards() {
        const deck = this.getCurrentDeck();
        return deck ? deck.cards : [];
    }

    // 设置编辑模式
    setEditingMode(editing) {
        this.isEditing = editing;
        if (!editing) {
            this.isSelectingCover = false;
        }
    }

    // 优化 setSelectingCoverMode 方法
    setSelectingCoverMode(selecting) {
        this.isSelectingCover = selecting;
        // console.log(`🖼️ 封面选择模式: ${selecting ? '开启' : '关闭'}`);
    }

    // 删除当前卡组
    deleteCurrentDeck() {
        if (this.decks.length <= 1) {
            // console.log('❌ 不能删除最后一个卡组');
            return false;
        }
        
        const deckToDelete = this.getCurrentDeck();
        if (!deckToDelete) {
            // console.log('❌ 没有找到要删除的卡组');
            return false;
        }
        
        // console.log(`🗑️ 删除卡组: ${deckToDelete.name}`);
        
        // 删除当前卡组
        this.decks.splice(this.currentDeckIndex, 1);
        
        // 切换到第一个卡组
        this.currentDeckIndex = 0;
        
        // 保存更改
        this.saveDecks();
        
        // console.log(`✅ 卡组删除成功，切换到: ${this.getCurrentDeck().name}`);
        return true;
    }

    // 获取卡组统计信息（用于确认对话框）
    getDeckStatsForDelete(deck) {
        return {
            name: deck.name,
            cardCount: deck.totalCount,
            deckCount: this.decks.length
        };
    }    
}