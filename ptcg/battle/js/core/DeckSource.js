// js/core/DeckSource.js — 卡组来源解析
//
// 目标：卡组不再内置，而是直接读取同源 ptcg 项目（/ptcg/）保存在 localStorage 的卡组，
//       **玩家与对手（AI）共用同一份卡组列表**（各自从中选一套）。
//   - ptcg 侧写入 key: STORAGE_KEYS.DECKS = 'ptcg_decks'
//       ptcg/js/utils/constants.js:87
//   - 结构：{ id, name, coverCardId, cards: [{ id, quantity }], totalCount }
//     与 ptcgBattle 原有内置结构（js/data/decks.js 的 TEST_DECKS）字段完全一致，无需格式转换。
//   - 可用性门槛：至少 1 张基础宝可梦（PTCG 规则起手必须有基础宝可梦），否则该卡组不可对战。
//   - 任何异常（无 localStorage / 无卡组 / 全部不可用）都回退到内置卡组，保证对战入口永不落空。

import { TEST_DECKS } from '../data/decks.js';

/** ptcg 卡组在 localStorage 中的 key（与 ptcg/js/utils/constants.js 的 STORAGE_KEYS.DECKS 保持一致） */
export const PTCG_DECKS_STORAGE_KEY = 'ptcg_decks';

/** 标准卡组张数（仅用于提示，不作为硬门槛） */
export const STANDARD_DECK_SIZE = 60;

function resolveStorage(explicit) {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

export class DeckSource {
  /**
   * @param {object|null} resolver CardResolver 实例（用于识别基础宝可梦）
   * @param {{storage?: Storage|null}} [options]
   */
  constructor(resolver, options = {}) {
    this.resolver = resolver || null;
    this.storage = resolveStorage(options.storage);
  }

  /**
   * 解析可用卡组（玩家与对手共用同一列表）。
   * @param {{builtin?: Array}} [options]
   * @returns {{decks: Array, source: 'ptcg'|'builtin', warnings: string[]}}
   */
  load(options = {}) {
    const builtin = Array.isArray(options.builtin) ? options.builtin : TEST_DECKS;
    const fallbackDecks = builtin.map((deck, i) => this._normalize(deck, i));
    const warnings = [];

    const stored = this._readStoredDecks();
    let decks = [];
    let source = 'builtin';

    if (!this.storage) {
      warnings.push('当前环境不支持 localStorage，已使用内置卡组');
    } else if (stored === null) {
      warnings.push('读取 ptcg 卡组失败（数据格式异常），已使用内置卡组');
    } else if (stored.length === 0) {
      warnings.push('尚未在卡牌库中创建卡组，已使用内置卡组');
    } else {
      const usable = [];
      for (let i = 0; i < stored.length; i++) {
        const deck = this._normalize(stored[i], i);
        if (deck.totalCount === 0) {
          warnings.push(`卡组「${deck.name}」没有卡牌，已跳过`);
          continue;
        }
        const basics = this.countBasicPokemon(deck);
        if (basics === 0) {
          warnings.push(`卡组「${deck.name}」没有基础宝可梦，无法开局，已跳过`);
          continue;
        }
        if (deck.totalCount !== STANDARD_DECK_SIZE) {
          warnings.push(`卡组「${deck.name}」共 ${deck.totalCount} 张（标准为 ${STANDARD_DECK_SIZE} 张）`);
        }
        usable.push(deck);
      }

      if (usable.length > 0) {
        decks = usable;
        source = 'ptcg';
      } else {
        warnings.push('卡牌库中的卡组均不可用（缺少基础宝可梦），已使用内置卡组');
      }
    }

    if (decks.length === 0) decks = fallbackDecks;

    return { decks, source, warnings };
  }

  /** 统计卡组中基础宝可梦张数（resolver 不可用时返回 -1 表示无法判定） */
  countBasicPokemon(deck) {
    if (!deck || !Array.isArray(deck.cards)) return 0;
    if (!this.resolver || typeof this.resolver.getCard !== 'function') return -1;
    let count = 0;
    for (const card of deck.cards) {
      const data = this.resolver.getCard(card.id);
      if (data && data.cardType === 'pokemon' && data.stage === '基础') {
        count += card.quantity || 0;
      }
    }
    return count;
  }

  /** 读取并在必要时反序列化 localStorage 中的卡组；返回 null 表示读取失败 */
  _readStoredDecks() {
    if (!this.storage) return [];
    let raw;
    try {
      raw = this.storage.getItem(PTCG_DECKS_STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  /** 归一化为对战引擎可消费的结构，并重算 totalCount */
  _normalize(deck, index) {
    const cards = [];
    const rawCards = deck && Array.isArray(deck.cards) ? deck.cards : [];
    for (const card of rawCards) {
      if (!card) continue;
      const id = card.id === undefined || card.id === null ? '' : String(card.id);
      const quantity = Number(card.quantity);
      if (!id || !Number.isInteger(quantity) || quantity <= 0) continue;
      cards.push({ id, quantity });
    }
    const name = deck && deck.name ? String(deck.name).trim() : '';
    return {
      id: deck && deck.id !== undefined && deck.id !== null ? String(deck.id) : `deck-${index}`,
      name: name || `未命名卡组 ${index + 1}`,
      coverCardId: deck && deck.coverCardId !== undefined && deck.coverCardId !== null
        ? String(deck.coverCardId)
        : null,
      cards,
      totalCount: cards.reduce((sum, card) => sum + card.quantity, 0),
    };
  }
}

/** 便捷入口：一次性解析卡组来源 */
export function loadDecks(resolver, options = {}) {
  return new DeckSource(resolver, options).load(options);
}
