// ui/PokemonCell.js - 简化版本
class PokemonCell {
    constructor(index, x, y, size) {
        this.index = index;
        this.x = x;
        this.y = y;
        this.size = size;
        this.pokemon = null;
        this.isActive = true;
        this.typeColors = {};
        
        this.createCanvas();
    }

    createCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.size;
        this.canvas.height = this.size;
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = `${this.x}px`;
        this.canvas.style.top = `${this.y}px`;
        this.ctx = this.canvas.getContext('2d');
    }

    setPokemon(pokemon, imageLoader) {
        console.log(`[格子${this.index}] 设置宝可梦:`, pokemon?.data?.name);
        
        this.pokemon = pokemon;
        this.isActive = true;
        
        if (pokemon) {
            try {
                // 尝试获取精灵图片
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
                    
                    // 异步尝试加载真实图片
                    setTimeout(() => {
                        imageLoader.loadPokemonImage(pokemon.data.id)
                            .then(() => {
                                const newSprite = imageLoader.getPokemonSprite(
                                    pokemon.data.id,
                                    pokemon.isShiny,
                                    false
                                );
                                if (newSprite && this.pokemon === pokemon) {
                                    this.sprite = newSprite;
                                    this.updateDisplay();
                                }
                            })
                            .catch(error => {
                                console.error(`[格子${this.index}] 异步加载图片失败:`, error);
                            });
                    }, 0);
                }
            } catch (error) {
                console.error(`[格子${this.index}] 设置宝可梦图片时出错:`, error);
                this.sprite = this.createSimplePlaceholder(pokemon.data.id);
            }
        } else {
            this.sprite = null;
        }
    }

    createSimplePlaceholder(id) {
        const canvas = document.createElement('canvas');
        canvas.width = this.size;
        canvas.height = this.size;
        const ctx = canvas.getContext('2d');
        
        // 根据ID生成不同的颜色
        const hue = (id * 137) % 360; // 黄金角度
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, this.size, this.size);
        
        // 边框
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, this.size - 4, this.size - 4);
        
        // ID文字
        ctx.fillStyle = 'white';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${id}`, this.size/2, this.size/2);
        
        return canvas;
    }

    updateDisplay() {
        if (!this.ctx || !this.canvas) return;
        
        // 清除画布
        this.ctx.clearRect(0, 0, this.size, this.size);
        
        // 如果有宝可梦
        if (this.pokemon && this.pokemon.currentTypes && this.pokemon.currentTypes[0]) {
            const mainType = this.pokemon.currentTypes[0];
            const typeColor = this.typeColors[mainType] || '#A8A878';
            
            console.log(`[格子${this.index}] 更新显示: ${this.pokemon.data.name}, 属性: ${mainType}, 颜色: ${typeColor}`);
            
            // 绘制属性背景色
            this.ctx.fillStyle = `${typeColor}66`;
            this.ctx.fillRect(0, 0, this.size, this.size);
            
            // 边框
            this.ctx.strokeStyle = typeColor;
            this.ctx.lineWidth = 3;
            this.ctx.strokeRect(2, 2, this.size - 4, this.size - 4);
            
            // 绘制宝可梦
            if (this.sprite) {
                this.ctx.drawImage(
                    this.sprite,
                    (this.size - this.sprite.width) / 2,
                    (this.size - this.sprite.height) / 2
                );
            }
            
            // 绘制特殊标记
            this.ctx.fillStyle = 'white';
            this.ctx.font = 'bold 14px Arial';
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
                this.ctx.font = 'bold 16px Arial';
                this.ctx.fillText('★', this.size - 15, 20);
            }
        } else {
            // 空格子
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            this.ctx.fillRect(0, 0, this.size, this.size);
            
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(2, 2, this.size - 4, this.size - 4);
        }
    }

    // 在ui/PokemonCell.js中添加clear方法（如果还没有的话）
    clear() {
        console.log(`[格子${this.index}] 清除内容`);
        this.pokemon = null;
        this.sprite = null;
        this.isActive = true;
        
        // 清除画布
        this.ctx.clearRect(0, 0, this.size, this.size);
        
        // 绘制空格子背景
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.fillRect(0, 0, this.size, this.size);
        
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(2, 2, this.size - 4, this.size - 4);
    }

    getElement() {
        return this.canvas;
    }
}

export default PokemonCell;