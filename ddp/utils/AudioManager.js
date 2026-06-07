// utils/AudioManager.js
class AudioManager {
    constructor() {
        // 每个音效预创建 2 个实例组成池，支持重叠播放
        this.soundPools = new Map();
        this.poolIndexes = new Map();
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
        const POOL_SIZE = 2;

        Object.entries(audioFiles).forEach(([key, path]) => {
            const pool = [];
            for (let i = 0; i < POOL_SIZE; i++) {
                const audio = new Audio();
                audio.src = path;
                audio.preload = 'auto';
                audio.volume = 0.5;
                pool.push(audio);
            }
            this.soundPools.set(key, pool);
            this.poolIndexes.set(key, 0);
        });

        // 预加载 BGM
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

        // 超时兜底：5 秒后标记已加载
        const markLoaded = setTimeout(() => {
            if (!this.isLoaded) {
                this.isLoaded = true;
                console.log('[音效] 加载超时兜底');
            }
        }, 5000);

        // 等待所有池中第一个元素就绪即标记可播放
        const firstElements = [];
        for (const [key, pool] of this.soundPools) {
            firstElements.push(pool[0]);
        }
        Promise.all(
            firstElements.map(audio => new Promise(resolve => {
                if (audio.readyState >= 3) resolve();
                else audio.addEventListener('canplaythrough', resolve, { once: true });
            }))
        ).then(() => {
            clearTimeout(markLoaded);
            this.isLoaded = true;
            console.log('[音效] 音效池就绪');
        }).catch(() => {
            clearTimeout(markLoaded);
            this.isLoaded = true;
        });
    }

    // 从池中取一个空闲元素播放，支持重叠音效
    play(soundName, volume = 0.5) {
        if (this.isMuted) return;

        const pool = this.soundPools.get(soundName);
        if (!pool || pool.length === 0) return;

        // 轮询取下一个元素
        let idx = this.poolIndexes.get(soundName) || 0;
        const audio = pool[idx];
        idx = (idx + 1) % pool.length;
        this.poolIndexes.set(soundName, idx);

        try {
            audio.volume = volume;
            audio.currentTime = 0;
            audio.play().catch(error => {
                if (error.name !== 'NotAllowedError') {
                    console.warn(`[音效] 播放失败 ${soundName}:`, error);
                }
            });
        } catch (error) {
            console.warn(`[音效] 播放出错 ${soundName}:`, error);
        }
    }

    // BGM 播放
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