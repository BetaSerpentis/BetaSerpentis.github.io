// ptcg/js/features/DeckEditor.js
import { debugLog } from '../utils/constants.js';
import { showToast } from '../utils/helpers.js';

export class DeckEditor {
    static MODE = Object.freeze({
        BROWSE:       'browse',
        DECK_VIEW:    'deck-view',
        DECK_EDIT:    'deck-edit',
        DECK_ADD:     'deck-add',
        COVER_SELECT: 'cover-select'
    });

    constructor(deckManager, cardManager, imageLoader, cardGrid, modalView) {
        this.deckManager = deckManager;
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.cardGrid = cardGrid;
        this.modalView = modalView;

        this.mode = DeckEditor.MODE.BROWSE;
        this.isMissingMode = false;
        this.deckTabsContainer = null;
        this.defaultGetDisplayCards = cardManager.getDisplayCards.bind(cardManager);

        // 模式 → 点击行为分发
        this._clickHandlers = {
            [DeckEditor.MODE.COVER_SELECT]: this._onCoverSelectClick.bind(this),
            [DeckEditor.MODE.DECK_ADD]:     this._onDeckAddClick.bind(this),
            [DeckEditor.MODE.DECK_EDIT]:    this._onDeckEditClick.bind(this),
            [DeckEditor.MODE.DECK_VIEW]:    this._onViewClick.bind(this),
            [DeckEditor.MODE.BROWSE]:       this._onBrowseClick.bind(this)
        };
        // 封面选择遮罩层
        this._coverSelectOverlay = null;

        this.init();
    }

    // ---- 统一模式 UI ----
    _applyModeUI(mode) {
        const M = DeckEditor.MODE;
        const showSearch  = mode === M.BROWSE || mode === M.DECK_ADD;
        const showFeatTab = mode === M.BROWSE || mode === M.DECK_ADD;
        const showDeckTab = mode === M.DECK_VIEW || mode === M.DECK_EDIT || mode === M.COVER_SELECT;
        const showGenTab  = mode === M.BROWSE;

        const el = (s) => document.querySelector(s);
        const setVis = (el, show) => { if (el) el.style.display = show ? '' : 'none'; };

        setVis(el('.search-header'), showSearch);
        setVis(el('.feature-tabs'), showFeatTab);
        setVis(document.getElementById('generation-tabs'), showGenTab);
        if (this.deckTabsContainer) {
            setVis(this.deckTabsContainer, showDeckTab);
        }
    }

    // ---- 模式切换（仅改状态 + UI，业务逻辑由调用方处理）----
    _switchMode(newMode) {
        this.mode = newMode;
        if (this.cardGrid) this.cardGrid.setMode(newMode);
        this._applyModeUI(newMode);
    }

    init() {
        this.setupModalPrevention();
        if (this.cardGrid) {
            this.cardGrid.deckManager = this.deckManager;
        }
        debugLog('🔍 DeckEditor 初始化检查:', {
            cardGrid: !!this.cardGrid,
            deckManager: !!this.deckManager
        });
    }

    // 添加强制设置回调的方法
    forceSetCardGridCallbacks() {
        if (this.cardGrid) {
            // debugLog('🔧 强制设置 CardGrid 回调');
            this.cardGrid.onCardClick = this.handleCardClick.bind(this);
            this.cardGrid.onQuantityChange = this.handleQuantityChange.bind(this);
            debugLog('✅ CardGrid 回调设置完成:', {
                onCardClick: !!this.cardGrid.onCardClick,
                onQuantityChange: !!this.cardGrid.onQuantityChange
            });
        } else {
            console.error('❌ CardGrid 未找到');
        }
    }

    // 进入卡组模式
    // 修改 enterDeckMode 方法
    async enterDeckMode() {
        // debugLog('🔍 进入卡组模式');
        
        // 保存原始状态
        // 预加载所有卡牌基础信息，确保排序时能获取到 type/number
        await this.cardManager.preloadAllCardBaseInfo();
        this.saveOriginalState();
        
        this.createDeckInterface();
        this._switchMode(DeckEditor.MODE.DECK_VIEW);
        this.renderCurrentDeck();
        if (window.buttonManager) window.buttonManager.showDeckMode();
    }

    // 在 DeckEditor.js 中优化保存原始状态的方法
    saveOriginalState() {
        // debugLog('💾 保存原始状态');
        
        // 保存原始方法
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
        
        // 保存过滤卡牌 - 深拷贝当前状态
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        
        // 保存当前标签页
        this.originalCurrentTab = this.cardManager.currentTab;
        
        // 保存卡牌数据完整副本（预加载可能污染 cardManager.cards）
        this.originalCards = [...this.cardManager.cards];
        
        debugLog('✅ 原始状态保存完成:', {
            filteredCardsCount: this.originalFilteredCards.length,
            currentTab: this.originalCurrentTab,
            totalCards: this.originalCardsLength
        });
    }

