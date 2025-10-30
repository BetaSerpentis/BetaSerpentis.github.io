export class SearchEngine {
    constructor(cardManager) {
        this.cardManager = cardManager;
    }

    // 执行搜索
    performSearch(searchText) {
        const results = this.cardManager.searchCards(searchText);
        
        if (!searchText.trim()) {
            return {
                cards: results,
                message: `显示全部 ${results.length} 张${this.cardManager.getCurrentTab()}卡牌`
            };
        } else {
            if (results.length === 0) {
                return {
                    cards: results,
                    message: `没有找到匹配"${searchText}"的${this.cardManager.getCurrentTab()}卡牌`
                };
            } else {
                return {
                    cards: results,
                    message: `找到 ${results.length} 张匹配"${searchText}"的${this.cardManager.getCurrentTab()}卡牌`
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