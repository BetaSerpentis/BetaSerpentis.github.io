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
        
        this.modalIsAnimating = true;
        
        let newIndex = this.currentIndex + direction;
        if (newIndex < 0) newIndex = cards.length - 1;
        else if (newIndex >= cards.length) newIndex = 0;
        
        const newCard = cards[newIndex];
        
        // 关键修复：在动画开始前预加载并设置新图片
        if (direction === 1) {
            // 向右切换：下一张图片移动到当前位置
            this.modalImgNext.src = newCard.image;
            this.modalImgCurrent.style.transform = 'translateX(-100%)';
            this.modalImgNext.style.transform = 'translateX(0)';
        } else {
            // 向左切换：上一张图片移动到当前位置  
            this.modalImgPrev.src = newCard.image;
            this.modalImgCurrent.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(0)';
        }
        
        // 等待动画完成
        setTimeout(() => {
            // 关键修复：先交换图片角色，再重置位置
            if (direction === 1) {
                // 向右切换后：next 变成 current，current 变成 prev
                [this.modalImgCurrent.src, this.modalImgPrev.src] = 
                [this.modalImgNext.src, this.modalImgCurrent.src];
            } else {
                // 向左切换后：prev 变成 current，current 变成 next  
                [this.modalImgCurrent.src, this.modalImgNext.src] = 
                [this.modalImgPrev.src, this.modalImgCurrent.src];
            }
            
            // 现在才重置过渡效果和位置
            this.modalImgCurrent.style.transition = 'none';
            this.modalImgNext.style.transition = 'none';
            this.modalImgPrev.style.transition = 'none';
            
            // 重置位置（此时 modalImgCurrent 已经显示正确的新图片）
            this.modalImgCurrent.style.transform = 'translateX(0)';
            this.modalImgNext.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(-100%)';
            
            // 强制重绘，确保样式应用
            this.modalImgCurrent.offsetHeight;
            this.modalImgNext.offsetHeight; 
            this.modalImgPrev.offsetHeight;
            
            // 恢复过渡效果
            setTimeout(() => {
                this.modalImgCurrent.style.transition = 'transform 0.3s ease';
                this.modalImgNext.style.transition = 'transform 0.3s ease';
                this.modalImgPrev.style.transition = 'transform 0.3s ease';
            }, 50);
            
            this.currentIndex = newIndex;
            this.cardName.textContent = newCard.name;
            this.modalIsAnimating = false;
            
            this.preloadAdjacentImages();
        }, 300);
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
            this.modalImgCurrent.style.transition = 'transform 0.3s ease';
            this.modalImgNext.style.transition = 'transform 0.3s ease';
            this.modalImgPrev.style.transition = 'transform 0.3s ease';
            
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
        console.log('🔄 ModalView.show 被调用', {
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
        this.modalImgCurrent.style.transition = 'transform 0.3s ease';
        this.modalImgNext.style.transition = 'transform 0.3s ease';
        this.modalImgPrev.style.transition = 'transform 0.3s ease';
        
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