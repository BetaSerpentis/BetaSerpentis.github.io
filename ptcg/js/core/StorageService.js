import { STORAGE_KEYS, CARD_TYPES } from '../utils/constants.js';
import { showSaveSuccess, showSaveError } from '../utils/helpers.js';

export class StorageService {
    constructor() {
        this.saveTimeout = null;
    }

    // 保存卡牌数量数据（保持原有方法兼容）
    saveCardQuantities(cards, currentTab) {
        try {
            // 获取现有的所有数据
            const existingData = this.getAllCardQuantities();
            
            // 更新当前类型的数据
            const saveData = cards.map(card => ({
                id: card.id,
                type: currentTab,
                quantity: card.quantity,
                name: card.name
            }));
            
            // 合并数据
            existingData[currentTab] = saveData.filter(card => card.quantity > 0);
            
            // 保存到 localStorage
            const allData = this.flattenQuantities(existingData);
            localStorage.setItem(STORAGE_KEYS.CARD_QUANTITIES, JSON.stringify(allData));
            localStorage.setItem(STORAGE_KEYS.LAST_SAVED, new Date().toISOString());
            
            // console.log(`${currentTab}数据保存成功`);
            return true;
            
        } catch (error) {
            console.error('保存数据失败:', error);
            showSaveError('保存数据失败');
            return false;
        }
    }

    // 加载卡牌数量数据（保持原有方法兼容）
    loadCardQuantities(cards, cardType) {
        const localData = localStorage.getItem(STORAGE_KEYS.CARD_QUANTITIES);
        if (!localData) return cards;

        try {
            const localQuantities = JSON.parse(localData);
            const quantityMap = new Map();
            
            localQuantities.forEach(item => {
                quantityMap.set(`${item.type}_${item.id}`, item.quantity);
            });
            
            return cards.map(card => {
                const savedQuantity = quantityMap.get(`${cardType}_${card.id}`);
                if (savedQuantity !== undefined) {
                    card.quantity = savedQuantity;
                }
                return card;
            });
            
        } catch (e) {
            console.warn('解析本地数据失败:', e);
            return cards;
        }
    }

