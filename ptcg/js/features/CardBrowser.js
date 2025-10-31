export class CardBrowser {
    constructor(cardManager, imageLoader, cardGrid, modalView, statsManager, searchEngine) {
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.cardGrid = cardGrid;
        this.modalView = modalView;
        this.statsManager = statsManager;
        this.searchEngine = searchEngine;
        
        this.searchInput = document.getElementById('search-input');
        this.searchButton = document.getElementById('search-button');
        this.loadingStatus = document.getElementById('loading-status');
        
        this.init();
    }

    // 初始化
    init() {
        this.bindEvents();
    }

    // 绑定事件
    bindEvents() {
        this.searchButton.addEventListener('click', () => {
            this.performSearch();
        });
        
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });
        
        // 设置卡牌点击回调
        this.cardGrid.onCardClick = (index, button) => {
            this.handleCardClick(index, button);
        };
        
        // 设置数量变化回调
        this.cardGrid.onQuantityChange = (index, change) => {
            this.handleQuantityChange(index, change);
        };
    }

    // 处理卡牌点击
    handleCardClick(index, button) {
        if (this.statsManager.isStatModeActive()) {
            if (button === 'left') {
                this.handleQuantityChange(index, 1);
            }
        } else {
            this.modalView.show(index);
        }
    }

    // 处理数量变化
    handleQuantityChange(index, change) {
        if (!this.statsManager.isStatModeActive()) return;
        
        const result = this.statsManager.updateCardQuantity(index, change);
        if (result) {
            this.cardGrid.updateCardQuantityDisplay(result.cardId, result.quantity);
        }
    }

    // 执行搜索
    performSearch() {
        const searchText = this.searchInput.value;
        const searchResult = this.searchEngine.performSearch(searchText);
        
        this.cardGrid.updateSearchInfo(searchResult.message);
        this.cardGrid.render();
    }

    // 加载卡牌数据
    async loadCardData(cardType) {
        this.cardGrid.showLoading();
        this.loadingStatus.textContent = `正在加载${cardType}数据...`;
        
        try {
            await this.cardManager.loadCardData(cardType);
            this.cardGrid.hideLoading();
            this.cardGrid.updateSearchInfo(`已加载所有 ${this.cardManager.cards.length} 张${cardType}卡牌`);
            this.cardGrid.render();
            
            // 更新搜索框提示
            this.searchInput.placeholder = this.searchEngine.getSearchPlaceholder();
            
        } catch (error) {
            this.loadingStatus.textContent = `加载失败: ${error.message}`;
        }
    }

    // 显示加载状态
    showLoading(message = '正在加载卡牌数据...') {
        this.loadingStatus.textContent = message;
        this.cardGrid.showLoading();
    }

    // 隐藏加载状态
    hideLoading() {
        this.cardGrid.hideLoading();
    }
}