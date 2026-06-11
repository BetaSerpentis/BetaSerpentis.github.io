import { debugLog } from '../utils/constants.js';

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
        
        this.modalTransitionMs = 300;
        this.modalTransition = `transform ${this.modalTransitionMs}ms ease`;
        this.pendingSwipeDirection = 0;
        this.pendingSwipeIndex = -1;

        // 新增：相邻图片跟随移动相关
        this.modalImgNext.style.transform = 'translateX(100%)';
        this.modalImgPrev.style.transform = 'translateX(-100%)';
        
        this.init();
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
        
        // 箭头事件
        this.prevArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.triggerSwipe(-1);
        });

        this.nextArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.triggerSwipe(1);
        });

        this.modalImgContainer.addEventListener('transitionend', (e) => {
            if (!this.modalIsAnimating || e.propertyName !== 'transform') return;
            const incomingImg = this.pendingSwipeDirection === 1 ? this.modalImgNext : this.modalImgPrev;
            if (e.target === incomingImg) {
                this.completeSwipe();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (!this.modal.classList.contains('active')) return;
            
            if (e.key === 'Escape') this.close();
            else if (e.key === 'ArrowLeft') this.triggerSwipe(-1);
            else if (e.key === 'ArrowRight') this.triggerSwipe(1);
        });
        
        this.initModalTouchEvents();
    }

    // 触发快速滑动切换
    triggerSwipe(direction) {
        if (this.modalIsAnimating) {
            return;
        }

        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) {
            return;
        }

        let newIndex = this.currentIndex + direction;
        if (newIndex < 0) newIndex = cards.length - 1;
        else if (newIndex >= cards.length) newIndex = 0;

        const newCard = cards[newIndex];
        const incomingImg = direction === 1 ? this.modalImgNext : this.modalImgPrev;
        const outgoingTransform = direction === 1 ? 'translateX(-100%)' : 'translateX(100%)';
        const incomingStartTransform = direction === 1 ? 'translateX(100%)' : 'translateX(-100%)';

        this.modalIsAnimating = true;
        this.pendingSwipeDirection = direction;
        this.pendingSwipeIndex = newIndex;

        this.setModalImageTransitions('none');
        incomingImg.src = newCard.image;
        incomingImg.style.transform = incomingStartTransform;
        this.modalImgCurrent.style.transform = 'translateX(0)';
        this.forceModalImageReflow();

        this.setModalImageTransitions(this.modalTransition);
        requestAnimationFrame(() => {
            this.modalImgCurrent.style.transform = outgoingTransform;
            incomingImg.style.transform = 'translateX(0)';
        });
    }

    completeSwipe() {
        if (!this.modalIsAnimating || this.pendingSwipeIndex < 0) return;

        const cards = this.cardManager.getDisplayCards();
        const newCard = cards[this.pendingSwipeIndex];
        if (!newCard) {
            this.modalIsAnimating = false;
            return;
        }

        this.setModalImageTransitions('none');
        this.modalImgCurrent.src = newCard.image;
        this.modalImgCurrent.style.transform = 'translateX(0)';
        this.modalImgPrev.style.transform = 'translateX(-100%)';
        this.modalImgNext.style.transform = 'translateX(100%)';
        this.forceModalImageReflow();
        this.setModalImageTransitions(this.modalTransition);

        this.currentIndex = this.pendingSwipeIndex;
        this.cardName.textContent = newCard.name;
        this.modalIsAnimating = false;
        this.pendingSwipeDirection = 0;
        this.pendingSwipeIndex = -1;
        this.preloadAdjacentImages();
    }

    setModalImageTransitions(value) {
        this.modalImgCurrent.style.transition = value;
        this.modalImgNext.style.transition = value;
        this.modalImgPrev.style.transition = value;
    }

    forceModalImageReflow() {
        this.modalImgCurrent.offsetHeight;
        this.modalImgNext.offsetHeight;
        this.modalImgPrev.offsetHeight;
    }

    // 优化触摸事件处理 - 修复相邻卡牌同步移动问题
    initModalTouchEvents() {
        const cards = this.cardManager.getDisplayCards();
        
        this.modalImgContainer.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.modal-img-container') || this.modalIsAnimating) {
                return;
            }
            
            this.modalTouchStartX = e.touches[0].clientX;
            this.modalIsDragging = true;
            
            // 移除过渡效果以便流畅拖动
            this.modalImgCurrent.style.transition = 'none';
            this.modalImgNext.style.transition = 'none';
            this.modalImgPrev.style.transition = 'none';
            
            // 确保相邻图片已预加载
            this.preloadAdjacentImages();
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchmove', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) {
                return;
            }
            
            const touchX = e.touches[0].clientX;
            const deltaX = touchX - this.modalTouchStartX;
            this.modalCurrentTranslateX = deltaX;
            
            const maxTranslate = window.innerWidth;
            const boundedTranslate = Math.max(-maxTranslate, Math.min(maxTranslate, deltaX));
            
            // 当前图片跟随手指移动
            this.modalImgCurrent.style.transform = `translateX(${boundedTranslate}px)`;
            
            // 修复：相邻图片以相同距离同步移动，保持相对位置
            if (boundedTranslate > 0) {
                // 向右拖动，前一张图片从左侧同步进入
                this.modalImgPrev.style.transform = `translateX(${boundedTranslate - window.innerWidth}px)`;
                this.modalImgNext.style.transform = 'translateX(100%)';
            } else if (boundedTranslate < 0) {
                // 向左拖动，后一张图片从右侧同步进入
                this.modalImgNext.style.transform = `translateX(${boundedTranslate + window.innerWidth}px)`;
                this.modalImgPrev.style.transform = 'translateX(-100%)';
            } else {
                // 无拖动时重置位置
                this.modalImgNext.style.transform = 'translateX(100%)';
                this.modalImgPrev.style.transform = 'translateX(-100%)';
            }
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchend', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) {
                return;
            }
            
            this.modalIsDragging = false;
            
            // 恢复过渡效果
            this.setModalImageTransitions(this.modalTransition);
            
            const shouldChange = Math.abs(this.modalCurrentTranslateX) > this.modalDragThreshold;
            
            if (shouldChange) {
                const direction = this.modalCurrentTranslateX > 0 ? -1 : 1;
                this.triggerSwipe(direction);
            } else {
                // 回到原位，带动画效果
                this.modalImgCurrent.style.transform = 'translateX(0)';
                this.modalImgNext.style.transform = 'translateX(100%)';
                this.modalImgPrev.style.transform = 'translateX(-100%)';
            }
            
            this.modalCurrentTranslateX = 0;
        }, { passive: true });
    }

    // 显示模态框
    show(index) {
        debugLog('🔄 ModalView.show 被调用', {
            index: index,
            time: new Date().toISOString()
        });
        
        // 检查是否在编辑/添加模式
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const isDeckAddMode = !!document.querySelector('.deck-complete-button');
        const isDeckEditMode = !!document.querySelector('.deck-add-button');
        
        const shouldPreventModal = isDeckMode && (isDeckAddMode || isDeckEditMode);
        
        if (shouldPreventModal) {
            return;
        }
        
        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) return;
        
        // 重置所有图片位置和状态
        this.modalImgCurrent.style.transform = 'translateX(0)';
        this.modalImgNext.style.transform = 'translateX(100%)';
        this.modalImgPrev.style.transform = 'translateX(-100%)';
        this.setModalImageTransitions(this.modalTransition);
        
        this.modalIsDragging = false;
        this.modalCurrentTranslateX = 0;
        this.modalIsAnimating = false;
        this.pendingSwipeDirection = 0;
        this.pendingSwipeIndex = -1;
        
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
        if (cards.length === 0) return;
        
        const prevIndex = this.currentIndex > 0 ? this.currentIndex - 1 : cards.length - 1;
        const nextIndex = this.currentIndex < cards.length - 1 ? this.currentIndex + 1 : 0;
        
        // 预加载到隐藏的img元素中
        if (cards[prevIndex]) {
            // 只有在图片不同时才设置src，避免不必要的网络请求
            if (this.modalImgPrev.src !== cards[prevIndex].image) {
                this.modalImgPrev.src = cards[prevIndex].image;
            }
        }
        if (cards[nextIndex]) {
            if (this.modalImgNext.src !== cards[nextIndex].image) {
                this.modalImgNext.src = cards[nextIndex].image;
            }
        }
        
        // 原有的预加载逻辑（如果需要）
        const cardElements = document.querySelectorAll('.card');
        this.imageLoader.preloadAdjacentImages(this.currentIndex, cards, cardElements);
    }
}