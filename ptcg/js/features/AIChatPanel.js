// ptcg/js/features/AIChatPanel.js
import { showToast } from '../utils/helpers.js';

export class AIChatPanel {
    constructor(aiChatService, deckManager, cardManager, imageLoader, apiKeyManager) {
        this.aiChatService = aiChatService;
        this.deckManager = deckManager;
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.apiKeyManager = apiKeyManager;
        this.panel = null;
        this.overlay = null;
        this.messagesContainer = null;
        this.inputArea = null;
        this.sendButton = null;
        this.isVisible = false;
        this.isLoading = false;
        this._currentAIMessageEl = null;
        this._currentAIMessageText = '';
        this._pendingDeck = null;
    }

    init() {
        this._createDOM();
        this._bindEvents();
    }

    _createDOM() {
        // 背景遮罩
        this.overlay = document.createElement('div');
        this.overlay.className = 'ai-chat-overlay';
        this.overlay.addEventListener('click', () => this.hide());
        document.body.appendChild(this.overlay);

        // 面板
        this.panel = document.createElement('div');
        this.panel.className = 'ai-chat-panel';
        this.panel.innerHTML = `
            <div class="ai-chat-header">
                <span class="ai-chat-title">AI 卡牌助手</span>
                <div class="ai-chat-header-buttons">
                    <button class="ai-chat-btn ai-chat-btn-settings" title="API Key 设置">⚙</button>
                    <button class="ai-chat-btn ai-chat-btn-new-chat" title="新对话">+</button>
                    <button class="ai-chat-btn ai-chat-btn-close" title="关闭">✕</button>
                </div>
            </div>
            <div class="ai-chat-messages">
                <div class="ai-chat-welcome">
                    <div class="ai-chat-welcome-icon">🤖</div>
                    <h3>AI 卡牌分析助手</h3>
                    <p>我可以帮你：</p>
                    <ul>
                        <li>🔍 分析卡牌强度与用法</li>
                        <li>🧩 推荐卡组构筑方案</li>
                        <li>📊 评估对局优劣势</li>
                        <li>💡 提供战术与组合建议</li>
                    </ul>
                    <p class="ai-chat-welcome-hint">试着问我：「帮我组一套喷火龙ex卡组」</p>
                </div>
            </div>
            <div class="ai-chat-input-area">
                <textarea class="ai-chat-input"
                    placeholder="输入你的问题，如：分析一下沙奈朵ex为什么强？"
                    rows="1"
                    maxlength="2000"></textarea>
                <button class="ai-chat-send-btn" title="发送">▶</button>
            </div>
            <div class="ai-chat-error-bar" style="display:none;"></div>
        `;
        document.body.appendChild(this.panel);

        // 缓存 DOM 引用
        this.messagesContainer = this.panel.querySelector('.ai-chat-messages');
        this.inputArea = this.panel.querySelector('.ai-chat-input');
        this.sendButton = this.panel.querySelector('.ai-chat-send-btn');
        this._errorBar = this.panel.querySelector('.ai-chat-error-bar');

        // 设置按钮
        this.panel.querySelector('.ai-chat-btn-settings').addEventListener('click', () => {
            this.apiKeyManager.showSettingsModal();
        });

        // 新对话按钮
        this.panel.querySelector('.ai-chat-btn-new-chat').addEventListener('click', () => {
            this._clearChat();
        });
    }

