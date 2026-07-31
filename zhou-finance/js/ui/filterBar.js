// 周家财务 — 筛选条组件

import { CATEGORIES, PEOPLE } from '../constants.js';
import { getToday, getCurrentMonth } from '../utils.js';

let currentFilters = {
  date: null,
  month: getCurrentMonth(),
  category: null,
  person: null
};

let onChangeCallback = null;

/**
 * 初始化筛选条
 * @param {Function} callback - 筛选条件变化时的回调
 */
export function init(callback) {
  onChangeCallback = callback;
  render();
}

/**
 * 获取当前筛选条件
 * @returns {Object}
 */
export function getFilters() {
  return { ...currentFilters };
}

/**
 * 渲染筛选条
 */
export function render() {
  const el = document.getElementById('filter-bar');
  const hasActive = currentFilters.date ||
    currentFilters.month !== getCurrentMonth() ||
    currentFilters.category ||
    currentFilters.person;

  let html = '';

  // 日期筛选
  html += '<div class="filter-group">';
  html += '<div class="filter-group-label">📅 日期</div>';
  html += '<div class="filter-chips">';
  html += renderChip('今天', !!currentFilters.date, 'date-today');
  html += renderChip('本月', currentFilters.month === getCurrentMonth() && !currentFilters.date, 'date-month');
  html += renderChip('全部', !currentFilters.date && currentFilters.month !== getCurrentMonth(), 'date-all');
  html += '</div></div>';

  // 分类筛选
  html += '<div class="filter-group">';
  html += '<div class="filter-group-label">🏷️ 分类</div>';
  html += '<div class="filter-chips">';
  html += renderChip('全部', !currentFilters.category, 'cat-all');
  for (const cat of CATEGORIES) {
    html += renderChip(cat.label, currentFilters.category === cat.label, `cat-${cat.id}`);
  }
  html += '</div></div>';

  // 人员筛选
  html += '<div class="filter-group">';
  html += '<div class="filter-group-label">👤 人员</div>';
  html += '<div class="filter-chips">';
  html += renderChip('全部', !currentFilters.person, 'person-all');
  for (const p of PEOPLE) {
    html += renderChip(p, currentFilters.person === p, `person-${p}`);
  }
  html += '</div></div>';

  // 清除筛选
  if (hasActive) {
    html += '<div class="filter-chips" style="margin-top:8px">';
    html += `<button class="filter-chip clear-btn" data-action="clear">✕ 清除筛选</button>`;
    html += '</div>';
  }

  el.innerHTML = html;

  // 绑定事件
  el.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => handleChipClick(chip));
  });
}

function renderChip(label, active, dataAction) {
  const cls = active ? 'filter-chip active' : 'filter-chip';
  return `<button class="${cls}" data-action="${dataAction}">${label}</button>`;
}

function handleChipClick(chip) {
  const action = chip.dataset.action;

  if (action === 'clear') {
    currentFilters = {
      date: null,
      month: getCurrentMonth(),
      category: null,
      person: null
    };
  } else if (action === 'date-today') {
    currentFilters.date = getToday();
    currentFilters.month = getCurrentMonth();
  } else if (action === 'date-month') {
    currentFilters.date = null;
    currentFilters.month = getCurrentMonth();
  } else if (action === 'date-all') {
    currentFilters.date = null;
    currentFilters.month = null;
  } else if (action === 'cat-all') {
    currentFilters.category = null;
  } else if (action.startsWith('cat-')) {
    const catId = action.replace('cat-', '');
    const cat = CATEGORIES.find(c => c.id === catId);
    currentFilters.category = cat ? cat.label : null;
  } else if (action === 'person-all') {
    currentFilters.person = null;
  } else if (action.startsWith('person-')) {
    currentFilters.person = action.replace('person-', '');
  }

  render();
  if (onChangeCallback) onChangeCallback(currentFilters);
}

/**
 * 重置筛选条件
 */
export function reset() {
  currentFilters = {
    date: null,
    month: getCurrentMonth(),
    category: null,
    person: null
  };
  render();
}
