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

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this.bindEvents();
    }

    // 只绑定搜索相关事件；卡牌点击由 main.js 统一处理
    bindEvents() {
        this.searchButton?.addEventListener('click', () => {
            this.performSearch();
        });

        this.searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });
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

    // 执行搜索（更新以考虑世代筛选）
    performSearch() {
        const searchText = this.searchInput.value;
        const searchResult = this.searchEngine.performSearch(searchText);
        
        // 显示搜索和筛选的综合结果
        const generation = this.cardManager.getCurrentGeneration();
        const generationName = this.cardManager.getGenerationName(generation);
        
        let message = searchResult.message;
        
        // 如果是宝可梦类型且应用了世代筛选，添加世代信息
        if (this.cardManager.getCurrentTab() === '宝可梦' && generation !== 'all') {
            message = `在${generationName}中${searchResult.message.includes('显示全部') ? '显示全部' : '搜索'}: ${searchResult.cards.length} 张`;
        }
        
        this.cardGrid.updateSearchInfo(message);
        this.cardGrid.render();
    }

    // 在 CardBrowser.js 中确保 loadCardData 方法正确重置状态
    async loadCardData(cardType) {
        // console.log(`🔄 CardBrowser: 加载 ${cardType} 数据`);

        this.cardGrid.showLoading();
        if (this.loadingStatus) this.loadingStatus.textContent = `正在加载${cardType}数据...`;

        try {
            // 先加载 idx 索引完成首屏渲染，再后台补 search/filter。
            await this.cardManager.loadCardData(cardType, {
                onSupplementalLoaded: loadedType => this.handleSupplementalLoaded(loadedType)
            });

            this.renderLoadedCards(cardType, true, true);
        } catch (error) {
            console.error(`❌ 加载 ${cardType} 数据失败:`, error);
            if (this.loadingStatus) this.loadingStatus.textContent = `加载失败: ${error.message}`;
            this.cardGrid.hideLoading();
        }
    }

    async loadPokemonWithInitialBatch() {
        await this.cardManager.loadCardData('宝可梦', {
            onSupplementalLoaded: loadedType => this.handleSupplementalLoaded(loadedType)
        });
        this.renderLoadedCards('宝可梦', true, true);
    }

    handleSupplementalLoaded(cardType) {
        if (this.cardManager.getCurrentTab() !== cardType) return;

        const hasSearchText = this.searchInput && this.searchInput.value.trim();
        if (hasSearchText) {
            this.performSearch();
            return;
        }

        this.renderLoadedCards(cardType, false, false);
    }

    renderLoadedCards(cardType, resetSearchState = false, isIndexOnly = false) {
        if (resetSearchState) {
            this.cardManager.isShowingAllCards = true;
            this.cardManager.hasActiveSearch = false;
        }

        // 世代筛选
        if (cardType === '宝可梦' && this.cardManager.getCurrentGeneration() !== 'all') {
            this.cardManager.applyGenerationFilter();
        }

        // 卡包筛选：re-sync state to ensure currentSetCode survives card reload
        if (window.setFilterManager) {
            window.setFilterManager.syncState();
        }

        this.cardManager.filteredCards = this.cardManager.cards.filter(card =>
            card.type === cardType
        );

        const displayCards = this.cardManager.getDisplayCards();
        const displayCount = displayCards.length;

        let displayMessage = isIndexOnly
            ? `已加载 ${displayCount} 张${cardType}卡牌，正在补充搜索/筛选数据`
            : `已加载所有 ${displayCount} 张${cardType}卡牌`;

        if (cardType === '宝可梦' && this.cardManager.getCurrentGeneration() !== 'all') {
            const generationName = this.cardManager.getGenerationName(this.cardManager.getCurrentGeneration());
            displayMessage = isIndexOnly
                ? `显示${generationName}: ${displayCount} 张卡牌，正在补充搜索/筛选数据`
                : `显示${generationName}: ${displayCount} 张卡牌`;
        }

        this.cardGrid.updateSearchInfo(displayMessage);
        this.cardGrid.render();

        this.searchInput.placeholder = this.searchEngine.getSearchPlaceholder();
    }

    // 显示加载状态
    showLoading(message = '正在加载卡牌数据...') {
        if (this.loadingStatus) this.loadingStatus.textContent = message;
        this.cardGrid.showLoading();
    }

    // 隐藏加载状态
    hideLoading() {
        this.cardGrid.hideLoading();
    }
}