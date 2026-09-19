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

// AI 分析配置（DeepSeek API，OpenAI 兼容格式）
// 模型名说明（2026-09 官方）：deepseek-chat / deepseek-reasoner 两个遗留名已于 2026-07-24 停止服务，
// 现行模型名为 deepseek-flash（= DeepSeek-V4.1-Flash）与 deepseek-v4-pro。
// 遗留名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍被接受，但对应模型已退役（由 V4.1-Flash 服务）。
export const CONFIG_AI = {
    model: 'deepseek-flash',
    maxTokens: 4096,
    maxContextCards: 50,
    maxHistoryMessages: 20,
    apiEndpoint: 'https://api.deepseek.com/v1/chat/completions'
};

/** 已停止服务的遗留模型名 → 现行模型名（localStorage 里可能残留旧值） */
export const AI_LEGACY_MODEL_MAP = {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash',
    'deepseek-coder': 'deepseek-flash',
};

/** 把遗留模型名归一为现行模型名；非字符串/空值回退默认模型 */
export function normalizeAiModel(model) {
    const name = typeof model === 'string' ? model.trim() : '';
    if (!name) return CONFIG_AI.model;
    return AI_LEGACY_MODEL_MAP[name] || name;
}

// debug 关闭时跳过所有参数求值；需懒求值时传函数：debugLog(() => ['msg', obj])
export function debugLog(fnOrMsg, ...rest) {
    if (!CONFIG.debug) return;
    if (typeof fnOrMsg === 'function') {
        console.log(...fnOrMsg());
    } else {
        console.log(fnOrMsg, ...rest);
    }
}

// 本地存储键名 - 保持原有键名兼容，只添加新的卡组键
export const STORAGE_KEYS = {
    CARD_QUANTITIES: 'pokemonCardQuantities',  // 保持原有键名
    LAST_SAVED: 'lastSaved',                   // 保持原有键名
    DECKS: 'ptcg_decks',                       // 新增卡组存储键
    AI_API_KEY: 'ptcg_ai_api_key',             // AI API Key
    AI_CHAT_HISTORY: 'ptcg_ai_chat_history',   // AI 聊天历史
    AI_SETTINGS: 'ptcg_ai_settings'            // AI 设置（模型选择等）
};