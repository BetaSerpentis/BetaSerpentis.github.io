import { debugLog } from '../utils/constants.js';

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
        this.currentMode = 'browse'; // 由外部 setMode() 更新
        
        // 触摸状态变量
        this.touchState = {
            startTime: 0,
            startX: 0,
            startY: 0,
            isDragging: false,
            longPressTimer: null,
            hasMoved: false,
            dragThreshold: 10, // 移动阈值（像素）
            tapThreshold: 200, // 点击阈值（毫秒）
            longPressThreshold: 1000 // 长按阈值（毫秒）
        };
    }

    init() {
        this.imageLoader.setOnLoadMore(() => {
            this.loadNextBatch();
        });
        
        this.imageLoader.initLazyLoading();
        this.disableImageLongPress();
    }

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
            
            // 确保网格对齐方式正确
            if (cards.length < 12) { // 如果卡牌数量少
                this.cardGrid.style.alignContent = 'start';
            } else {
                this.cardGrid.style.alignContent = 'start'; // 始终从顶部开始
            }
            
            this.loadNextBatch();
            // 第一批量渲染完成后立即隐藏 loading，消除闪烁
            this.hideLoading();
        }
    }

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

    createCardElement(card, index) {
        const cardElement = document.createElement('div');
        cardElement.className = 'card';
        cardElement.dataset.index = index;
        cardElement.dataset.cardId = card.id;

        const img = document.createElement('img');
        img.className = 'card-img';
        img.dataset.src = card.image;
        img.dataset.index = index;
        img.dataset.cardId = card.id;
        img.alt = card.name;
        img.dataset.loading = 'false';
        
        const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%231a1a24"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%233a3a45">加载中...</text></svg>`;
        img.src = svgPlaceholder;
        
        // 简化的数量显示逻辑（使用显式模式状态）
        let displayQuantity = 0;
        let shouldDisplayQuantity = false;
        
        const isDeckMode = this.currentMode !== 'browse';
        const isDeckAddMode = this.currentMode === 'deck-add' || this.currentMode === 'cover-select';
        
        if (isDeckMode) {
            if (this.deckManager) {
                const currentDeck = this.deckManager.getCurrentDeck();
                if (currentDeck) {
                    const deckCard = currentDeck.cards.find(c => c.id === card.id);
                    displayQuantity = deckCard ? deckCard.quantity : 0;
                    
                    if (isDeckAddMode) {
                        shouldDisplayQuantity = displayQuantity > 0;
                    } else {
                        const isDeckEditMode = !!document.querySelector('.deck-edit-button');
                        shouldDisplayQuantity = isDeckEditMode ? (displayQuantity > 0) : (displayQuantity > 1);
                    }
                }
            }
        } else {
            displayQuantity = card.quantity || 0;
            shouldDisplayQuantity = displayQuantity > 0;
        }
        
        if (shouldDisplayQuantity) {
            const quantity = document.createElement('div');
            quantity.className = 'card-quantity';
            quantity.textContent = displayQuantity;
            cardElement.appendChild(quantity);
        }
        
        cardElement.appendChild(img);
        
        // 绑定事件 - 使用改进的触摸处理
        const elementWithEvents = this.bindCardEvents(cardElement, index);
        
        this.imageLoader.observeImage(img);
        
        return elementWithEvents;
    }

    // ==== 改进的触摸事件处理 ====
    bindCardEvents(cardElement, index) {
        // 重置触摸状态
        const touchState = {
            startTime: 0,
            startX: 0,
            startY: 0,
            isDragging: false,
            longPressTimer: null,
            hasMoved: false,
            dragThreshold: 10,
            tapThreshold: 200,
            longPressThreshold: 1000,
            longPressInterval: null,
            touchIdentifier: null // 添加触摸标识符
        };

        // 检测是否为移动设备
        const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        
        // 清理函数
        const cleanupLongPress = () => {
            debugLog('🧹 CardGrid: 清理长按计时器');
            if (touchState.longPressTimer) {
                clearTimeout(touchState.longPressTimer);
                touchState.longPressTimer = null;
            }
            if (touchState.longPressInterval) {
                clearInterval(touchState.longPressInterval);
                touchState.longPressInterval = null;
            }
        };
        
        // 移动端触摸事件
        if (isMobile) {
            debugLog('📱 CardGrid: 移动端事件绑定');
            
            // 触摸开始
            cardElement.addEventListener('touchstart', (e) => {
                debugLog('👆 CardGrid: 触摸开始');
                
                // 只处理单指触摸
                if (e.touches.length > 1) return;
                
                const touch = e.touches[0];
                touchState.startTime = Date.now();
                touchState.startX = touch.clientX;
                touchState.startY = touch.clientY;
                touchState.isDragging = false;
                touchState.hasMoved = false;
                touchState.touchIdentifier = touch.identifier;
                
                // 清理之前的长按状态
                cleanupLongPress();
                
                // 设置长按计时器
                touchState.longPressTimer = setTimeout(() => {
                    // 长按事件 - 但如果已经开始拖拽就不触发
                    if (!touchState.isDragging && !touchState.hasMoved) {
                        debugLog('⏳ CardGrid: 长按触发，开始持续减少');
                        
                        // 第一次立即触发减少
                        this.handleCardAction(index, 'decrement');
                        
                        // 设置持续减少间隔
                        touchState.longPressInterval = setInterval(() => {
                            debugLog('⏳ CardGrid: 长按持续减少');
                            this.handleCardAction(index, 'decrement');
                        }, 1000);
                    } else {
                        debugLog('🚫 CardGrid: 长按但已拖拽或移动，不触发');
                    }
                }, touchState.longPressThreshold);
                
            }, { passive: true });
            
            // 触摸移动
            cardElement.addEventListener('touchmove', (e) => {
                // 检查是否是同一个触摸点
                const touch = Array.from(e.touches).find(t => t.identifier === touchState.touchIdentifier);
                if (!touch) return;
                
                const deltaX = Math.abs(touch.clientX - touchState.startX);
                const deltaY = Math.abs(touch.clientY - touchState.startY);
                
                // 检查是否达到拖拽阈值
                if (!touchState.hasMoved && (deltaX > touchState.dragThreshold || deltaY > touchState.dragThreshold)) {
                    debugLog('🔄 CardGrid: 开始拖拽', { deltaX, deltaY });
                    touchState.hasMoved = true;
                    
                    // 清除长按计时器，因为用户开始拖拽了
                    cleanupLongPress();
                    
                    // 标记为拖拽状态
                    touchState.isDragging = true;
                    
                    // 为卡牌网格添加拖拽样式
                    this.cardGrid.classList.add('dragging');
                }
                
                // 如果是拖拽状态，允许页面滚动
                if (touchState.isDragging) {
                    // 这里不需要做任何事，浏览器会自动处理滚动
                    return;
                }
                
            }, { passive: true });
            
            // 触摸结束
            cardElement.addEventListener('touchend', (e) => {
                debugLog('🖐️ CardGrid: 触摸结束');
                
                // 检查是否是同一个触摸点
                const changedTouch = Array.from(e.changedTouches).find(t => t.identifier === touchState.touchIdentifier);
                if (!changedTouch) return;
                
                const touchDuration = Date.now() - touchState.startTime;
                debugLog('📊 CardGrid: 触摸统计', {
                    touchDuration,
                    isDragging: touchState.isDragging, 
                    hasMoved: touchState.hasMoved,
                    hasLongPressTimer: !!touchState.longPressTimer
                });
                
                // 处理长按（如果长按计时器仍在运行，说明长按已触发）
                if (touchState.longPressInterval) {
                    debugLog('✅ CardGrid: 长按操作完成');
                    // 不需要阻止默认行为，因为长按时我们已经触发了动作
                } 
                // 如果不是拖拽且触摸时间短于点击阈值，触发点击
                else if (!touchState.isDragging && !touchState.hasMoved && touchDuration < touchState.tapThreshold) {
                    debugLog('✅ CardGrid: 移动端点击触发');
                    // 注意：这里不要用 preventDefault()，因为可能影响其他事件
                    this.handleCardAction(index, 'increment');
                }
                // 如果是拖拽或者移动了，不触发点击
                else if (touchState.isDragging || touchState.hasMoved) {
                    debugLog('🚫 CardGrid: 拖拽或移动，不触发点击');
                }
                // 其他情况（长按时长但还未触发长按）
                else if (touchDuration >= touchState.longPressThreshold && !touchState.longPressInterval) {
                    debugLog('⚠️ CardGrid: 长按时长但未触发，可能被取消了');
                }
                
                // 清理长按状态
                cleanupLongPress();
                
                // 重置触摸状态
                touchState.isDragging = false;
                touchState.hasMoved = false;
                touchState.touchIdentifier = null;
                
                // 移除拖拽样式
                this.cardGrid.classList.remove('dragging');
                
            }, { passive: true }); // 改回 passive: true
            
            // 触摸取消
            cardElement.addEventListener('touchcancel', (e) => {
                debugLog('❌ CardGrid: 触摸取消');
                
                // 检查是否是同一个触摸点
                const changedTouch = Array.from(e.changedTouches).find(t => t.identifier === touchState.touchIdentifier);
                if (!changedTouch) return;
                
                cleanupLongPress();
                
                // 重置触摸状态
                touchState.isDragging = false;
                touchState.hasMoved = false;
                touchState.touchIdentifier = null;
                
                // 移除拖拽样式
                this.cardGrid.classList.remove('dragging');
            }, { passive: true });
            
            // 阻止浏览器长按菜单
            cardElement.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }, false);
            
        } else {
            // 桌面端鼠标事件
            cardElement.addEventListener('click', (e) => {
                debugLog('🖱️ CardGrid: 桌面端左键点击');
                this.handleCardAction(index, 'increment');
            });
            
            cardElement.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                debugLog('🖱️ CardGrid: 桌面端右键点击');
                this.handleCardAction(index, 'decrement');
                return false;
            });
        }
        
        return cardElement;
    }

    handleCardAction(index, action) {
        // 防抖：防止短时间内重复触发
        const now = Date.now();
        const lastActionTime = this.lastActionTime || 0;
        const lastActionIndex = this.lastActionIndex || -1;
        
        // 如果和上次操作是同一张卡牌且时间间隔小于500ms，忽略
        if (index === lastActionIndex && now - lastActionTime < 500) {
            debugLog('⏱️ 防抖：忽略快速重复点击');
            return;
        }
        
        this.lastActionTime = now;
        this.lastActionIndex = index;
        
        const change = action === 'increment' ? 1 : -1;
        const buttonType = action === 'increment' ? 'left' : 'right';
        
        debugLog('🃏 CardGrid: 触发卡牌动作', { index, action, change, buttonType });
        
        if (this.onCardClick) {
            debugLog('✅ CardGrid: 使用 onCardClick 回调');
            this.onCardClick(index, buttonType);
            return;
        }
        
        if (this.onQuantityChange) {
            debugLog('✅ CardGrid: 使用 onQuantityChange 回调');
            this.onQuantityChange(index, change);
            return;
        }
        
        console.error('❌ CardGrid: 没有可用的回调函数来处理卡牌动作');
    }

    disableImageLongPress() {
        const style = document.createElement('style');
        style.textContent = `
            /* 只对卡牌相关元素禁用触摸菜单 */
            .card, .card * {
                -webkit-touch-callout: none !important;
                -webkit-user-select: none !important;
                user-select: none !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            
            /* 允许输入框 */
            input, textarea, .search-input, [contenteditable="true"] {
                -webkit-touch-callout: default !important;
                -webkit-user-select: auto !important;
                user-select: auto !important;
                -webkit-tap-highlight-color: auto !important;
            }
            
            /* 卡牌图片特殊处理 */
            .card img {
                pointer-events: none !important;
                -webkit-user-drag: none !important;
                user-drag: none !important;
            }
            
            /* 允许滚动 */
            .content-wrapper, .card-grid {
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }
            
            /* 确保触摸事件可以正常工作 */
            .card {
                touch-action: manipulation;
            }
        `;
        document.head.appendChild(style);
        
        // 只阻止卡牌区域的长按菜单
        document.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.card')) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }, { capture: true });
        
        // 防止双击缩放 - 只在卡牌区域
        let lastTouchEnd = 0;
        let lastTouchTarget = null;
        
        document.addEventListener('touchend', (e) => {
            if (e.target.closest('.card')) {
                const now = Date.now();
                if (now - lastTouchEnd <= 300 && lastTouchTarget === e.target) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                lastTouchEnd = now;
                lastTouchTarget = e.target;
            }
        }, { passive: false });
        
        debugLog('✅ 触摸防护已启用（只针对卡牌）');
    }

    isStatsModeActive() {
        // 统一使用 StatsManager 作为唯一真实来源
        if (window.statsManager && window.statsManager.isStatModeActive) {
            return window.statsManager.isStatModeActive();
        }
        return false;
    }

    updateCardQuantityDisplay(cardId, quantity) {
        const cardElements = document.querySelectorAll('.card');
        
        const isDeckMode = this.currentMode !== 'browse';
        const isDeckAddMode = this.currentMode === 'deck-add' || this.currentMode === 'cover-select';
        
        cardElements.forEach(cardElement => {
            const elementCardId = cardElement.dataset.cardId;
            
            if (elementCardId === cardId) {
                let quantityElement = cardElement.querySelector('.card-quantity');
                
                let shouldDisplay = false;
                
                if (isDeckAddMode) {
                    shouldDisplay = quantity > 0;
                } else if (isDeckMode && this.currentMode !== 'deck-add' && this.currentMode !== 'cover-select') {
                    // deck-view 或 deck-edit 模式：已有数量>1才显示角标
                    shouldDisplay = quantity > 1;
                } else {
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
    
    setMode(mode) {
        this.currentMode = mode;
    }

    showLoading() {
        if (this.loadingSection) this.loadingSection.style.display = 'block';
        this.cardGrid.style.display = 'none';
        if (this.noResults) this.noResults.style.display = 'none';
    }

    hideLoading() {
        if (this.loadingSection) this.loadingSection.style.display = 'none';
        this.cardGrid.style.display = 'grid';
    }

    updateSearchInfo(message) {
        const searchInfo = document.getElementById('search-info');
        if (searchInfo) {
            searchInfo.textContent = message;
        }
    }
}