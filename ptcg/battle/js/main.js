// js/main.js — PTCG Battle (FRLG Style)
import { GameState, PHASE, derivePickBounds } from './core/GameState.js';
import { BattleEngine } from './core/BattleEngine.js';
import { CardResolver } from './core/CardResolver.js';
import { executeEffects } from './core/EffectExecutor.js';
import { expandDeck } from './data/decks.js';
import { DeckSource } from './core/DeckSource.js';
import { pokemonSpriteImgHtml, pokemonSpriteSrc, cardThumbImgHtml, cardFullImgHtml, applySpriteBottomTrim, SPRITE_PREFER_ONLINE } from './ui/SpriteUtils.js';

// 卡面显示开关（true=卡图缩略图；后续可切 false 只保留名字与标签）
const SHOW_CARD_ART = true;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

export function energyLabel(energy) {
  if (energy == null) return '';
  if (typeof energy === 'string') return energy;
  if (typeof energy === 'object') return energy.name || energy.cardName || energy.cardId || '';
  return String(energy);
}

export function energyElementClass(energy) {
  const label = energyLabel(energy);
  const map = { '草': 'grass', '火': 'fire', '水': 'water', '雷': 'lightning', '电': 'lightning',
    '超': 'psychic', '斗': 'fighting', '恶': 'dark', '钢': 'metal', '无': 'colorless' };
  for (const [k, v] of Object.entries(map)) { if (label.includes(k)) return v; }
  return 'colorless';
}

export function pokemonPickerSlotAllowed(slot, options = {}) {
  if (!slot) return false;
  const selectableSlots = Array.isArray(options.selectableSlots) ? options.selectableSlots : null;
  if (selectableSlots && !selectableSlots.includes(slot)) return false;
  if (slot === 'active') return options.allowActive !== false;
  if (slot.startsWith('bench-')) return options.allowBench !== false;
  return false;
}

export function pokemonPickerHasLegalTarget(player, options = {}) {
  if (!player) return false;
  if (player.active && pokemonPickerSlotAllowed('active', options)) return true;
  return (player.bench || []).some((mon, i) => !!mon && pokemonPickerSlotAllowed(`bench-${i}`, options));
}

export function pokemonPickerSlotClass(slot, options = {}, selectedSlot = null) {
  const allowed = pokemonPickerSlotAllowed(slot, options);
  return {
    allowed,
    selected: allowed && slot === selectedSlot,
    className: `${allowed ? ' selectable' : ' disabled'}${allowed && slot === selectedSlot ? ' selected' : ''}`,
  };
}

export function pokemonPickerConfirmEnabled(selectedSlot, options = {}) {
  return pokemonPickerSlotAllowed(selectedSlot, options);
}

export function cardPickerTitleFor(pick = {}) {
  const options = pick?.options || {};
  if (options.prompt) return options.prompt;
  if (options.source === 'retreat-energy') return `选择撤退能量（费用${options.cost ?? pick?.count}）`;
  const { min, max } = derivePickBounds(pick);
  if (min === 0 && max > 0) return `选择最多${max}张卡`;
  if (min === max && max > 0) return `选择${max}张卡`;
  if (min < max) return `选择${min}-${max}张卡`;
  return '选择卡牌';
}

export function pokemonPickerTitleFor(isMySide, options = {}, isEffectPick = false) {
  if (isEffectPick && options?.prompt) return options.prompt;
  return `${isMySide ? '我方' : '对方'}宝可梦`;
}

export class PTCGBattleApp {
  constructor() {
    this.gs = new GameState();
    this.resolver = new CardResolver();
    this.engine = null;
    // Card screen state
    this._cardPage = 0;
    this._selectedCardIdx = -1;
    // Card mode: 'hand'(default), 'search-deck', 'search-discard', 'prize'
    this._cardMode = 'hand';
    // 动作完成后返回的列表视图：'hand' | 'pokemon' | null(主菜单)
    this._returnView = null;
    // Callback to invoke after card screen closes (for search/prize picks)
    this._cardModeCb = null;
    this._cardPickCards = null;
    this._lastMainStatus = '';
    // Pokemon screen state
    this._pokePage = 0;
    this._selectedBenchIdx = -1;
    this._selectedPokeSlot = null;
    // Pokemon mode: 'view'(default), 'energy', 'evolve', 'tool', 'swap'
    this._pokeMode = 'view';
    this._pokeTargetData = null; // {handIdx, data} for energy/evolve/tool
    // Log buffer for card screen messages
    this._cardLog = [];
    this.init();
  }

  async init() {
    await this.resolver.load();
    this._aiThinking = false;
    this.engine = new BattleEngine(this.gs, this.resolver, {
      onLog: m => this._onEngineLog(m),
      onPhaseChange: () => this._refresh(),
      onFieldUpdate: () => {
        this._renderScene();
        this._syncPlayerMainPanel();
      },
      // AI 对手：逐个动作播报，让玩家看得清对手做了什么（而不是一瞬间结束回合）
      onAiAction: ({ desc }) => {
        this._appendBattleLog(`对手：${desc}`);
        this._refresh();
      },
      onAiThinking: thinking => {
        this._aiThinking = !!thinking;
        this._updateMainMenu();
      }
    });
    this.gs.onLog = m => this._appendBattleLog(m);
    this.gs._onPendingPick = pick => this._handlePick(pick);
    this.gs._onPendingPokemonPick = pick => this._handlePokemonPick(pick);
    this._bindAll();
    this._bindHostReturn();
    this._bindLogDrag();
    this._fitScreen();
    window.addEventListener('resize', () => this._fitScreen());
    this._showDeckSelect();
  }

  // SPA 宿主模式：提供「返回卡牌库」入口（独立来源/无宿主时不显示）
  _bindHostReturn() {
    const btn = document.getElementById('deck-back');
    if (!btn) return;
    if (!window.__PTCG_BATTLE_HOST__) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.addEventListener('click', () => {
      if (typeof window.__ptcgReturnToLibrary === 'function') window.__ptcgReturnToLibrary();
    });
  }

  // === Deck Selection ===
  // 卡组来源：读取同源 ptcg 卡牌库（localStorage 'ptcg_decks'）中的卡组；
  // 玩家与对手共用同一份可用列表，各选一套。不可用时回退内置卡组。
  _showDeckSelect() {
    const body = $('#deck-select-body');
    this._deckResult = new DeckSource(this.resolver).load();
    this._decks = this._deckResult.decks;
    this._playerDeck = 0;
    this._oppDeck = this._decks.length > 1 ? 1 : 0;
    this._renderDeckSelect(body);
    $('#screen-deck-select').classList.add('active');
    $('#deck-start').addEventListener('click', () => {
      $('#screen-deck-select').classList.remove('active');
      this._startGame(this._decks[this._playerDeck], this._decks[this._oppDeck]);
    });
  }

  /** 卡组来源提示文本（供卡组选择页与宿主显示） */
  deckSourceHint() {
    if (!this._deckResult) return '';
    const sourceText = this._deckResult.source === 'ptcg'
      ? `卡组来自卡牌库（共 ${this._decks ? this._decks.length : 0} 套可用）`
      : '卡组来自内置（卡牌库中未找到可用卡组）';
    const warnings = this._deckResult.warnings || [];
    return warnings.length ? `${sourceText}｜${warnings.slice(0, 2).join('；')}` : sourceText;
  }

  _renderDeckSelect(body) {
    body.innerHTML = '';

    // 来源与异常提示行
    const hint = document.createElement('div');
    hint.className = 'deck-source-hint';
    hint.textContent = this.deckSourceHint();
    body.appendChild(hint);

    const cols = [
      { title: '你的卡组', key: '_playerDeck' },
      { title: '对手卡组', key: '_oppDeck' }
    ];
    cols.forEach(col => {
      const div = document.createElement('div');
      div.className = 'deck-column';
      div.innerHTML = `<div class="deck-column-title">${col.title}</div>`;
      this._decks.forEach((deck, i) => {
        const opt = document.createElement('div');
        opt.className = 'deck-option' + (this[col.key] === i ? ' selected' : '');
        const info = this.resolver.getInfo(deck.coverCardId);
        const imgSrc = pokemonSpriteSrc(info.number);
        const count = deck.totalCount ? ` (${deck.totalCount}张)` : '';
        opt.innerHTML = `${imgSrc ? pokemonSpriteImgHtml(info.number, info.name, { preferOnline: SPRITE_PREFER_ONLINE }) : ''}<span>${deck.name}${count}</span>`;
        opt.addEventListener('click', () => { this[col.key] = i; this._renderDeckSelect(body); });
        div.appendChild(opt);
      });
      body.appendChild(div);
    });
  }

