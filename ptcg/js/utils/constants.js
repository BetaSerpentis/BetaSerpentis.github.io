// constants.js
// 卡牌类型配置
export const CARD_TYPES = {
    '宝可梦': {
        idxFile: 'data_fast/pokemon.idx.tsv',
        searchFile: 'data_fast/pokemon.search.tsv',
        filterFile: 'data_fast/pokemon.filter.tsv',
        imagePath: 'images/',
        hasNumber: true
    },
    '支援者': {
        idxFile: 'data_fast/supporter.idx.tsv',
        searchFile: 'data_fast/supporter.search.tsv',
        filterFile: 'data_fast/supporter.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    },
    '物品': {
        idxFile: 'data_fast/item.idx.tsv',
        searchFile: 'data_fast/item.search.tsv',
        filterFile: 'data_fast/item.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    },
    '宝可梦道具': {
        idxFile: 'data_fast/pokemon-tool.idx.tsv',
        searchFile: 'data_fast/pokemon-tool.search.tsv',
        filterFile: 'data_fast/pokemon-tool.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    },
    '竞技场': {
        idxFile: 'data_fast/stadium.idx.tsv',
        searchFile: 'data_fast/stadium.search.tsv',
        filterFile: 'data_fast/stadium.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    },
    '基本能量': {
        idxFile: 'data_fast/basic-energy.idx.tsv',
        searchFile: 'data_fast/basic-energy.search.tsv',
        filterFile: 'data_fast/basic-energy.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    },
    '特殊能量': {
        idxFile: 'data_fast/special-energy.idx.tsv',
        searchFile: 'data_fast/special-energy.search.tsv',
        filterFile: 'data_fast/special-energy.filter.tsv',
        imagePath: 'images/',
        hasNumber: false
    }
};

// 应用配置
export const CONFIG = {
    batchSize: 50,
    modalDragThreshold: 80,
    imageRetryCount: 2,
    debounceTime: 500,
    debug: false
};

export function debugLog(...args) {
    if (CONFIG.debug) {
        console.log(...args);
    }
}

// 本地存储键名 - 保持原有键名兼容，只添加新的卡组键
export const STORAGE_KEYS = {
    CARD_QUANTITIES: 'pokemonCardQuantities',  // 保持原有键名
    LAST_SAVED: 'lastSaved',                   // 保持原有键名  
    DECKS: 'ptcg_decks'                        // 新增卡组存储键
};