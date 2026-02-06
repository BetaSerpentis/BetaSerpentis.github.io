// utils/AnimationManager.js
class AnimationManager {
    constructor() {
        this.animations = [];
        this.rafId = null;
    }

    addAnimation(animation) {
        this.animations.push(animation);
        if (!this.rafId) {
            this.startAnimationLoop();
        }
    }

    startAnimationLoop() {
        const animate = () => {
            const now = performance.now();
            let hasActiveAnimations = false;

            for (let i = this.animations.length - 1; i >= 0; i--) {
                const anim = this.animations[i];
                const elapsed = now - anim.startTime;
                
                if (elapsed >= anim.duration) {
                    // 动画结束
                    anim.onComplete?.();
                    this.animations.splice(i, 1);
                    continue;
                }

                const progress = elapsed / anim.duration;
                anim.update(progress);
                hasActiveAnimations = true;
            }

            if (hasActiveAnimations) {
                this.rafId = requestAnimationFrame(animate);
            } else {
                this.rafId = null;
            }
        };

        this.rafId = requestAnimationFrame(animate);
    }

    // 抛物线动画
    createParabolaAnimation(start, end, duration, onUpdate, onComplete) {
        const controlPoint = {
            x: (start.x + end.x) / 2,
            y: Math.min(start.y, end.y) - 100
        };

        return {
            startTime: performance.now(),
            duration,
            update: (progress) => {
                // 贝塞尔曲线计算
                const x = 
                    Math.pow(1 - progress, 2) * start.x +
                    2 * (1 - progress) * progress * controlPoint.x +
                    Math.pow(progress, 2) * end.x;
                
                const y = 
                    Math.pow(1 - progress, 2) * start.y +
                    2 * (1 - progress) * progress * controlPoint.y +
                    Math.pow(progress, 2) * end.y;
                
                // 旋转角度
                const rotation = progress * 720; // 旋转两周
                
                onUpdate({ x, y, rotation });
            },
            onComplete
        };
    }

    // 缩放动画
    createScaleAnimation(startScale, endScale, duration, onUpdate, onComplete) {
        return {
            startTime: performance.now(),
            duration,
            update: (progress) => {
                const scale = startScale + (endScale - startScale) * progress;
                onUpdate(scale);
            },
            onComplete
        };
    }

    // 闪烁动画（用于进化）
    createFlashAnimation(duration, onUpdate, onComplete) {
        let flashState = true;
        return {
            startTime: performance.now(),
            duration,
            update: (progress) => {
                const flashInterval = 0.1; // 闪烁间隔
                const shouldFlash = Math.floor(progress / flashInterval) % 2 === 0;
                
                if (flashState !== shouldFlash) {
                    flashState = shouldFlash;
                    onUpdate(flashState);
                }
            },
            onComplete
        };
    }

    // utils/AnimationManager.js - 修复createStarEffectAnimation方法
    createStarEffectAnimation(x, y, count, onUpdate, onComplete) {
        const stars = [];
        for (let i = 0; i < count; i++) {
            stars.push({
                x,
                y,
                angle: (i * Math.PI * 2) / count,
                distance: 0,
                scale: 0
            });
        }

        return {
            startTime: performance.now(),
            duration: 1000,
            update: (progress) => {
                stars.forEach(star => {
                    star.distance = progress * 50;
                    star.scale = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
                });
                
                // 调用onUpdate回调
                if (onUpdate) {
                    onUpdate(stars);
                }
            },
            onComplete: onComplete // 确保onComplete被传递
        };
    }

    // 对子消除动画
    createPairAnimation(start1, start2, end, duration, onUpdate, onComplete) {
        return {
            startTime: performance.now(),
            duration,
            update: (progress) => {
                const pos1 = {
                    x: start1.x + (end.x - start1.x) * progress,
                    y: start1.y + (end.y - start1.y) * progress,
                    scale: 1 - progress * 0.5
                };
                
                const pos2 = {
                    x: start2.x + (end.x - start2.x) * progress,
                    y: start2.y + (end.y - start2.y) * progress,
                    scale: 1 - progress * 0.5
                };
                
                onUpdate([pos1, pos2]);
            },
            onComplete
        };
    }
}

export default AnimationManager;