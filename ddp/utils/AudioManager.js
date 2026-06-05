// utils/AudioManager.js
class AudioManager {
    constructor() {
        this.sounds = new Map();
        this.bgm = null;
        this.isMuted = false;
        this.isLoaded = false;
        this.bgmLoopStart = 0;
        this.bgmLoopEnd = 46; // 46秒循环点
        
        // 预加载音效
        this.preloadSounds();
    }

    preloadSounds() {
        const audioFiles = {
            'point': './audio/point.mp3',
            'clear': './audio/clear.mp3',
            'summon': './audio/summon.mp3'
        };

        Object.entries(audioFiles).forEach(([key, path]) => {
            const audio = new Audio();
            audio.src = path;
            audio.preload = 'auto';
            
            audio.addEventListener('canplaythrough', () => {
                console.log(`[音效] ${key} 加载完成`);
            }, { once: true });
            
            audio.addEventListener('error', (e) => {
                console.warn(`[音效] ${key} 加载失败:`, e);
            });
            
            this.sounds.set(key, audio);
        });

        // 预加载BGM
        this.bgm = new Audio();
        this.bgm.src = './audio/background.mp3';
        this.bgm.preload = 'auto';
        this.bgm.loop = true;
        this.bgm.volume = 0.5;
        
        // 监听时间更新以实现指定区间循环
        this.bgm.addEventListener('timeupdate', () => {
            if (!this.bgm.paused && this.bgm.currentTime >= this.bgmLoopEnd) {
                this.bgm.currentTime = this.bgmLoopStart;
            }
        });
        
        this.bgm.addEventListener('canplaythrough', () => {
            console.log('[BGM] 背景音乐加载完成');
        });
        
        this.bgm.addEventListener('error', (e) => {
            console.warn('[BGM] 背景音乐加载失败:', e);
        });

        // 性能优化：5 秒超时兜底，防止音频加载阻塞游戏
        const markLoadedTimeout = setTimeout(() => {
            if (!this.isLoaded) {
                this.isLoaded = true;
                console.log('[音效] 加载超时兜底');
            }
        }, 5000);

        Promise.all(
            Array.from(this.sounds.values()).map(
                audio => new Promise(resolve => {
                    if (audio.readyState >= 3) {
                        resolve();
                    } else {
                        audio.addEventListener('canplaythrough', resolve, { once: true });
                    }
                })
            )
        ).then(() => {
            clearTimeout(markLoadedTimeout);
            if (!this.isLoaded) {
                this.isLoaded = true;
                console.log('[音效] 所有音效加载完成');
            }
        }).catch(error => {
            clearTimeout(markLoadedTimeout);
            console.warn('[音效] 部分音效加载失败:', error);
            this.isLoaded = true; // 失败也放行
        });
    }

    // 播放BGM
    playBGM(volume = 0.5) {
        if (this.isMuted) return;
        
        if (this.bgm) {
            this.bgm.volume = volume;
            this.bgm.currentTime = this.bgmLoopStart;
            this.bgm.play().catch(error => {
                console.warn('[BGM] 播放失败:', error);
            });
            console.log('[BGM] 开始播放');
        }
    }

    // 停止BGM
    stopBGM() {
        if (this.bgm) {
            this.bgm.pause();
            this.bgm.currentTime = 0;
            console.log('[BGM] 停止播放');
        }
    }

    // 淡出BGM
    fadeOutBGM(duration = 2000) {
        if (!this.bgm || this.bgm.volume === 0) return;
        
        console.log('[BGM] 开始淡出');
        const startVolume = this.bgm.volume;
        const startTime = performance.now();
        
        const fadeInterval = setInterval(() => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (this.bgm) {
                this.bgm.volume = startVolume * (1 - progress);
            }
            
            if (progress >= 1) {
                clearInterval(fadeInterval);
                this.stopBGM();
                console.log('[BGM] 淡出完成');
            }
        }, 50);
    }

    // 淡入BGM
    fadeInBGM(duration = 2000, targetVolume = 0.5) {
        if (this.isMuted) return;
        
        console.log('[BGM] 开始淡入');
        this.playBGM(0);
        
        const startTime = performance.now();
        
        const fadeInterval = setInterval(() => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            if (this.bgm) {
                this.bgm.volume = targetVolume * progress;
            }
            
            if (progress >= 1) {
                clearInterval(fadeInterval);
                console.log('[BGM] 淡入完成');
            }
        }, 50);
    }

    // 播放音效（使用 new Audio() 代替 cloneNode，避免 iOS Safari 内存泄漏）
    play(soundName, volume = 0.5) {
        if (this.isMuted) return;

        const sound = this.sounds.get(soundName);
        if (!sound) {
            console.warn(`[音效] 未找到音效: ${soundName}`);
            return;
        }

        try {
            // 性能优化：使用 new Audio() 代替 cloneNode()
            // iOS Safari PWA 模式下 cloneNode 的 ended 事件不可靠，导致 Audio 节点泄漏
            const soundClone = new Audio(sound.src);
            soundClone.volume = volume;
            soundClone.preload = 'auto';

            // 播放完成后自动清理资源
            const cleanup = () => {
                soundClone.pause();
                soundClone.src = '';
                soundClone.load();
                soundClone.removeEventListener('ended', cleanup);
                soundClone.removeEventListener('error', cleanup);
            };

            soundClone.addEventListener('ended', cleanup);
            soundClone.addEventListener('error', cleanup);

            soundClone.play().catch(error => {
                if (error.name !== 'NotAllowedError') {
                    console.warn(`[音效] 播放失败 ${soundName}:`, error);
                }
                cleanup();
            });

            // 安全兜底：5 秒后强制清理
            setTimeout(() => {
                try { cleanup(); } catch (e) { /* ignore */ }
            }, 5000);
        } catch (error) {
            console.warn(`[音效] 播放出错 ${soundName}:`, error);
        }
    }

    playPoint(volume = 0.5) {
        this.play('point', volume);
    }

    playClear(volume = 0.6) {
        this.play('clear', volume);
    }

    playSummon(volume = 0.7) {
        this.play('summon', volume);
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        
        if (this.bgm) {
            if (this.isMuted) {
                this.bgm.volume = 0;
            } else {
                this.bgm.volume = 0.5;
            }
        }
        
        console.log(`[音效] ${this.isMuted ? '已静音' : '已取消静音'}`);
        return this.isMuted;
    }

    setMute(muted) {
        this.isMuted = muted;
        if (this.bgm) {
            this.bgm.volume = muted ? 0 : 0.5;
        }
    }

    isLoading() {
        return !this.isLoaded;
    }
}

export default AudioManager;