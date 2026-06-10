// utils/AudioManager.js
class AudioManager {
    constructor() {
        this.sounds = new Map();
        this.bgm = null;
        this.isMuted = false;
        this._silentModeDetected = false;
        this._silentCheckDone = false;
        this.isLoaded = false;
        this._waiting = new Set();
        this.preloadSounds();
    }

    preloadSounds() {
        const audioFiles = {
            'point':  './audio/point.mp3',
            'clear':  './audio/clear.mp3',
            'summon': './audio/summon.mp3'
        };

        Object.entries(audioFiles).forEach(([key, path]) => {
            const a = new Audio();
            a.src = path;
            a.preload = 'auto';
            a.load();
            this.sounds.set(key, a);
        });

        // BGM — 用原生 loop 属性自然循环，结束自动重播
        this.bgm = new Audio();
        this.bgm.src = './audio/background.mp3';
        this.bgm.preload = 'auto';
        this.bgm.loop = true;
        this.bgm.volume = 0.5;
        this.bgm.load();

        // 轮询等待所有音效就绪（iOS 上 canplaythrough 可能不可靠）
        const maxWait = 15000;
        const start = Date.now();
        const check = () => {
            const all = [...this.sounds.values()];
            if (all.every(a => a.readyState >= 3) || Date.now() - start > maxWait) {
                this.isLoaded = true;
                return;
            }
            setTimeout(check, 300);
        };
        check();
    }

    // 播放音效 — 等就绪后触发
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
        } else if (!this._waiting.has(soundName)) {
            // 未就绪，注册一次性监听
            this._waiting.add(soundName);
            const onReady = () => {
                this._waiting.delete(soundName);
                a.removeEventListener('canplaythrough', onReady);
                doPlay();
            };
            a.addEventListener('canplaythrough', onReady, { once: false });
        }
    }

    playBGM(volume = 0.5) {
        if (this.isMuted || !this.bgm) return;
        this.bgm.volume = volume;
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

    // 解锁 iOS 音频上下文（在用户手势中调用一次）
    _unlockAudio() {
        if (this._unlocked) return;
        this._unlocked = true;
        // 静默 play() 解锁浏览器音频策略
        const u = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        u.volume = 0.001;
        u.play().catch(() => {}).then(() => u.remove());
    }

    // 播放音效 — 延迟到手势外执行，确保 iOS 尊重静音开关
    _playDeferred(soundName, volume) {
        setTimeout(() => this.play(soundName, volume), 50);
    }

    playPoint(volume = 0.5)  { this._playDeferred('point', volume); }
    playClear(volume = 0.6)  { this._playDeferred('clear', volume); }
    playSummon(volume = 0.7) { this._playDeferred('summon', volume); }
}

export default AudioManager;