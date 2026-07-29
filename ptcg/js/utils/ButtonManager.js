// ptcg/js/utils/ButtonManager.js
import { showToast } from './helpers.js';

export class ButtonManager {
    constructor(deckEditor, statsManager, cardManager, aiChatPanel = null, setFilterManager = null) {
        this.deckEditor = deckEditor;
        this.statsManager = statsManager;
        this.cardManager = cardManager;
        this.aiChatPanel = aiChatPanel;
        this.setFilterManager = setFilterManager;
        this.container = null;
        this.backdrop = null;
        this.menu = null;
        this.fabButton = null;
        this.isExpanded = false;

        this.init();
    }

    init() {
        this.createContainers();
        this.showBrowseMode();
    }

    createContainers() {
        // 移除可能存在的旧容器
        const oldContainers = document.querySelectorAll(
            '.fab-container, .global-button-container, .deck-button-container, .deck-init-button-container, .import-export-buttons'
        );
        oldContainers.forEach(container => container.remove());

        // 创建 FAB 容器
        this.container = document.createElement('div');
        this.container.className = 'fab-container';

        // 遮罩层（点击收起）
        this.backdrop = document.createElement('div');
        this.backdrop.className = 'fab-backdrop';
        this.backdrop.addEventListener('click', () => this.collapseMenu());

        // 菜单面板
        this.menu = document.createElement('div');
        this.menu.className = 'fab-menu';
        // 委托：点击菜单项自动收起
        this.menu.addEventListener('click', (e) => {
            if (e.target.closest('.fab-menu-item')) {
                this.collapseMenu();
            }
        });

        // FAB 触发按钮
        this.fabButton = document.createElement('button');
        this.fabButton.className = 'fab-button';
        this.fabButton.innerHTML = '&#9776;';
        this.fabButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
        });

        this.container.appendChild(this.menu);
        this.container.appendChild(this.fabButton);
        document.body.appendChild(this.backdrop);
        document.body.appendChild(this.container);
    }

    // ---------- 展开 / 收起 ----------

    toggleMenu() {
        this.isExpanded = !this.isExpanded;
        if (this.isExpanded) {
            this.container.classList.add('fab-expanded');
        } else {
            this.container.classList.remove('fab-expanded');
        }
    }

    collapseMenu() {
        this.isExpanded = false;
        this.container.classList.remove('fab-expanded');
    }

    // ---------- 模式切换 ----------

    showBrowseMode() {
        this.menu.innerHTML = '';

        if (this.aiChatPanel) {
            this.menu.appendChild(this.createButton('AI分析', 'ai-button', () => {
                this.aiChatPanel.toggle();
            }));
        }

        // 卡包筛选按钮
        if (this.setFilterManager) {
            this.menu.appendChild(this.createButton('卡包', 'setfilter-button', () => {
                this.setFilterManager.showSetList();
            }));
        }

        const deckButton = this.createButton('卡组', 'deck-button', () => {
            this.deckEditor.enterDeckMode();
        });
        const statsButton = this.createButton('统计', 'stats-button', () => {
            this.statsManager.toggleStatMode();
        });
        statsButton.id = 'stats-button';

        this.menu.appendChild(deckButton);
        this.menu.appendChild(statsButton);
        this.createImportExportButtons();
        this.collapseMenu();
    }

    showDeckMode() {
        this.menu.innerHTML = '';

        // 进入卡组模式时重置卡包筛选
        if (this.setFilterManager) this.setFilterManager.reset();

        if (this.aiChatPanel) {
            this.menu.appendChild(this.createButton('AI分析', 'ai-button', () => {
                this.aiChatPanel.toggle();
            }));
        }

        this.menu.appendChild(this.createButton('查卡', 'deck-search-button', () => {
            this.deckEditor.exitDeckMode();
        }));
        this.menu.appendChild(this.createButton('编辑', 'deck-edit-button', () => {
            this.deckEditor.enterEditMode();
        }));

        this.createImportExportButtons();
        this.collapseMenu();
    }

    showEditMode() {
        this.menu.innerHTML = '';

        this.menu.appendChild(this.createButton('新增', 'deck-add-button', () => {
            this.deckEditor.enterAddMode();
        }));
        this.menu.appendChild(this.createButton('保存', 'deck-save-button', () => {
            this.deckEditor.exitEditMode();
        }));

        this.createImportExportButtons();
        this.collapseMenu();
    }

    showAddMode() {
        this.menu.innerHTML = '';

        this.menu.appendChild(this.createButton('完成', 'deck-complete-button', () => {
            this.deckEditor.exitAddMode();
        }));
        this.menu.appendChild(this.createButton('保存', 'deck-save-button', () => {
            this.deckEditor.exitEditMode();
        }));

        this.createImportExportButtons();
        this.collapseMenu();
    }

    // ---------- 导入/导出（菜单底部，带分隔线） ----------

    createImportExportButtons() {
        const divider = document.createElement('div');
        divider.className = 'fab-menu-divider';
        this.menu.appendChild(divider);

        this.menu.appendChild(this.createButton('导入', 'import-button', () => {
            this.importAllData();
        }));
        this.menu.appendChild(this.createButton('导出', 'export-button', () => {
            this.exportAllData();
        }));
    }

    // ---------- 导入导出逻辑 ----------

    async exportAllData() {
        try {
            if (!this.cardManager || !this.deckManager) {
                console.error('❌ CardManager 或 DeckManager 未初始化');
                return;
            }
            await this.cardManager.storageService.exportAllData(this.cardManager, this.deckManager);
        } catch (error) {
            console.error('❌ 导出数据失败:', error);
        }
    }

    importAllData() {
        try {
            if (!this.cardManager || !this.deckManager) {
                console.error('❌ CardManager 或 DeckManager 未初始化');
                return;
            }
            this.cardManager.storageService.importAllData(
                this.cardManager,
                this.deckManager,
                this.onImportComplete.bind(this)
            );
        } catch (error) {
            console.error('❌ 导入数据失败:', error);
        }
    }

    async onImportComplete(result) {
        if (result.success) {
            this.showImportSuccess(result);
            await this.forceReloadAfterImport();
        } else {
            this.showImportError(result.error);
        }
    }

    async forceReloadAfterImport() {
        try {
            if (this.cardManager && this.cardManager.reloadCurrentCardData) {
                await this.cardManager.reloadCurrentCardData();
            }
            if (this.deckEditor && this.deckEditor.cardBrowser) {
                const currentTab = this.cardManager.getCurrentTab();
                await this.deckEditor.cardBrowser.loadCardData(currentTab);
            }
            if (this.deckEditor && this.deckEditor.cardGrid) {
                this.deckEditor.cardGrid.render();
            }
            if (this.deckEditor && this.deckEditor.deckTabsContainer) {
                this.deckEditor.renderDeckTabs();
            }
        } catch (error) {
            console.error('❌ 重新加载失败:', error);
        }
    }

    showImportSuccess(result) {
        const msg = result.message || `成功导入 ${result.cardsUpdated} 张卡牌和 ${result.decksUpdated} 个卡组`;
        showToast(msg, 'success', 3000);
    }

    showImportError(error) {
        showToast(`导入失败: ${error}`, 'error', 3000);
    }

    refreshAfterImport() {
        if (this.deckEditor && this.deckEditor.cardGrid) {
            this.deckEditor.cardGrid.render();
        }
        if (this.deckEditor && this.deckEditor.deckTabsContainer) {
            this.deckEditor.renderDeckTabs();
        }
    }

    // ---------- 工具方法 ----------

    createButton(text, className, onClick) {
        const button = document.createElement('button');
        button.className = `fab-menu-item ${className}`;
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

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
