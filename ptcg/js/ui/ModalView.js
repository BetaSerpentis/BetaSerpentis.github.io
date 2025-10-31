export class ModalView {
    constructor(cardManager, imageLoader) {
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        
        this.modal = document.getElementById('image-modal');
        this.modalImgCurrent = document.getElementById('modal-img-current');
        this.modalImgNext = document.getElementById('modal-img-next');
        this.modalImgPrev = document.getElementById('modal-img-prev');
        this.cardName = document.getElementById('card-name');
        this.modalClose = document.getElementById('modal-close');
        this.prevArrow = document.getElementById('prev-arrow');
        this.nextArrow = document.getElementById('next-arrow');
        this.modalImgContainer = document.getElementById('modal-img-container');
        
        this.currentIndex = 0;
        
        // 触摸相关变量
        this.modalTouchStartX = 0;
        this.modalIsDragging = false;
        this.modalCurrentTranslateX = 0;
        this.modalDragThreshold = 80;
        this.modalIsAnimating = false;
        
        this.init();

        // 调试函数
        this.debugLog = (message) => {
            const debugEl = document.getElementById('debug-info');
            if (debugEl) {
                debugEl.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
            }
            console.log('ModalView Debug:', message);
        };
    }

    // 初始化模态框
    init() {
        this.bindEvents();
    }

    // 绑定事件
    bindEvents() {
        this.modalClose.addEventListener('click', () => this.close());
        this.modal.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.close();
        });
        
        // 在 bindEvents 方法中修改箭头事件
        this.prevArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.debugLog('左箭头点击');
            this.triggerSwipe(-1);
        });

        this.nextArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.debugLog('右箭头点击');
            this.triggerSwipe(1);
        });

        document.addEventListener('keydown', (e) => {
            if (!this.modal.classList.contains('active')) return;
            
            if (e.key === 'Escape') this.close();
            else if (e.key === 'ArrowLeft') this.triggerSwipe(-1);
            else if (e.key === 'ArrowRight') this.triggerSwipe(1);
        });
        
        this.initModalTouchEvents();
    }

    // 新增：触发快速滑动切换
    triggerSwipe(direction) {
        this.debugLog(`triggerSwipe - 开始 | 方向: ${direction} | 当前动画状态: ${this.modalIsAnimating}`);
        
        if (this.modalIsAnimating) {
            this.debugLog('triggerSwipe - 动画进行中，拒绝新请求');
            return;
        }
        
        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) {
            this.debugLog('triggerSwipe - 无卡牌数据');
            return;
        }
        
        this.debugLog('triggerSwipe - 设置动画状态为true');
        this.modalIsAnimating = true;
        
        let newIndex = this.currentIndex + direction;
        if (newIndex < 0) newIndex = cards.length - 1;
        else if (newIndex >= cards.length) newIndex = 0;
        
        this.debugLog(`triggerSwipe - 索引计算 | 当前: ${this.currentIndex} -> 新: ${newIndex}`);
        
        // 执行滑动动画
        if (direction === 1) {
            this.modalImgCurrent.style.transform = 'translateX(-100%)';
            this.modalImgNext.style.transform = 'translateX(0)';
            this.debugLog('triggerSwipe - 向右切换动画开始');
        } else {
            this.modalImgCurrent.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(0)';
            this.debugLog('triggerSwipe - 向左切换动画开始');
        }
        
        setTimeout(() => {
            this.debugLog('triggerSwipe - 动画完成，更新状态');
            this.currentIndex = newIndex;
            const card = cards[this.currentIndex];
            
            // 重置所有图片位置
            this.modalImgCurrent.style.transition = 'none';
            this.modalImgNext.style.transition = 'none';
            this.modalImgPrev.style.transition = 'none';
            
            this.modalImgCurrent.src = card.image;
            this.modalImgCurrent.style.transform = 'translateX(0)';
            this.modalImgNext.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(-100%)';
            
            setTimeout(() => {
                this.modalImgCurrent.style.transition = 'transform 0.3s ease';
                this.modalImgNext.style.transition = 'transform 0.3s ease';
                this.modalImgPrev.style.transition = 'transform 0.3s ease';
            }, 50);
            
            this.cardName.textContent = card.name;
            this.debugLog(`triggerSwipe - 设置动画状态为false | 新卡牌: ${card.name}`);
            this.modalIsAnimating = false;
            
            this.preloadAdjacentImages();
        }, 300);
    }

    // 简化触摸事件处理
    initModalTouchEvents() {
        const cards = this.cardManager.getDisplayCards();
        
        this.modalImgContainer.addEventListener('touchstart', (e) => {
            this.debugLog(`touchstart - 触摸开始 | 动画状态: ${this.modalIsAnimating} | 拖动状态: ${this.modalIsDragging}`);
            
            if (!e.target.closest('.modal-img-container') || this.modalIsAnimating) {
                this.debugLog('touchstart - 条件不满足，退出');
                return;
            }
            
            this.modalTouchStartX = e.touches[0].clientX;
            this.modalIsDragging = true;
            this.modalImgCurrent.style.transition = 'none';
            this.debugLog(`touchstart - 开始拖动 | 起始X: ${this.modalTouchStartX}`);
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchmove', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) {
                this.debugLog(`touchmove - 不允许拖动 | 拖动: ${this.modalIsDragging} | 动画: ${this.modalIsAnimating}`);
                return;
            }
            
            const touchX = e.touches[0].clientX;
            const deltaX = touchX - this.modalTouchStartX;
            this.modalCurrentTranslateX = deltaX;
            
            const maxTranslate = window.innerWidth * 0.5;
            const boundedTranslate = Math.max(-maxTranslate, Math.min(maxTranslate, deltaX));
            
            this.modalImgCurrent.style.transform = `translateX(${boundedTranslate}px)`;
            this.debugLog(`touchmove - 拖动中 | deltaX: ${deltaX} | 限制后: ${boundedTranslate}`);
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchend', (e) => {
            this.debugLog(`touchend - 触摸结束 | 拖动状态: ${this.modalIsDragging} | 总位移: ${this.modalCurrentTranslateX}`);
            
            if (!this.modalIsDragging || this.modalIsAnimating) {
                this.debugLog('touchend - 条件不满足，退出');
                return;
            }
            
            this.modalIsDragging = false;
            this.modalImgCurrent.style.transition = 'transform 0.3s ease';
            
            const shouldChange = Math.abs(this.modalCurrentTranslateX) > this.modalDragThreshold;
            this.debugLog(`touchend - 判断切换 | 位移: ${this.modalCurrentTranslateX} | 阈值: ${this.modalDragThreshold} | 是否切换: ${shouldChange}`);
            
            if (shouldChange) {
                const direction = this.modalCurrentTranslateX > 0 ? -1 : 1;
                this.debugLog(`touchend - 触发切换 | 方向: ${direction}`);
                this.triggerSwipe(direction);
            } else {
                this.debugLog('touchend - 位移不足，回到原位');
                this.modalImgCurrent.style.transform = 'translateX(0)';
            }
            
            this.modalCurrentTranslateX = 0;
        }, { passive: true });
    }

    // 显示模态框
    show(index) {
        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) return;
        
        this.modalImgCurrent.style.transform = 'translateX(0)';
        this.modalImgNext.style.transform = 'translateX(100%)';
        this.modalImgPrev.style.transform = 'translateX(-100%)';
        this.modalIsDragging = false;
        this.modalCurrentTranslateX = 0;
        this.modalIsAnimating = false;
        
        const card = cards[index];
        this.modalImgCurrent.src = card.image;
        this.cardName.textContent = card.name;
        
        this.modal.classList.add('active');
        this.currentIndex = index;
        
        this.preloadAdjacentImages();
        document.body.style.overflow = 'hidden';
    }

    // 关闭模态框
    close() {
        this.modal.classList.remove('active');
        document.body.style.overflow = 'auto';
    }

    // 导航卡牌
    navigateCard(direction) {
        if (this.modalIsAnimating) return;
        
        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) return;
        
        let newIndex = this.currentIndex + direction;
        if (newIndex < 0) newIndex = cards.length - 1;
        else if (newIndex >= cards.length) newIndex = 0;
        
        this.currentIndex = newIndex;
        const card = cards[this.currentIndex];
        
        this.modalImgCurrent.src = card.image;
        this.cardName.textContent = card.name;
        
        this.preloadAdjacentImages();
    }

    // 预加载相邻图片
    preloadAdjacentImages() {
        const cards = this.cardManager.getDisplayCards();
        const cardElements = document.querySelectorAll('.card');
        this.imageLoader.preloadAdjacentImages(this.currentIndex, cards, cardElements);
    }
}