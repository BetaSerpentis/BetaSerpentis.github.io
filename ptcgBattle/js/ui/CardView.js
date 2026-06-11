// js/ui/CardView.js — 手牌 DOM 渲染（含名字和精灵图）

import { pokemonSpriteSrc } from './SpriteUtils.js';

export class CardView {
  constructor(handContainer, logContainer, gameState, resolver, callbacks = {}) {
    this.handEl = handContainer;
    this.logEl = logContainer;
    this.gs = gameState;
    this.resolver = resolver;
    this.cb = callbacks;
    this.selectedIndex = -1;
  }

  renderHand() {
    const player = this.gs.currentPlayer;
    this.handEl.innerHTML = '';
    if (player.hand.length === 0) {
      this.handEl.innerHTML = '<span class="hand-empty">手牌为空</span>';
      return;
    }
    player.hand.forEach((cardId, index) => {
      const card = this._createCard(cardId, index);
      card.addEventListener('click', () => this._onCardClick(index));
      this.handEl.appendChild(card);
    });
  }

  _createCard(cardId, index) {
    const info = this.resolver.getInfo(cardId);
    const name = info.name;
    const number = info.number;

    const div = document.createElement('div');
    div.className = 'card-hand' + (index === this.selectedIndex ? ' selected' : '');
    div.dataset.index = index;
    div.dataset.cardId = cardId;

    // 精灵图（仅宝可梦卡显示）
    if (number) {
      const img = document.createElement('img');
      img.className = 'card-sprite';
      img.src = pokemonSpriteSrc(number);
      img.alt = name;
      img.onerror = () => { img.style.display = 'none'; };
      div.appendChild(img);
    } else {
      // 非宝可梦卡显示类型标记
      const typeTag = document.createElement('span');
      typeTag.className = 'card-type-tag';
      typeTag.textContent = this._guessType(cardId);
      div.appendChild(typeTag);
    }

    // 名字
    const nameEl = document.createElement('span');
    nameEl.className = 'card-name';
    nameEl.textContent = name;
    div.appendChild(nameEl);

    return div;
  }

  _guessType(cardId) {
    const id = parseInt(cardId);
    // 简单推测，后续可改进
    if (id >= 10000) return '道';
    return '训';
  }

  _onCardClick(index) {
    this.selectedIndex = (this.selectedIndex === index) ? -1 : index;
    this.renderHand();
    this.cb.onSelectCard?.(index, this.gs.currentPlayer.hand[index]);
  }

  addLog(msg) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    this.logEl.prepend(entry);
    while (this.logEl.children.length > 50) this.logEl.lastChild.remove();
  }

  updatePhase(phase) {
    const names = { setup:'初始布置', draw:'抽卡', main:'主要', battle:'战斗', end:'结束', game_over:'终局' };
    const el = document.getElementById('phase-display');
    if (el) el.textContent = names[phase] || phase;
  }

  updatePlayer() {
    const el = document.getElementById('current-player-display');
    if (el) {
      const p = this.gs.currentPlayer;
      el.textContent = `${p.name} · 第${this.gs.turn}回合 · 奖品${p.prizes.length}/6`;
    }
  }
}
