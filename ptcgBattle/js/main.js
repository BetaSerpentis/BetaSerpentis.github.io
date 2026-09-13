// js/main.js — PTCG Battle (FRLG Style)
import { GameState, PHASE } from './core/GameState.js';
import { BattleEngine } from './core/BattleEngine.js';
import { CardResolver } from './core/CardResolver.js';
import { executeEffects } from './core/EffectExecutor.js';
import { TEST_DECKS, expandDeck } from './data/decks.js';
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
    this._cardScreenReturnStack = [];
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
    this._fitScreen();
    window.addEventListener('resize', () => this._fitScreen());
    this._showDeckSelect();
  }

  // === Deck Selection ===
  _showDeckSelect() {
    const body = $('#deck-select-body');
    this._playerDeck = 0;
    this._oppDeck = 1;
    this._renderDeckSelect(body);
    $('#screen-deck-select').classList.add('active');
    $('#deck-start').addEventListener('click', () => {
      $('#screen-deck-select').classList.remove('active');
      this._startGame(TEST_DECKS[this._playerDeck], TEST_DECKS[this._oppDeck]);
    });
  }

  _renderDeckSelect(body) {
    body.innerHTML = '';
    const cols = [
      { title: '你的卡组', key: '_playerDeck' },
      { title: '对手卡组', key: '_oppDeck' }
    ];
    cols.forEach(col => {
      const div = document.createElement('div');
      div.className = 'deck-column';
      div.innerHTML = `<div class="deck-column-title">${col.title}</div>`;
      TEST_DECKS.forEach((deck, i) => {
        const opt = document.createElement('div');
        opt.className = 'deck-option' + (this[col.key] === i ? ' selected' : '');
        const info = this.resolver.getInfo(deck.coverCardId);
        const imgSrc = pokemonSpriteSrc(info.number);
        opt.innerHTML = `${imgSrc ? pokemonSpriteImgHtml(info.number, info.name, { preferOnline: true }) : ''}<span>${deck.name}</span>`;
        opt.addEventListener('click', () => { this[col.key] = i; this._renderDeckSelect(body); });
        div.appendChild(opt);
      });
      body.appendChild(div);
    });
  }

  _startGame(pDeck, oDeck) {
    this.engine.startGame(expandDeck(pDeck), expandDeck(oDeck));
    this._refresh();
    this._openSetupCardScreen('请放置宝可梦到战斗区');
  }

  // === Engine Log → context-aware routing ===
  _onEngineLog(msg) {
    // If card screen is open, log goes there; otherwise to main message
    if ($('#screen-cards').classList.contains('active')) {
      this._cardLog.push(msg);
      this._renderCardLog();
    } else {
      this._lastMainStatus = msg;
      this._showMessage(msg);
    }
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
    // Target menu (legacy, kept for backward compat but prefer pokemon screen)
    $('#target-menu').addEventListener('click', e => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      if (item.classList.contains('back-item')) { this._pokeMode = 'view'; this._showPanel('panel-main'); return; }
      this._resolveTarget(item.dataset.slot);
    });
    // Cards screen
    $('#cards-prev').addEventListener('click', () => this._changeCardPage(-1));
    $('#cards-next').addEventListener('click', () => this._changeCardPage(1));
    $('#cards-back').addEventListener('click', () => this._closeCardScreen());
    $('#cards-use').addEventListener('click', () => this._useSelectedCard());
    $('#cards-confirm-setup')?.addEventListener('click', () => this._confirmSetupFromCardScreen());
    $('#card-list').addEventListener('click', e => {
      const item = e.target.closest('.card-list-item');
      if (!item) return;
      this._selectCardInList(parseInt(item.dataset.idx));
    });
    // Pokemon screen
    $('#poke-prev').addEventListener('click', () => this._changePokePage(-1));
    $('#poke-next').addEventListener('click', () => this._changePokePage(1));
    $('#poke-back').addEventListener('click', () => this._closePokeScreen());
    $('#poke-swap').addEventListener('click', () => this._onPokeAction());
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
        this._openCardScreen('hand');
        break;
      case 'pokemon':
        if (phase === PHASE.BATTLE) this.gs.setPhase(PHASE.MAIN);
        this._openPokeScreen('view');
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
  //  CARD SCREEN — template for all card viewing/selection
  // ============================================================

  /**
   * Open card screen in a given mode.
   * @param {'hand'|'search-deck'|'search-discard'|'prize'} mode
   * @param {Function} cb - callback with selected card IDs when in search/prize mode
   */
  _openCardScreen(mode = 'hand', cb = null, cards = null, title = null, options = {}) {
    this._cardMode = mode;
    this._cardModeCb = cb;
    this._cardPickCards = cards;
    this._cardPickTitle = title;
    this._cardPage = mode === 'pick-cards' ? 0 : (mode === 'hand' ? 0 : this._cardPageForMode(mode));
    this._selectedCardIdx = -1;
    this._selectedCardIndices = new Set();
    this._cardPickMax = Number.isFinite(cb?.max) ? cb.max : null;
    this._cardPickMin = Number.isFinite(cb?.min) ? cb.min : 1;
    this._cardPickAllowEmpty = !!cb?.allowEmpty;
    this._cardPickAllowFewer = !!cb?.allowFewer;
    if (!options.preserveLog) this._cardLog = [];
    this._openOverlay('screen-cards');
    this._renderCardList();
  }

  _captureCardScreenState() {
    return {
      mode: this._cardMode,
      page: this._cardPage,
      selectedIdx: this._selectedCardIdx,
      log: [...(this._cardLog || [])],
    };
  }

  _restoreCardScreenState(state) {
    if (!state) return false;
    const savedLog = Array.isArray(state.log) ? state.log : [];
    const currentLog = Array.isArray(this._cardLog) ? this._cardLog : [];
    const appendedLog = currentLog.slice(savedLog.length);
    this._cardMode = state.mode || 'hand';
    this._cardModeCb = null;
    this._cardPickCards = null;
    this._cardPickTitle = null;
    this._cardPickMax = null;
    this._cardPickMin = 1;
    this._cardPickAllowEmpty = false;
    this._cardPickAllowFewer = false;
    this._cardPage = Number.isInteger(state.page) ? state.page : 0;
    this._selectedCardIdx = Number.isInteger(state.selectedIdx) ? state.selectedIdx : -1;
    this._selectedCardIndices = new Set();
    this._cardLog = [...savedLog, ...appendedLog];
    this._openOverlay('screen-cards');
    this._renderScene();
    this._renderCardList();
    return true;
  }

  _openSetupCardScreen(initialMessage = null) {
    this._openCardScreen('hand', null, null, '初始布置');
    if (initialMessage) this._pushCardStatus(initialMessage);
  }

  _isSetupHandCardScreen() {
    return this.gs.phase === PHASE.SETUP && this._cardMode === 'hand';
  }

  _isCardScreenActive() {
    return $('#screen-cards')?.classList?.contains('active');
  }

  _finishCardPickMode(closeOverlay = true) {
    const restoreState = this._cardScreenReturnStack?.pop?.();
    if (restoreState) return this._restoreCardScreenState(restoreState);
    if (closeOverlay) this._closeOverlay('screen-cards');
    this._renderScene();
    return false;
  }

  _cardPageForMode(mode) {
    const pageMap = { 'search-deck': 2, 'search-discard': 1, 'prize': 3 };
    return pageMap[mode] ?? 0;
  }

  _closeCardScreen() {
    if (this._isSetupHandCardScreen()) {
      this._pushCardStatus('请先完成初始布置');
      return;
    }
    if (this._cardMode === 'pick-cards' && this._cardModeCb) {
      const cb = this._cardModeCb;
      this._cardModeCb = null;
      cb([]);
      this._finishCardPickMode(true);
      return;
    }
    if (this._cardMode === 'pick-cards' && this._finishCardPickMode(true)) return;
    this._closeOverlay('screen-cards');
    this._renderScene();
  }

  _getCardPages() {
    const p1 = this.gs.player1, p2 = this.gs.player2;
    if (this._cardMode === 'pick-cards') {
      return [{ title: this._cardPickTitle || '选择卡牌', cards: this._cardPickCards || [], usable: true }];
    }
    const isSearch = ['search-deck', 'search-discard', 'prize'].includes(this._cardMode);
    const stadium = this.gs.getActiveStadium?.();
    return [
      { title: '我方手牌', cards: p1.hand, usable: this._cardMode === 'hand' && (this.gs.phase === PHASE.SETUP || this.gs.phase === PHASE.MAIN) },
      { title: '我方弃牌区', cards: p1.discard, usable: this._cardMode === 'hand' || isSearch },
      { title: '竞技场', cards: stadium ? [stadium.cardId || stadium.name] : [], usable: this._cardMode === 'hand' && !!stadium, stadium:true, stadiumState:stadium },
      { title: '我方卡组', cards: p1.deck, usable: isSearch, hidden: !isSearch },
      { title: '我方奖赏卡', cards: p1.prizes, usable: this._cardMode === 'prize', hidden: this._cardMode !== 'prize' },
      { title: '对方手牌', cards: p2.hand, usable: false, hidden: true },
      { title: '对方弃牌区', cards: p2.discard, usable: false },
      { title: '对方卡组', cards: p2.deck, usable: false, hidden: true },
      { title: '对方奖赏卡', cards: p2.prizes, usable: false, hidden: true },
    ];
  }

  _changeCardPage(dir) {
    const pages = this._getCardPages();
    this._cardPage = (this._cardPage + dir + pages.length) % pages.length;
    this._selectedCardIdx = -1;
    this._renderCardList();
  }

  _renderCardList() {
    const pages = this._getCardPages();
    const page = pages[this._cardPage];
    const setupHand = this._isSetupHandCardScreen();
    $('#cards-title').textContent = this._cardPickTitle || (setupHand && this._cardPage === 0 ? '初始布置：我方手牌' : page.title);
    $('#cards-page').textContent = `${this._cardPage + 1}/${pages.length}`;
    $('#cards-use').classList.toggle('disabled', !page.usable);
    const confirmSetupBtn = $('#cards-confirm-setup');
    if (confirmSetupBtn) {
      confirmSetupBtn.hidden = !setupHand;
      confirmSetupBtn.classList.toggle('disabled', !setupHand);
    }
    $('#cards-back').classList.toggle('disabled', setupHand);
    // Update use button label based on mode
    if (this._cardMode === 'hand') {
      const idx = this._selectedCardIdx;
      const page = pages[this._cardPage];
      if (idx >= 0 && page.cards[idx]) {
        const cd = this.resolver.getCard(page.cards[idx]);
        $('#cards-use').textContent = page.stadium ? '使用场地效果' : this._useLabel(cd);
      } else {
        $('#cards-use').textContent = '使用';
      }
    } else if (['search-deck', 'search-discard', 'prize', 'pick-cards'].includes(this._cardMode)) {
      const count = this._selectedCardIndices?.size || 0;
      $('#cards-use').textContent = this._cardMode === 'pick-cards' && this._cardPickMax !== 1 ? `选择(${count}/${this._cardPickMax ?? count})` : '选择';
    }

    const list = $('#card-list');
    list.innerHTML = '';
    if (page.hidden) {
      list.innerHTML = `<div class="bench-empty">${page.cards.length} 张 (不可查看)</div>`;
      this._renderCardPreview(null);
      return;
    }
    page.cards.forEach((cid, i) => {
      const info = page.stadiumState?.card && page.stadium ? { name: page.stadiumState.name } : this.resolver.getInfo(cid);
      const item = document.createElement('div');
      const isSelected = this._cardMode === 'pick-cards' ? this._selectedCardIndices.has(i) : i === this._selectedCardIdx;
      item.className = 'card-list-item' + (isSelected ? ' selected' : '');
      item.dataset.idx = i;
      item.textContent = info.name || cid;
      if (this._cardArtEnabled() && typeof item.insertAdjacentHTML === 'function') {
        item.insertAdjacentHTML('afterbegin', cardThumbImgHtml(cid, info.name || ''));
      }
      list.appendChild(item);
    });
    if (page.cards.length === 0) {
      list.innerHTML = '<div class="bench-empty">空</div>';
    }
    this._renderCardPreview(this._selectedCardIdx >= 0 ? page.cards[this._selectedCardIdx] : (page.cards[0] || null));
    this._renderCardLog();
  }

  _useLabel(cd) {
    if (!cd) return '使用';
    const ct = cd.cardType;
    if (ct === 'pokemon') {
      if (cd.ability?.active && ['hand','discard'].includes(cd.ability.zone)) return '特性';
      return cd.evolvesFrom ? '进化' : '放置';
    }
    if (ct === 'energy' || ct === 'specialEnergy') return '附着';
    if (ct === 'trainer') {
      if (cd.trainerType === 'tool') return '装备';
      if (cd.trainerType === 'stadium') return '打出';
      return '使用';
    }
    return '使用';
  }

  _selectCardInList(idx) {
    this._selectedCardIdx = idx;
    const pages = this._getCardPages();
    const page = pages[this._cardPage];
    if (this._cardMode === 'pick-cards') {
      if (this._selectedCardIndices.has(idx)) this._selectedCardIndices.delete(idx);
      else {
        if (this._cardPickMax != null && this._selectedCardIndices.size >= this._cardPickMax) {
          const oldest = this._selectedCardIndices.values().next().value;
          this._selectedCardIndices.delete(oldest);
        }
        this._selectedCardIndices.add(idx);
      }
      $$('.card-list-item').forEach((el, i) => el.classList.toggle('selected', this._selectedCardIndices.has(i)));
      if (page.cards[idx]) this._renderCardPreview(page.cards[idx]);
      $('#cards-use').textContent = this._cardPickMax !== 1 ? `选择(${this._selectedCardIndices.size}/${this._cardPickMax ?? this._selectedCardIndices.size})` : '选择';
      return;
    }
    $$('.card-list-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
    if (page.cards[idx]) this._renderCardPreview(page.cards[idx]);
    if (this._cardMode === 'hand') {
      const cd = page.cards[idx] ? this.resolver.getCard(page.cards[idx]) : null;
      $('#cards-use').textContent = page.stadium ? '使用场地效果' : this._useLabel(cd);
    }
  }

  _renderCardPreview(cid) {
    const thumb = $('#card-thumb');
    const nameEl = $('#card-desc-name');
    const textEl = $('#card-desc-text');
    if (!cid) { thumb.innerHTML = ''; nameEl.textContent = ''; textEl.textContent = ''; return; }
    const stadium = this._getCardPages?.()[this._cardPage]?.stadiumState || null;
    const info = stadium && (stadium.cardId === cid || stadium.name === cid) ? { name:stadium.name, number:null } : this.resolver.getInfo(cid);
    const cd = stadium && (stadium.cardId === cid || stadium.name === cid) ? stadium.card : this.resolver.getCard(cid);
      const art = this._cardArtEnabled() ? cardFullImgHtml(cid, info.name || '') : '';
      if (art) {
        thumb.innerHTML = `${art}<div class="card-art-fallback" hidden>${info.name || ''}</div>`;
      } else {
        const src = pokemonSpriteSrc(info.number);
        thumb.innerHTML = src ? pokemonSpriteImgHtml(info.number, info.name, { preferOnline: true }) : `<div style="font-size:16px;color:#4878a8">${info.name?.[0] || '?'}</div>`;
      }
    nameEl.textContent = info.name || '';
    let desc = '';
    if (cd) {
      if (cd.cardType === 'pokemon') {
        desc = `HP ${cd.hp || ''} ${cd.evolvesFrom ? `(由${cd.evolvesFrom}进化)` : '[基础]'}`;
        if (cd.attacks?.length) desc += '\n' + cd.attacks.map(a => `${a.name} ${a.damage || ''}`).join(' / ');
      } else if (cd.cardType === 'trainer') {
        desc = `[${cd.trainerType}] ${cd.effectText || ''}`;
      } else {
        desc = cd.effectText || cd.name || '';
      }
    }
    textEl.textContent = desc;
  }

  _renderCardLog() {
    // Show recent log in card-desc-text area (append below preview)
    const logEl = $('#card-desc-log');
    if (!logEl) return;
    if (this._cardLog.length === 0) { logEl.textContent = ''; return; }
    logEl.textContent = this._cardLog.slice(-5).join('\n');
  }

  _latestLogOr(fallback) {
    return this.gs?.log?.at?.(-1) || fallback;
  }

  _pushCardStatus(msg) {
    this._cardLog.push(msg);
    this._renderCardLog();
  }

  _setupBlockedCardMessage() {
    return '初始布置阶段只能放置基础宝可梦';
  }

  async _confirmSetupFromCardScreen() {
    if (!this._isSetupHandCardScreen()) return false;
    const logStart = Array.isArray(this.gs?.log) ? this.gs.log.length : 0;
    const ok = this.engine.advancePhase();
    this._appendNewGameLogsToCardLog(logStart);
    this._selectedCardIdx = -1;
    if (ok === false || this.gs.phase === PHASE.SETUP) {
      if (this._cardLog.length === 0) this._pushCardStatus(this._latestLogOr('请先放置战斗宝可梦'));
      this._renderScene();
      this._renderCardList();
      this._openOverlay('screen-cards');
      return false;
    }
    this._closeOverlay('screen-cards');
    this._refresh();
    return true;
  }

  _appendNewGameLogsToCardLog(startIndex) {
    const logs = Array.isArray(this.gs?.log) ? this.gs.log.slice(Math.max(0, startIndex || 0)) : [];
    for (const msg of logs) {
      if (!this._cardLog.includes(msg)) this._cardLog.push(msg);
    }
    this._renderCardLog();
  }

  async _useSelectedCard() {
    const pages = this._getCardPages();
    const page = pages[this._cardPage];

    // Search/prize mode: pick card and return via callback
    if (['search-deck', 'search-discard', 'prize', 'pick-cards'].includes(this._cardMode)) {
      let selected = [];
      if (this._cardMode === 'pick-cards') {
        selected = [...this._selectedCardIndices];
        if (selected.length < (this._cardPickMin || 0)) return;
        if (this._cardPickMax != null && selected.length > this._cardPickMax) return;
      } else {
        if (this._selectedCardIdx < 0 || !page.cards[this._selectedCardIdx]) return;
        selected = [this._selectedCardIdx];
      }
      const cb = this._cardModeCb;
      this._cardModeCb = null;
      if (cb) cb(selected);
      this._finishCardPickMode(true);
      return;
    }

    if (page.stadium) {
      if (this._selectedCardIdx < 0 || !page.cards[this._selectedCardIdx]) return;
      const logStart = Array.isArray(this.gs?.log) ? this.gs.log.length : 0;
      const ok = await this.engine.activateStadium(this.gs.player1);
      this._appendNewGameLogsToCardLog(logStart);
      if (!ok && this._cardLog.length === 0) this._cardLog.push(this._latestLogOr('无法使用场地效果'));
      this._selectedCardIdx = -1;
      this._renderScene();
      this._renderCardList();
      return;
    }

    // Hand/discard mode: use the card or zone ability
    if (![0,1].includes(this._cardPage) || this._selectedCardIdx < 0) return;
    const pl = this.gs.player1;
    const idx = this._selectedCardIdx;
    const zone = this._cardPage === 1 ? 'discard' : 'hand';
    const cid = zone === 'discard' ? pl.discard[idx] : pl.hand[idx];
    const cd = this.resolver.getCard(cid);
    if (!cd) return;
    const ct = cd.cardType;
    const phase = this.gs.phase;

    if (ct === 'pokemon' && cd.ability?.active && cd.ability.zone === zone) {
      if (phase === PHASE.SETUP) { this._pushCardStatus(this._setupBlockedCardMessage()); return; }
      const ok = await this.engine.useAbility(cd, cd.ability, { player: pl, zone });
      this._cardLog.push(ok ? `使用了特性 ${cd.ability.name}` : '无法使用特性');
      this._selectedCardIdx = -1;
      this._renderScene();
      this._renderCardList();
      return;
    }
    if (zone !== 'hand') { this._cardLog.push('只能查看弃牌区'); this._renderCardLog(); return; }

    // Cards that need a pokemon target → open pokemon screen
    if (phase === PHASE.SETUP && !(ct === 'pokemon' && !cd.evolvesFrom)) {
      this._pushCardStatus(this._setupBlockedCardMessage());
      return;
    }
    if (ct === 'energy' || ct === 'specialEnergy') {
      if (pl.energyAttached) { this._cardLog.push('已附着过能量'); this._renderCardLog(); return; }
      this._openPokeScreen('energy', { handIdx: idx, data: cd });
      return;
    }
    if (ct === 'pokemon' && cd.evolvesFrom) {
      this._openPokeScreen('evolve', { handIdx: idx, data: cd });
      return;
    }
    if (ct === 'trainer' && cd.trainerType === 'tool') {
      this._openPokeScreen('tool', { handIdx: idx, data: cd });
      return;
    }

    // Cards that resolve immediately — stay in card screen
    if (ct === 'pokemon' && (phase === PHASE.SETUP || phase === PHASE.MAIN || phase === PHASE.BATTLE)) {
      if (!pl.active) {
        const ok = this.engine.placeActivePokemon(idx, cd);
        this._cardLog.push(ok ? `${cd.name} 放置到战斗区` : (this.gs.log[this.gs.log.length - 1] || '无法放置到战斗区'));
      } else if (pl.bench.length < 5) {
        const ok = this.engine.placeBenchPokemon(idx, cd);
        this._cardLog.push(ok ? `${cd.name} 放置到备战区` : (this.gs.log[this.gs.log.length - 1] || '无法放置到备战区'));
      } else {
        this._cardLog.push('备战区已满');
      }
    } else if (ct === 'trainer') {
      const logStart = Array.isArray(this.gs?.log) ? this.gs.log.length : 0;
      const ok = await this.engine.useTrainer(idx, cd);
      this._appendNewGameLogsToCardLog(logStart);
      if (ok) this._cardLog.push(`使用了 ${cd.name}`);
      else if (this._cardLog.length === 0) this._cardLog.push(this._latestLogOr('无法使用训练家卡'));
    }
    // Stay in card screen, refresh
    this._selectedCardIdx = -1;
    this._renderScene();
    this._renderCardList();
  }

  // ============================================================
  //  POKEMON SCREEN — template for pokemon viewing/targeting
  // ============================================================

  /**
   * Open pokemon screen in a given mode.
   * @param {'view'|'energy'|'evolve'|'tool'|'swap'} mode
   * @param {Object} targetData - {handIdx, data} for energy/evolve/tool modes
   */
  _openPokeScreen(mode = 'view', targetData = null) {
    this._pokeMode = mode;
    this._pokeTargetData = targetData;
    this._pokePage = 0;
    this._selectedBenchIdx = -1;
    this._selectedPokeSlot = null;
    this._openOverlay('screen-pokemon');
    this._renderPokemonScreen();
  }

  _closePokeScreen() {
    if (this._pendingPokemonResolve) {
      const resolve = this._pendingPokemonResolve;
      this._pendingPokemonResolve = null;
      resolve(null);
      return;
    }
    this._pokeMode = 'view';
    this._pokeTargetData = null;
    this._closeOverlay('screen-pokemon');
    this._renderScene();
  }

  _changePokePage(dir) {
    this._pokePage = (this._pokePage + dir + 2) % 2;
    this._selectedBenchIdx = -1;
    this._renderPokemonScreen();
  }

  _renderPokemonScreen() {
    const pl = this._pokePage === 0 ? this.gs.player1 : this.gs.player2;
    const isMySide = this._pokePage === 0;
    const modeLabels = {
      'view': '查看', 'energy': '选择附着目标', 'evolve': '选择进化目标',
      'tool': '选择装备目标', 'swap': '选择换上场', 'effect-switch': '选择换上场', 'effect-target': '选择目标'
    };
    $('#poke-title').textContent = pokemonPickerTitleFor(isMySide, this._pokeTargetData?.options || {}, this._pokeMode === 'effect-switch' || this._pokeMode === 'effect-target');
    $('#poke-page').textContent = `${this._pokePage + 1}/2`;

    // Only normal hand targeting is restricted to own side; effect picks use their pending options.
    const canTarget = isMySide && ['energy', 'evolve', 'tool'].includes(this._pokeMode);
    const isEffectPick = this._pokeMode === 'effect-switch' || this._pokeMode === 'effect-target';
    const effectPickOptions = isEffectPick ? (this._pokeTargetData?.options || {}) : null;
    const allowActivePick = canTarget || (isMySide && this._pokeMode === 'view');
    const allowBenchPick = isEffectPick ? false : true;
    const selectedSlot = this._selectedPokeSlot || (this._selectedBenchIdx >= 0 ? `bench-${this._selectedBenchIdx}` : null);
    const hasValidEffectPick = isEffectPick && pokemonPickerConfirmEnabled(selectedSlot, effectPickOptions);
    const hasLegalEffectTarget = !isEffectPick || pokemonPickerHasLegalTarget(pl, effectPickOptions);
    const canSwap = isMySide && (this._pokeMode === 'swap' || this._pokeMode === 'view');
    const showAction = canTarget || canSwap || isEffectPick;
    const selectedMon = this._getSelectedPokeMon(pl);
    const canUseAbility = isMySide && this._pokeMode === 'view' && selectedMon?.ability?.active;
    const actionLabel = canUseAbility ? '特性' : ({ 'energy': '附着', 'evolve': '进化', 'tool': '装备', 'swap': '交换', 'view': '交换', 'effect-switch': '确认' }[this._pokeMode] || '确认');
    $('#poke-swap').textContent = (showAction || canUseAbility) ? actionLabel : '交换';
    $('#poke-swap').classList.toggle('disabled', !(showAction || canUseAbility) || (isEffectPick ? !hasValidEffectPick : (canTarget ? !this._selectedPokeSlot : (canUseAbility ? false : this._selectedBenchIdx < 0))));

    const body = $('#pokemon-body');
    body.innerHTML = '';

    // Active pokemon
    const activeDiv = document.createElement('div');
    activeDiv.className = 'pokemon-active';
    if (pl.active) {
      const info = this.resolver.getInfo(pl.active.cardId);
      const src = pokemonSpriteSrc(info.number);
      const activeSlotClass = isEffectPick
        ? pokemonPickerSlotClass('active', effectPickOptions, this._selectedPokeSlot)
        : { allowed: allowActivePick, className: `${allowActivePick ? ' selectable' : ''}${this._selectedPokeSlot === 'active' ? ' selected' : ''}` };
      activeDiv.innerHTML = `
        <div class="pokemon-active-sprite${activeSlotClass.className}" data-slot="active">${src ? pokemonSpriteImgHtml(info.number, pl.active.name, { preferOnline: true, back: true }) : ''}</div>
        <div class="pokemon-active-name">${pl.active.name}</div>
        <div class="pokemon-active-hp">HP ${pl.active.hp}/${pl.active.maxHp}</div>
        <div class="energy-icons">${(pl.active.energy || []).map(e => `<span class="energy ${this._eleClass(e)}" title="${energyLabel(e)}"></span>`).join('')}</div>
        <div class="pokemon-active-tag">${pl.active.ability?.active ? `特性:${pl.active.ability.name}` : '出战中'}</div>`;
      if (activeSlotClass.allowed) {
        const spriteEl = activeDiv.querySelector('.pokemon-active-sprite');
        spriteEl.addEventListener('click', () => { this._selectedBenchIdx = -1; this._selectedPokeSlot = 'active'; this._renderPokemonScreen(); });
      }
    } else {
      activeDiv.innerHTML = '<div class="bench-empty">无出战宝可梦</div>';
    }
    body.appendChild(activeDiv);

    // Mode hint
    if (showAction) {
      const hint = document.createElement('div');
      hint.className = 'poke-mode-hint';
      hint.textContent = isEffectPick && !hasLegalEffectTarget ? `${modeLabels[this._pokeMode]}：无可选目标` : modeLabels[this._pokeMode];
      body.appendChild(hint);
    }

    // Bench
    const benchDiv = document.createElement('div');
    benchDiv.className = 'pokemon-bench';
    for (let i = 0; i < 5; i++) {
      const mon = pl.bench[i];
      const slot = document.createElement('div');
      const slotName = `bench-${i}`;
      const benchSlotClass = isEffectPick
        ? pokemonPickerSlotClass(slotName, effectPickOptions, selectedSlot)
        : { allowed: allowBenchPick, className: `${i === this._selectedBenchIdx ? ' selected' : ''}${allowBenchPick ? '' : ' disabled'}` };
      slot.className = 'bench-slot' + (mon ? '' : ' empty') + (mon ? benchSlotClass.className : '');
      if (mon) {
        const info = this.resolver.getInfo(mon.cardId);
        const src = pokemonSpriteSrc(info.number);
        slot.innerHTML = `
          <div class="bench-sprite">${src ? pokemonSpriteImgHtml(info.number, mon.name, { preferOnline: true, back: true }) : ''}</div>
          <div><div class="bench-name">${mon.name}</div><div class="bench-hp">HP ${mon.hp}/${mon.maxHp}</div></div>`;
        if (benchSlotClass.allowed) {
          slot.addEventListener('click', () => { this._selectedBenchIdx = i; this._selectedPokeSlot = slotName; this._renderPokemonScreen(); });
        }
      } else {
        slot.innerHTML = '<div class="bench-empty">空位</div>';
      }
      benchDiv.appendChild(slot);
    }
    body.appendChild(benchDiv);
  }

  async _onPokeAction() {
    const mode = this._pokeMode;
    if (mode === 'effect-switch' || mode === 'effect-target') {
      const slot = this._selectedPokeSlot || (this._selectedBenchIdx >= 0 ? `bench-${this._selectedBenchIdx}` : null);
      const options = this._pokeTargetData?.options || {};
      if (!pokemonPickerSlotAllowed(slot, options)) return;
      if (this._pendingPokemonResolve) this._pendingPokemonResolve(slot);
      return;
    }
    if (mode === 'view') {
      const mon = this._getSelectedPokeMon(this.gs.player1);
      if (mon?.ability?.active) {
        const ok = await this.engine.useAbility(mon, mon.ability, { player: this.gs.player1, zone: this.gs.inferAbilityZone?.(this.gs.player1, mon) || 'field' });
        this._showMessage(ok ? `使用了特性 ${mon.ability.name}` : '无法使用特性');
        this._renderPokemonScreen();
        return;
      }
      this._swapPokemon();
      return;
    }
    if (mode === 'swap') {
      this._swapPokemon();
      return;
    }
    // energy / evolve / tool — resolve target then return to card screen
    const slot = this._selectedPokeSlot || (this._selectedBenchIdx >= 0 ? `bench-${this._selectedBenchIdx}` : null);
    const tm = this._pokeTargetData;
    if (!tm || !slot) return;

    if (mode === 'energy') {
      const ok = await this.engine.attachEnergy(tm.handIdx, tm.data, slot);
      this._cardLog.push(ok ? `为${slot === 'active' ? '出战' : '备战'}宝可梦附着了${tm.data.name}` : '附着失败');
      // Execute special energy effects on attach
      if (ok && tm.data.effects?.length) {
        try { await executeEffects(this.gs, this.gs.player1, tm.data.effects); } catch(e) { this._cardLog.push(`能量效果: ${e.message}`); }
      }
    } else if (mode === 'evolve') {
      const ok = this.engine.evolvePokemon(tm.handIdx, tm.data, slot);
      this._cardLog.push(ok ? `进化成功！` : '无法进化');
    } else if (mode === 'tool') {
      const ok = await this.engine.useTrainer(tm.handIdx, tm.data, slot);
      this._cardLog.push(ok ? `装备了${tm.data.name}` : this._latestLogOr('装备失败'));
    }

    // Return to card screen (not main)
    this._pokeMode = 'view';
    this._pokeTargetData = null;
    this._closeOverlay('screen-pokemon');
    this._selectedCardIdx = -1;
    this._renderScene();
    this._renderCardList();
  }

  _getSelectedPokeMon(pl) {
    if (this._selectedPokeSlot === 'active') return pl.active;
    if (this._selectedBenchIdx >= 0) return pl.bench[this._selectedBenchIdx];
    return null;
  }

  async _swapPokemon() {
    if (this._pokePage !== 0 || this._selectedBenchIdx < 0) return;
    const pl = this.gs.player1;
    const benchIndex = this._selectedBenchIdx;
    if (!pl.bench[benchIndex]) return;
    const cost = this.gs.effectiveRetreatCost ? this.gs.effectiveRetreatCost(pl.active) : (pl.active?.retreatCostOverride ?? pl.active?.retreatCost ?? 1);
    if (cost > 0 && (pl.active.energy || []).length > 0) {
      if (!this.gs._canPayRetreatCost(pl.active, cost)) { this._showMessage('撤退能量不足'); return; }
      const picked = await this.gs.waitForPick((pl.active.energy || []).map(energyLabel), (pl.active.energy || []).length, { source:'retreat-energy', cost, allowEmpty:true });
      if (!picked || picked.length === 0) { this._showMessage('已取消撤退'); return; }
      if (!this.gs._canSelectedEnergyPayRetreat(pl.active, cost, picked)) { this._showMessage('选择的能量不足'); return; }
      const ok = this.gs.retreat(pl, benchIndex, picked);
      if (!ok) { this._showMessage(this.gs.log[this.gs.log.length - 1] || '无法撤退'); return; }
    } else {
      const ok = this.gs.retreat(pl, benchIndex);
      if (!ok) { this._showMessage(this.gs.log[this.gs.log.length - 1] || '无法撤退'); return; }
    }
    this._closeOverlay('screen-pokemon');
    this._refresh();
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
  _showTargetPanel(text) {
    const menu = $('#target-menu');
    menu.innerHTML = '';
    const pl = this.gs.player1;
    if (pl.active) {
      const item = document.createElement('div');
      item.className = 'menu-item selected';
      item.dataset.slot = 'active';
      item.textContent = `${pl.active.name} (出战)`;
      menu.appendChild(item);
    }
    pl.bench.forEach((mon, i) => {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.dataset.slot = 'bench-' + i;
      item.textContent = `${mon.name} (备战)`;
      menu.appendChild(item);
    });
    const back = document.createElement('div');
    back.className = 'menu-item back-item';
    back.textContent = '← 返回';
    menu.appendChild(back);
    $('#target-text').textContent = text;
    this._showPanel('panel-target');
  }

  _resolveTarget(slot) {
    if (!this._pokeTargetData) return;
    const mode = this._pokeMode;
    const tm = this._pokeTargetData;
    this._pokeMode = 'view';
    this._pokeTargetData = null;
    if (mode === 'energy') this.engine.attachEnergy(tm.handIdx, tm.data, slot);
    else if (mode === 'evolve') this.engine.evolvePokemon(tm.handIdx, tm.data, slot);
    else if (mode === 'tool') this.engine.useTrainer(tm.handIdx, tm.data, slot);
    this._showPanel('panel-main');
    this._refresh();
  }

  // === Pick Handler (for effects that need card selection) ===
  _handlePick(pick) {
    const isRetreat = pick.options?.source === 'retreat-energy';
    const title = cardPickerTitleFor(pick);
    const wasCardScreenOpen = $('#screen-cards').classList.contains('active') && this._cardMode !== 'pick-cards';
    if (wasCardScreenOpen) {
      if (!Array.isArray(this._cardScreenReturnStack)) this._cardScreenReturnStack = [];
      this._cardScreenReturnStack.push(this._captureCardScreenState());
    }
    const cb = (selectedIdx) => {
      this.gs.resolvePick(selectedIdx);
      if (!wasCardScreenOpen) this._refresh();
    };
    const bounds = derivePickBounds(pick);
    cb.max = bounds.max;
    cb.min = bounds.min;
    cb.allowEmpty = bounds.allowEmpty;
    cb.allowFewer = bounds.allowFewer;
    this._openCardScreen('pick-cards', cb, pick.cards || [], title, { preserveLog: wasCardScreenOpen });
  }

  _handlePokemonPick(pick) {
    // Use the pokemon-screen template to pick an effect target or replacement pokemon
    const oldMode = this._pokeMode;
    this._pokeMode = pick.options?.mode === 'switch' ? 'effect-switch' : 'effect-target';
    this._pokeTargetData = { pendingPokemonPick: true, options: pick.options || {} };
    this._pokePage = pick.player === this.gs.player2 ? 1 : 0;
    this._selectedBenchIdx = -1;
    this._selectedPokeSlot = null;
    this._openOverlay('screen-pokemon');
    this._renderPokemonScreen();
    this._pendingPokemonResolve = (slot) => {
      this._pendingPokemonResolve = null;
      this.gs.resolvePokemonPick(slot);
      this._pokeMode = oldMode || 'view';
      this._pokeTargetData = null;
      this._closeOverlay('screen-pokemon');
      this._refresh();
    };
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
    if ($('#screen-cards')?.classList.contains('active') || $('#screen-pokemon')?.classList.contains('active')) return;
    this._showPanel('panel-main');
  }

  _renderScene() {
    this._renderMon(this.gs.player1.active, 'pl');
    this._renderMon(this.gs.player2.active, 'opp');
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

  _openOverlay(id) { $(`#${id}`).classList.add('active'); }
  _closeOverlay(id) { $(`#${id}`).classList.remove('active'); }

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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => new PTCGBattleApp());
}
