// ui/MessageBoard.js
class MessageBoard {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.messages = [];
        this.maxMessages = 10;
        this.canvas = null;
        this.ctx = null;
        
        this.createCanvas();
    }

    createCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = `${this.x}px`;
        this.canvas.style.top = `${this.y}px`;
        this.canvas.style.background = 'rgba(0, 0, 0, 0.8)';
        this.canvas.style.borderRadius = '10px';
        this.ctx = this.canvas.getContext('2d');
        
        this.updateDisplay();
    }

    addMessage(type, message, color = null) {
        const timestamp = new Date().toLocaleTimeString();
        
        // 根据类型设置默认颜色
        if (!color) {
            switch(type) {
                case '奖励': color = '#81C784'; break;
                case '规则': color = '#4FC3F7'; break;
                case '进化': color = '#BA68C8'; break;
                case '召唤': color = '#64B5F6'; break;
                case '变身': color = '#9575CD'; break;
                case '游戏结束': color = '#FF5252'; break;
                case '错误': color = '#F44336'; break;
                default: color = '#FFFFFF';
            }
        }
        
        this.messages.unshift({
            type,
            message,
            timestamp,
            color
        });
        
        if (this.messages.length > this.maxMessages) {
            this.messages.pop();
        }
        
        this.updateDisplay();
    }

    updateDisplay() {
        this.ctx.clearRect(0, 0, this.width, this.height);
        
        // 标题
        this.ctx.fillStyle = '#FFD700';
        this.ctx.font = 'bold 16px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('游戏日志', this.width / 2, 25);
        
        // 消息列表
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'left';
        
        let y = 50;
        for (const msg of this.messages) {
            // 设置颜色
            this.ctx.fillStyle = msg.color;
            
            // 时间戳
            this.ctx.globalAlpha = 0.7;
            this.ctx.fillText(`[${msg.timestamp}]`, 10, y);
            this.ctx.globalAlpha = 1.0;
            
            // 消息内容
            const text = msg.message;
            const textX = 100; // 时间戳后开始
            
            // 换行处理
            const maxWidth = this.width - textX - 10;
            
            if (this.ctx.measureText(text).width > maxWidth) {
                // 换行处理
                const words = text.split(' ');
                let line = '';
                let lineY = y;
                
                for (const word of words) {
                    const testLine = line + word + ' ';
                    if (this.ctx.measureText(testLine).width > maxWidth) {
                        this.ctx.fillText(line, textX, lineY);
                        line = word + ' ';
                        lineY += 16;
                    } else {
                        line = testLine;
                    }
                }
                this.ctx.fillText(line, textX, lineY);
                y = lineY + 20;
            } else {
                this.ctx.fillText(text, textX, y);
                y += 20;
            }
            
            if (y > this.height - 20) break;
        }
    }

    clear() {
        this.messages = [];
        this.updateDisplay();
    }

    getElement() {
        return this.canvas;
    }
}

export default MessageBoard;