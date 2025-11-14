// ptcg/js/features/DeckEditor.js
export class DeckEditor {
    constructor(deckManager, cardManager, imageLoader, cardGrid, modalView) {
        this.deckManager = deckManager;
        this.cardManager = cardManager;
        this.imageLoader = imageLoader;
        this.cardGrid = cardGrid;
        this.modalView = modalView;
        
        this.deckButton = null;
        this.searchButton = null;
        this.editButton = null;
        this.addButton = null;
        this.saveButton = null;
        this.completeButton = null;
        
        this.isInAddMode = false;
        this.deckTabsContainer = null;
        this.deckButtonContainer = null;
        
        this.init();
    }

    // 修改 init 方法，添加延迟设置回调
    // DeckEditor.js - 修复初始化方法
    init() {
        this.createDeckButton();
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
            console.log('🔧 强制设置 CardGrid 回调');
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

    // 创建卡组按钮 - 改为上下排列
    // 在 DeckEditor.js 中修改 createDeckButton 方法
    createDeckButton() {
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'deck-init-button-container';
        buttonContainer.style.cssText = `
            position: fixed;
            bottom: 90px;  // 调整位置，在统计按钮上方
            left: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 1000;
        `;
        
        this.deckButton = document.createElement('button');
        this.deckButton.className = 'deck-button';
        this.deckButton.textContent = '卡组';
        
        this.deckButton.addEventListener('click', () => {
            this.enterDeckMode();
        });
        
        buttonContainer.appendChild(this.deckButton);
        document.body.appendChild(buttonContainer);
    }

    // 进入卡组模式
    // DeckEditor.js - 修复 enterDeckMode 方法，确保正确保存状态
    enterDeckMode() {
        console.log('🔍 进入卡组模式，保存原始状态');
        
        // 在修改任何状态之前保存原始状态
        this.saveOriginalState();
        
        // 隐藏搜索栏，显示卡组页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        document.querySelector('.stats-button').style.display = 'none';
        
        // 创建卡组界面
        this.createDeckInterface();
        this.deckButton.style.display = 'none';
        
        // 渲染当前卡组
        this.renderCurrentDeck();
    }

    // DeckEditor.js - 修复 saveOriginalState 方法，确保保存完整状态
    saveOriginalState() {
        console.log('💾 保存原始状态');
        
        // 保存原始方法
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
        
        // 保存过滤卡牌
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        
        // 保存当前标签页
        this.originalCurrentTab = this.cardManager.currentTab;
        
        console.log('✅ 原始状态保存完成:', {
            filteredCardsCount: this.originalFilteredCards.length,
            currentTab: this.originalCurrentTab
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
        
        // 创建查卡按钮
        this.searchButton = document.createElement('button');
        this.searchButton.className = 'deck-search-button';
        this.searchButton.textContent = '查卡';
        this.searchButton.style.cssText = `
            padding: 15px 30px;
            background: #2196F3;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
        // 创建编辑按钮
        this.editButton = document.createElement('button');
        this.editButton.className = 'deck-edit-button';
        this.editButton.textContent = '编辑';
        this.editButton.style.cssText = `
            padding: 15px 30px;
            background: #FF9800;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
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

    // 渲染卡组页签 - 修复封面尺寸
    renderDeckTabs() {
        this.deckTabsContainer.innerHTML = '';
        
        // 添加新建卡组按钮
        const addButton = document.createElement('div');
        addButton.className = 'deck-tab-add';
        addButton.innerHTML = '+';
        
        addButton.addEventListener('click', () => {
            if (!this.deckManager.isEditing) {
                this.deckManager.createNewDeck();
                this.renderDeckTabs();
                this.renderCurrentDeck();
            }
        });
        
        this.deckTabsContainer.appendChild(addButton);
        
        // 添加卡组页签
        this.deckManager.decks.forEach((deck, index) => {
            const tab = this.createDeckTab(deck, index);
            this.deckTabsContainer.appendChild(tab);
        });
    }

    // 创建卡组页签 - 修复封面尺寸
    createDeckTab(deck, index) {
        const tab = document.createElement('div');
        tab.className = `deck-tab ${index === this.deckManager.currentDeckIndex ? 'active' : ''}`;
        if (this.deckManager.isEditing) {
            tab.classList.add('disabled');
        }
        
        // 卡组封面 - 改为5:7比例
        const cover = document.createElement('div');
        cover.className = 'deck-cover';
        
        if (deck.coverCardId) {
            const card = this.cardManager.cards.find(c => c.id === deck.coverCardId);
            if (card) {
                const img = document.createElement('img');
                img.src = card.image;
                img.alt = deck.name;
                cover.appendChild(img);
            }
        } else {
            cover.textContent = '暂无封面';
            cover.className += ' no-cover';
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
        
        // 绑定事件
        tab.addEventListener('click', () => {
            if (!this.deckManager.isEditing) {
                this.deckManager.switchDeck(index);
                this.renderDeckTabs();
                this.renderCurrentDeck();
            }
        });
        
        return tab;
    }

    // 渲染当前卡组 - 修复数据显示问题
    // 在 DeckEditor.js 中修复 renderCurrentDeck 方法
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
        };
        
        this.cardGrid.render();
    }

    // 处理卡牌点击 - 修复编辑模式逻辑
    // DeckEditor.js - 修复 handleCardClick 方法中的统计模式处理
    handleCardClick(index, button) {
        console.log('=== DeckEditor: 卡牌点击事件 ===');
        console.log('索引:', index, '按钮:', button);
        
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
            console.log('🖼️ 封面选择模式处理');
            const cards = this.cardManager.getDisplayCards();
            
            if (index < 0 || index >= cards.length) {
                console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            console.log(`✅ 设置封面: ${card.name} (ID: ${card.id})`);
            
            // 设置封面
            const success = this.deckManager.setDeckCover(card.id);
            console.log('封面设置结果:', success);
            
            this.deckManager.setSelectingCoverMode(false);
            
            // 移除全局点击事件
            if (this.coverSelectionCancelHandler) {
                document.removeEventListener('click', this.coverSelectionCancelHandler, true);
                this.coverSelectionCancelHandler = null;
            }
            
            this.renderDeckTabs();
            this.exitAddMode();
            return;
        }
        
        // 统计模式处理 - 在卡组模式之前检查
        if (isStatsMode && !isDeckMode) {
            console.log('📊 统计模式处理');
            
            // 获取当前显示的卡牌
            const cards = this.cardManager.getDisplayCards();
            if (index < 0 || index >= cards.length) {
                console.log('❌ 索引超出范围');
                return;
            }
            
            const card = cards[index];
            console.log('📊 统计模式操作卡牌:', card.name, 'ID:', card.id, '按钮:', button);
            
            if (button === 'left') {
                // 左键：增加数量
                console.log('➕ 统计模式增加数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, 1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            } else if (button === 'right') {
                // 右键：减少数量
                console.log('➖ 统计模式减少数量');
                const newQuantity = this.cardManager.updateCardQuantity(card.id, -1);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
                this.cardManager.debouncedSave();
            }
            return;
        }

        // 卡组添加模式
        if (isDeckAddMode || this.isInAddMode) {
            console.log('添加模式处理 - 执行添加卡牌逻辑');
            if (button === 'left') {
                console.log('左键点击 - 添加卡牌');
                this.addCardToDeck(index, 1);
            } else if (button === 'right') {
                console.log('右键点击 - 移除卡牌');
                this.addCardToDeck(index, -1);
            }
            return;
        }
        
        // 卡组编辑模式（非添加模式）
        if (isDeckEditMode && isDeckMode && !isDeckAddMode) {
            console.log('编辑模式处理');
            const deckCards = this.deckManager.getDeckDisplayCards();
            if (index < deckCards.length) {
                if (button === 'left') {
                    this.handleQuantityChange(index, 1);
                } else if (button === 'right') {
                    this.handleQuantityChange(index, -1);
                }
            } else {
                console.log('❌ 索引超出卡组范围');
            }
            return;
        }
        
        // 卡组浏览模式
        if (isDeckMode && !isDeckEditMode && !isDeckAddMode) {
            console.log('卡组浏览模式 - 打开模态框');
            this.modalView.show(index);
            return;
        }
        
        // 正常浏览模式
        console.log('正常模式 - 打开模态框');
        this.modalView.show(index);
    }

    // 新增：专门处理添加卡牌到卡组
    // DeckEditor.js 修复 addCardToDeck 方法
    addCardToDeck(index, change) {
        console.log('=== 开始添加卡牌到卡组 ===');
        
        // 获取当前显示的卡牌
        const cards = this.cardManager.getDisplayCards();
        console.log('总卡牌数量:', cards.length, '点击索引:', index);
        
        if (index < 0 || index >= cards.length) {
            console.log('❌ 索引超出范围');
            return;
        }
        
        const card = cards[index];
        console.log('🃏 操作卡牌:', card.name, 'ID:', card.id, '变化:', change);
        
        // 执行添加操作
        const result = this.deckManager.updateCardQuantity(card.id, change);
        console.log('✅ 添加操作结果:', result);
        
        if (result) {
            console.log('📈 卡牌数量更新:', result.quantity);
            // 更新显示
            this.updateAddModeCardDisplay(card.id, result.quantity);
        } else if (change > 0) {
            console.log('🆕 新卡牌添加到卡组');
            // 新卡牌，显示数量为1
            this.updateAddModeCardDisplay(card.id, 1);
        } else {
            console.log('❌ 添加操作失败');
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
        console.log('🔄 更新卡牌显示, ID:', cardId, '数量:', quantity);
        
        const cardElements = document.querySelectorAll('.card');
        console.log('找到卡牌元素数量:', cardElements.length);
        
        cardElements.forEach((cardElement) => {
            const cardIndex = parseInt(cardElement.dataset.index);
            const cards = this.cardManager.getDisplayCards();
            
            if (cardIndex < cards.length) {
                const card = cards[cardIndex];
                if (card && card.id === cardId) {
                    console.log(`🎯 更新卡牌显示: ${card.name}, 数量: ${quantity}`);
                    
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
                        console.log('✅ 设置数量显示:', quantity);
                    } else {
                        console.log('❌ 移除数量显示');
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
                console.log('🔄 需要重新渲染: 卡牌数量从', oldQuantity, '变为', newQuantity);
                this.renderCurrentDeck();
            } else {
                // 只需要更新数量显示
                console.log('📊 只更新数量显示: 卡牌数量从', oldQuantity, '变为', newQuantity);
                this.cardGrid.updateCardQuantityDisplay(card.id, newQuantity);
            }
        } else {
            // 卡牌被移除（数量减到0），需要重新渲染
            console.log('🗑️ 卡牌被移除，重新渲染');
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
        console.log('🔄 更新原始状态以反映卡组变化');
        
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

    // 修复 enterEditMode 方法，确保按钮正确创建
    enterEditMode() {
        console.log('🔄 进入编辑模式');
        this.deckManager.setEditingMode(true);
        
        // 强制设置回调，确保编辑模式点击有效
        this.forceSetCardGridCallbacks();
        
        // 更新卡组页签为可编辑状态
        this.makeDeckTabsEditable();
        
        // 使用强制刷新确保按钮正确
        this.forceRefreshButtons();
        
        console.log('✅ 编辑模式进入完成');
    }

    // 使卡组页签可编辑
    // DeckEditor.js - 修复封面设置相关方法
    // 修改 makeDeckTabsEditable 方法中的封面点击处理
    makeDeckTabsEditable() {
        const currentDeck = this.deckManager.getCurrentDeck();
        if (!currentDeck) {
            console.log('❌ 没有找到当前卡组');
            return;
        }
        
        const activeTab = this.deckTabsContainer.querySelector('.deck-tab.active');
        if (activeTab) {
            console.log('🔧 使卡组页签可编辑');
            
            // 使卡组名称可编辑
            const nameElement = activeTab.querySelector('.deck-name');
            const originalName = nameElement.textContent;
            
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = originalName;
            nameInput.className = 'deck-name-input';
            
            nameInput.addEventListener('blur', () => {
                this.deckManager.updateDeckName(nameInput.value);
                this.renderDeckTabs();
            });
            
            nameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    nameInput.blur();
                }
            });
            
            nameElement.replaceWith(nameInput);
            nameInput.focus();
            nameInput.select();
            
            // 修复封面点击事件 - 不使用克隆，直接添加事件
            const coverElement = activeTab.querySelector('.deck-cover');
            coverElement.style.cursor = 'pointer';
            coverElement.title = '点击选择封面';
            coverElement.style.border = '2px dashed #FF9800';
            
            console.log('🖼️ 设置封面点击事件');
            
            // 移除之前的事件监听器（通过克隆来清除）
            const newCoverElement = coverElement.cloneNode(true);
            coverElement.parentNode.replaceChild(newCoverElement, coverElement);
            
            // 为新元素添加事件
            newCoverElement.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('🎯 封面被点击，进入封面选择模式');
                this.enterCoverSelectionMode();
            });
            
            console.log('✅ 封面点击事件设置完成');
        } else {
            console.log('❌ 没有找到活动的卡组页签');
        }
    }

    // 新增：进入封面选择模式
    // DeckEditor.js - 修复封面选择模式的处理
    enterCoverSelectionMode() {
        console.log('🎯 进入封面选择模式');
        this.deckManager.setSelectingCoverMode(true);
        this.isInAddMode = true;
        
        // 保存原始状态
        this.originalFilteredCards = [...this.cardManager.filteredCards];
        this.originalGetDisplayCards = this.cardManager.getDisplayCards;
        
        // 显示所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
        
        // 显示搜索栏和卡牌类型页签
        document.querySelector('.search-header').style.display = 'block';
        document.querySelector('.feature-tabs').style.display = 'block';
        
        // 强制重新设置回调
        this.forceSetCardGridCallbacks();
        
        // 渲染所有卡牌
        this.cardGrid.render();
        
        // 显示封面选择提示
        this.showCoverSelectionHint();
        
        // 添加全局点击事件，用于取消封面选择
        this.coverSelectionCancelHandler = (e) => {
            // 如果点击的不是卡牌，则取消封面选择
            if (!e.target.closest('.card')) {
                console.log('❌ 点击非卡牌区域，取消封面选择');
                this.cancelCoverSelection();
            }
        };
        
        document.addEventListener('click', this.coverSelectionCancelHandler, true);
    }

    // 确保 forceSetCardGridCallbacks 方法存在
    forceSetCardGridCallbacks() {
        if (this.cardGrid) {
            console.log('🔧 强制设置 CardGrid 回调');
            this.cardGrid.onCardClick = this.handleCardClick.bind(this);
            this.cardGrid.onQuantityChange = this.handleQuantityChange.bind(this);
            console.log('✅ CardGrid 回调设置完成');
        }
    }

    // 新增：取消封面选择
    cancelCoverSelection() {
        console.log('🚫 取消封面选择');
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
        
        // 隐藏搜索栏和卡牌类型页签
        document.querySelector('.search-header').style.display = 'none';
        document.querySelector('.feature-tabs').style.display = 'none';
        
        this.renderCurrentDeck();
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
    // DeckEditor.js 改进封面选择提示
    showCoverSelectionHint() {
        // 移除可能存在的旧提示
        const oldHint = document.querySelector('.cover-selection-hint');
        if (oldHint) oldHint.remove();
        
        const hint = document.createElement('div');
        hint.className = 'cover-selection-hint';
        hint.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 1.2rem; margin-bottom: 10px;">请点击选择一张卡牌作为封面</div>
                <div style="font-size: 0.9rem; opacity: 0.8;">点击卡牌以外的区域取消</div>
            </div>
        `;
        hint.style.cssText = `
            position: fixed;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 10px;
            z-index: 1001;
            font-size: 1.2rem;
            text-align: center;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;
        
        document.body.appendChild(hint);
        
        // 5秒后自动消失
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

    // DeckEditor.js - 修复 createEditModeButtons 方法，确保新增按钮正确绑定
    createEditModeButtons() {
        console.log('🔄 创建编辑模式按钮');
        
        this.deckButtonContainer.innerHTML = '';
        
        // 新增按钮
        this.addButton = document.createElement('button');
        this.addButton.className = 'deck-add-button';
        this.addButton.textContent = '新增';
        this.addButton.style.cssText = `
            padding: 15px 30px;
            background: #2196F3;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
        // 保存按钮
        this.saveButton = document.createElement('button');
        this.saveButton.className = 'deck-save-button';
        this.saveButton.textContent = '保存';
        this.saveButton.style.cssText = `
            padding: 15px 30px;
            background: #FF9800;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
        // 绑定事件 - 确保新增按钮正确绑定
        this.addButton.addEventListener('click', () => {
            console.log('➕ 新增按钮被点击');
            this.enterAddMode();
        });
        
        this.saveButton.addEventListener('click', () => {
            console.log('💾 保存按钮被点击');
            this.exitEditMode();
        });
        
        this.deckButtonContainer.appendChild(this.addButton);
        this.deckButtonContainer.appendChild(this.saveButton);
        
        console.log('✅ 编辑模式按钮创建完成');
    }

    // 进入添加模式 - 修复界面切换
    // DeckEditor.js - 修复按钮问题的完整方案
    enterAddMode() {
        console.log('🔍 进入添加模式 - 调试信息开始');
        
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
        
        // 使用强制刷新确保按钮正确
        this.forceRefreshButtons();
        
        console.log('🔍 进入添加模式 - 调试信息结束');
    }

    // 添加强制刷新按钮的方法
    forceRefreshButtons() {
        console.log('🔄 强制刷新按钮');
        
        // 清空按钮容器
        this.deckButtonContainer.innerHTML = '';
        
        // 根据当前模式创建正确的按钮
        if (this.isInAddMode) {
            this.createAddModeButtons();
        } else if (this.deckManager.isEditing) {
            this.createEditModeButtons();
        } else {
            this.createDeckModeButtons();
        }
        
        // 验证按钮是否正确创建
        console.log('强制刷新后按钮状态:', {
            按钮数量: this.deckButtonContainer.children.length,
            第一个按钮文本: this.deckButtonContainer.children[0]?.textContent,
            第二个按钮文本: this.deckButtonContainer.children[1]?.textContent
        });
    }

    // 确保 createAddModeButtons 方法正确工作
    createAddModeButtons() {
        console.log('🔄 创建添加模式按钮');
        
        // 清空按钮容器
        this.deckButtonContainer.innerHTML = '';
        
        // 完成按钮
        this.completeButton = document.createElement('button');
        this.completeButton.className = 'deck-complete-button';
        this.completeButton.textContent = '完成';
        this.completeButton.style.cssText = `
            padding: 15px 30px;
            background: #4CAF50;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
        // 保存按钮
        this.saveInAddButton = document.createElement('button');
        this.saveInAddButton.className = 'deck-save-in-add-button';
        this.saveInAddButton.textContent = '保存';
        this.saveInAddButton.style.cssText = `
            padding: 15px 30px;
            background: #FF9800;
            border: none;
            border-radius: 25px;
            color: white;
            font-weight: bold;
            font-size: 1.1rem;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;
        
        // 绑定事件 - 使用箭头函数确保正确的this绑定
        this.completeButton.addEventListener('click', (e) => {
            console.log('✅ 完成按钮被点击');
            e.stopPropagation();
            this.exitAddMode();
        });
        
        this.saveInAddButton.addEventListener('click', (e) => {
            console.log('💾 保存按钮被点击');
            e.stopPropagation();
            this.exitEditMode();
        });
        
        // 添加到容器
        this.deckButtonContainer.appendChild(this.completeButton);
        this.deckButtonContainer.appendChild(this.saveInAddButton);
        
        console.log('✅ 添加模式按钮创建完成');
    }

    // 修复 exitAddMode 方法，确保也能正确回到编辑模式
    exitAddMode() {
        console.log('🚪 退出添加模式');
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
        
        // 关键修复：重新创建编辑模式按钮，回到编辑界面
        this.createEditModeButtons();
        
        // 强制重新渲染，确保数量显示规则更新
        this.renderCurrentDeck();
        
        console.log('✅ 添加模式退出完成');
    }

    // 修复 exitEditMode 方法，确保使用最新的卡组状态
    exitEditMode() {
        console.log('🚪 退出编辑模式');
        this.deckManager.setEditingMode(false);
        this.isInAddMode = false;
        this.deckManager.setSelectingCoverMode(false);
        
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
        
        // 重新创建卡组模式按钮
        this.createDeckModeButtons();
        
        // 重新渲染卡组页签
        this.renderDeckTabs();
        
        // 使用最新的卡组状态重置显示
        this.resetToDeckCards();
        
        console.log('✅ 编辑模式退出完成');
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
        console.log('🔄 为退出编辑模式重置卡牌管理器状态');
        
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
        
        console.log('✅ 编辑模式状态重置完成，显示卡组卡牌:', this.cardManager.filteredCards.length);
    }

    // 创建卡组模式按钮
    createDeckModeButtons() {
        this.deckButtonContainer.innerHTML = '';
        this.deckButtonContainer.appendChild(this.searchButton);
        this.deckButtonContainer.appendChild(this.editButton);
    }

    // 修复 exitDeckMode 方法，确保彻底恢复
    exitDeckMode() {
        console.log('🔙 退出卡组模式，恢复原始状态');
        
        // 显示卡牌浏览相关元素
        document.querySelector('.search-header').style.display = 'block';
        document.querySelector('.feature-tabs').style.display = 'block';
        document.querySelector('.stats-button').style.display = 'block';
        
        // 移除卡组界面元素
        this.deckTabsContainer?.remove();
        this.deckButtonContainer?.remove();
        
        // 显示卡组按钮
        this.deckButton.style.display = 'block';
        
        // 彻底重置卡牌管理器状态
        this.forceResetCardManagerState();
        
        console.log('✅ 卡组模式退出完成');
    }

    // 新增：简化版状态重置
    simpleResetCardManagerState() {
        console.log('🔄 简化重置卡牌管理器状态');
        
        // 直接重置 filteredCards 为所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        console.log('✅ 重置 filteredCards，数量:', this.cardManager.filteredCards.length);
        
        // 恢复原始方法（如果存在）
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
            console.log('✅ 恢复 getDisplayCards 方法');
        }
        
        // 恢复当前标签页（如果存在）
        if (this.originalCurrentTab) {
            this.cardManager.currentTab = this.originalCurrentTab;
            console.log('✅ 恢复当前标签页:', this.originalCurrentTab);
        }
        
        // 直接通过 CardBrowser 重新加载数据，只调用一次
        this.directReloadCurrentTab();
    }

    // 修复 directReloadCurrentTab 方法
    directReloadCurrentTab() {
        console.log('🔄 直接重新加载当前标签页');
        
        // 获取当前活跃的标签页，如果找不到使用保存的原始标签页
        let tabName = '宝可梦'; // 默认值
        
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            tabName = activeTab.dataset.feature;
        } else if (this.originalCurrentTab) {
            tabName = this.originalCurrentTab;
        }
        
        console.log('加载标签页:', tabName);
        
        // 直接调用 CardBrowser 重新加载数据
        if (this.cardBrowser) {
            this.cardBrowser.loadCardData(tabName);
        } else {
            // 如果 CardBrowser 不可用，直接渲染
            this.cardGrid.render();
        }
    }

    // 修复 forceResetCardManagerState 方法
    forceResetCardManagerState() {
        console.log('🔄 强制重置卡牌管理器状态');
        
        // 方法1：直接重置 filteredCards 为所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        console.log('✅ 重置 filteredCards，数量:', this.cardManager.filteredCards.length);
        
        // 方法2：恢复原始方法（如果存在）
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
            console.log('✅ 恢复 getDisplayCards 方法');
        }
        
        // 方法3：恢复当前标签页（如果存在）
        if (this.originalCurrentTab) {
            this.cardManager.currentTab = this.originalCurrentTab;
            console.log('✅ 恢复当前标签页:', this.originalCurrentTab);
        }
        
        // 方法4：直接通过 CardBrowser 重新加载数据
        this.directReloadCurrentTab();
    }

    // 新增：带重试的强制重新加载
    forceReloadCurrentTabWithRetry() {
        console.log('🔄 带重试的强制重新加载当前标签页');
        
        // 第一次尝试
        this.forceReloadCurrentTab();
        
        // 第二次尝试（延迟，确保第一次完成）
        setTimeout(() => {
            console.log('🔄 第二次重试加载');
            this.cardManager.filteredCards = [...this.cardManager.cards];
            this.forceReloadCurrentTab();
        }, 200);
        
        // 第三次尝试（作为保险）
        setTimeout(() => {
            console.log('🔄 第三次保险加载');
            this.cardManager.filteredCards = [...this.cardManager.cards];
            if (this.cardBrowser) {
                this.cardBrowser.cardGrid.render();
            }
        }, 500);
    }

    // 修复 forceReloadCurrentTab 方法
    forceReloadCurrentTab() {
        console.log('🔄 强制重新加载当前标签页');
        
        // 强制重置卡牌管理器状态
        this.cardManager.filteredCards = [...this.cardManager.cards];
        
        // 获取当前活跃的标签页
        const activeTab = document.querySelector('.feature-tab.active');
        if (activeTab) {
            const tabName = activeTab.dataset.feature;
            console.log('重新加载标签页:', tabName);
            
            // 调用 CardBrowser 重新加载数据
            if (this.cardBrowser) {
                this.cardBrowser.loadCardData(tabName);
            } else {
                console.warn('⚠️ CardBrowser 未找到，手动重新渲染');
                this.cardGrid.render();
            }
        } else {
            console.warn('⚠️ 未找到活跃的标签页，使用默认标签页');
            // 使用默认标签页
            if (this.cardBrowser) {
                this.cardBrowser.loadCardData('宝可梦');
            } else {
                console.warn('⚠️ CardBrowser 未找到，手动重新渲染');
                this.cardGrid.render();
            }
        }
    }

    // DeckEditor.js - 修复 resetCardManagerState 方法，确保完全恢复
    resetCardManagerState() {
        console.log('🔄 重置卡牌管理器状态');
        
        // 强制重置 filteredCards 为所有卡牌
        this.cardManager.filteredCards = [...this.cardManager.cards];
        console.log('✅ 强制重置 filteredCards，数量:', this.cardManager.filteredCards.length);
        
        // 恢复原始方法（如果存在）
        if (this.originalGetDisplayCards) {
            this.cardManager.getDisplayCards = this.originalGetDisplayCards;
            console.log('✅ 恢复 getDisplayCards 方法');
        } else {
            // 如果没有保存的原始方法，使用默认方法
            this.cardManager.getDisplayCards = () => this.cardManager.filteredCards;
            console.log('✅ 使用默认 getDisplayCards 方法');
        }
        
        // 恢复当前标签页（如果存在）
        if (this.originalCurrentTab) {
            this.cardManager.currentTab = this.originalCurrentTab;
            console.log('✅ 恢复当前标签页:', this.originalCurrentTab);
        } else {
            console.warn('⚠️ 没有保存的当前标签页');
        }
        
        console.log('🔄 卡牌管理器状态重置完成');
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
                console.log('🚫 完全阻止模态框打开');
                return; // 直接返回，不执行任何操作
            }
            
            console.log('✅ 允许模态框打开');
            this.originalModalShow.call(this.modalView, index);
        };
    }
}