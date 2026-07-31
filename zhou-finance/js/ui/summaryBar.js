// 周家财务 — 汇总条组件

import { formatCurrency, formatMonth, getCurrentMonth } from '../utils.js';
import { getMonthEntries, getSubtotals } from '../model.js';
import { getAll } from '../storage.js';

/**
 * 渲染顶部汇总条
 * @param {Object} filters - 当前筛选条件
 * @param {Array} filteredEntries - 筛选后的条目（null 表示未筛选）
 */
export function render(filters, filteredEntries) {
  const el = document.getElementById('summary-bar');
  const allEntries = getAll();

  let entries, label;

  const hasActiveFilter = filters && (
    filters.date || filters.category || filters.person ||
    (filters.month && filters.month !== getCurrentMonth())
  );

  if (filteredEntries && hasActiveFilter) {
    entries = filteredEntries;
    label = '筛选结果';
  } else {
    const month = (filters && filters.month) ? filters.month : getCurrentMonth();
    entries = getMonthEntries(allEntries, month);
    label = formatMonth(month).replace(/^\d+年/, ''); // "7月"
  }

  const { income, expense } = getSubtotals(entries);

  el.innerHTML = `
    <div class="summary-item">
      <div class="summary-label">${label} 收入</div>
      <div class="summary-amount">${formatCurrency(income)}</div>
    </div>
    <div class="summary-divider"></div>
    <div class="summary-item">
      <div class="summary-label">${label} 支出</div>
      <div class="summary-amount">${formatCurrency(expense)}</div>
    </div>
  `;
}
