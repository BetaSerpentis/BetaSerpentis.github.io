// js/main.js — PTCG Battle (FRLG Style)
import { GameState, PHASE } from './core/GameState.js';
import { BattleEngine } from './core/BattleEngine.js';
import { CardResolver } from './core/CardResolver.js';
import { executeEffects } from './core/EffectExecutor.js';
import { expandDeck } from './data/decks.js';
import { DeckSource } from './core/DeckSource.js';
import { pokemonSpriteImgHtml, pokemonSpriteSrc, cardThumbImgHtml, cardFullImgHtml } from './ui/SpriteUtils.js';

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

function derivePickBounds(pick = {}) {
  const options = pick?.options || {};
  const cardsLen = (pick.cards || []).length;
  const requested = Number.isFinite(pick.count) ? pick.count : 1;
  if (options.source === 'retreat-energy') return { min:0, max:cardsLen, allowEmpty:true, allowFewer:true };
  const rawMax = Number.isFinite(options.maxCount) ? options.maxCount : requested;
  let max = Math.max(0, Math.min(rawMax, cardsLen));
  let min;
  if (Number.isFinite(options.minCount)) min = options.minCount;
  else if (Number.isFinite(options.requiredMin)) min = options.requiredMin;
  else if (options.allowEmpty) min = 0;
  else if (options.allowFewer) min = max > 0 ? 1 : 0;
  else min = Math.min(requested, cardsLen);
  min = Math.max(0, Math.min(min, max));
  return { min, max, allowEmpty:min === 0, allowFewer:!!options.allowFewer || min < max };
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
    this.engine = new BattleEngine(this.gs, this.resolver, {
      onLog: m => this._onEngineLog(m),
      onPhaseChange: () => this._refresh(),
      onFieldUpdate: () => {
        this._renderScene();
        this._syncPlayerMainPanel();
      }
    });
    this.gs.onLog = m => this._appendBattleLog(m);
    this.gs._onPendingPick = pick => this._handlePick(pick);
    this.gs._onPendingPokemonPick = pick => this._handlePokemonPick(pick);
    this._bindAll();
    this._bindHostReturn();
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
        opt.innerHTML = `${imgSrc ? pokemonSpriteImgHtml(info.number, info.name, { preferOnline: true }) : ''}<span>${deck.name}${count}</span>`;
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
          if (phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN); // 先退出战斗视图再结束回合
          this.engine.finishTurn();
        }
        break;
    }
  }

  // ============================================================
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
      const cost = (atk.cost || []).map(c => this._elementLabel(c)).join('·');
      const dmg = atk.damage ? String(atk.damage) : '变化';
      const meta = `${elem} · ${dmg}${cost ? ` · 需 ${cost}` : ' · 无需能量'}`;
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
    // 去全屏界面：候选卡在右下操作区滚动列表中选择
    this._showPickCards(pick);
  }

  _handlePokemonPick(pick) {
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
        spriteEl.innerHTML = pokemonSpriteImgHtml(info.number, mon.name, { preferOnline: true, back: prefix === 'pl' });
      } else {
        spriteEl.innerHTML = `<div class="placeholder">${mon.name}</div>`;
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
    if (cd.cardType === 'pokemon') return cd.evolvesFrom ? `宝可梦·${cd.stage || '进化'}` : '宝可梦·基础';
    if (cd.cardType === 'energy') return '基本能量';
    if (cd.cardType === 'specialEnergy') return '特殊能量';
    if (cd.cardType === 'trainer') return { item: '物品', supporter: '支援者', stadium: '竞技场', tool: '宝可梦道具' }[cd.trainerType] || '训练家';
    return '';
  }

  _cardMeta(cd) {
    const tag = this._cardTypeTag(cd);
    if (!cd) return tag;
    const extra = [];
    if (cd.cardType === 'pokemon') {
      if (cd.hp) extra.push(`HP ${cd.hp}`);
      const elem = (String(cd.name || '').match(/【(.+?)】/) || [])[1];
      if (elem) extra.push(elem);
    }
    if (cd.ability?.active) extra.push(`特性:${cd.ability.name}`);
    return [tag, ...extra].filter(Boolean).join(' · ');
  }

  // 手牌列表（滚动）：点击进入卡牌动作子菜单
  _showHandList() {
    this._returnView = 'hand';
    const pl = this.gs.player1;
    const hand = pl?.hand || [];
    const items = hand.map((cid, idx) => {
      const cd = this.resolver.getCard(cid);
      return {
        label: cd?.name || String(cid),
        meta: this._cardMeta(cd),
        onSelect: () => this._showCardActions(idx),
      };
    });
    if (!items.length) items.push({ label: '（手牌为空）', disabled: true });
    if (this.gs.phase === PHASE.SETUP) {
      const hasBasic = this.gs.hasBasicInHand ? this.gs.hasBasicInHand(pl) : true;
      items.push({
        label: '确认布置',
        meta: hasBasic ? '' : '手牌没有基础宝可梦，请先重新抽牌',
        onSelect: () => {
          const ok = this.engine.advancePhase();
          if (ok === false) this._showSetupFailureStatus();
          else this._refresh();
        },
      });
    }
    items.push({ label: '查看弃牌区', meta: `${pl.discard?.length || 0} 张`, onSelect: () => this._showDiscardList() });
    this._showListView(items, { onBack: () => { this._refresh(); this._showPanel('panel-main'); } });
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
      items.push({ label: '进化', meta: `由 ${cd.evolvesFrom} 进化`, onSelect: () => this._pickPokemonFor({ kind: 'evolve', handIdx: idx, cd }) });
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
    const push = (slot, mon, tag) => {
      if (!mon) return;
      const st = mon.status ? ` · ${mon.status}` : '';
      const en = (mon.energy || []).length;
      items.push({
        label: `${mon.name}${tag ? `（${tag}）` : ''}`,
        meta: `HP ${mon.hp}/${mon.maxHp}${st} · 能量 ${en}${mon.ability?.active ? ` · 特性:${mon.ability.name}` : ''}`,
        onSelect: () => this._showPokeActions(slot),
      });
    };
    push('active', pl.active, '出战');
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon, `备战${i + 1}`));
    items.push({ label: '查看对方场上', onSelect: () => this._showOpponentList() });
    const stadium = this.gs.getActiveStadium?.();
    if (stadium) items.push({ label: '查看竞技场', meta: stadium.name || stadium.cardId || '', disabled: true });
    this._showListView(items, { onBack: () => { this._refresh(); this._showPanel('panel-main'); } });
  }

  _showOpponentList() {
    const opp = this.gs.player2;
    const items = [];
    const push = (mon, tag) => {
      if (!mon) return;
      items.push({ label: `${mon.name}${tag ? `（${tag}）` : ''}`, meta: `HP ${mon.hp}/${mon.maxHp}${mon.status ? ` · ${mon.status}` : ''} · 能量 ${(mon.energy || []).length}`, disabled: true });
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
    const evoIdx = (pl.hand || []).findIndex(cid => { const c = this.resolver.getCard(cid); return c?.cardType === 'pokemon' && c.evolvesFrom === mon.name; });
    if (evoIdx >= 0) {
      const evo = this.resolver.getCard(pl.hand[evoIdx]);
      items.push({ label: '进化', meta: `→ ${evo.name}`, onSelect: async () => { this.engine.evolvePokemon(evoIdx, evo, slot); done(); } });
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
    // 主动特性
    if (mon.ability?.active) {
      items.push({
        label: '使用特性', meta: mon.ability.name,
        onSelect: async () => { await this.engine.useAbility(mon, mon.ability, { player: pl, zone: this.gs.inferAbilityZone?.(pl, mon) || 'field' }); done(); },
      });
    }
    // 撤退（仅出战位）
    if (slot === 'active' && (pl.bench || []).some(Boolean)) {
      items.push({ label: '撤退', meta: '选择换上的备战宝可梦', onSelect: () => this._showBenchForRetreat() });
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
    const push = (slot, mon, tag) => {
      if (!mon) return;
      items.push({
        label: `${mon.name}${tag ? `（${tag}）` : ''}`,
        meta: `HP ${mon.hp}/${mon.maxHp} · 能量 ${(mon.energy || []).length}`,
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
    // 进化目标限制：名字匹配 evolvesFrom（由 engine 再校验）
    push('active', pl.active, '出战');
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon, `备战${i + 1}`));
    if (!items.length) items.push({ label: '（无可选目标）', disabled: true });
    this._showListView(items, { onBack: () => this._showCardActions(handIdx) });
  }

  // 撤退：选择换上的备战宝可梦
  _showBenchForRetreat() {
    const pl = this.gs.player1;
    const items = (pl.bench || []).map((mon, i) => mon ? {
      label: mon.name, meta: `HP ${mon.hp}/${mon.maxHp} · 备战${i + 1}`,
      onSelect: () => this._retreatTo(i),
    } : null).filter(Boolean);
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
    const push = (slot, mon, tag) => {
      if (!mon || !pokemonPickerSlotAllowed(slot, options)) return;
      items.push({ label: `${mon.name}（${tag}）`, meta: `HP ${mon.hp}/${mon.maxHp}${mon.status ? ` · ${mon.status}` : ''}`, onSelect: () => finish(slot) });
    };
    push('active', pl.active, '出战');
    (pl.bench || []).forEach((mon, i) => push(`bench-${i}`, mon, `备战${i + 1}`));
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
      $('#main-text').textContent = '对手回合...';
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
    setTimeout(() => this._showPanel('panel-main'), 1200);
  }

  // 战斗日志浮层（左上，保留最近 6 行，pmBattle 风格）
  _appendBattleLog(line) {
    const box = $('#battle-log');
    if (!box || !line) return;
    if (this._lastLogLine === line) return; // 去重（引擎回调与 GameState 日志可能同源）
    this._lastLogLine = line;
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    box.appendChild(div);
    while (box.children.length > 6) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
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

export function showBattleApp() {
  const root = document.getElementById('battle-app');
  if (!root) return null;
  // 记住宿主滚动位置：body 在战斗期间 overflow:hidden 会重置它
  try { _hostScrollY = window.scrollY || 0; } catch (e) { _hostScrollY = 0; }
  // 注：宿主已不再声明 theme-color（否则 Safari 会用固定色渲染状态栏区域，遮挡场地背景），因此这里不需要切换。
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
