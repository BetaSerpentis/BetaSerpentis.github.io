// ptcg/js/services/AIChatService.js
// PTCG AI Agent 核心：对话管理、工具调度、agent 循环、卡组解析

import { CONFIG_AI, STORAGE_KEYS } from '../utils/constants.js';
import { buildSystemPrompt } from './AISystemPrompt.js';
import { AICardDataService } from './AICardDataService.js';
import { AIAnalysisService } from './AIAnalysisService.js';

export class AIChatService {
  constructor(cardManager, apiKeyManager, deckManager) {
    this.cardManager = cardManager;
    this.apiKeyManager = apiKeyManager;
    this.deckManager = deckManager;
    this._history = [];
    this._data = new AICardDataService(cardManager);
    this._analysis = new AIAnalysisService(this._data);
    this._loadHistory();
  }

  // ========== 数据初始化 ==========

  async ensureDataLoaded() {
    await this._data.ensureLoaded();
  }

  // ========== 对话历史 ==========

  _loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AI_CHAT_HISTORY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
          this._history = parsed.slice(-CONFIG_AI.maxHistoryMessages);
      }
    } catch (e) { this._history = []; }
  }

  _saveHistory() {
    try {
      const toSave = this._history.slice(-CONFIG_AI.maxHistoryMessages);
      localStorage.setItem(STORAGE_KEYS.AI_CHAT_HISTORY, JSON.stringify(toSave));
    } catch (e) { /* ignore */ }
  }

  clearHistory() {
    this._history = [];
    try { localStorage.removeItem(STORAGE_KEYS.AI_CHAT_HISTORY); } catch (e) { /* */ }
  }

  getHistory() { return [...this._history]; }

  // ========== Agent 工具定义 ==========

  _getTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'search_cards',
          description: '关键词搜索卡牌数据库。支持卡名、效果词、属性。多词空格分隔（AND）。用于快速找到目标卡或初步探索。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索关键词，例："沙奈朵ex" "伤害指示物 弃牌区"' },
              card_type: { type: 'string', enum: ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'] },
              limit: { type: 'integer', description: '返回数量，默认15，最大50' }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'grep_cards',
          description: '正则精确搜索卡牌效果文本。多pattern用||分隔。适合查找特定机制模式，如找所有"伤害随伤害指示物增加"的卡。',
          parameters: {
            type: 'object',
            properties: {
              patterns: { type: 'string', description: '正则表达式，多pattern用||分隔' },
              card_type: { type: 'string', enum: ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'] },
              limit: { type: 'integer', description: '返回上限，默认10' }
            },
            required: ['patterns']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_card_detail',
          description: '获取单卡完整数据（HP/特性/招式/效果/规则等）。在将任何卡写入分析前必须调用此工具确认效果。',
          parameters: {
            type: 'object',
            properties: { card_id: { type: 'string', description: '卡牌ID' } },
            required: ['card_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'deep_analysis',
          description: '一键深度分析：输入卡名，自动完成搜索→协同检测→评分排序→生成报告。第一次分析某张卡时优先用这个。',
          parameters: {
            type: 'object',
            properties: { card_name: { type: 'string', description: '卡牌名称' } },
            required: ['card_name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_my_decks',
          description: '列出用户已有的所有卡组，包含卡组名和卡牌数量。用户询问自己的卡组时调用。',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_deck_detail',
          description: '查看指定卡组的完整内容（所有卡牌及数量）。配合 get_my_decks 使用。',
          parameters: {
            type: 'object',
            properties: { deck_index: { type: 'integer', description: '卡组在列表中的序号（从0开始）' } },
            required: ['deck_index']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'build_deck',
          description: '为用户创建新卡组或更新已有卡组。cards_json 需包含 name 和 cards 数组，每张卡含 id 和 quantity。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '卡组名称' },
              cards_json: { type: 'string', description: 'JSON字符串: {"name":"卡组名","cards":[{"id":"ID","quantity":4}]} 注意id是字符串' },
              deck_index: { type: 'integer', description: '如要更新已有卡组，传卡组序号（从get_my_decks获取）。留空则创建新卡组。' }
            },
            required: ['cards_json']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_meta',
          description: '搜索当前环境元数据：上位卡组、常用泛用卡、赛标信息、环境趋势。用于了解当前PTCG简中环境的大环境信息。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索词，如"上位卡组"、"ACE SPEC"、"支援者"、"沙奈朵"等' }
            },
            required: ['query']
          }
        }
      }
    ];
  }

  // ========== 工具执行 ==========

  async _executeTool(toolCall) {
    const name = toolCall.name;
    let args = {};
    try { args = JSON.parse(toolCall.arguments || toolCall.args || '{}'); } catch (e) { /* */ }

    console.log('[AI Agent] Tool:', name, JSON.stringify(args).slice(0, 100));

    switch (name) {
      case 'search_cards': {
        const r = this._data.searchCards(args.query, args.card_type, args.limit || 15);
        return r.message;
      }
      case 'grep_cards': {
        const r = this._data.grepCards(args.patterns, args.card_type, args.limit || 10);
        return r.message;
      }
      case 'get_card_detail':
        return await this._data.getCardDetail(args.card_id);

      case 'deep_analysis':
        return await this._analysis.deepAnalysis(args.card_name);

      case 'get_my_decks': {
        const decks = this.deckManager.decks;
        if (decks.length === 0) return '你目前没有任何卡组。';
        return decks.map((d, i) =>
          `[${i}] **${d.name}** — ${d.totalCount}/60 张, ${d.cards.length} 种卡`
        ).join('\n');
      }

      case 'get_deck_detail': {
        const idx = args.deck_index;
        const deck = this.deckManager.decks[idx];
        if (!deck) return `卡组序号 ${idx} 不存在。`;
        return this._analysis.analyzeDeck(deck);
      }

      case 'build_deck': {
        const result = this._buildDeckFromAI(args.name, args.cards_json, args.deck_index);
        const idx = args.deck_index;
        if (idx != null && this.deckManager.decks[idx]) {
          this._lastBuiltDeck = { name: this.deckManager.decks[idx].name, cards: [...this.deckManager.decks[idx].cards], totalCount: this.deckManager.decks[idx].totalCount };
        } else {
          const latest = this.deckManager.decks[0];
          if (latest) this._lastBuiltDeck = { name: latest.name, cards: [...latest.cards], totalCount: latest.totalCount };
        }
        return result;
      }

      case 'search_meta': {
        return this._searchMeta(args.query);
      }

      default:
        return `未知工具: ${name}`;
    }
  }

  /** 从 AI 返回的 JSON 创建/更新卡组 */
  _buildDeckFromAI(name, cardsJson, deckIndex) {
    try {
      let parsed;
      try { parsed = JSON.parse(cardsJson); } catch (e) {
        const match = cardsJson.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else return '卡组 JSON 解析失败。请检查格式：{"name":"卡组名","cards":[{"id":"ID","quantity":4}]}';
      }

      if (!parsed || !Array.isArray(parsed.cards)) return '卡组缺少 cards 数组。';

      const deckName = name || parsed.name || 'AI 推荐卡组';
      const validCards = [];
      const invalidCards = [];

      for (const card of parsed.cards) {
        if (!card.id) { invalidCards.push(card); continue; }
        // 优先用全局 JSON 缓存校验（跨所有类型），fallback 到 cardManager
        const jsonData = this._data._jsonCache.get(String(card.id));
        if (jsonData) {
          const cardName = jsonData['宝可梦名字'] || jsonData['卡牌名字'] || String(card.id);
          const qty = Math.min(Math.max(1, parseInt(card.quantity) || 1), 4);
          validCards.push({
            id: String(card.id),
            name: cardName,
            image: `images/hk${String(card.id).padStart(8, '0')}.webp`,
            type: jsonData['宝可梦名字'] ? '宝可梦' : (jsonData['卡牌类型'] || '').replace('卡', ''),
            quantity: qty
          });
        } else {
          const baseInfo = this.cardManager.getCardBaseInfo(card.id);
          if (baseInfo && baseInfo.name && !baseInfo.name.startsWith('卡牌 ')) {
            validCards.push({
              id: String(card.id),
              name: baseInfo.name,
              image: baseInfo.image,
              type: baseInfo.type,
              quantity: Math.min(Math.max(1, parseInt(card.quantity) || 1), 4)
            });
          } else {
            invalidCards.push(card);
          }
        }
      }

      if (validCards.length === 0) return `所有卡牌 ID 验证失败，不在数据库中。请用 search_cards 找到正确的卡。`;

      if (deckIndex != null && this.deckManager.decks[deckIndex]) {
        const deck = this.deckManager.decks[deckIndex];
        deck.name = deckName;
        deck.cards = validCards;
        this.deckManager.sortDeckCards(deck);
        deck.totalCount = validCards.reduce((s, c) => s + c.quantity, 0);
        this.deckManager.saveDecks();
        const warn = invalidCards.length > 0 ? `\n⚠ ${invalidCards.length} 张无效卡已过滤` : '';
        return this._formatDeckResult(deckName, validCards, invalidCards, '更新');
      } else {
        const deck = this.deckManager.createNewDeck();
        deck.name = deckName;
        if (validCards.length > 0) deck.coverCardId = validCards[0].id;
        deck.cards = validCards;
        this.deckManager.sortDeckCards(deck);
        deck.totalCount = validCards.reduce((s, c) => s + c.quantity, 0);
        this.deckManager.saveDecks();
        const warn = invalidCards.length > 0 ? `\n⚠ ${invalidCards.length} 张无效卡已过滤` : '';
        return this._formatDeckResult(deckName, validCards, invalidCards, '创建');
      }
    } catch (e) {
      return `创建卡组失败: ${e.message}`;
    }
  }

  _formatDeckResult(name, cards, invalidCards, action) {
    const byType = {};
    for (const c of cards) {
      const t = c.type || '未知';
      if (!byType[t]) byType[t] = [];
      byType[t].push(c);
    }
    const total = cards.reduce((s, c) => s + c.quantity, 0);
    const lines = [
      `✅ 已${action}卡组「**${name}**」— ${total}/60 张 · ${cards.length} 种`,
      ''
    ];
    for (const [type, clist] of Object.entries(byType)) {
      lines.push(`**${type}** (${clist.length}种 / ${clist.reduce((s,c)=>s+c.quantity,0)}张)`);
      for (const c of clist) {
        lines.push(`- ${c.name} x${c.quantity}  \`ID:${c.id}\``);
      }
      lines.push('');
    }
    if (invalidCards.length > 0) {
      lines.push(`⚠ ${invalidCards.length} 张卡牌 ID 验证失败，已自动过滤。`);
    }
    // 嵌入 JSON 代码块让 parseDeckFromResponse 能捕获
    const deckJson = JSON.stringify({ name, cards: cards.map(c => ({ id: c.id, quantity: c.quantity })) });
    lines.push('\n```json deck');
    lines.push(deckJson);
    lines.push('```');
    lines.push('\n> 卡组已保存到你的卡组库，可在「卡组」页签查看。');
    return lines.join('\n');
  }

  // ========== 解析卡组 JSON（从流式文本中提取）==========

  parseDeckFromResponse(text) {
    if (!text) return null;

    // 先尝试从所有可能的 JSON 对象中找到包含 "cards" 数组的最大一个
    const jsonCandidates = [];
    let braceDepth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (braceDepth === 0) start = i;
        braceDepth++;
      } else if (text[i] === '}') {
        braceDepth--;
        if (braceDepth === 0 && start >= 0) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes('"cards"')) {
            jsonCandidates.push(candidate);
          }
        }
      }
    }

    jsonCandidates.sort((a, b) => b.length - a.length);
    for (const candidate of jsonCandidates) {
      const deck = this._tryParseDeck(candidate);
      if (deck) return deck;
    }

    // 没找到完整 JSON，尝试用正则从文本中提取 id/quantity 对重建卡组
    const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
    const cardMatches = text.matchAll(/\{?\s*"?id"?\s*:\s*"?(\d+)"?\s*,?\s*"?quantity"?\s*:\s*(\d+)\s*\}?/g);
    const cards = [];
    for (const m of cardMatches) {
      const id = m[1], qty = parseInt(m[2]) || 1;
      if (!cards.find(c => c.id === id)) cards.push({ id, quantity: qty });
    }
    if (cards.length > 0) {
      return this._validateDeck({ name: (nameMatch ? nameMatch[1] : 'AI 推荐卡组'), cards });
    }

    return null;
  }

  /** 尝试解析 JSON（自动修复常见错误） */
  _tryParseDeck(jsonStr) {
    // 去掉前缀（json deck、json 等）
    let fixed = jsonStr.replace(/^.*?json\s*deck\s*/i, '').replace(/^.*?json\s*/i, '');
    // 修复1：数组元素间缺逗号
    fixed = fixed.replace(/\}\s*\[/g, '},{').replace(/\]\s*\{/g, '},{')
      .replace(/\}\s*\{/g, '},{').replace(/\]\s*\[/g, '},{')
      .replace(/\)\s*\[/g, '},{').replace(/\)\s*\{/g, '},{')
      .replace(/\}\s*\)/g, '}').replace(/\)\s*\]/g, '}]')
    // 修复2：* 当冒号
      .replace(/\*/g, ':')
    // 修复3：键值间缺冒号/逗号
      .replace(/"([^"]+)"\s*"([^"]+)"/g, '"$1":"$2"')
    // 修复4：缺引号的数字值 id:123 → "id":"123"
      .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:\s*(\d+)/g, '$1"$2":"$3"');
    // 确保 cards 是有效数组
    if (!fixed.includes('"cards"')) return null;
    try {
      const deck = JSON.parse(fixed);
      if (deck && Array.isArray(deck.cards) && deck.cards.length > 0) {
        return this._validateDeck(deck);
      }
    } catch (e) { /* try regex extraction fallback */ }
    return null;
  }

  _validateDeck(deck) {
    if (!deck || !Array.isArray(deck.cards)) return null;
    const validCards = [];
    const invalidCards = [];

    for (const card of deck.cards) {
      if (!card.id) { invalidCards.push(card); continue; }
      const cid = String(card.id);
      // 全局 JSON 缓存优先
      const jsonData = this._data._jsonCache.get(cid);
      if (jsonData) {
        const cname = jsonData['宝可梦名字'] || jsonData['卡牌名字'] || cid;
        validCards.push({
          id: cid, name: cname,
          image: `images/hk${cid.padStart(8, '0')}.webp`,
          type: jsonData['宝可梦名字'] ? '宝可梦' : (jsonData['卡牌类型'] || '').replace('卡', ''),
          quantity: Math.min(Math.max(1, parseInt(card.quantity) || 1), 4)
        });
      } else {
        const baseInfo = this.cardManager.getCardBaseInfo(cid);
        if (baseInfo && baseInfo.name && !baseInfo.name.startsWith('卡牌 ')) {
          validCards.push({
            id: cid, name: baseInfo.name, image: baseInfo.image,
            type: baseInfo.type, quantity: Math.min(Math.max(1, parseInt(card.quantity) || 1), 4)
          });
        } else { invalidCards.push(card); }
      }
    }

    if (validCards.length === 0) return null;
    return {
      name: deck.name || 'AI 推荐卡组',
      cards: validCards,
      invalidCards: invalidCards.length > 0 ? invalidCards : [],
      totalCount: validCards.reduce((s, c) => s + c.quantity, 0)
    };
  }

  // ========== Agent 循环 ==========

  /** 搜索元数据（上位卡组、环境信息） */
  async _searchMeta(query) {
    try {
      const resp = await fetch('data/meta.json');
      if (!resp.ok) return '元数据加载失败。';
      const meta = await resp.json();
      const q = (query || '').toLowerCase();

      // 按 query 关键词匹配对应模块
      const lines = [];

      if (!q || q.includes('环境') || q.includes('赛标') || q.includes('标') || q.includes('格式')) {
        lines.push(`## 当前环境\n${meta.description}\n`);
        lines.push('### 各标系列');
        for (const [mark, desc] of Object.entries(meta.markSeries)) {
          lines.push(`- **${mark}标**: ${desc}`);
        }
        lines.push(`\n已退环境: ${meta.retiredMarks.join('/')}标`);
      }

      if (!q || q.includes('上位') || q.includes('卡组') || q.includes('meta') || q.includes('环境')) {
        lines.push('\n## 常见上位卡组');
        for (const deck of meta.topDecks) {
          if (q && q.length > 1 && !deck.name.includes(q) && !deck.type.includes(q) && !deck.core.join(' ').includes(q)) continue;
          lines.push(`### ${deck.name} (${deck.type})`);
          lines.push(`- 核心: ${deck.core.join(' → ')}`);
          lines.push(`- 优势: ${deck.strength}`);
          lines.push(`- 弱点: ${deck.weakness}`);
        }
      }

      if (q.includes('支援者') || q.includes('泛用') || q.includes('物品') || q.includes('道具') || q.includes('竞技场')) {
        for (const [cat, cards] of Object.entries(meta.stapleCards)) {
          const catName = { supporters: '支援者', items: '物品', tools: '宝可梦道具', stadiums: '竞技场' }[cat] || cat;
          const filtered = cards.filter(c => !q || q.length <= 1 || c.name.includes(q) || c.role.includes(q));
          if (filtered.length > 0) {
            lines.push(`\n## ${catName}`);
            filtered.forEach(c => lines.push(`- **${c.name}** (${c.role}): ${c.note}`));
          }
        }
      }

      if (q.includes('ace') || q.includes('ACE')) {
        lines.push(`\n## ACE SPEC\n${meta.aceSpec.description}`);
        lines.push(`当前可用: ${meta.aceSpec.cards.join('、')}`);
      }

      if (q.includes('能量') || q.includes('基本能') || q.includes('水能量') || q.includes('火能量') || q.includes('草能量') || q.includes('雷能量') || q.includes('超能量') || q.includes('斗能量') || q.includes('恶能量') || q.includes('钢能量')) {
        lines.push('\n## 基本能量卡ID');
        for (const c of (meta.basicEnergy?.cards || [])) {
          lines.push(`- **${c.name}**: ${c.ids.join(', ')}`);
        }
        lines.push('\n> 组卡组时使用上述ID，不要编造能量卡ID');
      }

      return lines.length > 0 ? lines.join('\n') : `未找到"${query}"相关的环境数据。可搜索的关键词：上位卡组、环境、ACE SPEC、支援者、物品、泛用卡。`;
    } catch (e) {
      return '元数据搜索失败: ' + e.message;
    }
  }

  /** 清除 DSML：DSML 特征是有 | 管道符，正常卡牌文本不会出现 */
  _stripXml(text) {
    // 切除 DSML 块：从第一个 DSML 标记向前找最近的换行，到最后一个 DSML 标记向后找最近的换行
    let t = text;
    const first = t.search(/\bDSML\b/i);
    if (first >= 0) {
      // 向前找段落的开头（上一个 \n\n 或文本开头）
      const cutStart = Math.max(0, t.lastIndexOf('\n\n', first));
      // 向后找段落的结尾（下一个 \n\n 或文本结尾）
      const last = t.lastIndexOf('DSML');
      const cutEnd = t.indexOf('\n\n', last);
      t = t.slice(0, cutStart) + (cutEnd >= 0 ? t.slice(cutEnd) : '');
    }
    // 清理残留
    return t
      .replace(/<[^>]*>/g, '')
      .split('\n').filter(l => !/\|/.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 发送消息，agent 自主迭代（最多 8 轮）
   */
  async sendMessage(userMessage, onChunk, onComplete, onError) {
    const apiKey = this.apiKeyManager.getApiKey();
    if (!apiKey) { onError(new Error('NO_API_KEY')); return; }

    try {
      // 确保数据已加载
      await this.ensureDataLoaded();

      this._history.push({ role: 'user', content: userMessage });
      this._lastBuiltDeck = null;

      const settings = this.apiKeyManager.getSettings();
      const messages = [
        { role: 'system', content: buildSystemPrompt() }
      ];

      // 注入历史（只保留最近 8 条消息，避免上下文过长）
      const maxHistory = 8;
      const recentHistory = this._history.slice(-maxHistory);
      for (const msg of recentHistory.slice(0, -1)) messages.push(msg);

      // 当前用户消息
      messages.push({ role: 'user', content: userMessage });

      // 如果用户要求保存/覆盖，优先引导调用 build_deck
      const hasSaveIntent = /保存|覆盖|导入|存入|存进去/.test(userMessage);
      if (hasSaveIntent) {
        messages.push({ role: 'system', content: '用户要求保存/覆盖卡组。流程：get_my_decks→get_deck_detail读原卡组→search_cards验证所有卡ID→build_deck保存。不要输出JSON文本，用build_deck工具保存。' });
      }

      // Agent 循环（保存意图时 2轮工具+1轮输出，否则 4+2）
      const MAX_LOOPS = hasSaveIntent ? 5 : 6;
      const finalAt = hasSaveIntent ? 4 : 4;
      let fullText = '';
      let deck = null;
      let builtDeck = null;

      for (let loop = 0; loop < MAX_LOOPS; loop++) {
        const isFinalRound = loop >= finalAt;

        if (isFinalRound) {
          // === 最终轮：追加指令让模型输出纯文本，不再调用工具 ===
          messages.push({ role: 'user', content: '你已经搜索了足够的数据。现在请直接输出分析报告（Markdown格式），不要再调用任何工具。' });

          // 流式输出 + DSML 安全过滤
          const resp = await fetch(CONFIG_AI.apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: settings.model || CONFIG_AI.model, max_tokens: 16384, messages, stream: true })
          });
          if (!resp.ok) { onError(new Error(`API 错误 ${resp.status}`)); return; }

          fullText = '';
          let rawText = '', lastCleanLen = 0;
          const reader = resp.body.getReader(), decoder = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              const d = line.trim(); if (!d.startsWith('data: ')) continue;
              const j = d.slice(6); if (j === '[DONE]') continue;
              try {
                const c = JSON.parse(j)?.choices?.[0]?.delta?.content;
                if (!c) continue;
                rawText += c;
                fullText = this._stripXml(rawText);
                if (onChunk && fullText.length > lastCleanLen) {
                  const add = fullText.slice(lastCleanLen);
                  lastCleanLen = fullText.length;
                  if (add) onChunk(add, fullText);
                }
              } catch (e) { /* */ }
            }
          }
          break;
        }

        // === 工具调用轮：非流式（content 和 tool_calls 天然分离，无 DSML 泄漏）===
        const resp = await fetch(CONFIG_AI.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: settings.model || CONFIG_AI.model, max_tokens: 8192, messages, tools: this._getTools(), tool_choice: 'auto' })
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          const errMap = { 401: 'API Key 无效或已过期', 429: '请求频率过高，请稍后再试', 402: '账户余额不足' };
          onError(new Error(errMap[resp.status] || `API 错误 ${resp.status}: ${errText}`)); return;
        }

        const data = await resp.json();
        const msg = data.choices?.[0]?.message;
        if (!msg) break;

        const toolCalls = msg.tool_calls || [];
        if (toolCalls.length === 0) { fullText = msg.content || ''; break; }

        console.log(`[AI Agent] Loop ${loop + 1}: ${toolCalls.length} tool calls`);
        messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

        for (const tc of toolCalls) {
          const result = await this._executeTool(tc.function);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }

        // 第1轮后提示收尾
        if (loop === 0) {
          if (hasSaveIntent) {
            messages.push({ role: 'user', content: '已看到卡组内容。请确认所有卡牌ID已验证，然后调用 build_deck 保存。' });
          } else {
            messages.push({ role: 'user', content: '已经搜索了足够的数据。请直接输出分析报告，不要再调用工具。' });
          }
        }
      }

      console.log(`[AI Agent] Final response: ${fullText.length} chars`);

      // 解析卡组 JSON
      deck = this.parseDeckFromResponse(fullText);

      // 兜底：保存意图 + AI 没调 build_deck + 能解析出卡组 → 自动保存
      if (hasSaveIntent && !this._lastBuiltDeck && deck && deck.cards.length > 2) {
        const saveResult = this._buildDeckFromAI(deck.name, JSON.stringify({ name: deck.name, cards: deck.cards.map(c => ({ id: c.id, quantity: c.quantity })) }), 0);
        console.log('[AI Agent] Auto-saved deck:', deck.cards.length, 'cards');
        // 追加到回复末尾
        fullText += '\n\n' + saveResult;
        this._lastBuiltDeck = { name: deck.name, cards: [...deck.cards], totalCount: deck.totalCount };
      }

      // 保存到历史
      this._history.push({ role: 'assistant', content: fullText });
      this._saveHistory();

      if (onComplete) onComplete(fullText, deck || this._lastBuiltDeck);

    } catch (error) {
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        onError(new Error('网络连接失败，请检查网络后重试。'));
      } else {
        onError(error);
      }
    }
  }
}
