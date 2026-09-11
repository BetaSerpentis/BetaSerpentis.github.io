// js/main.js — pmBattle 游戏主流程（玩家 vs AI，基于 PS 全量引擎）
// 格式默认 [Gen 8] NatDex Dynamax（Mega 进化 + Z 技能 + 极巨化三系统共存）。

import { createBattle, requestState, parseLog, getEnhancements, activeSnapshot, FORMATS, PLAYER, OPPONENT } from './core/ps-adapter.js';
import { chooseAiAction } from './core/ai.js';
import { PLAYER_TEAM, AI_TEAM } from './data/teams.js';
import { renderActive, renderLog, clearLog, renderMoveMenu, renderSwitchMenu, showMessage, animateAttack, animateHit, animateEnter, animateExit } from './ui/BattleField.js';

let battle;
let logCursor = 0;
let enhanceMode = { mega: false, zmove: false, dynamax: false };

// --- 初始化 ---
function init() {
  battle = createBattle(PLAYER_TEAM, AI_TEAM, '训练家', '对手', FORMATS.natdex8dynamax);
  logCursor = 0;
  renderBoth();
  advance();
}

function renderBoth() {
  renderActive(battle, PLAYER);
  renderActive(battle, OPPONENT);
}

// --- 日志刷新：取新增协议日志转中文，并触发动画 ---
function flushLog() {
  const newLogs = battle.log.slice(logCursor);
  logCursor = battle.log.length;
  const zh = parseLog(newLogs);
  if (zh.length) {
    // 新回合开始：清空上一回合的日志
    if (zh.some(l => l.startsWith('— 第'))) clearLog();
    renderLog(zh);
    triggerAnimations(zh);
  }
}

// 根据中文日志触发动画（攻击前冲/受击闪烁/登场/退场）
function triggerAnimations(lines) {
  const oppSnap = activeSnapshot(battle, OPPONENT);
  const oppName = oppSnap ? oppSnap.name : '';
  for (const line of lines) {
    const isOpp = oppName && line.startsWith(oppName);
    if (line.includes('使用了')) animateAttack(isOpp ? 'opp' : 'pl');
    else if (line.includes('损失了')) animateHit(isOpp ? 'opp' : 'pl');
    else if (line.includes('出场了')) animateEnter(isOpp ? 'opp' : 'pl');
    else if (line.includes('倒下了')) animateExit(isOpp ? 'opp' : 'pl');
  }
}

// --- 统一推进：先让 AI 处理完它的所有待决策（含濒死换人），再轮到玩家 ---
function advance() {
  // 1. AI 自动决策，直到轮到玩家或游戏结束
  let guard = 0;
  while (guard++ < 10) {
    if (checkWinner()) return;
    const oppState = requestState(battle, OPPONENT);
    if (oppState === '') break;
    const action = chooseAiAction(battle, OPPONENT);
    battle.choose(OPPONENT, `${action.type} ${action.index + 1}`);
    flushLog();
    renderBoth();
  }

  if (checkWinner()) return;

  // 2. 轮到玩家：渲染对应菜单
  const state = requestState(battle, PLAYER);
  if (state === 'teampreview') {
    renderSwitchMenu(battle, PLAYER, onPlayerPick, '选择首发宝可梦');
  } else if (state === 'switch') {
    renderSwitchMenu(battle, PLAYER, onPlayerPick, '选择上场的宝可梦');
  } else if (state === 'move') {
    enhanceMode = { mega: false, zmove: false, dynamax: false };
    const enh = getEnhancements(battle, PLAYER);
    renderMoveMenu(battle, onPlayerMove, onPlayerSwitchRequest, enh, enhanceMode, toggleEnhance);
  }
  // state === '' 时：AI 决策循环里已 break，理论上不该到这里（除非异常）
}

// --- 玩家选择（首发/换人） ---
function onPlayerPick(index) {
  const state = requestState(battle, PLAYER);
  battle.choose(PLAYER, `${state === 'teampreview' ? 'team' : 'switch'} ${index + 1}`);
  flushLog();
  renderBoth();
  advance();
}

// --- 玩家选招（带强化标记） ---
function onPlayerMove(index) {
  let input = `move ${index + 1}`;
  if (enhanceMode.mega) input += ' mega';
  if (enhanceMode.zmove) input += ' zmove';
  if (enhanceMode.dynamax) input += ' dynamax';
  battle.choose(PLAYER, input);
  flushLog();
  renderBoth();
  advance();
}

// --- 玩家主动换人请求 ---
function onPlayerSwitchRequest() {
  renderSwitchMenu(battle, PLAYER, (index) => {
    battle.choose(PLAYER, `switch ${index + 1}`);
    flushLog();
    renderBoth();
    advance();
  }, '选择上场的宝可梦');
}

// --- 强化按钮切换 ---
function toggleEnhance(key) {
  enhanceMode[key] = !enhanceMode[key];
  const enh = getEnhancements(battle, PLAYER);
  renderMoveMenu(battle, onPlayerMove, onPlayerSwitchRequest, enh, enhanceMode, toggleEnhance);
}

// --- 胜负判定 ---
function checkWinner() {
  if (battle.winner) {
    const text = battle.winner === PLAYER ? '🎉 你赢了！' : '💔 你输了...';
    flushLog();
    showMessage(text, () => location.reload());
    return true;
  }
  return false;
}

init();
