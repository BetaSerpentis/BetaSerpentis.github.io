// ptcg/js/services/AIAnalysisService.js
// AI 分析引擎 v2：机制自动提取 → 多模式搜索 → 精准评分 → 紧凑输出

import { AICardDataService } from './AICardDataService.js';

export class AIAnalysisService {
  /** @param {AICardDataService} dataService */
  constructor(dataService) {
    this.data = dataService;
  }

  // ========== 单卡强度评级 ==========

  /**
   * 快速评级单卡：S/A/B/C
   * 返回 { tier, reasons[] }
   */
  rateCard(jsonData) {
    if (!jsonData) return { tier: '?', reasons: ['无数据'] };
    const reasons = [];
    let score = 0;

    const isPokemon = !!jsonData['宝可梦名字'];
    if (!isPokemon) return this._rateTrainer(jsonData);

    const props = this._getStrategicProps(jsonData);
    const effects = this._collectEffects(jsonData);
    const hp = parseInt(jsonData['HP']) || 0;

    // 奖品效率（1奖基础/1阶 +3分）
    if (props.prizes === 1) { score += 3; reasons.push('单奖品'); }
    else if (props.prizes === 2) { score += 1; reasons.push('2奖品'); }

    // HP 评估
    if (hp >= 300) { score += 4; reasons.push(`高耐久 HP${hp}`); }
    else if (hp >= 200) { score += 2; reasons.push(`中等HP${hp}`); }
    else if (hp > 0 && hp < 120) { score -= 2; reasons.push(`低HP${hp}易被秒`); }

    // 启动成本
    if (props.maxEnergy <= 1) { score += 3; reasons.push('单能启动'); }
    else if (props.maxEnergy === 2) { score += 1; reasons.push('双能启动'); }
    else if (props.maxEnergy >= 3) { score -= 1; reasons.push(`需${props.maxEnergy}能`); }

    // 伤害缩放
    if (props.scaling === '伤指物缩放') { score += 5; reasons.push('伤指物缩放'); }
    else if (props.scaling === '能量缩放') { score += 3; reasons.push('能量缩放'); }

    // 特性
    if (jsonData['特性名字']) {
      score += 3;
      reasons.push(`特性「${jsonData['特性名字']}」`);
    }

    // 检索/过牌工具
    if (/牌库.*选择|选择.*牌库|抽出|检索/.test(effects)) { score += 2; reasons.push('检索能力'); }

    // HP 阈值风险
    if (props.scaling === '伤指物缩放' && hp > 0 && hp <= 70 && !jsonData['规则']?.includes('ex')) {
      reasons.push('⚠ HP≤70，伤指物缩放有被秒风险');
    }

    const tier = score >= 15 ? 'S' : score >= 10 ? 'A' : score >= 5 ? 'B' : 'C';
    return { tier, score, reasons };
  }

  _rateTrainer(jsonData) {
    const effects = (jsonData['效果'] || '') + (jsonData['特性效果'] || '');
    const type = (jsonData['卡牌类型'] || '').replace('卡', '');
    const reasons = [];
    let score = 0;

    // 过牌/检索
    if (/牌库.*抽出|抽出.*7/.test(effects)) { score += 6; reasons.push('强力过牌'); }
    else if (/牌库.*选择|检索/.test(effects)) { score += 4; reasons.push('检索能力'); }
    // Boss效果
    if (/战斗场|抓.*备战/.test(effects)) { score += 3; reasons.push('抓后排'); }
    // 回收
    if (/弃牌区.*加入手牌|加入手牌.*弃牌区|回收/.test(effects)) { score += 2; reasons.push('资源回收'); }
    // 填能
    if (/附着.*能量|能量.*附着/.test(effects) && /备战|弃牌|牌库/.test(effects)) { score += 4; reasons.push('填能加速'); }
    // 换位
    if (/交换|交替|换位|撤回/.test(effects)) { score += 1; reasons.push('换位'); }
    // ACE SPEC
    if (/ACE|ACE SPEC/i.test(jsonData['规则'] || '')) { score += 5; reasons.push('ACE SPEC'); }

    const tier = score >= 8 ? 'S' : score >= 5 ? 'A' : score >= 3 ? 'B' : 'C';
    return { tier, score, reasons, type: `${type}(训练家)` };
  }

