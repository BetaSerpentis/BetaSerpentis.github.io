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
        
        // 更新异常状态
        this.updateStatusIndicators(characterData.status);
        
        // 更新进度条
        this.updateStatBars(characterData.stats);
        
        // 更新能力值
        this.updateAbilities(characterData.abilities);
        
        // 更新操作按钮
        this.updateActionButtons(characterData.skills);
    },

    updateStatusIndicators: function(status) {
        const container = document.querySelector('.status-indicators-container');
        if (!container) return;
        
        // 清空现有状态
        container.innerHTML = '';
        
        // 如果没有状态或状态为正常，隐藏容器
        if (!status || status === '正常') {
            container.style.display = 'none';
            return;
        }
        
        // 显示容器
        container.style.display = 'flex';
        
        // 处理多个状态（用空格或逗号分隔）
        const statusList = status.split(/[,，\s]+/).filter(s => s && s !== '正常');
        
        if (statusList.length === 0) {
            container.style.display = 'none';
            return;
        }
        
        // 创建状态指示器项
        statusList.forEach(statusText => {
            const indicator = document.createElement('div');
            indicator.className = 'status-indicator-item';
            indicator.textContent = statusText;
            container.appendChild(indicator);
        });
    },

    updateStatBars: function(stats) {
        // 基准最大值
        const BASE_HP = 20;
        const BASE_MP = 20;
        const BASE_SANITY = 100;
        
        // 生命值
        const hpPercent = (stats.hp.current / stats.hp.max) * 100;
        const hpWidthPercent = (stats.hp.max / BASE_HP) * 100; // 条的总长度比例
        
        const hpProgress = document.querySelector('.health .stat-progress');
        const hpFill = document.querySelector('.health .stat-fill');
        
        if (hpProgress && hpFill) {
            hpProgress.style.width = hpWidthPercent + '%'; // 调整整个进度条容器的宽度
            hpFill.style.width = hpPercent + '%';
            document.querySelector('.health .stat-value').textContent = `${stats.hp.current}/${stats.hp.max}`;
        }
        
        // 法力值
        const mpPercent = (stats.mp.current / stats.mp.max) * 100;
        const mpWidthPercent = (stats.mp.max / BASE_MP) * 100;
        
        const mpProgress = document.querySelector('.mana .stat-progress');
        const mpFill = document.querySelector('.mana .stat-fill');
        
        if (mpProgress && mpFill) {
            mpProgress.style.width = mpWidthPercent + '%';
            mpFill.style.width = mpPercent + '%';
            document.querySelector('.mana .stat-value').textContent = `${stats.mp.current}/${stats.mp.max}`;
        }
        
        // 理智值（基准是100，所以通常都是100%宽度）
        const sanityPercent = (stats.sanity.current / stats.sanity.max) * 100;
        const sanityWidthPercent = (stats.sanity.max / BASE_SANITY) * 100;
        
        const sanityProgress = document.querySelector('.sanity .stat-progress');
        const sanityFill = document.querySelector('.sanity .stat-fill');
        
        if (sanityProgress && sanityFill) {
            sanityProgress.style.width = sanityWidthPercent + '%';
            sanityFill.style.width = sanityPercent + '%';
            document.querySelector('.sanity .stat-value').textContent = `${stats.sanity.current}/${stats.sanity.max}`;
        }
        
        console.log(`进度条宽度调整: HP=${hpWidthPercent}%, MP=${mpWidthPercent}%, Sanity=${sanityWidthPercent}%`);
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
        
        // 更新九维图填充区域
        this.updateNonagramFill(abilities);
    },

    updateNonagramFill: function(abilities) {
        const centerX = 100;
        const centerY = 100;
        const maxRadius = 80; // 最大半径（100%能力值时的半径）
        const baseRadius = 5; // 基础半径（0%能力值时的半径）
        const labelRadius = 100; // 标签位置的半径（在图形外部）
        
        // 能力顺序对应九边形的角顺序（从顶部开始顺时针）
        const abilityOrder = ['str', 'dex', 'con', 'app', 'pow', 'edu', 'siz', 'int', 'luk'];
        
        // 计算每个点的实际位置
        const actualPoints = abilityOrder.map((ability, index) => {
            const value = abilities[ability];
            
            // 计算角度（从顶部开始，顺时针）
            const angle = (index * 40 - 90) * Math.PI / 180; // 每40度一个点，从-90°开始（顶部）
            
            // 计算半径（根据能力值在基础半径和最大半径之间插值）
            const radius = baseRadius + (maxRadius - baseRadius) * (value / 100);
            
            // 计算坐标
            const x = centerX + radius * Math.cos(angle);
            const y = centerY + radius * Math.sin(angle);
            
            return [x, y];
        });
        
        // 生成SVG points字符串
        const pointsString = actualPoints.map(point => 
            Math.round(point[0]) + ',' + Math.round(point[1])
        ).join(' ');
        
        // 更新SVG填充区域
        const fillElement = document.querySelector('.nonagram-fill');
        if (fillElement) {
            fillElement.setAttribute('points', pointsString);
        }
        
        // 同时更新外框九边形（确保是正九边形）
        const maxPoints = abilityOrder.map((_, index) => {
            const angle = (index * 40 - 90) * Math.PI / 180;
            const x = centerX + maxRadius * Math.cos(angle);
            const y = centerY + maxRadius * Math.sin(angle);
            return [Math.round(x), Math.round(y)];
        });
        
        const gridElement = document.querySelector('.nonagram-grid');
        if (gridElement) {
            gridElement.setAttribute('points', maxPoints.map(point => point.join(',')).join(' '));
        }
        
        // 更新标签位置（确保三点一线）
        this.updateLabelPositions(abilities, centerX, centerY, labelRadius);
    },

    updateLabelPositions: function(abilities, centerX, centerY, labelRadius) {
        // 能力顺序对应九边形的角顺序（从顶部开始顺时针）
        const abilityOrder = ['str', 'dex', 'con', 'app', 'pow', 'edu', 'siz', 'int', 'luk'];
        
        abilityOrder.forEach((ability, index) => {
            // 计算角度（从顶部开始，顺时针）
            const angle = (index * 40 - 90) * Math.PI / 180;
            
            // 计算标签位置（在延长线上）
            const labelX = centerX + labelRadius * Math.cos(angle);
            const labelY = centerY + labelRadius * Math.sin(angle);
            
            // 更新标签位置
            const labelElement = document.querySelector(`[data-ability="${ability}"]`);
            if (labelElement) {
                // 转换为百分比位置（相对于280x280容器）
                const percentX = (labelX / 200 * 100); // 200是viewBox宽度
                const percentY = (labelY / 200 * 100); // 200是viewBox高度
                
                labelElement.style.left = percentX + '%';
                labelElement.style.top = percentY + '%';
                
                console.log(`${ability}: (${percentX.toFixed(1)}%, ${percentY.toFixed(1)}%) 角度: ${(angle * 180 / Math.PI).toFixed(1)}°`);
            }
        });
    },

    updateActionButtons: function(skills) {
        // 更新操作按钮内容
        const buttons = {
            'occupation-skills': skills.occupation,
            'hobby-skills': skills.hobby,
            'weapons': skills.weapon,
            'items': skills.item,
            'notes': skills.note,
            'magic': skills.magic
        };
        
        for (const [action, skill] of Object.entries(buttons)) {
            const btn = document.querySelector(`[data-action="${action}"] .btn-content`);
            if (btn && skill.name) {
                // 动态生成显示文本
                const displayText = skill.value !== null ? `${skill.name}：${skill.value}` : skill.name;
                btn.textContent = displayText;
                
                // 简单的文字长度判断
                this.adjustButtonText(btn, displayText);
            }
        }
    },

    // 简化版的文字调整
    adjustButtonText: function(buttonElement, text) {
        // 重置所有文字长度类
        buttonElement.classList.remove('long-text', 'very-long', 'extremely-long');
        
        // 根据文字长度添加相应类
        if (text.length > 12) {
            buttonElement.classList.add('extremely-long');
        } else if (text.length > 9) {
            buttonElement.classList.add('very-long');
        } else if (text.length > 6) {
            buttonElement.classList.add('long-text');
        }
    },
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