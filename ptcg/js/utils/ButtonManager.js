// ptcg/js/utils/ButtonManager.js
export class ButtonManager {
    constructor(deckEditor, statsManager, cardManager, aiChatPanel = null) {
        this.deckEditor = deckEditor;
        this.statsManager = statsManager;
        this.cardManager = cardManager;
        this.aiChatPanel = aiChatPanel;
        this.container = null;
        this.importExportContainer = null;

        this.init();
    }

    init() {
        this.createContainers(); // 这里应该是复数
        this.showBrowseMode();
    }

    createContainers() {
        // 移除可能存在的旧容器
        const oldContainers = document.querySelectorAll('.global-button-container, .deck-button-container, .deck-init-button-container, .import-export-buttons');
        oldContainers.forEach(container => container.remove());

        // 创建主按钮容器（左下角）
        this.container = document.createElement('div');
        this.container.className = 'global-button-container';
        document.body.appendChild(this.container);

        // 创建导入导出容器（右下角）
        this.importExportContainer = document.createElement('div');
        this.importExportContainer.className = 'import-export-buttons';
        document.body.appendChild(this.importExportContainer);
    }

    // 浏览模式：AI分析 + 卡组 + 统计 + 导入导出
    showBrowseMode() {
        this.container.innerHTML = '';
        this.importExportContainer.innerHTML = '';

        // AI 分析按钮
        if (this.aiChatPanel) {
            const aiButton = this.createButton('AI分析', 'ai-button', () => {
                this.aiChatPanel.toggle();
            });
            this.container.appendChild(aiButton);
        }

        // 左下角：卡组 + 统计
        const deckButton = this.createButton('卡组', 'deck-button', () => {
            this.deckEditor.enterDeckMode();
        });

        const statsButton = this.createButton('统计', 'stats-button', () => {
            this.statsManager.toggleStatMode();
        });
        statsButton.id = 'stats-button';

        this.container.appendChild(deckButton);
        this.container.appendChild(statsButton);

        // 右下角：导入 + 导出（始终显示）
        this.createImportExportButtons();
    }

    // 卡组模式：AI分析 + 查卡 + 编辑 + 导入导出
    showDeckMode() {
        this.container.innerHTML = '';
        this.importExportContainer.innerHTML = '';

        // AI 分析按钮
        if (this.aiChatPanel) {
            const aiButton = this.createButton('AI分析', 'ai-button', () => {
                this.aiChatPanel.toggle();
            });
            this.container.appendChild(aiButton);
        }

        const searchButton = this.createButton('查卡', 'deck-search-button', () => {
            this.deckEditor.exitDeckMode();
        });

        const editButton = this.createButton('编辑', 'deck-edit-button', () => {
            this.deckEditor.enterEditMode();
        });

        this.container.appendChild(searchButton);
        this.container.appendChild(editButton);

        // 右下角：导入 + 导出（始终显示）
        this.createImportExportButtons();
    }

    // 编辑模式：新增 + 保存 + 导入导出
    showEditMode() {
        this.container.innerHTML = '';
        this.importExportContainer.innerHTML = '';

        const addButton = this.createButton('新增', 'deck-add-button', () => {
            this.deckEditor.enterAddMode();
        });

        const saveButton = this.createButton('保存', 'deck-save-button', () => {
            this.deckEditor.exitEditMode();
        });

        this.container.appendChild(addButton);
        this.container.appendChild(saveButton);

        // 右下角：导入 + 导出（始终显示）
        this.createImportExportButtons();
    }

    // 添加模式：完成 + 保存 + 导入导出
    showAddMode() {
        this.container.innerHTML = '';
        this.importExportContainer.innerHTML = '';

        const completeButton = this.createButton('完成', 'deck-complete-button', () => {
            this.deckEditor.exitAddMode();
        });

        const saveButton = this.createButton('保存', 'deck-save-button', () => {
            this.deckEditor.exitEditMode();
        });

        this.container.appendChild(completeButton);
        this.container.appendChild(saveButton);

        // 右下角：导入 + 导出（始终显示）
        this.createImportExportButtons();
    }

    // 创建导入导出按钮（右下角）
    createImportExportButtons() {
        const importButton = this.createButton('导入', 'import-button', () => {
            this.importAllData();
        });

        const exportButton = this.createButton('导出', 'export-button', () => {
            this.exportAllData();
        });

        this.importExportContainer.appendChild(importButton);
        this.importExportContainer.appendChild(exportButton);
    }

