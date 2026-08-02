// 周家财务 — 筛选弹窗组件（即时生效、含自定义值）

import { CATEGORIES, PEOPLE } from '../constants.js';
import { getToday } from '../utils.js';
import { getAll } from '../storage.js';

let currentFilters = {
  date: null,
  month: null,
  category: null,
  person: null
};

let onChangeCallback = null;

export function init(callback) {
  onChangeCallback = callback;
}

export function getFilters() {
  return { ...currentFilters };
}

export async function open() {
  const modal = document.getElementById('filter-modal');
  modal.classList.remove('hidden');
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.getElementById('filter-close').onclick = close;
  await render();
}

function close() {
  document.getElementById('filter-modal').classList.add('hidden');
}

function apply() {
  if (onChangeCallback) onChangeCallback(currentFilters);
}

/**
 * 渲染筛选弹窗内容（含动态自定义值）
 */
export async function render() {
  const body = document.getElementById('filter-body');
  const hasActive = currentFilters.date || currentFilters.month || currentFilters.category || currentFilters.person;

  // 从数据中提取自定义分类和人员
  const allEntries = await getAll();
  const customCategories = new Set();
  const customPeople = new Set();
  const defaultLabels = new Set(CATEGORIES.map(c => c.label));
  const defaultPeople = new Set(PEOPLE);

  for (const e of allEntries) {
    if (!defaultLabels.has(e.category)) customCategories.add(e.category);
    if (!defaultPeople.has(e.person)) customPeople.add(e.person);
  }

  let html = '';

  // 日期筛选
  html += '<div class="filter-section"><div class="filter-section-title">📅 日期范围</div>';
  html += '<div class="filter-section-chips">';
  html += chip('全部日期', !currentFilters.date && !currentFilters.month, 'date-all');
  html += chip('今天', !!currentFilters.date, 'date-today');
  html += chip('本月', !!currentFilters.month, 'date-month');
  html += '</div></div>';

  // 分类
  html += '<div class="filter-section"><div class="filter-section-title">🏷️ 分类</div>';
  html += '<div class="filter-section-chips">';
  html += chip('全部分类', !currentFilters.category, 'cat-all');
  for (const cat of CATEGORIES) {
    html += chip(cat.icon + ' ' + cat.label, currentFilters.category === cat.label, 'cat-' + cat.id);
  }
  for (const c of [...customCategories].sort()) {
    html += chip('📝 ' + c, currentFilters.category === c, 'cat-custom-' + encodeURIComponent(c));
  }
  html += '</div></div>';

  // 人员
  html += '<div class="filter-section"><div class="filter-section-title">👤 人员</div>';
  html += '<div class="filter-section-chips">';
  html += chip('全部人员', !currentFilters.person, 'person-all');
  for (const p of PEOPLE) {
    html += chip(p, currentFilters.person === p, 'person-' + p);
  }
  for (const p of [...customPeople].sort()) {
    html += chip('📝 ' + p, currentFilters.person === p, 'person-custom-' + encodeURIComponent(p));
  }
  html += '</div></div>';

  // 底部：仅清除按钮
  if (hasActive) {
    html += '<div style="margin-top:16px;text-align:center">';
    html += '<button class="step-quick-btn" id="filter-clear" style="width:100%;max-width:280px;color:var(--color-accent);border-color:var(--color-accent)">✕ 清除全部筛选</button>';
    html += '</div>';
  }

  body.innerHTML = html;

  // 绑定 chip 点击 → 即时生效
  body.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      handleChipClick(chip);
    });
  });

  // 清除按钮 → 即时生效
  const clearBtn = body.querySelector('#filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      currentFilters = { date: null, month: null, category: null, person: null };
      apply();
      render();
    });
  }
}

function chip(label, active, dataAction) {
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
  } else if (action.startsWith('cat-custom-')) {
    const raw = action.replace('cat-custom-', '');
    currentFilters.category = decodeURIComponent(raw);
  } else if (action.startsWith('cat-')) {
    const catId = action.replace('cat-', '');
    const cat = CATEGORIES.find(c => c.id === catId);
    currentFilters.category = cat ? cat.label : null;
  } else if (action === 'person-all') {
    currentFilters.person = null;
  } else if (action.startsWith('person-custom-')) {
    const raw = action.replace('person-custom-', '');
    currentFilters.person = decodeURIComponent(raw);
  } else if (action.startsWith('person-')) {
    currentFilters.person = action.replace('person-', '');
  }

  // 即时生效
  apply();
  render();
}
