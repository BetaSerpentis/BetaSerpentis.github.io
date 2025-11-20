// ptcg/js/features/DeckEditor.js
export class DeckEditor {
    constructor(deckManager, cardManager, imageLoader, cardGrid, modalView) {
        this.deckManager = deckManager;
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.cardGrid = cardGrid;
        this.modalView = modalView;
                
        this.isInAddMode = false;
        this.deckTabsContainer = null;
        
        this.init();
    }

    // 修改 init 方法，添加延迟设置回调
    // DeckEditor.js - 修复初始化方法
    init() {
        this.setupModalPrevention();
        
        // 确保 CardGrid 可以访问 deckManager
        if (this.cardGrid) {
            this.cardGrid.deckManager = this.deckManager;
            
            // 强制设置回调，确保初始化时就有正确的回调
            this.forceSetCardGridCallbacks();
        }
        
        console.log('🔍 DeckEditor 初始化检查:', {
            cardGrid: !!this.cardGrid,
            onCardClick: !!(this.cardGrid && this.cardGrid.onCardClick),
            handleCardClick: !!this.handleCardClick
        });
    }

    // 添加强制设置回调的方法
    forceSetCardGridCallbacks() {
        if (this.cardGrid) {
            // console.log('🔧 强制设置 CardGrid 回调');
            this.cardGrid.onCardClick = this.handleCardClick.bind(this);
            this.cardGrid.onQuantityChange = this.handleQuantityChange.bind(this);
            console.log('✅ CardGrid 回调设置完成:', {
                onCardClick: !!this.cardGrid.onCardClick,
                onQuantityChange: !!this.cardGrid.onQuantityChange
            });
        } else {
            console.error('❌ CardGrid 未找到');
        }
    }

    // 进入卡组模式
    // 修改 enterDeckMode 方法
    enterDeckMode() {
        // console.log('🔍 进入卡组模式');
        
        // 保存原始状态
        this.saveOriginalState();
        
        // 隐藏搜索栏，显示卡组页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        
        // 通知 ButtonManager 切换到卡组模式
        if (window.buttonManager) {
            window.buttonManager.showDeckMode();
        }
        
        // 创建卡组界面
        this.createDeckInterface();
        
        // 渲染当前卡组
        this.renderCurrentDeck();
    }

    /*// 统一的按钮管理方法
    updateButtonContainer(mode) {
        const buttonContainer = document.querySelector('.deck-button-container');
        if (!buttonContainer) return;
        
        buttonContainer.innerHTML = '';
        
        switch(mode) {
            case 'browse':
                // 浏览模式：卡组 + 统计
                this.createBrowseModeButtons(buttonContainer);
                break;
            case 'deck':
                // 卡组模式：查卡 + 编辑
                this.createDeckModeButtons(buttonContainer);
                break;
            case 'edit':
                // 编辑模式：新增 + 保存
                this.createEditModeButtons(buttonContainer);
                break;
            case 'add':
                // 添加模式：完成 + 保存
                this.createAddModeButtons(buttonContainer);
                break;
        }
    }
    */

    createBrowseModeButtons(container) {
        const deckButton = document.createElement('button');
        deckButton.className = 'deck-button';
        deckButton.textContent = '卡组';
        deckButton.addEventListener('click', () => this.enterDeckMode());
        
        const statsButton = document.createElement('button');
        statsButton.className = 'stats-button';
        statsButton.textContent = '统计';
        statsButton.id = 'stats-button';
        
        container.appendChild(deckButton);
        container.appendChild(statsButton);
    }

    // 在 DeckEditor.js 中优化保存原始状态的方法
    saveOriginalState() {
        // console.log('💾 保存原始状态');
        
        // 保存原始方法
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
        
        // 保存过滤卡牌 - 深拷贝当前状态
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        
        // 保存当前标签页
        this.originalCurrentTab = this.cardManager.currentTab;
        
        // 保存卡牌数据引用（用于验证）
        this.originalCardsLength = this.cardManager.cards.length;
        
        console.log('✅ 原始状态保存完成:', {
            filteredCardsCount: this.originalFilteredCards.length,
            currentTab: this.originalCurrentTab,
            totalCards: this.originalCardsLength
        });
    }

