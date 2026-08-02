// 周家财务 — 分步记帐弹窗（6 步）

import { CATEGORIES, PEOPLE } from '../constants.js';
import { getToday, formatDate, parseAmount } from '../utils.js';
import { add } from '../storage.js';
import { toast } from './confirmDialog.js';

const TOTAL_STEPS = 6; // 0:日期 1:类型 2:金额 3:分类 4:人员 5:确认

const state = {
  date: getToday(),
  type: 'expense',
  amount: '',
  category: null,
  person: null,
  customCategory: '',
  customPerson: '',
  step: 0
};

export function open() {
  state.date = getToday();
  state.type = 'expense';
  state.amount = '';
  state.category = null;
  state.person = null;
  state.customCategory = '';
  state.customPerson = '';
  state.step = 0;
  const modal = document.getElementById('entry-modal');
  modal.classList.remove('hidden');
  // 点击外部关闭
  modal.onclick = (e) => { if (e.target === modal) close(); };
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
    case 4: el.innerHTML = renderPersonStep(); break;
    case 5: el.innerHTML = renderConfirmStep(); break;
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
    html += `<button class="step-btn-confirm" id="btn-confirm" ${canNext ? '' : 'disabled'}>✓ 确认</button>`;
  }
  el.innerHTML = html;

  const prevBtn = el.querySelector('#btn-prev');
  const nextBtn = el.querySelector('#btn-next');
  const confirmBtn = el.querySelector('#btn-confirm');

  if (prevBtn) prevBtn.addEventListener('click', () => { state.step--; renderStep(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { state.step++; renderStep(); });
  if (confirmBtn) confirmBtn.addEventListener('click', submit);
}

// ====== 步骤 0：日期 ======
function renderDateStep() {
  const today = getToday();
  const d = new Date(state.date + 'T00:00:00');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[d.getDay()];

  return `
    <div class="step-title">📅 选择日期</div>
    <div style="text-align:center;margin-bottom:16px">
      <input type="date" id="step-date-input" value="${state.date}" max="${today}"
        style="width:100%;height:64px;font-size:28px;font-family:var(--font-family);
          text-align:center;border:3px solid var(--color-accent);border-radius:16px;
          padding:0 16px;background:var(--color-surface);color:var(--color-accent);
          font-weight:700;-webkit-appearance:none;appearance:none;letter-spacing:2px">
      <div style="font-size:22px;color:var(--color-text-secondary);margin-top:8px">${weekday}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="step-quick-btn" id="step-date-yesterday">◀ 前一天</button>
      <button class="step-quick-btn" id="step-date-today">今天</button>
      <button class="step-quick-btn" id="step-date-tomorrow">后一天 ▶</button>
    </div>
  `;
}

// ====== 步骤 1：类型 ======
function renderTypeStep() {
  return `
    <div class="step-title">💰 收入还是支出？</div>
    <div style="display:flex;gap:12px;margin-top:16px">
      <button class="step-type-btn expense-btn ${state.type === 'expense' ? 'selected' : ''}"
        id="step-type-expense">💸 支出</button>
      <button class="step-type-btn income-btn ${state.type === 'income' ? 'selected' : ''}"
        id="step-type-income">💵 收入</button>
    </div>
  `;
}

// ====== 步骤 2：金额 ======
function renderAmountStep() {
  return `
    <div class="step-title">💲 输入金额</div>
    <div style="text-align:center;margin:16px 0">
      <span style="font-size:28px;color:var(--color-text-secondary)">¥</span>
      <input type="text" id="step-amount-input" inputmode="decimal" placeholder="0.00"
        value="${state.amount}"
        style="width:70%;height:80px;font-size:52px;font-family:var(--font-family);font-weight:700;
          text-align:center;border:none;border-bottom:3px solid var(--color-accent);
          background:transparent;color:var(--color-text);outline:none;-webkit-appearance:none">
    </div>
  `;
}

// ====== 步骤 3：分类 ======
function renderCategoryStep() {
  return `
    <div class="step-title">🏷️ 选择分类</div>
    <div class="step-selected-hint" id="cat-hint">${state.category ? '已选：' + (CATEGORIES.find(c => c.label === state.category)?.icon || '') + ' ' + state.category : '请点击下方选择'}</div>
    <div class="step-chip-list" id="category-list">
      ${CATEGORIES.map(c => `
        <button class="step-chip ${state.category === c.label ? 'selected' : ''}"
          data-category="${c.label}">
          <span class="chip-icon">${c.icon}</span>${c.label}
        </button>
      `).join('')}
      <button class="step-chip ${state.category === '__custom__' ? 'selected' : ''}"
        data-category="__custom__">
        <span class="chip-icon">📝</span>其他（——）
      </button>
    </div>
    ${state.category === '__custom__' ? `
      <div style="margin-top:12px">
        <input type="text" id="custom-category-input" placeholder="请输入分类名称"
          value="${state.customCategory}"
          style="width:100%;height:56px;font-size:22px;font-family:var(--font-family);
            border:2px solid var(--color-accent);border-radius:12px;padding:0 16px;
            background:var(--color-surface);color:var(--color-text);-webkit-appearance:none">
      </div>
    ` : ''}
  `;
}

// ====== 步骤 4：人员 ======
function renderPersonStep() {
  return `
    <div class="step-title">👤 选择经办人</div>
    <div class="step-selected-hint" id="person-hint">${state.person ? '已选：' + (state.person === '__custom__' ? state.customPerson || '自定义人员' : state.person) : '请点击下方选择'}</div>
    <div class="step-chip-list" id="person-list">
      ${PEOPLE.map(p => `
        <button class="step-chip ${state.person === p ? 'selected' : ''}"
          data-person="${p}">${p}</button>
      `).join('')}
      <button class="step-chip ${state.person === '__custom__' ? 'selected' : ''}"
        data-person="__custom__">
        <span class="chip-icon">📝</span>其他（——）
      </button>
    </div>
    ${state.person === '__custom__' ? `
      <div style="margin-top:12px">
        <input type="text" id="custom-person-input" placeholder="请输入经办人姓名"
          value="${state.customPerson}"
          style="width:100%;height:56px;font-size:22px;font-family:var(--font-family);
            border:2px solid var(--color-accent);border-radius:12px;padding:0 16px;
            background:var(--color-surface);color:var(--color-text);-webkit-appearance:none">
      </div>
    ` : ''}
  `;
}

// ====== 步骤 5：确认 ======
function renderConfirmStep() {
  const amount = parseAmount(state.amount);
  const amountClass = state.type;
  const typeLabel = state.type === 'income' ? '收入' : '支出';
  const catLabel = state.category === '__custom__' ? state.customCategory : state.category;
  const personLabel = state.person === '__custom__' ? state.customPerson : state.person;

  return `
    <div class="step-title">✓ 确认信息</div>
    <div class="confirm-card">
      <div class="confirm-row"><span class="confirm-label">日期</span><span class="confirm-value">${formatDate(state.date)}</span></div>
      <div class="confirm-row"><span class="confirm-label">类型</span><span class="confirm-value" style="color:${state.type === 'income' ? 'var(--color-income)' : 'var(--color-expense)'}">${typeLabel}</span></div>
      <div class="confirm-row"><span class="confirm-label">金额</span><span class="confirm-amount ${amountClass}">¥${amount.toFixed(2)}</span></div>
      <div class="confirm-row"><span class="confirm-label">分类</span><span class="confirm-value">${catLabel}</span></div>
      <div class="confirm-row"><span class="confirm-label">经办人</span><span class="confirm-value">${personLabel}</span></div>
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
    case 4: bindPersonEvents(); break;
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
    if (parts.length === 2 && parts[1].length > 2) val = parts[0] + '.' + parts[1].substring(0, 2);
    input.value = val;
    state.amount = val;
    renderNav();
  });
  setTimeout(() => input.focus(), 150);
}

function bindCategoryEvents() {
  document.querySelectorAll('#category-list .step-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cat = chip.dataset.category;
      state.category = cat;
      if (cat !== '__custom__') state.customCategory = '';
      renderStep();
    });
  });
  document.getElementById('custom-category-input')?.addEventListener('input', (e) => {
    state.customCategory = e.target.value;
    renderNav();
  });
}

function bindPersonEvents() {
  document.querySelectorAll('#person-list .step-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = chip.dataset.person;
      state.person = p;
      if (p !== '__custom__') state.customPerson = '';
      renderStep();
    });
  });
  document.getElementById('custom-person-input')?.addEventListener('input', (e) => {
    state.customPerson = e.target.value;
    renderNav();
  });
}

// ====== 工具 ======
function canProceed() {
  switch (state.step) {
    case 0: return !!state.date;
    case 1: return !!state.type;
    case 2: return parseAmount(state.amount) > 0;
    case 3:
      if (state.category === '__custom__') return state.customCategory.trim().length > 0;
      return !!state.category;
    case 4:
      if (state.person === '__custom__') return state.customPerson.trim().length > 0;
      return !!state.person;
    case 5:
      return !!state.person && parseAmount(state.amount) > 0 && !!state.category;
    default: return false;
  }
}

function formatYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function submit() {
  const amount = parseAmount(state.amount);
  if (amount <= 0) return;

  const finalCategory = state.category === '__custom__' ? state.customCategory.trim() : state.category;
  const finalPerson = state.person === '__custom__' ? state.customPerson.trim() : state.person;
  if (!finalCategory || !finalPerson) return;

  await add({
    date: state.date,
    type: state.type,
    amount: amount,
    category: finalCategory,
    person: finalPerson
  });

  close();
  toast('✓ 记账成功');
  window.dispatchEvent(new CustomEvent('data-changed'));
}
