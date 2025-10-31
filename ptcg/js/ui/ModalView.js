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
        
        this.prevArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.navigateCard(-1);
        });
        
        this.nextArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.navigateCard(1);
        });
        
        document.addEventListener('keydown', (e) => {
            if (!this.modal.classList.contains('active')) return;
            
            if (e.key === 'Escape') this.close();
            else if (e.key === 'ArrowLeft') this.navigateCard(-1);
            else if (e.key === 'ArrowRight') this.navigateCard(1);
        });
        
        this.initModalTouchEvents();
    }

    // 初始化模态框触摸事件
    initModalTouchEvents() {
        const cards = this.cardManager.getDisplayCards();
        
        this.modalImgContainer.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.modal-img-container') || this.modalIsAnimating) return;
            
            this.modalTouchStartX = e.touches[0].clientX;
            this.modalIsDragging = true;
            this.modalImgCurrent.style.transition = 'none';
            this.modalImgNext.style.transition = 'none';
            this.modalImgPrev.style.transition = 'none';
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchmove', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) return;
            
            const touchX = e.touches[0].clientX;
            const deltaX = touchX - this.modalTouchStartX;
            this.modalCurrentTranslateX = deltaX;
            
            const maxTranslate = window.innerWidth * 0.3;
            const boundedTranslate = Math.max(-maxTranslate, Math.min(maxTranslate, deltaX));
            
            this.modalImgCurrent.style.transform = `translateX(${boundedTranslate}px)`;
            
            if (deltaX < -30 && this.modalImgNext.style.transform === 'translateX(100%)') {
                const nextIndex = (this.currentIndex + 1) % cards.length;
                this.modalImgNext.src = cards[nextIndex].image;
                this.modalImgNext.style.transform = 'translateX(100%)';
            } else if (deltaX > 30 && this.modalImgPrev.style.transform === 'translateX(-100%)') {
                const prevIndex = (this.currentIndex - 1 + cards.length) % cards.length;
                this.modalImgPrev.src = cards[prevIndex].image;
                this.modalImgPrev.style.transform = 'translateX(-100%)';
            }
        }, { passive: true });
        
        this.modalImgContainer.addEventListener('touchend', (e) => {
            if (!this.modalIsDragging || this.modalIsAnimating) return;
            
            this.modalIsDragging = false;
            this.modalImgCurrent.style.transition = 'transform 0.3s ease';
            this.modalImgNext.style.transition = 'transform 0.3s ease';
            this.modalImgPrev.style.transition = 'transform 0.3s ease';
            
            const shouldChange = Math.abs(this.modalCurrentTranslateX) > this.modalDragThreshold;
            const direction = this.modalCurrentTranslateX > 0 ? -1 : 1;
            
            if (shouldChange) {
                this.modalIsAnimating = true;
                
                let newIndex = this.currentIndex + direction;
                if (newIndex < 0) newIndex = cards.length - 1;
                else if (newIndex >= cards.length) newIndex = 0;
                
                if (direction === 1) {
                    this.modalImgCurrent.style.transform = 'translateX(-100%)';
                    this.modalImgNext.style.transform = 'translateX(0)';
                } else {
                    this.modalImgCurrent.style.transform = 'translateX(100%)';
                    this.modalImgPrev.style.transform = 'translateX(0)';
                }
                
                setTimeout(() => {
                    this.currentIndex = newIndex;
                    const card = cards[this.currentIndex];
                    
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
                    
                    this.preloadAdjacentImages();
                    this.modalIsAnimating = false;
                }, 300);
            } else {
                this.modalImgCurrent.style.transform = 'translateX(0)';
                this.modalImgNext.style.transform = 'translateX(100%)';
                this.modalImgPrev.style.transform = 'translateX(-100%)';
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