    // createDeckInterface — 只创建 deckTabsContainer，按钮由 ButtonManager 统一管理
    createDeckInterface() {
        this.deckTabsContainer = document.createElement('div');
        this.deckTabsContainer.className = 'deck-tabs-container';
        
        const container = document.querySelector('.container');
        container.insertBefore(this.deckTabsContainer, container.firstChild);
        
        this.renderDeckTabs();
    }

    // 在 renderDeckTabs 方法中确保编辑模式下有删除按钮
    renderDeckTabs() {
        this.deckTabsContainer.innerHTML = '';
        
        // 添加新建卡组按钮 - 简化结构，只显示加号
        const addButton = document.createElement('div');
        addButton.className = 'deck-tab-add';
        
        addButton.addEventListener('click', () => {
            if (!this.deckManager.isEditing) {
                this.deckManager.createNewDeck();
                this.renderDeckTabs();
                this.renderCurrentDeck();
                
                // 如果是编辑模式，为新卡组添加删除按钮
                if (this.deckManager.isEditing) {
                    setTimeout(() => {
                        this.addDeleteButtonsToDecks();
                    }, 100);
                }
            }
        });
        
        this.deckTabsContainer.appendChild(addButton);
        
        // 添加卡组页签
        this.deckManager.decks.forEach((deck, index) => {
            const tab = this.createDeckTab(deck, index);
            this.deckTabsContainer.appendChild(tab);
        });
        
        // 如果是编辑模式，为当前卡组添加删除按钮
        if (this.deckManager.isEditing) {
            setTimeout(() => {
                this.addDeleteButtonsToDecks();
            }, 100);
        }
        
        // debugLog('✅ 卡组页签渲染完成，新增按钮已优化');
    }

    // 在 createDeckTab 方法中优化封面显示逻辑
    createDeckTab(deck, index) {
        const tab = document.createElement('div');
        tab.className = `deck-tab ${index === this.deckManager.currentDeckIndex ? 'active' : ''}`;
        if (index === this.deckManager.currentDeckIndex && this.isMissingMode) {
            tab.classList.add('missing-mode');
        }

        // 修复：只有非当前卡组页签在编辑模式下才禁用
        if (this.deckManager.isEditing && index !== this.deckManager.currentDeckIndex) {
            tab.classList.add('disabled');
        }
        
        // 卡组封面 - 优化图片显示，支持所有卡牌类型
        const cover = document.createElement('div');
        cover.className = 'deck-cover';

        if (deck.coverCardId) {
            // 直接使用卡牌管理器的全局缓存获取卡牌信息
            const cardInfo = this.cardManager.getCardBaseInfo(deck.coverCardId);
            
            if (cardInfo && cardInfo.image) {
                const img = document.createElement('img');
                img.src = cardInfo.image;
                img.alt = deck.name;
                img.onload = () => {
                    // debugLog(`✅ 封面图片加载成功: ${cardInfo.name}`);
                };
                img.onerror = () => {
                    // debugLog(`❌ 封面图片加载失败: ${cardInfo.name}, 路径: ${cardInfo.image}`);
                    // 图片加载失败时，显示占位符
                    this.showCoverPlaceholder(cover, cardInfo.name);
                };
                cover.appendChild(img);
            } else {
                // 没有找到卡牌信息，显示占位符
                this.showCoverPlaceholder(cover, '未知卡牌');
            }
        } else {
            this.showCoverPlaceholder(cover, '暂无封面');
        }

        // 卡组信息
        const info = document.createElement('div');
        info.className = 'deck-info';
        
        const name = document.createElement('div');
        name.className = 'deck-name';
        name.textContent = deck.name;
        
        const count = document.createElement('div');
        count.className = 'deck-count';
        count.textContent = `${deck.totalCount}/60`;
        
        info.appendChild(name);
        info.appendChild(count);
        
        tab.appendChild(cover);
        tab.appendChild(info);
        
        // 绑定事件 - 修复事件处理逻辑
        tab.addEventListener('click', (e) => {
            // 如果点击的是封面或名称，让它们自己的事件处理
            if (e.target.closest('.deck-cover') || e.target.closest('.deck-name')) {
                // debugLog('🖼️ 点击了封面或名称，由专门的事件处理');
                return;
            }
            
            // 编辑模式下，只有当前卡组可以操作，其他卡组不能切换
            if (this.deckManager.isEditing) {
                if (index === this.deckManager.currentDeckIndex) {
                    // debugLog('🔄 编辑模式下点击当前卡组的其他区域');
                    // 当前卡组的其他区域点击不做特殊处理
                } else {
                    // debugLog('🚫 编辑模式下不能切换卡组');
                    return;
                }
            } else {
                if (index === this.deckManager.currentDeckIndex) {
                    this.toggleMissingMode();
                } else {
                    // 非编辑模式下可以正常切换卡组，切换卡组时回到普通卡组内容
                    this.isMissingMode = false;
                    this.deckManager.switchDeck(index);
                    this.renderDeckTabs();
                    this.renderCurrentDeck();
                }
            }
        });
        
        return tab;
    }

