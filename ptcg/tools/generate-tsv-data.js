const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'data_fast');

const CARD_SOURCES = [
  { type: '宝可梦', slug: 'pokemon', file: 'pokemon-cards.json', nameField: '宝可梦名字' },
  { type: '支援者', slug: 'supporter', file: 'Supporter-cards.json', nameField: '卡牌名字' },
  { type: '物品', slug: 'item', file: 'Item-cards.json', nameField: '卡牌名字' },
  { type: '宝可梦道具', slug: 'pokemon-tool', file: 'PokemonTool-cards.json', nameField: '卡牌名字' },
  { type: '竞技场', slug: 'stadium', file: 'Stadium-cards.json', nameField: '卡牌名字' },
  { type: '基本能量', slug: 'basic-energy', file: 'BasicEnergy-cards.json', nameField: '卡牌名字' },
  { type: '特殊能量', slug: 'special-energy', file: 'SpecialEnergy-cards.json', nameField: '卡牌名字' }
];

const ATTR_CODES = {
  '草': 'G',
  '火': 'R',
  '水': 'W',
  '雷': 'L',
  '超': 'P',
  '斗': 'F',
  '恶': 'D',
  '钢': 'M',
  '妖': 'Y',
  '龙': 'N',
  '无': 'C'
};

const STAGE_CODES = {
  '基础': '0',
  '1阶进化': '1',
  '一阶进化': '1',
  '2阶进化': '2',
  '二阶进化': '2',
  'V进化': '1',
  'VMAX': '2',
  'VSTAR': '2'
};

const ENERGY_CODES = {
  '草': 'G',
  '火': 'R',
  '水': 'W',
  '雷': 'L',
  '超': 'P',
  '斗': 'F',
  '恶': 'D',
  '钢': 'M',
  '妖': 'Y',
  '龙': 'N',
  '无': 'C'
};

const FLAG_RULES = [
  { bit: 0, patterns: ['__HAS_ABILITY__'] },
  { bit: 1, patterns: ['抽', '抽出'] },
  { bit: 2, patterns: ['选择', '加入手牌', '搜索', '牌库选择', '从自己的牌库'] },
  { bit: 3, patterns: ['恢复', '回复', 'HP', '治疗'] },
  { bit: 4, patterns: ['中毒', '灼伤', '麻痹', '睡眠', '混乱', '异常状态'] },
  { bit: 5, patterns: ['附于', '附上', '能量加速', '基本能量卡附'] },
  { bit: 6, patterns: ['交换', '换位', '替换', '退回备战区'] },
  { bit: 7, patterns: ['丢弃能量', '弃能', '将.*能量.*丢到弃牌区'] },
  { bit: 8, patterns: ['从弃牌区', '回到手牌', '返回手牌', '回收'] },
  { bit: 9, patterns: ['伤害指示物', '放置.*指示物'] },
  { bit: 10, patterns: ['不受伤害', '防止', '减少.*伤害'] },
  { bit: 11, patterns: ['不能撤退', '无法撤退'] },
  { bit: 12, patterns: ['对自己', '自己的.*受到.*伤害'] },
  { bit: 13, patterns: ['投币', '硬币', '正面', '反面'] },
  { bit: 14, patterns: ['ACE SPEC', 'ACE', '王牌'] },
  { bit: 15, patterns: ['宝可梦道具', '道具'] },
  { bit: 16, patterns: ['竞技场'] },
  { bit: 17, patterns: ['弃牌', '丢到弃牌区'] },
  { bit: 18, patterns: ['放逐区'] },
  { bit: 19, patterns: ['特性'] }
];

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'));
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function tsvEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function row(values) {
  return values.map(tsvEscape).join('\t');
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s+/g, '').trim();
}