    _bindEvents() {
        // 关闭按钮
        this.panel.querySelector('.ai-chat-btn-close').addEventListener('click', () => {
            this.hide();
        });

        // 发送按钮
        this.sendButton.addEventListener('click', () => this._handleSend());

        // 回车发送，Shift+Enter 换行
        this.inputArea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._handleSend();
            }
        });

        // 自动调整输入框高度
        this.inputArea.addEventListener('input', () => {
            this.inputArea.style.height = 'auto';
            this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 120) + 'px';
        });

        // ESC 关闭面板
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    // 显示面板
    show() {
        if (this.isVisible) return;
        this.isVisible = true;
        this.overlay.classList.add('active');
        this.panel.classList.add('active');
        document.body.style.overflow = 'hidden';
        setTimeout(() => this.inputArea.focus(), 350);
    }

    // 隐藏面板
    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;
        this.overlay.classList.remove('active');
        this.panel.classList.remove('active');
        document.body.style.overflow = '';
    }

    // 切换显示
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            // 检查 API Key
            if (!this.apiKeyManager.hasApiKey()) {
                this.apiKeyManager.showSettingsModal();
                // 延迟显示面板，让设置弹窗先出现
                // 如果用户设置了 key，面板自动显示
                const onKeySet = () => {
                    if (this.apiKeyManager.hasApiKey()) {
                        this.show();
                    }
                };
                // 监听设置弹窗关闭
                const checkInterval = setInterval(() => {
                    if (!document.querySelector('.api-key-modal')) {
                        clearInterval(checkInterval);
                        onKeySet();
                    }
                }, 200);
                return;
            }
            this.show();
        }
    }

    // 处理发送
    async _handleSend() {
        const message = this.inputArea.value.trim();
        if (!message || this.isLoading) return;

        // 清空输入
        this.inputArea.value = '';
        this.inputArea.style.height = 'auto';

        // 隐藏欢迎消息
        const welcome = this.messagesContainer.querySelector('.ai-chat-welcome');
        if (welcome) welcome.style.display = 'none';

        // 隐藏错误
        this._hideError();

        // 渲染用户消息
        this._addUserMessage(message);

        // 创建 AI 消息占位
        this._currentAIMessageEl = this._addAIMessagePlaceholder();
        this._currentAIMessageText = '';
        this._pendingDeck = null;

        // 设为 loading 状态
        this.isLoading = true;
        this.sendButton.disabled = true;
        this.inputArea.disabled = true;

        // 调用 AI
        await this.aiChatService.sendMessage(
            message,
            // onChunk
            (chunk, fullText) => {
                this._currentAIMessageText = fullText;
                this._updateAIMessage(this._currentAIMessageEl, fullText);
            },
            // onComplete
            (fullText, deck) => {
                this._updateAIMessage(this._currentAIMessageEl, fullText);
                if (deck) {
                    this._pendingDeck = deck;
                    this._renderDeckPreview(deck);
                }
                this._finishLoading();
            },
            // onError
            (error) => {
                if (error.message === 'NO_API_KEY') {
                    this._removeLastAIMessage();
                    this._showError('请先设置 API Key');
                    this.apiKeyManager.showSettingsModal();
                } else {
                    this._updateAIMessage(this._currentAIMessageEl,
                        this._currentAIMessageText || error.message);
                    this._showError(error.message);
                }
                this._finishLoading();
            }
        );
    }

    _finishLoading() {
        this.isLoading = false;
        this.sendButton.disabled = false;
        this.inputArea.disabled = false;
        this._currentAIMessageEl = null;
        setTimeout(() => this.inputArea.focus(), 100);
    }

    // ---- 消息渲染 ----

    _addUserMessage(text) {
        const el = document.createElement('div');
        el.className = 'ai-message ai-message-user';
        el.innerHTML = `<div class="ai-message-bubble">${this._escapeHtml(text)}</div>`;
        this.messagesContainer.appendChild(el);
        this._scrollToBottom();
        return el;
    }

    _addAIMessagePlaceholder() {
        const el = document.createElement('div');
        el.className = 'ai-message ai-message-assistant';
        el.innerHTML = `
            <div class="ai-message-bubble">
                <span class="ai-typing-indicator">
                    <span></span><span></span><span></span>
                </span>
            </div>
        `;
        this.messagesContainer.appendChild(el);
        this._scrollToBottom();
        return el;
    }

    _updateAIMessage(el, text) {
        if (!el) return;
        const bubble = el.querySelector('.ai-message-bubble');
        if (!bubble) return;

        // 渲染 Markdown
        bubble.innerHTML = this._renderMarkdown(text);
        this._scrollToBottom();
    }

    _removeLastAIMessage() {
        const messages = this.messagesContainer.querySelectorAll('.ai-message-assistant');
        const last = messages[messages.length - 1];
        if (last) last.remove();
    }

    // 渲染卡组预览
    _renderDeckPreview(deck) {
        if (!this._currentAIMessageEl || !deck.cards.length) return;

        const preview = document.createElement('div');
        preview.className = 'ai-deck-preview';

        const cardThumbs = deck.cards.slice(0, 12).map(card => {
            const imgSrc = card.image || this.cardManager.generateDefaultImage(card.id);
            return `
                <div class="ai-deck-card-thumb" title="${this._escapeHtml(card.name)}">
                    <img src="${imgSrc}" alt="${this._escapeHtml(card.name)}" loading="lazy"
                         onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                    <span class="ai-deck-card-fallback" style="display:none;">${this._escapeHtml(card.name).slice(0, 4)}</span>
                    <span class="ai-deck-card-qty">×${card.quantity}</span>
                </div>
            `;
        }).join('');

        const extraCount = deck.cards.length > 12 ? deck.cards.length - 12 : 0;

        preview.innerHTML = `
            <div class="ai-deck-preview-header">
                <span class="ai-deck-preview-name">📋 ${this._escapeHtml(deck.name)}</span>
                <span class="ai-deck-preview-count">${deck.totalCount}/60 张 · ${deck.cards.length} 种</span>
            </div>
            <div class="ai-deck-preview-cards">
                ${cardThumbs}
                ${extraCount > 0 ? `<div class="ai-deck-card-more">+${extraCount}</div>` : ''}
            </div>
            ${deck.invalidCards && deck.invalidCards.length > 0 ? `
                <div class="ai-deck-preview-warning">
                    ⚠ ${deck.invalidCards.length} 张卡牌 ID 在数据库中未找到，已自动移除
                </div>
            ` : ''}
            <button class="ai-deck-import-btn">📥 导入到我的卡组</button>
        `;

        // 导入按钮事件
        preview.querySelector('.ai-deck-import-btn').addEventListener('click', () => {
            this._importDeckToCollection(deck);
        });

        this._currentAIMessageEl.appendChild(preview);
        this._scrollToBottom();
    }

    // 导入卡组到收藏
    async _importDeckToCollection(deck) {
        try {
            const newDeck = this.deckManager.createNewDeck();
            newDeck.name = deck.name || 'AI 推荐卡组';
            if (deck.cards.length > 0) newDeck.coverCardId = deck.cards[0].id;

            // 确保数据已加载
            if (typeof this.aiChatService.ensureDataLoaded === 'function') {
                await this.aiChatService.ensureDataLoaded();
            }

            // 优先用 AI 服务的全局 JSON 缓存验证（跨所有卡牌类型）
            const jsonCache = this.aiChatService._data?._jsonCache;
            const allCardsCache = this.cardManager.allCardsCache || [];

            for (const card of deck.cards) {
                const cid = String(card.id);
                let cardInfo = null;

                if (jsonCache && jsonCache.has(cid)) {
                    const jd = jsonCache.get(cid);
                    cardInfo = {
                        id: cid,
                        name: jd['宝可梦名字'] || jd['卡牌名字'] || cid,
                        image: `images/hk${cid.padStart(8, '0')}.webp`,
                        type: jd['宝可梦名字'] ? '宝可梦' : (jd['卡牌类型'] || '').replace('卡', ''),
                        number: jd['编号'] || ''
                    };
                } else {
                    const baseInfo = this.cardManager.getCardBaseInfo(cid);
                    if (baseInfo && baseInfo.name && !baseInfo.name.startsWith('卡牌 ')) {
                        const cacheCard = allCardsCache.find(c => c.id === cid);
                        cardInfo = {
                            id: cid,
                            name: baseInfo.name,
                            image: baseInfo.image,
                            type: baseInfo.type || '未知',
                            number: (cacheCard && cacheCard.number) || ''
                        };
                    }
                }

                if (cardInfo) {
                    newDeck.cards.push({ ...cardInfo, quantity: card.quantity });
                }
            }

            this.deckManager.sortDeckCards(newDeck);
            newDeck.totalCount = newDeck.cards.reduce((sum, c) => sum + c.quantity, 0);
            this.deckManager.saveDecks();

            showToast(`✅ 已导入卡组「${deck.name}」，共 ${newDeck.totalCount} 张`, 'success', 2500);

        } catch (e) {
            showToast('❌ 导入失败，请重试', 'error', 2500);
            console.error('导入卡组失败:', e);
        }
    }

    // ---- 工具方法 ----

    _clearChat() {
        this.aiChatService.clearHistory();
        this.messagesContainer.innerHTML = `
            <div class="ai-chat-welcome">
                <div class="ai-chat-welcome-icon">🤖</div>
                <h3>AI 卡牌分析助手</h3>
                <p>新对话已开始，有什么可以帮你的？</p>
            </div>
        `;
        this._hideError();
    }

    _scrollToBottom() {
        requestAnimationFrame(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        });
    }

    _showError(message) {
        console.error('[AI Panel Error]', message);
        this._errorBar.textContent = message;
        this._errorBar.style.display = 'block';
        // 不自动消失，用户发送新消息时才会清除
    }

    _hideError() {
        this._errorBar.style.display = 'none';
    }



    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 简单的 Markdown → HTML 渲染
    _renderMarkdown(text) {
        if (!text) return '';

        // 代码块占位符（在转义前处理）
        const codeBlocks = [];
        const CB = '<!--CB-->';
        let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push(`<pre><code>${this._escapeHtml(code)}</code></pre>`);
            return `${CB}${idx}${CB}`;
        });

        // 行内代码占位符
        const inlineCodes = [];
        const IC = '<!--IC-->';
        processed = processed.replace(/`([^`]+)`/g, (_, code) => {
            const idx = inlineCodes.length;
            inlineCodes.push(`<code>${this._escapeHtml(code)}</code>`);
            return `${IC}${idx}${IC}`;
        });

        // 转义剩余文本
        let html = this._escapeHtml(processed);

        // 粗体
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // 斜体
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // 标题
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

        // 无序列表
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

        // 有序列表
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // 换行
        html = html.replace(/\n\n/g, '<br><br>');
        html = html.replace(/\n/g, '<br>');

        // 恢复代码块（占位符在转义后变成 &lt;!--CB--&gt; 的形式）
        html = html.replace(/&lt;!--CB--&gt;(\d+)&lt;!--CB--&gt;/g, (_, idx) => codeBlocks[parseInt(idx)] || '');
        html = html.replace(/&lt;!--IC--&gt;(\d+)&lt;!--IC--&gt;/g, (_, idx) => inlineCodes[parseInt(idx)] || '');

        return html;
    }
}
