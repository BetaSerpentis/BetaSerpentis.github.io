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

    // iOS 静音开关检测：首次用户手势中创建 AudioContext 测试音频路由
    detectSilentMode() {
        if (this._silentCheckDone) return;
        this._silentCheckDone = true;

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            const ctx = new AC();
            const buf = ctx.createBuffer(1, 1, 22050);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);

            // 播放极短无声片段，检测 iOS 是否因静音开关挂起上下文
            const start = ctx.currentTime;
            src.start(start);
            src.stop(start + 0.001);

            // 延时检查 AudioContext 状态
            setTimeout(() => {
                if (ctx.state === 'suspended') {
                    this._silentModeDetected = true;
                    this.isMuted = true;
                }
                ctx.close().catch(() => {});
            }, 200);
        } catch (e) {
            // 不支持则忽略
        }
    }
}

export default AudioManager;