    // 创建卡组界面
    createDeckInterface() {
        // 创建卡组页签容器
        this.deckTabsContainer = document.createElement('div');
        this.deckTabsContainer.className = 'deck-tabs-container';
        
        // 创建底部按钮容器 - 改为上下排列
        this.deckButtonContainer = document.createElement('div');
        this.deckButtonContainer.className = 'deck-button-container';
        this.deckButtonContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 1000;
        `;
        
        // 创建查卡按钮 - 移除内联样式
        this.searchButton = document.createElement('button');
        this.searchButton.className = 'deck-search-button';
        this.searchButton.textContent = '查卡';
        // 移除 style.cssText 行

        // 创建编辑按钮 - 移除内联样式
        this.editButton = document.createElement('button');
        this.editButton.className = 'deck-edit-button';
        this.editButton.textContent = '编辑';
        // 移除 style.cssText 行

        // 绑定事件
        this.searchButton.addEventListener('click', () => {
            this.exitDeckMode();
        });
        
        this.editButton.addEventListener('click', () => {
            this.enterEditMode();
        });
        
        // 添加到页面
        this.deckButtonContainer.appendChild(this.searchButton);
        this.deckButtonContainer.appendChild(this.editButton);
        
        const container = document.querySelector('.container');
        container.insertBefore(this.deckTabsContainer, container.firstChild);
        document.body.appendChild(this.deckButtonContainer);
        
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
        
        // console.log('✅ 卡组页签渲染完成，新增按钮已优化');
    }

    // 在 createDeckTab 方法中优化封面显示逻辑
    createDeckTab(deck, index) {
        const tab = document.createElement('div');
        tab.className = `deck-tab ${index === this.deckManager.currentDeckIndex ? 'active' : ''}`;
        
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
                    // console.log(`✅ 封面图片加载成功: ${cardInfo.name}`);
                };
                img.onerror = () => {
                    // console.log(`❌ 封面图片加载失败: ${cardInfo.name}, 路径: ${cardInfo.image}`);
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
                // console.log('🖼️ 点击了封面或名称，由专门的事件处理');
                return;
            }
            
            // 编辑模式下，只有当前卡组可以操作，其他卡组不能切换
            if (this.deckManager.isEditing) {
                if (index === this.deckManager.currentDeckIndex) {
                    // console.log('🔄 编辑模式下点击当前卡组的其他区域');
                    // 当前卡组的其他区域点击不做特殊处理
                } else {
                    // console.log('🚫 编辑模式下不能切换卡组');
                    return;
                }
            } else {
                // 非编辑模式下可以正常切换卡组
                this.deckManager.switchDeck(index);
                this.renderDeckTabs();
                this.renderCurrentDeck();
            }
        });
        
        return tab;
    }

    // 新增：显示封面占位符
    showCoverPlaceholder(coverElement, text) {
        coverElement.textContent = text;
        coverElement.className += ' no-cover';
        // console.log(`📝 封面占位符: ${text}`);
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
                // console.log(`✅ 封面图片加载成功: ${cardInfo.name}`);
            };
            
            cover.appendChild(img);
        }
    }

    // 渲染当前卡组 - 修复数据显示问题
    renderCurrentDeck() {
        if (this.isInAddMode) {
            // 添加模式：显示所有卡牌
            return;
        }
        
        // 卡组模式：显示当前卡组的卡牌
        const deckCards = this.deckManager.getDeckDisplayCards();
        
        // 临时修改 cardManager 的行为
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
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
    }

    // 处理卡牌点击 - 修复编辑模式逻辑
    // 优化 handleCardClick 方法中的封面选择处理
    handleCardClick(index, button) {
        // console.log('=== DeckEditor: 卡牌点击事件 ===');
        // console.log('索引:', index, '按钮:', button);
        
        // 检测当前模式
        const isDeckMode = !!document.querySelector('.deck-tabs-container');
        const isDeckAddMode = !!document.querySelector('.deck-complete-button');
        const isDeckEditMode = !!document.querySelector('.deck-add-button');
        
        // 使用 CardGrid 的统计模式检测方法
        const isStatsMode = this.cardGrid.isStatsModeActive ? this.cardGrid.isStatsModeActive() : false;
        
        console.log('🔍 完整模式检测:', {
            isDeckMode,
            isDeckAddMode,
            isDeckEditMode,
            isStatsMode,
            isInAddMode: this.isInAddMode,
            isSelectingCover: this.deckManager.isSelectingCover
        });
        
        // 封面选择模式处理 - 最高优先级
        if (this.deckManager.isSelectingCover) {
            // console.log('🖼️ 封面选择模式处理');
            const cards = this.cardManager.getDisplayCards();
            
            if (index < 0 || index >= cards.length) {
                // console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            // console.log(`✅ 设置封面: ${card.name} (ID: ${card.id})`);
            
            // 设置封面
            const success = this.deckManager.setDeckCover(card.id);
            // console.log('封面设置结果:', success);
            
            // 退出封面选择模式
            this.deckManager.setSelectingCoverMode(false);
            
            // 移除全局点击事件
            if (this.coverSelectionCancelHandler) {
                document.removeEventListener('click', this.coverSelectionCancelHandler, true);
                this.coverSelectionCancelHandler = null;
            }
            
            // 重新渲染卡组页签以显示新封面
            this.renderDeckTabs();
            
            // 退出添加模式，回到编辑模式
            this.exitAddMode();
            return;
        }

        // 统计模式处理 - 在卡组模式之前检查
        if (isStatsMode && !isDeckMode) {
            // console.log('📊 统计模式处理');
            
            // 获取当前显示的卡牌
            const cards = this.cardManager.getDisplayCards();
            if (index < 0 || index >= cards.length) {
                // console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            // console.log('📊 统计模式操作卡牌:', card.name, 'ID:', card.id, '按钮:', button);
            
            if (button === 'left') {
                // 左键：增加数量
                // console.log('➕ 统计模式增加数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, 1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            } else if (button === 'right') {
                // 右键：减少数量
                // console.log('➖ 统计模式减少数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, -1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            }
            return;
        }

        // 卡组添加模式
        if (isDeckAddMode || this.isInAddMode) {
            // console.log('添加模式处理 - 执行添加卡牌逻辑');
            if (button === 'left') {
                // console.log('左键点击 - 添加卡牌');
                this.addCardToDeck(index, 1);
            } else if (button === 'right') {
                // console.log('右键点击 - 移除卡牌');
                this.addCardToDeck(index, -1);
            }
            return;
        }
        
        // 卡组编辑模式（非添加模式）
        if (isDeckEditMode && isDeckMode && !isDeckAddMode) {
            // console.log('编辑模式处理');
            const deckCards = this.deckManager.getDeckDisplayCards();
            if (index < deckCards.length) {
                if (button === 'left') {
                    this.handleQuantityChange(index, 1);
                } else if (button === 'right') {
                    this.handleQuantityChange(index, -1);
                }
            } else {
                // console.log('❌ 索引超出卡组范围');
            }
            return;
        }
        
        // 卡组浏览模式
        if (isDeckMode && !isDeckEditMode && !isDeckAddMode) {
            // console.log('卡组浏览模式 - 打开模态框');
            this.modalView.show(index);
            return;
        }
        
        // 正常浏览模式
        // console.log('正常模式 - 打开模态框');
        this.modalView.show(index);
    }

    // 新增：专门处理添加卡牌到卡组
    // DeckEditor.js 修复 addCardToDeck 方法
    addCardToDeck(index, change) {
        // console.log('=== 开始添加卡牌到卡组 ===');
        
        // 获取当前显示的卡牌
        const cards = this.cardManager.getDisplayCards();
        // console.log('总卡牌数量:', cards.length, '点击索引:', index);
        
        if (index < 0 || index >= cards.length) {
            // console.log('❌ 索引超出范围');
            return;
        }
        
        const card = cards[index];
        // console.log('🃏 操作卡牌:', card.name, 'ID:', card.id, '变化:', change);
        
        // 执行添加操作
        const result = this.deckManager.updateCardQuantity(card.id, change);
        // console.log('✅ 添加操作结果:', result);
        
        if (result) {
            // console.log('📈 卡牌数量更新:', result.quantity);
            // 更新显示
            this.updateAddModeCardDisplay(card.id, result.quantity);
        } else if (change > 0) {
            // console.log('🆕 新卡牌添加到卡组');
            // 新卡牌，显示数量为1
            this.updateAddModeCardDisplay(card.id, 1);
        } else {
            // console.log('❌ 添加操作失败');
        }
        
        // 更新卡组页签
        this.renderDeckTabs();
        
        // 显示反馈
        this.showOperationFeedback(card.name, change);
    }

    // 添加操作反馈
    showOperationFeedback(cardName, change) {
        const feedback = document.createElement('div');
        feedback.className = 'deck-operation-feedback';
        feedback.textContent = `${cardName} ${change > 0 ? '添加' : '移除'}成功`;
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 5px;
            z-index: 1001;
            font-size: 1rem;
        `;
        
        document.body.appendChild(feedback);
        setTimeout(() => {
            feedback.remove();
        }, 1000);
    }

