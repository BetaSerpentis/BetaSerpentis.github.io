// utils/AudioManager.js — Web Audio API 版，原生尊重 iOS 静音开关
class AudioManager {
    constructor() {
        this.ctx = null;            // AudioContext（首次用户手势时创建）
        this.bgmBuffer = null;      // BGM 解码后的 AudioBuffer
        this.bgmSource = null;      // 当前 BGM BufferSourceNode
        this.bgmGain = null;        // BGM 音量控制
        this.bgmStartTime = 0;      // BGM 开始时间（用于暂停恢复）
        this.bgmLoopStart = 0;
        this.bgmLoopEnd = 43;

        this.sfxBuffers = new Map(); // SFX AudioBuffer 缓存
        this.isMuted = false;
        this.isLoaded = false;
        this._unlocked = false;

        this.preloadAll();
    }

    async preloadAll() {
        try {
            // 预加载所有音频文件为 ArrayBuffer
            const files = {
                bgm:    './audio/background.mp3',
                point:  './audio/point.mp3',
                clear:  './audio/clear.mp3',
                summon: './audio/summon.mp3'
            };

            const entries = Object.entries(files);
            const results = await Promise.all(entries.map(([key, url]) =>
                fetch(url).then(r => r.arrayBuffer()).then(buf => ({ key, buf }))
            ));

            // AudioContext 在用户手势中创建，这里先存原始数据
            this._pendingBuffers = {};
            for (const { key, buf } of results) {
                this._pendingBuffers[key] = buf;
            }
            this.isLoaded = true;
        } catch (e) {
            console.warn('[音频] 预加载失败:', e);
            this.isLoaded = true;
        }
    }

    // 同步创建 AudioContext（必须在用户手势内执行）
    _ensureContext() {
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = 0.5;
        this.bgmGain.connect(this.ctx.destination);
        // 异步解码预加载的音频
        this._decodePending();
    }

    async _decodePending() {
        if (!this._pendingBuffers) return;
        const pending = this._pendingBuffers;
        this._pendingBuffers = null;
        for (const [key, buf] of Object.entries(pending)) {
            try {
                const audioBuf = await this.ctx.decodeAudioData(buf.slice(0));
                if (key === 'bgm') {
                    this.bgmBuffer = audioBuf;
                } else {
                    this.sfxBuffers.set(key, audioBuf);
                }
            } catch (e) {
                console.warn('[音频] 解码失败:', key, e);
            }
        }
    }

    // BGM 播放 — 通过 AudioContext，原生受 iOS 静音控制
    playBGM(volume = 0.5) {
        if (this.isMuted) return;
        this._ensureContext();
        if (!this.bgmBuffer) {
            // 解码未完成，等解码结束后自动播放
            this._bgmPendingVolume = volume;
            return;
        }
        this._stopBGM();
        this.bgmGain.gain.value = volume;
        const src = this.ctx.createBufferSource();
        src.buffer = this.bgmBuffer;
        src.loop = true;
        src.loopStart = this.bgmLoopStart;
        src.loopEnd = this.bgmLoopEnd;
        src.connect(this.bgmGain);
        src.start(0);
        this.bgmSource = src;
    }

    // 解码完成后尝试补播 BGM
    async _decodePending() {
        if (!this._pendingBuffers) return;
        const pending = this._pendingBuffers;
        this._pendingBuffers = null;
        for (const [key, buf] of Object.entries(pending)) {
            try {
                const audioBuf = await this.ctx.decodeAudioData(buf.slice(0));
                if (key === 'bgm') {
                    this.bgmBuffer = audioBuf;
                } else {
                    this.sfxBuffers.set(key, audioBuf);
                }
            } catch (e) {
                console.warn('[音频] 解码失败:', key, e);
            }
        }
        // 如果 BGM 在解码完成前就请求播放，现在补播
        if (this._bgmPendingVolume !== undefined && this.bgmBuffer && !this.bgmSource) {
            const vol = this._bgmPendingVolume;
            this._bgmPendingVolume = undefined;
            this.playBGM(vol);
        }
    }

    _stopBGM() {
        if (this.bgmSource) {
            try { this.bgmSource.stop(); } catch (e) { /* already stopped */ }
            this.bgmSource = null;
        }
    }

    stopBGM() {
        this._stopBGM();
        this.bgmStartTime = 0;
    }

    fadeOutBGM(duration = 2000) {
        if (!this.bgmGain || this.bgmGain.gain.value === 0) return;
        const sv = this.bgmGain.gain.value;
        const st = performance.now();
        const iv = setInterval(() => {
            const p = Math.min((performance.now() - st) / duration, 1);
            if (this.bgmGain) this.bgmGain.gain.value = sv * (1 - p);
            if (p >= 1) { clearInterval(iv); this.stopBGM(); }
        }, 50);
    }

    fadeInBGM(duration = 2000, targetVolume = 0.5) {
        if (this.isMuted) return;
        this.playBGM(0);
        if (!this.bgmGain) return;
        this.bgmGain.gain.value = 0;
        const st = performance.now();
        const iv = setInterval(() => {
            const p = Math.min((performance.now() - st) / duration, 1);
            if (this.bgmGain) this.bgmGain.gain.value = targetVolume * p;
            if (p >= 1) clearInterval(iv);
        }, 50);
    }

    // SFX 播放 — 通过 AudioContext，同受 iOS 静音控制
    _playSFX(name, volume = 0.5) {
        if (this.isMuted) return;
        const buf = this.sfxBuffers.get(name);
        if (!buf) return;
        this._ensureContext();
        if (!this.ctx) return;

        const src = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        gain.gain.value = volume;
        src.buffer = buf;
        src.connect(gain);
        gain.connect(this.ctx.destination);
        src.start(0);
    }

    playPoint(volume = 0.5)  { this._playSFX('point', volume); }
    playClear(volume = 0.6)  { this._playSFX('clear', volume); }
    playSummon(volume = 0.7) { this._playSFX('summon', volume); }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.bgmGain) this.bgmGain.gain.value = this.isMuted ? 0 : 0.5;
        return this.isMuted;
    }
    setMute(muted) {
        this.isMuted = muted;
        if (this.bgmGain) this.bgmGain.gain.value = muted ? 0 : 0.5;
    }
    isLoading() { return !this.isLoaded; }
}

export default AudioManager;