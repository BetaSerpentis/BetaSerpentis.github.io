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
        
        // 修改左右箭头事件 - 改为触发快速拖动
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

    // 新增：触发快速滑动切换
    triggerSwipe(direction) {
        if (this.modalIsAnimating) return;
        
        const cards = this.cardManager.getDisplayCards();
        if (cards.length === 0) return;
        
        this.modalIsAnimating = true;
        
        let newIndex = this.currentIndex + direction;
        if (newIndex < 0) newIndex = cards.length - 1;
        else if (newIndex >= cards.length) newIndex = 0;
        
        // 执行滑动动画
        if (direction === 1) {
            // 向右滑动切换
            this.modalImgCurrent.style.transform = 'translateX(-100%)';
            this.modalImgNext.style.transform = 'translateX(0)';
        } else {
            // 向左滑动切换
            this.modalImgCurrent.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(0)';
        }
        
        // 动画完成后更新状态
        setTimeout(() => {
            this.currentIndex = newIndex;
            const card = cards[this.currentIndex];
            
            // 重置所有图片位置
            this.modalImgCurrent.style.transition = 'none';
            this.modalImgNext.style.transition = 'none';
            this.modalImgPrev.style.transition = 'none';
            
            // 更新当前显示的图片
            this.modalImgCurrent.src = card.image;
            this.modalImgCurrent.style.transform = 'translateX(0)';
            
            // 重置相邻图片位置
            this.modalImgNext.style.transform = 'translateX(100%)';
            this.modalImgPrev.style.transform = 'translateX(-100%)';
            
            // 恢复过渡效果
            setTimeout(() => {
                this.modalImgCurrent.style.transition = 'transform 0.3s ease';
                this.modalImgNext.style.transition = 'transform 0.3s ease';
                this.modalImgPrev.style.transition = 'transform 0.3s ease';
            }, 50);
            
            // 更新卡牌名称
            this.cardName.textContent = card.name;
            
            // 预加载新的相邻图片
            this.preloadAdjacentImages();
            
            this.modalIsAnimating = false;
        }, 300);
    }

    // 简化触摸事件处理
    initModalTouchEvents() {
        this.modalImgContainer.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.modal-img-container') || this.modalIsAnimating) return;
            
            this.modalTouchStartX = e.touches[0].clientX;
            this.modalIsDragging = true;
            this.modalImgCurrent.style.transition = 'none';
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchmove', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) return;
            
            const touchX = e.touches[0].clientX;
            const deltaX = touchX - this.modalTouchStartX;
            this.modalCurrentTranslateX = deltaX;
            
            // 限制最大拖动距离
            const maxTranslate = window.innerWidth * 0.5;
            const boundedTranslate = Math.max(-maxTranslate, Math.min(maxTranslate, deltaX));
            
            this.modalImgCurrent.style.transform = `translateX(${boundedTranslate}px)`;
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchend', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) return;
            
            this.modalIsDragging = false;
            this.modalImgCurrent.style.transition = 'transform 0.3s ease';
            
            const shouldChange = Math.abs(this.modalCurrentTranslateX) > this.modalDragThreshold;
            
            if (shouldChange) {
                const direction = this.modalCurrentTranslateX > 0 ? -1 : 1;
                this.triggerSwipe(direction);
            } else {
                // 回到原位
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