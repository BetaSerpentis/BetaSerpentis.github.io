import { CONFIG } from '../utils/constants.js';

export class ImageLoader {
    constructor() {
        this.loadedImages = new Set();
        this.failedImages = new Set();
        this.observer = null;
    }

    // 初始化懒加载观察器
    initLazyLoading() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    if (entry.target.id === 'load-more-trigger') {
                        // 触发加载更多
                        if (this.onLoadMore) {
                            this.onLoadMore();
                        }
                    } else if (entry.target.classList.contains('card-img')) {
                        const img = entry.target;
                        const index = img.dataset.index;
                        const src = img.dataset.src;
                        
                        if (!this.loadedImages.has(index) && !this.failedImages.has(index)) {
                            this.loadImageWithRetry(img, src, index, CONFIG.imageRetryCount);
                        }
                    }
                }
            });
        }, { rootMargin: '200px 0px', threshold: 0.01 });
    }

    // 带重试的图片加载
    loadImageWithRetry(img, src, index, retries) {
        if (img.dataset.loading === 'true') return;
        img.dataset.loading = 'true';
        
        const tempImg = new Image();
        
        tempImg.onload = function() {
            img.src = src;
            img.classList.add('loaded');
            img.classList.remove('error');
            this.loadedImages.add(index);
            this.failedImages.delete(index);
            img.dataset.loading = 'false';
        }.bind(this);
        
        tempImg.onerror = function() {
            if (retries > 0) {
                setTimeout(() => {
                    this.loadImageWithRetry(img, src, index, retries - 1);
                }, 500);
            } else {
                const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23FFCC00"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23000000">图片加载失败</text></svg>`;
                img.src = svgPlaceholder;
                img.classList.add('error');
                this.failedImages.add(index);
                img.dataset.loading = 'false';
            }
        }.bind(this);
        
        tempImg.src = src;
    }

    // 观察图片元素
    observeImage(img) {
        if (this.observer) {
            this.observer.observe(img);
        }
    }

    // 观察加载更多触发器
    observeLoadMoreTrigger(trigger) {
        if (this.observer && trigger) {
            this.observer.observe(trigger);
        }
    }

    // 预加载相邻图片
    preloadAdjacentImages(centerIndex, cards, cardElements) {
        for (let i = Math.max(0, centerIndex - 2); i <= Math.min(cards.length - 1, centerIndex + 2); i++) {
            if (!this.loadedImages.has(i.toString()) && !this.failedImages.has(i.toString())) {
                const cardElement = cardElements[i];
                if (cardElement) {
                    const img = cardElement.querySelector('.card-img');
                    if (img) {
                        this.loadImageWithRetry(img, img.dataset.src, i, CONFIG.imageRetryCount);
                    }
                }
            }
        }
    }

    // 重置加载状态
    reset() {
        this.loadedImages.clear();
        this.failedImages.clear();
    }

    // 设置加载更多回调
    setOnLoadMore(callback) {
        this.onLoadMore = callback;
    }
}