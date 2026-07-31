// 周家财务 — 数据聚合与筛选逻辑

/**
 * 计算一组条目的收入/支出汇总
 * @param {Array} entries
 * @returns {{ income: number, expense: number }}
 */
export function getSubtotals(entries) {
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    if (e.type === 'income') income += e.amount;
    else expense += e.amount;
  }
  return { income, expense };
}

/**
 * 按日分组条目，并计算每日小计
 * @param {Array} entries - 已排序的条目
 * @returns {Array<{ date: string, income: number, expense: number, entries: Array }>}
 */
export function getDailyGroups(entries) {
  const groups = [];
  let currentDate = null;
  let currentGroup = null;

  for (const e of entries) {
    if (e.date !== currentDate) {
      currentDate = e.date;
      currentGroup = { date: currentDate, income: 0, expense: 0, entries: [] };
      groups.push(currentGroup);
    }
    if (e.type === 'income') currentGroup.income += e.amount;
    else currentGroup.expense += e.amount;
    currentGroup.entries.push(e);
  }
  return groups;
}

/**
 * 按筛选条件过滤条目
 * @param {Array} entries - 全部条目
 * @param {Object} filters - { date, month, category, person }
 *   date: "2026-07-31" | null (具体某天)
 *   month: "2026-07" | null (某月)
 *   category: "日常食材" | null (分类 label)
 *   person: "周连国" | null (人员)
 * @returns {Array}
 */
export function filterEntries(entries, filters) {
  if (!filters) return entries;
  const { date, month, category, person } = filters;

  return entries.filter(e => {
    if (date && e.date !== date) return false;
    if (month && !e.date.startsWith(month)) return false;
    if (category && e.category !== category) return false;
    if (person && e.person !== person) return false;
    return true;
  });
}

/**
 * 获取某月的条目
 * @param {Array} entries
 * @param {string} monthStr - YYYY-MM
 * @returns {Array}
 */
export function getMonthEntries(entries, monthStr) {
  return entries.filter(e => e.date.startsWith(monthStr));
}

/**
 * 获取条目中出现的所有月份列表（降序）
 * @param {Array} entries
 * @returns {Array<string>} e.g. ["2026-07", "2026-06"]
 */
export function getAvailableMonths(entries) {
  const months = new Set();
  for (const e of entries) {
    months.add(e.date.substring(0, 7));
  }
  return Array.from(months).sort().reverse();
}
