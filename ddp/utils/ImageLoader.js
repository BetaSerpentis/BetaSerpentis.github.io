// utils/ImageLoader.js - 修复版本
class ImageLoader {
    constructor() {
        this.images = new Map();
        this.pokemonSprites = new Map();
        this.ballImage = null;
        this.pokemonSize = 64;
        this.loadingPromises = new Map();
        // 性能优化：缓存提取的精灵图，避免每次 getPokemonSprite 创建新 Canvas
        this.extractedSprites = new Map();
    }

    async loadPokemonImage(id) {
        // 如果已经加载过，直接返回
        if (this.pokemonSprites.has(id)) {
            return this.pokemonSprites.get(id);
        }
        
        // 如果正在加载中，等待加载完成
        if (this.loadingPromises.has(id)) {
            return await this.loadingPromises.get(id);
        }
        
        console.log(`[ImageLoader] 开始加载宝可梦图片: ${id}`);
        
        // 关键修复：先创建Promise变量
        let loadPromiseResolve;
        let loadPromiseReject;
        
        const loadPromise = new Promise((resolve, reject) => {
            loadPromiseResolve = resolve;
            loadPromiseReject = reject;
        });
        
        // 立即设置到loadingPromises，避免异步问题
        this.loadingPromises.set(id, loadPromise);
        
        // 异步加载图片
        this.doLoadPokemonImage(id, loadPromiseResolve, loadPromiseReject);
        
        return await loadPromise;
    }

    // 新增：分离的异步加载方法
    async doLoadPokemonImage(id, resolve, reject) {
        try {
            const img = new Image();
            img.crossOrigin = "anonymous";
            
            const paddedId = id.toString().padStart(3, '0');
            img.src = `./images/${paddedId}.png`;
            
            img.onload = () => {
                console.log(`[ImageLoader] 图片加载成功: ${id}, 尺寸: ${img.width}x${img.height}`);
                
                const processed = this.removeBackground(img);
                this.pokemonSprites.set(id, processed);
                this.loadingPromises.delete(id);
                
                resolve(processed);
            };
            
            img.onerror = (error) => {
                console.error(`[ImageLoader] 无法加载图片 ${id}:`, error);
                console.error(`[ImageLoader] 尝试的路径: ./images/${paddedId}.png`);
                
                const canvas = this.createPlaceholderImage(id);
                this.pokemonSprites.set(id, canvas);
                this.loadingPromises.delete(id);
                
                resolve(canvas);
            };
            
        } catch (error) {
            console.error(`[ImageLoader] 加载图片 ${id} 时出错:`, error);
            
            const canvas = this.createPlaceholderImage(id);
            this.pokemonSprites.set(id, canvas);
            this.loadingPromises.delete(id);
            
            resolve(canvas);
        }
    }

    createPlaceholderImage(id) {
        const canvas = document.createElement('canvas');
        canvas.width = this.pokemonSize * 4;
        canvas.height = this.pokemonSize;
        const ctx = canvas.getContext('2d');
        
        const colors = ['#FF9999', '#99FF99', '#9999FF', '#FFFF99'];
        for (let i = 0; i < 4; i++) {
            ctx.fillStyle = colors[i];
            ctx.fillRect(i * this.pokemonSize, 0, this.pokemonSize, this.pokemonSize);
            
            ctx.fillStyle = 'black';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`ID:${id}`, i * this.pokemonSize + this.pokemonSize/2, this.pokemonSize/2);
        }
        
        console.log(`[ImageLoader] 创建占位符图片: ${id}`);
        return canvas;
    }

    removeBackground(img) {
        console.log(`[ImageLoader] 处理图片背景，尺寸: ${img.width}x${img.height}`);
        
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        
        ctx.drawImage(img, 0, 0);
        
        const pixelData = ctx.getImageData(0, 0, 1, 1).data;
        const bgR = pixelData[0];
        const bgG = pixelData[1];
        const bgB = pixelData[2];
        
        console.log(`[ImageLoader] 检测到背景色: RGB(${bgR}, ${bgG}, ${bgB})`);
        
        if (pixelData[3] < 255) {
            console.log(`[ImageLoader] 图片已有透明背景，无需处理`);
            return canvas;
        }
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);
        
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        
        const tolerance = 40;
        let processedPixels = 0;
        
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            if (Math.abs(r - bgR) < tolerance &&
                Math.abs(g - bgG) < tolerance &&
                Math.abs(b - bgB) < tolerance) {
                data[i + 3] = 0;
                processedPixels++;
            }
        }
        
        console.log(`[ImageLoader] 处理了 ${processedPixels} 个背景像素`);
        
        tempCtx.putImageData(imageData, 0, 0);
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tempCanvas, 0, 0);
        
        return canvas;
    }

    async loadBallImage() {
        if (this.ballImage) return this.ballImage;

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = './images/ball.png';
            
            img.onload = () => {
                console.log('[ImageLoader] 精灵球图片加载成功');
                const processed = this.removeBackground(img);
                this.ballImage = processed;
                resolve(processed);
            };
            
            img.onerror = () => {
                console.error('[ImageLoader] 无法加载精灵球图片');
                const canvas = this.createBallPlaceholder();
                this.ballImage = canvas;
                resolve(canvas);
            };
        });
    }

    createBallPlaceholder() {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        
        ctx.fillStyle = 'red';
        ctx.beginPath();
        ctx.arc(16, 16, 15, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(16, 16, 15, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(16, 16, 5, 0, Math.PI * 2);
        ctx.fill();
        
        return canvas;
    }

    getPokemonSprite(id, isShiny = false, isBack = false) {
        // 性能优化：缓存 key，避免每次都创建新 Canvas 对象
        const cacheKey = `${id}_${isShiny ? 's' : 'n'}_${isBack ? 'b' : 'f'}`;

        if (this.extractedSprites.has(cacheKey)) {
            return this.extractedSprites.get(cacheKey);
        }

        if (!this.pokemonSprites.has(id)) {
            console.warn(`[ImageLoader] 宝可梦 ${id} 的图片未加载`);
            return null;
        }

        const spriteSheet = this.pokemonSprites.get(id);

        if (!spriteSheet || !spriteSheet.width || !spriteSheet.height) {
            console.error(`[ImageLoader] 宝可梦 ${id} 的spriteSheet无效`);
            return null;
        }

        const canvas = document.createElement('canvas');
        canvas.width = this.pokemonSize;
        canvas.height = this.pokemonSize;
        const ctx = canvas.getContext('2d');

        let sx = 0;

        if (isShiny && isBack) {
            sx = this.pokemonSize * 3;
        } else if (isShiny && !isBack) {
            sx = this.pokemonSize * 1;
        } else if (!isShiny && isBack) {
            sx = this.pokemonSize * 2;
        } else {
            sx = 0;
        }

        if (sx + this.pokemonSize > spriteSheet.width) {
            sx = 0;
        }

        try {
            ctx.drawImage(
                spriteSheet,
                sx, 0,
                this.pokemonSize, this.pokemonSize,
                0, 0,
                this.pokemonSize, this.pokemonSize
            );

            // 缓存提取结果
            this.extractedSprites.set(cacheKey, canvas);
            return canvas;
        } catch (error) {
            console.error(`[ImageLoader] 提取精灵图失败:`, error);
            return null;
        }
    }
}

export default ImageLoader;