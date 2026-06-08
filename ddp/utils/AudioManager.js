// utils/AudioManager.js
class AudioManager {
    constructor() {
        this.pools = new Map();       // soundName → Audio[]
        this.poolIdx = new Map();     // soundName → next index
        this.bgm = null;
        this.isMuted = false;
        this.isLoaded = false;
        this.bgmLoopStart = 0;
        this.bgmLoopEnd = 46;
        this.preloadSounds();
    }

    preloadSounds() {
        const POOL_SIZE = 4;
        const audioFiles = {
            'point': './audio/point.mp3',
            'clear': './audio/clear.mp3',
            'summon': './audio/summon.mp3'
        };

        // 为每个音效创建池，显式 load()
        Object.entries(audioFiles).forEach(([key, path]) => {
            const pool = [];
            for (let i = 0; i < POOL_SIZE; i++) {
                const a = new Audio();
                a.src = path;
                a.preload = 'auto';
                a.load();
                pool.push(a);
            }
            this.pools.set(key, pool);
            this.poolIdx.set(key, 0);
        });

        // 预加载 BGM
        this.bgm = new Audio();
        this.bgm.src = './audio/background.mp3';
        this.bgm.preload = 'auto';
        this.bgm.loop = true;
        this.bgm.volume = 0.5;
        this.bgm.load();
        this.bgm.addEventListener('timeupdate', () => {
            if (!this.bgm.paused && this.bgm.currentTime >= this.bgmLoopEnd) {
                this.bgm.currentTime = this.bgmLoopStart;
            }
        });

        // 等待所有池中第一个元素就绪即放行
        const timeout = setTimeout(() => {
            if (!this.isLoaded) { this.isLoaded = true; }
        }, 5000);

        const firsts = [];
        for (const pool of this.pools.values()) firsts.push(pool[0]);
        Promise.all(firsts.map(a => new Promise(resolve => {
            if (a.readyState >= 3) resolve();
            else a.addEventListener('canplaythrough', resolve, { once: true });
        }))).then(() => {
            clearTimeout(timeout);
            this.isLoaded = true;
        }).catch(() => {
            clearTimeout(timeout);
            this.isLoaded = true;
        });
    }

    // 从池中轮询取元素播放，支持重叠音效
    play(soundName, volume = 0.5) {
        if (this.isMuted) return;
        const pool = this.pools.get(soundName);
        if (!pool) return;

        const idx = this.poolIdx.get(soundName) || 0;
        const a = pool[idx];
        this.poolIdx.set(soundName, (idx + 1) % pool.length);

        try {
            a.volume = volume;
            a.currentTime = 0;
            a.play().catch(e => {
                if (e.name !== 'NotAllowedError') {
                    console.warn('[音效] ' + soundName + ' 播放失败:', e);
                }
            });
        } catch (e) {
            console.warn('[音效] ' + soundName + ' 出错:', e);
        }
    }

    playBGM(volume = 0.5) {
        if (this.isMuted || !this.bgm) return;
        this.bgm.volume = volume;
        this.bgm.currentTime = this.bgmLoopStart;
        this.bgm.play().catch(() => {});
    }

    stopBGM() {
        if (this.bgm) { this.bgm.pause(); this.bgm.currentTime = 0; }
    }

    fadeOutBGM(duration = 2000) {
        if (!this.bgm || this.bgm.volume === 0) return;
        const sv = this.bgm.volume, st = performance.now();
        const iv = setInterval(() => {
            const p = Math.min((performance.now() - st) / duration, 1);
            if (this.bgm) this.bgm.volume = sv * (1 - p);
            if (p >= 1) { clearInterval(iv); this.stopBGM(); }
        }, 50);
    }

    fadeInBGM(duration = 2000, targetVolume = 0.5) {
        if (this.isMuted) return;
        this.playBGM(0);
        const st = performance.now();
        const iv = setInterval(() => {
            const p = Math.min((performance.now() - st) / duration, 1);
            if (this.bgm) this.bgm.volume = targetVolume * p;
            if (p >= 1) clearInterval(iv);
        }, 50);
    }

    playPoint(volume = 0.5)  { this.play('point', volume); }
    playClear(volume = 0.6)  { this.play('clear', volume); }
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