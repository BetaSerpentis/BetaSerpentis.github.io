export class StatsManager {
    constructor(cardManager, onStatsChange) {
        this.cardManager = cardManager;
        this.onStatsChange = onStatsChange;
        this.isStatMode = false;
    }

    init() {
        // 事件绑定现在由 ButtonManager 处理
        // console.log('✅ StatsManager 初始化完成');
    }

    // 绑定事件
    bindEvents() {
        this.statsButton.addEventListener('click', () => {
            this.toggleStatMode();
        });
    }

    // toggleStatMode 方法保持不变
    toggleStatMode() {
        this.isStatMode = !this.isStatMode;
        
        if (this.onStatsChange) {
            this.onStatsChange(this.isStatMode);
        }
        
        if (!this.isStatMode) {
            this.cardManager.saveData();
        }
    }

    // 更新卡牌数量
    updateCardQuantity(index, change) {
        const cards = this.cardManager.getDisplayCards();
        if (index < 0 || index >= cards.length) return;
        
        const card = cards[index];
        const newQuantity = this.cardManager.updateCardQuantity(card.id, change);
        
        this.cardManager.debouncedSave();
        
        return {
            cardId: card.id,
            quantity: newQuantity
        };
    }
    
    // 获取统计模式状态
    isStatModeActive() {
        return this.isStatMode;
    }
}