  // ========== 机制自动提取 ==========

  /**
   * 从卡牌文本自动提取所有机制标签
   * 返回 [{ category, label, searchRules: [{pattern, cardType, hint}] }]
   */
  _extractMechanisms(jsonData) {
    const effects = this._collectEffects(jsonData);
    const attr = jsonData['属性'] || '';
    const hp = parseInt(jsonData['HP']) || 0;
    const isPokemon = !!jsonData['宝可梦名字'];
    const mechanisms = [];

    if (!isPokemon) {
      // 训练家卡的机制
      return this._extractTrainerMechanisms(jsonData);
    }

    // === 伤害指示物 ===
    if (effects.includes('伤害指示物')) {
      const rules = [];
      if (/放置.*伤害指示物|伤害指示物.*放置/.test(effects)) {
        rules.push({ pattern: '伤害指示物.*(×|每有|数量|增加)', cardType: '宝可梦', hint: '伤指物缩放打手' });
        rules.push({ pattern: '伤害指示物', cardType: '宝可梦', hint: '伤指物互动' });
        mechanisms.push({ category: 'dmgCtr', label: '放置伤害指示物', provides: '为目标提供伤指物', rules });
      }
      if (/×|每有|数量.*伤害/.test(effects) && effects.includes('伤害指示物')) {
        mechanisms.push({ category: 'dmgCtr', label: '伤害指示物缩放', needs: '需要前置伤指物来源', rules: [
          { pattern: '伤害指示物.*放置|放置.*伤害指示物', cardType: '宝可梦', hint: '伤指物来源' }
        ]});
      }
    }

    // === 能量相关 ===
    if (/附着.*能量|能量.*附着|填能/.test(effects) && /弃牌区|牌库|特性/.test(effects)) {
      mechanisms.push({ category: 'energy', label: '能量加速', provides: '为其他宝可梦填能', rules: [
        { pattern: isPokemon ? `${attr}.*无.*无` : '无 无 无', cardType: '宝可梦', hint: '受益打手(高能需求)' },
        { pattern: '填能|附着.*能量|能量.*附着', cardType: null, hint: '更多填能手段' }
      ]});
    }

    const maxEnergy = this._getMaxEnergy(jsonData);
    if (maxEnergy >= 3) {
      mechanisms.push({ category: 'energy', label: '高能量需求', needs: '需要填能加速', rules: [
        { pattern: '附着.*能量.*(备战|弃牌|牌库)|特性.*填能|能量.*弃牌区', cardType: null, hint: '填能辅助' }
      ]});
    }

    // === 弃牌区 ===
    if (effects.includes('弃牌区')) {
      mechanisms.push({ category: 'discard', label: '弃牌区互动', rules: [
        { pattern: '弃牌区', cardType: '宝可梦', hint: '弃牌区协同' },
        { pattern: '弃牌区.*加入手牌|回收.*弃牌区', cardType: null, hint: '弃牌回收' }
      ]});
    }

    // === 备战区 ===
    if (effects.includes('备战')) {
      mechanisms.push({ category: 'bench', label: '备战区互动', rules: [
        { pattern: '备战区.*(特性|效果|触发)|特性.*备战', cardType: '宝可梦', hint: '备战特性' }
      ]});
    }

    // === 特性 ===
    if (jsonData['特性名字']) {
      mechanisms.push({ category: 'ability', label: '有特性', rules: [
        { pattern: '特性.*无效|无效.*特性|不能使用.*特性', cardType: null, hint: '特性反制' },
        { pattern: '特性.*(牌库|检索|抽出)', cardType: '宝可梦', hint: '特性检索引擎' }
      ]});
    }

    // === 进化 ===
    const stage = jsonData['进化阶段'] || '';
    if (stage.includes('2')) {
      mechanisms.push({ category: 'evolution', label: '2阶进化', needs: '需要进化辅助', rules: [
        { pattern: '进化.*牌库|神奇糖果|糖果', cardType: null, hint: '进化加速' }
      ]});
    }

    // === 检索/过牌 ===
    if (/牌库.*选择|选择.*牌库|检索.*牌库/.test(effects)) {
      mechanisms.push({ category: 'search', label: '牌库检索', provides: '精准检索', rules: [
        { pattern: '牌库.*选择|选择.*牌库', cardType: null, hint: '更多检索手段' }
      ]});
    }

    // === 特殊状态 ===
    const statusTerms = ['中毒', '灼伤', '麻痹', '混乱', '睡眠'];
    for (const st of statusTerms) {
      if (effects.includes(st)) {
        mechanisms.push({ category: 'status', label: `施加${st}`, rules: [
          { pattern: st, cardType: '宝可梦', hint: `${st}相关` }
        ]});
        break; // 只取第一个匹配的状态
      }
    }

    // === 奖赏卡相关 ===
    if (/奖赏卡|奖品卡|奖品/.test(effects)) {
      mechanisms.push({ category: 'prize', label: '奖赏卡互动', rules: [
        { pattern: '奖赏卡|奖品卡|奖品', cardType: null, hint: '奖品相关' }
      ]});
    }

    // === 属性特定 ===
    if (attr) {
      const attrName = this._attrCodeToName(attr);
      if (/宝可梦/.test(effects) && effects.includes(attrName)) {
        // 此卡限定某属性宝可梦
      }
    }

    // === HP 阈值 ===
    if (hp > 0 && hp <= 70) {
      mechanisms.push({ category: 'lowHP', label: `低HP(${hp})`, warning: 'HP≤70 易被秒杀' });
    }

    return mechanisms;
  }

