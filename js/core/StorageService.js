import { STORAGE_KEYS } from '../utils/constants.js';
import { showSaveSuccess, showSaveError } from '../utils/helpers.js';

export class StorageService {
    constructor() {
        this.saveTimeout = null;
    }

    // 保存卡牌数量数据
    saveCardQuantities(cards, currentTab) {
        try {
            const saveData = cards.map(card => ({
                id: card.id,
                type: currentTab,
                quantity: card.quantity,
                name: card.name
            }));
            
            localStorage.setItem(STORAGE_KEYS.CARD_QUANTITIES, JSON.stringify(saveData));
            localStorage.setItem(STORAGE_KEYS.LAST_SAVED, new Date().toISOString());
            
            console.log(`${currentTab}数据保存到LocalStorage成功`);
            return true;
            
        } catch (error) {
            console.error('保存数据失败:', error);
            showSaveError('保存数据失败');
            return false;
        }
    }

    // 加载卡牌数量数据
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

    // 导出数据
    exportData(cards, currentTab) {
        const exportData = cards
            .filter(card => card.quantity > 0)
            .map(card => ({
                id: card.id,
                type: currentTab,
                quantity: card.quantity
            }));
        
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], {type: 'application/json'});
        
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `pokemon-cards-${currentTab}-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        showSaveSuccess(`已导出 ${exportData.length} 张${currentTab}卡牌数据`);
    }

    // 导入数据
    importData(cards, currentTab, onImportComplete) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    const importData = JSON.parse(event.target.result);
                    const quantityMap = new Map();
                    
                    importData.forEach(item => {
                        if (item.id && typeof item.quantity === 'number') {
                            quantityMap.set(item.id, item.quantity);
                        }
                    });
                    
                    let updatedCount = 0;
                    cards.forEach(card => {
                        const importedQuantity = quantityMap.get(card.id);
                        if (importedQuantity !== undefined) {
                            card.quantity = importedQuantity;
                            updatedCount++;
                        } else {
                            card.quantity = 0;
                        }
                    });
                    
                    onImportComplete(updatedCount);
                    
                } catch (error) {
                    console.error('导入数据失败:', error);
                    showSaveError('导入失败：文件格式不正确');
                }
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    }

    // 防抖保存
    debouncedSave(cards, currentTab) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveCardQuantities(cards, currentTab);
        }, 500);
    }
}