    // 新增：统一导出方法
    async exportAllData() {
        try {
            // console.log('📤 开始导出所有数据...');
            
            // 确保有 cardManager 和 deckManager 的引用
            if (!this.cardManager || !this.deckManager) {
                console.error('❌ CardManager 或 DeckManager 未初始化');
                return;
            }
            
            // 调用 StorageService 的统一导出方法
            await this.cardManager.storageService.exportAllData(this.cardManager, this.deckManager);
            
        } catch (error) {
            console.error('❌ 导出数据失败:', error);
            // 这里可以显示错误提示
        }
    }

    // 新增：统一导入方法
    importAllData() {
        try {
            // console.log('📥 开始导入所有数据...');
            
            // 确保有 cardManager 和 deckManager 的引用
            if (!this.cardManager || !this.deckManager) {
                console.error('❌ CardManager 或 DeckManager 未初始化');
                return;
            }
            
            // 调用 StorageService 的统一导入方法
            this.cardManager.storageService.importAllData(
                this.cardManager, 
                this.deckManager, 
                this.onImportComplete.bind(this)
            );
            
        } catch (error) {
            console.error('❌ 导入数据失败:', error);
        }
    }

    // 导入完成回调
    async onImportComplete(result) {
        // console.log('✅ 导入完成:', result);
        
        if (result.success) {
            // 显示成功消息
            this.showImportSuccess(result);
            
            // 强制重新加载当前数据
            await this.forceReloadAfterImport();
        } else {
            // 显示错误消息
            this.showImportError(result.error);
        }
    }

    // 导入后强制重新加载
    async forceReloadAfterImport() {
        // console.log('🔄 导入后强制重新加载数据...');
        
        try {
            // 方法1：通过 CardManager 重新加载当前数据
            if (this.cardManager && this.cardManager.reloadCurrentCardData) {
                await this.cardManager.reloadCurrentCardData();
                // console.log('✅ 卡牌数据重新加载完成');
            }
            
            // 方法2：通过 CardBrowser 重新加载（备用）
            if (this.deckEditor && this.deckEditor.cardBrowser) {
                const currentTab = this.cardManager.getCurrentTab();
                await this.deckEditor.cardBrowser.loadCardData(currentTab);
                // console.log('✅ 通过 CardBrowser 重新加载完成');
            }
            
            // 方法3：直接重新渲染网格
            if (this.deckEditor && this.deckEditor.cardGrid) {
                this.deckEditor.cardGrid.render();
                // console.log('✅ 卡牌网格重新渲染完成');
            }
            
            // 刷新卡组显示（如果在卡组模式下）
            if (this.deckEditor && this.deckEditor.deckTabsContainer) {
                this.deckEditor.renderDeckTabs();
                // console.log('✅ 卡组页签刷新完成');
            }
            
        } catch (error) {
            console.error('❌ 重新加载失败:', error);
        }
    }

    // 新增：显示导入成功消息
    showImportSuccess(result) {
        const message = result.message || `成功导入 ${result.cardsUpdated} 张卡牌和 ${result.decksUpdated} 个卡组`;
        
        // 使用现有的成功提示
        const successMsg = document.createElement('div');
        successMsg.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(76, 175, 80, 0.95);
            color: white;
            padding: 20px 30px;
            border-radius: 10px;
            font-size: 1.2rem;
            font-weight: bold;
            z-index: 10000;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        `;
        successMsg.textContent = message;
        
        document.body.appendChild(successMsg);
        
        setTimeout(() => {
            if (document.body.contains(successMsg)) {
                document.body.removeChild(successMsg);
            }
        }, 3000);
    }

    // 新增：显示导入错误消息
    showImportError(error) {
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(244, 67, 54, 0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 10px;
            font-size: 1.2rem;
            font-weight: bold;
            z-index: 10000;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        `;
        errorMsg.textContent = `导入失败: ${error}`;
        
        document.body.appendChild(errorMsg);
        
        setTimeout(() => {
            document.body.removeChild(errorMsg);
        }, 3000);
    }

    // 新增：导入后刷新显示
    refreshAfterImport() {
        // 刷新卡牌显示
        if (this.deckEditor && this.deckEditor.cardGrid) {
            this.deckEditor.cardGrid.render();
        }
        
        // 刷新卡组显示（如果在卡组模式下）
        if (this.deckEditor && this.deckEditor.deckTabsContainer) {
            this.deckEditor.renderDeckTabs();
        }
        
        // console.log('🔄 导入后界面已刷新');
    }

    createButton(text, className, onClick) {
        const button = document.createElement('button');
        button.className = `global-button ${className}`;
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    // 更新统计按钮状态
    updateStatsButton(isActive) {
        const statsButton = document.getElementById('stats-button');
        if (statsButton) {
            if (isActive) {
                statsButton.classList.add('active');
                statsButton.textContent = '完成';
            } else {
                statsButton.classList.remove('active');
                statsButton.textContent = '统计';
            }
        }
    }
}