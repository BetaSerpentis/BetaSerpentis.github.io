// ptcg/js/services/AICardDataService.js
// AI 卡牌数据层：TSV 优先 + JSON 回退，搜索、详情

export class AICardDataService {
  constructor(cardManager) {
    this.cardManager = cardManager;
    // JSON 完整卡牌数据: Map<cardId, fullCardObject>（遗留回退）
    this._jsonCache = new Map();
    this._jsonLoading = new Map();
    // TSV 索引: Map<cardId, {name, type, mark, searchText}>
    this._tsvIndex = new Map();
    // TSV 招式/特性/属性缓存
    this._tsvAttacks = new Map();
    this._tsvAbilities = new Map();
    this._tsvFilter = new Map();  // cardId → {hp, stage, attr, retreat}
    // 加载状态
    this._loaded = false;
    this._tsvLoaded = false;
  }

  // ========== TSV 类型映射 ==========

  _typeToSlug(cardType) {
    const map = {
      '宝可梦': 'pokemon', '支援者': 'supporter', '物品': 'item',
      '宝可梦道具': 'pokemon-tool', '竞技场': 'stadium',
      '基本能量': 'basic-energy', '特殊能量': 'special-energy'
    };
    return map[cardType] || null;
  }

  _slugToType(slug) {
    const map = {
      'pokemon': '宝可梦', 'supporter': '支援者', 'item': '物品',
      'pokemon-tool': '宝可梦道具', 'stadium': '竞技场',
      'basic-energy': '基本能量', 'special-energy': '特殊能量'
    };
    return map[slug] || slug;
  }

  // ========== TSV 索引加载 ==========

  async _loadTsvIndex() {
    if (this._tsvLoaded) return;
    const slugs = ['pokemon', 'supporter', 'item', 'pokemon-tool', 'stadium', 'basic-energy', 'special-energy'];

    try {
      // 并行加载所有 idx.tsv + search.tsv
      const loadPromises = slugs.map(async (slug) => {
        try {
          const [idxResp, searchResp] = await Promise.all([
            fetch(`data_fast/${slug}.idx.tsv`),
            fetch(`data_fast/${slug}.search.tsv`)
          ]);
          if (!idxResp.ok || !searchResp.ok) return;

          const idxText = await idxResp.text();
          const searchText = await searchResp.text();
          const idxLines = idxText.split('\n').filter(l => l.trim());
          const searchLines = searchText.split('\n').filter(l => l.trim());

          // 构建 searchText 查找: ID → text
          const searchMap = new Map();
          for (const line of searchLines) {
            const tabIdx = line.indexOf('\t');
            if (tabIdx < 0) continue;
            searchMap.set(line.slice(0, tabIdx), line.slice(tabIdx + 1));
          }

          const cardType = this._slugToType(slug);

          for (const line of idxLines) {
            const parts = line.split('\t');
            if (parts.length < 2) continue;
            const id = parts[0];
            const name = parts[1];
            // 提取版本标记：优先从 searchText 末尾获取，回退从 ID 前缀推断
            const searchStr = searchMap.get(id) || '';
            let mark = '';
            // search.tsv 格式末尾通常是 "... csv10c i" 或 "... csv8c h"
            const markMatch = searchStr.match(/\b([fghi])\b(?=\s*$)/i);
            if (markMatch) {
              mark = markMatch[1].toUpperCase();
            } else if (id.startsWith('CSV')) {
              // 回退：从 ID 数字部分推断（CSV7+→H, CSV10+→I）
              const numMatch = id.match(/^CSV[A-Z]*(\d+)/);
              if (numMatch) {
                const num = parseInt(numMatch[1]);
                if (num >= 10) mark = 'I';
                else if (num >= 7) mark = 'H';
                else if (num >= 4) mark = 'G';
                else mark = 'F';
              }
            }
            // TSV 数据全部为 F-I 标，无法识别时默认当前环境
            if (!mark || mark === '?') mark = 'H';

            const entry = {
              name,
              type: cardType,
              mark: mark || '?',
              searchText: searchStr || name
            };

            if (!this._tsvIndex.has(id)) {
              this._tsvIndex.set(id, entry);
            }
          }
        } catch (e) {
          console.warn(`[AI TSV] Failed to load ${slug}:`, e.message);
        }
      });

      await Promise.all(loadPromises);

      // 加载招式 + 特性 + 属性全局索引
      await Promise.all([
        this._loadTsvAttacks(),
        this._loadTsvAbilities(),
        this._loadTsvFilters()
      ]);

      this._tsvLoaded = true;
      console.log('[AI TSV] Index ready:', this._tsvIndex.size, 'cards,',
        this._tsvAttacks.size, 'with attacks,', this._tsvAbilities.size, 'with abilities');
    } catch (e) {
      console.warn('[AI TSV] Index load failed:', e.message);
    }
  }

