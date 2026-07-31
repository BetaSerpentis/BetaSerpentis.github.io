// 周家财务 — 分步记帐弹窗

import { CATEGORIES, PEOPLE } from '../constants.js';
import { getToday, formatDate, getWeekday, parseAmount } from '../utils.js';
import { add } from '../storage.js';
import { toast } from './confirmDialog.js';

const TOTAL_STEPS = 5; // 0:日期 1:类型 2:金额 3:分类 4:人员+确认

const state = {
  date: getToday(),
  type: 'expense',
  amount: '',
  category: null,
  person: null,
  step: 0
};

/**
 * 打开记帐弹窗
 */
export function open() {
  reset();
  show();
}

function reset() {
  state.date = getToday();
  state.type = 'expense';
  state.amount = '';
  state.category = null;
  state.person = null;
  state.step = 0;
}

function show() {
  document.getElementById('entry-modal').classList.remove('hidden');
  renderStep();
}

function close() {
  document.getElementById('entry-modal').classList.add('hidden');
}

function renderStep() {
  renderIndicator();
  renderBody();
  renderNav();
}

function renderIndicator() {
  const el = document.getElementById('step-indicator');
  let html = '';
  for (let i = 0; i < TOTAL_STEPS; i++) {
    let cls = 'step-dot';
    if (i < state.step) cls += ' done';
    else if (i === state.step) cls += ' current';
    html += `<div class="${cls}"></div>`;
  }
  el.innerHTML = html;
}

function renderBody() {
  const el = document.getElementById('step-body');
  switch (state.step) {
    case 0: el.innerHTML = renderDateStep(); break;
    case 1: el.innerHTML = renderTypeStep(); break;
    case 2: el.innerHTML = renderAmountStep(); break;
    case 3: el.innerHTML = renderCategoryStep(); break;
    case 4: el.innerHTML = renderConfirmStep(); break;
  }
  bindStepEvents();
}

