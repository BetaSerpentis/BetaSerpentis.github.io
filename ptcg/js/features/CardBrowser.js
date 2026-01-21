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

    // 修改 init 方法，移除事件绑定
    init() {
        this.bindEvents();
    }

    // 修改 bindEvents 方法，只绑定搜索相关事件
    bindEvents() {
        this.searchButton.addEventListener('click', () => {
            this.performSearch();
        });
        
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });
        
        // 注意：不再在这里设置 cardGrid.onCardClick
        // 事件现在由 main.js 统一处理
    }

    // CardBrowser.js - 修复 handleCardClick 方法
    handleCardClick(index, button) {
        // console.log('📱 CardBrowser: 卡牌点击事件');
        // console.log('索引:', index, '按钮:', button, '统计模式:', this.statsManager.isStatModeActive());
        
        // 统计模式处理 - 最高优先级
        if (this.statsManager.isStatModeActive()) {
            // console.log('📊 CardBrowser: 统计模式处理');
            
            const cards = this.cardManager.getDisplayCards();
            if (index < 0 || index >= cards.length) {
                // console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            // console.log('📊 操作卡牌:', card.name, '当前数量:', card.quantity);
            
            if (button === 'left') {
                // 左键：增加数量
                // console.log('➕ 增加数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, 1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            } else if (button === 'right') {
                // 右键：减少数量
                // console.log('➖ 减少数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, -1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            }
            return;
        }
        
        // 正常模式：打开模态框
        // console.log('🌐 正常模式 - 打开模态框');
        this.modalView.show(index);
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

    // 在 CardBrowser.js 中确保 loadCardData 方法正确重置状态
    async loadCardData(cardType) {
        // console.log(`🔄 CardBrowser: 加载 ${cardType} 数据`);
        
        this.cardGrid.showLoading();
        this.loadingStatus.textContent = `正在加载${cardType}数据...`;
        
        try {
            // 先加载卡牌数据
            await this.cardManager.loadCardData(cardType);
            
            // 关键：确保 filteredCards 包含所有该类型的卡牌
            this.cardManager.filteredCards = this.cardManager.cards.filter(card => 
                card.type === cardType
            );
            
            // 关键：确保 getDisplayCards 使用正确的 filteredCards
            this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
            
            this.cardGrid.hideLoading();
            
            const displayCount = this.cardManager.filteredCards.length;
            // console.log(`✅ ${cardType} 数据加载完成，显示 ${displayCount} 张卡牌`);
            
            this.cardGrid.updateSearchInfo(`已加载所有 ${displayCount} 张${cardType}卡牌`);
            this.cardGrid.render();
            
            // 更新搜索框提示
            this.searchInput.placeholder = this.searchEngine.getSearchPlaceholder();
            
        } catch (error) {
            console.error(`❌ 加载 ${cardType} 数据失败:`, error);
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