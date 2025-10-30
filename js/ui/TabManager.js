export class TabManager {
    constructor(cardManager, onTabChange) {
        this.cardManager = cardManager;
        this.onTabChange = onTabChange;
        this.currentTab = '宝可梦';
        this.tabsContainer = document.getElementById('tabs-container');
    }

    // 初始化页签
    init() {
        this.renderTabs();
        this.bindEvents();
    }

    // 渲染页签
    renderTabs() {
        const cardTypes = this.cardManager.getCardTypes();
        this.tabsContainer.innerHTML = '';
        
        Object.keys(cardTypes).forEach(tabName => {
            const tab = document.createElement('div');
            tab.className = `tab ${tabName === this.currentTab ? 'active' : ''}`;
            tab.dataset.tab = tabName;
            tab.textContent = tabName;
            this.tabsContainer.appendChild(tab);
        });
    }

    // 绑定事件
    bindEvents() {
        this.tabsContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab')) {
                this.switchTab(e.target.dataset.tab);
            }
        });
    }

    // 切换页签
    async switchTab(tabName) {
        if (tabName === this.currentTab) return;
        
        // 更新当前标签
        this.currentTab = tabName;
        
        // 更新标签样式
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
        
        // 调用回调函数
        if (this.onTabChange) {
            await this.onTabChange(tabName);
        }
    }

    // 获取当前页签
    getCurrentTab() {
        return this.currentTab;
    }
}