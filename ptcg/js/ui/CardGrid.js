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
        
        // 触摸相关变量
        this.cardTouchStartTime = 0;
        this.cardTouchStartX = 0;
        this.cardTouchStartY = 0;
        this.cardTouchCount = 0;
        this.cardIsMultiTouch = false;
        this.cardLastTouchEndTime = 0;
        this.cardDoubleTouchProcessed = false;
    }

    // 初始化卡牌网格
    init() {
        this.imageLoader.setOnLoadMore(() => {
            this.loadNextBatch();
        });
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
            const card = cards[i];
            const cardElement = this.createCardElement(card, i);
            fragment.appendChild(cardElement);
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
        const cardElement = document.createElement('div');
        cardElement.className = 'card';
        cardElement.dataset.index = index;

        const img = document.createElement('img');
        img.className = 'card-img';
        img.dataset.src = card.image;
        img.dataset.index = index;
        img.alt = card.name;
        img.dataset.loading = 'false';
        
        const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23f0f0f0"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23666">加载中...</text></svg>`;
        img.src = svgPlaceholder;
        
        // 只在宝可梦卡牌显示编号
        const currentTab = this.cardManager.getCurrentTab();
        if (currentTab === '宝可梦' && card.number && card.number !== '未知') {
            const badge = document.createElement('div');
            badge.className = 'card-badge';
            badge.textContent = card.number;
            cardElement.appendChild(badge);
        }
        
        if (card.quantity > 0) {
            const quantity = document.createElement('div');
            quantity.className = 'card-quantity';
            quantity.textContent = card.quantity;
            cardElement.appendChild(quantity);
        }
        
        cardElement.appendChild(img);
        
        // 绑定事件
        this.bindCardEvents(cardElement, index);
        
        // 观察图片加载
        this.imageLoader.observeImage(img);
        
        return cardElement;
    }

    // 绑定卡牌事件
    bindCardEvents(cardElement, index) {
        // 触摸事件处理
        cardElement.addEventListener('touchstart', this.handleCardTouchStart.bind(this), { passive: true });
        cardElement.addEventListener('touchend', this.handleCardTouchEnd.bind(this), { passive: true });
        cardElement.addEventListener('touchcancel', this.handleCardTouchCancel.bind(this), { passive: true });
        
        // PC端事件
        let clickProcessed = false;
        cardElement.addEventListener('click', (e) => {
            if (clickProcessed) return;
            clickProcessed = true;
            
            if (this.onCardClick) {
                this.onCardClick(index, e.button === 0 ? 'left' : 'right');
            }
            
            setTimeout(() => {
                clickProcessed = false;
            }, 300);
        });
        
        cardElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.onCardClick) {
                this.onCardClick(index, 'right');
            }
        });
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

    // 更新卡牌数量显示
    updateCardQuantityDisplay(cardId, quantity) {
        const cardElements = document.querySelectorAll('.card');
        cardElements.forEach(cardElement => {
            const index = parseInt(cardElement.dataset.index);
            const cards = this.cardManager.getDisplayCards();
            const card = cards[index];
            
            if (card && card.id === cardId) {
                let quantityElement = cardElement.querySelector('.card-quantity');
                
                if (quantity > 0) {
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
}