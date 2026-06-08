// utils/AudioManager.js
class AudioManager {
    constructor() {
        this.sounds = new Map();
        this.bgm = null;
        this.isMuted = false;
        this.isLoaded = false;
        this.bgmLoopStart = 0;
        this.bgmLoopEnd = 46;

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

        this.bgm.addEventListener('timeupdate', () => {
            if (!this.bgm.paused && this.bgm.currentTime >= this.bgmLoopEnd) {
                this.bgm.currentTime = this.bgmLoopStart;
            }
        });

        // 5 秒加载超时兜底
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
            this.isLoaded = true;
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
        }
    }

    stopBGM() {
        if (this.bgm) {
            this.bgm.pause();
            this.bgm.currentTime = 0;
        }
    }

    fadeOutBGM(duration = 2000) {
        if (!this.bgm || this.bgm.volume === 0) return;
        const startVolume = this.bgm.volume;
        const startTime = performance.now();
        const fadeInterval = setInterval(() => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            if (this.bgm) this.bgm.volume = startVolume * (1 - progress);
            if (progress >= 1) {
                clearInterval(fadeInterval);
                this.stopBGM();
            }
        }, 50);
    }

    fadeInBGM(duration = 2000, targetVolume = 0.5) {
        if (this.isMuted) return;
        this.playBGM(0);
        const startTime = performance.now();
        const fadeInterval = setInterval(() => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            if (this.bgm) this.bgm.volume = targetVolume * progress;
            if (progress >= 1) clearInterval(fadeInterval);
        }, 50);
    }

    // 播放音效 — cloneNode 方案（原始验证过，iOS 稳定）
    // cloneNode 继承父元素的用户手势解锁状态，每次独立播放不冲突
    play(soundName, volume = 0.5) {
        if (this.isMuted) return;

        const sound = this.sounds.get(soundName);
        if (!sound) {
            console.warn(`[音效] 未找到音效: ${soundName}`);
            return;
        }

        try {
            const soundClone = sound.cloneNode();
            soundClone.volume = volume;
            soundClone.play().catch(error => {
                if (error.name !== 'NotAllowedError') {
                    console.warn(`[音效] 播放失败 ${soundName}:`, error);
                }
            });
            soundClone.addEventListener('ended', () => {
                soundClone.remove();
            });
        } catch (error) {
            console.warn(`[音效] 播放出错 ${soundName}:`, error);
        }
    }

    playPoint(volume = 0.5) { this.play('point', volume); }
    playClear(volume = 0.6) { this.play('clear', volume); }
    playSummon(volume = 0.7) { this.play('summon', volume); }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.bgm) this.bgm.volume = this.isMuted ? 0 : 0.5;
        return this.isMuted;
    }

    setMute(muted) {
        this.isMuted = muted;
        if (this.bgm) this.bgm.volume = muted ? 0 : 0.5;
    }

    isLoading() { return !this.isLoaded; }
}

export default AudioManager;