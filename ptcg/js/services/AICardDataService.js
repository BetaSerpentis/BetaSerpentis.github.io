// ptcg/js/services/AICardDataService.js
// AI 卡牌数据层：JSON 缓存、搜索、详情

export class AICardDataService {
  constructor(cardManager) {
    this.cardManager = cardManager;
    // JSON 完整卡牌数据: Map<cardId, fullCardObject>
    this._jsonCache = new Map();
    this._jsonLoading = new Map();
    this._loaded = false;
    // 动态环境标（由 AIChatService 从 meta.json 注入，默认 GHI）
    this._currentMarks = new Set(['G', 'H', 'I']);
  }

  /** 由外部注入当前有效标集合（AIChatService._loadEnvironment 调用）*/
  setCurrentMarks(marks) {
    if (Array.isArray(marks) && marks.length > 0) {
      this._currentMarks = new Set(marks.map(m => m.toUpperCase()));
      console.log('[AI Data] 环境过滤切换到:', [...this._currentMarks].join('/'), '标');
    }
  }

  // ========== JSON 缓存加载 ==========

  _getJsonFileForType(cardType) {
    const map = {
      '宝可梦': 'pokemon-cards.json',
      '支援者': 'Supporter-cards.json',
      '物品': 'Item-cards.json',
      '宝可梦道具': 'PokemonTool-cards.json',
      '竞技场': 'Stadium-cards.json',
      '基本能量': 'BasicEnergy-cards.json',
      '特殊能量': 'SpecialEnergy-cards.json'
    };
    return map[cardType] || null;
  }

