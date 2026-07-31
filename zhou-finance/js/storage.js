// 周家财务 — LocalStorage 数据持久层

import { STORAGE_KEY } from './constants.js';
import { generateId } from './utils.js';

/**
 * 读取全部条目，按日期降序 + 创建时间降序排列
 * @returns {Array}
 */
export function getAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    // 按日期降序、创建时间降序
    entries.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    return entries;
  } catch (e) {
    console.error('读取数据失败', e);
    return [];
  }
}

/**
 * 保存全部条目
 * @param {Array} entries
 */
function saveAll(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.error('保存数据失败', e);
    alert('存储空间不足，请导出数据后清理旧记录');
  }
}

/**
 * 新增一条记录
 * @param {Object} entry - { date, type, amount, category, person }
 * @returns {Object} 完整的 entry 对象
 */
export function add(entry) {
  const full = {
    ...entry,
    id: generateId(),
    createdAt: new Date().toISOString()
  };
  const all = getAll();
  all.unshift(full);
  saveAll(all);
  return full;
}

/**
 * 删除一条记录
 * @param {string} id
 */
export function remove(id) {
  const all = getAll();
  const filtered = all.filter(e => e.id !== id);
  saveAll(filtered);
}

/**
 * 更新一条记录
 * @param {string} id
 * @param {Object} entry
 */
export function update(id, entry) {
  const all = getAll();
  const idx = all.findIndex(e => e.id === id);
  if (idx === -1) return;
  all[idx] = { ...all[idx], ...entry };
  saveAll(all);
}

/**
 * 根据 ID 查找记录
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  return getAll().find(e => e.id === id);
}

/**
 * 导出数据为 JSON 字符串
 * @returns {string}
 */
export function exportData() {
  return JSON.stringify(getAll(), null, 2);
}

/**
 * 清空数据（危险操作）
 */
export function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
}