    // 新增：显示封面占位符
    showCoverPlaceholder(coverElement, text) {
        coverElement.textContent = text;
        coverElement.className += ' no-cover';
        // debugLog(`📝 封面占位符: ${text}`);
    }

    fallbackCoverImage(coverElement, cardId, deckName) {
        // 使用卡牌管理器的全局缓存查找
        const cardInfo = this.cardManager.getCardBaseInfo(cardId);
        
        if (cardInfo && cardInfo.image) {
            const img = document.createElement('img');
            img.alt = deck.name;
            
            // 使用带重试的图片加载
            this.cardManager.loadImageWithRetry(img, cardInfo.image, 3);
            
            img.onload = () => {
                // debugLog(`✅ 封面图片加载成功: ${cardInfo.name}`);
            };
            
            cover.appendChild(img);
        }
    }

    // 渲染当前卡组 - 修复数据显示问题
    renderCurrentDeck() {
        if (this.mode === DeckEditor.MODE.DECK_ADD) return;

        const deckCards = this.isMissingMode
            ? this.deckManager.getDeckMissingCards()
            : this.deckManager.getDeckDisplayCards();

        // 临时修改 cardManager 的行为
        this.cardManager.getDisplayCards = () => {
            return deckCards.map(deckCard => {
                // 统一方式：从卡牌管理器中获取完整的卡牌信息
                const cardInfo = this.cardManager.getCardBaseInfo(deckCard.id);
                return {
                    ...deckCard,
                    name: cardInfo.name,
                    image: cardInfo.image, // 使用统一的图片路径
                    type: cardInfo.type,
                    number: deckCard.number // 如果有的话
                };
            });
        };

        this.cardGrid.render();
        const currentDeck = this.deckManager.getCurrentDeck();
        this.cardGrid.updateSearchInfo(this.isMissingMode
            ? `缺卡清单：${deckCards.length} 种卡缺少，点击当前卡组页签返回完整卡组`
            : `当前卡组：${currentDeck?.name || '新卡组'}（${currentDeck?.totalCount || 0}/60）`);
    }

    toggleMissingMode() {
        this.isMissingMode = !this.isMissingMode;
        this.renderDeckTabs();
        this.renderCurrentDeck();
    }

    // ---- 卡牌点击：按模式分发给对应 handler ----
    handleCardClick(index, button) {
        const cardGrid = document.querySelector('.card-grid');
        if (cardGrid && cardGrid.classList.contains('dragging')) return;

        const handler = this._clickHandlers[this.mode];
        if (handler) {
            handler(index, button);
        }
    }

    // 各模式下的点击行为
    _onCoverSelectClick(index, button) {
        const cards = this.cardManager.getDisplayCards();
        if (index < 0 || index >= cards.length) return;
        const card = cards[index];
        this.deckManager.setDeckCover(card.id);
        this.renderDeckTabs();
        // 选完封面回到编辑模式
        this._cleanupCoverSelectIfNeeded();
        this._switchMode(DeckEditor.MODE.DECK_EDIT);
        this.cardManager.getDisplayCards = this.defaultGetDisplayCards;
        if (this.originalFilteredCards) {
            this.cardManager.filteredCards = this.originalFilteredCards;
        }
        this.renderCurrentDeck();
        if (window.buttonManager) window.buttonManager.showEditMode();
    }

    _onDeckAddClick(index, button) {
        this.addCardToDeck(index, button === 'left' ? 1 : -1);
    }

    _onDeckEditClick(index, button) {
        const deckCards = this.deckManager.getDeckDisplayCards();
        if (index >= 0 && index < deckCards.length) {
            this.handleQuantityChange(index, button === 'left' ? 1 : -1);
        }
    }

    _onViewClick(index, button) {
        this.modalView.show(index);
    }

    _onBrowseClick(index, button) {
        this.modalView.show(index);
    }

    // 新增：专门处理添加卡牌到卡组
    addCardToDeck(index, change) {
        debugLog(() => ['=== DeckEditor.addCardToDeck ===', { index, change }]);
        
        // 获取当前显示的卡牌
        const cards = this.cardManager.getDisplayCards();
        debugLog('总卡牌数量:', cards.length, '点击索引:', index);
        
        if (index < 0 || index >= cards.length) {
            debugLog('❌ 索引超出范围');
            return;
        }
        
        const card = cards[index];
        debugLog('🃏 操作卡牌:', card.name, 'ID:', card.id, '变化:', change);
        
        // 执行添加操作
        const result = this.deckManager.updateCardQuantity(card.id, change);
        debugLog('✅ 添加操作结果:', result);
        
        if (result) {
            const newQuantity = result.quantity;
            debugLog('📈 卡牌数量更新:', newQuantity);
            
            // 在添加模式下使用专门的更新方法
            this.updateAddModeCardDisplay(card.id, newQuantity);
        } else if (change > 0) {
            debugLog('🆕 新卡牌添加到卡组');
            // 新卡牌，显示数量为1
            this.updateAddModeCardDisplay(card.id, 1);
        } else {
            debugLog('✅ 卡牌从卡组中移除');
            // 卡牌被移除（数量减到0）
            this.updateAddModeCardDisplay(card.id, 0);
        }
        
        // 更新卡组页签
        this.renderDeckTabs();
        
        // 显示反馈
        this.showOperationFeedback(card.name, change);
    }

