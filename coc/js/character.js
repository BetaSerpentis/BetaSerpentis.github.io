// 角色详情页功能
const CharacterPage = {
    currentCharacter: null,
    
    init: function() {
        this.bindEvents();
    },
    
    bindEvents: function() {
        // 返回按钮
        const backButton = document.getElementById('back-button');
        if (backButton) {
            backButton.addEventListener('click', this.handleBack.bind(this));
        }
        
        // 状态区域点击事件
        document.addEventListener('click', (e) => {
            // 头像和基本信息
            if (e.target.closest('.avatar-info-group')) {
                this.handleBackgroundInfo();
            }
            // 状态进度条
            else if (e.target.closest('.stat-bar')) {
                const statType = e.target.closest('.stat-bar').classList[1];
                this.handleStatInfo(statType);
            }
            // 能力标签
            else if (e.target.closest('.ability-label')) {
                const ability = e.target.closest('.ability-label').dataset.ability;
                this.handleAbilityCheck(ability);
            }
            // 九维图中间区域
            else if (e.target.closest('.nonagram-chart')) {
                this.handleAbilityAdjust();
            }
            // 操作按钮
            else if (e.target.closest('.action-btn')) {
                const action = e.target.closest('.action-btn').dataset.action;
                this.handleActionClick(action);
            }
        });
        
        // 操作按钮长按事件
        document.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: true });
        document.addEventListener('touchend', this.handleTouchEnd.bind(this));
    },
    
    handleBack: function() {
        console.log('返回花名册');
        this.playPageTurnOut(() => {
            Pages.showRoster();
        });
    },
    
    handleBackgroundInfo: function() {
        console.log('打开角色背景信息');
        // 后续实现
    },
    
    handleStatInfo: function(statType) {
        console.log('打开状态信息:', statType);
        // 后续实现
    },
    
    handleAbilityCheck: function(ability) {
        console.log('能力判定:', ability);
        // 后续实现
    },
    
    handleAbilityAdjust: function() {
        console.log('能力调整');
        // 后续实现
    },
    
    handleActionClick: function(action) {
        console.log('技能检定:', action);
        // 后续实现
    },
    
    handleTouchStart: function(e) {
        const actionBtn = e.target.closest('.action-btn');
        if (actionBtn) {
            this.longPressTimer = setTimeout(() => {
                const action = actionBtn.dataset.action;
                this.handleActionLongPress(action);
            }, 800); // 800毫秒判定为长按
        }
    },
    
    handleTouchEnd: function(e) {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    },
    
    handleActionLongPress: function(action) {
        console.log('技能选择:', action);
        // 后续实现
    },
    
    playPageTurnIn: function(callback) {
        const page = document.getElementById('character-page');
        page.classList.add('turning-in');
        setTimeout(() => {
            page.classList.remove('turning-in');
            if (callback) callback();
        }, 600);
    },
    
    playPageTurnOut: function(callback) {
        const page = document.getElementById('character-page');
        page.classList.add('turning-out');
        setTimeout(() => {
            page.classList.remove('turning-out');
            if (callback) callback();
        }, 600);
    },
    
    show: function(characterData) {
        this.currentCharacter = characterData;
        this.playPageTurnIn(() => {
            // 更新页面数据
            this.updateCharacterData(characterData);
        });
    },
    
    updateCharacterData: function(characterData) {
        // 更新基本信息
        const nameElement = document.querySelector('.character-name');
        nameElement.textContent = characterData.name;
        document.querySelector('.avatar').alt = characterData.name;
        
        // 名字过长时缩小字号
        if (characterData.name.length > 6) {
            nameElement.classList.add('long');
        } else {
            nameElement.classList.remove('long');
        }
        
        // 更新状态指示器
        const statusIndicator = document.querySelector('.status-indicator');
        if (characterData.status && characterData.status !== '正常') {
            statusIndicator.textContent = characterData.status;
            statusIndicator.style.display = 'block';
        } else {
            statusIndicator.style.display = 'none';
        }
        
        // 更新进度条
        this.updateStatBars(characterData.stats);
        
        // 更新能力值
        this.updateAbilities(characterData.abilities);
        
        // 更新操作按钮
        this.updateActionButtons(characterData.skills);
    },

    updateStatBars: function(stats) {
        // 生命值
        const hpPercent = (stats.hp.current / stats.hp.max) * 100;
        document.querySelector('.health .stat-fill').style.width = hpPercent + '%';
        document.querySelector('.health .stat-value').textContent = `${stats.hp.current}/${stats.hp.max}`;
        
        // 法力值
        const mpPercent = (stats.mp.current / stats.mp.max) * 100;
        document.querySelector('.mana .stat-fill').style.width = mpPercent + '%';
        document.querySelector('.mana .stat-value').textContent = `${stats.mp.current}/${stats.mp.max}`;
        
        // 理智值
        const sanityPercent = (stats.sanity.current / stats.sanity.max) * 100;
        document.querySelector('.sanity .stat-fill').style.width = sanityPercent + '%';
        document.querySelector('.sanity .stat-value').textContent = `${stats.sanity.current}/${stats.sanity.max}`;
    },

    updateAbilities: function(abilities) {
        // 更新所有能力标签
        for (const [ability, value] of Object.entries(abilities)) {
            const label = document.querySelector(`[data-ability="${ability}"]`);
            if (label) {
                const abilityNames = {
                    str: '力量', dex: '敏捷', con: '体质', pow: '意志',
                    app: '外貌', luk: '幸运', siz: '体型', int: '智力', edu: '教育'
                };
                label.innerHTML = `${abilityNames[ability]}<br>${value}`;
            }
        }
    },

    updateActionButtons: function(skills) {
        // 更新操作按钮内容
        const buttons = {
            'occupation-skills': { 
                content: skills.occupation
            },
            'hobby-skills': { 
                content: skills.hobby
            },
            'weapons': { 
                content: skills.weapon
            },
            'items': { 
                content: skills.item
            },
            'notes': { 
                content: skills.note
            },
            'magic': { 
                content: skills.magic
            }
        };
        
        for (const [action, data] of Object.entries(buttons)) {
            const btn = document.querySelector(`[data-action="${action}"] .btn-content`);
            if (btn) {
                btn.textContent = data.content;
                // 统一使用 without-value 类，因为冒号已经在内容中了
                btn.className = 'btn-content without-value';
            }
        }
    }
};

// 页面路由管理
const Pages = {
    ROSTER: 'roster-page',
    CHARACTER: 'character-page',
    CREATOR: 'creator-page',
    
    showRoster: function() {
        this.hideAllPages();
        document.getElementById(this.ROSTER).classList.add('active');
    },
    
    showCharacter: function(characterData) {
        this.hideAllPages();
        document.getElementById(this.CHARACTER).classList.add('active');
        CharacterPage.show(characterData);
    },
    
    showCreator: function() {
        this.hideAllPages();
        document.getElementById(this.CREATOR).classList.add('active');
    },
    
    hideAllPages: function() {
        document.getElementById(this.ROSTER).classList.remove('active');
        document.getElementById(this.CHARACTER).classList.remove('active');
        document.getElementById(this.CREATOR).classList.remove('active');
    }
};