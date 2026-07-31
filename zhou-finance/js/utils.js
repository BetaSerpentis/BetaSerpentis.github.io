// 周家财务 — 工具函数

/**
 * 格式化金额为人民币显示
 * @param {number} amount
 * @returns {string} e.g. "¥1,234.56" or "¥1,234"
 */
export function formatCurrency(amount) {
  if (amount === 0) return '¥0';
  const fixed = amount.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decPart === '00') return `¥${formatted}`;
  return `¥${formatted}.${decPart}`;
}

/**
 * 获取今天的日期字符串 YYYY-MM-DD
 * @returns {string}
 */
export function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 获取当前月份 YYYY-MM
 * @returns {string}
 */
export function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 格式化日期为中文显示
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} e.g. "7月31日 周四"
 */
export function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(+y, +m - 1, +d);
  const weekday = WEEKDAY_NAMES[date.getDay()];
  return `${+m}月${+d}日 ${weekday}`;
}

/**
 * 格式化月份为中文显示
 * @param {string} monthStr - YYYY-MM
 * @returns {string} e.g. "2026年7月"
 */
export function formatMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  return `${y}年${+m}月`;
}

/**
 * 获取日期对应的星期几
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
export function getWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(+y, +m - 1, +d);
  return WEEKDAY_NAMES[date.getDay()];
}

/**
 * 生成唯一 ID
 * @returns {string} e.g. "zf_1712345678_a1b2c3"
 */
export function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `zf_${ts}_${rand}`;
}

/**
 * 解析金额输入字符串为数字（保留两位小数）
 * @param {string} raw
 * @returns {number}
 */
export function parseAmount(raw) {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100) / 100;
}