  _extractTrainerMechanisms(jsonData) {
    const effects = (jsonData['效果'] || '') + (jsonData['特性效果'] || '');
    const mechanisms = [];

    if (/进化.*牌库|糖果/.test(effects)) {
      mechanisms.push({ category: 'evolution', label: '进化辅助', rules: [
        { pattern: '进化', cardType: '宝可梦', hint: '需要进化的宝可梦受益' }
      ]});
    }
    if (/附着.*能量|能量.*附着/.test(effects)) {
      mechanisms.push({ category: 'energy', label: '填能', rules: [
        { pattern: '无 无 无|无 无', cardType: '宝可梦', hint: '高能需求打手' }
      ]});
    }
    if (/牌库.*抽出|抽出.*7/.test(effects)) {
      mechanisms.push({ category: 'draw', label: '抽牌引擎', rules: [] });
    }
    if (/弃牌区.*加入手牌|回收/.test(effects)) {
      mechanisms.push({ category: 'recycle', label: '资源回收', rules: [
        { pattern: '弃牌区', cardType: '宝可梦', hint: '利用弃牌区的宝可梦' }
      ]});
    }
    return mechanisms;
  }

  // ========== 新版 deepAnalysis：机制驱动 ==========

  /**
   * 深度分析 v2：自动提取机制 → 多模式搜索 → 统一评分 → 紧凑输出
   * @returns {string} 格式化的分析报告
   */
  async deepAnalysis(cardName) {
    if (!cardName) return '请提供卡牌名称';

    // 1. 定位目标卡（自动处理「某某的卡名」这种口语说法）
    let searchResult = this.data.searchCards(cardName, null, 3);
    let nameUsed = cardName;
    // 如果搜不到，尝试去掉「某某的」前缀
    if (searchResult.results.length === 0) {
      const stripped = cardName.replace(/^.{1,4}的/, '').trim();
      if (stripped !== cardName && stripped.length > 0) {
        searchResult = this.data.searchCards(stripped, null, 3);
        nameUsed = stripped;
      }
    }
    if (searchResult.results.length === 0) return `未找到"${cardName}"。请检查卡名拼写。`;

    const targetId = searchResult.results[0].id;
    const targetData = await this.data.getFullCardData(targetId);
    if (!targetData) return `找到 ID ${targetId} 但无完整数据。`;

    const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || cardName;
    const isPokemon = !!targetData['宝可梦名字'];
    const lines = [];

    // 2. 单卡评级
    const rating = this.rateCard(targetData);
    const tierEmoji = { 'S': '🏆', 'A': '⭐', 'B': '✓', 'C': '  ' }[rating.tier] || '';
    lines.push(`## ${tierEmoji} ${rating.tier}级 ${targetName}`);
    lines.push(this.data._formatCardRich(targetData, targetId));
    lines.push(`> ${rating.reasons.join(' · ')}`);
    if (isPokemon) {
      const props = this._getStrategicProps(targetData);
      lines.push(`> ${props.prizes}奖 | ${props.stage} | 最高${props.maxEnergy}能 | ${props.scaling}`);
    }

    // 3. 自动提取机制并搜索
    const mechanisms = this._extractMechanisms(targetData);
    const allSynergyCards = await this._searchAllMechanisms(targetData, mechanisms);

    // 4. 按类别分组输出（每类 top 5）
    lines.push('\n## 🔗 协同配合');
    const categories = ['dmgCtr', 'energy', 'bench', 'discard', 'evolution', 'ability', 'status', 'prize', 'search'];
    let foundAny = false;

    for (const cat of categories) {
      const catCards = allSynergyCards.filter(c => c.category === cat);
      if (catCards.length === 0) continue;
      foundAny = true;
      const catNames = {
        dmgCtr: '伤害指示物', energy: '能量协同', bench: '备战区', discard: '弃牌区',
        evolution: '进化辅助', ability: '特性联动', status: '特殊状态', prize: '奖赏卡', search: '检索协同'
      };
      const top = catCards.slice(0, 5);
      lines.push(`\n### ${catNames[cat] || cat} (${catCards.length}张相关，显示前${top.length})`);
      for (const c of top) {
        const star = top.indexOf(c) < 3 ? '⭐' : '';
        const type = c.data['卡牌类型'] || (c.data['宝可梦名字'] ? '宝可梦' : '');
        const warn = c.warning ? ` ⚠${c.warning}` : '';
        const incompat = c.incompat ? ` 🚫${c.incompat}` : '';
        lines.push(`${star} **${c.name}** [${type}] ID:${c.id} (${c.strScore}分)${warn}${incompat}`);
        lines.push(`  ${c.evidence}`);
      }
    }

    if (!foundAny) {
      lines.push('\n未检测到明确的机制协同标签。尝试泛用卡匹配。');
    }

    // 5. 泛用卡推荐（紧凑 top 10）
    lines.push('\n---');
    lines.push('## 📦 泛用卡推荐');
    const targetEffects = this._collectEffects(targetData);
    const targetAttr = targetData['属性'] || '';
    const generalCards = this._scoreGeneralCards(targetData, targetEffects, targetAttr);
    const top10 = generalCards.slice(0, 10);
    top10.forEach((s, i) => {
      const star = i < 3 ? '⭐' : (i < 6 ? '★' : '  ');
      lines.push(`${star}[${s.type}] **${s.name}** ID:${s.id} (${s.score}分) ${(s.data['效果']||'').slice(0, 50)}`);
    });

    // 6. 风险提示
    const warnings = [];
    if (isPokemon) {
      const hp = parseInt(targetData['HP']) || 0;
      const props = this._getStrategicProps(targetData);
      if (props.scaling === '伤指物缩放' && hp <= 70) {
        warnings.push(`⚠ HP仅${hp}，伤指物缩放卡有被秒风险——需要保护手段`);
      }
      if (props.stage === '2阶' && !targetEffects.includes('糖果')) {
        warnings.push('⚠ 2阶进化无糖果加速，完整进化需要3回合');
      }
      if (props.maxEnergy >= 3 && !targetEffects.includes('填能') && !/弃牌区.*能量|能量.*弃牌区/.test(targetEffects)) {
        warnings.push(`⚠ 需${props.maxEnergy}能启动，且无自填能手段，强烈需要填能辅助`);
      }
    }
    if (warnings.length > 0) {
      lines.push('\n---');
      lines.push('## ⚠ 风险提示');
      warnings.forEach(w => lines.push(w));
    }

    // 7. 卡组模板建议（基于机制自动生成框架）
    lines.push('\n---');
    lines.push('## 🃏 卡组构筑建议');
    if (isPokemon) {
      const props = this._getStrategicProps(targetData);
      const isEvo = (targetData['进化阶段'] || '').includes('2') || (targetData['进化阶段'] || '').includes('1');
      const evoFrom = targetData['进化自'] || '';
      const attr = targetData['属性'] || '';
      const attrName = this._attrCodeToName(attr);

      lines.push(`\n### 核心思路`);
      lines.push(`- 主打手：**${targetName}**（${rating.tier}级，${rating.reasons.slice(0,3).join(' · ')}）`);
      if (evoFrom) lines.push(`- 进化线：${evoFrom} → ${targetName}`);
      lines.push(`- 能量类型：基本${attrName}能量`);
      lines.push(`- 策略方向：${isEvo ? '中速进化型' : '基础快攻型'}，利用${targetEffects.slice(0,30)}...`);

      lines.push(`\n### 推荐张数配比`);
      const pokeCount = isEvo ? '16-20' : '12-16';
      lines.push(`- 宝可梦：${pokeCount} 张`);
      lines.push(`- 训练家卡：${isEvo ? '28-32' : '32-36'} 张`);
      lines.push(`- ${attrName}能量：10-14 张`);

      lines.push(`\n### 必备卡`);
      if (isEvo) {
        lines.push(`- 神奇糖果 ×3（加速进化）`);
        lines.push(`- 好友宝芬/巢穴球 ×4（检索基础宝可梦）`);
      }
      lines.push(`- 博士的研究 ×4（核心过牌引擎）`);
      lines.push(`- 老大的指令 ×2-3（抓对手关键宝可梦）`);
      lines.push(`- 互换推车/气球 ×2（换位逃脱）`);
      lines.push(`- 夜游记 ×1（回收宝可梦+能量）`);
    }

    // 8. 对局/换备建议
    lines.push('\n---');
    lines.push('## ⚔ 环境适应性');
    lines.push('> 💡 用 search_meta("上位卡组") 获取当前环境上位卡组列表，针对性地选择克制卡。');
    if (isPokemon) {
      const attr = targetData['属性'] || '';
      const attrName = this._attrCodeToName(attr);
      const hp = parseInt(targetData['HP']) || 0;
      const isEvo = (targetData['进化阶段'] || '').includes('2');

      lines.push(`\n### 优势对局`);
      lines.push(`- 属性克制：${attrName}系对 ${attrName === '恶' ? '超' : attrName === '火' ? '草' : attrName === '水' ? '火' : '弱点系'} 有优势`);
      if (hp >= 250) lines.push(`- 高HP(${hp}) 能硬吃多数打手的一击，换奖效率高`);
      if (!isEvo) lines.push(`- 基础直接上场，不怕进化链被打断`);

      lines.push(`\n### 劣势对局`);
      if (isEvo) lines.push(`- 2阶进化需要3回合，快攻卡组（如猛雷鼓ex）可在此期间抢奖`);
      if (hp <= 280) lines.push(`- HP${hp} 可能被高爆发打手（如喷火龙ex后期）一击秒杀`);
      lines.push(`- 怕 Boss 抓杀关键中间体（进化型卡组的天敌）`);

      lines.push(`\n### 换备建议`);
      lines.push(`- 对抗快攻：换入回复卡（伤药等）+ 更多铺场检索`);
      lines.push(`- 对抗控制：换入换位卡（防Boss抓）`);
      lines.push(`- 对抗特性卡组：换入钥圈儿（锁特性）`);
    }

    lines.push('\n> 组卡组时优先 ⭐ 标记的卡。可进一步用 search_cards/grep_cards 搜索特定方向。');
    return lines.join('\n');
  }