    // 导出所有数据（卡牌数量 + 卡组）
    async exportAllData(cardManager, deckManager) {
        try {
            // console.log('📤 开始导出所有数据...');
            
            // 获取所有卡牌数量数据
            const cardQuantities = await cardManager.getAllCardQuantities();
            
            // 验证数据
            if (!cardQuantities || typeof cardQuantities !== 'object') {
                throw new Error('获取卡牌数量数据失败');
            }
            
            // 获取精简的卡组数据
            const decks = deckManager.getMinimizedDecks();
            
            // 构建导出数据
            const exportData = {
                version: "1.0",
                exportTime: new Date().toISOString(),
                metadata: {
                    totalCards: this.countTotalCards(cardQuantities),
                    totalDecks: decks.length,
                    appVersion: "1.0"
                },
                cards: cardQuantities,
                decks: decks
            };
            
            // 生成文件
            const dataStr = JSON.stringify(exportData, null, 2);
            const dataBlob = new Blob([dataStr], {type: 'application/json'});
            
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `ptcg-collection-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            const cardCount = this.countTotalCards(cardQuantities);
            showSaveSuccess(`已导出 ${cardCount} 张卡牌和 ${decks.length} 个卡组`);
            
        } catch (error) {
            console.error('导出数据失败:', error);
            showSaveError(`导出数据失败: ${error.message}`);
        }
    }

    // 导入所有数据（卡牌数量 + 卡组）
    importAllData(cardManager, deckManager, onImportComplete) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const importData = JSON.parse(event.target.result);
                    
                    // 验证文件格式
                    if (!this.validateImportData(importData)) {
                        showSaveError('导入失败：文件格式不正确');
                        return;
                    }
                    
                    // 执行导入
                    const result = await this.executeImport(importData, cardManager, deckManager);
                    
                    if (result.success) {
                        onImportComplete(result);
                    } else {
                        showSaveError(`导入失败: ${result.error}`);
                    }
                    
                } catch (error) {
                    console.error('导入数据失败:', error);
                    showSaveError('导入失败：文件格式不正确');
                }
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    }

    // 验证导入数据格式
    validateImportData(data) {
        return data && 
               data.version === "1.0" &&
               data.cards && 
               typeof data.cards === 'object' &&
               data.decks && 
               Array.isArray(data.decks);
    }

    // 执行导入操作
    async executeImport(importData, cardManager, deckManager) {
        try {
            // console.log('📥 开始执行导入操作...');
            
            // 验证导入数据
            console.log('导入数据验证:', {
                卡牌类型: Object.keys(importData.cards),
                各类型卡牌数量: Object.keys(importData.cards).map(type => ({
                    类型: type,
                    数量: importData.cards[type].length
                })),
                卡组数量: importData.decks?.length || 0
            });
            
            // 1. 更新卡牌数量到本地存储
            // console.log('🔄 步骤1: 更新卡牌数量到本地存储...');
            const cardUpdateCount = await cardManager.updateAllCardQuantities(importData.cards);
            
            // 验证本地存储是否更新
            const storedData = this.getAllCardQuantities();
            console.log('本地存储验证:', {
                存储的类型: Object.keys(storedData),
                各类型存储数量: Object.keys(storedData).map(type => ({
                    类型: type,
                    数量: storedData[type].length
                }))
            });
            
            // 2. 更新卡组数据
            // console.log('🔄 步骤2: 更新卡组数据...');
            let deckUpdateCount = 0;
            if (importData.decks && Array.isArray(importData.decks)) {
                const restoredDecks = await deckManager.restoreDecksFromMinimized(importData.decks);
                deckManager.decks = restoredDecks;
                deckManager.currentDeckIndex = 0;
                deckManager.saveDecks();
                deckUpdateCount = restoredDecks.length;
            }
            
            console.log('✅ 导入操作完成:', {
                保存的卡牌: cardUpdateCount,
                更新的卡组: deckUpdateCount
            });
            
            return {
                success: true,
                cardsUpdated: cardUpdateCount,
                decksUpdated: deckUpdateCount,
                message: `成功导入 ${cardUpdateCount} 张卡牌和 ${deckUpdateCount} 个卡组`
            };
            
        } catch (error) {
            console.error('执行导入失败:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // 获取所有卡牌数量数据（按类型分组）
    getAllCardQuantities() {
        const localData = localStorage.getItem(STORAGE_KEYS.CARD_QUANTITIES);
        if (!localData) return this.initializeEmptyQuantities();

        try {
            const allQuantities = JSON.parse(localData);
            return this.groupQuantitiesByType(allQuantities);
        } catch (e) {
            console.warn('解析本地数据失败:', e);
            return this.initializeEmptyQuantities();
        }
    }

    // 初始化空的卡牌数量结构
    initializeEmptyQuantities() {
        const quantities = {};
        Object.keys(CARD_TYPES).forEach(type => {
            quantities[type] = [];
        });
        return quantities;
    }

    // 按类型分组卡牌数量数据
    groupQuantitiesByType(flatQuantities) {
        const grouped = this.initializeEmptyQuantities();
        
        flatQuantities.forEach(item => {
            if (item.type && grouped[item.type]) {
                grouped[item.type].push({
                    id: item.id,
                    quantity: item.quantity
                });
            }
        });
        
        return grouped;
    }

    // 将分组数据扁平化
    flattenQuantities(groupedQuantities) {
        const flat = [];
        Object.keys(groupedQuantities).forEach(type => {
            groupedQuantities[type].forEach(card => {
                flat.push({
                    id: card.id,
                    type: type,
                    quantity: card.quantity
                });
            });
        });
        return flat;
    }

    // 计算总卡牌数量
    countTotalCards(cardQuantities) {
        let total = 0;
        Object.keys(cardQuantities).forEach(type => {
            total += cardQuantities[type].length;
        });
        return total;
    }

    // 防抖保存（保持原有方法兼容）
    debouncedSave(cards, currentTab) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveCardQuantities(cards, currentTab);
        }, 500);
    }

    // 保存卡组数据（保持原有方法兼容）
    saveDecks(decks) {
        try {
            localStorage.setItem(STORAGE_KEYS.DECKS, JSON.stringify(decks));
            // console.log('卡组数据保存成功');
            return true;
        } catch (error) {
            console.error('保存卡组数据失败:', error);
            return false;
        }
    }

    // 加载卡组数据（保持原有方法兼容）
    loadDecks() {
        try {
            const decksData = localStorage.getItem(STORAGE_KEYS.DECKS);
            return decksData ? JSON.parse(decksData) : null;
        } catch (error) {
            console.error('加载卡组数据失败:', error);
            return null;
        }
    }

    // 清空所有数量数据
    clearAllQuantities() {
        localStorage.setItem(STORAGE_KEYS.CARD_QUANTITIES, JSON.stringify([]));
        // console.log('🗑️ 清空本地存储中的所有卡牌数量');
    }

    // 为导入保存卡牌数量
    saveCardQuantitiesForImport(cardType, importedCards) {
        try {
            // 获取现有的所有数据
            const existingData = this.getAllCardQuantities();
            
            // 更新当前类型的数据（使用导入的数据）
            existingData[cardType] = importedCards
                .filter(card => card.quantity > 0) // 只保存数量>0的
                .map(card => ({
                    id: card.id,
                    type: cardType, // 确保包含类型
                    quantity: card.quantity
                }));
            
            // 保存到 localStorage
            const allData = this.flattenQuantities(existingData);
            localStorage.setItem(STORAGE_KEYS.CARD_QUANTITIES, JSON.stringify(allData));
            
            // console.log(`💾 ${cardType}: 保存了 ${existingData[cardType].length} 张卡牌数量`);
            return existingData[cardType].length;
            
        } catch (error) {
            console.error(`❌ 保存 ${cardType} 导入数据失败:`, error);
            return 0;
        }
    }
}