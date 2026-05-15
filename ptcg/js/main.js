import { CardManager } from './core/CardManager.js';
import { SearchEngine } from './core/SearchEngine.js';
import { StorageService } from './core/StorageService.js';
import { ImageLoader } from './core/ImageLoader.js';

import { CardGrid } from './ui/CardGrid.js';
import { ModalView } from './ui/ModalView.js';
import { TabManager } from './ui/TabManager.js';
import { StatsManager } from './ui/StatsManager.js';

import { CardBrowser } from './features/CardBrowser.js';

//import { initThreeJS, showSaveSuccess } from './utils/helpers.js';

import { DeckManager } from './core/DeckManager.js';
import { DeckEditor } from './features/DeckEditor.js';

import { ButtonManager } from './utils/ButtonManager.js';
import { TouchManager } from './utils/TouchManager.js';

class PTCGApp {
    constructor() {
        this.currentFeature = 'browser';
        this.init();
    }
    
    // main.js - 确保 ImageLoader 正确初始化
    async init() {
        try {
            // 初始化Three.js背景
            //initThreeJS();
            
            // 初始化核心服务
            const touchManager = new TouchManager();
            this.touchManager = touchManager; // 保存到实例变量中

            this.storageService = new StorageService();
            this.cardManager = new CardManager(this.storageService);
            this.searchEngine = new SearchEngine(this.cardManager);
            this.imageLoader = new ImageLoader();

            // 确保输入框可以正常工作
            const searchInput = document.getElementById('search-input');
            if (searchInput) {
                touchManager.enableTouchForElement(searchInput);
            } 

            // 确保 ImageLoader 初始化完成
            // console.log('初始化 ImageLoader 懒加载');
            this.imageLoader.initLazyLoading();
            
            // 初始化卡组管理器
            this.deckManager = new DeckManager(this.storageService, this.cardManager);
            this.deckManager.init();
            
            // 先初始化基础的UI组件
            this.modalView = new ModalView(this.cardManager, this.imageLoader);
            this.statsManager = new StatsManager(this.cardManager, this.onStatsChange.bind(this));
            
            // 创建 CardGrid - 这次传入正确的回调
            this.cardGrid = new CardGrid(
                this.cardManager, 
                this.imageLoader,
                (index, button) => this.handleCardClick(index, button), // 统一处理卡牌点击
                (index, change) => this.handleQuantityChange(index, change) // 统一处理数量变化
            );

            // 确保 CardGrid 可以访问 deckManager
            this.cardGrid.deckManager = this.deckManager;

            // 先初始化 CardBrowser，确保它可用
            this.cardBrowser = new CardBrowser(
                this.cardManager,
                this.imageLoader,
                this.cardGrid,
                this.modalView,
                this.statsManager,
                this.searchEngine
            );
            
            // 然后初始化 TabManager（修改：需要传入 cardBrowser）
            this.tabManager = new TabManager(this.cardBrowser, this.cardManager);
            
            // 然后初始化 DeckEditor
            this.deckEditor = new DeckEditor(
                this.deckManager,
                this.cardManager,
                this.imageLoader,
                this.cardGrid,
                this.modalView
            );

            // 让 DeckEditor 可以访问 CardBrowser
            this.deckEditor.cardBrowser = this.cardBrowser;
            
            // 初始化组件
            this.cardGrid.init(); // 确保 CardGrid 初始化
            this.tabManager.init();
            this.statsManager.init();
            this.cardBrowser.init();

            // 初始化 ButtonManager
            this.buttonManager = new ButtonManager(
                this.deckEditor,
                this.statsManager,
                this.cardManager
            );

            // 确保 ButtonManager 可以访问 DeckManager
            this.buttonManager.deckManager = this.deckManager;

            // 设置为全局变量便于访问
            window.buttonManager = this.buttonManager;

            // 修改 StatsManager 的回调以使用 ButtonManager
            this.statsManager.onStatsChange = (isStatMode) => {
                this.buttonManager.updateStatsButton(isStatMode);
                this.onStatsChange(isStatMode);
            };
            
            // 绑定全局事件
            this.bindGlobalEvents();
            this.bindFeatureTabs();
                        
            // 加载初始数据
            await this.cardBrowser.loadCardData('宝可梦');
            
            console.log('✅ 应用初始化完成');
            
            // 首屏渲染完成后，后台逐批预加载（间隔 2s，避免连续 JSON parse 阻塞主线程）
            setTimeout(() => {
                this._lazyPreloadAllTypes();
            }, 2000);

        } catch (error) {
            console.error('应用初始化失败:', error);
        }
    }