  /**
   * 执行所有机制的搜索，统一去重+评分+分类
   */
  async _searchAllMechanisms(targetData, mechanisms) {
    const allResults = new Map(); // id → { card info + accumulated data }
    const targetId = (targetData['卡牌ID'] || [])[0];
    const targetAttr = targetData['属性'] || '';
    const targetEffects = this._collectEffects(targetData);

    for (const mech of mechanisms) {
      if (!mech.rules || mech.rules.length === 0) continue;
      for (const rule of mech.rules) {
        const result = this.data.grepCards(rule.pattern, rule.cardType, 25);
        for (let i = 0; i < result.results.length; i++) {
          const r = result.results[i];
          if (!r.data || r.id === targetId) continue;

          // 属性兼容性检查
          if (rule.cardType === '宝可梦' && targetAttr) {
            const cardAttr = r.data['属性'] || '';
            const attrName = this._attrCodeToName(targetAttr);
            if (targetEffects.includes(attrName + '宝可梦') && cardAttr && cardAttr !== targetAttr) continue;
          }

          const existing = allResults.get(r.id);
          // 命中位置越靠前分数越高
          const scoreAdd = Math.max(1, result.results.length - i);
          if (existing) {
            existing.score += scoreAdd;
            if (!existing.categories.includes(mech.category)) {
              existing.categories.push(mech.category);
            }
          } else {
            const strProps = this._getStrategicProps(r.data);
            const evidence = this._findEvidence(targetData, r.data, mech.label);
            allResults.set(r.id, {
              id: r.id,
              name: r.data['宝可梦名字'] || r.data['卡牌名字'] || r.id,
              data: r.data,
              score: scoreAdd,
              categories: [mech.category],
              strProps,
              evidence,
              strScore: 0,  // 战略评分
              warning: '',
              incompat: ''
            });
          }
        }
      }
    }

    // 计算战略评分 + 反协同 + HP 阈值
    for (const [id, card] of allResults) {
      card.strScore = this._scoreAttacker(card.strProps);
      card.incompat = this._getIncompatReason(targetData, card.data);
      // HP 阈值警告
      const hp = parseInt(card.data['HP']) || 0;
      if (card.strProps.scaling === '伤指物缩放' && hp > 0 && hp <= 70 && !(card.data['规则']||'').includes('ex')) {
        card.warning = `HP仅${hp}`;
      }
      // 合并类别（取第一个作为主类别）
      card.category = card.categories[0] || 'other';
    }

    // 按战略评分降序排列
    return [...allResults.values()].sort((a, b) => {
      if (b.strScore !== a.strScore) return b.strScore - a.strScore;
      return b.score - a.score;
    });
  }

