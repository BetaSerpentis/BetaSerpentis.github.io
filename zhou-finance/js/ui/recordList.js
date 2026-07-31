// 周家财务 — 账单列表组件

import { formatCurrency, formatDate } from '../utils.js';
import { getDailyGroups } from '../model.js';
import { remove, getAll, exportData } from '../storage.js';
import { confirm, toast } from './confirmDialog.js';

/**
 * 渲染账单列表
 * @param {Array} entries - 筛选后的条目列表
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

  // 数据导出区
  html += `
    <div class="data-actions">
      <button class="data-btn" id="btn-export">📤 导出数据</button>
    </div>
  `;

  el.innerHTML = html;

  // 绑定删除事件
  el.querySelectorAll('.record-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const ok = await confirm('确定要删除这条记录吗？', { danger: true, confirmText: '删除' });
      if (ok) {
        remove(id);
        // 触发刷新（通过自定义事件）
        window.dispatchEvent(new CustomEvent('data-changed'));
      }
    });
  });

  // 绑定导出按钮
  const exportBtn = el.querySelector('#btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const json = exportData();
      try {
        await navigator.clipboard.writeText(json);
        toast('✅ 数据已复制到剪贴板');
      } catch {
        // 降级方案：创建临时文本框
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
}

function renderEmpty(el) {
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📒</div>
      <div class="empty-text">还没有记账记录</div>
      <div class="empty-hint">点击下方「记账」开始添加</div>
    </div>
    <div class="data-actions">
      <button class="data-btn" id="btn-export">📤 导出数据</button>
    </div>
  `;

  const exportBtn = el.querySelector('#btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const json = exportData();
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
}

function renderRecordCard(entry) {
  const typeClass = entry.type;
  const typeSymbol = entry.type === 'income' ? '+' : '−';
  const amountClass = entry.type === 'income' ? 'income' : 'expense';

  return `
    <div class="record-card">
      <div class="record-type-badge ${typeClass}">${typeSymbol}</div>
      <div class="record-info">
        <div class="record-category">${entry.category}</div>
        <div class="record-person">${entry.person}</div>
      </div>
      <div class="record-amount ${amountClass}">${formatCurrency(entry.amount)}</div>
      <button class="record-delete" data-id="${entry.id}" title="删除">✕</button>
    </div>
  `;
}
