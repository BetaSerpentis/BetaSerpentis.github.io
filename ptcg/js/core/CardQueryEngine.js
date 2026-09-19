/**
 * 结构化卡牌查询引擎。
 *
 * 定位：把「自然语言 → 结构化条件」之后的**确定性筛选**放在这里。
 * 不依赖任何模型判断，结果可复现、可解释。AI 只负责把用户的话翻译成下面的条件对象。
 *
 * 数据来源（全部是构建期产物）：
 *   <type>.idx.tsv    卡号 / 名字 / 属性 / 图鉴号
 *   <type>.filter.tsv hp stage attr retreat flags costs dmg  —— costs 是**逐招式**逗号分隔的消耗串（如 "R,RR"）
 *   <type>.detail.tsv 第 9 列是**环境标记**（如 H）
 *   effects.tsv       card_key scope slot seq action params_json —— 用于读减费效果
 *   abilities.tsv     卡号 / 套装 / 序号 / 顺序 / 特性名 / 特性文本 —— 特性内容检索
 *   attacks.tsv       卡号 / 套装 / 序号 / 顺序 / 招式名 / 消耗 / 伤害 / 招式文本 —— 招式内容检索
 *   meta.json         currentMarks / retiredMarks（环境合法性以它为准）
 *
 * 排序：默认按卡库加载顺序（idx.tsv，与卡牌库列表一致），可选 sort='id' / 'dex'。
 *
 * 减费折算口径（与用户确认）：
 *   1. 动态减费量按**理论上限**算（如「对手备战数量」→ 最多 5）
 *   2. 只算该宝可梦**自身特性**的减费；道具/训练家等需要额外前提的不算（结果才不依赖卡组构成）
 *   3. 减费只作用于【无】色需求（现有数据里的减费全是 colorless）
 *   => 招式最小可达能量数 = 该招式符号总数 - min(无色符号数, 减费上限)
 */

export const CARD_TYPES = ['宝可梦', '支援者', '物品', '宝可梦道具', '竞技场', '基本能量', '特殊能量'];

export const TYPE_SLUG = {
  宝可梦: 'pokemon',
  支援者: 'supporter',
  物品: 'item',
  宝可梦道具: 'pokemon-tool',
  竞技场: 'stadium',
  基本能量: 'basic-energy',
  特殊能量: 'special-energy',
};

/** 进化阶段：filter.tsv 的数字 → 中文 */
export const STAGE_CN = { 0: '基础', 1: '1阶进化', 2: '2阶进化' };

/** 属性代码 → 中文（与 build-cn-data.py 的 ATTR_CODES 一致） */
export const ATTR_CN = {
  G: '草', R: '火', W: '水', L: '雷', P: '超', F: '斗',
  D: '恶', M: '钢', Y: '妖', N: '龙', C: '无',
};

/**
 * 动态减费量的「理论可达上限」。
 * - opponent_bench_count：对手最多 5 只备战
 * - opponent_field_rule_count：对手场上带规则的宝可梦，最多 1 出战 + 5 备战 = 6
 * - opponent_prizes_taken：对手已获得奖赏卡数；拿满 6 张即结束，故最多按 5 计
 */
export const REDUCTION_CAP = {
  opponent_bench_count: 5,
  opponent_field_rule_count: 6,
  opponent_prizes_taken: 5,
};

function splitTsvLine(line) {
  return line.split('\t').map(v => v.replace(/\\([\\trn])/g, (_, ch) => (ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === 'n' ? '\n' : '\\')));
}