    showOperationFeedback(cardName, change) {
        showToast(`${cardName} ${change > 0 ? '添加' : '移除'}成功`, 'info', 1000);
    }

    // 新增：在添加模式下更新卡牌显示
    updateAddModeCardDisplay(cardId, quantity) {
        debugLog(() => ['🔄 DeckEditor.updateAddModeCardDisplay', { cardId, quantity }]);
        
        const cardElements = document.querySelectorAll('.card');
        
        cardElements.forEach((cardElement) => {
            const elementCardId = cardElement.dataset.cardId;
            
            if (elementCardId === cardId) {
                debugLog(`🎯 更新卡牌显示: ${cardId}, 数量: ${quantity}`);
                
                // 移除现有的数量显示
                const existingQuantity = cardElement.querySelector('.card-quantity');
                if (existingQuantity) {
                    existingQuantity.remove();
                }
                
                // 添加模式下：只要数量>0就显示
                if (quantity > 0) {
                    const quantityElement = document.createElement('div');
                    quantityElement.className = 'card-quantity';
                    quantityElement.textContent = quantity;
                    cardElement.appendChild(quantityElement);
                    debugLog('✅ 添加模式下显示数量:', quantity);
                } else {
                    debugLog('✅ 添加模式下移除数量显示（数量为0）');
                }
            }
        });
    }

    // 处理数量变化
    handleQuantityChange(index, change) {
        const deckCards = this.deckManager.getDeckDisplayCards();
        if (index < 0 || index >= deckCards.length) return;
        
        const card = deckCards[index];
        const oldQuantity = card.quantity;
        
        // 执行更新操作
        const result = this.deckManager.updateCardQuantity(card.id, change);
        
        // 更新卡组页签的总数量显示
        this.renderDeckTabs();
        
        if (result) {
            const newQuantity = result.quantity;
            
            debugLog(() => ['🔄 DeckEditor.handleQuantityChange', {
                cardId: card.id,
                oldQuantity,
                newQuantity,
                change
            }]);
            
            // 判断是否需要重新渲染
            const needsRerender = this.shouldRerenderAfterQuantityChange(oldQuantity, newQuantity);
            
            if (needsRerender) {
                // 需要重新渲染的情况：新增卡牌或数量减到0
                debugLog('🔄 需要重新渲染: 卡牌数量从', oldQuantity, '变为', newQuantity);
                this.renderCurrentDeck();
            } else {
                // 只需要更新数量显示
                debugLog('📊 只更新数量显示: 卡牌数量从', oldQuantity, '变为', newQuantity);
                // 确保使用正确的更新方法
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
            }
        } else {
            // 卡牌被移除（数量减到0），需要重新渲染
            debugLog('🗑️ 卡牌被移除，重新渲染');
            this.renderCurrentDeck();
        }
    }

    // 新增：判断数量变化后是否需要重新渲染
    shouldRerenderAfterQuantityChange(oldQuantity, newQuantity) {
        // 情况1：数量从0变为1（新增卡牌）- 需要重新渲染
        if (oldQuantity === 0 && newQuantity === 1) {
            return true;
        }
        
        // 情况2：数量从1变为0（移除卡牌）- 需要重新渲染
        if (oldQuantity === 1 && newQuantity === 0) {
            return true;
        }
        
        // 情况3：数量从大于1变为0（移除卡牌）- 需要重新渲染
        if (oldQuantity > 1 && newQuantity === 0) {
            return true;
        }
        
        // 其他情况：只需要更新数量显示
        return false;
    }

    // 新增：更新原始状态以反映卡组变化
    updateOriginalState() {
        // debugLog('🔄 更新原始状态以反映卡组变化');
        
        // 更新保存的过滤卡牌状态
        if (this.originalFilteredCards) {
            // 重新获取当前卡组的卡牌显示
            const deckCards = this.deckManager.getDeckDisplayCards();
            this.originalFilteredCards = deckCards.map(deckCard => {
                const fullCard = this.cardManager.cards.find(c => c.id === deckCard.id);
                return {
                    ...deckCard,
                    name: fullCard?.name || deckCard.name,
                    image: fullCard?.image || deckCard.image,
                    type: fullCard?.type || '未知',
                    number: fullCard?.number
                };
            });
        }
    }

