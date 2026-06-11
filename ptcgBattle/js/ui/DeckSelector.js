// js/ui/DeckSelector.js — 卡组选择弹窗

import { pokemonSpriteSrc } from './SpriteUtils.js';

export class DeckSelector {
  constructor(resolver, decks, callback) {
    this.resolver = resolver;
    this.decks = decks;
    this.cb = callback;
    this.playerChoice = 0;
    this.opponentChoice = 1;
    this._createDOM();
  }

  _createDOM() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'picker-overlay';
    this.overlay.style.display = 'flex';
    this.overlay.innerHTML = `
      <div class="picker-box" style="max-width:700px">
        <div class="picker-title">选择卡组</div>
        <div style="display:flex;gap:16px">
          <div style="flex:1"><div style="text-align:center;color:#58a6ff;margin-bottom:8px">你的卡组</div>
            <div id="deck-player-list"></div></div>
          <div style="flex:1"><div style="text-align:center;color:#f85149;margin-bottom:8px">对手卡组</div>
            <div id="deck-opponent-list"></div></div>
        </div>
        <div class="picker-actions" style="margin-top:14px">
          <button class="picker-btn picker-confirm" id="deck-start-btn">开始对战</button>
        </div>
      </div>`;
    document.body.appendChild(this.overlay);

    this._renderList('deck-player-list', true);
    this._renderList('deck-opponent-list', false);
    document.getElementById('deck-start-btn').addEventListener('click', () => {
      document.body.removeChild(this.overlay);
      this.cb(this.decks[this.playerChoice], this.decks[this.opponentChoice]);
    });
  }

  _renderList(containerId, isPlayer) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    this.decks.forEach((deck, i) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px;margin:4px 0;border:1.5px solid #30363d;border-radius:6px;cursor:pointer;background:#21262d';
      if ((isPlayer && i === this.playerChoice) || (!isPlayer && i === this.opponentChoice)) {
        div.style.borderColor = '#58a6ff'; div.style.boxShadow = '0 0 8px rgba(88,166,255,.3)';
      }
      const info = this.resolver.getInfo(deck.coverCardId);
      if (info.number) {
        const img = document.createElement('img');
        img.src = pokemonSpriteSrc(info.number);
        img.onerror = () => { img.style.display = 'none'; };
        img.style.cssText = 'width:36px;height:36px;image-rendering:pixelated';
        div.appendChild(img);
      }
      const txt = document.createElement('span');
      txt.textContent = `${deck.name} (${deck.totalCount}张)`;
      txt.style.cssText = 'font-size:12px;color:#e6edf3';
      div.appendChild(txt);
      div.addEventListener('click', () => {
        if (isPlayer) this.playerChoice = i; else this.opponentChoice = i;
        this._renderList('deck-player-list', true);
        this._renderList('deck-opponent-list', false);
      });
      el.appendChild(div);
    });
  }
}