  _startGame(pDeck, oDeck) {
    this.engine.startGame(expandDeck(pDeck), expandDeck(oDeck));
    this._refresh();
    // 初始布置：直接在操作区显示手牌列表（点卡→放置战斗区/备战区），列表底部提供“确认布置”
    this._returnView = 'hand';
    this._showHandList();
  }

  // === Engine Log → context-aware routing ===
  _onEngineLog(msg) {
    this._lastMainStatus = msg;
    this._showMessage(msg);
  }

  // === Bind Events ===
  _bindAll() {
    // Main menu
    $('#main-menu').addEventListener('click', e => {
      const item = e.target.closest('.menu-item');
      if (!item || item.classList.contains('disabled')) return;
      this._onMainAction(item.dataset.action);
    });
    // Fight menu
    $('#fight-menu').addEventListener('click', e => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      if (item.classList.contains('back-item')) {
        if (this.gs.phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN); // 返回主要阶段，不消耗回合
        this._showPanel('panel-main');
        return;
      }
      if (item.classList.contains('disabled')) {
        this._appendBattleLog('能量不足，无法使用该招式');
        return;
      }
      this._doAttack(parseInt(item.dataset.idx));
    });
  }

  // === Main Actions ===
  _onMainAction(action) {
    const phase = this.gs.phase;
    const isP = this.gs.currentPlayer === this.gs.player1;
    if (!isP && phase !== PHASE.GAME_OVER) return;

    switch (action) {
      case 'fight':
        if (phase === PHASE.SETUP) {
          const ok = this.engine.advancePhase();
          if (ok === false) this._showSetupFailureStatus();
        } else if (phase === PHASE.BATTLE || phase === PHASE.MAIN) {
          // 规则：攻击不是独立阶段，而是在主要阶段内随时进行。
          // 进入“战斗视图”只切换 phase 用于招式校验，可随时返回且不消耗回合。
          if (phase === PHASE.MAIN) this.gs.setPhase(PHASE.BATTLE);
          this._showFightPanel();
        }
        break;
      case 'cards':
        if (phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN);
        this._showHandList();
        break;
      case 'pokemon':
        if (phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN);
        this._showPokemonList();
        break;
      case 'mulligan':
        if (phase === PHASE.SETUP && !this.gs.hasBasicInHand(this.gs.player1)) {
          this.engine.mulliganPlayer(this.gs.player1);
          this._selectedCardIdx = -1;
          this._renderScene();
          this._refresh();
        }
        break;
      case 'end':
        if (phase === PHASE.SETUP) {
          const ok = this.engine.advancePhase();
          if (ok === false) this._showSetupFailureStatus();
        } else if (phase === PHASE.MAIN || phase === PHASE.BATTLE) {
          // 需求：先进入二级菜单（结束回合 / 结束对战 / 返回）
          this._showEndMenu();
        }
        break;
    }
  }

  // ============================================================
  // 【结束】二级菜单：结束回合 / 结束对战 / 返回
  _showEndMenu() {
    const items = [
      {
        label: '结束回合',
        onSelect: () => {
          if (this.gs.phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN);
          this.engine.finishTurn();
        },
      },
      { label: '结束对战', meta: '认输并结束本局', onSelect: () => this._concede() },
      // 需求：不再需要额外的「返回」（列表底部已有默认返回按钮）
    ];
    this._showListView(items, { onBack: () => { this._refresh(); this._showPanel('panel-main'); } });
  }

  // 认输：直接判对手获胜
  _concede() {
    this.gs.winner = this.gs.player2;
    this.gs.setPhase(PHASE.GAME_OVER);
    this._appendBattleLog('你认输了，对手获胜');
    // 需求：结束对战直接回到开局选卡组的界面（而不是停在战斗界面）
    this._showDeckSelect();
  }

  // === Fight Panel ===
  _showFightPanel() {
    const mon = this.gs.player1.active;
    if (!mon) { this._showMessage('无出战宝可梦'); return; }
    const menu = $('#fight-menu');
    menu.innerHTML = '';
    const elem = this._elementLabel(mon.element);
    const attacks = mon.attacks || [];
    const usableCount = attacks.filter((_, i) => this.gs.checkEnergy(mon, i)).length;
    if (!attacks.length) this._appendBattleLog(`${mon.name} 没有可使用的招式`);
    else if (!usableCount) this._appendBattleLog(`${mon.name} 能量不足，无法使用招式（可返回）`);
    attacks.forEach((atk, i) => {
      const canUse = this.gs.checkEnergy(mon, i);
      const item = document.createElement('div');
      item.className = 'menu-item' + (!canUse ? ' disabled' : '') + (i === 0 ? ' selected' : '');
      item.dataset.idx = i;
      // 需求：只保留所需能量（招式名在左、能量在右），避免小屏信息截断
      const cost = (this.gs.adjustedAttackCost ? this.gs.adjustedAttackCost(mon, atk) : (atk.cost || []))
        .map(c => this._elementLabel(c)).join('·');
      const meta = cost || '无需能量';
      item.innerHTML = `<span class="mv-name">${atk.name}</span><span class="mv-meta">${meta}</span>`;
      menu.appendChild(item);
    });
    const back = document.createElement('div');
    back.className = 'menu-item back-item';
    back.textContent = '← 返回';
    menu.appendChild(back);
    $('#fight-text').textContent = '选择招式！';
    this._showPanel('panel-fight');
  }

  async _doAttack(atkIdx) {
    const mon = this.gs.player1.active;
    if (!mon?.attacks?.[atkIdx]) return;
    if (!this.gs.checkEnergy(mon, atkIdx)) { this._appendBattleLog('能量不足，无法使用该招式'); return; }
    if (this.gs.phase === PHASE.MAIN) this.gs.setPhase(PHASE.BATTLE); // 攻击需要 BATTLE 校验
    const anim = this._animEnabled();
    const beforeOppId = this.gs.player2.active?.cardId ?? null;
    const beforeOppHp = this.gs.player2.active?.hp ?? null;
    if (anim) await this._playAttackAnimAsync('pl');
    else this._playAttackAnim('pl');
    const ok = await this.engine.attack(atkIdx);
    if (anim) {
      const afterOpp = this.gs.player2.active;
      const afterOppId = afterOpp?.cardId ?? null;
      // 受击：HP 下降且未换人 → 闪烁 + 血条过渡（transition 由 CSS 处理）
      if (afterOpp && beforeOppHp != null && afterOpp.hp < beforeOppHp && afterOppId === beforeOppId) {
        this._animateHit('opp');
        await this._sleep(560);
      }
      // 换人/击倒补位：登场缩放动画（先起始态再换图，避免旧图闪现）
      if (afterOppId !== beforeOppId) {
        if (!afterOpp) this._animateExit('opp');
        else this._animateEnter('opp', () => this._renderMon(afterOpp, 'opp'));
        await this._sleep(650);
      }
      this._renderScene();
    }
    // attack() itself advances the turn and triggers UI callbacks. Do not reopen the action panel here.
    if (!ok) this._refresh();
  }

  // === Target Panel (legacy, kept for compatibility) ===
  _handlePick(pick) {
    // AI 回合（或自动对战）的选择由策略应答，不走玩家 UI
    if (this.gs.aiPickHandler) return;
    // 去全屏界面：候选卡在右下操作区滚动列表中选择
    this._showPickCards(pick);
  }

  _handlePokemonPick(pick) {
    if (this.gs.aiPokemonPickHandler) return;
    // 去全屏界面：目标宝可梦在右下操作区列表中选
    this._showPickPokemon(pick);
  }


  // === Rendering ===
  _showSetupFailureStatus() {
    this._refresh();
    const latest = this._lastMainStatus || this.gs.log?.at?.(-1) || '布置失败，请检查双方是否有基础宝可梦';
    $('#main-text').textContent = `${latest}；可重试确认或重新选择卡组`;
    this._showPanel('panel-main');
  }

  _refresh() {
    this._renderScene();
    this._updateMainMenu();
    this._syncPlayerMainPanel();
  }

  _syncPlayerMainPanel() {
    if (this.gs.phase !== PHASE.MAIN || this.gs.currentPlayer !== this.gs.player1) return;
    // 正在操作区列表（手牌/场地/动作子菜单/选卡）中浏览时不打断
    const active = document.querySelector('.dialog-panel.active');
    if (active && active.id === 'panel-list') return;
    this._showPanel('panel-main');
  }

  _renderScene() {
    this._renderMon(this.gs.player1.active, 'pl');
    this._renderMon(this.gs.player2.active, 'opp');
    this._renderStats();
  }

  // 对局状态行：奖赏卡 / 牌库 / 手牌 / 弃牌（双方）
  _renderStats() {
    const fmt = pl => `奖赏 ${pl.prizes?.length ?? 0}/6 · 牌库 ${pl.deck?.length ?? 0} · 手牌 ${pl.hand?.length ?? 0}`;
    const plEl = $('#pl-stats');
    const oppEl = $('#opp-stats');
    if (plEl) plEl.textContent = fmt(this.gs.player1);
    if (oppEl) oppEl.textContent = fmt(this.gs.player2);
  }

  _renderMon(mon, prefix) {
    const nameEl = $(`#${prefix}-name`);
    const hpBar = $(`#${prefix}-hp-bar`);
    const hpText = $(`#${prefix}-hp-text`);
    const energyEl = $(`#${prefix}-energy`);
    const spriteEl = $(`#${prefix === 'pl' ? 'player' : 'opp'}-sprite`);
    const statusEl = $(`#${prefix}-status`);
    const tagsEl = $(`#${prefix}-tags`);

    const reset = () => {
      if (nameEl) nameEl.textContent = '???';
      if (hpBar) { hpBar.style.width = '0%'; hpBar.className = 'hp-bar-fill'; }
      if (hpText) hpText.textContent = '';
      if (energyEl) energyEl.innerHTML = '';
      if (spriteEl) spriteEl.innerHTML = '';
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (tagsEl) tagsEl.innerHTML = '';
    };
    if (!mon) { reset(); return; }

    if (nameEl) nameEl.textContent = mon.name;
    const pct = Math.max(0, Math.min(100, mon.hp / mon.maxHp * 100));
    if (hpBar) {
      hpBar.style.width = pct + '%';
      hpBar.className = 'hp-bar-fill' + (pct <= 20 ? ' red' : pct <= 50 ? ' yellow' : '');
    }
    if (hpText) hpText.textContent = `${mon.hp}/${mon.maxHp}`;

    // 规则标记（替代 pmBattle 的等级位）：规则盒 + 进化阶段
    if (tagsEl) {
      const tags = [];
      if (mon.isEx) tags.push('ex');
      if (mon.isRadiant) tags.push('光辉');
      const rb = String(mon.ruleBox || '');
      for (const k of ['VMAX', 'VSTAR', 'V', 'GX']) if (rb.includes(k) && !tags.includes(k)) tags.push(k);
      const stage = String(mon.stage || '');
      if (stage && stage !== '基础') tags.push(stage);
      tagsEl.innerHTML = tags.map(t => `<span class="rule-tag${/阶/.test(t) ? ' stage' : ''}">${t}</span>`).join('');
    }

    // 异常状态标签（pmBattle 风格：名字旁的标签）
    const statusMap = { poison: '毒', burn: '炎', sleep: '眠', paralysis: '痹', confusion: '乱' };
    const statuses = String(mon.status || '').split(',').filter(Boolean);
    if (statusEl) {
      statusEl.style.display = statuses.length ? 'inline-block' : 'none';
      statusEl.textContent = statuses.map(s => statusMap[s] || s).join(' ');
      statusEl.className = 'status-tag' + (statuses[0] ? ' ' + statuses[0] : '');
    }

    // 附着能量 + 宝可梦道具
    if (energyEl) {
      const icons = (mon.energy || []).map(e => `<span class="energy ${this._eleClass(e)}" title="${energyLabel(e)}"></span>`).join('');
      const tool = mon.tool ? `<span class="energy" style="background:#ffd964" title="${(mon.tool && (mon.tool.name || mon.tool.cardId)) || '宝可梦道具'}"></span>` : '';
      energyEl.innerHTML = icons + tool;
    }

    // 立绘（在线优先 + 本地/正面回退；我方用背面形象）
    if (spriteEl) {
      const info = this.resolver.getInfo(mon.cardId);
      if (info && info.number) {
        spriteEl.innerHTML = pokemonSpriteImgHtml(info.number, mon.name, { preferOnline: SPRITE_PREFER_ONLINE, back: prefix === 'pl' });
      } else {
        spriteEl.innerHTML = `<div class="placeholder">${mon.name}</div>`;
      }
      // 需求：裁掉立绘底部的透明留白，让脚踩在脚踏台上
      const trimImg = spriteEl.querySelector('img');
      if (trimImg) {
        trimImg.addEventListener('load', () => applySpriteBottomTrim(trimImg), { once: true });
        if (trimImg.complete) applySpriteBottomTrim(trimImg);
      }
    }
  }
  // ============================================================
  //  操作区列表系统（去全屏界面：手牌/宝可梦/候选/目标 全部在右下操作区）
  // ============================================================
  _showListView(items, { onBack = null } = {}) {
    const menu = $('#list-menu');
    if (!menu) return;
    menu.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'menu-item' + (it.disabled ? ' disabled' : '') + (it.selected ? ' selected' : '');
      el.innerHTML = `<span class="mv-name">${it.label}</span>${it.meta ? `<span class="mv-meta">${it.meta}</span>` : ''}`;
      if (!it.disabled && typeof el.addEventListener === 'function') el.addEventListener('click', () => it.onSelect?.());
      menu.appendChild(el);
    }
    if (onBack) {
      const back = document.createElement('div');
      back.className = 'menu-item back-item';
      back.innerHTML = '<span class="mv-name">← 返回</span>';
      if (typeof back.addEventListener === 'function') back.addEventListener('click', () => onBack());
      menu.appendChild(back);
    }
    this._showPanel('panel-list');
  }

  _cardTypeTag(cd) {
    if (!cd) return '';
    // 卡牌页签/手牌列表里宝可梦只保留「宝可梦」三个字（阶段、HP、属性都不再追加，
    // 避免小屏右侧信息被截断）
    if (cd.cardType === 'pokemon') return '宝可梦';
    if (cd.cardType === 'energy') return '基本能量';
    if (cd.cardType === 'specialEnergy') return '特殊能量';
    if (cd.cardType === 'trainer') return { item: '物品', supporter: '支援者', stadium: '竞技场', tool: '宝可梦道具' }[cd.trainerType] || '训练家';
    return '';
  }

  _cardMeta(cd) {
    const tag = this._cardTypeTag(cd);
    if (!cd) return tag;
    if (cd.cardType === 'pokemon') return tag;   // 需求：宝可梦只显示「宝可梦」
    const extra = [];
    if (cd.ability?.active) extra.push(`特性:${cd.ability.name}`);
    return [tag, ...extra].filter(Boolean).join(' · ');
  }

  // 能量属性单字（按附着顺序拼接，用于「场地」列表右侧信息）
  _energyShort(e) {
    const label = energyLabel(e);
    const keys = ['草', '火', '水', '雷', '超', '斗', '恶', '钢', '龙', '妖', '无'];
    for (const k of keys) if (label.includes(k)) return k;
    const el = (typeof e === 'object' && e) ? (e.element || e.provides?.[0]?.types?.[0]) : null;
    return el ? this._elementLabel(el) : '';
  }

  _energyShortText(mon) {
    return (mon?.energy || []).map(e => this._energyShort(e)).filter(Boolean).join('');
  }

  // 手牌列表（滚动）：点击进入卡牌动作子菜单
  _showHandList() {
    this._returnView = 'hand';
    const pl = this.gs.player1;
    const hand = pl?.hand || [];

    // ===== 开局布置：独立界面 =====
    // 需求：只允许放置基础宝可梦（其余手牌置灰）；放置/完成布置/重新抽牌都在本界面完成，
    // 不提供「返回上级」；不进入任何卡牌二级菜单。
    if (this.gs.phase === PHASE.SETUP) {
      const hasBasic = this.gs.hasBasicInHand ? this.gs.hasBasicInHand(pl) : true;
      const benchFull = (pl.bench?.length || 0) >= 5;
      const items = hand.map((cid, idx) => {
        const cd = this.resolver.getCard(cid);
        const isBasic = cd?.cardType === 'pokemon' && !cd.evolvesFrom;
        const noSlot = !!pl.active && benchFull;
        const canPlace = isBasic && !noSlot;
        const meta = !isBasic ? '仅能放置基础宝可梦'
          : noSlot ? '没有可放置的位置'
          : (pl.active ? '放置到备战区' : '放置到战斗区');
        return {
          label: cd?.name || String(cid),
          meta,
          disabled: !canPlace,
          onSelect: () => this._placeBasicInSetup(idx, cd),
        };
      });
      if (!items.length) items.push({ label: '（手牌为空）', disabled: true });
      // 需求：只有起手真的没有基础宝可梦、且还没放置过出战宝可梦时，才提供重新抽牌。
      // （原来只要手牌里没有基础宝可梦就亮，导致把基础宝可梦全部放上场后也会出现该按钮）
      if (!hasBasic && !pl.active) {
        items.push({
          label: '重新抽牌', meta: '手牌没有基础宝可梦（对手补抽 1 张）',
          onSelect: () => {
            this.engine.mulliganPlayer(this.gs.player1);
            this._selectedCardIdx = -1;
            this._renderScene();
            this._showHandList();
          },
        });
      }
      items.push({
        label: '完成布置',
        meta: pl.active ? '' : '请先放置 1 只基础宝可梦到战斗区',
        disabled: !pl.active,
        onSelect: () => {
          const ok = this.engine.advancePhase();
          if (ok === false) this._showSetupFailureStatus();
          else this._refresh();
        },
      });
      this._showListView(items);   // 不传 onBack：布置阶段没有返回上级
      return;
    }

    // ===== 对局中的手牌 =====
    // 需求：点击卡牌即代表使用（不再二次确认）；不可用的卡牌置灰并说明原因。
    const items = hand.map((cid, idx) => {
      const cd = this.resolver.getCard(cid);
      const u = this._handCardUsability(cd);
      return {
        label: cd?.name || String(cid),
        meta: u.ok ? this._cardMeta(cd) : (u.reason || '当前不可使用'),
        disabled: !u.ok,
        onSelect: () => this._useCardDirect(idx, cd),
      };
    });
    if (!items.length) items.push({ label: '（手牌为空）', disabled: true });
    items.push({ label: '查看弃牌区', meta: `${pl.discard?.length || 0} 张`, onSelect: () => this._showDiscardList() });
    this._showListView(items, { onBack: () => { this._refresh(); this._showPanel('panel-main'); } });
  }

  // 手牌可用性判定（需求：不可用的卡直接置灰，而不是点了再提示）
  _handCardUsability(cd) {
    const pl = this.gs.player1;
    if (!cd) return { ok: false, reason: '未知卡牌' };
    const mons = [
      ...(pl.active ? [{ slot: 'active', mon: pl.active }] : []),
      ...(pl.bench || []).map((m, i) => (m ? { slot: `bench-${i}`, mon: m } : null)).filter(Boolean),
    ];
    // 基础宝可梦：需要有空位
    if (cd.cardType === 'pokemon' && !cd.evolvesFrom) {
      const noSlot = !!pl.active && (pl.bench?.length || 0) >= 5;
      return noSlot ? { ok: false, reason: '没有可放置的位置' } : { ok: true };
    }
    // 进化宝可梦：场上要有可进化的底座（名匹配、非本回合出场/进化）
    if (cd.cardType === 'pokemon' && cd.evolvesFrom) {
      const ok = mons.some(t => t.mon.name === cd.evolvesFrom && !t.mon.evolvedThisTurn && !t.mon.placedThisTurn);
      return ok ? { ok: true } : { ok: false, reason: '没有可进化的底座' };
    }
    // 能量：每回合 1 次，且场上要有宝可梦
    if (cd.cardType === 'energy' || cd.cardType === 'specialEnergy') {
      if (pl.energyAttached) return { ok: false, reason: '本回合已附着过能量' };
      return mons.length ? { ok: true } : { ok: false, reason: '场上没有宝可梦' };
    }
    // 宝可梦道具：需要有未装备道具的宝可梦
    if (cd.cardType === 'trainer' && cd.trainerType === 'tool') {
      const free = mons.filter(t => !t.mon.tool);
      return free.length ? { ok: true } : { ok: false, reason: '没有可装备的目标' };
    }
    // 训练家（物品/支援者/竞技场）：沿用引擎的合法性判定
    if (cd.cardType === 'trainer') {
      const chk = this.gs.canUseTrainer ? this.gs.canUseTrainer(pl, cd, null) : { ok: true };
      return chk.ok ? { ok: true } : { ok: false, reason: this.gs._trainerLegalityMessage?.(chk) || chk.message || '当前不可用' };
    }
    // 手牌/弃牌区主动特性
    if (cd.ability?.active && ['hand', 'discard'].includes(cd.ability.zone)) {
      const chk = this.gs.canUseAbility ? this.gs.canUseAbility(pl, cd, cd.ability, cd.ability.zone) : { ok: true };
      return chk.ok ? { ok: true } : { ok: false, reason: this.gs._abilityReasonText?.(chk.reason) || chk.message || '当前不可用' };
    }
    return { ok: false, reason: '当前无法使用' };
  }

  // 点击手牌即使用：单目标情形直接执行，多目标情形才进入目标选择
  async _useCardDirect(idx, cd) {
    const pl = this.gs.player1;
    const done = () => { this._selectedCardIdx = -1; this._renderScene(); this._afterAction(); };
    const mons = [
      ...(pl.active ? [{ slot: 'active', mon: pl.active }] : []),
      ...(pl.bench || []).map((m, i) => (m ? { slot: `bench-${i}`, mon: m } : null)).filter(Boolean),
    ];
    if (!cd) return;

    // 基础宝可梦：战斗区优先，其次备战区
    if (cd.cardType === 'pokemon' && !cd.evolvesFrom) {
      if (!pl.active) { this.engine.placeActivePokemon(idx, cd); done(); return; }
      if ((pl.bench?.length || 0) < 5) { this.engine.placeBenchPokemon(idx, cd); done(); return; }
      this._appendBattleLog('没有可放置的位置'); return;
    }
    // 进化：唯一底座直接进化，多底座才让玩家选
    if (cd.cardType === 'pokemon' && cd.evolvesFrom) {
      const targets = mons.filter(t => t.mon.name === cd.evolvesFrom && !t.mon.evolvedThisTurn && !t.mon.placedThisTurn);
      if (!targets.length) { this._appendBattleLog('没有可进化的底座'); return; }
      if (targets.length === 1) { this.engine.evolvePokemon(idx, cd, targets[0].slot); done(); return; }
      this._pickPokemonFor({ kind: 'evolve', handIdx: idx, cd }); return;
    }
    // 能量：唯一宝可梦直接附着，多只才让玩家选
    if (cd.cardType === 'energy' || cd.cardType === 'specialEnergy') {
      if (pl.energyAttached) { this._appendBattleLog('本回合已附着过能量'); return; }
      if (!mons.length) { this._appendBattleLog('场上没有宝可梦'); return; }
      if (mons.length === 1) {
        const ok = await this.engine.attachEnergy(idx, cd, mons[0].slot);
        if (ok && cd.effects?.length) { try { await executeEffects(this.gs, pl, cd.effects); } catch (e) { /* 忽略 */ } }
        done(); return;
      }
      this._pickPokemonFor({ kind: 'energy', handIdx: idx, cd }); return;
    }
    // 道具：唯一可用目标直接装备
    if (cd.cardType === 'trainer' && cd.trainerType === 'tool') {
      const free = mons.filter(t => !t.mon.tool);
      if (!free.length) { this._appendBattleLog('没有可装备的目标'); return; }
      if (free.length === 1) { await this.engine.useTrainer(idx, cd, free[0].slot); done(); return; }
      this._pickPokemonFor({ kind: 'tool', handIdx: idx, cd }); return;
    }
    // 训练家：直接使用
    if (cd.cardType === 'trainer') { await this.engine.useTrainer(idx, cd); done(); return; }
    // 手牌/弃牌区主动特性
    if (cd.ability?.active && ['hand', 'discard'].includes(cd.ability.zone)) {
      await this.engine.useAbility(cd, cd.ability, { player: pl, zone: cd.ability.zone });
      done(); return;
    }
    this._appendBattleLog('这张卡当前无法使用');
  }

  // 开局布置：点击基础宝可梦直接放置（战斗区优先，其次备战区）
  _placeBasicInSetup(idx, cd) {
    const pl = this.gs.player1;
    const done = () => { this._selectedCardIdx = -1; this._renderScene(); this._showHandList(); };
    if (!pl.active) { this.engine.placeActivePokemon(idx, cd); done(); return; }
    if ((pl.bench?.length || 0) < 5) { this.engine.placeBenchPokemon(idx, cd); done(); return; }
    this._appendBattleLog('没有可放置的位置');
  }

  _showDiscardList() {
    const pl = this.gs.player1;
    const items = (pl.discard || []).map(cid => {
      const cd = this.resolver.getCard(cid);
      return { label: cd?.name || String(cid), meta: this._cardMeta(cd), disabled: true };
    });
    if (!items.length) items.push({ label: '（弃牌区为空）', disabled: true });
    this._showListView(items, { onBack: () => this._showHandList() });
  }

  // 卡牌动作子菜单
  _showCardActions(idx) {
    const pl = this.gs.player1;
    const cd = this.resolver.getCard(pl?.hand?.[idx]);
    if (!cd) return;
    const phase = this.gs.phase;
    const setup = phase === PHASE.SETUP;
    const items = [];
    const done = () => { this._selectedCardIdx = -1; this._renderScene(); this._afterAction(); };

    if (cd.cardType === 'pokemon' && !cd.evolvesFrom) {
      if (!pl.active) items.push({ label: '放置到战斗区', meta: '基础宝可梦', onSelect: () => { this.engine.placeActivePokemon(idx, cd); done(); } });
      const benchFull = (pl.bench?.length || 0) >= 5;
      items.push({ label: '放置到备战区', meta: benchFull ? '备战区已满' : `备战 ${pl.bench?.length || 0}/5`, disabled: benchFull, onSelect: () => { this.engine.placeBenchPokemon(idx, cd); done(); } });
    }
    if (cd.cardType === 'pokemon' && cd.evolvesFrom) {
      // 需求：当回合不可进化的宝可梦（刚出场/本回合已进化）→ 进化选项置灰
      const fieldMons = [pl.active, ...(pl.bench || [])].filter(Boolean);
      const bases = fieldMons.filter(mon => mon.name === cd.evolvesFrom);
      const targets = bases.filter(mon => !mon.placedThisTurn && !mon.evolvedThisTurn);
      const meta = targets.length
        ? `由 ${cd.evolvesFrom} 进化`
        : (bases.length ? '本回合刚出场或已进化，下回合才能进化' : `场上没有 ${cd.evolvesFrom}`);
      items.push({ label: '进化', meta, disabled: !targets.length, onSelect: () => this._pickPokemonFor({ kind: 'evolve', handIdx: idx, cd }) });
    }
    if (cd.cardType === 'energy' || cd.cardType === 'specialEnergy') {
      const used = !!pl.energyAttached;
      items.push({ label: '附着能量', meta: used ? '本回合已附着过能量' : '每回合 1 次', disabled: used, onSelect: () => this._pickPokemonFor({ kind: 'energy', handIdx: idx, cd }) });
    }
    if (cd.cardType === 'trainer' && cd.trainerType === 'tool') {
      items.push({ label: '装备道具', meta: '选择宝可梦', onSelect: () => this._pickPokemonFor({ kind: 'tool', handIdx: idx, cd }) });
    }
    if (cd.cardType === 'trainer' && cd.trainerType !== 'tool') {
      const label = cd.trainerType === 'supporter' ? '使用支援者' : cd.trainerType === 'stadium' ? '打出竞技场' : '使用物品';
      // 与引擎一致的合法性判定：先攻最初回合禁支援者、每回合 1 张支援者、使用前提等
      const check = this.gs.canUseTrainer ? this.gs.canUseTrainer(pl, cd, null) : { ok: true };
      const reason = check.ok ? '' : (this.gs._trainerLegalityMessage?.(check) || '当前不可用');
      items.push({ label, meta: reason, disabled: !check.ok, onSelect: async () => { await this.engine.useTrainer(idx, cd); done(); } });
    }
    if (cd.ability?.active && ['hand', 'discard'].includes(cd.ability.zone)) {
      const zone = cd.ability.zone;
      items.push({ label: `使用特性`, meta: cd.ability.name, onSelect: async () => { await this.engine.useAbility(cd, cd.ability, { player: pl, zone }); done(); } });
    }
    items.push({ label: '返回手牌', onSelect: () => this._showHandList() });
    this._showListView(items, { onBack: () => this._showHandList() });
  }

  // 宝可梦列表（出战 + 备战）
  _showPokemonList() {
    this._returnView = 'pokemon';
    const pl = this.gs.player1;
    const items = [];
    // 需求：只留名字 + 「当前hp/总hp·能量」，去掉（出战）/（备战N）等占位提示
    const push = (slot, mon, tag) => {
      if (!mon) return;
      const enText = this._energyShortText(mon);
      const usable = this._pokeHasActions(slot, mon);
      items.push({
        label: mon.name,
        meta: enText ? `${mon.hp}/${mon.maxHp}·${enText}` : `${mon.hp}/${mon.maxHp}`,
        disabled: !usable,
        onSelect: () => this._showPokeActions(slot),
      });
    };
    push('active', pl.active, '出战');
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon, `备战${i + 1}`));
    items.push({ label: '查看对方场上', onSelect: () => this._showOpponentList() });
    // 竞技场（需求：可直接使用当前竞技场效果；仅当不存在/已用过/无可执行效果时置灰）
    const stadium = this.gs.getActiveStadium?.();
    if (stadium) {
      const chk = this.gs.canActivateStadium ? this.gs.canActivateStadium(pl) : { ok: false, message: '当前不可使用' };
      items.push({
        label: '使用竞技场效果',
        meta: chk.ok ? (stadium.name || stadium.cardId || '') : (chk.message || '当前不可使用'),
        disabled: !chk.ok,
        onSelect: async () => {
          await this.engine.activateStadium(pl);
          this._renderScene();
          this._afterAction();
        },
      });
    }
    this._showListView(items, { onBack: () => { this._refresh(); this._showPanel('panel-main'); } });
  }

  // 该宝可梦当前是否有任何可执行操作（需求：没有任何可做的就置灰，不给点进空菜单）
  _pokeHasActions(slot, mon) {
    const pl = this.gs.player1;
    if (!mon) return false;
    const hand = pl?.hand || [];
    const find = pred => hand.some(cid => { const c = this.resolver.getCard(cid); return c && pred(c); });
    // 进化
    if (find(c => c.cardType === 'pokemon' && c.evolvesFrom === mon.name)) return true;
    // 附着能量（每回合 1 次）
    if (!pl.energyAttached && find(c => c.cardType === 'energy' || c.cardType === 'specialEnergy')) return true;
    // 装备道具
    if (!mon.tool && find(c => c.cardType === 'trainer' && c.trainerType === 'tool')) return true;
    // 主动特性（可用即可点）
    if (mon.ability) {
      const zone = this.gs.inferAbilityZone?.(pl, mon) || 'field';
      const chk = this.gs.canUseAbility ? this.gs.canUseAbility(pl, mon, mon.ability, zone) : { ok: false };
      if (chk.ok) return true;
    }
    // 撤退（仅出战位且可支付）
    if (slot === 'active' && (pl.bench || []).some(Boolean) && !pl.retreatUsed && !mon.cannotRetreat) {
      const cost = this.gs.effectiveRetreatCost ? this.gs.effectiveRetreatCost(mon) : (mon.retreatCost ?? 1);
      const canPay = this.gs._canPayRetreatCost ? this.gs._canPayRetreatCost(mon, cost) : true;
      if (canPay) return true;
    }
    return false;
  }

  _showOpponentList() {
    const opp = this.gs.player2;
    const items = [];
    // 需求：对方场地同样只留名字 + 当前hp/总hp·能量
    const push = (mon, tag) => {
      if (!mon) return;
      const enText = this._energyShortText(mon);
      items.push({
        label: mon.name,
        meta: enText ? `${mon.hp}/${mon.maxHp}·${enText}` : `${mon.hp}/${mon.maxHp}`,
        disabled: true,
      });
    };
    push(opp.active, '出战');
    (opp.bench || []).forEach((mon, i) => push(mon, `备战${i + 1}`));
    if (!items.length) items.push({ label: '（对方场上无宝可梦）', disabled: true });
    this._showListView(items, { onBack: () => this._showPokemonList() });
  }

  // 宝可梦动作子菜单
  _showPokeActions(slot) {
    const pl = this.gs.player1;
    const mon = slot === 'active' ? pl.active : pl.bench?.[parseInt(String(slot).replace('bench-', ''), 10)];
    if (!mon) { this._showPokemonList(); return; }
    const items = [];
    const done = () => { this._renderScene(); this._afterAction(); };

    // 进化：手牌中存在可进化成该宝可梦的卡
    // 需求：当回合刚出场/已进化的宝可梦，进化选项要置灰（而不是点了才报错）
    const evoIdx = (pl.hand || []).findIndex(cid => { const c = this.resolver.getCard(cid); return c?.cardType === 'pokemon' && c.evolvesFrom === mon.name; });
    if (evoIdx >= 0) {
      const evo = this.resolver.getCard(pl.hand[evoIdx]);
      const blocked = !!mon.placedThisTurn || !!mon.evolvedThisTurn;
      items.push({
        label: '进化',
        meta: blocked ? '本回合刚出场或已进化，下回合才能进化' : `→ ${evo.name}`,
        disabled: blocked,
        onSelect: async () => { this.engine.evolvePokemon(evoIdx, evo, slot); done(); },
      });
    }
    // 附着能量：手牌中的能量卡
    const energyIdxs = (pl.hand || []).map((cid, i) => ({ cid, i })).filter(x => { const c = this.resolver.getCard(x.cid); return c?.cardType === 'energy' || c?.cardType === 'specialEnergy'; });
    if (energyIdxs.length) {
      const disabled = !!pl.energyAttached;
      items.push({
        label: '附着能量', meta: disabled ? '本回合已附着过能量' : `手牌能量 ${energyIdxs.length} 张`, disabled,
        onSelect: () => this._showHandSubset(energyIdxs, '选择要附着的能量', async (idx, cd) => {
          const ok = await this.engine.attachEnergy(idx, cd, slot);
          if (ok && cd.effects?.length) { try { await executeEffects(this.gs, pl, cd.effects); } catch (e) { /* 忽略 */ } }
          done();
        }),
      });
    }
    // 装备道具
    const toolIdxs = (pl.hand || []).map((cid, i) => ({ cid, i })).filter(x => { const c = this.resolver.getCard(x.cid); return c?.cardType === 'trainer' && c.trainerType === 'tool'; });
    if (toolIdxs.length && !mon.tool) {
      items.push({
        label: '装备宝可梦道具', meta: `手牌道具 ${toolIdxs.length} 张`,
        onSelect: () => this._showHandSubset(toolIdxs, '选择要装备的道具', async (idx, cd) => { await this.engine.useTrainer(idx, cd, slot); done(); }),
      });
    }
    // 主动特性（需求：不可用/已用过/被消除时置灰，而不是点了再报错）
    if (mon.ability) {
      const zone = this.gs.inferAbilityZone?.(pl, mon) || 'field';
      const chk = this.gs.canUseAbility ? this.gs.canUseAbility(pl, mon, mon.ability, zone) : { ok: true };
      const reason = chk.ok ? '' : (this.gs._abilityReasonText?.(chk.reason) || chk.message || '当前不可使用');
      items.push({
        label: '使用特性',
        meta: chk.ok ? mon.ability.name : reason,
        disabled: !chk.ok,
        onSelect: async () => { await this.engine.useAbility(mon, mon.ability, { player: pl, zone }); done(); },
      });
    }
    // 撤退（仅出战位）：显示真实撤退能量（含特性/道具修正），不足或已撤退则置灰
    if (slot === 'active') {
      const hasBench = (pl.bench || []).some(Boolean);
      const cost = this.gs.effectiveRetreatCost ? this.gs.effectiveRetreatCost(mon) : (mon?.retreatCost ?? 1);
      const canPay = this.gs._canPayRetreatCost ? this.gs._canPayRetreatCost(mon, cost) : true;
      const reason = !hasBench ? '备战区没有宝可梦'
        : pl.retreatUsed ? '本回合已撤退过'
        : mon.cannotRetreat ? '无法撤退'
        : !canPay ? '撤退能量不足' : '';
      items.push({
        label: '撤退',
        meta: reason || `撤退能量：${cost}`,
        disabled: !!reason,
        onSelect: () => this._showBenchForRetreat(),
      });
    }
    this._showListView(items, { onBack: () => this._showPokemonList() });
  }

  // 手牌子集选择（能量/道具等）
  _showHandSubset(entries, title, onPick) {
    const items = entries.map(({ cid, i }) => {
      const cd = this.resolver.getCard(cid);
      return { label: cd?.name || String(cid), meta: this._cardMeta(cd), onSelect: () => onPick(i, cd) };
    });
    this._showListView(items, { onBack: () => this._showPokeActions(this._pokePickSlot || 'active') });
  }

  // 选择宝可梦目标（进化/附能/装备）
  _pickPokemonFor({ kind, handIdx, cd }) {
    const pl = this.gs.player1;
    const items = [];
    const push = (slot, mon) => {
      if (!mon) return;
      // 需求：与【场地】列表保持一致 —— 只显示「名字 + 血量 + 能量」，去掉标签和冗余信息
      const enText = this._energyShortText(mon);
      // 进化目标：名字需匹配且本回合未出场/未进化（不可选时置灰）
      const blocked = kind === 'evolve'
        && (mon.name !== cd.evolvesFrom || mon.placedThisTurn || mon.evolvedThisTurn);
      items.push({
        label: mon.name,
        meta: enText ? `${mon.hp}/${mon.maxHp}·${enText}` : `${mon.hp}/${mon.maxHp}`,
        disabled: blocked,
        onSelect: async () => {
          if (kind === 'evolve') this.engine.evolvePokemon(handIdx, cd, slot);
          else if (kind === 'energy') {
            const ok = await this.engine.attachEnergy(handIdx, cd, slot);
            if (ok && cd.effects?.length) { try { await executeEffects(this.gs, pl, cd.effects); } catch (e) { /* 忽略 */ } }
          } else if (kind === 'tool') await this.engine.useTrainer(handIdx, cd, slot);
          this._selectedCardIdx = -1;
          this._renderScene();
          this._afterAction();
        },
      });
    };
    const label = kind === 'evolve' ? '选择进化目标' : kind === 'energy' ? '选择附着目标' : '选择装备目标';
    push('active', pl.active);
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon));
    if (!items.length) items.push({ label: '（无可选目标）', disabled: true });
    // 需求：点返回直接回到【卡牌】手牌列表（不再回到动作子菜单）
    this._showListView(items, { onBack: () => this._showHandList() });
  }

  // 撤退：选择换上的备战宝可梦（格式与【场地】列表一致：名字 + 血量 + 能量）
  _showBenchForRetreat() {
    const pl = this.gs.player1;
    const items = (pl.bench || []).map((mon) => {
      if (!mon) return null;
      const enText = this._energyShortText(mon);
      return {
        label: mon.name,
        meta: enText ? `${mon.hp}/${mon.maxHp}·${enText}` : `${mon.hp}/${mon.maxHp}`,
        onSelect: () => this._retreatTo(pl.bench.indexOf(mon)),
      };
    }).filter(Boolean);
    if (!items.length) items.push({ label: '（备战区无宝可梦）', disabled: true });
    this._showListView(items, { onBack: () => this._showPokeActions('active') });
  }

  async _retreatTo(benchIndex) {
    const pl = this.gs.player1;
    if (!pl.bench?.[benchIndex]) return;
    const cost = this.gs.effectiveRetreatCost ? this.gs.effectiveRetreatCost(pl.active) : (pl.active?.retreatCostOverride ?? pl.active?.retreatCost ?? 1);
    const energy = pl.active?.energy || [];
    if (cost > 0 && energy.length > 0) {
      if (!this.gs._canPayRetreatCost(pl.active, cost)) { this._appendBattleLog('撤退能量不足'); this._showPokeActions('active'); return; }
      const picked = await this.gs.waitForPick(energy.map(energyLabel), energy.length, { source: 'retreat-energy', cost, allowEmpty: true });
      if (!picked || picked.length === 0) { this._appendBattleLog('已取消撤退'); this._showPokeActions('active'); return; }
      if (!this.gs._canSelectedEnergyPayRetreat(pl.active, cost, picked)) { this._appendBattleLog('选择的能量不足'); this._showPokeActions('active'); return; }
      const ok = this.gs.retreat(pl, benchIndex, picked);
      if (!ok) { this._appendBattleLog(this.gs.log[this.gs.log.length - 1] || '无法撤退'); this._showPokeActions('active'); return; }
    } else {
      const ok = this.gs.retreat(pl, benchIndex);
      if (!ok) { this._appendBattleLog(this.gs.log[this.gs.log.length - 1] || '无法撤退'); this._showPokeActions('active'); return; }
    }
    this._renderScene();
    this._afterAction();
  }

  // 效果选卡：候选列表（滚动 + 多选 + 确定/取消）
  _showPickCards(pick) {
    const cards = pick.cards || [];
    const bounds = derivePickBounds(pick);
    const chosen = new Set();
    const finish = (indices) => {
      this.gs.resolvePick(indices);
      this._refresh();
      this._goBackToList();
    };
    const render = () => {
      const items = cards.map((label, i) => ({
        label: String(label),
        meta: chosen.has(i) ? '已选' : (bounds.max > 1 ? `选择（${chosen.size}/${bounds.max}）` : ''),
        selected: chosen.has(i),
        onSelect: () => {
          if (bounds.max <= 1) { finish([i]); return; }
          if (chosen.has(i)) chosen.delete(i);
          else {
            if (chosen.size >= bounds.max) chosen.delete(chosen.values().next().value);
            chosen.add(i);
          }
          render();
        },
      }));
      if (bounds.max > 1) items.push({ label: `确定`, meta: `${chosen.size}/${bounds.max}`, disabled: chosen.size < bounds.min, onSelect: () => finish([...chosen]) });
      if (bounds.min === 0) items.push({ label: '取消选择', onSelect: () => finish([]) });
      this._showListView(items, { onBack: () => finish([]) });
    };
    if (!cards.length) { finish([]); return; }
    render();
  }

  // 效果选宝可梦目标
  _showPickPokemon(pick) {
    const pl = pick.player || this.gs.player1;
    const options = pick.options || {};
    const finish = (slot) => {
      this.gs.resolvePokemonPick(slot);
      this._refresh();
      this._goBackToList();
    };
    const items = [];
    const push = (slot, mon) => {
      if (!mon || !pokemonPickerSlotAllowed(slot, options)) return;
      // 需求：与【场地】列表保持一致 —— 只显示名字 + 血量 + 能量
      const enText = this._energyShortText(mon);
      items.push({
        label: mon.name,
        meta: enText ? `${mon.hp}/${mon.maxHp}·${enText}` : `${mon.hp}/${mon.maxHp}`,
        onSelect: () => finish(slot),
      });
    };
    push('active', pl.active);
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon));
    if (!items.length) items.push({ label: '（无可选目标）', disabled: true });
    if (options.allowEmpty || options.optional) items.push({ label: '取消选择', onSelect: () => finish(null) });
    this._showListView(items, { onBack: () => finish(null) });
  }

  // 动作完成后回到来源页签（卡牌→手牌列表；场地→场地列表），便于连续操作
  _goBackToList() {
    if (this._returnView === 'hand') this._showHandList();
    else if (this._returnView === 'pokemon') this._showPokemonList();
    else this._showPanel('panel-main');
  }

  _afterAction() {
    if (this.gs.pendingPick || this.gs.pendingPokemonPick) return; // 等待玩家继续选择
    this._refresh();
    this._goBackToList();
  }

  _updateMainMenu() {
    const phase = this.gs.phase;
    const isP = this.gs.currentPlayer === this.gs.player1;
    const items = $$('#main-menu .menu-item');
    const over = phase === PHASE.GAME_OVER;
    this._ensureBackDeckButton();

    // 需求：对战结束后隐藏全部操作按钮，只显示「返回卡组选择」
    // （原来只是把战斗/结束置灰，卡牌与场地仍可点开）
    const backBtn = document.getElementById('main-back-deck');
    if (over) {
      items.forEach(it => { it.hidden = true; });
      if (backBtn) backBtn.hidden = false;
      $('#main-text').textContent = `${this.gs.winner?.name || ''} 获胜！`;
      this._showPanel('panel-main');
      return;
    }
    if (backBtn) backBtn.hidden = true;
    items.forEach(it => { if (it.id !== 'main-back-deck') it.hidden = false; });

    items[0].classList.toggle('disabled', over || !isP || (phase !== PHASE.BATTLE && phase !== PHASE.MAIN && phase !== PHASE.SETUP));
    items[0].textContent = phase === PHASE.SETUP ? '确认布置' : '战 斗';
    items[1].classList.toggle('disabled', false);
    items[2].classList.toggle('disabled', false);
    // 起手无基础宝可梦：提供“重新抽牌”（每重抽一次对手额外抽 1 张）
    const mulliganItem = [...items].find(item => item.dataset.action === 'mulligan');
    if (mulliganItem) {
      const needMulligan = phase === PHASE.SETUP && isP && !this.gs.hasBasicInHand(this.gs.player1);
      mulliganItem.hidden = !needMulligan;
      mulliganItem.classList.toggle('disabled', !needMulligan);
    }
    const endItem = [...items].find(item => item.dataset.action === 'end') || items[3];
    endItem.classList.toggle('disabled', over || !isP || (phase !== PHASE.MAIN && phase !== PHASE.BATTLE && phase !== PHASE.SETUP));
    endItem.textContent = phase === PHASE.SETUP ? '确认布置' : '结 束';

    if (over) {
      $('#main-text').textContent = `${this.gs.winner?.name || ''} 获胜！`;
    } else if (!isP) {
      $('#main-text').textContent = this._aiThinking ? '对手思考中…' : '对手回合...';
    } else {
      const texts = {
        [PHASE.SETUP]: '放置宝可梦后点确认',
        [PHASE.MAIN]: `${this.gs.player1.active?.name || ''}想做什么？`,
        [PHASE.BATTLE]: `${this.gs.player1.active?.name || ''}想做什么？`,
        [PHASE.DRAW]: '抽卡中...',
        [PHASE.END]: '回合结束'
      };
      $('#main-text').textContent = texts[phase] || '';
    }
    this._showPanel('panel-main');
  }

  // === Helpers ===
  // 对战结束后的唯一出口：返回选卡组界面
  _ensureBackDeckButton() {
    let btn = document.getElementById('main-back-deck');
    if (btn) return btn;
    const menu = document.getElementById('main-menu');
    if (!menu) return null;
    btn = document.createElement('div');
    btn.className = 'menu-item';
    btn.id = 'main-back-deck';
    btn.textContent = '返回卡组选择';
    btn.hidden = true;
    btn.addEventListener('click', () => this._showDeckSelect());
    menu.appendChild(btn);
    return btn;
  }

  _showPanel(id) {
    $$('.dialog-panel').forEach(p => p.classList.remove('active'));
    $(`#${id}`).classList.add('active');
  }

  _showMessage(msg) {
    const textEl = $('#msg-text');
    if (textEl) textEl.textContent = msg;
    this._appendBattleLog(msg);
    // 正在选择招式/目标时不打断（提示统一走左上信息栏）
    const activePanel = document.querySelector('.dialog-panel.active');
    const isChoosing = !!activePanel && (activePanel.id === 'panel-fight' || activePanel.id === 'panel-target');
    if (isChoosing) return;
    this._showPanel('panel-message');
    // 只在自己还停在提示面板时才收回。
    // 原实现无条件切回 panel-main：回合开始时引擎日志会触发 _showMessage，
    // 1.2 秒后把用户刚打开的【卡牌】页签顶掉，表现为“点进去又被弹回上一界面”。
    setTimeout(() => {
      const now = document.querySelector('.dialog-panel.active');
      if (now && now.id === 'panel-message') this._showPanel('panel-main');
    }, 1200);
  }

  // 战斗日志浮层（左上；可拖动滚动回看历史动作）
  _appendBattleLog(line) {
    const box = $('#battle-log');
    if (!box || !line) return;
    if (this._lastLogLine === line) return; // 去重（引擎回调与 GameState 日志可能同源）
    this._lastLogLine = line;
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    box.appendChild(div);
    // 保留更多历史（与 GameState MAX_LOG_ENTRIES 同量级），便于回查报错
    while (box.children.length > 200) box.removeChild(box.firstChild);
    // 实时跟随最新动作：默认始终跟随；用户主动上滚查看历史时暂停跟随（滚回底部恢复）
    if (this._logFollow !== false) box.scrollTop = box.scrollHeight;
  }

  /** 日志区支持鼠标按住拖动滚动（方便查看之前的动作/报错） */
  _bindLogDrag() {
    const box = $('#battle-log');
    if (!box || box.dataset.dragBound) return;
    box.dataset.dragBound = '1';
    let dragging = false, startY = 0, startTop = 0;
    // 是否跟随最新：滚到底部（容差内）则恢复跟随
    const syncFollow = () => {
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 48;
      this._logFollow = nearBottom;
    };
    this._logFollow = true;
    box.addEventListener('scroll', syncFollow);
    box.addEventListener('wheel', () => { setTimeout(syncFollow, 0); }, { passive: true });
    box.addEventListener('touchmove', () => { setTimeout(syncFollow, 0); }, { passive: true });
    box.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; startY = e.clientY; startTop = box.scrollTop;
      box.classList.add('dragging');
      try { box.setPointerCapture?.(e.pointerId); } catch (_) { /* 忽略 */ }
    });
    box.addEventListener('pointermove', e => {
      if (!dragging) return;
      box.scrollTop = startTop - (e.clientY - startY);
      syncFollow();
      e.preventDefault();
    });
    const end = e => {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('dragging');
      try { box.releasePointerCapture?.(e.pointerId); } catch (_) { /* 忽略 */ }
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('pointerleave', end);
  }

  _openOverlay(id) { $(`#${id}`)?.classList?.add('active'); }
  _closeOverlay(id) { $(`#${id}`)?.classList?.remove('active'); }

  // === 动画工具（真实浏览器启用；Node 测试环境无 document.body 时自动跳过） ===
  _animEnabled() {
    if (typeof globalThis !== 'undefined' && globalThis.PTCG_ANIM === 'off') return false;
    return typeof document !== 'undefined' && !!document.body;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _spriteEl(prefix) { return $(`#${prefix === 'pl' ? 'player' : 'opp'}-sprite`); }

  _pulseClass(el, cls, ms, keep = false) {
    if (!el || !el.classList) return;
    el.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
    void el.offsetWidth;
    el.classList.add(cls);
    if (keep || cls === 'anim-exit') return;
    setTimeout(() => el.classList.remove(cls), ms);
  }

  // 攻击：攻方前冲 → 对方受击闪烁（pmBattle 节奏）
  _playAttackAnim(prefix = 'pl') {
    const atkEl = this._spriteEl(prefix);
    const defEl = this._spriteEl(prefix === 'pl' ? 'opp' : 'pl');
    if (atkEl) {
      atkEl.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
      void atkEl.offsetWidth;
      atkEl.classList.add('anim-attack');
      setTimeout(() => atkEl.classList.remove('anim-attack'), 500);
    }
    if (defEl) setTimeout(() => this._pulseClass(defEl, 'anim-hit', 600), 420);
  }

  async _playAttackAnimAsync(prefix = 'pl') {
    this._playAttackAnim(prefix);
    await this._sleep(700);
  }

  _animateHit(prefix) { this._pulseClass(this._spriteEl(prefix), 'anim-hit', 600); }

  // 登场：先把立绘缩到 0（隐藏旧图）→ 回调内换图 → 恢复
  _animateEnter(prefix, onSwap) {
    const el = this._spriteEl(prefix);
    if (!el) { if (onSwap) onSwap(); return; }
    el.classList.remove('anim-attack', 'anim-hit', 'anim-enter', 'anim-exit');
    el.classList.add('anim-enter');
    void el.offsetWidth;
    if (onSwap) onSwap();
    setTimeout(() => el.classList.remove('anim-enter'), 520);
  }

  // 退场：缩到 0 并保持终态（由下次 enter/渲染清除）
  _animateExit(prefix) { this._pulseClass(this._spriteEl(prefix), 'anim-exit', 500, true); }

  _cardArtEnabled() {
    if (typeof globalThis !== 'undefined' && globalThis.PTCG_SHOW_CARD_ART === false) return false;
    return SHOW_CARD_ART;
  }

  _elementLabel(element) {
    const map = { grass: '草', fire: '火', water: '水', lightning: '雷', electric: '雷',
      psychic: '超', fighting: '斗', dark: '恶', metal: '钢', dragon: '龙', fairy: '妖', colorless: '无' };
    const key = String(element ?? '').toLowerCase();
    return map[key] || (element ? String(element) : '无');
  }

  _eleClass(energy) {
    return energyElementClass(energy);
  }

  _fitScreen() {
    // 竖屏单屏自适应：不再做 480x320 等比缩放，交给 CSS（max-width + 100dvh）
    const screen = $('#screen');
    if (!screen) return;
    screen.style.transform = '';
  }
}

