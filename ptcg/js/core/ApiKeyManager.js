// ptcg/js/core/ApiKeyManager.js
import { STORAGE_KEYS, CONFIG_AI } from '../utils/constants.js';
import { showToast } from '../utils/helpers.js';

export class ApiKeyManager {
    constructor(storageService) {
        this.storageService = storageService;
        this._apiKey = null;
        this._settingsModal = null;
        this._onKeyChangeCallbacks = [];
        this._loadFromStorage();
    }

    // 从 localStorage 加载 API Key
    _loadFromStorage() {
        try {
            this._apiKey = localStorage.getItem(STORAGE_KEYS.AI_API_KEY) || null;
        } catch (e) {
            this._apiKey = null;
        }
    }

    // 获取 API Key
    getApiKey() {
        return this._apiKey;
    }

    // 是否已设置 API Key
    hasApiKey() {
        return !!this._apiKey && this._apiKey.trim().length > 0;
    }

    // 设置 API Key
    setApiKey(key) {
        const trimmedKey = (key || '').trim();
        if (trimmedKey) {
            this._apiKey = trimmedKey;
            try {
                localStorage.setItem(STORAGE_KEYS.AI_API_KEY, trimmedKey);
            } catch (e) {
                console.error('保存 API Key 失败:', e);
                return false;
            }
        } else {
            this.clearApiKey();
        }
        this._notifyKeyChange();
        return true;
    }

    // 清除 API Key
    clearApiKey() {
        this._apiKey = null;
        try {
            localStorage.removeItem(STORAGE_KEYS.AI_API_KEY);
        } catch (e) {
            // ignore
        }
        this._notifyKeyChange();
    }

    // 注册 Key 变更回调
    onKeyChange(callback) {
        if (typeof callback === 'function') {
            this._onKeyChangeCallbacks.push(callback);
        }
    }

    _notifyKeyChange() {
        this._onKeyChangeCallbacks.forEach(cb => {
            try { cb(this._apiKey); } catch (e) { /* ignore */ }
        });
    }

    // 获取 AI 设置
    getSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.AI_SETTINGS);
            if (raw) {
                return { ...CONFIG_AI, ...JSON.parse(raw) };
            }
        } catch (e) { /* ignore */ }
        return { ...CONFIG_AI };
    }

    // 保存 AI 设置
    saveSettings(settings) {
        try {
            localStorage.setItem(STORAGE_KEYS.AI_SETTINGS, JSON.stringify(settings));
        } catch (e) {
            console.error('保存 AI 设置失败:', e);
        }
    }

    // 显示 API Key 设置弹窗
    showSettingsModal() {
        // 移除旧弹窗
        this.hideSettingsModal();

        const modal = document.createElement('div');
        modal.className = 'api-key-modal';
        modal.innerHTML = `
            <div class="api-key-modal-content">
                <h3 class="api-key-modal-title">设置 API Key</h3>
                <p class="api-key-modal-desc">
                    请输入你的 DeepSeek API Key，用于 AI 卡牌分析功能。<br>
                    Key 仅存储在浏览器本地，不会上传到任何服务器。<br>
                    <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" class="api-key-modal-link">
                        在 platform.deepseek.com 获取 Key →
                    </a>
                </p>
                <div class="api-key-input-wrapper">
                    <input type="password" class="api-key-input"
                           placeholder="sk-..."
                           value="${this._apiKey || ''}"
                           autocomplete="off">
                    <button class="api-key-toggle-vis" title="显示/隐藏">👁</button>
                </div>
                <div class="api-key-error" style="display:none;"></div>
                <div class="api-key-modal-buttons">
                    <button class="api-key-btn api-key-btn-cancel">取消</button>
                    <button class="api-key-btn api-key-btn-save">保存</button>
                </div>
                ${this._apiKey ? '<button class="api-key-btn api-key-btn-clear">清除 Key</button>' : ''}
            </div>
        `;

        document.body.appendChild(modal);
        // 触发动画
        requestAnimationFrame(() => modal.classList.add('active'));

        // 绑定事件
        const input = modal.querySelector('.api-key-input');
        const errorDiv = modal.querySelector('.api-key-error');
        const toggleVis = modal.querySelector('.api-key-toggle-vis');

        // 关闭：点击背景
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideSettingsModal();
        });

        // 取消按钮
        modal.querySelector('.api-key-btn-cancel').addEventListener('click', () => {
            this.hideSettingsModal();
        });

        // 保存按钮
        modal.querySelector('.api-key-btn-save').addEventListener('click', () => {
            const key = input.value.trim();
            if (!key) {
                errorDiv.textContent = '请输入 API Key';
                errorDiv.style.display = 'block';
                return;
            }
            if (!key.startsWith('sk-')) {
                errorDiv.textContent = 'API Key 格式不正确，应以 sk- 开头';
                errorDiv.style.display = 'block';
                return;
            }
            errorDiv.style.display = 'none';
            this.setApiKey(key);
            this.hideSettingsModal();
            this._showToast('✅ API Key 已保存');
        });

        // 清除按钮
        const clearBtn = modal.querySelector('.api-key-btn-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearApiKey();
                this.hideSettingsModal();
                this._showToast('API Key 已清除');
            });
        }

        // 显示/隐藏切换
        toggleVis.addEventListener('click', () => {
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            toggleVis.textContent = isPassword ? '🙈' : '👁';
        });

        // ESC 关闭
        this._escHandler = (e) => {
            if (e.key === 'Escape') this.hideSettingsModal();
        };
        document.addEventListener('keydown', this._escHandler);

        this._settingsModal = modal;
        // 自动聚焦输入框
        setTimeout(() => input.focus(), 100);
    }

    // 隐藏设置弹窗
    hideSettingsModal() {
        if (this._settingsModal) {
            this._settingsModal.classList.remove('active');
            const modal = this._settingsModal;
            setTimeout(() => {
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
            }, 300);
            this._settingsModal = null;
        }
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
    }

    _showToast(message) {
        showToast(message, 'success', 2200);
    }
}