function renderNav() {
  const el = document.getElementById('step-nav');
  const isFirst = state.step === 0;
  const isLast = state.step === TOTAL_STEPS - 1;
  const canNext = canProceed();

  let html = '';
  if (!isFirst) {
    html += '<button class="step-btn-prev" id="btn-prev">← 上一步</button>';
  }
  if (!isLast) {
    html += `<button class="step-btn-next" id="btn-next" ${canNext ? '' : 'disabled'}>下一步 →</button>`;
  } else {
    html += `<button class="step-btn-confirm" id="btn-confirm" ${canNext ? '' : 'disabled'}>✓ 确认记账</button>`;
  }
  el.innerHTML = html;

  // 绑定导航事件
  const prevBtn = el.querySelector('#btn-prev');
  const nextBtn = el.querySelector('#btn-next');
  const confirmBtn = el.querySelector('#btn-confirm');

  if (prevBtn) prevBtn.addEventListener('click', () => { state.step--; renderStep(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { state.step++; renderStep(); });
  if (confirmBtn) confirmBtn.addEventListener('click', submit);
}

// ====== 各步骤渲染 ======

function renderDateStep() {
  const disp = formatDate(state.date);
  const today = getToday();
  const isToday = state.date === today;
  const isPast = state.date < today;

  return `
    <div class="step-title">📅 选择日期</div>
    <div class="step-date-display">${state.date.split('-').join('年'.replace('2026-','2026'))}</div>
    <div class="step-date-weekday">${disp}</div>
    <div style="display:flex;gap:12px;margin-bottom:12px">
      <button class="filter-chip" id="step-date-yesterday" style="flex:1;justify-content:center">◀ 前一天</button>
      <button class="filter-chip ${isToday ? 'active' : ''}" id="step-date-today" style="flex:1;justify-content:center">今天</button>
      <button class="filter-chip" id="step-date-tomorrow" style="flex:1;justify-content:center" ${isPast ? '' : 'disabled'}>后一天 ▶</button>
    </div>
    <input type="date" id="step-date-input" value="${state.date}" max="${today}"
      style="width:100%;height:56px;font-size:20px;font-family:var(--font-family);border:2px solid var(--color-border);border-radius:12px;padding:0 16px;background:var(--color-surface);-webkit-appearance:none">
  `;
}

function renderTypeStep() {
  return `
    <div class="step-title">💰 收入还是支出？</div>
    <div style="display:flex;gap:12px;margin-top:16px">
      <button class="filter-chip select-chip-step ${state.type === 'expense' ? 'active' : ''}"
        id="step-type-expense" style="flex:1;height:80px;font-size:28px;justify-content:center">
        💸 支出
      </button>
      <button class="filter-chip select-chip-step ${state.type === 'income' ? 'active' : ''}"
        id="step-type-income" style="flex:1;height:80px;font-size:28px;justify-content:center">
        💵 收入
      </button>
    </div>
  `;
}

function renderAmountStep() {
  return `
    <div class="step-title">💲 输入金额</div>
    <div style="text-align:center;margin:16px 0">
      <span style="font-size:24px;color:var(--color-text-secondary)">¥</span>
      <input type="text" id="step-amount-input" inputmode="decimal" placeholder="0.00"
        value="${state.amount}"
        style="width:70%;height:80px;font-size:48px;font-family:var(--font-family);font-weight:700;
          text-align:center;border:none;border-bottom:3px solid var(--color-accent);
          background:transparent;color:var(--color-text);outline:none;-webkit-appearance:none">
    </div>
    <div style="text-align:center;font-size:16px;color:var(--color-text-muted)">
      输入数字，如 35.50
    </div>
  `;
}

function renderCategoryStep() {
  return `
    <div class="step-title">🏷️ 选择分类</div>
    <div class="chip-grid" style="margin-top:12px">
      ${CATEGORIES.map(c => `
        <button class="select-chip ${state.category === c.label ? 'selected' : ''}"
          data-category="${c.label}">
          <span class="chip-icon">${c.icon}</span>${c.label}
        </button>
      `).join('')}
    </div>
  `;
}

function renderConfirmStep() {
  const amount = parseAmount(state.amount);
  const amountClass = state.type;
  const typeLabel = state.type === 'income' ? '收入' : '支出';
  const catObj = CATEGORIES.find(c => c.label === state.category);

  return `
    <div class="step-title">✓ 确认信息</div>
    <div class="confirm-card">
      <div class="confirm-row">
        <span class="confirm-label">日期</span>
        <span class="confirm-value">${formatDate(state.date)}</span>
      </div>
      <div class="confirm-row">
        <span class="confirm-label">类型</span>
        <span class="confirm-value" style="color:${state.type === 'income' ? 'var(--color-income)' : 'var(--color-expense)'}">${typeLabel}</span>
      </div>
      <div class="confirm-row">
        <span class="confirm-label">金额</span>
        <span class="confirm-amount ${amountClass}">¥${amount.toFixed(2)}</span>
      </div>
      <div class="confirm-row">
        <span class="confirm-label">分类</span>
        <span class="confirm-value">${catObj ? catObj.icon : ''} ${state.category}</span>
      </div>
      <div class="confirm-row">
        <span class="confirm-label">经办人</span>
        <span class="confirm-value">${state.person}</span>
      </div>
    </div>
    <div style="margin-top:12px">
      <div class="step-title" style="font-size:var(--font-size-md);margin-bottom:8px">👤 经办人</div>
      <div class="chip-grid cols-4">
        ${PEOPLE.map(p => `
          <button class="select-chip ${state.person === p ? 'selected' : ''}"
            data-person="${p}">${p}</button>
        `).join('')}
      </div>
    </div>
  `;
}

// ====== 事件绑定 ======

function bindStepEvents() {
  switch (state.step) {
    case 0: bindDateEvents(); break;
    case 1: bindTypeEvents(); break;
    case 2: bindAmountEvents(); break;
    case 3: bindCategoryEvents(); break;
    case 4: bindConfirmEvents(); break;
  }
}

function bindDateEvents() {
  const today = getToday();

  document.getElementById('step-date-yesterday')?.addEventListener('click', () => {
    const d = new Date(state.date + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    state.date = formatYMD(d);
    renderStep();
  });

  document.getElementById('step-date-today')?.addEventListener('click', () => {
    state.date = getToday();
    renderStep();
  });

  document.getElementById('step-date-tomorrow')?.addEventListener('click', () => {
    const d = new Date(state.date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    if (d > new Date(today + 'T00:00:00')) return;
    state.date = formatYMD(d);
    renderStep();
  });

  document.getElementById('step-date-input')?.addEventListener('change', (e) => {
    state.date = e.target.value;
    renderStep();
  });
}

function bindTypeEvents() {
  document.getElementById('step-type-expense')?.addEventListener('click', () => {
    state.type = 'expense';
    renderStep();
  });
  document.getElementById('step-type-income')?.addEventListener('click', () => {
    state.type = 'income';
    renderStep();
  });
}

function bindAmountEvents() {
  const input = document.getElementById('step-amount-input');
  if (!input) return;
  input.addEventListener('input', () => {
    let val = input.value.replace(/[^\d.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
    if (parts.length === 2 && parts[1].length > 2) {
      val = parts[0] + '.' + parts[1].substring(0, 2);
    }
    input.value = val;
    state.amount = val;
    renderNav();
  });
  // 自动聚焦
  setTimeout(() => input.focus(), 100);
}

function bindCategoryEvents() {
  document.querySelectorAll('#step-body .select-chip[data-category]').forEach(chip => {
    chip.addEventListener('click', () => {
      state.category = chip.dataset.category;
      renderStep();
    });
  });
}

function bindConfirmEvents() {
  document.querySelectorAll('#step-body .select-chip[data-person]').forEach(chip => {
    chip.addEventListener('click', () => {
      state.person = chip.dataset.person;
      renderStep();
    });
  });
}

// ====== 工具函数 ======

function canProceed() {
  switch (state.step) {
    case 0: return !!state.date;
    case 1: return !!state.type;
    case 2: return parseAmount(state.amount) > 0;
    case 3: return !!state.category;
    case 4: return !!state.person && parseAmount(state.amount) > 0;
    default: return false;
  }
}

function formatYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function submit() {
  const amount = parseAmount(state.amount);
  if (amount <= 0 || !state.person) return;

  add({
    date: state.date,
    type: state.type,
    amount: amount,
    category: state.category,
    person: state.person
  });

  close();
  toast('✓ 记账成功');
  window.dispatchEvent(new CustomEvent('data-changed'));
}