  async _loadJsonCache(cardType) {
    const filename = this._getJsonFileForType(cardType);
    if (!filename) return;
    if (this._jsonLoading.has(cardType)) return this._jsonLoading.get(cardType);

    const promise = (async () => {
      try {
        const resp = await fetch(`data/${filename}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const jsonData = await resp.json();
        if (!Array.isArray(jsonData)) return;
        for (const card of jsonData) {
          const ids = card['卡牌ID'];
          if (!ids || !Array.isArray(ids)) continue;
          for (const id of ids) {
            if (id && !this._jsonCache.has(id)) this._jsonCache.set(id, card);
          }
        }
      } catch (e) {
        console.warn(`[AI Data] Failed to load ${filename}:`, e.message);
      }
    })();

    this._jsonLoading.set(cardType, promise);
    return promise;
  }

  async ensureLoaded() {
    if (this._loaded) return;
    const types = this.cardManager.getAllCardTypes();
    await Promise.all(types.map(t => this._loadJsonCache(t)));
    this._loaded = true;
    console.log('[AI Data] JSON cache ready:', this._jsonCache.size, 'cards');
  }

  /** 获取指定 ID 的完整 JSON 数据 */
  async getFullCardData(cardId) {
    if (this._jsonCache.has(cardId)) return this._jsonCache.get(cardId);
    // 尝试按需加载该卡所属类型
    let cardType = null;
    const cache = this.cardManager.allCardsCache || this.cardManager.cards || [];
    const basic = cache.find(c => c.id === cardId);
    if (basic) cardType = basic.type;
    if (!cardType) return null;
    await this._loadJsonCache(cardType);
    return this._jsonCache.get(cardId) || null;
  }

  async getFullCardDataBatch(cardIds) {
    const typesNeeded = new Set();
    const cache = this.cardManager.allCardsCache || this.cardManager.cards || [];
    for (const id of cardIds) {
      if (this._jsonCache.has(id)) continue;
      const basic = cache.find(c => c.id === id);
      if (basic && basic.type) typesNeeded.add(basic.type);
    }
    if (typesNeeded.size > 0) await Promise.all([...typesNeeded].map(t => this._loadJsonCache(t)));
    const result = new Map();
    for (const id of cardIds) {
      const data = this._jsonCache.get(id);
      if (data) result.set(id, data);
    }
    return result;
  }

  // ========== 搜索 ==========

  _jsonCardToSearchText(data) {
    const parts = [];
    if (data['宝可梦名字']) parts.push(data['宝可梦名字']);
    if (data['卡牌名字']) parts.push(data['卡牌名字']);
    if (data['进化阶段']) parts.push(data['进化阶段']);
    if (data['进化自']) parts.push(data['进化自']);
    if (data['属性']) parts.push(data['属性']);
    if (data['特性名字']) parts.push(data['特性名字']);
    if (data['特性效果']) parts.push(data['特性效果']);
    if (data['卡牌类型']) parts.push(data['卡牌类型']);
    for (let i = 1; i <= 4; i++) {
      const skill = data[`技能${i}`];
      if (skill) {
        if (skill['名字']) parts.push(skill['名字']);
        if (skill['效果'] && skill['效果'] !== '无') parts.push(skill['效果']);
        if (Array.isArray(skill['消耗'])) parts.push(skill['消耗'].join(' '));
      }
    }
    if (data['效果']) parts.push(data['效果']);
    if (data['规则']) parts.push(data['规则']);
    if (data['弱点']) parts.push(data['弱点']);
    return parts.join(' ');
  }

  _extractVersion(data) {
    const version = Array.isArray(data['卡牌版本']) ? data['卡牌版本'][0] : (data['卡牌版本'] || '');
    return (version && /^[A-I]$/i.test(version)) ? version.toUpperCase() : null;
  }

  _isCurrentFormat(version) {
    return version && this._currentMarks.has(version.toUpperCase());
  }

  /** search_cards — 关键词搜索 */
  searchCards(query, cardType, limit = 15) {
    if (!query || !query.trim()) return { results: [], total: 0, message: '请提供搜索关键词' };
    limit = Math.min(limit, 50);
    // 归一化搜索词（【】和普通括号互转）
    const normQuery = query.replace(/[【】]/g, '');
    const terms = normQuery.split(/\s+/).filter(t => t.length > 0);
    const results = [];

    for (const [id, data] of this._jsonCache) {
      if (cardType) {
        let type = data['卡牌类型'] || '';
        if (!type && data['宝可梦名字']) type = '宝可梦';
        if (type.endsWith('卡')) type = type.slice(0, -1);
        if (type !== cardType) continue;
      }
      const version = this._extractVersion(data);
      if (version && !this._isCurrentFormat(version)) continue;
      // 归一化搜索文本（同样去掉【】用于匹配）
      const text = this._jsonCardToSearchText(data).replace(/[【】]/g, '');
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      if (score > 0) results.push({ id, score, data });
    }

    // Fallback to TSV cache
    if (results.length === 0) {
      const cache = this.cardManager.allCardsCache || [];
      for (const card of cache) {
        if (cardType && card.type !== cardType) continue;
        const searchField = (card.searchText || '') + ' ' + (card.name || '');
        let score = 0;
        for (const term of terms) {
          if (searchField.toLowerCase().includes(term.toLowerCase())) score++;
        }
        if (score > 0) results.push({ id: card.id, score, data: null });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    const formatted = top.map(r => {
      const name = r.data ? (r.data['宝可梦名字'] || r.data['卡牌名字'] || '未知') : `卡牌 ${r.id}`;
      const type = r.data ? (r.data['卡牌类型'] || (r.data['宝可梦名字'] ? '宝可梦' : '')) : '?';
      const detail = r.data ? this._summarizeCardQuick(r.data) : `(score:${r.score})`;
      return `- **${name}** [ID:${r.id}] [${type}] ${detail}`;
    }).join('\n');

    return {
      results: top.map(r => ({ id: r.id, data: r.data })),
      total: results.length,
      message: `找到 ${results.length} 张，显示前 ${top.length} 张:\n${formatted}\n\n> 用 get_card_detail(ID) 查看完整效果`
    };
  }

  /** grep_cards — 正则精确搜索 */
  grepCards(patterns, cardType, limit = 10) {
    if (!patterns) return { results: [], total: 0, message: '请提供正则表达式' };
    limit = Math.min(limit, 20);
    const patternList = patterns.split('||').map(p => p.trim()).filter(p => p.length > 0);
    const allResults = new Map();

    for (const patternStr of patternList) {
      let regex;
      try { regex = new RegExp(patternStr, 'i'); } catch (e) {
        return { results: [], total: 0, message: `正则错误: ${e.message}` };
      }
      for (const [id, data] of this._jsonCache) {
        if (cardType) {
          let type = data['卡牌类型'] || '';
          if (!type && data['宝可梦名字']) type = '宝可梦';
          if (type.endsWith('卡')) type = type.slice(0, -1);
          if (type !== cardType) continue;
        }
        const version = this._extractVersion(data);
        if (version && !this._isCurrentFormat(version)) continue;
        const text = this._jsonCardToSearchText(data);
        const matches = [];
        let match;
        const re = new RegExp(patternStr, 'gi');
        while ((match = re.exec(text)) !== null) {
          matches.push(match[0]);
          if (matches.length >= 3) break;
        }
        if (matches.length > 0) {
          const existing = allResults.get(id);
          if (existing) {
            existing.score += matches.length;
            existing.matches.push(...matches);
          } else {
            const name = data['宝可梦名字'] || data['卡牌名字'] || id;
            allResults.set(id, { id, name, data, score: matches.length, matches });
          }
        }
      }
    }

    if (allResults.size === 0) {
      return { results: [], total: 0, message: '未找到匹配。建议：简化正则或换个搜索方向' };
    }

    const sorted = [...allResults.values()].sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, limit);
    const formatted = top.map(c => {
      const snippets = [...new Set(c.matches)].slice(0, 2).join(', ');
      const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
      const detail = this._summarizeCardQuick(c.data);
      return `- **${c.name}** [ID:${c.id}] [${type}] ${detail}\n  命中: ${snippets}`;
    }).join('\n');

    return {
      results: top.map(r => ({ id: r.id, data: r.data })),
      total: allResults.size,
      message: `Grep "${patterns}" 找到 ${allResults.size} 张 (仅F-I标)，前 ${top.length}:\n${formatted}`
    };
  }

  /** get_card_detail — 获取单卡完整数据 */
  async getCardDetail(cardId) {
    if (!cardId) return '错误：请提供卡牌ID';
    const data = this._jsonCache.get(cardId) || await this.getFullCardData(cardId);
    if (!data) return `未找到卡牌 ID: ${cardId}`;
    return this._formatCardRich(data, cardId);
  }

  // ========== 格式化 ==========

  _summarizeCardQuick(data) {
    const parts = [];
    const name = data['宝可梦名字'] || data['卡牌名字'] || '';
    if (data['HP']) parts.push(`HP${data['HP']}`);
    if (data['属性']) parts.push(data['属性']);
    if (data['进化阶段'] && data['进化阶段'] !== '基础') parts.push(data['进化阶段']);
    if (data['特性名字']) parts.push(`特性:${data['特性名字']}`);
    for (let i = 1; i <= 4; i++) {
      const s = data[`技能${i}`];
      if (s && s['名字']) {
        const cost = Array.isArray(s['消耗']) ? s['消耗'].filter(c => c !== '无').join('') : '';
        const dmg = s['伤害'] ? `(${s['伤害']})` : '';
        parts.push(`[${cost}]${s['名字']}${dmg}`);
      }
    }
    if (data['效果']) parts.push(data['效果'].slice(0, 40));
    return parts.join(' | ');
  }

  _formatCardRich(data, cardId) {
    const lines = [];
    const version = this._extractVersion(data);
    const envTag = version ? (this._isCurrentFormat(version) ? ` [${version}标✓]` : ` [${version}标·已退]`) : '';
    const name = data['宝可梦名字'] || data['卡牌名字'] || '未知';
    lines.push(`**${name}**${envTag}  ID:\`${cardId}\``);

    if (data['宝可梦名字']) {
      lines.push(`- 宝可梦 | ${data['属性'] || '?'} | HP${data['HP'] || '?'} | ${data['进化阶段'] || '基础'}`);
      if (data['进化自']) lines.push(`- 进化自: ${data['进化自']}`);
      if (data['规则']) lines.push(`- 规则: ${data['规则']}`);
      if (data['弱点']) lines.push(`- 弱点: ${data['弱点']} | 抵抗力: ${data['抵抗力'] || '无'} | 撤退: ${data['撤退'] != null ? data['撤退'] : '?'}`);
      if (data['特性名字']) lines.push(`- 特性「${data['特性名字']}」: ${data['特性效果'] || '(无描述)'}`);
      for (let i = 1; i <= 4; i++) {
        const s = data[`技能${i}`];
        if (s && s['名字']) {
          const cost = Array.isArray(s['消耗']) ? s['消耗'].join(' ') : '无';
          const dmg = s['伤害'] ? ` ${s['伤害']}` : '';
          const eff = s['效果'] && s['效果'] !== '无' ? `。${s['效果']}` : '';
          lines.push(`- ${cost}「${s['名字']}」${dmg}${eff}`);
        }
      }
    } else {
      lines.push(`- 类型: ${data['卡牌类型'] || '?'}`);
      if (Array.isArray(data['卡牌版本'])) lines.push(`- 版本: ${data['卡牌版本'].join(', ')}`);
      if (data['效果']) lines.push(`- 效果: ${data['效果']}`);
    }
    return lines.join('\n');
  }

  /** 获取卡牌数量 */
  get cacheSize() { return this._jsonCache.size; }
}