  // ========== 辅助方法 ==========

  _getStrategicProps(jsonData) {
    const prizes = (jsonData['规则'] || '').includes('ex') || (jsonData['规则'] || '').includes('V') ? 2 : 1;
    const stageMap = { '基础': '基础', '1阶进化': '1阶', '一阶进化': '1阶', '2阶进化': '2阶', '二阶进化': '2阶' };
    const stage = stageMap[jsonData['进化阶段']] || '基础';
    let scaling = '固定';
    const allText = this._collectEffects(jsonData);
    if (allText.includes('伤害指示物') && /[×xX*]|每有|数量|增加/.test(allText)) scaling = '伤指物缩放';
    else if (allText.includes('能量') && /[×xX*]|每有/.test(allText)) scaling = '能量缩放';
    const maxEnergy = this._getMaxEnergy(jsonData);
    return { prizes, stage, scaling, maxEnergy };
  }

  _getMaxEnergy(jsonData) {
    let max = 0;
    for (let i = 1; i <= 4; i++) {
      const s = jsonData[`技能${i}`];
      if (s && Array.isArray(s['消耗'])) {
        const cnt = s['消耗'].filter(c => c !== '无').length;
        if (cnt > max) max = cnt;
      }
    }
    return max;
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

  _attrCodeToName(code) {
    const map = { 'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超', 'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无' };
    return map[code] || code;
  }

  // ========== 评分 ==========

  _scoreAttacker(props) {
    let score = 0;
    if (props.prizes === 1) score += 3;
    if (props.stage === '基础') score += 2;
    if (props.scaling === '伤指物缩放') score += 4;
    else if (props.scaling === '能量缩放') score += 3;
    if (props.maxEnergy <= 2) score += 1;
    return score;
  }

  _findEvidence(targetData, cardData, ruleLabel) {
    const targetText = this._collectEffects(targetData);
    const cardText = this._collectEffects(cardData);
    const targetName = targetData['宝可梦名字'] || targetData['卡牌名字'] || '目标卡';
    const evidences = [];

    if (cardText.includes('伤害指示物')) {
      if (/×|每有|数量.*伤害/.test(cardText))
        evidences.push(`伤害随伤指物缩放——${targetName}提供的伤指物转化为伤害`);
      else
        evidences.push(`与${targetName}的伤指物放置联动`);
    }

    for (let i = 1; i <= 4; i++) {
      const s = cardData[`技能${i}`];
      if (s && Array.isArray(s['消耗'])) {
        const cnt = s['消耗'].filter(c => c !== '无').length;
        if (cnt >= 3) { evidences.push(`「${s['名字']}」需${cnt}能，${targetName}可加速`); break; }
      }
    }

    if (targetText.includes('弃牌区') && cardText.includes('弃牌区'))
      evidences.push('双方利用弃牌区，资源循环');
    if (targetText.includes('备战') && cardText.includes('备战'))
      evidences.push('涉及备战区互动');
    if (cardText.includes('糖果') && !cardData['宝可梦名字'])
      evidences.push('神奇糖果加速进化');
    if (cardText.includes('特性') && (cardText.includes('无效') || cardText.includes('不能使用')))
      evidences.push('可封锁对手特性');

    return evidences.length > 0 ? evidences.join('；') : `匹配: ${ruleLabel}`;
  }

  _getIncompatReason(targetData, cardData) {
    const targetAttr = targetData['属性'] || '';
    const cardAttr = cardData['属性'] || '';
    const targetEffects = this._collectEffects(targetData);
    const attrName = this._attrCodeToName(targetAttr);
    if (targetEffects.includes(attrName + '宝可梦') && cardAttr && cardAttr !== targetAttr) {
      return `仅支持${attrName}系，此卡是${this._attrCodeToName(cardAttr)}系`;
    }
    return '';
  }

  // ========== 泛用卡评分 ==========

  _scoreGeneralCards(targetData, targetEffects, targetAttr) {
    const scored = [];
    const seenNames = new Set();
    const isEvo = (targetData['进化阶段'] || '').includes('2');
    const hasDmgCtr = targetEffects.includes('伤害指示物');
    const hasDiscard = targetEffects.includes('弃牌区') && targetEffects.includes('能量');
    const isPokemon = !!targetData['宝可梦名字'];

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
      if (text.includes('牌库') && /抽出|抽.*张/.test(text)) score += 2;
      if (text.includes('回收') || text.includes('加入手牌')) score += 2;
      if (/战斗场|抓/.test(text)) score += 2;
      if (targetAttr && text.includes(targetAttr + '能量')) score += 3;
      if (!isPokemon && /填能|附着.*能量/.test(text)) score += 3;

      scored.push({ name, id, type, data, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // ========== 卡组分析 ==========

  /**
   * 分析用户卡组 v2：类型分布 + 策略识别 + 能量曲线 + 缺失检测
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
    let totalPokeQty = 0, totalEnergyQty = 0, totalTrainerQty = 0;
    for (const card of deck.cards) {
      const t = card.type || '未知';
      typeCount[t] = (typeCount[t] || 0) + card.quantity;
      if (t === '宝可梦') totalPokeQty += card.quantity;
      else if (t === '基本能量' || t === '特殊能量') totalEnergyQty += card.quantity;
      else totalTrainerQty += card.quantity;
    }

    lines.push(`\n### 类型分布`);
    lines.push(`宝可梦: ${totalPokeQty}张 | 训练家: ${totalTrainerQty}张 | 能量: ${totalEnergyQty}张`);
    for (const [type, count] of Object.entries(typeCount)) {
      lines.push(`- ${type}: ${count} 张`);
    }

    // 策略识别
    lines.push('\n### 策略分析');
    const pokemons = deck.cards.filter(c => c.type === '宝可梦');
    const mainAttackers = pokemons.filter(c => c.quantity >= 3).sort((a, b) => b.quantity - a.quantity);
    if (mainAttackers.length > 0) {
      lines.push(`主力打手: ${mainAttackers.map(c => `${c.name}×${c.quantity}`).join('、')}`);
    }

    // 能量颜色
    const energies = deck.cards.filter(c => c.type === '基本能量' || c.type === '特殊能量');
    const energyNames = [...new Set(energies.map(c => c.name))];
    lines.push(`能量类型: ${energyNames.join('、') || '无'}`);

    // 检测 2 阶进化链完整性
    const stage2Pokes = pokemons.filter(c => c.name.includes('ex') && c.quantity >= 2);
    if (stage2Pokes.length > 0) {
      lines.push(`核心进化线: ${stage2Pokes.map(c => c.name).join('、')}`);
    }

    // 检测问题
    const issues = [];
    if (deck.totalCount !== 60) issues.push(`⚠ 卡组 ${deck.totalCount} 张（应为 60）`);
    if (totalPokeQty < 12) issues.push(`⚠ 宝可梦 ${totalPokeQty} 张偏少（建议 12-20）`);
    if (totalPokeQty > 24) issues.push(`⚠ 宝可梦 ${totalPokeQty} 张偏多`);
    if (totalEnergyQty < 8) issues.push(`⚠ 能量 ${totalEnergyQty} 张偏少（建议 8-14）`);
    if (totalEnergyQty > 16) issues.push(`⚠ 能量 ${totalEnergyQty} 张偏多`);
    // 检查是否有换位卡
    const hasSwitch = deck.cards.some(c =>
      c.type === '物品' && /交换|交替|换位|互换/.test(c.name));
    if (!hasSwitch) issues.push('💡 建议添加换位卡（互换推车等）');

    if (issues.length > 0) {
      lines.push('\n### 诊断');
      issues.forEach(i => lines.push(i));
    }

    // 进化链检查
    const evolveLines = this._detectEvoLines(deck);
    if (evolveLines.length > 0) {
      lines.push('\n### 进化线');
      evolveLines.forEach(l => lines.push(l));
    }

    lines.push('\n---');
    lines.push('> 如需深度分析，可以问 AI：「分析我的卡组，找出不足和改进方向」');

    return lines.join('\n');
  }

  _detectEvoLines(deck) {
    const pokemons = deck.cards.filter(c => c.type === '宝可梦');
    if (pokemons.length < 3) return [];
    const lines = [];
    // 简单检测：同名前缀匹配
    const groups = {};
    for (const p of pokemons) {
      const base = p.name.replace(/ex|V$|VSTAR|VMAX|GX/gi, '').trim();
      if (!groups[base]) groups[base] = [];
      groups[base].push(p);
    }
    for (const [base, cards] of Object.entries(groups)) {
      if (cards.length >= 3) {
        lines.push(`- ${base}线: ${cards.map(c => `${c.name}×${c.quantity}`).join(' → ')}`);
      }
    }
    return lines;
  }
}
