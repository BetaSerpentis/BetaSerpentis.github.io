// js/core/CardResolver.js
import { parseEffect } from './EffectParser.js';

const DATA_FILES = [
  { path: '../ptcg/data/pokemon-cards.json',     nameField: '宝可梦名字', numberField: '编号', type: 'pokemon' },
  { path: '../ptcg/data/Item-cards.json',          nameField: '卡牌名字', numberField: null, type: 'item' },
  { path: '../ptcg/data/Supporter-cards.json',     nameField: '卡牌名字', numberField: null, type: 'supporter' },
  { path: '../ptcg/data/Stadium-cards.json',       nameField: '卡牌名字', numberField: null, type: 'stadium' },
  { path: '../ptcg/data/PokemonTool-cards.json',   nameField: '卡牌名字', numberField: null, type: 'tool' },
  { path: '../ptcg/data/BasicEnergy-cards.json',   nameField: '卡牌名字', numberField: null, type: 'energy' },
  { path: '../ptcg/data/SpecialEnergy-cards.json', nameField: '卡牌名字', numberField: null, type: 'specialEnergy' },
];

const ELEM = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting',
               '恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };
const REV_ELEM = { grass:'草',fire:'火',water:'水',lightning:'雷',fighting:'斗',dark:'恶',metal:'钢',psychic:'超',colorless:'无',dragon:'龙',fairy:'妖' };
const CACHE_KEY = 'ptcg_names_v3';

export class CardResolver {
  constructor() {
    this.map = null; this.raw = {}; this.compiled = {};
    this.loaded = false; this.loading = null;
  }

