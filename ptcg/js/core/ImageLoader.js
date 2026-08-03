import { CONFIG } from '../utils/constants.js';

const MAX_CONCURRENT = 8;

export class ImageLoader {
    constructor() {
        this.loadedImages = new Set();
        this.failedImages = new Set();
        this.observer = null;

        // 并发控制
        this._activeCount = 0;
        this._pendingQueue = [];
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
                        const src = img.dataset.src;
                        const key = img.dataset.cardId || src;

                        if (this.loadedImages.has(key)) {
                            img.src = src;
                            img.classList.add('loaded');
                            img.classList.remove('error');
                            img.dataset.loading = 'false';
                        } else if (!this.failedImages.has(key)) {
                            this.loadImageWithRetry(img, src, key, CONFIG.imageRetryCount);
                        }
                    }
                }
            });
        }, { rootMargin: '600px 0px', threshold: 0.01 });
    }

    // 带重试的图片加载（入口：排队等待并发槽位）
    loadImageWithRetry(img, src, key, retries) {
        if (img.dataset.loading === 'true') return;
        img.dataset.loading = 'true';
        this._pendingQueue.push({ img, src, key, retries });
        this._drainQueue();
    }

    // 从队列中取出等待任务，控制在 MAX_CONCURRENT 以内
    _drainQueue() {
        while (this._activeCount < MAX_CONCURRENT && this._pendingQueue.length > 0) {
            const task = this._pendingQueue.shift();
            this._activeCount++;
            this._doLoad(task);
        }
    }

    _doLoad({ img, src, key, retries }) {
        const tempImg = new Image();

        tempImg.onload = () => {
            img.src = src;
            img.classList.add('loaded');
            img.classList.remove('error');
            this.loadedImages.add(key);
            this.failedImages.delete(key);
            img.dataset.loading = 'false';
            this._finishOne();
        };

        tempImg.onerror = () => {
            if (retries > 0) {
                setTimeout(() => {
                    this._pendingQueue.push({ img, src, key, retries: retries - 1 });
                    this._drainQueue();
                }, 500);
            } else {
                const svgPlaceholder = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="%23FFCC00"/><text x="126" y="176" font-family="Arial" font-size="14" text-anchor="middle" fill="%23000000">加载失败</text></svg>`;
                img.src = svgPlaceholder;
                img.classList.add('error');
                this.failedImages.add(key);
                img.dataset.loading = 'false';
            }
            this._finishOne();
        };

        tempImg.src = src;
    }

    _finishOne() {
        this._activeCount--;
        this._drainQueue();
    }

    // 观察图片元素
    // 在 observeImage 方法中添加调试
    observeImage(img) {
        if (this.observer) {
            // // console.log('👀 开始观察图片:', img.dataset.src);
            this.observer.observe(img);
        } else {
            console.error('❌ ImageLoader 观察器未初始化');
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
            const card = cards[i];
            const key = card?.id || card?.image;
            if (key && !this.loadedImages.has(key) && !this.failedImages.has(key)) {
                const cardElement = cardElements[i];
                if (cardElement) {
                    const img = cardElement.querySelector('.card-img');
                    if (img) {
                        this.loadImageWithRetry(img, img.dataset.src, key, CONFIG.imageRetryCount);
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