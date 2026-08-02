// 周家财务 — 主入口

import { getAll } from './storage.js';
import { filterEntries } from './model.js';
import { getCurrentMonth } from './utils.js';
import * as summaryBar from './ui/summaryBar.js';
import * as filterModal from './ui/filterBar.js';
import * as recordList from './ui/recordList.js';
import * as entryModal from './ui/entryForm.js';

// 默认筛选：显示全部（不限定月份）
let currentFilters = {
  date: null,
  month: null,
  category: null,
  person: null
};

/**
 * 刷新整个账单视图
 */
async function refreshRecords() {
  const allEntries = await getAll();
  const filtered = filterEntries(allEntries, currentFilters);
  await summaryBar.render(currentFilters, filtered);
  recordList.render(filtered);
}

/**
 * 处理筛选变化
 */
function onFilterChange(filters) {
  currentFilters = filters;
  refreshRecords();
}

/**
 * 处理数据变更
 */
async function onDataChanged() {
  filterModal.render();
  await refreshRecords();
}

/**
 * 注册 Service Worker
 */
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then(r => console.log('SW registered:', r.scope))
        .catch(e => console.warn('SW registration skipped:', e));
    });
  }
}

/**
 * 初始化应用
 */
async function init() {
  // 初始化筛选弹窗
  filterModal.init(onFilterChange);

  // 汇总条点击无反应（筛选已移到弹窗），不再展开/折叠

  // "记一笔"按钮
  document.getElementById('fab-add').addEventListener('click', () => {
    entryModal.open();
  });

  // 数据变更事件监听
  window.addEventListener('data-changed', onDataChanged);

  // 注册 Service Worker
  registerSW();

  // 初始渲染
  await refreshRecords();
}

// 启动应用
document.addEventListener('DOMContentLoaded', init);
