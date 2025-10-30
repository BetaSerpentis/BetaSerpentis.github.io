import { CardManager } from './core/CardManager.js';
import { SearchEngine } from './core/SearchEngine.js';
import { StorageService } from './core/StorageService.js';
import { ImageLoader } from './core/ImageLoader.js';

import { CardGrid } from './ui/CardGrid.js';
import { ModalView } from './ui/ModalView.js';
import { TabManager } from './ui/TabManager.js';
import { StatsManager } from './ui/StatsManager.js';

import { CardBrowser } from './features/CardBrowser.js';

import { initThreeJS, showSaveSuccess } from './utils/helpers.js';

class PTCGApp {
    constructor() {
        this.currentFeature = 'browser';
        this.init();
    }
    
    async init() {
        try {
            // 初始化Three.js背景
            initThreeJS();
            
            // 初始化核心服务
            this.storageService = new StorageService();
            this.cardManager = new CardManager(this.storageService);
            this.searchEngine = new SearchEngine(this.cardManager);
            this.imageLoader = new ImageLoader();
            
            // 初始化UI组件
            this.cardGrid = new CardGrid(
                this.cardManager, 
                this.imageLoader,
                null, // 将在CardBrowser中设置
                null  // 将在CardBrowser中设置
            );
            
            this.modalView = new ModalView(this.cardManager, this.imageLoader);
            this.statsManager = new StatsManager(this.cardManager, this.onStatsChange.bind(this));
            
            this.tabManager = new TabManager(
                this.cardManager, 
                this.onTabChange.bind(this)
            );
            
            // 初始化功能模块
            this.cardBrowser = new CardBrowser(
                this.cardManager,
                this.imageLoader,
                this.cardGrid,
                this.modalView,
                this.statsManager,
                this.searchEngine
            );
            
            // 初始化组件
            this.imageLoader.initLazyLoading();
            this.cardGrid.init();
            this.tabManager.init();
            this.statsManager.init();
            this.cardBrowser.init();
            
            // 绑定全局事件
            this.bindGlobalEvents();
            
            // 绑定功能切换
            this.bindFeatureTabs();
            
            // 加载初始数据
            await this.cardBrowser.loadCardData('宝可梦');
            
        } catch (error) {
            console.error('应用初始化失败:', error);
        }
    }
    
    // 绑定全局事件
    bindGlobalEvents() {
        // 导入按钮
        document.getElementById('import-button').addEventListener('click', () => {
            this.cardManager.importData((updatedCount) => {
                this.cardGrid.render();
                showSaveSuccess(`成功导入 ${updatedCount} 张卡牌数据，其他卡牌数量已归零`);
            });
        });
        
        // 导出按钮
        document.getElementById('export-button').addEventListener('click', () => {
            this.cardManager.exportData();
        });
    }
    
    // 绑定功能标签
    bindFeatureTabs() {
        const featureTabs = document.getElementById('feature-tabs');
        const featurePanels = document.querySelectorAll('.feature-panel');
        
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
                document.querySelector(`.feature-panel[data-feature="${feature}"]`).classList.add('active');
                
                this.currentFeature = feature;
            }
        });
    }
    
    // 页签切换回调
    async onTabChange(tabName) {
        await this.cardBrowser.loadCardData(tabName);
    }
    
    // 统计模式变化回调
    onStatsChange(isStatMode) {
        console.log(`统计模式: ${isStatMode ? '开启' : '关闭'}`);
    }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
    new PTCGApp();
});