// ptcg/js/services/AIAnalysisService.js
// AI 分析引擎：协同检测、评分、证据生成

import { AICardDataService } from './AICardDataService.js';

export class AIAnalysisService {
  /** @param {AICardDataService} dataService */
  constructor(dataService) {
    this.data = dataService;
  }

  // ========== 战略属性提取 ==========

  _getStrategicProps(jsonData) {
    const prizes = (jsonData['规则'] || '').includes('ex') || (jsonData['规则'] || '').includes('V') ? 2 : 1;
    const stageMap = { '基础': '基础', '1阶进化': '1阶', '一阶进化': '1阶', '2阶进化': '2阶', '二阶进化': '2阶' };
    const stage = stageMap[jsonData['进化阶段']] || '基础';

    // 检测缩放机制
    let scaling = '固定';
    const allText = this._collectEffects(jsonData);
    if (allText.includes('伤害指示物') && /[×xX*]|每有|数量|增加/.test(allText)) scaling = '伤指物缩放';
    else if (allText.includes('能量') && /[×xX*]|每有/.test(allText)) scaling = '能量缩放';

    // 检测最大能量需求
    let maxEnergy = 0;
    for (let i = 1; i <= 4; i++) {
      const s = jsonData[`技能${i}`];
      if (s && Array.isArray(s['消耗'])) {
        const cnt = s['消耗'].filter(c => c !== '无').length;
        if (cnt > maxEnergy) maxEnergy = cnt;
      }
    }

    return { prizes, stage, scaling, maxEnergy };
  }

  _collectEffects(jsonData) {
    const parts = [];
    if (jsonData['特性效果']) parts.push(jsonData['特性效果']);
    if (jsonData['效果']) parts.push(jsonData['效果']);
    for (let i = 1; i <= 4; i++) {
      const s = jsonData[`技能${i}`];
      if (s && s['效果'] && s['效果'] !== '无') parts.push(s['效果']);
      if (s && s['名字']) parts.push(s['名字']);
    }
    return parts.join(' ');
  }

  // ========== 协同分析 ==========