    // 新增：在添加模式下更新卡牌显示
    // DeckEditor.js 修复 updateAddModeCardDisplay 方法
    updateAddModeCardDisplay(cardId, quantity) {
        // console.log('🔄 更新卡牌显示, ID:', cardId, '数量:', quantity);
        
        const cardElements = document.querySelectorAll('.card');
        // console.log('找到卡牌元素数量:', cardElements.length);
        
        cardElements.forEach((cardElement) => {
            const cardIndex = parseInt(cardElement.dataset.index);
            const cards = this.cardManager.getDisplayCards();
            
            if (cardIndex < cards.length) {
                const card = cards[cardIndex];
                if (card && card.id === cardId) {
                    // console.log(`🎯 更新卡牌显示: ${card.name}, 数量: ${quantity}`);
                    
                    // 移除现有的数量显示
                    const existingQuantity = cardElement.querySelector('.card-quantity');
                    if (existingQuantity) {
                        existingQuantity.remove();
                    }
                    
                    // 只在数量>0时显示
                    if (quantity > 0) {
                        const quantityElement = document.createElement('div');
                        quantityElement.className = 'card-quantity';
                        quantityElement.textContent = quantity;
                        cardElement.appendChild(quantityElement);
                        // console.log('✅ 设置数量显示:', quantity);
                    } else {
                        // console.log('❌ 移除数量显示');
                    }
                }
            }
        });
    }

