// ui/BallCounter.js
class BallCounter {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.count = 9;
        this.totalBallsAdded = 0;
        this.ballImage = null;
        this.canvas = null;
        this.ctx = null;
        
        this.createCanvas();
    }

    createCanvas() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 300;
        this.canvas.height = 80;
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = `${this.x}px`;
        this.canvas.style.top = `${this.y}px`;
        this.ctx = this.canvas.getContext('2d');
    }

    setBallImage(image) {
        this.ballImage = image;
        this.updateDisplay();
    }

    updateDisplay() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 背景
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 标题
        this.ctx.fillStyle = 'white';
        this.ctx.font = 'bold 16px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('精灵球', 10, 25);
        
        // 数量
        this.ctx.font = 'bold 24px Arial';
        this.ctx.fillText(`${this.count}`, 80, 30);
        
        // 绘制精灵球
        if (this.ballImage) {
            this.ctx.drawImage(this.ballImage, 200, 15, 32, 32);
        }
        
        // 累计获得
        this.ctx.font = '14px Arial';
        this.ctx.fillStyle = '#FFD700';
        this.ctx.fillText(`累计获得: ${this.totalBallsAdded}`, 10, 55);
    }

    setCount(count) {
        this.count = count;
        this.updateDisplay();
    }

    setTotalAdded(total) {
        this.totalBallsAdded = total;
        this.updateDisplay();
    }

    getElement() {
        return this.canvas;
    }
}

export default BallCounter;