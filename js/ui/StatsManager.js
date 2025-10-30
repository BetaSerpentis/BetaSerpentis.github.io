export class StatsManager {
    constructor(cardManager, onStatsChange) {
        this.cardManager = cardManager;
        this.onStatsChange = onStatsChange;
        this.isStatMode = false;
        this.statsButton = document.getElementById('stats-button');
    }

    // 初始化
    init() {
        this.bindEvents();
    }

    // 绑定事件
    bindEvents() {
        this.statsButton.addEventListener('click', () => {
            this.toggleStatMode();
        });
    }

    // 切换统计模式
    toggleStatMode() {
        this.isStatMode = !this.isStatMode;
        const body = document.body;
        
        if (this.isStatMode) {
            this.statsButton.textContent = '完成';
            this.statsButton.classList.add('active');
            body.classList.add('stat-mode');
        } else {
            this.statsButton.textContent = '统计';
            this.statsButton.classList.remove('active');
            body.classList.remove('stat-mode');
            
            // 退出统计模式时自动保存
            this.cardManager.saveData();
        }
        
        // 调用回调函数
        if (this.onStatsChange) {
            this.onStatsChange(this.isStatMode);
        }
    }

    // 更新卡牌数量
    updateCardQuantity(index, change) {
        const cards = this.cardManager.getDisplayCards();
        if (index < 0 || index >= cards.length) return;
        
        const card = cards[index];
        const newQuantity = this.cardManager.updateCardQuantity(card.id, change);
        
        // 防抖保存
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