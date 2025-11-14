// ptcg/js/ui/DeckTabs.js
export class DeckTabs {
    constructor(deckManager, onDeckSwitch, onDeckCreate) {
        this.deckManager = deckManager;
        this.onDeckSwitch = onDeckSwitch;
        this.onDeckCreate = onDeckCreate;
        
        this.tabsContainer = null;
        this.isEditing = false;
    }

    // 初始化
    init(container) {
        this.tabsContainer = container;
        this.render();
    }

    // 渲染卡组页签
    render() {
        if (!this.tabsContainer) return;

        this.tabsContainer.innerHTML = '';
        
        // 添加"新建卡组"按钮
        const addButton = this.createAddDeckButton();
        this.tabsContainer.appendChild(addButton);
        
        // 添加卡组页签
        this.deckManager.decks.forEach((deck, index) => {
            const tab = this.createDeckTab(deck, index);
            this.tabsContainer.appendChild(tab);
        });
    }

    // 创建新建卡组按钮
    createAddDeckButton() {
        const button = document.createElement('div');
        button.className = 'deck-tab add-deck-tab';
        button.innerHTML = '+';
        
        button.addEventListener('click', () => {
            if (!this.isEditing) {
                this.onDeckCreate();
            }
        });
        
        return button;
    }

    // 创建卡组页签
    createDeckTab(deck, index) {
        const tab = document.createElement('div');
        tab.className = `deck-tab ${index === this.deckManager.currentDeckIndex ? 'active' : ''}`;
        tab.dataset.index = index;
        
        // 卡组封面
        const cover = document.createElement('div');
        cover.className = 'deck-cover';
        if (deck.coverCardId) {
            const card = this.deckManager.cardManager.cards.find(c => c.id === deck.coverCardId);
            if (card) {
                const img = document.createElement('img');
                img.src = card.image;
                img.alt = deck.name;
                cover.appendChild(img);
            }
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
        tab.addEventListener('click', (e) => {
            if (!this.isEditing) {
                this.onDeckSwitch(index);
            }
        });
        
        return tab;
    }

    // 设置编辑模式
    setEditingMode(editing) {
        this.isEditing = editing;
        this.updateTabStates();
    }

    // 更新页签状态
    updateTabStates() {
        const tabs = this.tabsContainer.querySelectorAll('.deck-tab:not(.add-deck-tab)');
        tabs.forEach(tab => {
            if (this.isEditing) {
                tab.classList.add('disabled');
            } else {
                tab.classList.remove('disabled');
            }
        });
    }

    // 刷新显示
    refresh() {
        this.render();
    }
}