  async _loadTsvAttacks() {
    try {
      const resp = await fetch('data_fast/attacks.tsv');
      if (!resp.ok) return;
      const text = await resp.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        const cardId = parts[0];
        const attack = {
          index: parseInt(parts[3]) || 1,
          name: parts[4] || '',
          cost: (parts[5] || '').split(',').filter(c => c),
          damage: parts[6] || '',
          effect: parts[7] || ''
        };
        if (!this._tsvAttacks.has(cardId)) this._tsvAttacks.set(cardId, []);
        this._tsvAttacks.get(cardId).push(attack);
      }
    } catch (e) {
      console.warn('[AI TSV] Attacks load failed:', e.message);
    }
  }

  async _loadTsvAbilities() {
    try {
      const resp = await fetch('data_fast/abilities.tsv');
      if (!resp.ok) return;
      const text = await resp.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 6) continue;
        const cardId = parts[0];
        const ability = {
          index: parseInt(parts[3]) || 1,
          name: parts[4] || '',
          effect: parts[5] || ''
        };
        if (!this._tsvAbilities.has(cardId)) this._tsvAbilities.set(cardId, []);
        this._tsvAbilities.get(cardId).push(ability);
      }
    } catch (e) {
      console.warn('[AI TSV] Abilities load failed:', e.message);
    }
  }

  async _loadTsvFilters() {
    const slugs = ['pokemon', 'supporter', 'item', 'pokemon-tool', 'stadium', 'basic-energy', 'special-energy'];
    const attrCodes = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
    const stageNames = { '0': '基础', '1': '1阶进化', '2': '2阶进化' };

    for (const slug of slugs) {
      try {
        const resp = await fetch(`data_fast/${slug}.filter.tsv`);
        if (!resp.ok) continue;
        const text = await resp.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length < 2) continue;
          const id = parts[0];
          if (slug === 'pokemon' && parts.length >= 5) {
            this._tsvFilter.set(id, {
              hp: parseInt(parts[1]) || 0,
              stage: stageNames[parts[2]] || '基础',
              attr: attrCodes[parts[3]] || parts[3] || '',
              retreat: parseInt(parts[4]) || 0
            });
          }
          // 训练家卡 filter 仅用于标记存在性
        }
      } catch (e) {
        console.warn(`[AI TSV] Filter load failed for ${slug}:`, e.message);
      }
    }
    console.log('[AI TSV] Filters loaded:', this._tsvFilter.size, 'pokemon with stats');
  }

  /** 从 TSV 索引构建 JSON 兼容的卡牌数据对象 */
  _buildTsvCardData(cardId) {
    const idx = this._tsvIndex.get(cardId);
    if (!idx) return null;

    const attacks = this._tsvAttacks.get(cardId) || [];
    const abilities = this._tsvAbilities.get(cardId) || [];
    const filter = this._tsvFilter.get(cardId);

    const isPokemon = idx.type === '宝可梦';
    const data = {};

    if (isPokemon) {
      data['宝可梦名字'] = idx.name;
      data['卡牌版本'] = idx.mark;
      // 从 searchText 提取属性、进化阶段
      const st = idx.searchText;
      const attrMap = { '草': '草', '火': '火', '水': '水', '雷': '雷', '超': '超', '斗': '斗', '恶': '恶', '钢': '钢', '妖': '妖', '龙': '龙', '无': '无' };
      for (const attr of Object.keys(attrMap)) {
        if (st.includes(' ' + attr + ' ')) { data['属性'] = attr; break; }
      }
      // 进化阶段：优先 filter，回退 search text
      if (filter && filter.stage) {
        data['进化阶段'] = filter.stage;
      } else if (st.includes('stage 2')) {
        data['进化阶段'] = '2阶进化';
      } else if (st.includes('stage 1')) {
        data['进化阶段'] = '1阶进化';
      } else {
        data['进化阶段'] = '基础';
      }
      // HP + 撤退（来自 filter.tsv）
      if (filter) {
        data['HP'] = filter.hp || undefined;
        data['属性'] = filter.attr || data['属性'] || '';
        data['撤退'] = filter.retreat;
      }
      // 特性
      if (abilities.length > 0) {
        data['特性名字'] = abilities[0].name;
        data['特性效果'] = abilities[0].effect;
      }
      // 技能
      for (const atk of attacks) {
        const key = `技能${atk.index}`;
        data[key] = {
          '名字': atk.name,
          '消耗': atk.cost,
          '伤害': atk.damage,
          '效果': atk.effect
        };
      }
    } else {
      data['卡牌名字'] = idx.name;
      data['卡牌类型'] = idx.type + '卡';
      data['卡牌版本'] = [idx.mark];
      // 效果从 searchText 提取（简化：整段作为效果）
      data['效果'] = idx.searchText;
    }

    // 标记数据来源
    data._fromTsv = true;
    return data;
  }

  // ========== JSON 缓存加载（保留回退） ==========

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

    // 并行加载 TSV 索引（优先）+ JSON（回退）
    const tasks = [this._loadTsvIndex()];
    const types = this.cardManager.getAllCardTypes();
    tasks.push(...types.map(t => this._loadJsonCache(t)));

    await Promise.all(tasks);
    this._loaded = true;
    console.log('[AI Data] Ready — TSV:', this._tsvIndex.size, 'cards, JSON:', this._jsonCache.size, 'cards');
  }

  /** 获取指定 ID 的完整数据（TSV 优先，JSON 回退，过滤退环境） */
  async getFullCardData(cardId) {
    // 优先从 JSON 缓存查找（数据更完整，但需过滤退环境卡）
    if (this._jsonCache.has(cardId)) {
      const data = this._jsonCache.get(cardId);
      const v = this._extractVersion(data);
      if (!v || this._isCurrentFormat(v)) return data;
      // 退环境卡：不回退到旧数据，转 TSV
    }

    // TSV 查找
    if (this._tsvIndex.has(cardId)) {
      return this._buildTsvCardData(cardId);
    }

    // 回退：仅 TSV 索引中存在的卡（过滤旧 JSON 编号 ID 如 "4521"）
    if (!cardId || !this._tsvIndex.has(cardId)) return null;
    let cardType = null;
    const cache = this.cardManager.allCardsCache || this.cardManager.cards || [];
    const basic = cache.find(c => c.id === cardId);
    if (basic) cardType = basic.type;
    if (!cardType) return null;
    await this._loadJsonCache(cardType);
    const data = this._jsonCache.get(cardId);
    if (data) {
      const v = this._extractVersion(data);
      if (v && !this._isCurrentFormat(v)) return null; // 退环境
    }
    return data || null;
  }

  async getFullCardDataBatch(cardIds) {
    const typesNeeded = new Set();
    const cache = this.cardManager.allCardsCache || this.cardManager.cards || [];
    for (const id of cardIds) {
      if (this._jsonCache.has(id) || this._tsvIndex.has(id)) continue;
      const basic = cache.find(c => c.id === id);
      if (basic && basic.type) typesNeeded.add(basic.type);
    }
    if (typesNeeded.size > 0) await Promise.all([...typesNeeded].map(t => this._loadJsonCache(t)));
    const result = new Map();
    for (const id of cardIds) {
      const data = this._jsonCache.get(id) || this._buildTsvCardData(id);
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
    return version && /^[FGHI]$/i.test(version);
  }

  /** search_cards — TSV优先，JSON回退 */
  searchCards(query, cardType, limit = 15) {
    if (!query || !query.trim()) return { results: [], total: 0, message: '请提供搜索关键词' };
    limit = Math.min(limit, 50);
    const normQuery = query.replace(/[【】]/g, '');
    const terms = normQuery.split(/\s+/).filter(t => t.length > 0);
    const results = [];
    const seenIds = new Set();

    // 1. 优先搜索 TSV 索引（数据最新最全）
    for (const [id, entry] of this._tsvIndex) {
      if (seenIds.has(id)) continue;
      if (cardType && entry.type !== cardType) continue;
      if (entry.mark && !this._isCurrentFormat(entry.mark)) continue;

      const text = entry.searchText;
      let score = 0;
      for (const term of terms) {
        if (text.includes(term.toLowerCase())) score++;
      }
      if (score > 0) {
        seenIds.add(id);
        results.push({ id, score, data: null, _name: entry.name, _type: entry.type });
      }
    }

    // 2. JSON 回退搜索
    for (const [id, data] of this._jsonCache) {
      if (seenIds.has(id)) continue;
      if (cardType) {
        let type = data['卡牌类型'] || '';
        if (!type && data['宝可梦名字']) type = '宝可梦';
        if (type.endsWith('卡')) type = type.slice(0, -1);
        if (type !== cardType) continue;
      }
      const version = this._extractVersion(data);
      if (version && !this._isCurrentFormat(version)) continue;
      const text = this._jsonCardToSearchText(data).replace(/[【】]/g, '');
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      if (score > 0) {
        seenIds.add(id);
        results.push({ id, score, data });
      }
    }

    // 3. CardManager 回退（仅 TSV 索引中存在的当前环境卡）
    if (results.length === 0) {
      const cache = this.cardManager.allCardsCache || [];
      for (const card of cache) {
        if (cardType && card.type !== cardType) continue;
        // 🔴 过滤退环境卡：必须存在于 TSV 索引（build-cn-data.py 仅输出当前环境卡）
        if (!card.id || !this._tsvIndex.has(card.id)) continue;
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
      if (r.data) {
        const name = r.data['宝可梦名字'] || r.data['卡牌名字'] || '未知';
        const type = r.data['卡牌类型'] || (r.data['宝可梦名字'] ? '宝可梦' : '');
        const detail = this._summarizeCardQuick(r.data);
        return `- **${name}** [ID:${r.id}] [${type}] ${detail}`;
      }
      const name = r._name || `卡牌 ${r.id}`;
      const type = r._type || '?';
      return `- **${name}** [ID:${r.id}] [${type}] (TSV)`;
    }).join('\n');

    const sourceTag = results.length > 0 && !results[0].data ? ' [TSV]' : '';
    return {
      results: top.map(r => ({ id: r.id, data: r.data })),
      total: results.length,
      message: `找到 ${results.length} 张${sourceTag}，显示前 ${top.length} 张:\n${formatted}\n\n> 用 get_card_detail(ID) 查看完整效果`
    };
  }

  /** grep_cards — TSV优先，JSON回退 */
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

      // TSV 搜索
      for (const [id, entry] of this._tsvIndex) {
        if (cardType && entry.type !== cardType) continue;
        if (entry.mark && !this._isCurrentFormat(entry.mark)) continue;

        const re = new RegExp(patternStr, 'gi');
        const matches = [];
        let match;
        while ((match = re.exec(entry.searchText)) !== null) {
          matches.push(match[0]);
          if (matches.length >= 3) break;
        }
        if (matches.length > 0) {
          const existing = allResults.get(id);
          if (existing) {
            existing.score += matches.length;
            existing.matches.push(...matches);
          } else {
            allResults.set(id, { id, name: entry.name, data: null, score: matches.length, matches, _fromTsv: true });
          }
        }
      }

      // JSON 回退
      for (const [id, data] of this._jsonCache) {
        if (allResults.has(id)) continue;
        if (cardType) {
          let type = data['卡牌类型'] || '';
          if (!type && data['宝可梦名字']) type = '宝可梦';
          if (type.endsWith('卡')) type = type.slice(0, -1);
          if (type !== cardType) continue;
        }
        const version = this._extractVersion(data);
        if (version && !this._isCurrentFormat(version)) continue;
        const text = this._jsonCardToSearchText(data);
        const re = new RegExp(patternStr, 'gi');
        const matches = [];
        let match;
        while ((match = re.exec(text)) !== null) {
          matches.push(match[0]);
          if (matches.length >= 3) break;
        }
        if (matches.length > 0) {
          const name = data['宝可梦名字'] || data['卡牌名字'] || id;
          allResults.set(id, { id, name, data, score: matches.length, matches, _fromTsv: false });
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
      if (c.data) {
        const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
        const detail = this._summarizeCardQuick(c.data);
        return `- **${c.name}** [ID:${c.id}] [${type}] ${detail}\n  命中: ${snippets}`;
      }
      return `- **${c.name}** [ID:${c.id}] [TSV]\n  命中: ${snippets}`;
    }).join('\n');

    return {
      results: top.map(r => ({ id: r.id, data: r.data })),
      total: allResults.size,
      message: `Grep "${patterns}" 找到 ${allResults.size} 张 (TSV+JSON, 仅F-I标)，前 ${top.length}:\n${formatted}`
    };
  }

  /** get_card_detail — TSV优先，JSON回退 */
  async getCardDetail(cardId) {
    if (!cardId) return '错误：请提供卡牌ID';

    // JSON 优先（数据更完整）
    let data = this._jsonCache.get(cardId);
    if (!data) {
      data = await this.getFullCardData(cardId);
    }
    // TSV 构建
    if (!data && this._tsvIndex.has(cardId)) {
      data = this._buildTsvCardData(cardId);
    }
    if (!data) return `未找到卡牌 ID: ${cardId}`;
    return this._formatCardRich(data, cardId);
  }

  /** search_by_set — 按卡包代码列出该包全部卡牌 */
  searchBySet(setCode, cardType, limit = 50) {
    if (!setCode) return { results: [], total: 0, message: '请提供卡包代码，如 CSV10C' };
    const prefix = setCode.toUpperCase();
    limit = Math.min(limit, 100);
    const results = [];

    for (const [id, entry] of this._tsvIndex) {
      if (!id.startsWith(prefix)) continue;
      if (cardType && entry.type !== cardType) continue;
      results.push({ id, name: entry.name, type: entry.type, mark: entry.mark });
    }

    if (results.length === 0) {
      // 尝试从 sets.tsv 获取卡包信息
      return {
        results: [],
        total: 0,
        message: `未找到卡包 "${setCode}" 中的卡牌。提示：用 search_meta("sets") 查看可用卡包列表，或尝试 "CSV10C"（共逐荣光）、"CSV9C"（星彩晶璃）等。`
      };
    }

    // 按类型分组
    const byType = {};
    for (const r of results) {
      if (!byType[r.type]) byType[r.type] = [];
      byType[r.type].push(r);
    }

    const top = results.slice(0, limit);
    let msg = `卡包 **${prefix}** 共 ${results.length} 张卡牌`;
    const setNames = { 'CSV10C': '共逐荣光', 'CSV9C': '星彩晶璃', 'CSV9.5C': '太晶盛聚', 'CSV8C': '璀璨诡幻', 'CSV7C': '利刃猛醒' };
    if (setNames[prefix]) msg += `（${setNames[prefix]}）`;
    msg += ':\n';

    for (const [type, cards] of Object.entries(byType)) {
      msg += `\n**${type}** (${cards.length}张):\n`;
      const show = cards.slice(0, 20);
      show.forEach(c => msg += `- ${c.name} [ID:${c.id}]\n`);
      if (cards.length > 20) msg += `  ... 还有 ${cards.length - 20} 张\n`;
    }

    return {
      results: top.map(r => ({ id: r.id, data: null, _name: r.name, _type: r.type })),
      total: results.length,
      message: msg
    };
  }

  /** verify_card_name — 模糊匹配纠错，输入疑似卡名返回最接近的真实卡名 */
  verifyCardName(query, limit = 5) {
    if (!query || !query.trim()) return { results: [], message: '请提供卡牌名称' };
    const q = query.replace(/[【】]/g, '').toLowerCase();
    const results = [];

    for (const [id, entry] of this._tsvIndex) {
      const name = entry.name.toLowerCase();
      // 精确匹配优先
      if (name === q) {
        results.push({ id, name: entry.name, type: entry.type, mark: entry.mark, score: 100, match: 'exact' });
        continue;
      }
      // 包含匹配
      if (name.includes(q) || q.includes(name)) {
        results.push({ id, name: entry.name, type: entry.type, mark: entry.mark, score: 80, match: 'contains' });
        continue;
      }
      // 单字差异匹配（Levenshtein简化：共享字符数）
      let common = 0;
      for (const ch of q) {
        if (name.includes(ch)) common++;
      }
      const similarity = common / Math.max(q.length, name.length);
      if (similarity > 0.5 && q.length >= 2) {
        results.push({ id, name: entry.name, type: entry.type, mark: entry.mark, score: Math.round(similarity * 60), match: 'fuzzy' });
      }
    }

    // 去重（同名卡取最新版本）
    const seen = new Set();
    const unique = [];
    for (const r of results.sort((a, b) => b.score - a.score)) {
      if (!seen.has(r.name)) {
        seen.add(r.name);
        unique.push(r);
      }
    }

    const top = unique.slice(0, limit);
    if (top.length === 0) {
      return { results: [], message: `未找到与"${query}"接近的卡名。建议：简化搜索词或换一个名称尝试。` };
    }

    const formatted = top.map(r => {
      const tag = r.match === 'exact' ? '✓精确' : r.match === 'contains' ? '~包含' : '?模糊';
      return `- ${tag} **${r.name}** [ID:${r.id}] [${r.type}] [${r.mark}标]`;
    }).join('\n');

    return {
      results: top.map(r => ({ id: r.id, name: r.name, type: r.type })),
      message: `"${query}" 的可能匹配:\n${formatted}\n\n> 如果以上都不是你要找的卡，尝试用 search_cards 搜索。`
    };
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
    const sourceTag = data._fromTsv ? ' [TSV]' : '';
    lines.push(`**${name}**${envTag}${sourceTag}  ID:\`${cardId}\``);

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
  get cacheSize() { return this._tsvIndex.size + this._jsonCache.size; }
}