// === 挂载入口（SPA 嵌入 / 独立页共用）===

let _battleAppInstance = null;

/** 挂载战斗应用（单例：重复调用只初始化一次，切页保留对战状态与 resize 监听） */
export function mountBattleApp() {
  if (_battleAppInstance) return _battleAppInstance;
  const root = document.getElementById('battle-app');
  if (!root) {
    console.warn('[Battle] 未找到 #battle-app 容器，无法挂载');
    return null;
  }
  _battleAppInstance = new PTCGBattleApp();
  return _battleAppInstance;
}

export function getBattleApp() {
  return _battleAppInstance;
}

/** 显示战斗视图（仅切换 class，不重新加载页面、不丢对战状态） */
let _hostScrollY = 0;
let _hostThemeColor = null;

export function showBattleApp() {
  const root = document.getElementById('battle-app');
  if (!root) return null;
  // 记住宿主滚动位置：body 在战斗期间 overflow:hidden 会重置它
  try { _hostScrollY = window.scrollY || 0; } catch (e) { _hostScrollY = 0; }
  // Safari/Android 工具栏跟随场地：宿主 theme-color 为深色(卡牌库)，
  // 战斗期间临时改为场地上方的天空色，退出时还原（iOS PWA 的状态栏由
  // black-translucent 透明显示页面内容，不受此影响）。
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { _hostThemeColor = meta.getAttribute('content'); meta.setAttribute('content', '#4a90d9'); }
  } catch (e) { /* ignore */ }
  const app = mountBattleApp();
  root.classList.add('active');
  document.body.classList.add('ptcg-battle-active');
  document.documentElement.classList.add('ptcg-battle-active');  // 让 html 铺场地背景（含刘海/底边安全区）
  app?._fitScreen?.();
  return app;
}

/** 隐藏战斗视图（回到卡牌库） */
export function hideBattleApp() {
  const root = document.getElementById('battle-app');
  if (root) root.classList.remove('active');
  document.body.classList.remove('ptcg-battle-active');
  document.documentElement.classList.remove('ptcg-battle-active');
  // 还原宿主 theme-color
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && _hostThemeColor !== null) meta.setAttribute('content', _hostThemeColor);
  } catch (e) { /* ignore */ }
  // 恢复宿主滚动位置（切页前用户看到的位置）
  try { window.scrollTo(0, _hostScrollY); } catch (e) { /* ignore */ }

}

// 兜底：页面存在 #battle-app 时自动展示战斗视图。
// SPA 宿主会先设 window.__PTCG_BATTLE_HOST__ = true 再显式调用 showBattleApp()。
if (typeof document !== 'undefined') {
  const autoMount = () => {
    if (!document.getElementById('battle-app')) return;
    showBattleApp();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
}