function toKeywordList(v) {
  if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  return s ? [s] : [];
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class CardQueryEngine {
  /**
   * @param {{loadText?: (url:string)=>Promise<string>, basePath?: string}} options
   *   loadText 可注入（node 测试里传 fs 版本，浏览器里默认用 fetch）
   */
  constructor({ loadText, basePath = 'data_fast/' } = {}) {
    this.basePath = basePath;
    this.loadText = loadText || (async url => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`加载失败: ${url}`);
      return r.text();
    });
    this.cards = new Map();     // id -> card
    this.loadSeq = 0;           // 卡库加载顺序（与 idx.tsv 一致，用于默认排序）
    this.effects = new Map();   // id -> [{scope, slot, seq, action, params}]
    this.envMarks = [];         // 标准环境标记（来自 meta.json）
    this.retiredMarks = [];
    this.loaded = false;
  }

  async _rows(file) {
    const text = await this.loadText(this.basePath + file);
    const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l && !l.startsWith('#'));
    return lines.map(splitTsvLine);
  }

  async load() {
    if (this.loaded) return this;

    // 环境标记以 meta.json 为准
    try {
      const meta = JSON.parse(await this.loadText(this.basePath.replace(/data_fast\/$/, '') + 'data/meta.json'));
      this.envMarks = Array.isArray(meta.currentMarks) ? meta.currentMarks : [];
      this.retiredMarks = Array.isArray(meta.retiredMarks) ? meta.retiredMarks : [];
    } catch (e) {
      this.envMarks = [];
      this.retiredMarks = [];
    }

    for (const cnType of CARD_TYPES) {
      const slug = TYPE_SLUG[cnType];
      const [idx, filter, detail] = await Promise.all([
        this._rows(`${slug}.idx.tsv`),
        this._rows(`${slug}.filter.tsv`),
        this._rows(`${slug}.detail.tsv`).catch(() => []),
      ]);

      const filterMap = new Map(filter.map(r => [r[0], r]));
      const detailMap = new Map(detail.map(r => [r[0], r]));

      for (const r of idx) {
        const id = r[0];
        if (!id) continue;
        const loadIndex = this.loadSeq++;
        const f = filterMap.get(id) || [];
        const d = detailMap.get(id) || [];
        this.cards.set(id, {
          id,
          loadIndex,
          name: r[1] || '',
          type: cnType,
          typeSlug: slug,
          dexNumber: toNum(r[2]),
          attribute: ATTR_CN[r[3]] || r[3] || '',
          hp: toNum(f[1]),
          stage: toNum(f[2]),
          stageName: STAGE_CN[toNum(f[2])] || '',
          attr: ATTR_CN[f[3]] || f[3] || '',
          retreat: toNum(f[4]),
          costs: f[6] || '',
          damage: f[7] || '',
          mark: (d[9] || '').trim().toUpperCase(),
          evolvesFrom: d[2] || '',
        });
      }
    }

    // effects.tsv：card_key scope slot seq action params
    for (const r of await this._rows('effects.tsv')) {
      if (!r[0]) continue;
      let params = {};
      try { params = r[5] ? JSON.parse(r[5]) : {}; } catch (e) { params = {}; }
      const list = this.effects.get(r[0]) || [];
      list.push({ scope: r[1], slot: r[2], seq: toNum(r[3]) || 0, action: r[4], params });
      this.effects.set(r[0], list);
    }

    // 特性 / 招式文本（用于「特性内容是…」「招式效果含…」这类检索；缺文件则跳过）
    try {
      for (const r of await this._rows('abilities.tsv')) {
        const card = this.cards.get(r[0]);
        if (!card) continue;
        card.abilityNames = card.abilityNames || [];
        card.abilityTexts = card.abilityTexts || [];
        if (r[4]) card.abilityNames.push(r[4]);
        if (r[5]) card.abilityTexts.push(r[5]);
      }
    } catch (e) { /* abilities.tsv 不存在时忽略 */ }
    try {
      for (const r of await this._rows('attacks.tsv')) {
        const card = this.cards.get(r[0]);
        if (!card) continue;
        card.attackNames = card.attackNames || [];
        card.attackTexts = card.attackTexts || [];
        if (r[4]) card.attackNames.push(r[4]);
        if (r[7]) card.attackTexts.push(r[7]);
      }
    } catch (e) { /* attacks.tsv 不存在时忽略 */ }

    this.loaded = true;
    return this;
  }

  /** 文本归一化：去括号/标点/空白，使「雷能量」能命中「【雷】能量」 */
  _normText(s) {
    return String(s ?? '')
      .replace(/[【】\[\]（）()「」『』〈〉《》]/g, '')
      .replace(/[\s，,。.、·:：;；!！?？"'‘’“”]/g, '')
      .toLowerCase();
  }

  /**
   * 「填能」动作词：附着 / 转附 / 改附 / 充能 / 填充 / 贴上 / 加速
   * 注意：归一化后文本里，"附着于"→"附于"，"转附"保持
   */
  static ATTACH_VERB_RE = /(附着|附于|转附|改附|充能|填充|贴上|加速)/;

  /**
   * 判断（归一化后的）文本是否表达「给宝可梦填 X 能量」：
   *  - 必须同时出现「填能动作词」与「能量对象」
   *  - 能量对象允许泛化：查询「雷能量」时，"基本能量"、"能量"（未限定属性）也算命中
   *    （因为雷能量 ⊂ 基本能量 ⊂ 能量）；但明确写了其它属性（如"火能量"）不算
   */
  _matchesEnergyAttach(hay, energyType = null) {
    if (!hay || !hay.includes('能量')) return false;
    if (!CardQueryEngine.ATTACH_VERB_RE.test(hay)) return false;
    // 目标必须是「自方宝可梦」：排除「选择附着于对手宝可梦身上的能量，放回/丢弃」这类反向操作
    const toSelf = /自己的宝可梦|自己场上的|这只宝可梦/.test(hay);
    if (/对手/.test(hay) && !toSelf) return false;
    if (!energyType) return true;
    const t = this._normText(energyType);
    if (!t) return true;
    if (hay.includes(`${t}能量`)) return true;           // 直接命中该属性
    if (hay.includes('基本能量')) return true;            // 泛化为基本能量
    const others = Object.values(ATTR_CN).filter(x => x !== energyType);
    if (others.some(x => hay.includes(`${this._normText(x)}能量`))) return false; // 明确了其它属性
    return true;                                          // 只提"能量"（未限定属性）→ 泛化命中
  }

  /** 卡片的效果文本池（特性 + 招式） */
  _effectTextPool(card, scope = 'any') {
    const parts = [];
    if (scope === 'ability' || scope === 'any') parts.push(...(card.abilityTexts || []));
    if (scope === 'attack' || scope === 'any') parts.push(...(card.attackTexts || []));
    return this._normText(parts.join('\n'));
  }

  /** 该卡自身特性提供的【无】色减费上限（动态量按理论上限） */
  colorlessReductionCap(cardId) {
    const list = this.effects.get(cardId) || [];
    let cap = 0;
    for (const e of list) {
      if (e.action !== 'attack_cost_reduction') continue;
      if (e.scope !== 'ability') continue;                       // 只算自身特性
      const type = String(e.params.type || 'colorless');
      if (type !== 'colorless') continue;                        // 现有数据全是无色
      const amount = e.params.amount;
      if (typeof amount === 'number') { cap += amount; continue; }
      const s = String(amount ?? '');
      if (Object.prototype.hasOwnProperty.call(REDUCTION_CAP, s)) { cap += REDUCTION_CAP[s]; continue; }
      const n = Number(s);
      if (Number.isFinite(n)) cap += n;
    }
    return cap;
  }

  /**
   * 每个招式在「理论上限」下的最小可达能量数。
   * 「没提属性 = 任意能量」→ 这里只算数量，不管属性。
   * @returns {number[]} 与 costs 的招式顺序一致
   */
  minimalAttackCosts(cardOrId) {
    const card = typeof cardOrId === 'string' ? this.cards.get(cardOrId) : cardOrId;
    if (!card) return [];
    const cap = this.colorlessReductionCap(card.id);
    const parts = String(card.costs || '').split(',').map(s => s.trim()).filter(Boolean);
    return parts.map(cost => {
      const symbols = cost.replace(/[^A-Za-z]/g, '').split('');
      const total = symbols.length;
      if (!total) return 0;
      const colorless = symbols.filter(s => s.toUpperCase() === 'C').length;
      return total - Math.min(colorless, cap);
    });
  }

  _cmp(actual, op, value) {
    if (actual === null || actual === undefined) return false;
    switch (op) {
      case '=': case '==': return actual === value;
      case '!=': return actual !== value;
      case '<': return actual < value;
      case '<=': return actual <= value;
      case '>': return actual > value;
      case '>=': return actual >= value;
      default: return false;
    }
  }

  _numCond(cond, actual) {
    if (cond === null || cond === undefined) return true;
    if (typeof cond === 'number') return actual === cond;
    if (typeof cond === 'object') return this._cmp(actual, cond.op || '=', Number(cond.value));
    return true;
  }

  /**
   * 结构化筛选。所有条件都是可选的，未给即不限制。
   * @param {{
   *   types?: string[],            卡牌类型（中文，如 ['宝可梦']）
   *   stage?: number|object,       进化阶段：0基础 / 1一阶 / 2二阶
   *   retreat?: number|object,     撤退能量
   *   hp?: number|object,          HP
   *   attr?: string,               属性（中文）
   *   marks?: string[],            指定环境标记
   *   env?: boolean,               true = 仅当前标准环境（meta.json 的 currentMarks）
   *   attackCostExactly?: number,  至少有一个招式「折算后恰好 N 能」
   *   attackCostAtMost?: number,   至少有一个招式「折算后 ≤ N 能」
   *   keyword?: string,            名称子串（仅卡名）
   *   abilityName?: string|string[], 特性名子串（数组 = 任一命中）
   *   abilityText?: string|string[], 特性效果文本子串（数组 = 任一命中）
   *   attackText?: string|string[],  招式效果文本子串（数组 = 任一命中）
   *   textAny?: string|string[],     特性+招式文本子串（数组 = 任一命中）
   *   energyAttach?: boolean,         「填能」语义：动作词（附着/转附/充能…）+ 能量对象
   *   energyType?: string,            填能属性（如 '雷'）；省略 = 任意能量
   *   energyIn?: 'ability'|'attack'|'any', 填能语义的检索范围（默认 any）
   *   sort?: 'load'|'id'|'dex',       排序：load=卡库顺序（默认）/ id / 图鉴号
   *   limit?: number,
   * }} conds
   */
  query(conds = {}) {
    const {
      types, stage, retreat, hp, attr, marks, env,
      attackCostExactly, attackCostAtMost, keyword, limit,
      abilityName, abilityText, attackText, textAny,
      energyAttach, energyType, energyIn, sort,
    } = conds;

    const typeSet = types && types.length ? new Set(types) : null;
    const markSet = marks && marks.length ? new Set(marks.map(m => String(m).toUpperCase())) : null;
    const envSet = env ? new Set(this.envMarks.map(m => String(m).toUpperCase())) : null;
    const kw = keyword ? String(keyword).toLowerCase() : null;

    const out = [];
    for (const card of this.cards.values()) {
      if (typeSet && !typeSet.has(card.type)) continue;
      if (!this._numCond(stage, card.stage)) continue;
      if (!this._numCond(retreat, card.retreat)) continue;
      if (!this._numCond(hp, card.hp)) continue;
      if (attr && card.attr !== attr && card.attribute !== attr) continue;
      if (markSet && !markSet.has(card.mark)) continue;
      if (envSet && !envSet.has(card.mark)) continue;
      if (kw && !card.name.toLowerCase().includes(kw)) continue;

      // 效果/特性文本检索（归一化后子串匹配；数组语义 = 任一命中）
      if (abilityName) {
        const hay = this._normText((card.abilityNames || []).join('\n'));
        if (!toKeywordList(abilityName).map(k => this._normText(k)).some(k => k && hay.includes(k))) continue;
      }
      if (abilityText) {
        const hay = this._effectTextPool(card, 'ability');
        if (!toKeywordList(abilityText).map(k => this._normText(k)).some(k => k && hay.includes(k))) continue;
      }
      if (attackText) {
        const hay = this._effectTextPool(card, 'attack');
        if (!toKeywordList(attackText).map(k => this._normText(k)).some(k => k && hay.includes(k))) continue;
      }
      if (textAny) {
        const hay = this._effectTextPool(card, 'any');
        if (!toKeywordList(textAny).map(k => this._normText(k)).some(k => k && hay.includes(k))) continue;
      }
      if (energyAttach) {
        const scope = energyIn === 'ability' ? 'ability' : energyIn === 'attack' ? 'attack' : 'any';
        if (!this._matchesEnergyAttach(this._effectTextPool(card, scope), energyType || null)) continue;
      }

      let minCosts = null;
      if (attackCostExactly !== undefined && attackCostExactly !== null) {
        minCosts = this.minimalAttackCosts(card);
        if (!minCosts.some(c => c === attackCostExactly)) continue;
      }
      if (attackCostAtMost !== undefined && attackCostAtMost !== null) {
        if (!minCosts) minCosts = this.minimalAttackCosts(card);
        if (!minCosts.some(c => c <= attackCostAtMost)) continue;
      }

      out.push(minCosts ? { ...card, minCosts } : card);
    }

    // 默认按卡库加载顺序（与卡牌库列表一致）；可选 id / 图鉴号
    // 统一的 id 比较（纯码点序，避免 localeCompare 在不同环境下的差异）
    const cmpId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    if (sort === 'id') out.sort(cmpId);
    else if (sort === 'dex') out.sort((a, b) => (toNum(a.dexNumber) ?? 99999) - (toNum(b.dexNumber) ?? 99999) || cmpId(a, b));
    else out.sort((a, b) => (a.loadIndex ?? 0) - (b.loadIndex ?? 0));
    return limit ? out.slice(0, limit) : out;
  }
}
