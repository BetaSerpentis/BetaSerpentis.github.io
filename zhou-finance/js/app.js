// 周家财务 — 主入口

import { getAll } from './storage.js';
import { filterEntries } from './model.js';
import { getCurrentMonth } from './utils.js';
import * as summaryBar from './ui/summaryBar.js';
import * as filterBar from './ui/filterBar.js';
import * as recordList from './ui/recordList.js';
import * as entryModal from './ui/entryForm.js';

let currentFilters = {
  date: null,
  month: getCurrentMonth(),
  category: null,
  person: null
};

/**
 * 刷新整个账单视图
 */
function refreshRecords() {
  const allEntries = getAll();
  const filtered = filterEntries(allEntries, currentFilters);
  summaryBar.render(currentFilters, filtered);
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
function onDataChanged() {
  filterBar.render();
  refreshRecords();
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
function init() {
  // 初始化筛选条
  filterBar.init(onFilterChange);

  // 汇总条点击展开/折叠筛选
  document.getElementById('summary-bar').addEventListener('click', () => {
    const filterBarEl = document.getElementById('filter-bar');
    filterBarEl.classList.toggle('expanded');
  });

  // "记一笔"按钮
  document.getElementById('fab-add').addEventListener('click', () => {
    entryModal.open();
  });

  // 数据变更事件监听
  window.addEventListener('data-changed', onDataChanged);

  // 注册 Service Worker
  registerSW();

  // 初始渲染
  filterBar.render();
  refreshRecords();
}

// 启动应用
document.addEventListener('DOMContentLoaded', init);