    // 处理数量变化
    // DeckEditor.js - 优化 handleQuantityChange 方法，减少不必要的重新渲染
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
            
            // 判断是否需要重新渲染
            const needsRerender = this.shouldRerenderAfterQuantityChange(oldQuantity, newQuantity);
            
            if (needsRerender) {
                // 需要重新渲染的情况：新增卡牌或数量减到0
                // console.log('🔄 需要重新渲染: 卡牌数量从', oldQuantity, '变为', newQuantity);
                this.renderCurrentDeck();
            } else {
                // 只需要更新数量显示
                // console.log('📊 只更新数量显示: 卡牌数量从', oldQuantity, '变为', newQuantity);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
            }
        } else {
            // 卡牌被移除（数量减到0），需要重新渲染
            // console.log('🗑️ 卡牌被移除，重新渲染');
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
        // console.log('🔄 更新原始状态以反映卡组变化');
        
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
        // console.log('🔄 进入编辑模式');
        this.deckManager.setEditingMode(true);
        
        // 强制设置回调，确保编辑模式点击有效
        this.forceSetCardGridCallbacks();
        
        // 更新卡组页签为可编辑状态
        this.makeDeckTabsEditable();
        
        // 添加删除按钮
        this.addDeleteButtonsToDecks();
        
        // 添加编辑模式CSS类
        document.body.classList.add('deck-edit-mode');
        
        // 通知 ButtonManager 切换到编辑模式
        if (window.buttonManager) {
            window.buttonManager.showEditMode();
        }
        
        // console.log('✅ 编辑模式进入完成');
    }

    // 使卡组页签可编辑
    // 修改 makeDeckTabsEditable 方法，移除自动聚焦
    makeDeckTabsEditable() {
        const currentDeck = this.deckManager.getCurrentDeck();
        if (!currentDeck) {
            // console.log('❌ 没有找到当前卡组');
            return;
        }
        
        const activeTab = this.deckTabsContainer.querySelector('.deck-tab.active');
        if (activeTab) {
            // console.log('🔧 使卡组页签可编辑');
            
            // 使卡组名称可点击编辑（不自动聚焦）
            this.makeDeckNameEditable(activeTab);
            
            // 设置封面点击事件
            this.makeDeckCoverEditable(activeTab);
            
        } else {
            // console.log('❌ 没有找到活动的卡组页签');
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
            
            // console.log('📝 卡组名被点击，进入编辑模式');
            
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
                // console.log('💾 保存卡组名:', nameInput.value);
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
            // console.log('🖼️ 设置封面点击事件');
            
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
                // console.log('🎯 封面点击事件触发');
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();
                
                // console.log('🎯 进入封面选择模式');
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
            
            // console.log('✅ 封面点击事件设置完成');
        }
    }

    // 新增：进入封面选择模式
    // 修改 enterCoverSelectionMode 方法（如果需要）
    enterCoverSelectionMode() {
        // console.log('🎯 进入封面选择模式 - 开始');
        
        // 设置模式状态
        this.deckManager.setSelectingCoverMode(true);
        this.isInAddMode = true;
        
        console.log('✅ 模式状态设置完成:', {
            isSelectingCover: this.deckManager.isSelectingCover,
            isInAddMode: this.isInAddMode
        });
        
        // 保存原始状态
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
        
        // console.log('✅ 原始状态保存完成');
        
        // 显示当前卡组内的卡牌，而不是所有卡牌
        const deckCards = this.deckManager.getDeckDisplayCards();
        // console.log('📊 卡组内卡牌数量:', deckCards.length);
        
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
        
        this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
        
        // 隐藏搜索栏和卡牌类型页签（封面选择模式下不需要）
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        
        // console.log('✅ 界面元素调整完成');
        
        // 强制重新设置回调
        this.forceSetCardGridCallbacks();
        
        // 渲染卡组内的卡牌
        this.cardGrid.render();
        
        // console.log('✅ 卡牌渲染完成');
        
        // 显示封面选择提示
        this.showCoverSelectionHint();
        
        // 通知 ButtonManager 切换到添加模式（封面选择也是添加模式的一种）
        if (window.buttonManager) {
            window.buttonManager.showAddMode();
        }
        
        // 添加全局点击事件，用于取消封面选择
        this.coverSelectionCancelHandler = (e) => {
            // 如果点击的不是卡牌，则取消封面选择
            if (!e.target.closest('.card')) {
                // console.log('❌ 点击非卡牌区域，取消封面选择');
                this.cancelCoverSelection();
            }
        };
        
        document.addEventListener('click', this.coverSelectionCancelHandler, true);
        
        // console.log('🎯 进入封面选择模式 - 完成');
    }

    // 确保 forceSetCardGridCallbacks 方法存在
    forceSetCardGridCallbacks() {
        if (this.cardGrid) {
            // console.log('🔧 强制设置 CardGrid 回调');
            this.cardGrid.onCardClick = this.handleCardClick.bind(this);
            this.cardGrid.onQuantityChange = this.handleQuantityChange.bind(this);
            // console.log('✅ CardGrid 回调设置完成');
        }
    }

    // 新增：取消封面选择
    // 修改 cancelCoverSelection 方法
    cancelCoverSelection() {
        // console.log('🚫 取消封面选择');
        this.deckManager.setSelectingCoverMode(false);
        this.isInAddMode = false;
        
        // 移除全局点击事件
        if (this.coverSelectionCancelHandler) {
            document.removeEventListener('click', this.coverSelectionCancelHandler, true);
            this.coverSelectionCancelHandler = null;
        }
        
        // 恢复原始状态
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
        }
        if (this.originalFilteredCards) {
            this.cardManager.filteredCards = this.originalFilteredCards;
        }
        
        // 隐藏搜索栏和卡牌类型页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        
        // 通知 ButtonManager 切换回编辑模式
        if (window.buttonManager) {
            window.buttonManager.showEditMode();
        }
        
        // 重新渲染当前卡组
        this.renderCurrentDeck();
        
        // console.log('✅ 封面选择已取消');
    }

    // 为选择封面进入添加模式
    enterAddModeForCover() {
        this.isInAddMode = true;
        this.cardManager.filteredCards = [...this.cardManager.cards];
        this.cardGrid.render();
        
        // 显示提示
        this.showCoverSelectionHint();
    }

    // 显示选择封面提示
    // 优化 showCoverSelectionHint 方法
    showCoverSelectionHint() {
        // 移除可能存在的旧提示
        const oldHint = document.querySelector('.cover-selection-hint');
        if (oldHint) oldHint.remove();
        
        const hint = document.createElement('div');
        hint.className = 'cover-selection-hint';
        hint.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 1.2rem; margin-bottom: 10px; font-weight: bold;">🎯 选择封面</div>
                <div style="font-size: 1rem; margin-bottom: 8px;">请点击选择一张卡牌作为卡组封面</div>
                <div style="font-size: 0.9rem; opacity: 0.8;">点击卡牌以外的区域取消选择</div>
            </div>
        `;
        hint.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.95);
            color: white;
            padding: 25px 35px;
            border-radius: 15px;
            z-index: 1001;
            font-size: 1.2rem;
            text-align: center;
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.6);
            border: 2px solid #FF9800;
            max-width: 300px;
        `;
        
        document.body.appendChild(hint);
        
        // 5秒后自动淡出
        setTimeout(() => {
            if (hint.parentNode) {
                hint.style.opacity = '0';
                hint.style.transition = 'opacity 0.5s ease';
                setTimeout(() => {
                    if (hint.parentNode) hint.remove();
                }, 500);
            }
        }, 5000);
    }

    // 进入添加模式 - 修复界面切换
    // 修改 enterAddMode 方法
    enterAddMode() {
        // console.log('🔍 进入添加模式');
        
        this.isInAddMode = true;
        
        // 显示搜索栏，隐藏卡组页签
        document.querySelector('.search-header').style.display = 'block';
        document.querySelector('.feature-tabs').style.display = 'block';
        if (this.deckTabsContainer) {
            this.deckTabsContainer.style.display = 'none';
        }
        
        // 显示所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
        
        this.cardGrid.render();
        
        // 通知 ButtonManager 切换到添加模式
        if (window.buttonManager) {
            window.buttonManager.showAddMode();
        }
        
        // console.log('🔍 进入添加模式完成');
    }

    // 修改 exitAddMode 方法
    exitAddMode() {
        // console.log('🚪 退出添加模式');
        this.isInAddMode = false;
        this.deckManager.setSelectingCoverMode(false);
        
        // 移除封面选择的全局点击事件
        if (this.coverSelectionCancelHandler) {
            document.removeEventListener('click', this.coverSelectionCancelHandler, true);
            this.coverSelectionCancelHandler = null;
        }
        
        // 恢复原始状态
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
        }
        if (this.originalFilteredCards) {
            this.cardManager.filteredCards = this.originalFilteredCards;
        }
        
        // 隐藏搜索栏和卡牌类型页签，显示卡组页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        if (this.deckTabsContainer) {
            this.deckTabsContainer.style.display = '';
        }
        
        // 通知 ButtonManager 切换回编辑模式
        if (window.buttonManager) {
            window.buttonManager.showEditMode();
        }
        
        // 强制重新渲染，确保数量显示规则更新
        this.renderCurrentDeck();
        
        // console.log('✅ 添加模式退出完成');
    }

    // 修改 exitEditMode 方法，清理删除按钮
    exitEditMode() {
        // console.log('🚪 退出编辑模式');
        this.deckManager.setEditingMode(false);
        this.isInAddMode = false;
        this.deckManager.setSelectingCoverMode(false);
        
        // 移除编辑模式CSS类
        document.body.classList.remove('deck-edit-mode');
        
        // 移除删除按钮
        this.removeDeleteButtonsFromDecks();
        
        // 移除封面选择的全局点击事件
        if (this.coverSelectionCancelHandler) {
            document.removeEventListener('click', this.coverSelectionCancelHandler, true);
            this.coverSelectionCancelHandler = null;
        }
        
        // 确保隐藏搜索栏和卡牌类型页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        
        // 确保显示卡组页签
        if (this.deckTabsContainer) {
            this.deckTabsContainer.style.display = '';
        }
        
        // 通知 ButtonManager 切换回卡组模式
        if (window.buttonManager) {
            window.buttonManager.showDeckMode();
        }
        
        // 重新渲染卡组页签
        this.renderDeckTabs();
        
        // 使用最新的卡组状态重置显示
        this.resetToDeckCards();
        
        // console.log('✅ 编辑模式退出完成');
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
            // console.log('❌ 没有找到当前卡组');
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
        // console.log('🗑️ 执行卡组删除...');
        
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

    // 新增：显示删除成功反馈
    showDeletionSuccess() {
        const feedback = document.createElement('div');
        feedback.className = 'deck-operation-feedback';
        feedback.textContent = '卡组删除成功';
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(76, 175, 80, 0.9);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            z-index: 1001;
            font-size: 1.1rem;
            font-weight: bold;
        `;
        
        document.body.appendChild(feedback);
        setTimeout(() => {
            if (feedback.parentNode) {
                feedback.parentNode.removeChild(feedback);
            }
        }, 2000);
    }

    // 新增：显示删除错误反馈
    showDeletionError() {
        const feedback = document.createElement('div');
        feedback.className = 'deck-operation-feedback';
        feedback.textContent = '删除失败，无法删除最后一个卡组';
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(244, 67, 54, 0.9);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            z-index: 1001;
            font-size: 1.1rem;
            font-weight: bold;
        `;
        
        document.body.appendChild(feedback);
        setTimeout(() => {
            if (feedback.parentNode) {
                feedback.parentNode.removeChild(feedback);
            }
        }, 3000);
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
        // console.log('🔄 为退出编辑模式重置卡牌管理器状态');
        
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
        
        // console.log('✅ 编辑模式状态重置完成，显示卡组卡牌:', this.cardManager.filteredCards.length);
    }

    // 在合适的位置添加这个方法（可以在 exitDeckMode 方法之前）
    simpleCardManagerReset() {
        // console.log('🔄 简化重置卡牌管理器状态');
        
        // 直接重置 filteredCards 为所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        // console.log('✅ 重置 filteredCards，数量:', this.cardManager.filteredCards.length);
        
        // 恢复原始方法（如果存在）
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
            // console.log('✅ 恢复 getDisplayCards 方法');
        } else {
            // 如果没有原始方法，使用默认方法
            this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
            // console.log('✅ 使用默认 getDisplayCards 方法');
        }
        
        // 恢复当前标签页（如果存在）
        if (this.originalCurrentTab) {
            this.cardManager.currentTab = this.originalCurrentTab;
            // console.log('✅ 恢复当前标签页:', this.originalCurrentTab);
        }
        
        // 通过 CardBrowser 重新加载当前标签页
        this.reloadCurrentTabViaCardBrowser();
    }

    // 在 DeckEditor.js 中彻底修复退出卡组模式的问题
    // DeckEditor.js - 确保 exitDeckMode 方法正确
    exitDeckMode() {
        // console.log('🔙 退出卡组模式');
        
        // 显示卡牌浏览相关元素
        document.querySelector('.search-header').style.display = 'block';
        document.querySelector('.feature-tabs').style.display = 'block';
        
        // 移除卡组界面元素
        this.deckTabsContainer?.remove();
        
        // 通知 ButtonManager 切换回浏览模式
        if (window.buttonManager) {
            window.buttonManager.showBrowseMode();
        }
        
        // 修复：确保调用正确的方法
        if (typeof this.simpleCardManagerReset === 'function') {
            this.simpleCardManagerReset();
        } else {
            console.error('❌ simpleCardManagerReset 方法不存在，使用备用重置');
            this.cardManager.filteredCards = [...this.cardManager.cards];
            if (this.cardBrowser && this.cardBrowser.loadCardData) {
                this.cardBrowser.loadCardData('宝可梦');
            }
        }
        
        // console.log('✅ 卡组模式退出完成');
    }

    // 新增：通过 CardBrowser 重新加载当前标签页
    reloadCurrentTabViaCardBrowser() {
        // console.log('🔄 通过 CardBrowser 重新加载当前标签页');
        
        // 获取当前标签页名称
        let tabName = '宝可梦';
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            tabName = activeTab.dataset.feature;
        } else if (this.originalCurrentTab) {
            tabName = this.originalCurrentTab;
        }
        
        // console.log('重新加载标签页:', tabName);
        
        // 通过 CardBrowser 重新加载数据
        if (this.cardBrowser && this.cardBrowser.loadCardData) {
            // console.log('✅ 调用 CardBrowser.loadCardData');
            this.cardBrowser.loadCardData(tabName);
        } else {
            // console.log('❌ CardBrowser 不可用，手动过滤和渲染');
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
        // console.log('🔄 直接重新加载当前标签页');
        
        // 获取当前标签页名称
        let tabName = '宝可梦';
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            tabName = activeTab.dataset.feature;
        } else if (this.originalCurrentTab) {
            tabName = this.originalCurrentTab;
        }
        
        // console.log('加载标签页:', tabName);
        
        // 直接过滤当前类型的卡牌
        this.cardManager.filteredCards = this.cardManager.cards.filter(card => 
            card.type === tabName
        );
        
        // console.log(`✅ 直接过滤后卡牌数量: ${this.cardManager.filteredCards.length}`);
        
        // 直接重新渲染网格
        if (this.cardGrid && this.cardGrid.render) {
            this.cardGrid.render();
            // console.log('✅ 卡牌网格直接重新渲染完成');
        }
        
        // 同时调用 CardBrowser 作为备份（但主要依赖直接重置）
        if (this.cardBrowser && this.cardBrowser.loadCardData) {
            // console.log('🔄 同时调用 CardBrowser.loadCardData 作为备份');
            setTimeout(() => {
                this.cardBrowser.loadCardData(tabName);
            }, 50);
        }
    }

    // DeckEditor.js 修改 setupModalPrevention 方法
    setupModalPrevention() {
        // 保存原始方法
        this.originalModalShow = this.modalView.show;
        
        // 覆盖 modalView.show
        this.modalView.show = (index) => {
            console.log('🛑 ModalView.show 被调用，检查模式:', {
                isInAddMode: this.isInAddMode,
                isEditing: this.deckManager.isEditing,
                isSelectingCover: this.deckManager.isSelectingCover
            });
            
            // 在编辑/添加模式下完全阻止模态框
            if (this.isInAddMode || this.deckManager.isEditing || this.deckManager.isSelectingCover) {
                // console.log('🚫 完全阻止模态框打开');
                return; // 直接返回，不执行任何操作
            }
            
            // console.log('✅ 允许模态框打开');
            this.originalModalShow.call(this.modalView, index);
        };
    }
}