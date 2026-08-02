// 周家财务 — 账单列表组件

import { formatCurrency, formatDate } from '../utils.js';
import { getDailyGroups } from '../model.js';
import { remove } from '../storage.js';
import { confirm, toast } from './confirmDialog.js';
import * as filterModal from './filterBar.js';
import { exportData } from '../storage.js';

/**
 * 渲染账单列表
 * @param {Array} entries - 筛选后的条目
 */
export function render(entries) {
  const el = document.getElementById('record-list');

  if (!entries || entries.length === 0) {
    renderEmpty(el);
    return;
  }

  const groups = getDailyGroups(entries);

  let html = '';
  for (const group of groups) {
    html += '<div class="day-group">';
    html += '<div class="day-group-header">';
    html += `<span class="day-date">${formatDate(group.date)}</span>`;
    html += '<span class="day-subtotal">';
    html += `收 ${formatCurrency(group.income)} · 支 ${formatCurrency(group.expense)}`;
    html += '</span>';
    html += '</div>';

    for (const entry of group.entries) {
      html += renderRecordCard(entry);
    }

    html += '</div>';
  }

  // 底部操作区
  html += `
    <div class="data-actions">
      <button class="data-btn" id="btn-filter">🔍 筛选</button>
      <button class="data-btn" id="btn-export">📤 导出</button>
    </div>
  `;

  el.innerHTML = html;

  // 删除按钮
  el.querySelectorAll('.record-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const ok = await confirm('确定要删除这条记录吗？', { danger: true, confirmText: '删除' });
      if (ok) {
        await remove(id);
        window.dispatchEvent(new CustomEvent('data-changed'));
      }
    });
  });

  // 筛选按钮
  el.querySelector('#btn-filter')?.addEventListener('click', () => {
    filterModal.open();
  });

  // 导出按钮
  el.querySelector('#btn-export')?.addEventListener('click', async () => {
    const json = await exportData();
    try {
      await navigator.clipboard.writeText(json);
      toast('✅ 数据已复制到剪贴板');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      toast('✅ 数据已复制到剪贴板');
    }
  });
}

function renderEmpty(el) {
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📒</div>
      <div class="empty-text">还没有记账记录</div>
      <div class="empty-hint">点击上方「记一笔」开始添加</div>
    </div>
    <div class="data-actions">
      <button class="data-btn" id="btn-filter">🔍 筛选</button>
      <button class="data-btn" id="btn-export">📤 导出</button>
    </div>
  `;

  el.querySelector('#btn-filter')?.addEventListener('click', () => {
    filterModal.open();
  });

  el.querySelector('#btn-export')?.addEventListener('click', async () => {
    const json = await exportData();
    if (json === '[]') {
      toast('暂无数据可导出');
      return;
    }
    try {
      await navigator.clipboard.writeText(json);
      toast('✅ 数据已复制到剪贴板');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      toast('✅ 数据已复制到剪贴板');
    }
  });
}

function renderRecordCard(entry) {
  const typeSymbol = entry.type === 'income' ? '+' : '−';
  const amountClass = entry.type;

  return `
    <div class="record-card">
      <div class="record-type-badge ${entry.type}">${typeSymbol}</div>
      <div class="record-info">
        <div class="record-category">${entry.category}</div>
        <div class="record-person">${entry.person}</div>
      </div>
      <div class="record-amount ${amountClass}">${formatCurrency(entry.amount)}</div>
      <button class="record-delete" data-id="${entry.id}" title="删除">✕</button>
    </div>
  `;
}