  /**
   * 深度分析：给定目标卡，搜索所有潜在的协同卡并打分排序
   * @returns {string} 格式化的分析报告
   */
  async deepAnalysis(cardName) {
    if (!cardName) return '请提供卡牌名称';

    // 1. 搜索目标卡
    const searchResult = this.data.searchCards(cardName, null, 3);
    if (searchResult.results.length === 0) return `未找到"${cardName}"。请检查卡名拼写。`;

    const targetId = searchResult.results[0].id;
    const targetData = await this.data.getFullCardData(targetId);
    if (!targetData) return `找到 ID ${targetId} 但无完整数据。`;

    const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || cardName;
    const targetType = targetData['宝可梦名字'] ? '宝可梦' : (targetData['卡牌类型'] || '');
    const lines = [];

    // 2. 目标卡详情
    lines.push(`## 🎯 目标卡: ${targetName}`);
    lines.push(this.data._formatCardRich(targetData, targetId));
    const props = this._getStrategicProps(targetData);
    lines.push(`\n🏷 ${props.prizes}奖 | ${props.stage} | ${props.scaling} | 最高${props.maxEnergy}能`);

    // 3. 识别角色并确定搜索方向
    const targetEffects = this._collectEffects(targetData);
    const targetAttr = targetData['属性'] || '';

    const providesEnergy = /附着.*能量|能量.*附着|填能/.test(targetEffects) &&
      /弃牌区|牌库|手牌|特性/.test(targetEffects);
    const placesDamageCtr = targetEffects.includes('伤害指示物') && targetEffects.includes('放置');
    const needsEnergy = props.maxEnergy >= 3;
    const isEvo2 = (targetData['进化阶段'] || '').includes('2');

    lines.push('\n## 🔍 协同搜索');

    // 搜索方向 1：伤害指示物协同
    if (placesDamageCtr || targetEffects.includes('伤害指示物')) {
      const dmgCards = this._findSynergyCards(targetData, [
        { label: '伤害指示物缩放', pattern: '伤害指示物.*(×|数量|每有|增加)', type: '宝可梦', provides: '目标卡可放置伤害指示物，此卡将其转化为伤害' },
        { label: '伤害指示物互动', pattern: '伤害指示物', type: '宝可梦', provides: '与伤害指示物机制互动' }
      ]);
      if (dmgCards.length > 0) {
        lines.push(`\n### 伤害指示物协同 (目标卡可放置伤指物，找到 ${dmgCards.length} 张相关卡)`);
        dmgCards.slice(0, 20).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 2：能量加速需求
    if (needsEnergy && !providesEnergy) {
      const enCards = this._findSynergyCards(targetData, [
        { label: '填能加速', pattern: `附着.*能量|能量.*附着.*(备战|弃牌|牌库)`, type: null, provides: '帮助目标卡快速启动' }
      ]);
      if (enCards.length > 0) {
        lines.push(`\n### 填能加速 (目标卡需要${props.maxEnergy}能，找到 ${enCards.length} 张辅助)`);
        enCards.slice(0, 15).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 3：能量供给者的受益打手
    if (providesEnergy) {
      const atkCards = this._findSynergyCards(targetData, [
        { label: '高能量需求打手', pattern: targetAttr ? `${targetAttr}.*无.*无` : '无 无 无', type: '宝可梦', provides: '目标卡填能，此卡输出' }
      ]);
      if (atkCards.length > 0) {
        lines.push(`\n### 受益打手 (目标卡可填能，找到 ${atkCards.length} 张)`);
        atkCards.slice(0, 20).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 4：备战区协同
    if (targetEffects.includes('备战') || targetEffects.includes('备战区')) {
      const benchCards = this._findSynergyCards(targetData, [
        { label: '备战区受益', pattern: '备战区.*(特性|效果|触发)|特性.*备战', type: '宝可梦', provides: '在备战区发挥作用' }
      ]);
      if (benchCards.length > 0) {
        lines.push(`\n### 备战区协同 (找到 ${benchCards.length} 张)`);
        benchCards.slice(0, 10).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 5：进化辅助（仅当目标卡是 2 阶进化时）
    if (isEvo2) {
      const evoCards = this._findSynergyCards(targetData, [
        { label: '进化辅助', pattern: '进化.*(牌库|选择|糖果)|糖果', type: null, provides: '加速2阶进化' }
      ]);
      if (evoCards.length > 0) {
        lines.push(`\n### 进化辅助 (目标卡是2阶进化，找到 ${evoCards.length} 张)`);
        evoCards.slice(0, 10).forEach(c => lines.push(c.formatted));
      }
    }

    // 6. 泛用卡推荐
    lines.push('\n---');
    lines.push('## 📦 泛用卡推荐 (按目标卡需求打分)');
    const generalCards = this._scoreGeneralCards(targetData, targetEffects, targetAttr);
    generalCards.slice(0, 20).forEach((s, i) => {
      const star = i < 5 ? '⭐' : (i < 10 ? '★' : '  ');
      const eff = (s.data['效果'] || '').slice(0, 60);
      lines.push(`${star}[${s.type}] **${s.name}** ID:${s.id} (${s.score}分) ${eff}`);
    });

    lines.push('\n> 组卡组时优先从标记 ⭐ 的卡中选择。');
    lines.push('> 如需更精确搜索某一方向，使用 search_cards 或 grep_cards。');

    return lines.join('\n');
  }

  /**
   * 根据规则搜索协同卡并评分
   */
  _findSynergyCards(targetData, rules) {
    const targetAttr = targetData['属性'] || '';
    const allCards = new Map();

    for (const rule of rules) {
      const result = this.data.grepCards(rule.pattern, rule.type, 30);
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        if (!r.data || r.id === (targetData['卡牌ID'] || [])[0]) continue;
        // 兼容性检查
        if (rule.type === '宝可梦' && targetAttr) {
          const cardAttr = r.data['属性'] || '';
          // 如果目标卡是能量供给者且限定了属性
          const targetEffects = this._collectEffects(targetData);
          const attrNames = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
          const attrName = attrNames[targetAttr] || targetAttr;
          if (targetEffects.includes(attrName + '宝可梦') && cardAttr !== targetAttr) continue;
        }

        const existing = allCards.get(r.id);
        if (existing) {
          existing.score += (result.results.length - i);
          existing.labels.push(rule.label);
        } else {
          const strProps = this._getStrategicProps(r.data);
          const evidence = this._findEvidence(targetData, r.data, rule.label);
          allCards.set(r.id, {
            id: r.id,
            name: r.data['宝可梦名字'] || r.data['卡牌名字'] || r.id,
            data: r.data,
            score: result.results.length - i,
            labels: [rule.label],
            strProps,
            evidence,
            formatted: '' // fill below
          });
        }
      }
    }

    // 按战略得分排序
    const sorted = [...allCards.values()].sort((a, b) => {
      const sa = this._scoreAttacker(a.strProps);
      const sb = this._scoreAttacker(b.strProps);
      if (sa !== sb) return sb - sa;
      return b.score - a.score;
    });

    // 生成格式化文本
    const top3 = new Set(sorted.slice(0, 3).map(c => c.id));
    for (const c of sorted) {
      const marker = top3.has(c.id) ? '⭐' : '';
      const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
      const incompat = this._getIncompatReason(targetData, c.data);
      const warn = incompat ? ` ⚠${incompat}` : '';
      c.formatted = `${marker} **${c.name}** [ID:${c.id}] [${type}] (${c.strProps.prizes}奖|${c.strProps.stage}|${c.strProps.scaling})${warn}\n  ${c.evidence}`;
    }

    return sorted;
  }

  /**
   * 评估打手的战略价值
   */
  _scoreAttacker(props) {
    let score = 0;
    if (props.prizes === 1) score += 3;       // 1奖小人牌优选
    if (props.stage === '基础') score += 2;     // 基础比进化好调度
    if (props.scaling === '伤指物缩放') score += 4;
    else if (props.scaling === '能量缩放') score += 3;
    if (props.maxEnergy <= 2) score += 1;       // 低能量需求
    return score;
  }

  /**
   * 找两张卡之间的协同证据
   */
  _findEvidence(targetData, cardData, ruleLabel) {
    const targetText = this._collectEffects(targetData);
    const cardText = this._collectEffects(cardData);
    const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || '目标卡';
    const evidences = [];

    // 伤害指示物协同
    if (cardText.includes('伤害指示物')) {
      if (/×|每有|数量.*伤害/.test(cardText))
        evidences.push(`伤害随伤指物缩放——${targetName}提供的伤指物直接转化为伤害`);
      else
        evidences.push(`效果涉及伤害指示物，与${targetName}的伤指物放置形成联动`);
    }

    // 能量协同
    for (let i = 1; i <= 4; i++) {
      const s = cardData[`技能${i}`];
      if (s && Array.isArray(s['消耗'])) {
        const cnt = s['消耗'].filter(c => c !== '无').length;
        if (cnt >= 3) {
          evidences.push(`招式「${s['名字']}」需${cnt}能，${targetName}可加速`);
          break;
        }
      }
    }

    // 弃牌区协同
    if (targetText.includes('弃牌区') && cardText.includes('弃牌区'))
      evidences.push(`双方都利用弃牌区，形成资源循环`);

    // 备战区协同
    if (targetText.includes('备战') && cardText.includes('备战'))
      evidences.push(`涉及备战区互动`);

    // 进化协同
    if (cardText.includes('糖果') && !cardData['宝可梦名字'])
      evidences.push(`神奇糖果可加速进化`);

    return evidences.length > 0 ? evidences.join('；') : `匹配规则: ${ruleLabel}`;
  }

  /**
   * 不兼容原因
   */
  _getIncompatReason(targetData, cardData) {
    const targetAttr = targetData['属性'] || '';
    const cardAttr = cardData['属性'] || '';
    const targetEffects = this._collectEffects(targetData);
    const attrNames = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
    const attrName = attrNames[targetAttr] || targetAttr;
    if (targetEffects.includes(attrName + '宝可梦') && cardAttr && cardAttr !== targetAttr) {
      return `目标卡仅支持${attrName}宝可梦，此卡是${attrNames[cardAttr] || cardAttr}系`;
    }
    return '';
  }

  /**
   * 推荐泛用卡（支援者/物品/道具/竞技场），按目标卡需求打分
   */
  _scoreGeneralCards(targetData, targetEffects, targetAttr) {
    const scored = [];
    const seenNames = new Set();
    const isEvo = (targetData['进化阶段'] || '').includes('2');
    const hasDmgCtr = targetEffects.includes('伤害指示物');
    const hasDiscard = targetEffects.includes('弃牌区') && targetEffects.includes('能量');

    for (const [id, data] of this.data._jsonCache) {
      if (data['宝可梦名字']) continue;
      const name = data['卡牌名字'] || '';
      if (!name || seenNames.has(name)) continue;
      const version = this.data._extractVersion(data);
      if (version && !this.data._isCurrentFormat(version)) continue;
      seenNames.add(name);

      const type = (data['卡牌类型'] || '').replace('卡', '');
      const text = (data['效果'] || '') + (data['特性效果'] || '');

      let score = 1;
      if (isEvo && text.includes('进化') && (text.includes('牌库') || text.includes('糖果'))) score += 5;
      if (isEvo && text.includes('基础') && text.includes('牌库')) score += 3;
      if (hasDmgCtr && text.includes('伤害指示物')) score += 4;
      if (hasDiscard && text.includes('弃牌区') && text.includes('能量')) score += 3;
      if (text.includes('牌库') && text.includes('抽出')) score += 2;
      if (text.includes('回收') || text.includes('加入手牌')) score += 2;
      if (text.includes('战斗场') || text.includes('抓')) score += 2;
      if (targetAttr && text.includes(targetAttr + '能量')) score += 3;

      scored.push({ name, id, type, data, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * 分析用户卡组
   */
  analyzeDeck(deck) {
    if (!deck || !Array.isArray(deck.cards) || deck.cards.length === 0) {
      return '该卡组为空，无法分析。';
    }

    const lines = [];
    lines.push(`## 📊 卡组分析: ${deck.name}`);
    lines.push(`总张数: ${deck.totalCount}/60 | 种类: ${deck.cards.length}`);

    // 按类型统计
    const typeCount = {};
    for (const card of deck.cards) {
      const t = card.type || '未知';
      typeCount[t] = (typeCount[t] || 0) + card.quantity;
    }

    lines.push('\n### 类型分布');
    for (const [type, count] of Object.entries(typeCount)) {
      lines.push(`- ${type}: ${count} 张`);
    }

    // 检测问题
    const issues = [];
    if (deck.totalCount !== 60) issues.push(`⚠ 卡组 ${deck.totalCount} 张（应为 60 张）`);
    const pokeCount = (typeCount['宝可梦'] || 0);
    if (pokeCount < 12) issues.push(`⚠ 宝可梦仅 ${pokeCount} 张，偏少（建议 12-20）`);
    if (pokeCount > 24) issues.push(`⚠ 宝可梦 ${pokeCount} 张，偏多`);
    const energyCount = (typeCount['基本能量'] || 0) + (typeCount['特殊能量'] || 0);
    if (energyCount < 8) issues.push(`⚠ 能量仅 ${energyCount} 张，偏少（建议 8-14）`);
    if (energyCount > 16) issues.push(`⚠ 能量 ${energyCount} 张，偏多`);

    if (issues.length > 0) {
      lines.push('\n### 检测到的问题');
      issues.forEach(i => lines.push(i));
    }

    // 列出宝可梦线和训练家卡
    lines.push('\n### 宝可梦线');
    const pokemons = deck.cards.filter(c => c.type === '宝可梦').sort((a, b) => b.quantity - a.quantity);
    pokemons.forEach(c => lines.push(`- ${c.name} x${c.quantity} (ID:${c.id})`));

    lines.push('\n### 训练家卡');
    const trainers = deck.cards.filter(c => c.type !== '宝可梦' && c.type !== '基本能量' && c.type !== '特殊能量');
    trainers.forEach(c => lines.push(`- [${c.type}] ${c.name} x${c.quantity} (ID:${c.id})`));

    lines.push('\n---');
    lines.push('> 如需改进建议，请告诉我想优化的方向（如：提高稳定性、加强打手、改善对局等）。');
    lines.push('> 如需直接修改卡组，告诉我具体需求（如：加入2张某某卡、替换某某卡线等）。');

    return lines.join('\n');
  }
}
