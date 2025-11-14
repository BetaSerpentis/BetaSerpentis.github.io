export class CardGrid {
    // CardGrid.js - 在构造函数中确保方法可用
    constructor(cardManager, imageLoader, onCardClick, onQuantityChange) {
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.onCardClick = onCardClick;
        this.onQuantityChange = onQuantityChange;
        
        this.cardGrid = document.getElementById('card-grid');
        this.noResults = document.getElementById('no-results');
        this.loadingSection = document.getElementById('loading-section');
        
        this.batchSize = 50;
        this.currentBatch = 0;
        this.isLoadingBatch = false;
        
        // 确保统计模式检测方法可用
        this.isStatsModeActive = this.isStatsModeActive.bind(this);
        
        // 触摸相关变量
        this.cardTouchStartTime = 0;
        this.cardTouchStartX = 0;
        this.cardTouchStartY = 0;
        this.cardTouchCount = 0;
        this.cardIsMultiTouch = false;
        this.cardLastTouchEndTime = 0;
        this.cardDoubleTouchProcessed = false;
    }

    // CardGrid.js - 修复 init 方法
    init() {
        console.log('🔄 CardGrid 初始化懒加载');
        this.imageLoader.setOnLoadMore(() => {
            this.loadNextBatch();
        });
        
        // 确保懒加载观察器已启动
        this.imageLoader.initLazyLoading();
    }

    // 渲染卡牌网格
    // 修复 render 方法中的错误调用
    render() {
        this.cardGrid.innerHTML = '';
        this.currentBatch = 0;
        this.imageLoader.reset();
        
        const cards = this.cardManager.getDisplayCards();
        
        if (cards.length === 0) {
            this.noResults.style.display = 'block';
            this.cardGrid.style.display = 'none';
        } else {
            this.noResults.style.display = 'none';
            this.cardGrid.style.display = 'grid';
            this.loadNextBatch();
            
            // 修复：移除错误的方法调用
            // setTimeout(() => {
            //     this.imageLoader.checkVisibleImages(); // 这行会导致错误
            // }, 100);
        }
    }

    // 加载下一批卡牌
    // CardGrid.js - 修复 loadNextBatch 和 render 方法中的错误调用
    loadNextBatch() {
        if (this.isLoadingBatch) return;
        
        const cards = this.cardManager.getDisplayCards();
        const startIndex = this.currentBatch * this.batchSize;
        
        if (startIndex >= cards.length) return;
        
        this.isLoadingBatch = true;
        const endIndex = Math.min(startIndex + this.batchSize, cards.length);
        
        const fragment = document.createDocumentFragment();
        
        for (let i = startIndex; i < endIndex; i++) {
            try {
                const card = cards[i];
                const cardElement = this.createCardElement(card, i);
                fragment.appendChild(cardElement);
            } catch (error) {
                console.error(`创建卡牌元素失败 (索引 ${i}):`, error);
                continue;
            }
        }
        
        const oldTrigger = document.getElementById('load-more-trigger');
        if (oldTrigger) oldTrigger.remove();
        
        this.cardGrid.appendChild(fragment);
        
        if (endIndex < cards.length) {
            const loadMoreTrigger = document.createElement('div');
            loadMoreTrigger.id = 'load-more-trigger';
            loadMoreTrigger.style.height = '50px';
            loadMoreTrigger.style.width = '100%';
            this.cardGrid.appendChild(loadMoreTrigger);
            this.imageLoader.observeLoadMoreTrigger(loadMoreTrigger);
        }
        
        this.currentBatch++;
        this.isLoadingBatch = false;
        
        // 修复：使用正确的方法名 - 移除这行或者使用正确的方法
        // this.imageLoader.checkVisibleImages(); // 这行会导致错误
    }

    // CardGrid.js - 修复 createCardElement 方法，添加图片观察
    createCardElement(card, index) {
        const cardElement = document.createElement('div');
        cardElement.className = 'card';
        cardElement.dataset.index = index;
        cardElement.dataset.cardId = card.id;

        const img = document.createElement('img');
        img.className = 'card-img';
        img.dataset.src = card.image;
        img.dataset.index = index;
        img.alt = card.name;
        img.dataset.loading = 'false';
        
        const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23f0f0f0"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23666">加载中...</text></svg>`;
        img.src = svgPlaceholder;

        // 简化的模式检测
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const hasSearchHeader = document.querySelector('.search-header').style.display !== 'none';
        
        // 数量显示逻辑
        let displayQuantity = 0;
        let shouldDisplayQuantity = false;
        
        if (isDeckMode && !hasSearchHeader) {
            // 卡组模式（显示卡组页签，隐藏搜索栏）：数量为1不显示
            if (this.deckManager) {
                const currentDeck = this.deckManager.getCurrentDeck();
                if (currentDeck) {
                    const deckCard = currentDeck.cards.find(c => c.id === card.id);
                    displayQuantity = deckCard ? deckCard.quantity : 0;
                    shouldDisplayQuantity = displayQuantity > 1;
                }
            }
        } else {
            // 卡牌浏览模式（显示搜索栏）：数量为1也要显示
            if (isDeckMode && this.deckManager) {
                // 卡组新增界面：显示卡组内的数量
                const currentDeck = this.deckManager.getCurrentDeck();
                if (currentDeck) {
                    const deckCard = currentDeck.cards.find(c => c.id === card.id);
                    displayQuantity = deckCard ? deckCard.quantity : 0;
                    shouldDisplayQuantity = displayQuantity > 0;
                }
            } else {
                // 统计模式或正常浏览：显示拥有数量
                displayQuantity = card.quantity;
                shouldDisplayQuantity = displayQuantity > 0;
            }
        }
        
        // 显示数量
        if (shouldDisplayQuantity) {
            const quantity = document.createElement('div');
            quantity.className = 'card-quantity';
            quantity.textContent = displayQuantity;
            cardElement.appendChild(quantity);
        }
        
        cardElement.appendChild(img);
        
        // 绑定事件
        const elementWithEvents = this.bindCardEvents(cardElement, index);
        
        // 重要：观察图片加载 - 这行是修复自动加载的关键
        this.imageLoader.observeImage(img);
        
        return elementWithEvents;
    }

    // 绑定卡牌事件
    // CardGrid.js - 简化 bindCardEvents 方法
    bindCardEvents(cardElement, index) {
        // console.log('🎮 绑定卡牌事件 - 索引:', index);
        
        let clickProcessed = false;
        
        const handleClick = (e) => {
            if (clickProcessed) return;
            clickProcessed = true;
            
            console.log('🖱️ 卡牌点击 - 索引:', index, '按钮:', e.type);
            
            if (this.onCardClick) {
                const buttonType = e.type === 'contextmenu' ? 'right' : 'left';
                console.log('📞 调用 onCardClick, 按钮:', buttonType);
                this.onCardClick(index, buttonType);
            }
            
            setTimeout(() => { clickProcessed = false; }, 300);
        };

        cardElement.addEventListener('click', (e) => {
            e.preventDefault();
            handleClick(e);
        });

        cardElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            handleClick(e);
        });
        
        return cardElement;
    }

    // 新增：更可靠的统计模式检测方法
    isStatsModeActive() {
        // 方法1：检查统计按钮状态
        const statsButton = document.querySelector('.stats-button');
        if (statsButton && statsButton.classList.contains('active')) {
            return true;
        }
        
        // 方法2：检查统计面板是否可见
        const statsPanel = document.querySelector('.stats-panel');
        if (statsPanel && statsPanel.style.display !== 'none') {
            return true;
        }
        
        // 方法3：检查是否有统计模式特定的类名
        if (document.querySelector('.stats-mode-active')) {
            return true;
        }
        
        // 方法4：检查全局变量（如果存在）
        if (window.isStatsModeActive && typeof window.isStatsModeActive === 'function') {
            return window.isStatsModeActive();
        }
        
        return false;
    }

    // 新增：统计模式事件绑定
    bindStatsModeEvents(cardElement, index) {
        let clickProcessed = false;
        
        const handleClick = (e) => {
            if (clickProcessed) return;
            clickProcessed = true;
            
            console.log('📊 统计模式点击 - 索引:', index, '类型:', e.type);
            
            const cards = this.cardManager.getDisplayCards();
            if (index < 0 || index >= cards.length) {
                console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            console.log('📊 操作卡牌:', card.name, '当前数量:', card.quantity);
            
            if (e.type === 'click' || e.button === 0) {
                // 左键：增加数量
                console.log('➕ 统计模式增加数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, 1);
                this.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
                this.showStatsOperationFeedback(card.name, 1);
            } else if (e.type === 'contextmenu' || e.button === 2) {
                // 右键：减少数量
                console.log('➖ 统计模式减少数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, -1);
                this.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
                this.showStatsOperationFeedback(card.name, -1);
            }
            
            setTimeout(() => { clickProcessed = false; }, 300);
        };

        cardElement.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleClick(e);
        });

        cardElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleClick(e);
        });
        
        return cardElement;
    }

    // 新增：统计模式操作反馈
    showStatsOperationFeedback(cardName, change) {
        const feedback = document.createElement('div');
        feedback.textContent = `${cardName} ${change > 0 ? '增加' : '减少'}成功`;
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 5px;
            z-index: 1001;
            font-size: 1rem;
        `;
        
        document.body.appendChild(feedback);
        setTimeout(() => {
            feedback.remove();
        }, 1000);
    }

    // 添加紧急处理方法
    emergencyDeckEditHandler(index, change) {
        console.log('🆘 紧急处理卡组编辑 - 索引:', index, '变化:', change);
        
        const cards = this.cardManager.getDisplayCards();
        if (index < 0 || index >= cards.length) {
            console.log('❌ 索引超出范围');
            return;
        }
        
        const card = cards[index];
        console.log('🃏 操作卡牌:', card.name, 'ID:', card.id);
        
        if (this.deckManager) {
            const result = this.deckManager.updateCardQuantity(card.id, change);
            console.log('✅ 紧急处理结果:', result);
            
            // 更新显示
            if (result) {
                this.updateCardQuantityDisplay(card.id, result.quantity);
            }
            
            // 显示反馈
            this.showDeckOperationFeedback(card.name, change);
        }
    }

    // 添加反馈方法
    showDeckOperationFeedback(cardName, change) {
        const feedback = document.createElement('div');
        feedback.textContent = `${cardName} ${change > 0 ? '添加' : '移除'}成功`;
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 5px;
            z-index: 1001;
            font-size: 1rem;
        `;
        
        document.body.appendChild(feedback);
        setTimeout(() => {
            feedback.remove();
        }, 1000);
    }

    // 卡牌触摸开始
    handleCardTouchStart(e) {
        const now = Date.now();
        
        if (now - this.cardLastTouchEndTime < 300) {
            return;
        }
        
        this.cardTouchStartTime = now;
        this.cardTouchStartX = e.touches[0].clientX;
        this.cardTouchStartY = e.touches[0].clientY;
        this.cardTouchCount = e.touches.length;
        this.cardDoubleTouchProcessed = false;
        
        if (this.cardTouchCount >= 2) {
            this.cardIsMultiTouch = true;
            return;
        }
        
        this.cardIsMultiTouch = false;
    }

    // 卡牌触摸结束
    handleCardTouchEnd(e) {
        const now = Date.now();
        this.cardLastTouchEndTime = now;
        
        const touchDuration = now - this.cardTouchStartTime;
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const deltaX = Math.abs(touchEndX - this.cardTouchStartX);
        const deltaY = Math.abs(touchEndY - this.cardTouchStartY);
        
        const index = parseInt(e.currentTarget.dataset.index);
        
        // 只处理双指触摸（减少数量）
        if (this.cardIsMultiTouch && this.cardTouchCount >= 2 && !this.cardDoubleTouchProcessed) {
            if (this.onQuantityChange && touchDuration < 500) {
                this.onQuantityChange(index, -1);
                this.cardDoubleTouchProcessed = true;
            }
            this.cardIsMultiTouch = false;
            return;
        }
        
        this.cardIsMultiTouch = false;
    }

    // 卡牌触摸取消
    handleCardTouchCancel() {
        this.cardIsMultiTouch = false;
        this.cardDoubleTouchProcessed = false;
    }

    // CardGrid.js - 优化 updateCardQuantityDisplay 方法
    updateCardQuantityDisplay(cardId, quantity) {
        console.log('🔄 更新卡牌数量显示:', cardId, '数量:', quantity);
        
        const cardElements = document.querySelectorAll('.card');
        
        // 简化的模式检测
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const hasSearchHeader = document.querySelector('.search-header').style.display !== 'none';
        
        cardElements.forEach(cardElement => {
            const elementCardId = cardElement.dataset.cardId;
            
            if (elementCardId === cardId) {
                let quantityElement = cardElement.querySelector('.card-quantity');
                
                // 根据模式决定显示规则
                let shouldDisplay = false;
                
                if (isDeckMode && !hasSearchHeader) {
                    // 卡组模式：数量为1不显示
                    shouldDisplay = quantity > 1;
                } else {
                    // 卡牌浏览模式：数量为1也要显示
                    shouldDisplay = quantity > 0;
                }
                
                if (shouldDisplay) {
                    if (!quantityElement) {
                        quantityElement = document.createElement('div');
                        quantityElement.className = 'card-quantity';
                        cardElement.appendChild(quantityElement);
                    }
                    quantityElement.textContent = quantity;
                    console.log('✅ 设置数量显示:', quantity);
                } else if (quantityElement) {
                    quantityElement.remove();
                    console.log('❌ 移除数量显示');
                }
            }
        });
    }

    // 显示加载状态
    showLoading() {
        this.loadingSection.style.display = 'block';
        this.cardGrid.style.display = 'none';
        this.noResults.style.display = 'none';
    }

    // 隐藏加载状态
    hideLoading() {
        this.loadingSection.style.display = 'none';
        this.cardGrid.style.display = 'grid';
    }

    // 更新搜索信息
    updateSearchInfo(message) {
        const searchInfo = document.getElementById('search-info');
        if (searchInfo) {
            searchInfo.textContent = message;
        }
    }
}