// js/main.js — pmBattle 游戏主流程（玩家 vs AI，基于 PS 全量引擎）
// 格式默认 [Gen 8] NatDex Dynamax（Mega 进化 + Z 技能 + 极巨化三系统共存）。
// 播放流程：每次引擎推进后，逐条日志播放（文字 + 动画 + 节奏停顿），
// 播放期间锁定菜单，一回合表现播完才轮到玩家下一轮操作。

import { createBattle, requestState, parseEvents, getEnhancements, FORMATS, PLAYER, OPPONENT } from './core/ps-adapter.js';
import { chooseAiAction } from './core/ai.js';
import { PLAYER_TEAM, AI_TEAM } from './data/teams.js';
import { renderActive, renderLog, clearLog, renderMoveMenu, renderSwitchMenu, showMessage, animateAttack, animateHit, animateEnter, animateExit, setHpDisplay, setStatusDisplay } from './ui/BattleField.js';

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
  const events = parseEvents(newLogs);
  if (!events.length) return;

  // 新回合开始：清空上一回合的日志
  if (events.some(e => e.evt === 'turn')) clearLog();

  playing = true;
  hideMenus();

  for (const ev of events) {
    renderLog([ev.text]);       // 逐条显示
    await playLine(ev);         // 该行动画与停顿
  }

  playing = false;
  renderBoth();                // 播完后同步真实状态（名字/状态等）
}

// 事件 side（'p1'/'p2'）→ UI 侧（pl/opp）
function uiSide(side) { return side === PLAYER ? 'pl' : side === OPPONENT ? 'opp' : null; }

// --- 单行播放节奏：按结构化事件分派（顺序：攻击→受击→掉血） ---
async function playLine(ev) {
  const s = uiSide(ev.side);
  switch (ev.evt) {
    case 'move': {
      // 攻方前冲
      if (s) animateAttack(s);
      await sleep(750);          // 前冲动画 .45s + 停顿
      return;
    }
    case '-damage': {
      // 受击闪烁 → 按事件 HP 掉血条（正确顺序，不依赖名字）
      // [from] 伤害（特性/道具/异常状态/反动/混乱等非招式直伤）不播受击动画
      if (s) {
        if (!ev.from) animateHit(s);
        await sleep(ev.from ? 150 : 560);   // 无动画时仅短暂停顿
        if (ev.hp) setHpDisplay(s, ev.hp.cur, ev.hp.max);
      }
      await sleep(420);         // 血条过渡 .4s + 停顿
      return;
    }
    case '-heal': case '-sethp': {
      if (s && ev.hp) setHpDisplay(s, ev.hp.cur, ev.hp.max);
      await sleep(500);
      return;
    }
    case '-status': {
      if (s) setStatusDisplay(s, ev.statusKey || null); // 即时上标签（如烧伤/麻痹）
      await sleep(520);
      return;
    }
    case '-curestatus': {
      if (s) setStatusDisplay(s, null);                  // 即时摘标签
      await sleep(520);
      return;
    }
    case 'switch': case 'drag': {
      if (s) {
        // 先 enter 起始态（scale0 隐藏旧图）→ 回调内换图渲染（旧图不再闪现）
        // HP 用事件行内出场快照：battle 终态已含本回合后续伤害，不能提前显示
        animateEnter(s, () => renderActive(battle, s === 'pl' ? PLAYER : OPPONENT, ev.hp));
      }
      await sleep(700);         // 登场动画 .5s
      return;
    }
    case 'faint': {
      if (s) animateExit(s);
      await sleep(800);         // 退场动画 .5s + 停顿
      return;
    }
    case 'turn': {
      await sleep(560);         // 回合分隔稍停
      return;
    }
    default: {
      await sleep(520);         // 普通行阅读时间
      return;
    }
  }
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
