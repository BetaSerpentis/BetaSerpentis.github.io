// utils/AudioManager.js
class AudioManager {
    constructor() {
        this.sounds = new Map();
        this.bgm = null;
        this.isMuted = false;
        this.isLoaded = false;
        this.bgmLoopStart = 0;
        this.bgmLoopEnd = 43;
        this.preloadSounds();
    }

    preloadSounds() {
        const audioFiles = {
            'point':  './audio/point.mp3',
            'clear':  './audio/clear.mp3',
            'summon': './audio/summon.mp3'
        };

        // 每个音效只创建一个元素，显式 load()
        Object.entries(audioFiles).forEach(([key, path]) => {
            const a = new Audio();
            a.src = path;
            a.preload = 'auto';
            a.load();
            this.sounds.set(key, a);
        });

        // BGM
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

        // 等音效就绪（10 秒超时兜底）
        const timeout = setTimeout(() => { this.isLoaded = true; }, 10000);
        const elements = [...this.sounds.values()];
        Promise.all(elements.map(a => new Promise(resolve => {
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

    // 播放音效 — 未就绪则等加载完成后播放
    play(soundName, volume = 0.5) {
        if (this.isMuted) return;
        const a = this.sounds.get(soundName);
        if (!a) return;

        const doPlay = () => {
            try {
                if (!a.paused) a.currentTime = 0;
                a.volume = volume;
                a.play().catch(() => {});
            } catch (e) { /* silence */ }
        };

        if (a.readyState >= 2) {
            doPlay();
        } else {
            // 元素未就绪，等加载完成后播放
            a.addEventListener('canplaythrough', doPlay, { once: true });
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