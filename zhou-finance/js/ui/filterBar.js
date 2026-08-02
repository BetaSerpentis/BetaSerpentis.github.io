// 周家财务 — 筛选弹窗组件

import { CATEGORIES, PEOPLE } from '../constants.js';
import { getToday } from '../utils.js';

let currentFilters = {
  date: null,
  month: null,
  category: null,
  person: null
};

let onChangeCallback = null;

/**
 * 初始化筛选弹窗
 * @param {Function} callback
 */
export function init(callback) {
  onChangeCallback = callback;
}

/**
 * 获取当前筛选条件
 */
export function getFilters() {
  return { ...currentFilters };
}

/**
 * 打开筛选弹窗
 */
export function open() {
  const modal = document.getElementById('filter-modal');
  modal.classList.remove('hidden');
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.getElementById('filter-close').onclick = close;
  render();
}

function close() {
  document.getElementById('filter-modal').classList.add('hidden');
}

/**
 * 渲染筛选弹窗内容
 */
export function render() {
  const body = document.getElementById('filter-body');
  const hasActive = currentFilters.date || currentFilters.month || currentFilters.category || currentFilters.person;

  let html = '';

  // 日期筛选
  html += '<div class="filter-section"><div class="filter-section-title">📅 日期范围</div>';
  html += '<div class="filter-section-chips">';
  html += renderFilterChip('全部日期', !currentFilters.date && !currentFilters.month, 'date-all');
  html += renderFilterChip('今天', !!currentFilters.date, 'date-today');
  html += renderFilterChip('本月', !!currentFilters.month, 'date-month');
  html += '</div></div>';

  // 分类
  html += '<div class="filter-section"><div class="filter-section-title">🏷️ 分类</div>';
  html += '<div class="filter-section-chips">';
  html += renderFilterChip('全部分类', !currentFilters.category, 'cat-all');
  for (const cat of CATEGORIES) {
    html += renderFilterChip(cat.icon + ' ' + cat.label, currentFilters.category === cat.label, 'cat-' + cat.id);
  }
  html += '</div></div>';

  // 人员
  html += '<div class="filter-section"><div class="filter-section-title">👤 人员</div>';
  html += '<div class="filter-section-chips">';
  html += renderFilterChip('全部人员', !currentFilters.person, 'person-all');
  for (const p of PEOPLE) {
    html += renderFilterChip(p, currentFilters.person === p, 'person-' + p);
  }
  html += '</div></div>';

  // 操作按钮
  html += '<div style="display:flex;gap:12px;margin-top:16px">';
  if (hasActive) {
    html += '<button class="step-quick-btn" id="filter-clear" style="flex:1">✕ 清除筛选</button>';
  }
  html += '<button class="step-btn-next" id="filter-apply" style="flex:1;max-width:200px">确定</button>';
  html += '</div>';

  body.innerHTML = html;

  // 绑定事件
  body.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => handleChipClick(chip));
  });

  const clearBtn = body.querySelector('#filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    currentFilters = { date: null, month: null, category: null, person: null };
    render();
  });

  body.querySelector('#filter-apply')?.addEventListener('click', () => {
    close();
    if (onChangeCallback) onChangeCallback(currentFilters);
  });
}

function renderFilterChip(label, active, dataAction) {
  const cls = active ? 'filter-chip active' : 'filter-chip';
  return `<button class="${cls}" data-action="${dataAction}">${label}</button>`;
}

function handleChipClick(chip) {
  const action = chip.dataset.action;

  if (action === 'date-all') {
    currentFilters.date = null;
    currentFilters.month = null;
  } else if (action === 'date-today') {
    currentFilters.date = getToday();
    currentFilters.month = null;
  } else if (action === 'date-month') {
    currentFilters.date = null;
    const now = new Date();
    currentFilters.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
}
