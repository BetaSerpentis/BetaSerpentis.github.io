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
export function animateEnter(side) { pulseClass(side, 'anim-enter', 500); }
export function animateExit(side) { pulseClass(side, 'anim-exit', 500); }

function pulseClass(side, cls, ms) {
  const el = side === PLAYER ? $('#pl-sprite') : $('#opp-sprite');
  if (!el) return;
  el.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
  // 强制重绘以支持连续触发同一动画
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// 渲染场上宝可梦（side: PLAYER/OPPONENT）
export function renderActive(battle, side) {
  const snap = activeSnapshot(battle, side);
  const prefix = side === PLAYER ? 'pl' : 'opp';
  if (!snap) return;

  $(`#${prefix}-name`).textContent = snap.name;
  $(`#${prefix}-level`).textContent = `Lv.${snap.level}`;
  $(`#${prefix}-hp-text`).textContent = `${snap.hp} / ${snap.maxhp}`;

  const ratio = snap.hp / snap.maxhp;
  const bar = $(`#${prefix}-hp-bar`);
  bar.style.width = `${Math.max(0, ratio * 100)}%`;
  bar.style.background = ratio > 0.5 ? 'var(--hp-green)' : ratio > 0.2 ? 'var(--hp-yellow)' : 'var(--hp-red)';

  const statusEl = $(`#${prefix}-status`);
  statusEl.textContent = snap.status ? statusZh(snap.status) : '';
  statusEl.style.display = snap.status ? 'inline-block' : 'none';

  const img = $(`#${prefix}-sprite`);
  // 己方显示背面形象，对方显示正面形象；背面 404 时回退正面
  img.src = spriteUrl(battle[side].active[0].species.num, side === PLAYER);
  img.onerror = () => {
    if (side === PLAYER) img.src = spriteUrl(battle[side].active[0].species.num, false);
  };
  img.alt = snap.name;
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
