// js/ui/BattleField.js — 战斗界面渲染（对接 PS 引擎适配层）

import { activeSnapshot, teamSnapshot, getMoves, statusZh, typeName, PLAYER, OPPONENT } from '../core/ps-adapter.js';

const $ = s => document.querySelector(s);

// 宝可梦立绘：正面（对方）/ 背面（己方）
export function spriteUrl(num, back = false) {
  const dir = back ? 'back/' : '';
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dir}${num}.png`;
}

// --- 动画触发（CSS class 方式） ---
export function animateAttack(side) { pulseClass(side, 'anim-attack', 450); }
export function animateHit(side) { pulseClass(side, 'anim-hit', 550); }
// 登场动画：先进入 scale(0) 起始态（立即隐藏旧精灵），再执行换图回调
export function animateEnter(side, onSwap) {
  const el = side === 'pl' ? $('#pl-sprite') : $('#opp-sprite');
  if (!el) return;
  el.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
  el.classList.add('anim-enter');
  // 强制应用起始帧后再换图，避免旧精灵以全尺寸闪现
  void el.offsetWidth;
  if (onSwap) onSwap();
  setTimeout(() => el.classList.remove('anim-enter'), 520);
}
export function animateExit(side) { pulseClass(side, 'anim-exit', 500); }

function pulseClass(side, cls, ms) {
  const el = side === 'pl' ? $('#pl-sprite') : $('#opp-sprite');
  if (!el) return;
  el.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
  // 强制重绘以支持连续触发同一动画
  void el.offsetWidth;
  el.classList.add(cls);
  // 退场动画保持终态（缩小不反弹）：换人 enter 时统一清除
  if (cls === 'anim-exit') return;
  setTimeout(() => el.classList.remove(cls), ms);
}

// 渲染场上宝可梦（side: PLAYER/OPPONENT）
// 同值不重写 DOM（避免每次 renderBoth 重复触发 mutation / 闪烁）
function setTextIfChanged(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// 异常状态标签即时更新（-status/-curestatus 行播放时）
export function setStatusDisplay(side, statusKey) {
  const prefix = side === 'pl' ? 'pl' : 'opp';
  const statusEl = $(`#${prefix}-status`);
  setTextIfChanged(statusEl, statusKey ? statusZh(statusKey) : '');
  statusEl.style.display = statusKey ? 'inline-block' : 'none';
}

// hpOverride：日志事件行内的 HP 快照（switch/drag 出场值）。
// 播放中 battle 已是整回合结算后的终态，直接读 snap.hp 会把后续伤害提前显示。
export function renderActive(battle, side, hpOverride = null) {
  const snap = activeSnapshot(battle, side);
  const prefix = side === PLAYER ? 'pl' : 'opp';
  if (!snap) return;
  const hp = hpOverride && hpOverride.max ? hpOverride : { cur: snap.hp, max: snap.maxhp };

  setTextIfChanged($(`#${prefix}-name`), snap.name);
  setTextIfChanged($(`#${prefix}-level`), `Lv.${snap.level}`);
  setTextIfChanged($(`#${prefix}-hp-text`), `${hp.cur} / ${hp.max}`);

  const ratio = Math.max(0, hp.cur / hp.max);
  const bar = $(`#${prefix}-hp-bar`);
  bar.style.width = `${Math.max(0, ratio * 100)}%`;
  bar.style.background = ratio > 0.5 ? 'var(--hp-green)' : ratio > 0.2 ? 'var(--hp-yellow)' : 'var(--hp-red)';

  // 播放中（hpOverride 存在）不显示终态异常标签：新出场精灵的烧伤等由 -status 行播到时再上
  const st = hpOverride ? null : snap.status;
  const statusEl = $(`#${prefix}-status`);
  setTextIfChanged(statusEl, st ? statusZh(st) : '');
  statusEl.style.display = st ? 'inline-block' : 'none';

  const img = $(`#${prefix}-sprite`);
  // 己方显示背面形象，对方显示正面形象；背面 404 时回退正面
  const newSrc = spriteUrl(battle[side].active[0].species.num, side === PLAYER);
  if (img.getAttribute('src') !== newSrc) {
    // 换新精灵：清残留的退场缩小态，保证 enter 从全尺寸开始
    img.classList.remove('anim-exit');
    img.src = newSrc;
    img.onerror = () => {
      if (side === PLAYER) img.src = spriteUrl(battle[side].active[0].species.num, false);
    };
  }
  img.alt = snap.name;
}