function compactSearchText(parts) {
  return parts
    .filter(part => part !== undefined && part !== null && String(part).trim() !== '')
    .map(part => typeof part === 'object' ? JSON.stringify(part) : String(part))
    .join(' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[，。；：！？、（）【】《》「」『』“”'".,;:!?()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hash16(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function getSkill(card, index) {
  return card[`技能${index}`] || {};
}

function getSkillCosts(card) {
  const costs = [];
  for (let i = 1; i <= 4; i += 1) {
    const skill = getSkill(card, i);
    if (!skill || Object.keys(skill).length === 0) continue;
    const rawCost = Array.isArray(skill['消耗']) ? skill['消耗'] : (skill['消耗'] ? [skill['消耗']] : []);
    costs.push(rawCost.map(item => ENERGY_CODES[item] || item || '').join(''));
  }
  return costs.join(',');
}

function getSkillDamage(card) {
  const damage = [];
  for (let i = 1; i <= 4; i += 1) {
    const skill = getSkill(card, i);
    if (!skill || Object.keys(skill).length === 0) continue;
    damage.push(skill['伤害'] || '');
  }
  return damage.join(',');
}

function getEffectCorpus(card, cardType) {
  const parts = [];
  if (cardType === '宝可梦') {
    parts.push(card['特性名字'], card['特性效果']);
    for (let i = 1; i <= 4; i += 1) {
      const skill = getSkill(card, i);
      parts.push(skill['名字'], skill['伤害'], skill['效果']);
      if (Array.isArray(skill['消耗'])) parts.push(skill['消耗'].join(' '));
    }
  } else {
    parts.push(card['效果'], card['卡牌类型']);
  }
  return parts.filter(Boolean).join(' ');
}

function buildEquivalenceSource(card, cardType, name) {
  const parts = [cardType, name];
  if (cardType === '宝可梦') {
    parts.push(card['特性名字'] || '');
    parts.push(card['特性效果'] || '');
    for (let i = 1; i <= 4; i += 1) {
      const skill = getSkill(card, i);
      parts.push(skill['名字'] || '');
      parts.push(Array.isArray(skill['消耗']) ? skill['消耗'].join(',') : (skill['消耗'] || ''));
      parts.push(skill['伤害'] || '');
      parts.push(skill['效果'] || '');
    }
  } else {
    parts.push(card['效果'] || '');
  }
  return parts.map(normalizeText).join('|');
}

function buildSearchText(card, cardType, name) {
  const parts = [name, card['卡牌类型'], card['卡牌版本'], card['编号'], card['属性'], card['HP'], card['进化阶段'], card['规则'], card['规则2']];
  if (cardType === '宝可梦') {
    parts.push(card['特性名字'], card['特性效果']);
    for (let i = 1; i <= 4; i += 1) {
      const skill = getSkill(card, i);
      parts.push(skill['名字'], Array.isArray(skill['消耗']) ? skill['消耗'].join(' ') : skill['消耗'], skill['伤害'], skill['效果']);
    }
  } else {
    parts.push(card['效果']);
  }
  return compactSearchText(parts);
}

function patternMatches(text, pattern) {
  if (pattern.includes('.*')) {
    return new RegExp(pattern).test(text);
  }
  return text.includes(pattern);
}

function buildFlags(card, cardType) {
  let flags = 0;
  const corpus = getEffectCorpus(card, cardType);
  const withMarkers = `${corpus} ${card['特性名字'] || card['特性效果'] ? '__HAS_ABILITY__' : ''}`;

  for (const rule of FLAG_RULES) {
    if (rule.patterns.some(pattern => patternMatches(withMarkers, pattern))) {
      flags |= (1 << rule.bit);
    }
  }
  return flags.toString(16);
}

function buildFilterValues(card, cardType) {
  const hp = cardType === '宝可梦' ? (card['HP'] || '') : '';
  const stage = cardType === '宝可梦' ? (STAGE_CODES[card['进化阶段']] ?? '') : '';
  const attr = cardType === '宝可梦' ? (ATTR_CODES[card['属性']] || card['属性'] || '') : '';
  const retreat = cardType === '宝可梦' ? (card['撤退'] ?? '') : '';
  const flags = buildFlags(card, cardType);
  const costs = cardType === '宝可梦' ? getSkillCosts(card) : '';
  const dmg = cardType === '宝可梦' ? getSkillDamage(card) : '';
  return { hp, stage, attr, retreat, flags, costs, dmg };
}

function writeCardType(source) {
  const json = readJson(source.file);
  const idxRows = ['#idx1'];
  const searchRows = ['#srch1'];
  const filterRows = ['#flt1'];
  let cardCount = 0;

  for (const rawCard of json) {
    const ids = Array.isArray(rawCard['卡牌ID']) ? rawCard['卡牌ID'] : [];
    if (ids.length === 0) continue;

    const name = rawCard[source.nameField] || rawCard['卡牌名字'] || rawCard['宝可梦名字'] || '未知';
    const no = source.type === '宝可梦' ? (rawCard['编号'] || '') : '';
    const attr = source.type === '宝可梦' ? (ATTR_CODES[rawCard['属性']] || rawCard['属性'] || '') : '';
    const quantity = parseInt(rawCard['拥有数量'], 10) || 0;
    const eq = hash16(buildEquivalenceSource(rawCard, source.type, name));
    const searchText = buildSearchText(rawCard, source.type, name);
    const filter = buildFilterValues(rawCard, source.type);

    for (const id of ids) {
      if (!id) continue;
      idxRows.push(row([id, name, no, attr, quantity, eq]));
      searchRows.push(row([id, searchText]));
      filterRows.push(row([id, filter.hp, filter.stage, filter.attr, filter.retreat, filter.flags, filter.costs, filter.dmg]));
      cardCount += 1;
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, `${source.slug}.idx.tsv`), `${idxRows.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `${source.slug}.search.tsv`), `${searchRows.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `${source.slug}.filter.tsv`), `${filterRows.join('\n')}\n`, 'utf8');

  return { type: source.type, slug: source.slug, cards: cardCount };
}

function main() {
  ensureOutDir();
  const results = CARD_SOURCES.map(writeCardType);
  console.table(results);
}

main();
