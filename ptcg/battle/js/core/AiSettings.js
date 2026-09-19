// js/core/AiSettings.js — 与 ptcg 共用的 AI 配置读取层
//
// ptcg 侧的定义（ptcg/js/utils/constants.js → STORAGE_KEYS）：
//   ptcg_ai_api_key       API Key
//   ptcg_ai_settings      AI 设置（模型选择等）
//   ptcg_ai_chat_history  聊天历史
//
// ptcgBattle 已并入 /ptcg/battle/，与卡牌库同源（同 scheme+host+port），
// 因此 localStorage 直接共享：玩家在卡牌库填过一次 API Key，对战侧即可直接使用，
// 无需重复配置，也无需导出/导入。
//
// 本模块只做「读取 + 监听」，写入仍由 ptcg 的 ApiKeyManager 负责，避免出现两处写入源。

/** 与 ptcg/js/utils/constants.js 的 STORAGE_KEYS 保持一致 */
export const AI_STORAGE_KEYS = {
  API_KEY: 'ptcg_ai_api_key',
  SETTINGS: 'ptcg_ai_settings',
  CHAT_HISTORY: 'ptcg_ai_chat_history',
};

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

/** 已停止服务的遗留模型名（2026-07-24）→ 现行模型名 */
const LEGACY_MODEL_MAP = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-coder': 'deepseek-flash',
};

/** 归一模型名（battle 侧不依赖 ptcg/js，因此内联同一份映射） */
export function normalizeAiModelName(model) {
  const name = typeof model === 'string' ? model.trim() : '';
  return name ? (LEGACY_MODEL_MAP[name] || name) : 'deepseek-flash';
}

/** 读取 API Key（未配置返回 null） */
export function getAiApiKey() {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const key = storage.getItem(AI_STORAGE_KEYS.API_KEY);
    return key && key.trim() ? key.trim() : null;
  } catch (e) {
    return null;
  }
}

/** 是否已配置 API Key */
export function hasAiApiKey() {
  return !!getAiApiKey();
}

/** 读取 AI 设置（与默认值合并；遗留模型名自动归一） */
export function getAiSettings(defaults = {}) {
  const storage = safeStorage();
  if (!storage) return { ...defaults };
  try {
    const raw = storage.getItem(AI_STORAGE_KEYS.SETTINGS);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...defaults };
    const merged = { ...defaults, ...parsed };
    // deepseek-chat / deepseek-reasoner 已于 2026-07-24 停止服务 → 归一为现行模型名
    if (merged.model) merged.model = normalizeAiModelName(merged.model);
    return merged;
  } catch (e) {
    return { ...defaults };
  }
}

/**
 * 监听 API Key 变化。
 * localStorage 的 storage 事件只在「其他标签页」触发，同页变更需由调用方在切换视图时重新读取。
 * @param {(key: string|null) => void} callback
 * @returns {() => void} 取消监听
 */
export function onAiKeyChange(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') return () => {};
  const handler = event => {
    if (event.key && event.key !== AI_STORAGE_KEYS.API_KEY) return;
    callback(getAiApiKey());
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/** 供 UI 显示的状态摘要 */
export function describeAiStatus() {
  const configured = hasAiApiKey();
  return configured
    ? { configured: true, message: 'AI 已就绪（共用卡牌库中的 API Key）' }
    : { configured: false, message: '未配置 API Key，请先在卡牌库中设置' };
}