// 仅按行内 HP 更新血条（受击节奏：先动画再掉血；同值跳过）
export function setHpDisplay(side, cur, max) {
  const prefix = side === 'pl' ? 'pl' : 'opp';
  const ratio = Math.max(0, Math.min(1, cur / max));
  setTextIfChanged($(`#${prefix}-hp-text`), `${cur} / ${max}`);
  const bar = $(`#${prefix}-hp-bar`);
  bar.style.width = `${ratio * 100}%`;
  bar.style.background = ratio > 0.5 ? 'var(--hp-green)' : ratio > 0.2 ? 'var(--hp-yellow)' : 'var(--hp-red)';
}

// 渲染战斗日志（中文文本数组）
export function renderLog(lines) {
  const box = $('#battle-log');
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    box.appendChild(div);
  }
  while (box.children.length > 6) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// 清空日志（新回合开始时调用）
export function clearLog() {
  const box = $('#battle-log');
  box.innerHTML = '';
}

// 渲染招式菜单：顶部行（强化 + 换人）+ 技能网格 2×2
export function renderMoveMenu(battle, onMove, onSwitch, enhancements, enhanceMode, onToggleEnhance) {
  const menu = $('#menu-moves');
  const switchMenu = $('#menu-switch');
  const msg = $('#menu-message');
  menu.hidden = false; switchMenu.hidden = true; msg.hidden = true;
  menu.innerHTML = '';

  // 顶部行：强化按钮 + 换人按钮（横排紧凑）
  const topRow = document.createElement('div');
  topRow.className = 'menu-top-row';
  const mk = (label, key) => {
    const btn = document.createElement('div');
    btn.className = 'menu-item' + (enhanceMode[key] ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => onToggleEnhance(key));
    topRow.appendChild(btn);
  };
  if (enhancements && enhancements.canMegaEvo) mk('💎Mega', 'mega');
  if (enhancements && enhancements.canZMove.length) mk('⚡Z', 'zmove');
  if (enhancements && enhancements.canDynamax) mk('🏔极巨化', 'dynamax');
  const swBtn = document.createElement('div');
  swBtn.className = 'menu-item';
  swBtn.textContent = '🔁换人';
  swBtn.addEventListener('click', onSwitch);
  topRow.appendChild(swBtn);
  menu.appendChild(topRow);

  // 技能按钮：单行紧凑（名字 + PP）
  const grid = document.createElement('div');
  grid.className = 'menu-grid';
  const moves = getMoves(battle, PLAYER);
  for (const m of moves) {
    const btn = document.createElement('div');
    btn.className = 'menu-item' + (m.disabled || m.pp <= 0 ? ' disabled' : '');
    const catZh = m.category === 'Physical' ? '物' : m.category === 'Special' ? '特' : '变';
    btn.innerHTML = `
      <span class="mv-name">${m.name}</span>
      <span class="mv-pp">${typeName(m.type)}·${catZh}·${m.basePower || '—'} ${m.pp}/${m.maxpp}</span>`;
    btn.addEventListener('click', () => onMove(m.index));
    grid.appendChild(btn);
  }
  menu.appendChild(grid);
}

// 渲染换人/首发菜单（2 列网格）
export function renderSwitchMenu(battle, side, onSelect, title = '选择宝可梦') {
  const menu = $('#menu-moves');
  const switchMenu = $('#menu-switch');
  const msg = $('#menu-message');
  menu.hidden = true; switchMenu.hidden = false; msg.hidden = true;
  switchMenu.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'menu-grid';
  const team = teamSnapshot(battle, side);
  team.forEach((p, i) => {
    const disabled = p.fainted || p.active;
    const btn = document.createElement('div');
    btn.className = 'menu-item' + (disabled ? ' disabled' : '');
    btn.innerHTML = `
      <span class="mv-name">${p.name}</span>
      <span class="mv-pp">${p.hp}/${p.maxhp}${p.status ? '·' + statusZh(p.status) : ''}</span>`;
    if (!disabled) btn.addEventListener('click', () => onSelect(i));
    grid.appendChild(btn);
  });
  switchMenu.appendChild(grid);
}

// 显示纯消息（等待点击）
export function showMessage(text, onClick) {
  const menu = $('#menu-moves');
  const switchMenu = $('#menu-switch');
  const msg = $('#menu-message');
  menu.hidden = true; switchMenu.hidden = true; msg.hidden = false;
  msg.innerHTML = `<div class="menu-item" style="pointer-events:auto;text-align:center">${text}</div>`;
  msg.querySelector('.menu-item').addEventListener('click', onClick);
}