    // 修改 enterEditMode 方法，添加删除按钮
    enterEditMode() {
        this.isMissingMode = false;
        this.deckManager.setEditingMode(true);
        this._switchMode(DeckEditor.MODE.DECK_EDIT);
        this.forceSetCardGridCallbacks();
        this.makeDeckTabsEditable();
        this.addDeleteButtonsToDecks();
        document.body.classList.add('deck-edit-mode');
        if (window.buttonManager) window.buttonManager.showEditMode();
    }

    // 使卡组页签可编辑
    // 修改 makeDeckTabsEditable 方法，移除自动聚焦
    makeDeckTabsEditable() {
        const currentDeck = this.deckManager.getCurrentDeck();
        if (!currentDeck) {
            // debugLog('❌ 没有找到当前卡组');
            return;
        }
        
        const activeTab = this.deckTabsContainer.querySelector('.deck-tab.active');
        if (activeTab) {
            // debugLog('🔧 使卡组页签可编辑');
            
            // 使卡组名称可点击编辑（不自动聚焦）
            this.makeDeckNameEditable(activeTab);
            
            // 设置封面点击事件
            this.makeDeckCoverEditable(activeTab);
            
        } else {
            // debugLog('❌ 没有找到活动的卡组页签');
        }
    }

    // 新增：使卡组名可点击编辑
    makeDeckNameEditable(activeTab) {
        const nameElement = activeTab.querySelector('.deck-name');
        if (!nameElement) return;
        
        const originalName = nameElement.textContent;
        
        // 设置卡组名可点击
        nameElement.style.cursor = 'pointer';
        nameElement.title = '点击编辑名称';
        nameElement.style.borderBottom = '1px dashed #FF9800';
        
        // 点击卡组名变为输入框
        const nameClickHandler = (e) => {
            e.stopPropagation();
            e.preventDefault();
            
            // debugLog('📝 卡组名被点击，进入编辑模式');
            
            // 如果已经是输入框，则忽略
            if (nameElement.querySelector('input')) return;
            
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = originalName;
            nameInput.className = 'deck-name-input';
            nameInput.style.cssText = `
                width: 100%;
                border: 1px solid #FF9800;
                border-radius: 3px;
                padding: 2px 5px;
                font-size: 0.9rem;
                background: white;
                color: #333;
            `;
            
            // 失去焦点时保存
            nameInput.addEventListener('blur', () => {
                // debugLog('💾 保存卡组名:', nameInput.value);
                this.deckManager.updateDeckName(nameInput.value);
                
                // 恢复为文本显示
                nameElement.textContent = nameInput.value;
                nameElement.style.cursor = 'pointer';
                nameElement.style.borderBottom = '1px dashed #FF9800';
                
                // 重新绑定点击事件
                nameElement.addEventListener('click', nameClickHandler);
            });
            
            // 按回车保存
            nameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    nameInput.blur();
                }
            });
            
            // 移除点击事件，避免重复触发
            nameElement.removeEventListener('click', nameClickHandler);
            
            // 替换为输入框
            nameElement.textContent = '';
            nameElement.appendChild(nameInput);
            nameInput.focus();
            nameInput.select();
        };
        
        nameElement.addEventListener('click', nameClickHandler);
    }

    // 新增：使封面可编辑
    makeDeckCoverEditable(activeTab) {
        const coverElement = activeTab.querySelector('.deck-cover');
        if (coverElement) {
            // debugLog('🖼️ 设置封面点击事件');
            
            // 直接设置样式和事件
            coverElement.style.cursor = 'pointer';
            coverElement.title = '点击选择封面';
            coverElement.style.border = '2px dashed #FF9800';
            coverElement.style.position = 'relative';
            
            // 添加选择封面提示
            const coverHint = document.createElement('div');
            coverHint.textContent = '点击选择封面';
            coverHint.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(255, 152, 0, 0.8);
                color: white;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.7rem;
                opacity: 0;
                transition: opacity 0.3s ease;
                border-radius: 5px;
            `;
            coverElement.appendChild(coverHint);
            
            // 鼠标悬停显示提示
            coverElement.addEventListener('mouseenter', () => {
                coverHint.style.opacity = '1';
            });
            
            coverElement.addEventListener('mouseleave', () => {
                coverHint.style.opacity = '0';
            });
            
            // 封面点击事件
            const coverClickHandler = (e) => {
                // debugLog('🎯 封面点击事件触发');
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();
                
                // debugLog('🎯 进入封面选择模式');
                this.enterCoverSelectionMode();
            };
            
            // 使用一次性克隆确保事件干净
            const newCoverElement = coverElement.cloneNode(true);
            coverElement.parentNode.replaceChild(newCoverElement, coverElement);
            
            // 重新添加提示和事件
            const newCoverHint = document.createElement('div');
            newCoverHint.textContent = '点击选择封面';
            newCoverHint.style.cssText = coverHint.style.cssText;
            newCoverElement.appendChild(newCoverHint);
            
            newCoverElement.addEventListener('mouseenter', () => {
                newCoverHint.style.opacity = '1';
            });
            
            newCoverElement.addEventListener('mouseleave', () => {
                newCoverHint.style.opacity = '0';
            });
            
            newCoverElement.addEventListener('click', coverClickHandler);
            
            // debugLog('✅ 封面点击事件设置完成');
        }
    }

    // ---- 封面选择（用遮罩层替代全局 click 捕获）----
    enterCoverSelectionMode() {
        this.deckManager.setSelectingCoverMode(true);
        this._switchMode(DeckEditor.MODE.COVER_SELECT);

        // 保存状态
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;

        // 显示卡组内卡牌供选择封面
        const deckCards = this.deckManager.getDeckDisplayCards();
        this.cardManager.filteredCards = deckCards.map(dc => {
            const fc = this.cardManager.cards.find(c => c.id === dc.id);
            return { ...dc, name: fc?.name || dc.name, image: fc?.image || dc.image, type: fc?.type || '未知', number: fc?.number };
        });
        this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
        this.forceSetCardGridCallbacks();
        this.cardGrid.render();
        this.showCoverSelectionHint();

        // 透明遮罩：点击卡片以外区域 = 取消
        this._setupCoverSelectOverlay();

        if (window.buttonManager) window.buttonManager.showAddMode();
    }

    _setupCoverSelectOverlay() {
        this._removeCoverSelectOverlay();
        // 用 document 级监听代替全屏遮罩层，避免 z-index 遮挡卡片导致无法点击选择
        const handler = (e) => {
            // 点击的不是卡片 → 取消封面选择
            if (!e.target.closest('.card')) {
                this._cancelCoverSelection();
            }
        };
        // 延迟绑定，避免当前封面点击事件冒泡时立即触发取消
        setTimeout(() => {
            document.addEventListener('click', handler, true);
        }, 100);
        this._coverSelectOverlay = { handler };
    }

    _removeCoverSelectOverlay() {
        if (this._coverSelectOverlay) {
            document.removeEventListener('click', this._coverSelectOverlay.handler, true);
            this._coverSelectOverlay = null;
        }
    }

    _cancelCoverSelection() {
        this.deckManager.setSelectingCoverMode(false);
        this._switchMode(DeckEditor.MODE.DECK_EDIT);
        this.cardManager.getDisplayCards = this.defaultGetDisplayCards;
        if (this.originalFilteredCards) {
            this.cardManager.filteredCards = this.originalFilteredCards;
        }
        this._removeCoverSelectOverlay();
        this.renderCurrentDeck();
        if (window.buttonManager) window.buttonManager.showEditMode();
    }

    _cleanupCoverSelectIfNeeded() {
        this.deckManager.setSelectingCoverMode(false);
        this._removeCoverSelectOverlay();
    }

    // 为选择封面进入添加模式
    enterAddModeForCover() {
        this.cardManager.filteredCards = [...this.cardManager.cards];
        this.cardGrid.render();
        this.showCoverSelectionHint();
    }

    showCoverSelectionHint() {
        const oldHint = document.querySelector('.cover-selection-hint');
        if (oldHint) oldHint.remove();
    }

    // 进入添加模式 - 修复界面切换
    // 修改 enterAddMode 方法
    enterAddMode() {
        this.isMissingMode = false;
        this._switchMode(DeckEditor.MODE.DECK_ADD);
        this.cardManager.filteredCards = [...this.cardManager.cards];
        this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
        this.cardGrid.render();
        if (window.buttonManager) window.buttonManager.showAddMode();
    }

    // 修改 exitAddMode 方法
    exitAddMode() {
        this._cleanupCoverSelectIfNeeded();
        this._switchMode(DeckEditor.MODE.DECK_EDIT);
        this.cardManager.getDisplayCards = this.defaultGetDisplayCards;
        if (this.originalFilteredCards) {
            this.cardManager.filteredCards = this.originalFilteredCards;
        }
        this.renderCurrentDeck();
        if (window.buttonManager) window.buttonManager.showEditMode();
    }

    // 修改 exitEditMode 方法，清理删除按钮
    exitEditMode() {
        this.deckManager.setEditingMode(false);
        this.isMissingMode = false;
        this._cleanupCoverSelectIfNeeded();
        this._switchMode(DeckEditor.MODE.DECK_VIEW);
        document.body.classList.remove('deck-edit-mode');
        this.removeDeleteButtonsFromDecks();
        this.renderDeckTabs();
        this.resetToDeckCards();
        if (window.buttonManager) window.buttonManager.showDeckMode();
    }

    // 新增：为卡组添加删除按钮
    addDeleteButtonsToDecks() {
        const activeTab = this.deckTabsContainer.querySelector('.deck-tab.active');
        if (activeTab) {
            this.createDeleteButton(activeTab);
        }
    }

    // 新增：创建删除按钮
    createDeleteButton(deckTab) {
        // 移除可能已存在的删除按钮
        const existingButton = deckTab.querySelector('.deck-delete-button');
        if (existingButton) {
            existingButton.remove();
        }
        
        // 创建删除按钮
        const deleteButton = document.createElement('button');
        deleteButton.className = 'deck-delete-button';
        deleteButton.innerHTML = '×';
        deleteButton.title = '删除卡组';
        
        // 设置定位
        deckTab.style.position = 'relative';
        
        // 绑定点击事件
        deleteButton.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.showDeleteConfirmation();
        });
        
        deckTab.appendChild(deleteButton);
    }

    // 新增：移除删除按钮
    removeDeleteButtonsFromDecks() {
        const deleteButtons = this.deckTabsContainer.querySelectorAll('.deck-delete-button');
        deleteButtons.forEach(button => button.remove());
    }

    // 新增：显示删除确认对话框
    showDeleteConfirmation() {
        const currentDeck = this.deckManager.getCurrentDeck();
        if (!currentDeck) {
            // debugLog('❌ 没有找到当前卡组');
            return;
        }
        
        const stats = this.deckManager.getDeckStatsForDelete(currentDeck);
        
        // 创建确认模态框
        const modal = document.createElement('div');
        modal.className = 'delete-confirm-modal';
        modal.innerHTML = `
            <div class="delete-confirm-content">
                <div class="delete-confirm-title">删除卡组</div>
                <div class="delete-confirm-message">
                    确定要删除卡组 "<strong>${stats.name}</strong>" 吗？<br>
                    这个卡组包含 <strong>${stats.cardCount}</strong> 张卡牌，删除后无法恢复。
                </div>
                <div class="delete-confirm-buttons">
                    <button class="delete-confirm-button delete-confirm-cancel">取消</button>
                    <button class="delete-confirm-button delete-confirm-delete">删除</button>
                </div>
            </div>
        `;
        
        // 添加事件监听
        const cancelButton = modal.querySelector('.delete-confirm-cancel');
        const deleteButton = modal.querySelector('.delete-confirm-delete');
        
        cancelButton.addEventListener('click', () => {
            this.hideDeleteConfirmation(modal);
        });
        
        deleteButton.addEventListener('click', () => {
            this.executeDeckDeletion(modal);
        });
        
        // 点击模态框背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideDeleteConfirmation(modal);
            }
        });
        
        // 添加到页面并显示
        document.body.appendChild(modal);
        setTimeout(() => modal.classList.add('active'), 10);
    }

    // 新增：隐藏删除确认对话框
    hideDeleteConfirmation(modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        }, 300);
    }

    // 新增：执行卡组删除
    executeDeckDeletion(modal) {
        // debugLog('🗑️ 执行卡组删除...');
        
        // 执行删除
        const success = this.deckManager.deleteCurrentDeck();
        
        if (success) {
            // 隐藏确认对话框
            this.hideDeleteConfirmation(modal);
            
            // 退出编辑模式，回到卡组查看模式
            this.exitEditMode();
            
            // 显示成功反馈
            this.showDeletionSuccess();
        } else {
            // 删除失败，显示错误
            this.showDeletionError();
            this.hideDeleteConfirmation(modal);
        }
    }

    showDeletionSuccess() {
        showToast('卡组删除成功', 'success', 2000);
    }

    showDeletionError() {
        showToast('删除失败，无法删除最后一个卡组', 'error', 3000);
    }

    // 修复 resetToDeckCards 方法，确保使用最新数据
    resetToDeckCards() {
        const deckCards = this.deckManager.getDeckDisplayCards();
        this.cardManager.filteredCards = deckCards.map(deckCard => {
            const fullCard = this.cardManager.cards.find(c => c.id === deckCard.id);
            return {
                ...deckCard,
                name: fullCard?.name || deckCard.name,
                image: fullCard?.image || deckCard.image,
                type: fullCard?.type || '未知',
                number: fullCard?.number
            };
        });
        
        // 直接渲染，不通过加载流程
        this.cardGrid.render();
    }

    // 新增：专门为退出编辑模式重置状态的方法
    resetCardManagerStateForEditMode() {
        // debugLog('🔄 为退出编辑模式重置卡牌管理器状态');
        
        // 强制重置 filteredCards 为卡组内的卡牌（不是所有卡牌）
        const deckCards = this.deckManager.getDeckDisplayCards();
        this.cardManager.filteredCards = deckCards.map(deckCard => {
            // 从完整卡牌数据中获取详细信息
            const fullCard = this.cardManager.cards.find(c => c.id === deckCard.id);
            return {
                ...deckCard,
                name: fullCard?.name || deckCard.name,
                image: fullCard?.image || deckCard.image,
                type: fullCard?.type || '未知',
                number: fullCard?.number
            };
        });
        
        // debugLog('✅ 编辑模式状态重置完成，显示卡组卡牌:', this.cardManager.filteredCards.length);
    }

    // 在合适的位置添加这个方法（可以在 exitDeckMode 方法之前）
    simpleCardManagerReset() {
        // debugLog('🔄 简化重置卡牌管理器状态');
        
        // 直接重置 filteredCards 为所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        // debugLog('✅ 重置 filteredCards，数量:', this.cardManager.filteredCards.length);
        
        // 恢复 CardManager 原型方法，避免卡组视图的临时覆盖污染搜索/筛选
        this.cardManager.getDisplayCards = this.defaultGetDisplayCards;
        
        // 恢复当前标签页（如果存在）
        if (this.originalCurrentTab) {
            this.cardManager.currentTab = this.originalCurrentTab;
            // debugLog('✅ 恢复当前标签页:', this.originalCurrentTab);
        }
        
        // 恢复保存的 cards（防止预加载污染），然后过滤并渲染
        if (this.originalCards) {
            this.cardManager.cards = this.originalCards;
        }
        const tabName = this.originalCurrentTab || '宝可梦';
        this.cardManager.filteredCards = this.cardManager.cards.filter(card =>
            card.type === tabName
        );
        this.cardManager.isShowingAllCards = true;
        this.cardManager.hasActiveSearch = false;
        const activeTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
        if (activeTab) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            activeTab.classList.add('active');
        }
        if (this.cardGrid && this.cardGrid.render) {
            this.cardGrid.render();
        }
    }

    // 在 DeckEditor.js 中彻底修复退出卡组模式的问题
    // 修改 exitDeckMode 方法
    exitDeckMode() {
        document.querySelectorAll('.deck-tabs-container').forEach(c => c.remove());
        this.deckTabsContainer = null;
        this.isMissingMode = false;
        this._switchMode(DeckEditor.MODE.BROWSE);
        // 如果当前是宝可梦标签页，恢复世代筛选栏
        const genTabs2 = document.getElementById('generation-tabs');
        if (genTabs2 && this.originalCurrentTab === '宝可梦') {
            genTabs2.style.display = '';
        }
        if (window.buttonManager) window.buttonManager.showBrowseMode();
        this.simpleCardManagerReset();
    }

    // 新增：通过 CardBrowser 重新加载当前标签页
    reloadCurrentTabViaCardBrowser() {
        // debugLog('🔄 通过 CardBrowser 重新加载当前标签页');
        
        // 获取当前标签页名称
        let tabName = '宝可梦';
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            tabName = activeTab.dataset.feature;
        } else if (this.originalCurrentTab) {
            tabName = this.originalCurrentTab;
        }
        
        // debugLog('重新加载标签页:', tabName);
        
        // 通过 CardBrowser 重新加载数据
        if (this.cardBrowser && this.cardBrowser.loadCardData) {
            // debugLog('✅ 调用 CardBrowser.loadCardData');
            this.cardBrowser.loadCardData(tabName);
        } else {
            // debugLog('❌ CardBrowser 不可用，手动过滤和渲染');
            // 手动过滤当前类型的卡牌
            this.cardManager.filteredCards = this.cardManager.cards.filter(card => 
                card.type === tabName
            );
            // 手动渲染
            if (this.cardGrid && this.cardGrid.render) {
                this.cardGrid.render();
            }
        }
    }

    // 修改：直接重新加载当前标签页
    directReloadCurrentTab() {
        // debugLog('🔄 直接重新加载当前标签页');
        
        // 获取当前标签页名称
        let tabName = '宝可梦';
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            tabName = activeTab.dataset.feature;
        } else if (this.originalCurrentTab) {
            tabName = this.originalCurrentTab;
        }
        
        // debugLog('加载标签页:', tabName);
        
        // 直接过滤当前类型的卡牌
        this.cardManager.filteredCards = this.cardManager.cards.filter(card => 
            card.type === tabName
        );
        
        // debugLog(`✅ 直接过滤后卡牌数量: ${this.cardManager.filteredCards.length}`);
        
        // 直接重新渲染网格
        if (this.cardGrid && this.cardGrid.render) {
            this.cardGrid.render();
            // debugLog('✅ 卡牌网格直接重新渲染完成');
        }
        
        // 同时调用 CardBrowser 作为备份（但主要依赖直接重置）
        if (this.cardBrowser && this.cardBrowser.loadCardData) {
            // debugLog('🔄 同时调用 CardBrowser.loadCardData 作为备份');
            setTimeout(() => {
                this.cardBrowser.loadCardData(tabName);
            }, 50);
        }
    }

    // 修改 setupModalPrevention 方法 - 只在特定模式下阻止模态框
    setupModalPrevention() {
        // 保存原始方法
        this.originalModalShow = this.modalView.show;
        
        // 覆盖 modalView.show - 只在编辑模式下阻止模态框
        this.modalView.show = (index) => {
            // 只在封面选择 / 添加模式下阻止模态框
            if (this.mode === DeckEditor.MODE.COVER_SELECT || this.mode === DeckEditor.MODE.DECK_ADD) {
                debugLog('🚫 封面选择模式下阻止模态框');
                return;
            }
            
            // 编辑模式其他情况下允许模态框
            debugLog('✅ 允许模态框打开');
            this.originalModalShow.call(this.modalView, index);
        };
    }
}