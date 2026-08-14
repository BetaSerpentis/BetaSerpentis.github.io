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

  // ========== 数值分析 ==========

  /**
   * 计算伤害线：给定卡牌的攻击在不同加成下的伤害输出
   */
  calculateDamageLines(cardData) {
    if (!cardData) return null;
    const name = cardData['宝可梦名字'] || cardData['卡牌名字'] || '未知';
    const lines = [];
    lines.push(`\n### 📐 伤害线分析: ${name}`);

    const attacks = [];
    for (let i = 1; i <= 4; i++) {
      const s = cardData[`技能${i}`];
      if (s && s['名字']) attacks.push(s);
    }
    if (attacks.length === 0) {
      lines.push('(无攻击招式)');
      return lines.join('\n');
    }

    // 环境 HP 阈值
    const thresholds = [
      { label: '基础宝可梦', hp: 130 },
      { label: '基础ex/V', hp: 230 },
      { label: '1阶ex', hp: 310 },
      { label: '沙奈朵ex/多龙ex', hp: 320 },
      { label: '恶喷ex', hp: 330 },
      { label: '班基拉斯ex', hp: 340 }
    ];

    for (const atk of attacks) {
      const cost = Array.isArray(atk['消耗']) ? atk['消耗'].join(' ') : '?';
      const baseDmg = parseInt(atk['伤害']) || 0;
      const hasPlus = String(atk['伤害'] || '').includes('+');
      const bonusText = atk['效果'] || '';

      lines.push(`\n**${atk['名字']}** ${cost} 基础${atk['伤害']}`);

      if (hasPlus || bonusText.includes('增加')) {
        // 尝试从效果文本提取加成条件
        let bonusVal = 0;
        const bonusMatch = bonusText.match(/增加(\d+)/);
        if (bonusMatch) bonusVal = parseInt(bonusMatch[1]);

        const condMatch = bonusText.match(/若|如果|自己.*放置有/);
        const condition = condMatch ? bonusText.slice(0, 60) : '满足条件时';

        lines.push(`| 配置 | 伤害 | 可OHKO |`);
        lines.push(`|------|------|--------|`);
        const base = baseDmg;
        const full = baseDmg + bonusVal;

        const configs = [
          { label: '基础（未触发）', dmg: base },
          { label: `+条件触发`, dmg: full },
          { label: `+不服输头带`, dmg: full + 30 },
          { label: `+极限腰带(vs ex)`, dmg: full + 50 },
          { label: `+头带+腰带`, dmg: full + 80 }
        ];

        for (const cfg of configs) {
          const kills = thresholds.filter(t => cfg.dmg >= t.hp).map(t => t.label);
          const killStr = kills.length > 0 ? kills.slice(0, 3).join('、') : '—';
          lines.push(`| ${cfg.label} | **${cfg.dmg}** | ${killStr} |`);
        }
      } else {
        lines.push(`| 配置 | 伤害 | 可OHKO |`);
        lines.push(`|------|------|--------|`);
        const configs = [
          { label: '基础', dmg: baseDmg },
          { label: '+不服输头带', dmg: baseDmg + 30 },
          { label: '+极限腰带(vs ex)', dmg: baseDmg + 50 },
          { label: '+头带+腰带', dmg: baseDmg + 80 }
        ];
        for (const cfg of configs) {
          const kills = thresholds.filter(t => cfg.dmg >= t.hp).map(t => t.label);
          const killStr = kills.length > 0 ? kills.slice(0, 3).join('、') : '—';
          lines.push(`| ${cfg.label} | **${cfg.dmg}** | ${killStr} |`);
        }
      }
    }

    // HP 耐力分析
    const hp = cardData['HP'];
    if (hp) {
      lines.push(`\n### 🛡 耐力分析`);
      lines.push(`基础 HP: **${hp}**`);

      const hasRuleEx = (cardData['规则'] || '').includes('ex') || (cardData['规则'] || '').includes('V');
      if (hasRuleEx) {
        lines.push(`+英雄斗篷(ACE): **${hp + 100}** ← ex 可用`);
      } else {
        lines.push(`+豪华斗篷: **${hp + 100}** ← 非规则宝可梦可用`);
      }

      // 撤退成本
      const retreat = cardData['撤退'];
      if (retreat != null) {
        const cost = parseInt(retreat) || 0;
        const tag = cost === 0 ? '🟢 免费撤退' : (cost <= 2 ? '🟡 需要' + cost + '能撤退' : '🔴 撤退' + cost + '，笨重');
        lines.push(`撤退成本: ${tag}`);
      }

      // 弱点
      if (cardData['弱点']) {
        lines.push(`弱点: ${cardData['弱点']} ⚠`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 起手一致性估算
   */
  estimateConsistency(deckSummary) {
    const { totalCards = 60, basicCount = 0, searchCount = 0, drawCount = 0, keyCount4 = 0, keyCount3 = 0 } = deckSummary;
    const lines = [];
    lines.push('\n### 🎲 起手一致性估算');
    lines.push('（基于超几何分布近似计算，含再战规则）\n');

    // 起手 7 张有基础的概率
    if (basicCount > 0 && totalCards > 0) {
      // 简化：P(至少1张) ≈ 1 - P(0张)
      let p0 = 1;
      for (let i = 0; i < 7; i++) {
        p0 *= (totalCards - basicCount - i) / (totalCards - i);
      }
      const pBasic = Math.round((1 - p0) * 100);
      const withMulligan = Math.round((1 - p0 * p0) * 100);
      const icon = pBasic >= 85 ? '🟢' : (pBasic >= 70 ? '🟡' : '🔴');
      lines.push(`| ${icon} 起手有基础宝可梦 | ${pBasic}% | 含再战→${withMulligan}% | 标准≥85% |`);
    }

    // 4-of 关键卡起手命中
    if (keyCount4 > 0 && totalCards > 0) {
      let p0 = 1;
      for (let i = 0; i < 7; i++) {
        p0 *= (totalCards - keyCount4 - i) / (totalCards - i);
      }
      const pHit = Math.round((1 - p0) * 100);
      lines.push(`| 4-of 关键卡起手命中 | ${pHit}% | 含再战→${Math.round((1 - p0 * p0) * 100)}% | 约40%为正常值 |`);
    }

    // 检索卡上手率
    if (searchCount > 0 && totalCards > 0) {
      let p0 = 1;
      for (let i = 0; i < 7; i++) {
        p0 *= (totalCards - searchCount - i) / (totalCards - i);
      }
      const pSearch = Math.round((1 - p0) * 100);
      const icon2 = pSearch >= 70 ? '🟢' : (pSearch >= 50 ? '🟡' : '🔴');
      lines.push(`| ${icon2} 起手有检索卡 | ${pSearch}% | ${searchCount}张检索 | 越高越好 |`);
    }

    // 能量起手上手
    const energyCount = (deckSummary.energyCount || 0);
    if (energyCount > 0 && totalCards > 0) {
      let p0 = 1;
      for (let i = 0; i < 7; i++) {
        p0 *= (totalCards - energyCount - i) / (totalCards - i);
      }
      const pEnergy = Math.round((1 - p0) * 100);
      const icon3 = pEnergy >= 70 ? '🟢' : (pEnergy >= 50 ? '🟡' : '🔴');
      lines.push(`| ${icon3} 起手有能量 | ${pEnergy}% | ${energyCount}张能量 | ≥70%不卡能 |`);
    }

    lines.push('\n> 再战规则：第一次起手无基础宝可梦→对手多抽1张→自己重抽7张。实际概率≈1-(1-p)²');

    return lines.join('\n');
  }

  // ========== 协同分析 ==========

  /**
   * 深度分析：给定目标卡，搜索所有潜在的协同卡并打分排序
   * @returns {string} 格式化的分析报告
   */
  async deepAnalysis(cardName) {
    if (!cardName) return '请提供卡牌名称';

    // 1. 搜索目标卡（同时搜原始名和去前缀名，原始名结果优先）
    const strippedName = cardName.replace(/^[\u4e00-\u9fa5]{1,4}的/, '').trim();
    const hasPrefix = strippedName && strippedName !== cardName && strippedName.length > 1;

    const origResult = this.data.searchCards(cardName, null, 5);
    const strippedResult = hasPrefix ? this.data.searchCards(strippedName, null, 5) : null;

    // 合并去重：原始查询结果在前，去前缀结果在后
    const merged = [];
    const seen = new Set();
    for (const r of origResult.results) { merged.push(r); seen.add(r.id); }
    if (strippedResult) {
      for (const r of strippedResult.results) {
        if (!seen.has(r.id)) { r._secondary = true; merged.push(r); seen.add(r.id); }
      }
    }

    if (merged.length === 0) return `未找到"${cardName}"。请检查卡名拼写。`;
    const searchResult = { results: merged, total: merged.length };

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

    // 搜索方向 5：进化辅助
    if (isEvo2 || (targetData['进化阶段'] || '').includes('1')) {
      const evoCards = this._findSynergyCards(targetData, [
        { label: '进化加速', pattern: '进化.*(牌库|选择|糖果)|糖果|演进', type: null, provides: '加速进化过程' }
      ]);
      if (evoCards.length > 0) {
        lines.push(`\n### 进化辅助 (目标卡需进化，找到 ${evoCards.length} 张)`);
        evoCards.slice(0, 10).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 6：弃牌区协同
    if (targetEffects.includes('弃牌区')) {
      const discardCards = this._findSynergyCards(targetData, [
        { label: '弃牌区回收', pattern: '弃牌区.*(加入手牌|放回|附着)', type: null, provides: '从弃牌区回收资源' },
        { label: '弃牌区受益', pattern: '弃牌区.*(能量|宝可梦)', type: '宝可梦', provides: '弃牌区资源利用' }
      ]);
      if (discardCards.length > 0) {
        lines.push(`\n### 弃牌区协同 (目标卡涉及弃牌区，找到 ${discardCards.length} 张)`);
        discardCards.slice(0, 15).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 7：特殊状态协同
    if (/中毒|灼伤|麻痹|睡眠|混乱/.test(targetEffects)) {
      const statusCards = this._findSynergyCards(targetData, [
        { label: '状态受益', pattern: '中毒|灼伤|麻痹|睡眠|混乱', type: '宝可梦', provides: '利用特殊状态的卡' }
      ]);
      if (statusCards.length > 0) {
        lines.push(`\n### 特殊状态协同 (目标卡涉及状态，找到 ${statusCards.length} 张)`);
        statusCards.slice(0, 10).forEach(c => lines.push(c.formatted));
      }
    }

    // 搜索方向 8：训练家宝可梦专属
    const isTrainerPokemon = targetName.includes('的') && !targetName.includes('博士') && !targetName.includes('老大');
    if (isTrainerPokemon) {
      const trainerPrefix = targetName.split('的')[0];
      const trainerCards = this._findSynergyCards(targetData, [
        { label: `${trainerPrefix}的宝可梦`, pattern: `${trainerPrefix}的`, type: '宝可梦', provides: `同属${trainerPrefix}体系的宝可梦` }
      ]);
      // 同时搜对应的支援道具
      const supportCards = this._findSynergyCards(targetData, [
        { label: `${trainerPrefix}专属支援`, pattern: `${trainerPrefix}`, type: null, provides: `${trainerPrefix}体系的训练家卡` }
      ]);
      const allTrainer = [...trainerCards, ...supportCards];
      if (allTrainer.length > 0) {
        lines.push(`\n### 「${trainerPrefix}的」体系协同 (找到 ${allTrainer.length} 张)`);
        allTrainer.slice(0, 15).forEach(c => lines.push(c.formatted));
      }
    }

    // 加入数值分析
    if (targetData['宝可梦名字']) {
      lines.push(this.calculateDamageLines(targetData));
    }

    // 9. 泛用卡推荐
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
    lines.push('> 组完卡组后使用 check_deck_consistency 检验结构，使用 matchup_hint 评估对局。');

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
    if (props.maxEnergy <= 1) score += 2;       // 1能启动极优
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
      // 新增评分维度
      const hasStatus = /中毒|灼伤|麻痹|睡眠|混乱/.test(targetEffects);
      if (hasStatus && /中毒|灼伤|麻痹|睡眠|混乱/.test(text)) score += 3;
      if (targetEffects.includes('弃牌区') && text.includes('弃牌区')) score += 3;
      // 训练家宝可梦专属卡加成
      const targetName = targetData['宝可梦名字'] || '';
      if (targetName.includes('的')) {
        const prefix = targetName.split('的')[0];
        if (text.includes(prefix)) score += 4;
      }
      // 低能需求的打手更优
      if (text.includes('无') && !text.includes('无无无')) score += 1;

      scored.push({ name, id, type, data, score });
    }

    // 从 TSV 索引补充（JSON 中未出现的训练家/物品/道具/竞技场）
    for (const [id, entry] of this.data._tsvIndex) {
      if (entry.type === '宝可梦' || entry.type === '基本能量' || entry.type === '特殊能量') continue;
      const name = entry.name;
      if (!name || seenNames.has(name)) continue;
      if (entry.mark && !this.data._isCurrentFormat(entry.mark)) continue;
      seenNames.add(name);

      const text = entry.searchText || '';
      let score = 1;
      if (isEvo && text.includes('进化') && (text.includes('牌库') || text.includes('糖果'))) score += 5;
      if (isEvo && text.includes('基础') && text.includes('牌库')) score += 3;
      if (hasDmgCtr && text.includes('伤害指示物')) score += 4;
      if (hasDiscard && text.includes('弃牌区') && text.includes('能量')) score += 3;
      if (text.includes('牌库') && /抽出|抽.*张/.test(text)) score += 2;
      if (text.includes('回收') || text.includes('加入手牌')) score += 2;
      if (/战斗场|抓/.test(text)) score += 2;

      scored.push({ name, id, type: entry.type, data: null, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * 自动化卡组一致性检验
   */
  checkDeckConsistency(deck) {
    if (!deck || !Array.isArray(deck.cards) || deck.cards.length === 0) {
      return '该卡组为空，无法检验。';
    }

    const lines = [];
    lines.push(`## 🔍 卡组一致性检验: ${deck.name}`);
    lines.push(`总张数: ${deck.totalCount}/60 | 种类: ${deck.cards.length}\n`);

    // ── 分类统计 ──
    const stats = { pokemon: 0, supporter: 0, item: 0, tool: 0, stadium: 0, energy: 0, basicPokemon: 0, evo1Pokemon: 0, evo2Pokemon: 0, aceCount: 0 };
    const drawCards = [];    // 抽牌/滤牌
    const searchCards = [];  // 检索
    const recoveryCards = [];// 回收
    const switchCards = [];  // 换位
    const gustCards = [];    // 抓枪

    // 卡牌分类关键词
    const drawNames = ['博士的研究', '奇树', '妮莫', '艾莉丝', '玛俐', '暗码迷', '牡丹'];
    const searchNames = ['球', '宝芬', 'VIP', '装置', '雷达', '香氛', '推车', '包包'];
    const recoveryNames = ['钓竿', '回收', '夜间学院', '朋友手册', '能量再利用', '圣灰'];
    const switchNames = ['交替', '喷射', '滑板', '绳索', '急进', '牡丹', '回收机'];
    const gustNames = ['老大', '捕捉器', '拖拽'];

    for (const card of deck.cards) {
      const t = card.type || '';
      const n = card.name || '';
      const q = card.quantity || 0;

      if (t === '宝可梦') {
        stats.pokemon += q;
        // 尝试判断进化阶段（通过名字模式）
        if (n.includes('ex') || n.includes('VSTAR') || n.includes('VMAX')) {
          stats.evo2Pokemon += q;
        } else if (n.includes('V') && !n.includes('VSTAR') && !n.includes('VMAX')) {
          stats.evo2Pokemon += q;
        } else {
          stats.basicPokemon += q; // 简化：大部分宝可梦基础卡不带后缀
        }
      } else if (t === '支援者') {
        stats.supporter += q;
        if (drawNames.some(k => n.includes(k))) drawCards.push(n);
        if (gustNames.some(k => n.includes(k))) gustCards.push(n);
      } else if (t === '物品') {
        stats.item += q;
        if (searchNames.some(k => n.includes(k))) searchCards.push(n);
        if (recoveryNames.some(k => n.includes(k))) recoveryCards.push(n);
        if (switchNames.some(k => n.includes(k))) switchCards.push(n);
      } else if (t === '宝可梦道具') {
        stats.tool += q;
        // ACE SPEC 检测
        if (['英雄斗篷', '极限腰带', '璀璨结晶', '豪华炸弹', '幸存锻炼器', '希望护身符'].includes(n)) stats.aceCount += q;
      } else if (t === '竞技场') {
        stats.stadium += q;
        if (['伟大巨树', '中立中心'].includes(n)) stats.aceCount += q;
        if (recoveryNames.some(k => n.includes(k))) recoveryCards.push(n);
      } else if (t.includes('能量')) {
        stats.energy += q;
        if (['遗赠能量', '富裕能量', '新冲天能量'].includes(n)) stats.aceCount += q;
      }
      // 物品 ACE 检测
      if (t === '物品' && ['大师球', '秘密箱', '不公印章', '钓竿MAX', '能量输送PRO', '百万吨吹风机', '宝可梦旋风回收机', '顶尖捕捉器', '高级香氛', '觉醒战鼓', '重启舱', '危险光线', '宝可生机剂A', '寻宝装置', '紧急切换', '完美搅拌器', '贵重推车', '奇迹耳机'].includes(n)) {
        stats.aceCount += q;
      }
    }

    const trainerTotal = stats.supporter + stats.item + stats.tool + stats.stadium;

    // ── 检验结果 ──
    const checks = [];
    const addCheck = (label, value, min, max, advice) => {
      const icon = value < min ? '🔴' : (value > max ? '🟡' : '🟢');
      checks.push({ icon, label, value, range: `${min}-${max}`, ok: value >= min && value <= max, advice });
    };

    addCheck('总张数', deck.totalCount, 60, 60, '必须恰好60张');
    addCheck('宝可梦', stats.pokemon, 12, 18, '竞技标准12-18张');
    addCheck('训练家', trainerTotal, 30, 36, '竞技下限30张');
    addCheck('能量', stats.energy, 8, 12, '高能耗可达14张');
    addCheck('支援者', stats.supporter, 8, 12, '过少→手牌枯竭；过多→积压');
    addCheck('物品', stats.item, 10, 15, '过少→检索不上手');
    addCheck('宝可梦道具', stats.tool, 2, 6, '派帕卡组建议3-6');
    addCheck('竞技场', stats.stadium, 1, 3, '过少→被对手竞技场压制');

    // 功能性检查
    const drawCount = [...new Set(drawCards)].length;
    const searchCount = [...new Set(searchCards)].length;
    const recoveryCount = [...new Set(recoveryCards)].length;
    const switchCount = [...new Set(switchCards)].length;
    const gustCount = [...new Set(gustCards)].length;

    const drawCheck = { icon: drawCount >= 8 ? '🟢' : '🔴', label: '抽滤手段', value: drawCount, range: '≥8' };
    const searchCheck = { icon: searchCount >= 8 ? '🟢' : (searchCount >= 6 ? '🟡' : '🔴'), label: '检索手段', value: searchCount, range: '≥8' };
    const recoveryCheck = { icon: recoveryCount >= 2 ? '🟢' : '🔴', label: '回收手段', value: recoveryCount, range: '≥2' };
    const switchCheck = { icon: switchCount >= 2 ? '🟢' : '🔴', label: '换位手段', value: switchCount, range: '≥2' };
    const gustCheck = { icon: gustCount >= 1 ? '🟢' : '🟡', label: '抓枪手段', value: gustCount, range: '≥1' };
    const aceCheck = { icon: stats.aceCount === 1 ? '🟢' : (stats.aceCount === 0 ? '🟡' : '🔴'), label: 'ACE SPEC', value: stats.aceCount, range: '=1' };

    // 输出
    lines.push('### 📊 类型分布');
    lines.push(`| 类型 | 数量 | 检验 |`);
    lines.push(`|------|------|------|`);
    for (const c of checks) {
      lines.push(`| ${c.icon} ${c.label} | ${c.value} | ${c.range} ${c.ok ? '✓' : '← 需调整'}`);
    }

    lines.push('\n### 🔧 功能密度');
    lines.push(`| 功能 | 数量 | 标准 |`);
    lines.push(`|------|------|------|`);
    [drawCheck, searchCheck, recoveryCheck, switchCheck, gustCheck, aceCheck].forEach(c => {
      lines.push(`| ${c.icon} ${c.label} | ${c.value} | ${c.range} |`);
    });

    // 问题汇总
    const allResults = [...checks, drawCheck, searchCheck, recoveryCheck, switchCheck, gustCheck, aceCheck];
    const fails = allResults.filter(c => c.icon !== '🟢');

    if (fails.length === 0) {
      lines.push('\n### ✅ 全部通过');
      lines.push('卡组结构符合竞技标准。如需深度对局分析，请提供具体想优化的方向。');
    } else {
      lines.push('\n### ⚠ 需要关注');
      for (const f of fails) {
        const adv = f.advice || '';
        lines.push(`- ${f.icon} **${f.label}**: 当前 ${f.value}，标准 ${f.range}${adv ? ' — ' + adv : ''}`);
      }
    }

    // 进化线提示
    if (stats.pokemon > 0) {
      lines.push('\n### 🧬 进化线提示');
      lines.push('- 基础宝可梦约占宝可梦总数的 ' + Math.round(stats.basicPokemon / Math.max(1, stats.pokemon) * 100) + '%');
      if (stats.basicPokemon < 8) {
        lines.push('- ⚠ 基础宝可梦偏少（<' + stats.basicPokemon + '），起手上手率可能不足85%');
      }
      lines.push('- 自动检测进化链需要卡牌详情数据，请用 get_card_detail 验证每条进化线完整性');
    }

    lines.push('\n> 提示：功能性分类基于卡名关键词自动检测，可能有遗漏。人工复核建议对照卡组逐张确认。');

    return lines.join('\n');
  }

  /**
   * 对局提示 — 基于 meta.json 环境数据评估卡组对局优劣势
   */
  async matchupHint(cardNames) {
    if (!cardNames || cardNames.length === 0) return '请提供卡组核心卡牌名称，如"派帕的獒教父ex 愿增猿 藏饱栗鼠"';

    const names = Array.isArray(cardNames) ? cardNames : cardNames.split(/[,，\s]+/).filter(n => n.length > 1);
    if (names.length === 0) return '无法解析卡牌名称。';

    const lines = [];
    lines.push('## ⚔ 环境对局预判\n');

    // 加载 meta.json
    try {
      const resp = await fetch('data/meta.json');
      if (!resp.ok) throw new Error('meta not loaded');
      const meta = await resp.json();
      const topDecks = meta.topDecks || [];
      const matchups = meta.matchups || {};

      if (topDecks.length === 0) {
        lines.push('> 环境数据暂不可用。');
        return lines.join('\n');
      }

      lines.push(`### 当前环境（${matchups.dataSource || '简中 F/G/H/I 标'}）\n`);

      // 分析卡组特征
      const namesStr = names.join(' ');
      const isEx = namesStr.includes('ex') || namesStr.includes('VSTAR') || namesStr.includes('VMAX');
      const isDark = namesStr.includes('恶');
      const isGrass = namesStr.includes('草');
      const usesDmgCtr = namesStr.includes('愿增猿') || namesStr.includes('伤害指示物');
      const hasHeal = namesStr.includes('三明治') || namesStr.includes('回复') || namesStr.includes('藏饱栗鼠');
      const isStage1 = names.some(n => n.includes('教父') || n.includes('栗鼠') || n.includes('水母'));
      const usesHeroCape = namesStr.includes('英雄斗篷');

      // 对每个主流卡组评估
      lines.push('| 卡组 | 使用率 | 预判 | 分析 |');
      lines.push('|------|--------|------|------|');
      for (const deck of topDecks) {
        let favor = '均势';
        let reason = [];

        // 伤害线评估（简化）
        if (deck.name.includes('沙奈朵')) {
          if (isDark) { favor = '略优'; reason.push('恶系克制超系沙奈朵'); }
          else { favor = '不利'; reason.push('沙奈朵ex HP310+伤害指示物扩散难以突破'); }
        } else if (deck.name.includes('猛雷鼓')) {
          favor = '略优';
          reason.push('猛雷鼓ex HP220，210+极限腰带260可OHKO');
        } else if (deck.name.includes('恶喷') || deck.name.includes('喷火龙')) {
          favor = '不利';
          reason.push('喷火龙ex HP330无法OHKO，不公印章压手牌');
        } else if (deck.name.includes('多龙')) {
          if (hasHeal) { favor = '略劣'; reason.push('多龙狙击可破满血条件，但有回复可对抗'); }
          else { favor = '不利'; reason.push('多龙ex HP320+备战狙击直接废掉满血条件'); }
        } else if (deck.name.includes('密勒顿')) {
          favor = '有利';
          reason.push('密勒顿ex HP220，1能150可T1后攻压杀');
        } else if (deck.name.includes('洛奇亚')) {
          favor = '均势';
          reason.push('洛奇亚VSTAR HP230，210+极限260可杀，但古旧能量-1奖');
        } else if (deck.name.includes('LTB') || deck.name.includes('放逐')) {
          favor = '略优';
          reason.push('150稳定压杀放逐打手');
        }

        // 通用弱点检测
        if (isGrass && deck.name.includes('草')) reason.push('⚠ 草弱点需注意');
        if (isStage1 && deck.name.includes('多龙')) reason.push('进化速度不如多龙的Drakloak引擎');

        lines.push(`| ${deck.name} | ${deck.usageRate || '?'} | ${favor} | ${reason.join('；') || '需进一步分析'} |`);
      }

      lines.push(`\n> 📊 数据来源：${matchups.dataSource || '简中社区统计'}`);
      lines.push('> ⚠ 以上为基于卡组特征的简化预判，实际对局受构筑细节和操作影响。');
    } catch (e) {
      lines.push('> 环境数据加载失败，无法生成对局分析。');
    }

    return lines.join('\n');
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
