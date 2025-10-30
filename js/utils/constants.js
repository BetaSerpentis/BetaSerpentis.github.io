// 卡牌类型配置
export const CARD_TYPES = {
    '宝可梦': {
        jsonFile: 'data/pokemon-cards.json',
        imagePath: 'images/',
        hasNumber: true
    },
    '支援者': {
        jsonFile: 'data/Supporter-cards.json',
        imagePath: 'images/',
        hasNumber: false
    },
    '物品': {
        jsonFile: 'data/Item-cards.json',
        imagePath: 'images/',
        hasNumber: false
    },
    '宝可梦道具': {
        jsonFile: 'data/PokemonTool-cards.json',
        imagePath: 'images/',
        hasNumber: false
    },
    '竞技场': {
        jsonFile: 'data/Stadium-cards.json',
        imagePath: 'images/',
        hasNumber: false
    },
    '基本能量': {
        jsonFile: 'data/BasicEnergy-cards.json',
        imagePath: 'images/',
        hasNumber: false
    },
    '特殊能量': {
        jsonFile: 'data/SpecialEnergy-cards.json',
        imagePath: 'images/',
        hasNumber: false
    }
};

// 应用配置
export const CONFIG = {
    batchSize: 50,
    modalDragThreshold: 80,
    imageRetryCount: 2,
    debounceTime: 500
};

// 本地存储键名
export const STORAGE_KEYS = {
    CARD_QUANTITIES: 'pokemonCardQuantities',
    LAST_SAVED: 'lastSaved'
};