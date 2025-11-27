// 花名册功能
const Roster = {
    init: function() {
        this.bindEvents();
        this.loadCharacters();
    },
    
    bindEvents: function() {
        // 新增调查员点击事件
        const addButton = document.getElementById('add-character');
        if (addButton) {
            addButton.addEventListener('click', this.handleAddCharacter.bind(this));
        }
        
        // 角色卡片点击事件
        document.addEventListener('click', (e) => {
            const characterCard = e.target.closest('.character-card');
            if (characterCard && characterCard.id !== 'add-character') {
                const characterId = characterCard.dataset.id;
                this.handleCharacterClick(characterId, characterCard);
            }
        });
    },
    
    handleAddCharacter: function() {
        console.log('打开创建角色页面');
        // 后续连接创建页面
        alert('后续将打开角色创建页面');
    },
    
    handleCharacterClick: function(characterId, cardElement) {
        console.log('查看角色详情:', characterId);
        
        // 获取角色数据
        const characterData = this.getCharacterData(characterId);
        if (characterData) {
            // 切换到角色详情页
            Pages.showCharacter(characterData);
        } else {
            console.error('未找到角色数据:', characterId);
        }
    },
    
    getCharacterData: function(characterId) {
        const mockCharacters = {
            '1': {
                id: '1',
                name: '李明',
                gender: '♂',
                age: 32,
                profession: '记者',
                status: '疯狂',
                activeEra: '1920年代',
                avatar: 'assets/images/placeholder-avatar.jpg',
                stats: {
                    hp: { current: 14, max: 20 },
                    mp: { current: 9, max: 20 },
                    sanity: { current: 30, max: 100 }
                },
                abilities: {
                    str: 65, dex: 70, con: 55, pow: 80, app: 60, 
                    luk: 45, siz: 75, int: 85, edu: 70
                },
                skills: {
                    occupation: '侦查：70',  // 直接在内容中包含冒号
                    hobby: '图书馆使用：60',
                    weapon: '手枪',
                    item: '医疗包', 
                    note: '线索记录',
                    magic: '深潜术'
                }
            },
            '2': {
                id: '2', 
                name: '王雪',
                gender: '♀',
                age: 28,
                profession: '图书管理员', 
                status: '正常',
                activeEra: '2010年代',
                avatar: 'assets/images/placeholder-avatar.jpg',
                stats: {
                    hp: { current: 18, max: 18 },
                    mp: { current: 15, max: 15 },
                    sanity: { current: 75, max: 75 }
                },
                abilities: {
                    str: 45, dex: 60, con: 50, pow: 70, app: 80, 
                    luk: 65, siz: 55, int: 90, edu: 85
                },
                skills: {
                    occupation: '图书馆使用：80',
                    hobby: '心理学：50', 
                    weapon: '',
                    item: '古籍',
                    note: '研究记录',
                    magic: ''
                }
            }
        };
        
        return mockCharacters[characterId];
    },
    
    loadCharacters: function() {
        const characters = Storage.getCharacters();
        console.log('加载角色数据:', characters);
        // 如果存储中没有数据，使用模拟数据
        if (characters.length === 0) {
            // 可以在这里初始化一些示例数据
        }
    }
};