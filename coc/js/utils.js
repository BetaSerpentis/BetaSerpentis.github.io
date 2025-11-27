// 工具函数
const Utils = {
    // 生成UUID
    generateId: function() {
        return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    },
    
    // 防抖函数
    debounce: function(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
};

// 数据存储管理
const Storage = {
    KEY: 'coc-characters',
    
    getCharacters: function() {
        const data = localStorage.getItem(this.KEY);
        return data ? JSON.parse(data) : [];
    },
    
    saveCharacters: function(characters) {
        localStorage.setItem(this.KEY, JSON.stringify(characters));
    },
    
    addCharacter: function(character) {
        const characters = this.getCharacters();
        characters.unshift(character); // 新角色添加到最前面
        this.saveCharacters(characters);
        return characters;
    }
};