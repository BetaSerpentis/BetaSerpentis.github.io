export class SearchEngine {
    constructor(cardManager) {
        this.cardManager = cardManager;
    }

    // 执行搜索（更新以考虑世代筛选）
    performSearch(searchText) {
        const results = this.cardManager.searchCards(searchText);
        
        const currentTab = this.cardManager.getCurrentTab();
        const currentGeneration = this.cardManager.getCurrentGeneration();
        
        if (!searchText.trim()) {
            let message = `显示全部 ${results.length} 张${currentTab}卡牌`;
            
            // 如果是宝可梦类型且应用了世代筛选
            if (currentTab === '宝可梦' && currentGeneration !== 'all') {
                const generationName = this.cardManager.getGenerationName(currentGeneration);
                message = `显示${generationName}: ${results.length} 张卡牌`;
            }
            
            return {
                cards: results,
                message: message
            };
        } else {
            if (results.length === 0) {
                let message = `没有找到匹配"${searchText}"的${currentTab}卡牌`;
                
                // 如果是宝可梦类型且应用了世代筛选
                if (currentTab === '宝可梦' && currentGeneration !== 'all') {
                    const generationName = this.cardManager.getGenerationName(currentGeneration);
                    message = `在${generationName}中没有找到匹配"${searchText}"的卡牌`;
                }
                
                return {
                    cards: results,
                    message: message
                };
            } else {
                let message = `找到 ${results.length} 张匹配"${searchText}"的${currentTab}卡牌`;
                
                // 如果是宝可梦类型且应用了世代筛选
                if (currentTab === '宝可梦' && currentGeneration !== 'all') {
                    const generationName = this.cardManager.getGenerationName(currentGeneration);
                    message = `在${generationName}中找到 ${results.length} 张匹配"${searchText}"的卡牌`;
                }
                
                return {
                    cards: results,
                    message: message
                };
            }
        }
    }

    // 获取搜索提示
    getSearchPlaceholder() {
        const currentTab = this.cardManager.getCurrentTab();
        if (currentTab === '宝可梦') {
            return '搜索宝可梦名字、特性、技能效果...';
        } else {
            return '搜索卡牌名字、效果...';
        }
    }
}