    // 逐批后台预加载其他卡牌类型（不污染当前 cardManager 展示状态）
    async _lazyPreloadAllTypes() {
        const allTypes = ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'];
        for (const cardType of allTypes) {
            if (cardType === this.cardManager.getCurrentTab()) continue;
            try {
                // 保存当前状态，预加载后恢复
                const savedCards = this.cardManager.cards;
                const savedTab = this.cardManager.currentTab;
                await this.cardManager.loadCardData(cardType);
                this.cardManager.cards = savedCards;
                this.cardManager.currentTab = savedTab;
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.warn('预加载跳过:', cardType, e.message);
            }
        }
    }

    // ===== 新增：统一的卡牌点击处理 =====
    handleCardClick(index, button) {
        console.log('🔄 Main: 卡牌点击事件分发', { index, button });
        
        // 检查统计模式（最高优先级）
        if (this.statsManager.isStatModeActive()) {
            console.log('📊 Main: 分发到统计模式');
            const change = button === 'left' ? 1 : -1;
            const result = this.statsManager.updateCardQuantity(index, change);
            if (result) {
                this.cardGrid.updateCardQuantityDisplay(result.cardId, result.quantity);
            }
            return;
        }
        
        // 检查是否是卡组模式（显式状态，不再查 DOM）
        const isDeckMode = this.deckEditor && this.deckEditor.mode !== 'browse';
        
        if (isDeckMode) {
            console.log('🎴 Main: 分发到卡组编辑模式');
            this.deckEditor.handleCardClick(index, button);
        } else {
            console.log('🌐 Main: 分发到模态框');
            this.modalView.show(index);
        }
    }

    // ===== 新增：统一的数量变化处理 =====
    handleQuantityChange(index, change) {
        console.log('🔄 Main: 数量变化事件分发', { index, change });
        
        // 统计模式处理
        if (this.statsManager.isStatModeActive()) {
            console.log('📊 Main: 统计模式数量变化');
            const result = this.statsManager.updateCardQuantity(index, change);
            if (result) {
                this.cardGrid.updateCardQuantityDisplay(result.cardId, result.quantity);
            }
            return;
        }
        
        // 卡组模式处理（显式状态）
        const isDeckMode = this.deckEditor && this.deckEditor.mode !== 'browse';
        if (isDeckMode) {
            console.log('🎴 Main: 卡组模式数量变化');
            this.deckEditor.handleQuantityChange(index, change);
        }
    }

    // 绑定全局事件
    bindGlobalEvents() {
        // 绑定搜索按钮事件
        const searchButton = document.getElementById('search-button');
        const searchInput = document.getElementById('search-input');
        
        if (searchButton && this.cardBrowser) {
            searchButton.addEventListener('click', () => {
                this.cardBrowser.performSearch();
            });
        }
        
        if (searchInput && this.cardBrowser) {
            searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.cardBrowser.performSearch();
                }
            });
        }
    }
    
    // 绑定功能标签
    bindFeatureTabs() {
        const featureTabs = document.getElementById('feature-tabs');
        const featurePanels = document.querySelectorAll('.feature-panel');
        
        if (featureTabs) {
            featureTabs.addEventListener('click', (e) => {
                if (e.target.classList.contains('feature-tab')) {
                    const feature = e.target.dataset.feature;
                    
                    // 更新标签状态
                    featureTabs.querySelectorAll('.feature-tab').forEach(tab => {
                        tab.classList.remove('active');
                    });
                    e.target.classList.add('active');
                    
                    // 更新面板显示
                    featurePanels.forEach(panel => {
                        panel.classList.remove('active');
                    });
                    const targetPanel = document.querySelector(`.feature-panel[data-feature="${feature}"]`);
                    if (targetPanel) {
                        targetPanel.classList.add('active');
                    }
                    
                    this.currentFeature = feature;
                    
                    // 切换功能时重置世代筛选
                    if (feature === 'browser' && this.cardManager) {
                        // 如果是浏览器模式，重置为宝可梦类型
                        this.tabManager.switchTab('宝可梦');
                    } else if (this.cardManager) {
                        // 其他模式重置世代筛选
                        this.cardManager.resetGenerationFilter();
                    }
                }
            });
        }
    }
    
    // 页签切换回调（修改为异步）
    async onTabChange(tabName) {
        if (this.cardBrowser) {
            await this.cardBrowser.loadCardData(tabName);
        }
    }
    
    // 统计模式变化回调
    onStatsChange(isStatMode) {
        console.log(`统计模式: ${isStatMode ? '开启' : '关闭'}`);
        
        // 如果切换到非统计模式且当前是宝可梦类型，确保世代筛选正确应用
        if (!isStatMode && this.cardManager && this.tabManager) {
            const currentTab = this.cardManager.getCurrentTab();
            if (currentTab === '宝可梦') {
                this.tabManager.refreshFilters();
            }
        }
    }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
    new PTCGApp();
});