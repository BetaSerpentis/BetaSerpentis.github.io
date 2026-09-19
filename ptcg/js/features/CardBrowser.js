export class CardBrowser {
    constructor(cardManager, imageLoader, cardGrid, modalView, statsManager, searchEngine) {
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.cardGrid = cardGrid;
        this.modalView = modalView;
        this.statsManager = statsManager;
        this.searchEngine = searchEngine;
        
        this.searchInput = document.getElementById('search-input');
        this.searchButton = document.getElementById('search-button');
        this.loadingStatus = document.getElementById('loading-status');
        this.aiToggleButton = document.getElementById('ai-search-toggle');

        // AI 辅助搜索：{ engine: CardQueryEngine, parser: SearchIntentParser }
        // 由 main.js 注入。AI 只负责把自然语言翻译成结构化条件，
        // 筛选由 CardQueryEngine 在本地确定性执行。
        this.semanticSearch = null;
        this.aiSearchEnabled = false;
        this._AI_SEARCH_STORAGE_KEY = 'ptcg_ai_search_enabled';
        
        this.init();
    }

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this._restoreAiSearchState();
        this.bindEvents();
    }

    /** 注入语义搜索依赖（main.js 在创建后调用） */
    setSemanticSearch(deps) {
        this.semanticSearch = deps || null;
        // 只注册一次：用户在弹窗里保存 Key 之后自动把开关点亮
        const mgr = deps && deps.apiKeyManager;
        if (mgr && typeof mgr.onKeyChange === 'function' && !this._apiKeyListenerBound) {
            this._apiKeyListenerBound = true;
            mgr.onKeyChange(key => {
                if (key && this._pendingAiEnable) {
                    this._pendingAiEnable = false;
                    this._setAiEnabled(true);
                    this.cardGrid.updateSearchInfo('API Key 已保存，AI 辅助已开启');
                }
                this._syncAiToggle();
            });
        }
        this._syncAiToggle();
    }

    /** 是否已配置 API Key（没有的话 AI 辅助无法工作，需要先让用户输入） */
    _hasApiKey() {
        const mgr = this.semanticSearch && this.semanticSearch.apiKeyManager;
        if (!mgr) return false;
        try {
            return typeof mgr.getApiKey === 'function' ? !!mgr.getApiKey() : false;
        } catch (e) {
            return false;
        }
    }

    _setAiEnabled(enabled) {
        this.aiSearchEnabled = !!enabled;
        try {
            localStorage.setItem(this._AI_SEARCH_STORAGE_KEY, this.aiSearchEnabled ? '1' : '0');
        } catch (e) { /* 忽略隐私模式等写入失败 */ }
        this._syncAiToggle();
    }

    _restoreAiSearchState() {
        try {
            this.aiSearchEnabled = localStorage.getItem(this._AI_SEARCH_STORAGE_KEY) === '1';
        } catch (e) {
            this.aiSearchEnabled = false;
        }
        // 没有 Key 时开了也没用，先按关闭显示（Key 保存后由监听自动点亮）
        if (this.aiSearchEnabled && this.semanticSearch && !this._hasApiKey()) {
            this.aiSearchEnabled = false;
        }
        this._syncAiToggle();
    }

    _syncAiToggle() {
        const btn = this.aiToggleButton;
        if (!btn) return;
        btn.setAttribute('aria-checked', this.aiSearchEnabled ? 'true' : 'false');
        const ready = !!this.semanticSearch;
        btn.disabled = !ready || this._aiBusy;
        if (!ready) {
            btn.title = 'AI 辅助暂不可用（缺少组件）';
        } else if (this.aiSearchEnabled) {
            btn.title = 'AI 辅助已开启：点搜索会先把你的描述解析成条件再筛选';
        } else {
            btn.title = 'AI 辅助：用自然语言描述条件（如「环境内需要1能就能使用招式的2阶进化宝可梦」）';
        }
    }

    _toggleAiSearch() {
        if (this.aiSearchEnabled) {
            this._setAiEnabled(false);
            return;
        }
        // 开启前必须有 API Key；没有就弹出输入框，保存后由监听自动点亮
        if (this.semanticSearch && !this._hasApiKey()) {
            const mgr = this.semanticSearch.apiKeyManager;
            if (mgr && typeof mgr.showSettingsModal === 'function') {
                this._pendingAiEnable = true;
                mgr.showSettingsModal();
                this.cardGrid.updateSearchInfo('AI 辅助需要 API Key：请在弹出的窗口里填写，保存后会自动开启');
                this._syncAiToggle();
                return;
            }
            this.cardGrid.updateSearchInfo('AI 辅助需要先配置 API Key');
            return;
        }
        this._setAiEnabled(true);
    }

    // 只绑定搜索相关事件；卡牌点击由 main.js 统一处理
    bindEvents() {
        this.searchButton?.addEventListener('click', () => {
            this.performSearch();
        });

        this.searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });

        this.aiToggleButton?.addEventListener('click', () => {
            this._toggleAiSearch();
        });
    }

    // CardBrowser.js - 修复 handleCardClick 方法
    handleCardClick(index, button) {
        // console.log('📱 CardBrowser: 卡牌点击事件');
        // console.log('索引:', index, '按钮:', button, '统计模式:', this.statsManager.isStatModeActive());
        
        // 统计模式处理 - 最高优先级
        if (this.statsManager.isStatModeActive()) {
            // console.log('📊 CardBrowser: 统计模式处理');
            
            const cards = this.cardManager.getDisplayCards();
            if (index < 0 || index >= cards.length) {
                // console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            // console.log('📊 操作卡牌:', card.name, '当前数量:', card.quantity);
            
            if (button === 'left') {
                // 左键：增加数量
                // console.log('➕ 增加数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, 1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            } else if (button === 'right') {
                // 右键：减少数量
                // console.log('➖ 减少数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, -1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            }
            return;
        }
        
        // 正常模式：打开模态框
        // console.log('🌐 正常模式 - 打开模态框');
        this.modalView.show(index);
    }

    // 处理数量变化
    handleQuantityChange(index, change) {
        if (!this.statsManager.isStatModeActive()) return;
        
        const result = this.statsManager.updateCardQuantity(index, change);
        if (result) {
            this.cardGrid.updateCardQuantityDisplay(result.cardId, result.quantity);
        }
    }

    // 执行搜索（更新以考虑世代筛选）
    async performSearch() {
        const searchText = this.searchInput.value;

        // AI 辅助模式：先解析成结构化条件，再本地筛选；解析失败则回退关键词搜索
        if (this.aiSearchEnabled && searchText.trim() && this.semanticSearch) {
            const ok = await this._performSemanticSearch(searchText);
            if (ok) return;
        }

        const searchResult = this.searchEngine.performSearch(searchText);
        
        // 显示搜索和筛选的综合结果
        const generation = this.cardManager.getCurrentGeneration();
        const generationName = this.cardManager.getGenerationName(generation);
        
        let message = searchResult.message;
        
        // 如果是宝可梦类型且应用了世代筛选，添加世代信息
        if (this.cardManager.getCurrentTab() === '宝可梦' && generation !== 'all') {
            message = `在${generationName}中${searchResult.message.includes('显示全部') ? '显示全部' : '搜索'}: ${searchResult.cards.length} 张`;
        }
        
        this.cardGrid.updateSearchInfo(message);
        this.cardGrid.render();
    }

    /**
     * AI 辅助搜索：把自然语言解析成结构化条件 → CardQueryEngine 本地筛选。
     * @returns {Promise<boolean>} true 表示已处理（调用方不要再走关键词搜索）
     */
    async _performSemanticSearch(searchText) {
        const { engine, parser } = this.semanticSearch;
        if (!engine || !parser) return false;
        this._setAiBusy(true);
        try {
            const parsed = await parser.parse(searchText);
            if (!parsed) {
                this.cardGrid.updateSearchInfo('AI 解析失败（或未配置 API Key），已回退为普通关键词搜索');
                return false;
            }
            await engine.load();

            const conds = { ...parsed.conditions };
            const currentTab = this.cardManager.getCurrentTab();
            let tabHint = '';
            if (!conds.types) {
                // 没指明类型时，按当前页签收敛，避免结果跨类型混在同一个列表里
                conds.types = [currentTab];
                tabHint = `（未指明类型，按当前页签「${currentTab}」）`;
            } else if (!conds.types.includes(currentTab)) {
                tabHint = `（结果含 ${conds.types.join('/')}，与当前页签「${currentTab}」不同）`;
            }

            const cards = engine.query(conds);
            // setExternalFilter 会按 id 映射回当前已加载的完整卡片对象（渲染需要 image/quantity），
            // 并返回实际能显示的列表；映射不到的多半是当前页签没加载的类型。
            const shown = this.cardManager.setExternalFilter(cards);
            const dropped = this.cardManager._lastExternalFilterMissing || 0;
            const desc = this._describeConditions(conds);
            const dropHint = dropped
                ? `（另有 ${dropped} 张属于其它类型，切到对应页签后再搜可见）`
                : '';
            this.cardGrid.updateSearchInfo(`AI 解析出条件：${desc} ${tabHint} → ${shown.length} 张${dropHint}`);
            this.cardGrid.render();
            return true;
        } catch (e) {
            this.cardGrid.updateSearchInfo(`AI 搜索出错，已回退为普通关键词搜索：${e?.message || e}`);
            return false;
        } finally {
            this._setAiBusy(false);
        }
    }

    _setAiBusy(busy) {
        const btn = this.aiToggleButton;
        this._aiBusy = !!busy;
        if (!btn) return;
        btn.classList.toggle('busy', this._aiBusy);
        btn.disabled = this._aiBusy || !this.semanticSearch;
    }

    /** 把条件对象翻译成可读文本（让用户能核对 AI 解析得对不对） */
    _describeConditions(c) {
        const parts = [];
        if (c.types?.length) parts.push(`类型=${c.types.join('/')}`);
        if (c.stage !== undefined) parts.push(`阶段=${['基础', '1阶进化', '2阶进化'][c.stage] || c.stage}`);
        if (c.retreat) parts.push(`撤退${c.retreat.op}${c.retreat.value}`);
        if (c.hp) parts.push(`HP${c.hp.op}${c.hp.value}`);
        if (c.attr) parts.push(`属性=${c.attr}`);
        if (c.env) parts.push('仅当前环境');
        if (c.attackCostExactly !== undefined) parts.push(`招式恰好${c.attackCostExactly}能`);
        if (c.attackCostAtMost !== undefined) parts.push(`招式≤${c.attackCostAtMost}能`);
        if (c.keyword) parts.push(`名称含「${c.keyword}」`);
        const kwList = v => Array.isArray(v) ? v.join('或') : v;
        if (c.abilityName) parts.push(`特性名含「${kwList(c.abilityName)}」`);
        if (c.abilityText) parts.push(`特性内容含「${kwList(c.abilityText)}」`);
        if (c.attackText) parts.push(`招式内容含「${kwList(c.attackText)}」`);
        if (c.textAny) parts.push(`效果内容含「${kwList(c.textAny)}」`);
        return parts.length ? parts.join('、') : '（无条件，显示当前页签全部）';
    }

    // 在 CardBrowser.js 中确保 loadCardData 方法正确重置状态
    async loadCardData(cardType) {
        // console.log(`🔄 CardBrowser: 加载 ${cardType} 数据`);

        this.cardGrid.showLoading();
        if (this.loadingStatus) this.loadingStatus.textContent = `正在加载${cardType}数据...`;

        try {
            // 先加载 idx 索引完成首屏渲染，再后台补 search/filter。
            await this.cardManager.loadCardData(cardType, {
                onSupplementalLoaded: loadedType => this.handleSupplementalLoaded(loadedType)
            });

            this.renderLoadedCards(cardType, true, true);
        } catch (error) {
            console.error(`❌ 加载 ${cardType} 数据失败:`, error);
            if (this.loadingStatus) this.loadingStatus.textContent = `加载失败: ${error.message}`;
            this.cardGrid.hideLoading();
        }
    }

    async loadPokemonWithInitialBatch() {
        await this.cardManager.loadCardData('宝可梦', {
            onSupplementalLoaded: loadedType => this.handleSupplementalLoaded(loadedType)
        });
        this.renderLoadedCards('宝可梦', true, true);
    }

    handleSupplementalLoaded(cardType) {
        if (this.cardManager.getCurrentTab() !== cardType) return;

        const hasSearchText = this.searchInput && this.searchInput.value.trim();
        if (hasSearchText) {
            this.performSearch();
            return;
        }

        this.renderLoadedCards(cardType, false, false);
    }

    renderLoadedCards(cardType, resetSearchState = false, isIndexOnly = false) {
        if (resetSearchState) {
            this.cardManager.isShowingAllCards = true;
            this.cardManager.hasActiveSearch = false;
        }

        // 世代筛选
        if (cardType === '宝可梦' && this.cardManager.getCurrentGeneration() !== 'all') {
            this.cardManager.applyGenerationFilter();
        }

        // 卡包筛选：re-sync state to ensure currentSetCode survives card reload
        if (window.setFilterManager) {
            window.setFilterManager.syncState();
        }

        this.cardManager.filteredCards = this.cardManager.cards.filter(card =>
            card.type === cardType
        );

        const displayCards = this.cardManager.getDisplayCards();
        const displayCount = displayCards.length;

        let displayMessage = isIndexOnly
            ? `已加载 ${displayCount} 张${cardType}卡牌，正在补充搜索/筛选数据`
            : `已加载所有 ${displayCount} 张${cardType}卡牌`;

        if (cardType === '宝可梦' && this.cardManager.getCurrentGeneration() !== 'all') {
            const generationName = this.cardManager.getGenerationName(this.cardManager.getCurrentGeneration());
            displayMessage = isIndexOnly
                ? `显示${generationName}: ${displayCount} 张卡牌，正在补充搜索/筛选数据`
                : `显示${generationName}: ${displayCount} 张卡牌`;
        }

        this.cardGrid.updateSearchInfo(displayMessage);
        this.cardGrid.render();

        this.searchInput.placeholder = this.searchEngine.getSearchPlaceholder();
    }

    // 显示加载状态
    showLoading(message = '正在加载卡牌数据...') {
        if (this.loadingStatus) this.loadingStatus.textContent = message;
        this.cardGrid.showLoading();
    }

    // 隐藏加载状态
    hideLoading() {
        this.cardGrid.hideLoading();
    }
}