export class TabManager {
    constructor(cardBrowser, cardManager) {
        this.cardBrowser = cardBrowser;
        this.cardManager = cardManager;
        
        this.tabsContainer = document.getElementById('tabs-container');
        this.generationTabs = document.getElementById('generation-tabs');
        this.generationTabsContainer = document.getElementById('generation-tabs-container');
        
        this.init();
    }

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this.bindEvents();
        this.hideGenerationTabs(); // 初始时隐藏世代筛选栏
    }

    bindEvents() {
        // 原有功能页签事件
        this.tabsContainer.addEventListener('click', (e) => {
            const tab = e.target.closest('.tab');
            if (tab) {
                const tabName = tab.dataset.tab;
                this.switchTab(tabName);
            }
        });

        // 新增世代页签事件
        this.generationTabsContainer.addEventListener('click', (e) => {
            const tab = e.target.closest('.generation-tab');
            if (tab) {
                const generation = tab.dataset.generation;
                this.switchGeneration(generation);
            }
        });
    }

    async switchTab(tabName) {
        // 更新功能页签状态
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');

        // 显示/隐藏世代筛选栏
        if (tabName === '宝可梦') {
            this.showGenerationTabs();
        } else {
            this.hideGenerationTabs();
            // 切换到非宝可梦类型时重置世代筛选
            this.cardManager.setCurrentGeneration('all');
            this.updateGenerationTabStates();
        }

        // 加载卡牌数据
        await this.cardBrowser.loadCardData(tabName);
    }

    switchGeneration(generation) {
        // 更新世代页签状态
        this.updateGenerationTabStates(generation);
        
        // 设置当前世代
        this.cardManager.setCurrentGeneration(generation);
        
        // 应用世代筛选
        this.applyGenerationFilter();
    }

    // 更新世代页签状态
    updateGenerationTabStates(activeGeneration = 'all') {
        document.querySelectorAll('.generation-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.dataset.generation === activeGeneration) {
                tab.classList.add('active');
            }
        });
    }

    applyGenerationFilter() {
        const generation = this.cardManager.getCurrentGeneration();
        const cards = this.cardManager.cards;
        
        // 应用世代筛选
        const filteredCards = this.cardManager.applyGenerationFilter(generation);
        
        // 更新显示
        const displayCount = filteredCards.length;
        const generationName = this.cardManager.getGenerationName(generation);
        
        this.cardBrowser.cardGrid.updateSearchInfo(
            generation === 'all' 
                ? `显示所有 ${displayCount} 张宝可梦卡牌`
                : `显示 ${generationName} (${displayCount} 张卡牌)`
        );
        
        this.cardBrowser.cardGrid.render();
    }

    showGenerationTabs() {
        this.generationTabs.style.display = 'block';
        setTimeout(() => {
            this.generationTabs.classList.add('show');
        }, 10);
    }

    hideGenerationTabs() {
        this.generationTabs.classList.remove('show');
        setTimeout(() => {
            this.generationTabs.style.display = 'none';
        }, 300); // 等待动画完成
    }

    // 重新应用当前筛选条件
    refreshFilters() {
        const currentTab = this.cardManager.getCurrentTab();
        
        if (currentTab === '宝可梦' && this.cardManager.getCurrentGeneration() !== 'all') {
            this.applyGenerationFilter();
        }
    }
}