  async load() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this._load(); await this.loading; this.loading = null;
  }

  async _load() {
    let skipBuild = false;
    try {
      const c = localStorage.getItem(CACHE_KEY);
      if (c) { const d = JSON.parse(c); if (Array.isArray(d)&&d.length>100) { this.map=new Map(d); skipBuild=true; } }
    } catch(e){}
    if (!this.map) this.map = new Map();

    for (const f of DATA_FILES) {
      try {
        const r = await fetch(f.path); if (!r.ok) continue;
        const cards = await r.json();
        for (const raw of cards) {
          const ids = raw['卡牌ID']||[];
          if (!skipBuild) {
            const entry = { name:raw[f.nameField]||'未知', number:f.numberField?(raw[f.numberField]||null):null, type:f.type };
            for (const id of ids) if (!this.map.has(id)) this.map.set(id, entry);
          }
          for (const id of ids) { if (!this.raw[id]) this.raw[id]={...raw,_t:f.type}; }
        }
      } catch(e){ console.warn('[CR] skip',f.path); }
    }
    this.loaded = true;
    if (!skipBuild) try{ localStorage.setItem(CACHE_KEY,JSON.stringify([...this.map])); }catch(e){}
  }

  getName(id){ const i=this.map?.get(String(id)); return i?i.name:'#'+id; }
  getNumber(id){ return this.map?.get(String(id))?.number??null; }
  getType(id){ return this.map?.get(String(id))?.type??'unknown'; }
  getInfo(id){ return this.map?.get(String(id))||{name:'#'+id,number:null,type:'unknown'}; }

  getCard(id){
    const sid=String(id);
    if(this.compiled[sid]) return this.compiled[sid];
    const raw=this.raw[sid];
    if(!raw) return null;
    const card=raw._t==='pokemon'?this._pokemon(raw):
      (['item','supporter','stadium','tool'].includes(raw._t)?this._trainer(raw):this._energy(raw));
    this.compiled[sid]=card;
    return card;
  }

  _pokemon(r){
    const attacks=[];
    for(const k of['技能1','技能2','技能3','技能4']){
      const s=r[k]; if(!s||!s['名字']) continue;
      const parsed = parseEffect(s['效果']||'');
      attacks.push({ name:s['名字'], cost:(s['消耗']||[]).map(c=>ELEM[c]||'colorless'),
        damage:parseInt(String(s['伤害']).match(/\d+/)?.[0]||'0'),
        effect:s['效果']||'', effects:parsed.effects });
    }
    const abilityText = r['特性效果']||'';
    const abilityParsed = parseEffect(abilityText);
    const abilityActive = /可使用1次|可使用/.test(abilityText);
    const ability = r['特性名字'] ? { name:r['特性名字'], effect:abilityText, effects:abilityParsed.effects,
      active:abilityActive, passive:!abilityActive, oncePerTurn:/可使用1次/.test(abilityText), zone:this._abilityZone(abilityText) } : null;
    const ruleText = r['规则'] || '';
    const rule2Text = r['规则2'] || '';
    const ruleBox = [ruleText, rule2Text].filter(Boolean).join(' ');
    const name = r['宝可梦名字'] || '未知';
    const isEx = /(?:宝可梦)?【?ex】?|\bex\b/i.test(`${name} ${ruleBox}`);
    const isRadiant = /光辉宝可梦|^光辉/.test(`${name} ${ruleBox}`);
    const hasRuleBox = isEx || isRadiant || /(?:宝可梦)?(?:GX|V|VMAX|VSTAR|BREAK)\b|拥有规则的宝可梦|规则宝可梦|太晶/i.test(`${name} ${ruleBox}`);
    return { cardType:'pokemon', name, number:r['编号']||null,
      stage:r['进化阶段']||'基础', evolvesFrom:r['进化自']||null,
      ruleText, rule2Text, ruleBox, isEx, isRadiant, hasRuleBox,
      hp:parseInt(r['HP'])||60, element:ELEM[r['属性']]||'colorless',
      weakness:r['弱点']? (ELEM[r['弱点']]||r['弱点']) : null, resistance:r['抵抗力']? (ELEM[r['抵抗力']]||r['抵抗力']) : null,
      retreatCost:Number.isFinite(parseInt(r['撤退'],10))?parseInt(r['撤退'],10):1,
      ability, attacks };
  }

  _abilityZone(text){
    if(/手牌只有这1张卡|从手牌使出这张卡|在手牌/.test(text))return 'hand';
    if(/弃牌区/.test(text)&&(/这张卡|可使用/.test(text)))return 'discard';
    if(/在备战区/.test(text))return 'bench';
    if(/在战斗场上|战斗场上/.test(text))return 'active';
    return 'field';
  }

  _trainer(r){
    const parsed = parseEffect(r['效果']||'');
    return { cardType:'trainer', trainerType:r._t, name:r['卡牌名字']||'未知',
      effectText:r['效果']||'', effects:parsed.effects, unparsed:parsed.unparsed };
  }

  _energy(r){ const m=(r['卡牌名字']||'').match(/【(.+?)】/);
    const parsed = parseEffect(r['效果']||'');
    const name = r['卡牌名字']||'未知';
    const effectText = r['效果']||'';
    return { cardType:r._t==='specialEnergy'?'specialEnergy':'energy', name, element:m?m[1]:null,
      provides:this._energyProvidesMeta(name,effectText,r._t), specialRules:this._energySpecialRules(name,effectText),
      effectText, effects:parsed.effects, unparsed:parsed.unparsed }; }

  _energyProvidesMeta(name,text,type){
    if(type!=='specialEnergy') return [{types:[ELEM[name.match(/【(.+?)】/)?.[1]]||'colorless'],count:1}];
    const provides=[];
    if(/提供(\d+)个所有属性/.test(text)||/视为提供(\d+)个所有属性/.test(text)){
      const count=parseInt((text.match(/(?:提供|视为提供)(\d+)个所有属性/)||[])[1]||'1');
      provides.push({types:['any'],count});
    }
    for(const m of text.matchAll(/(?:提供|视为提供)(\d+)个【(.+?)】能量/g)){
      provides.push({types:[ELEM[m[2]]||'colorless'],count:parseInt(m[1])||1});
    }
    for(const m of text.matchAll(/(?:提供|视为提供)(\d+)个((?:【.+?】){2,})\d*种属性的能量/g)){
      const types=[...m[2].matchAll(/【(.+?)】/g)].map(x=>ELEM[x[1]]||'colorless');
      provides.push({types,count:parseInt(m[1])||1});
    }
    if(provides.length===0) provides.push({types:['colorless'],count:1});
    // Prefer the broadest/highest yield option for current simplified runtime.
    provides.sort((a,b)=>(b.count-a.count)||(b.types.length-a.types.length));
    return provides;
  }

  _energySpecialRules(name,text){
    return {
      damageOnAttach:/放置1个伤害指示物/.test(text)?10:0,
      drawOnAttach:parseInt((text.match(/抽出(\d+)张/)||[])[1]||'0'),
      preventWeakness:/弱点全部消除/.test(text),
      retreatCostZero:/【撤退】所需的能量全部消除/.test(text),
      damageBonus:parseInt((text.match(/伤害["“]?\+(\d+)["”]?点/)||[])[1]||'0'),
      damageReduction:parseInt((text.match(/伤害["“]?-(\d+)["”]?点/)||[])[1]||'0'),
      maxHpBonus:parseInt((text.match(/最大HP增加["“]?(\d+)["”]?/)||[])[1]||'0'),
      blockSpecialCondition:/不会陷入特殊状态/.test(text),
      blockAttackEffects:/不会受到对手的宝可梦使用招式的效果/.test(text),
      recycleToHand:/不会丢到弃牌区，而是放回手牌/.test(text),
      discardAtTurnEnd:/附上的回合结束时丢到弃牌区/.test(text),
      requireEvolution:/只可附于进化宝可梦身上/.test(text),
      requiresDiscardOnAttach:/必须将自己的1张手牌丢弃/.test(text),
    };
  }
}
