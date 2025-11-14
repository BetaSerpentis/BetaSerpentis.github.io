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

    // 排序卡组中的卡牌
    sortDeckCards(deck) {
        if (!deck || !deck.cards) return;
        
        const typeOrder = this.getCardTypeOrder();
        
        deck.cards.sort((a, b) => {
            const typeA = this.getCardType(a.id);
            const typeB = this.getCardType(b.id);
            
            const orderA = typeOrder[typeA] || 999;
            const orderB = typeOrder[typeB] || 999;
            
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            
            // 同类型按名称排序
            const nameA = a.name || '';
            const nameB = b.name || '';
            return nameA.localeCompare(nameB);
        });
    }

    // 更新卡组中的卡牌数量
    // 在更新卡牌数量后自动排序
    updateCardQuantity(cardId, change) {
        console.log('🔄 DeckManager: 更新卡牌数量');
        
        const deck = this.getCurrentDeck();
        if (!deck) {
            console.log('❌ 没有找到当前卡组');
            return null;
        }

        console.log('当前卡组:', deck.name);
        console.log('卡组中的卡牌:', deck.cards);

        const existingCard = deck.cards.find(card => card.id === cardId);
        console.log('找到现有卡牌:', existingCard);
        
        if (existingCard) {
            existingCard.quantity = Math.max(0, existingCard.quantity + change);
            console.log('更新后数量:', existingCard.quantity);
            
            if (existingCard.quantity === 0) {
                deck.cards = deck.cards.filter(card => card.id !== cardId);
                console.log('卡牌数量为0，从卡组移除');
            }
        } else if (change > 0) {
            console.log('添加新卡牌到卡组');
            const cardData = this.cardManager.cards.find(card => card.id === cardId);
            if (cardData) {
                const newCard = {
                    id: cardId,
                    name: cardData.name,
                    image: cardData.image,
                    quantity: change
                };
                deck.cards.push(newCard);
                console.log('新卡牌添加成功:', newCard);
            } else {
                console.log('❌ 没有找到卡牌数据');
            }
        }

        deck.totalCount = deck.cards.reduce((total, card) => total + card.quantity, 0);
        console.log('卡组总数量:', deck.totalCount);
        
        // 自动排序
        this.sortDeckCards(deck);
        
        this.saveDecks();
        
        const result = deck.cards.find(card => card.id === cardId);
        console.log('最终结果:', result);
        return result;
    }

    // 设置卡组封面
    setDeckCover(cardId) {
        const deck = this.getCurrentDeck();
        if (deck) {
            deck.coverCardId = cardId;
            this.saveDecks();
            return true;
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

    // 导入卡组数据
    importDecks(data) {
        try {
            const importedDecks = JSON.parse(data);
            if (Array.isArray(importedDecks)) {
                this.decks = importedDecks;
                this.currentDeckIndex = 0;
                this.saveDecks();
                return true;
            }
        } catch (error) {
            console.error('导入卡组数据失败:', error);
        }
        return false;
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

    // 设置选择封面模式
    setSelectingCoverMode(selecting) {
        this.isSelectingCover = selecting;
    }
}