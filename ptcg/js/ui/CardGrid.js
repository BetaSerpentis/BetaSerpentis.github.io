export class CardGrid {
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
        
        // ==== 关键修复：移除所有方法绑定，等后续再绑定 ====
        // 不要在这里绑定任何方法
    }

    // CardGrid.js - 修复 init 方法
    init() {
        // console.log('🔄 CardGrid 初始化懒加载');
        this.imageLoader.setOnLoadMore(() => {
            this.loadNextBatch();
        });
        
        // 确保懒加载观察器已启动
        this.imageLoader.initLazyLoading();
        
        // 新增：禁用图片长按保存
        this.disableImageLongPress();
    }

    // 渲染卡牌网格
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
        }
    }

    // 加载下一批卡牌
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
    }

    // 创建卡牌元素
    createCardElement(card, index) {
        // console.log(`🖼️ 创建卡牌元素: ${card.name}, 图片路径: ${card.image}, ID: ${card.id}`);
        
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
        
        // 添加图片加载事件监听用于调试
        img.onload = () => {
            // console.log(`✅ 卡牌图片加载成功: ${card.name}, 路径: ${card.image}`);
        };
        
        img.onerror = () => {
            // console.log(`❌ 卡牌图片加载失败: ${card.name}, 路径: ${card.image}, ID: ${card.id}`);
        };
        
        const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23f0f0f0"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23666">加载中...</text></svg>`;
        img.src = svgPlaceholder;
        
        // 简化的数量显示逻辑
        let displayQuantity = 0;
        let shouldDisplayQuantity = false;
        
        // 检查是否在卡组模式
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const hasSearchHeader = document.querySelector('.search-header').style.display !== 'none';
        
        // 检查是否是卡组添加模式
        const isDeckAddMode = !!document.querySelector('.deck-complete-button') || 
                            (isDeckMode && hasSearchHeader);
        
        if (isDeckMode) {
            // 卡组模式：显示卡组中的数量
            if (this.deckManager) {
                const currentDeck = this.deckManager.getCurrentDeck();
                if (currentDeck) {
                    const deckCard = currentDeck.cards.find(c => c.id === card.id);
                    displayQuantity = deckCard ? deckCard.quantity : 0;
                    
                    // 根据具体模式决定显示规则
                    if (isDeckAddMode) {
                        // 添加模式：数量>0就显示（包括1）
                        shouldDisplayQuantity = displayQuantity > 0;
                    } else {
                        // 编辑模式：总是显示数量
                        const isDeckEditMode = !!document.querySelector('.deck-edit-button');
                        shouldDisplayQuantity = isDeckEditMode ? (displayQuantity > 0) : (displayQuantity > 1);
                    }
                }
            }
        } else {
            // 普通模式：显示拥有数量（统计模式）
            displayQuantity = card.quantity || 0;
            shouldDisplayQuantity = displayQuantity > 0;
        }
        
        // 显示数量
        if (shouldDisplayQuantity) {
            const quantity = document.createElement('div');
            quantity.className = 'card-quantity';
            quantity.textContent = displayQuantity;
            cardElement.appendChild(quantity);
        }
        
        cardElement.appendChild(img);
        
        // 绑定事件 - 使用统一的触摸处理
        const elementWithEvents = this.bindCardEvents(cardElement, index);
        
        this.imageLoader.observeImage(img);
        
        return elementWithEvents;
    }

    // ==== 统一触摸事件处理 ====
    bindCardEvents(cardElement, index) {
        let touchStartTime = 0;
        let longPressTimer = null;
        let touchMoved = false;
        
        // 触摸开始
        cardElement.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // 只处理单指触摸
            if (e.touches.length > 1) return;
            
            touchStartTime = Date.now();
            touchMoved = false;
            
            // 清除之前的定时器
            if (longPressTimer) {
                clearTimeout(longPressTimer);
            }
            
            // 设置长按定时器（1秒）
            longPressTimer = setTimeout(() => {
                // 长按：-1
                this.handleCardAction(index, 'decrement');
                
                // 持续减少（每1秒-1）
                const intervalId = setInterval(() => {
                    this.handleCardAction(index, 'decrement');
                }, 1000);
                
                // 存储intervalId，触摸结束时清除
                const clearIntervalOnEnd = () => {
                    clearInterval(intervalId);
                    cardElement.removeEventListener('touchend', clearIntervalOnEnd);
                    cardElement.removeEventListener('touchcancel', clearIntervalOnEnd);
                };
                
                cardElement.addEventListener('touchend', clearIntervalOnEnd, { once: true });
                cardElement.addEventListener('touchcancel', clearIntervalOnEnd, { once: true });
            }, 1000);
            
        }, { passive: false });
        
        // 触摸移动
        cardElement.addEventListener('touchmove', (e) => {
            // 如果移动距离较大，取消长按
            touchMoved = true;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });
        
        // 触摸结束
        cardElement.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // 清除长按定时器
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            
            // 如果发生了移动，不处理点击
            if (touchMoved) return;
            
            const touchDuration = Date.now() - touchStartTime;
            
            console.log('🖐️ CardGrid: 触摸结束', { touchDuration, touchMoved });
            
            // 短按（<1秒）：+1
            if (touchDuration < 1000) {
                console.log('➕ CardGrid: 触发增加动作');
                this.handleCardAction(index, 'increment');
            }
            
        }, { passive: false });

        // 触摸取消
        cardElement.addEventListener('touchcancel', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });
        
        // 桌面端右键（备用）
        cardElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleCardAction(index, 'decrement');
        }, false);
        
        // 桌面端左键（备用）
        cardElement.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleCardAction(index, 'increment');
        }, false);
        
        return cardElement;
    }

    // 在 handleCardAction 方法中修复
    handleCardAction(index, action) {
        const change = action === 'increment' ? 1 : -1;
        const buttonType = action === 'increment' ? 'left' : 'right';
        
        console.log('🃏 CardGrid: 触发卡牌动作', { index, action, change, buttonType });
        
        // 优先使用 onCardClick 回调
        if (this.onCardClick) {
            console.log('✅ CardGrid: 使用 onCardClick 回调');
            this.onCardClick(index, buttonType);
            return;
        }
        
        // 如果没有 onCardClick，尝试使用 onQuantityChange
        if (this.onQuantityChange) {
            console.log('✅ CardGrid: 使用 onQuantityChange 回调');
            this.onQuantityChange(index, change);
            return;
        }
        
        console.error('❌ CardGrid: 没有可用的回调函数来处理卡牌动作');
    }

    // ==== 新增：禁用图片长按保存 ====
    disableImageLongPress() {
        // CSS禁用长按菜单
        const style = document.createElement('style');
        style.textContent = `
            .card img {
                -webkit-touch-callout: none !important;
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
                user-select: none !important;
                pointer-events: none !important;
            }
            
            .card {
                -webkit-tap-highlight-color: transparent !important;
                touch-action: manipulation !important;
            }
            
            img {
                -webkit-touch-callout: none !important;
            }
            
            /* 防止iOS上的长按菜单 */
            * {
                -webkit-touch-callout: none;
                -webkit-user-select: none;
            }
        `;
        document.head.appendChild(style);
        
        // JavaScript阻止默认行为
        document.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.card') || e.target.closest('.card img')) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }, { capture: true });
        
        // iOS特殊处理 - 阻止长按事件
        document.addEventListener('touchstart', (e) => {
            if (e.target.closest('.card') || e.target.closest('.card img')) {
                // 允许阻止默认行为
                if (e.cancelable) {
                    e.preventDefault();
                }
            }
        }, { passive: false, capture: true });
        
        // 额外：防止触摸保持菜单
        document.addEventListener('touchend', (e) => {
            if (e.target.closest('.card')) {
                e.preventDefault();
            }
        }, { passive: false, capture: true });
    }

    // ==== 统计模式检测 ====
    isStatsModeActive() {
        // 方法1：检查统计按钮状态
        const statsButton = document.querySelector('.stats-button');
        if (statsButton && statsButton.classList.contains('active')) {
            return true;
        }
        
        // 方法2：检查全局变量
        if (window.statsManager && window.statsManager.isStatModeActive) {
            return window.statsManager.isStatModeActive();
        }
        
        return false;
    }

    // ==== 更新卡牌数量显示 ====
    updateCardQuantityDisplay(cardId, quantity) {
        const cardElements = document.querySelectorAll('.card');
        
        // 简化的模式检测
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const hasSearchHeader = document.querySelector('.search-header').style.display !== 'none';
        
        // 特别检查是否是卡组添加模式
        const isDeckAddMode = !!document.querySelector('.deck-complete-button') || 
                            (isDeckMode && hasSearchHeader);
        
        cardElements.forEach(cardElement => {
            const elementCardId = cardElement.dataset.cardId;
            
            if (elementCardId === cardId) {
                let quantityElement = cardElement.querySelector('.card-quantity');
                
                // 根据模式决定显示规则
                let shouldDisplay = false;
                
                if (isDeckAddMode) {
                    // 卡组添加模式：数量>0就显示（包括1）
                    shouldDisplay = quantity > 0;
                } else if (isDeckMode && !hasSearchHeader) {
                    // 卡组编辑/浏览模式：数量为1不显示
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
                } else if (quantityElement) {
                    quantityElement.remove();
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

    // ==== 移除不再需要的方法 ====
    // 删除以下重复或不再需要的方法：
    // - handleShortPress
    // - handleLongPress
    // - handleRightClick
    // - handleLeftClick
    // - triggerCardAction（重复）
    // - bindStatsModeEvents
    // - showStatsOperationFeedback
    // - emergencyDeckEditHandler
    // - showDeckOperationFeedback
    // - handleCardTouchStart
    // - handleCardTouchEnd
    // - handleCardTouchCancel
}