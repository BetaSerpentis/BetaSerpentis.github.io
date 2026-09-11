// js/main.js — pmBattle 游戏主流程（玩家 vs AI，基于 PS 全量引擎）
// 格式默认 [Gen 8] NatDex Dynamax（Mega 进化 + Z 技能 + 极巨化三系统共存）。
// 播放流程：每次引擎推进后，逐条日志播放（文字 + 动画 + 节奏停顿），
// 播放期间锁定菜单，一回合表现播完才轮到玩家下一轮操作。

import { createBattle, requestState, parseLog, getEnhancements, activeSnapshot, FORMATS, PLAYER, OPPONENT } from './core/ps-adapter.js';
import { chooseAiAction } from './core/ai.js';
import { PLAYER_TEAM, AI_TEAM } from './data/teams.js';
import { renderActive, renderLog, clearLog, renderMoveMenu, renderSwitchMenu, showMessage, animateAttack, animateHit, animateEnter, animateExit } from './ui/BattleField.js';

let battle;
let logCursor = 0;
let enhanceMode = { mega: false, zmove: false, dynamax: false };
let playing = false; // 播放中（锁定玩家操作）

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// --- 隐藏全部菜单（播放期间） ---
function hideMenus() {
  for (const id of ['menu-moves', 'menu-switch', 'menu-message']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
}

// --- 日志播放：逐条显示 + 动画 + 节奏 ---
async function flushLog() {
  const newLogs = battle.log.slice(logCursor);
  logCursor = battle.log.length;
  const zh = parseLog(newLogs);
  if (!zh.length) return;

  // 新回合开始：清空上一回合的日志
  if (zh.some(l => l.startsWith('— 第'))) clearLog();

  playing = true;
  hideMenus();

  for (const line of zh) {
    renderLog([line]);            // 逐条显示
    await playLine(line);         // 该行的动画与停顿
  }

  playing = false;
}

// --- 单行播放节奏：有动画的行走动画时长，否则留阅读时间 ---
async function playLine(line) {
  const oppSnap = activeSnapshot(battle, OPPONENT);
  const oppName = oppSnap ? oppSnap.name : '';
  const isOpp = oppName && line.startsWith(oppName);

  if (line.includes('使用了')) {
    animateAttack(isOpp ? 'opp' : 'pl');
    await sleep(750);            // 前冲动画 .45s + 停顿
    return;
  }
  if (line.includes('损失了')) {
    animateHit(isOpp ? 'opp' : 'pl');
    renderBoth();                // 受击时血条同步变化
    await sleep(650);            // 闪烁动画 .55s + 停顿
    return;
  }
  if (line.includes('出场了')) {
    animateEnter(isOpp ? 'opp' : 'pl');
    renderBoth();
    await sleep(700);            // 登场动画 .5s
    return;
  }
  if (line.includes('倒下了')) {
    animateExit(isOpp ? 'opp' : 'pl');
    renderBoth();
    await sleep(800);            // 退场动画 .5s + 停顿
    return;
  }
  if (line.startsWith('— 第')) {
    await sleep(500);            // 回合分隔稍停
    return;
  }
  await sleep(520);              // 普通行阅读时间
}

// --- 统一推进：先让 AI 处理完它的所有待决策（含濒死换人），再轮到玩家 ---
async function advance() {
  // 1. AI 自动决策，直到轮到玩家或游戏结束
  let guard = 0;
  while (guard++ < 10) {
    if (await checkWinner()) return;
    const oppState = requestState(battle, OPPONENT);
    if (oppState === '') break;
    const action = chooseAiAction(battle, OPPONENT);
    battle.choose(OPPONENT, `${action.type} ${action.index + 1}`);
    await flushLog();            // 逐条播放这一段的表现
    renderBoth();
  }

  if (await checkWinner()) return;

  // 2. 轮到玩家：播放完毕后渲染对应菜单
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
}

// --- 玩家选择（首发/换人） ---
async function onPlayerPick(index) {
  if (playing) return;
  const state = requestState(battle, PLAYER);
  battle.choose(PLAYER, `${state === 'teampreview' ? 'team' : 'switch'} ${index + 1}`);
  await flushLog();
  renderBoth();
  advance();
}

// --- 玩家选招（带强化标记） ---
async function onPlayerMove(index) {
  if (playing) return;
  let input = `move ${index + 1}`;
  if (enhanceMode.mega) input += ' mega';
  if (enhanceMode.zmove) input += ' zmove';
  if (enhanceMode.dynamax) input += ' dynamax';
  battle.choose(PLAYER, input);
  await flushLog();              // 播完整回合的表现
  renderBoth();
  advance();                     // 再轮 AI / 玩家
}

// --- 玩家主动换人请求 ---
function onPlayerSwitchRequest() {
  if (playing) return;
  renderSwitchMenu(battle, PLAYER, async (index) => {
    battle.choose(PLAYER, `switch ${index + 1}`);
    await flushLog();
    renderBoth();
    advance();
  }, '选择上场的宝可梦');
}

// --- 强化按钮切换 ---
function toggleEnhance(key) {
  if (playing) return;
  enhanceMode[key] = !enhanceMode[key];
  const enh = getEnhancements(battle, PLAYER);
  renderMoveMenu(battle, onPlayerMove, onPlayerSwitchRequest, enh, enhanceMode, toggleEnhance);
}

// --- 胜负判定 ---
async function checkWinner() {
  if (battle.winner) {
    await flushLog();            // 播完最后的战斗表现
    const text = battle.winner === PLAYER ? '🎉 你赢了！' : '💔 你输了...';
    showMessage(text, () => location.reload());
    return true;
  }
  return false;
}

init();
