// 周家财务 — 汇总条组件

import { formatCurrency } from '../utils.js';
import { getSubtotals } from '../model.js';

/**
 * 渲染顶部汇总条
 * @param {Object} filters - 当前筛选条件
 * @param {Array} filteredEntries - 筛选后的条目（null = 全空 / 空数组 = 已筛选但无结果）
 */
export async function render(filters, filteredEntries) {
  const el = document.getElementById('summary-bar');

  let entries, label;

  const hasActiveFilter = filters && (
    filters.date || filters.month || filters.category || filters.person
  );

  if (filteredEntries) {
    entries = filteredEntries;
    label = hasActiveFilter ? '筛选' : '全部';
  } else {
    entries = [];
    label = '全部';
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
