/**
 * 搜索意图解析：把自然语言查询翻译成 CardQueryEngine 的结构化条件。
 *
 * 设计原则（很重要）：
 *   - LLM 只负责「翻译」，不负责判断；筛选由 CardQueryEngine 做**确定性**执行
 *   - **绝不信任模型输出**：返回值逐字段白名单校验，未知字段丢弃、越界值丢弃
 *   - 任何失败（无 API Key / 网络错 / JSON 不合法）都返回 null，由调用方回退到普通关键词搜索
 *
 * 减费口径与引擎保持一致（用户确认）：
 *   1. 动态减费按理论上限算
 *   2. 只算宝可梦自身特性的减费
 *   3. 「N能」只管数量不管属性（需要属性时会明说，如「1火能」）
 */

import { CONFIG_AI } from '../utils/constants.js';
import { CARD_TYPES, ATTR_CN } from '../core/CardQueryEngine.js';

const STAGE_LABEL = '0=基础, 1=1阶进化, 2=2阶进化';
const ATTR_LABEL = Object.values(ATTR_CN).join('/');
const OPS = ['=', '!=', '<', '<=', '>', '>='];

const SYSTEM_PROMPT = `你是一个查询条件翻译器。把用户的卡牌查询翻译成 JSON。只输出 JSON，不要解释。

可用字段（全部可选，没提到就不要出现）：
- types: 卡牌类型数组，取值只能来自 [${CARD_TYPES.join(', ')}]
- stage: 进化阶段，${STAGE_LABEL}
- retreat: {"op":"=/<=/>=/</>", "value":数字}  撤退能量
- hp: {"op":"=/<=/>=/</>", "value":数字}       HP
- attr: 属性，取值只能来自 [${ATTR_LABEL}]
- env: true 表示「仅当前标准环境（合法标记）」
- attackCostExactly: 数字。含义是「该宝可梦至少有一个招式，在把该宝可梦自身特性的减费算到理论上限后，所需能量数**恰好**等于这个数字」
- attackCostAtMost: 数字。同上，但表示「≤这个数字」
- keyword: 名称子串（**只有在用户明确要按卡名找时才用**）
- abilityName: 特性名字符串或数组（数组 = 任一命中），用于「特性名是/含…」
- abilityText: 特性**效果文本内容**字符串或数组（数组 = 任一命中）。
  例：「有附着雷能量特性的宝可梦」→ {"types":["宝可梦"], "abilityText":["雷能量"]}
  「特性是转附基本能量的宝可梦」→ {"types":["宝可梦"], "abilityText":["转附"]} 或 ["基本能量"]
- attackText: 招式**效果文本内容**字符串或数组（数组 = 任一命中）
- textAny: 特性+招式文本任意位置字符串或数组（数组 = 任一命中），不确定在特性还是招式时用

规则：
1. 「N能」「需要N个能量」一律用 attackCostExactly: N。只有当用户说「N能以下」「N能以内」「不超过N能」时才用 attackCostAtMost: N。
2. 能量数量**只看个数，不看属性**：用户说「1能」时，火/水/恶等任意 1 个能量都算。
   只有用户明确说属性时（如「1火能」「至少1个火能量」）才不要用 energy 类字段——
   目前不支持按属性筛招式消耗，这种情况请只保留其他条件。
3. 提到「环境内」「标准环境」「合法」时加 env: true。
4. 提到宝可梦的进化阶段用 stage；提到「宝可梦」时加 types: ["宝可梦"]。
5. 撤退能量相关用 retreat。HP 相关用 hp。
6. **描述「效果/特性内容是…」时必须用 abilityText / attackText / textAny，不要退化成 keyword 或 attr**。
   keyword 只匹配卡名；attr 只匹配宝可梦属性。
7. 不要臆造字段。无法翻译的部分忽略。`;

/** 逐字段白名单校验：模型返回任何越界内容都会被丢弃 */
export function sanitizeConditions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  if (Array.isArray(raw.types)) {
    const t = raw.types.filter(x => CARD_TYPES.includes(String(x)));
    if (t.length) out.types = t;
  }

  const stage = Number(raw.stage);
  if (Number.isInteger(stage) && stage >= 0 && stage <= 2) out.stage = stage;

  const attrValues = Object.values(ATTR_CN);
  if (attrValues.includes(String(raw.attr))) out.attr = String(raw.attr);

  if (raw.env === true) out.env = true;

  for (const key of ['retreat', 'hp']) {
    const c = raw[key];
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const op = OPS.includes(String(c.op)) ? String(c.op) : '=';
      const value = Number(c.value);
      if (Number.isFinite(value) && value >= 0 && value <= 500) out[key] = { op, value };
    } else if (Number.isFinite(Number(c)) && c !== null && c !== undefined && c !== '') {
      out[key] = { op: '=', value: Number(c) };
    }
  }

  for (const key of ['attackCostExactly', 'attackCostAtMost']) {
    const v = Number(raw[key]);
    if (Number.isInteger(v) && v >= 0 && v <= 10) out[key] = v;
  }

  // 效果/特性文本类条件：只接受字符串或字符串数组，逐项去空/限长
  for (const key of ['abilityName', 'abilityText', 'attackText', 'textAny']) {
    const v = raw[key];
    const list = (Array.isArray(v) ? v : [v])
      .filter(x => typeof x === 'string')
      .map(x => x.trim().slice(0, 24))
      .filter(Boolean)
      .slice(0, 6);
    if (list.length) out[key] = list.length === 1 ? list[0] : list;
  }

  if (typeof raw.keyword === 'string') {
    const k = raw.keyword.trim().slice(0, 40);
    if (k) out.keyword = k;
  }

  return out;
}

/** 从可能带 Markdown 代码块/前后缀的文本里抠出 JSON 对象 */
export function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

export class SearchIntentParser {
  constructor(apiKeyManager) {
    this.apiKeyManager = apiKeyManager;
  }

  hasApiKey() {
    try {
      return !!this.apiKeyManager?.getApiKey?.();
    } catch (e) {
      return false;
    }
  }

  /**
   * @returns {Promise<{conditions: object, raw: string}|null>} 失败返回 null（调用方回退关键词搜索）
   */
  async parse(text) {
    const query = String(text || '').trim();
    if (!query) return null;
    const apiKey = this.apiKeyManager?.getApiKey?.();
    if (!apiKey) return null;

    let settings = {};
    try { settings = this.apiKeyManager.getSettings?.() || {}; } catch (e) { settings = {}; }
    const endpoint = settings.apiEndpoint || CONFIG_AI.apiEndpoint;
    const model = settings.model || CONFIG_AI.model;

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 512,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query },
          ],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      const json = extractJson(content);
      if (!json) return null;
      const conditions = sanitizeConditions(json);
      if (!Object.keys(conditions).length) return null;
      return { conditions, raw: String(content || '') };
    } catch (e) {
      return null;
    }
  }
}
