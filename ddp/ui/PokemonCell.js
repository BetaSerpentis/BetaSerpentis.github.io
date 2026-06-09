// ui/PokemonCell.js - 简化版本
class PokemonCell {
    constructor(index, container, size) {
        this.index = index;
        this.container = container;
        this.size = size;
        this.pokemon = null;
        this.isActive = true;
        this.typeColors = {};
        
        this.createCanvas();
    }

    updateSize(newSize) {
        if (newSize && newSize !== this.size) {
            this.size = newSize;
            this.canvas.width = newSize;
            this.canvas.height = newSize;
            this.updateDisplay();
        }
    }

    createCanvas() {
        // 移除已有的canvas
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }
        
        // 创建新的canvas
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.size || 100;
        this.canvas.height = this.size || 100;
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.borderRadius = '8px';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        
        this.drawEmpty();
    }

    // ui/PokemonCell.js - 修改setPokemon方法
    setPokemon(pokemon, imageLoader) {
        console.log(`[格子${this.index}] 设置宝可梦:`, pokemon?.data?.name);
        
        this.pokemon = pokemon;
        this.isActive = true;
        
        if (pokemon) {
            try {
                const sprite = imageLoader.getPokemonSprite(
                    pokemon.data.id,
                    pokemon.isShiny,
                    false
                );
                
                if (sprite) {
                    this.sprite = sprite;
                } else {
                    console.warn(`[格子${this.index}] 无法获取宝可梦图片: ${pokemon.data.id}，使用占位符`);
                    this.sprite = this.createSimplePlaceholder(pokemon.data.id);
                }
            } catch (error) {
                console.error(`[格子${this.index}] 设置宝可梦图片时出错:`, error);
                this.sprite = this.createSimplePlaceholder(pokemon.data.id);
            }
        } else {
            this.sprite = null;
        }
        
        // 清除画布，准备播放动画
        this.ctx.clearRect(0, 0, this.size, this.size);
        this.drawEmpty(); // 显示空格子
    }

    updateDisplay() {
        if (!this.ctx || !this.canvas) return;
        
        // 确保canvas尺寸正确
        if (this.canvas.width !== this.size || this.canvas.height !== this.size) {
            this.canvas.width = this.size;
            this.canvas.height = this.size;
        }
        
        // 清除画布
        this.ctx.clearRect(0, 0, this.size, this.size);
        
        // 如果有宝可梦
        if (this.pokemon && this.pokemon.currentTypes && this.pokemon.currentTypes[0]) {
            this.drawPokemon();
        } else {
            this.drawEmpty();
        }
    }

    drawPokemon() {
        const types = this.pokemon.currentTypes;
        const s = this.size;

        if (types.length >= 2) {
            // 双属性：对角分割，左上三角形 type1，右下三角形 type2
            const c1 = this.typeColors[types[0]] || '#A8A878';
            const c2 = this.typeColors[types[1]] || '#A8A878';

            this.ctx.fillStyle = `${c1}66`;
            this.ctx.beginPath();
            this.ctx.moveTo(0, 0);
            this.ctx.lineTo(s, 0);
            this.ctx.lineTo(0, s);
            this.ctx.closePath();
            this.ctx.fill();

            this.ctx.fillStyle = `${c2}66`;
            this.ctx.beginPath();
            this.ctx.moveTo(s, 0);
            this.ctx.lineTo(s, s);
            this.ctx.lineTo(0, s);
            this.ctx.closePath();
            this.ctx.fill();

            // 边框：对角线分两种颜色各画一半
            this.ctx.lineWidth = Math.max(2, s * 0.01);
            this.ctx.strokeStyle = c1;
            this.ctx.beginPath();
            this.ctx.moveTo(2, 2);
            this.ctx.lineTo(s - 2, 2);
            this.ctx.lineTo(2, s - 2);
            this.ctx.stroke();

            this.ctx.strokeStyle = c2;
            this.ctx.beginPath();
            this.ctx.moveTo(s - 2, 2);
            this.ctx.lineTo(s - 2, s - 2);
            this.ctx.lineTo(2, s - 2);
            this.ctx.stroke();
        } else {
            // 单属性：纯色背景
            const typeColor = this.typeColors[types[0]] || '#A8A878';

            this.ctx.fillStyle = `${typeColor}66`;
            this.ctx.fillRect(0, 0, s, s);

            this.ctx.strokeStyle = typeColor;
            this.ctx.lineWidth = Math.max(2, s * 0.01);
            this.ctx.strokeRect(2, 2, s - 4, s - 4);
        }
        
        // 绘制宝可梦
        if (this.sprite) {
            // 计算缩放比例，让图片适应格子大小（留出20%边距）
            const maxSize = this.size * 0.7;
            const scale = maxSize / Math.max(this.sprite.width, this.sprite.height);
            
            this.ctx.save();
            this.ctx.translate(this.size / 2, this.size / 2);
            this.ctx.scale(scale, scale);
            this.ctx.drawImage(
                this.sprite,
                -this.sprite.width / 2,
                -this.sprite.height / 2
            );
            this.ctx.restore();
        }
        
        // 绘制特殊标记
        this.ctx.fillStyle = 'white';
        this.ctx.font = `bold ${Math.floor(this.size * 0.16)}px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        
        let text = '';
        if (this.pokemon.data.isTransformer) text += '变';
        if (this.pokemon.data.isLegendary) text += '传';
        if (this.pokemon.data.isMythical) text += '幻';
        
        if (text) {
            this.ctx.fillText(text, this.size / 2, this.size - 8);
        }
        
        // 如果是异色，添加星星标记
        if (this.pokemon.isShiny) {
            this.ctx.fillStyle = 'gold';
            this.ctx.font = `bold ${Math.floor(this.size * 0.2)}px Arial`;
            this.ctx.fillText('★', this.size - 15, 20);
        }
    }

    // ui/PokemonCell.js - 添加drawEmpty方法
    drawEmpty() {
        // 空格子背景
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.fillRect(0, 0, this.size, this.size);
        
        // 边框
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = Math.max(1, this.size * 0.005);
        this.ctx.strokeRect(2, 2, this.size - 4, this.size - 4);
    }

    createSimplePlaceholder(id) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        const hue = (id * 137) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, 64, 64);
        
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, 60, 60);
        
        ctx.fillStyle = 'white';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${id}`, 32, 32);
        
        return canvas;
    }

    // ui/PokemonCell.js - 修改clear方法
    clear() {
        console.log(`[格子${this.index}] 清除内容`);
        this.pokemon = null;
        this.sprite = null;
        this.isActive = false;
        
        this.ctx.clearRect(0, 0, this.size, this.size);
        this.drawEmpty();
    }

    getElement() {
        return this.canvas;
    }
    
    // 获取格子中心点的屏幕坐标
    getCenterPosition() {
        const rect = this.container.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
    }
}

export default PokemonCell;