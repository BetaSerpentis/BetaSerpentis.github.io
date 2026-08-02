// 周家财务 — IndexedDB 数据持久层（Android PWA 友好）

import { generateId } from './utils.js';

const DB_NAME = 'zhou-finance';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

/**
 * 打开数据库
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 读取全部条目，按日期降序 + 创建时间降序排列
 * @returns {Promise<Array>}
 */
export async function getAll() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result || [];
        entries.sort((a, b) => {
          if (a.date !== b.date) return b.date.localeCompare(a.date);
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        });
        resolve(entries);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('读取数据失败', e);
    return [];
  }
}

/**
 * 新增一条记录
 * @param {Object} entry - { date, type, amount, category, person }
 * @returns {Promise<Object>} 完整的 entry 对象
 */
export async function add(entry) {
  const full = {
    ...entry,
    id: generateId(),
    createdAt: new Date().toISOString()
  };
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.add(full);
      tx.oncomplete = () => resolve(full);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('保存数据失败', e);
    // 降级到 localStorage
    return fallbackAdd(full);
  }
}

/**
 * 删除一条记录
 * @param {string} id
 */
export async function remove(id) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('删除数据失败', e);
  }
}

/**
 * 导出数据为 JSON 字符串
 * @returns {Promise<string>}
 */
export async function exportData() {
  const entries = await getAll();
  return JSON.stringify(entries, null, 2);
}

// ===== localStorage 降级（IndexedDB 不可用时） =====

function getLSData() {
  try {
    const raw = localStorage.getItem('zhou-finance-entries');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveLSData(entries) {
  try { localStorage.setItem('zhou-finance-entries', JSON.stringify(entries)); } catch {}
}

function fallbackAdd(entry) {
  const all = getLSData();
  all.unshift(entry);
  saveLSData(all);
  return entry;
}
