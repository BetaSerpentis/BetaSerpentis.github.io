// js/core/GameState.js — (含能量+进化+特性)

export const PHASE = { SETUP:'setup',DRAW:'draw',MAIN:'main',BATTLE:'battle',END:'end',GAME_OVER:'game_over' };
export const MAX_LOG_ENTRIES = 200;

/**
 * 卡牌引用规范化：手牌/牌库/弃牌区统一存「卡牌 ID」。
 * 背景下：弃能量等操作曾把能量对象直接 push 进弃牌区，
 * 回收（如「夜间担架」）后对象进了手牌，UI 按 ID 查不到就显示成「未知」。
 */
export function toCardRef(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return value.cardId ?? value.id ?? value.name ?? null;
  return value;
}

/**
 * 选择（waitForPick）的合法返回边界。
 * 玩家 UI（main.js）与 AI 决策（AiPolicy）共用同一份推导，避免出现非法返回值。
 */
export function derivePickBounds(pick = {}) {
  const options = pick?.options || {};
  const cardsLen = (pick.cards || []).length;
  const requested = Number.isFinite(pick.count) ? pick.count : 1;
  if (options.source === 'retreat-energy') return { min:0, max:cardsLen, allowEmpty:true, allowFewer:true };
  const rawMax = Number.isFinite(options.maxCount) ? options.maxCount : requested;
  const max = Math.max(0, Math.min(rawMax, cardsLen));
  let min;
  if (Number.isFinite(options.minCount)) min = options.minCount;
  else if (Number.isFinite(options.requiredMin)) min = options.requiredMin;
  else if (options.allowEmpty) min = 0;
  else if (options.allowFewer) min = max > 0 ? 1 : 0;
  else min = Math.min(requested, cardsLen);
  min = Math.max(0, Math.min(min, max));
  return { min, max, allowEmpty:min === 0, allowFewer:!!options.allowFewer || min < max };
}

const TYPE_CN = { grass:'草',fire:'火',water:'水',lightning:'雷',psychic:'超',fighting:'斗',dark:'恶',metal:'钢',dragon:'龙',fairy:'妖',colorless:'无' };
const TYPE_EN = Object.fromEntries(Object.entries(TYPE_CN).map(([k,v])=>[v,k]));

/** 备战区上限（与 placeBench 的判定保持一致） */
const BENCH_MAX = 5;

/**
 * 「必须放到备战区」的动作：备战区已满时这类效果无法执行。
 * 需求：竞技场「深钵镇」、物品「巢穴球」这类把宝可梦放到场上的效果，
 * 在备战区已满时**不能空发**，使用前就应该置灰。
 * 注意只列“放置到备战区”的动作；switch_active_basic_heal_bench（换位）不需要空位。
 */
const BENCH_SLOT_ACTIONS = new Set(['search_deck_to_bench', 'discard_to_bench', 'place_self_to_bench']);

/** 附带动作：不影响「这张卡能不能用」的判断（如检索后必然附带的重洗牌库） */
const INCIDENTAL_ACTIONS = new Set(['shuffle_deck']);

export class PlayerState {
  constructor(name){this.name=name;this.deck=[];this.hand=[];this.discard=[];this.prizes=[];this.active=null;this.bench=[];
    // 放逐区：与弃牌区**分开**的区域。放进去的卡不能被回收（部分卡的效果以此为条件）。
    this.lostZone=[];
    this.stadium=null;this.supporterUsed=false;this.energyAttached=false;this.retreatUsed=false;this.stadiumPlayedThisTurn=false;this.abilityUsedThisTurn={};this.stadiumUsedThisTurn={};this.turnAttackModifiers=[];this.extraTurnPending=false;}
  draw(n=1){const d=[];for(let i=n;i>0&&this.deck.length;i--){const c=this.deck.pop();this.hand.push(c);d.push(c);}return d;}
}

export class GameState {
  constructor(){this.player1=new PlayerState('玩家');this.player2=new PlayerState('对手');
    this.currentPlayer=this.player1;this.phase=PHASE.SETUP;this.turn=0;this.log=[];this.winner=null;this.temporaryAbilityLocks=[];
    this.firstPlayer=null;this.firstPlayerFirstTurnInProgress=false;
    this.stadium=null;this.pendingPick=null;this.pendingPokemonPick=null;this.knockoutHistory=[];}

  _applyTurnAttackModifiers(attacker,defender,move,pl){let total=0;
    for(const mod of pl?.turnAttackModifiers||[]){
      if((mod.target==='own_field'||mod.target==='field')&&!this.getPokemonInPlay(pl).includes(attacker))continue;
      if(mod.defender==='opponent_active'&&defender!==this.getOpponent(pl)?.active)continue;
      if(mod.defenderRule&&!this._isRuleMon(defender,mod.defenderRule))continue;
      total+=mod.amount||0;
    }
    return total;}

  waitForPick(cards,count,options={}){return new Promise(r=>{
    this.pendingPick={cards,count,options,resolve:r};
    // AI 决策路由：AI 回合（或自动对战）由策略直接应答，避免 Promise 永不 resolve 把回合卡死
    const handler=this.aiPickHandler;
    if(handler){
      Promise.resolve()
        .then(()=>handler(this.pendingPick))
        .then(sel=>this.resolvePick(Array.isArray(sel)?sel:[]))
        .catch(()=>this.resolvePick([]));
      return;
    }
    this._onPendingPick?.(this.pendingPick);
  });}
  waitForPokemonPick(player, options={}){return new Promise(r=>{
    this.pendingPokemonPick={player,options,resolve:r};
    const handler=this.aiPokemonPickHandler;
    if(handler){
      Promise.resolve()
        .then(()=>handler(this.pendingPokemonPick))
        .then(slot=>this.resolvePokemonPick(slot||null))
        .catch(()=>this.resolvePokemonPick(null));
      return;
    }
    this._onPendingPokemonPick?.(this.pendingPokemonPick);
  });}
  resolvePokemonPick(slot){if(this.pendingPokemonPick){const r=this.pendingPokemonPick.resolve;this.pendingPokemonPick=null;r(slot);}}
  resolvePick(selected){if(this.pendingPick){const r=this.pendingPick.resolve;this.pendingPick=null;r(selected);}}

  init(p1,p2){for(const pl of[this.player1,this.player2]){pl.hand=[];pl.discard=[];pl.active=null;pl.bench=[];pl.stadium=null;pl.abilityUsedThisTurn={};pl.stadiumUsedThisTurn={};}
    this.stadium=null;
    this.player1.deck=this._shuffle([...p1]);this.player2.deck=this._shuffle([...p2]);
    this.player1.prizes=this.player1.deck.splice(-6,6);this.player2.prizes=this.player2.deck.splice(-6,6);
    this.player1.draw(7);this.player2.draw(7);
    this.turn=0;this.phase=PHASE.SETUP;this.winner=null;this.log=[];this.currentPlayer=this.player1;this.temporaryAbilityLocks=[];
    this.firstPlayer=null;this.firstPlayerFirstTurnInProgress=false;this.knockoutHistory=[];this.mulliganCount={player1:0,player2:0};
    this.addLog('请放置1只基础宝可梦到战斗区');}

  setPhase(p){this.phase=p;}
  nextPhase(){const o=[PHASE.DRAW,PHASE.MAIN,PHASE.BATTLE,PHASE.END];const i=o.indexOf(this.phase);
    i>=0&&i<o.length-1?this.setPhase(o[i+1]):(i===o.length-1&&this.endTurn());}

  endTurn(){
    // 0. 「在下个对手的回合结束时，受到这个招式影响的宝可梦会【昏厥】」
    //    标记打在受影响方身上、此刻正好轮到它自己的回合结束 → 在这里结算，随后再走常规清理。
    {
      for (const mon of [this.currentPlayer.active, ...(this.currentPlayer.bench || [])]) {
        if (!mon || !mon.delayedKoAtOppTurnEnd) continue;
        mon.delayedKoAtOppTurnEnd = 0;
        const isActive = this.currentPlayer.active === mon;
        this.addLog(`${mon.name} 的延迟昏厥结算`);
        if (isActive) {
          this.knockout(this.currentPlayer);
        } else {
          // 备战区：直接进弃牌区（备战位昏迷不拿奖赏卡）
          const bi = this.currentPlayer.bench.indexOf(mon);
          if (bi >= 0) this.currentPlayer.bench.splice(bi, 1);
          this.currentPlayer.discard.push(mon.cardId);
          for (const e of (mon.energy || [])) this.currentPlayer.discard.push(this._toolCardValue(e));
          if (mon.tool) this.currentPlayer.discard.push(this._toolCardValue(mon.tool));
          this.addLog(`${mon.name} 被昏厥（备战区）`);
        }
        this.recomputePassives?.();
        if (this.phase === PHASE.GAME_OVER) return;
      }
    }
    // 1. 清除结束回合玩家的每回合临时效果
    //    例外：「在下一个对手的回合不受到招式的伤害和效果影响」（如大岩蛇「坚硬头锤」掷硬币正面）
    //    生效窗口是**对手的下一个回合**，所以不能在自己回合结束时就清掉，
    //    否则轮到对手时防护已经没了（曾因此被对手正常打伤）。
    for(const mon of[this.currentPlayer.active,...this.currentPlayer.bench]){
      if(!mon)continue;
      if(!mon.attackShieldArmed){mon.preventDamage=false;mon.preventEffect=false;mon.damageFlipShieldArmed=false;}
      mon.damageMod=0;mon.damageReceivedMod=0;
      mon.cannotAttackNext=false;mon.cannotRetreat=false;mon.ignore=[];
      // 「在下个对手的回合，受到这个招式影响的宝可梦在使用招式时…出现反面则那个招式失败」
      // 标记打在**受影响方**身上；放在这个循环里（结束回合方的宝可梦）清理，
      // 时序正好：我在自己回合标记对手的宝可梦 → 我回合结束时不会清（它不是 currentPlayer 的）
      // → 对手回合内一直有效 → 对手回合结束时被清掉。
      mon.coinFailAttackNext=0;
      mon.delayedKoAtOppTurnEnd=0;
      mon.noHandEnergyNext=0;
      mon.costEliminated=false;mon.abilityUsed=false;
    }
    // 1.1 对手身上「活到对手回合结束」的防护：刚结束的这个回合就是它的生效窗口 → 到期清除
    {
      const other=this.getOpponent(this.currentPlayer);
      for(const mon of[other.active,...other.bench]){
        if(!mon||!mon.attackShieldArmed)continue;
        mon.attackShieldArmed=false;
        mon.preventDamage=false;mon.preventEffect=false;mon.damageFlipShieldArmed=false;
        this.addLog(`${mon.name} 的招式防护已结束`);
      }
    }
    // 1.6 清除「反射屏障」类反伤标记：只在“下个对手回合”有效，
    //     所以对手回合结束时（currentPlayer 不是标记所有者）清除
    for(const pl of[this.player1,this.player2]){
      if(pl===this.currentPlayer)continue;
      for(const mon of[pl.active,...(pl.bench||[])])if(mon)mon.mirrorDamageCounters=false;
    }
    // 2. 回合间检查（Pokémon Checkup）：双方出战宝可梦的中毒/灼伤/睡眠；结束方麻痹回合末恢复
    for(const pl of [this.player1, this.player2]){
      const mon=pl.active;
      if(!mon||!mon.status)continue;
      // 「因这个【中毒】而放置的伤害指示物数量变为N个」→ 每次检查放 N 个指示物（默认 1 个 = 10 点）
      if(mon.status.includes('poison')){let pd=10*(mon.poisonCounters||1);for(const {params:q} of this._passiveEffectsFor(this.getOpponent(pl).active,'poison_damage_increase')){pd+=(q.amount||0)*10;}mon.hp-=pd;this.addLog(`${mon.name} 中毒 -${pd}${mon.poisonCounters>1?`（${mon.poisonCounters}个指示物）`:''}`);}
      if(mon.status.includes('burn')){
        if(Math.random()<0.5){mon.status=mon.status.split(',').filter(s=>s!=='burn').join(',')||null;this.addLog(`${mon.name} 灼伤恢复`);}
        else{mon.hp-=20;this.addLog(`${mon.name} 灼伤 -20`);}
      }
      if(mon.status&&mon.status.includes('sleep')&&Math.random()<0.5){mon.status=mon.status.split(',').filter(s=>s!=='sleep').join(',')||null;this.addLog(`${mon.name} 睡眠恢复`);}
      if(pl===this.currentPlayer&&mon.status&&mon.status.includes('paralysis')){mon.status=mon.status.split(',').filter(s=>s!=='paralysis').join(',')||null;this.addLog(`${mon.name} 麻痹恢复`);}
      if(mon.hp<=0){this.knockout(pl);}
    }
    this.emitTriggerEvent('checkup',{});
    // 「在自己的回合结束时」/「对手的回合结束时」触发（特性：光辉妙蛙花/雄伟牙ex/弱丁鱼）
    // payload.player = 正在结束回合的一方，由 _shouldTrigger 决定各玩家哪些宝可梦能收到
    this.emitTriggerEvent('turn_end',{player:this.currentPlayer});
    this.emitTriggerEvent('opponent_turn_end',{player:this.currentPlayer});
    // 支援者的「使用了这张卡牌的回合结束时」延迟效果（青绿的战略/莉莉艾的全力/纳莉）
    // 注意：endTurn 是同步流程，这里只取出登记项，实际执行由 _runEffects 异步进行（目标玩家已固定，
    // 所以即使晚一个 tick 结算，作用对象与结果都正确）。
    {
      const all=this.pendingTurnEnd||[];
      const mine=all.filter(x=>x.player===this.currentPlayer);
      this.pendingTurnEnd=all.filter(x=>x.player!==this.currentPlayer);
      for(const entry of mine)this._runEffects?.(entry.player,entry.effects);
    }
    // 1.5' 「回合结束时自动弃置」类道具：
    //   - 自己的回合结束时（招式学习器类，action=tool_end_of_turn_discard）→ 结束回合的这一方
    //   - 对手的回合结束时（金属核心屏障/巨型炸弹，tool_opponent_turn_end_discard）→ 另一方
    // ⚠️ 必须放在 checkup **之后**：文柚果/木子果/应急果冻 是「双方的回合结束时」触发的，
    //    先弃卡就再也触发不了了（原实现把这段放在 checkup 之前，属于顺序错误）。
    for(const [owner,marker] of [[this.currentPlayer,'tool_end_of_turn_discard'],[this.getOpponent(this.currentPlayer),'tool_opponent_turn_end_discard']]){
      for(const mon of[owner.active,...(owner.bench||[])]){
        if(!mon?.tool)continue;
        const toolEffects=Array.isArray(mon.tool.effects)?mon.tool.effects:[];
        if(!toolEffects.some(e=>e.action===marker))continue;
        owner.discard.push(this._toolCardValue(mon.tool));
        this.addLog(`${mon.name} 身上的「${this._toolLabel(mon.tool)}」被放入弃牌区`);
        mon.tool=null;
      }
    }
    if(this.firstPlayerFirstTurnInProgress&&this.currentPlayer===this.firstPlayer)this.firstPlayerFirstTurnInProgress=false;
    this.currentPlayer.coinChoiceArmed=false; // 一树：只在使用的那个回合有效
    this.currentPlayer.supporterUsed=false;this.currentPlayer.energyAttached=false;this.currentPlayer.retreatUsed=false;this.currentPlayer.stadiumPlayedThisTurn=false;this.currentPlayer.abilityUsedThisTurn={};this.currentPlayer.stadiumUsedThisTurn={};this.currentPlayer.turnAttackModifiers=[];
    this.currentPlayer.playRestrictions=null;
    this.temporaryAbilityLocks=(this.temporaryAbilityLocks||[]).filter(lock=>lock.expires!=='turn'&&lock.owner!==this.currentPlayer);
    for(const mon of[this.currentPlayer.active,...this.currentPlayer.bench]){if(mon){mon.placedThisTurn=false;mon.evolvedThisTurn=false;mon.cameFromBenchThisTurn=false;}}
    // ⑩「当这个回合结束时，自己的回合会再开始1次」——VSTAR 力量等给的额外回合：
    //    此时**不切换** currentPlayer，直接再开一轮自己的回合（回合数照常 +1，抽牌/牌库耗尽判定照旧）。
    if(this.currentPlayer.extraTurnPending){
      this.currentPlayer.extraTurnPending=false;
      this.addLog(`${this.currentPlayer.name} 的回合再次开始（额外回合）`);
    }else{
      this.currentPlayer=(this.currentPlayer===this.player1)?this.player2:this.player1;
    }
    this.turn++;this.setPhase(PHASE.DRAW);this.addLog(`第${this.turn}回合 — ${this.currentPlayer.name}`);
    if(this.currentPlayer.deck.length===0){this.winner=this.getOpponent(this.currentPlayer);this.phase=PHASE.GAME_OVER;this.addLog(`${this.currentPlayer.name} 牌库抽干，${this.winner.name} 胜利！`);}
    else{this.currentPlayer.draw(1);}
    this.recomputePassives();}

  _makeMon(cid,cd,n,hp){return {cardId:cid,name:n,hp,maxHp:hp,element:cd?.element||'colorless',weakness:cd?.weakness||null,resistance:cd?.resistance||null,weaknessMultiplier:cd?.weaknessMultiplier||2,resistanceValue:cd?.resistanceValue??-30,
    stage:cd?.stage||'基础',evolvesFrom:cd?.evolvesFrom||null,ruleText:cd?.ruleText||'',rule2Text:cd?.rule2Text||'',ruleBox:cd?.ruleBox||'',
    isEx:!!cd?.isEx,isRadiant:!!cd?.isRadiant,hasRuleBox:!!cd?.hasRuleBox,
    attacks:cd?.attacks||[{name:'撞击',damage:20,cost:[],effect:''}],energy:[],status:null,placedThisTurn:true,evolvedThisTurn:false,
    tool:null,ability:cd?.ability||null,abilityUsed:false,abilityDisabled:false,abilityDisabledBy:null,damageMod:0,damageReceivedMod:0,preventDamage:false,preventEffect:false,cannotAttackNext:false,cannotRetreat:false,coinFailAttackNext:0,delayedKoAtOppTurnEnd:0,noHandEnergyNext:0,
    ignore:[],costEliminated:false,retreatCost:cd?.retreatCost??1};}

  placeActive(pl,idx,cd=null){
    if(cd?.cardType==='pokemon'&&cd.stage&&cd.stage!=='基础'){this.addLog('只能将基础宝可梦直接放到战斗区');return null;}
    const cid=pl.hand.splice(idx,1)[0];const n=cd?.name||'???',hp=cd?.hp||80;
    pl.active=this._makeMon(cid,cd,n,hp);
    this.addLog(`${pl.name} 放置 ${n} 到战斗区`);this.recomputePassives();return pl.active;}

  placeBench(pl,idx,cd=null){if(pl.bench.length>=5){this.addLog('后备区已满');return null;}
    if(cd?.cardType==='pokemon'&&cd.stage&&cd.stage!=='基础'){this.addLog('只能将基础宝可梦直接放到后备区');return null;}
    const cid=pl.hand.splice(idx,1)[0];const n=cd?.name||'???',hp=cd?.hp||80;
    const mon=this._makeMon(cid,cd,n,hp);
    pl.bench.push(mon);this.addLog(`${pl.name} 放置 ${n} 到后备区`);this.recomputePassives();return mon;}

  attachEnergy(pl,idx,cd,slot){if(pl.energyAttached){this.addLog('已附着过能量');return false;}
    if(!cd||(cd.cardType!=='energy'&&cd.cardType!=='specialEnergy')){this.addLog('不是能量卡');return false;}
    const t=slot==='active'?pl.active:(slot?.startsWith('bench-')?pl.bench[parseInt(slot.replace('bench-',''))]:null);
    if(!t){this.addLog('目标不存在');return false;}
    // ⑨「在下个对手的回合，无法从手牌将能量附于受到这个招式影响的宝可梦身上」→ 宝可梦级
    if(t.noHandEnergyNext){this.addLog(`${t.name} 下回合无法从手牌被附着能量`);return false;}
    // ⑨「对手无法从手牌使出并附着特殊能量」→ 玩家级（只拦特殊能量）
    if(cd.cardType==='specialEnergy'&&pl.playRestrictions?.specialAttach){this.addLog('下回合无法从手牌附着特殊能量');return false;}
    if(cd.specialRules?.requiresDiscardOnAttach&&pl.hand.length<=1){this.addLog('需要先丢弃1张其他手牌');return false;}
    const attached=pl.hand.splice(idx,1)[0];
    if(cd.specialRules?.requiresDiscardOnAttach&&pl.hand.length>0)pl.discard.push(pl.hand.pop());
    // 尖钉能量类：把「受到招式伤害时给攻击方放置 N 个伤害指示物」记到能量实例上，
    // 后续在 BattleEngine.attack 里结算反伤（能量离场时自动失效）
    const reflectCounters=(cd.effects||[])
      .filter(e=>e.action==='attack_reflect_counters')
      .reduce((sum,e)=>sum+(e.params?.counters||0),0);
    t.energy.push({cardId:attached,name:cd.name,provides:cd.provides||null,specialRules:cd.specialRules||null,attackReflectCounters:reflectCounters||undefined});
    if(cd.specialRules?.damageOnAttach){t.hp-=cd.specialRules.damageOnAttach;this.addLog(`${t.name} 因 ${cd.name} 受到${cd.specialRules.damageOnAttach}伤害`);}
    if(cd.specialRules?.maxHpBonus&&(!cd.element||t.element===cd.element||cd.name.includes(t.element))){t.maxHp+=cd.specialRules.maxHpBonus;t.hp+=cd.specialRules.maxHpBonus;}
    if(cd.specialRules?.preventWeakness)t.weakness=null;
    if(cd.specialRules?.retreatCostZero)t.retreatCostOverride=0;
    if(cd.specialRules?.blockAttackEffects)t.preventEffect=true;
    if(cd.specialRules?.blockSpecialCondition)t.status=null;
    pl.energyAttached=true;
    // fromHand / cardName 供触发条件判定：
    // attachEnergy 的能量一定来自手牌（下面 splice 的就是 pl.hand），
    // 「每次从自己的手牌将【X】能量附着于这只宝可梦身上时」这类特性要靠它区分。
    this.addLog(`${pl.name} 为 ${t.name} 附着了 ${cd.name}`);this.emitTriggerEvent('energy_attached',{target:t,owner:pl,fromHand:true,cardName:cd?.name||''});return true;}

  checkEnergy(mon,ai){const a=this.getAttacks(mon)[ai];if(!a||!a.cost||a.cost.length===0)return true;
    return this._canPayEnergyCost(mon,this.adjustedAttackCost(mon,a));}
  adjustedAttackCost(mon,attack){let adjusted=this._adjustAttackCostForPassives(mon,attack?.cost||[],attack);const inc=(mon?.attackCostIncrease||0)+this._passiveAttackCostIncrease(mon);for(let i=0;i<inc;i++)adjusted.push('colorless');return adjusted;}
  _adjustAttackCostForPassives(mon,cost,attack=null){let adjusted=[...(cost||[])];
    const owner=[this.player1,this.player2].find(pl=>this.getPokemonInPlay(pl).includes(mon));
    if(!owner)return adjusted;
    for(const source of this.getPokemonInPlay(owner)){
      if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
      for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='attack_cost_reduction')){
        const p=eff.params||{};
        if((p.target==='self'||p.target==='this')&&source!==mon)continue;
        const type=this._normalizeType(p.type||'colorless');
        let amount=p.amount==='opponent_prizes_taken'?this._prizesTaken(this.getOpponent(owner)):(p.amount||0);
        while(amount>0){const idx=adjusted.indexOf(type);if(idx<0)break;adjusted.splice(idx,1);amount--;}
      }
    }
    return adjusted;}
  _prizesTaken(pl){return Math.max(0,6-(pl?.prizes?.length??6));}
  _passiveAttackCostIncrease(mon){let total=0;const owner=[this.player1,this.player2].find(pl=>this.getPokemonInPlay(pl).includes(mon));if(!owner)return 0;const opp=this.getOpponent(owner);for(const source of this.getPokemonInPlay(opp)){if(!source?.ability?.effects?.length||source.abilityDisabled)continue;for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='attack_cost_increase')){const p=eff.params||{};if(p.target==='opponent_active'&&mon!==owner.active)continue;total+=p.amount||0;}}return total;}

  _energyProvides(energy,mon=null){
    let base;
    if(typeof energy==='object'&&energy.provides)base=energy.provides.flatMap(p=>Array.from({length:p.count||1},()=>p.types));
    else{const s=String(typeof energy==='object'?energy.name:energy);const keys=TYPE_CN;
      const provides=[];for(const [k,cn] of Object.entries(keys)){if(s.includes(k)||s.includes(cn))provides.push([k]);}if(s.includes('特殊')||s.includes('任意')||provides.length===0)provides.push(['colorless']);base=provides;}
    if(!mon)return base;
    let out=base;
    for(const eff of this._energyMultiplierEffectsFor(mon)){
      const type=this._normalizeType(eff.params?.energyType||eff.params?.type||mon.element);
      const mult=eff.params?.multiplier||2;
      const name=String(typeof energy==='object'?energy.name:energy);
      if(eff.params?.basicOnly&&!name.includes('基本'))continue;
      const target=eff.params?.target||'self';
      if(target==='self'&&!this._energyMatchesType(out,type))continue;
      const next=[];
      for(const provides of out){
        if(provides.includes(type)||provides.includes('any'))for(let i=0;i<mult;i++)next.push([type]);
        else next.push(provides);
      }
      out=next;
    }
    return out;}
  _canPayEnergyCost(mon,cost){const avail=(mon.energy||[]).flatMap(e=>this._energyProvides(e,mon));
    for(const r of cost){let idx=-1;if(r==='colorless')idx=avail.findIndex(p=>p.length>0);else idx=avail.findIndex(p=>p.includes(r)||p.includes('any'));
      if(idx<0)return false;avail.splice(idx,1);}return true;}
  _energyUnitsForRetreat(energy,mon){return Math.max(0,(this._energyProvides(energy,mon)||[]).length);}
  _canSelectedEnergyPayRetreat(mon,cost,selectedIndices){
    const energy=mon.energy||[];const seen=new Set();let units=0;
    for(const raw of selectedIndices||[]){const idx=Number(raw);if(!Number.isInteger(idx)||idx<0||idx>=energy.length||seen.has(idx))return false;seen.add(idx);units+=this._energyUnitsForRetreat(energy[idx],mon);}
    return units>=cost;
  }
  _canPayRetreatCost(mon,cost){return (mon.energy||[]).reduce((sum,e)=>sum+this._energyUnitsForRetreat(e,mon),0)>=cost;}
  getCardForMon(mon){return mon?.cardId&&this.cardResolver?.getCard?.(mon.cardId)||null;}
  isStage2Pokemon(mon){const card=this.getCardForMon(mon);const stage=String(card?.stage||mon?.stage||'');return /^2阶/.test(stage)||/^stage\s*2$/i.test(stage);}
  isExPokemon(mon){const card=this.getCardForMon(mon);return !!(card?.isEx||mon?.isEx||/(?:宝可梦)?【?ex】?|\bex\b/i.test(`${card?.name||''} ${mon?.name||''} ${card?.ruleBox||''} ${mon?.ruleBox||''} ${card?.ruleText||''} ${mon?.ruleText||''}`));}
  isRadiantPokemonCard(card){return !!(card?.isRadiant||/光辉宝可梦|^光辉/.test(`${card?.name||''} ${card?.ruleBox||''} ${card?.ruleText||''}`));}
  hasRuleBoxPokemonCard(card){return !!(card?.hasRuleBox||card?.isEx||card?.isRadiant||/(?:宝可梦)?(?:ex|EX|GX|V|VMAX|VSTAR|BREAK)\b|拥有规则的宝可梦|规则宝可梦|光辉宝可梦|太晶/.test(`${card?.name||''} ${card?.ruleBox||''} ${card?.ruleText||''} ${card?.rule2Text||''}`));}
  effectiveRetreatCost(mon){
    let cost=mon?.retreatCostOverride??mon?.retreatCost??1;
    const tool=mon?.tool;
    // 道具效果（通用）：撤退费减少 / 全部消除（如「紧急滑板」减少1个）
    if(tool&&Array.isArray(tool.effects)){
      for(const e of tool.effects){
        if(e.action==='retreat_cost_reduce')cost-=(e.params?.amount||0);
        else if(e.action==='retreat_cost_zero')cost=0;
      }
    }else if(tool&&(String(tool.cardId||'')==='9024'||tool.name==='大气球')){
      // 兼容旧数据（道具对象里没有 effects 时的历史存档/卡组）
      if(this.isStage2Pokemon(mon))cost=0;
    }
    if(this._hasPassive(mon,'retreat_cost_zero'))cost=0;
    for(const {params:p} of this._passiveEffectsFor(mon,'retreat_cost_reduce'))cost-=(p.amount||0);
    cost+=(mon?.retreatCostIncrease||0);
    return Math.max(0,cost||0);
  }
  _discardEnergyForRetreat(mon,count,pl,selectedIndices=null){
    if(count<=0)return true;
    if(selectedIndices){
      if(!this._canSelectedEnergyPayRetreat(mon,count,selectedIndices))return false;
      const unique=[...new Set(selectedIndices.map(Number))].sort((a,b)=>b-a);
      for(const idx of unique)pl.discard.push(toCardRef(mon.energy.splice(idx,1)[0]));
      return true;
    }
    let paid=0;
    while(paid<count){
      if(!mon.energy?.length)return false;
      const idx=mon.energy.length-1;
      const energy=mon.energy[idx];
      paid+=this._energyUnitsForRetreat(energy,mon);
      pl.discard.push(toCardRef(mon.energy.splice(idx,1)[0]));
    }
    return true;
  }
  _removeSpecialConditions(mon){if(!mon)return;mon.status=null;mon.poisonCounters=null;mon.coinFailAttackNext=0;mon.delayedKoAtOppTurnEnd=0;mon.cannotAttackNext=false;mon.cannotRetreat=false;mon.preventDamage=false;mon.preventEffect=false;mon.attackShieldArmed=false;mon.damageMod=0;mon.damageReceivedMod=0;mon.ignore=[];mon.costEliminated=false;mon.retreatCostIncrease=0;mon.attackCostIncrease=0;}

  retreat(pl,benchIndex,selectedEnergyIndices=null){if(pl.retreatUsed){this.addLog('本回合已撤退过');return false;}if(!pl.active||!pl.bench[benchIndex]){this.addLog('撤退目标不存在');return false;}
    // dollNoRetreat 是**永久**被动（玩偶/化石「无法撤退」），不能依赖每回合被清理的 cannotRetreat
    const st=pl.active.status||'';if(st.includes('sleep')||st.includes('paralysis')||pl.active.cannotRetreat||pl.active.dollNoRetreat){this.addLog('无法撤退');return false;}
    if(this._hasPassive(this.getOpponent(pl).active,'cannot_retreat_passive')){this.addLog('因对手特性无法撤退');return false;}
    const cost=this.effectiveRetreatCost(pl.active);if(!this._canPayRetreatCost(pl.active,cost)){this.addLog('撤退能量不足');return false;}
    if(!this._discardEnergyForRetreat(pl.active,cost,pl,selectedEnergyIndices))return false;const old=pl.active;pl.active=pl.bench.splice(benchIndex,1)[0];pl.bench.push(old);this._removeSpecialConditions(old);pl.retreatUsed=true;this.addLog(`${pl.name} 撤退，换上 ${pl.active.name}`);this.recomputePassives();return true;}

  /** 进化前提校验（从手牌进化与「从牌库进化」共用，保证两条路径规则一致） */
  _canEvolveInto(pl,t,cd){
    if(!t){this.addLog('目标不存在');return false;}
    if(!cd?.evolvesFrom||t.name!==cd.evolvesFrom){this.addLog(`${t.name} 不能进化为 ${cd?.name||'?'}`);return false;}
    // 例外：「抢先进化」类特性（如烈雀 151C-021）允许后攻玩家在最初回合进化刚出场的宝可梦；
    // 但「本回合已进化过」仍然不允许再进化一次。
    const firstTurnEvo=t.placedThisTurn&&this._canEvolveOnFirstTurn(pl,t);
    if((t.placedThisTurn&&!firstTurnEvo)||t.evolvedThisTurn){this.addLog(`${t.name} 本回合刚出场或已进化，下回合才能进化`);return false;}
    return true;
  }
  /** 进化的状态变更（卡牌已从来源区域取出，newCardId 为进化后的卡） */
  _applyEvolutionInto(pl,t,cd,newCardId){
    const dmg=t.maxHp-t.hp;
    if(newCardId)t.cardId=newCardId;
    t.name=cd.name;t.maxHp=cd.hp;t.hp=Math.max(cd.hp-dmg,10);
    t.stage=cd.stage||t.stage;t.evolvesFrom=cd.evolvesFrom||null;t.ruleText=cd.ruleText||'';t.rule2Text=cd.rule2Text||'';t.ruleBox=cd.ruleBox||'';t.isEx=!!cd.isEx;t.isRadiant=!!cd.isRadiant;t.hasRuleBox=!!cd.hasRuleBox;
    // 记录最近一次进化（供「附着于进化后的宝可梦身上」这类后续效果定位目标）
    this._lastEvolved={player:pl,mon:t};
    t.attacks=cd.attacks;t.element=cd.element;t.weakness=cd.weakness||null;t.resistance=cd.resistance||null;t.weaknessMultiplier=cd.weaknessMultiplier||2;t.resistanceValue=cd.resistanceValue??-30;t.retreatCost=cd.retreatCost??1;t.ability=cd.ability||null;t.abilityUsed=false;t.abilityDisabled=false;t.abilityDisabledBy=null;t.placedThisTurn=false;t.evolvedThisTurn=true;
    this._removeSpecialConditions(t);
    this.addLog(`${pl.name} 的宝可梦进化成了 ${cd.name}！`);this.recomputePassives();this.emitTriggerEvent('evolved',{target:t,owner:pl});return true;
  }
  evolve(pl,hi,cd,slot){const t=slot==='active'?pl.active:pl.bench[parseInt(slot.replace('bench-',''))];
    if(!this._canEvolveInto(pl,t,cd))return false;
    const newCardId=pl.hand[hi];   // 需求：进化后更新 cardId，立绘才会换成进化后的形象
    pl.hand.splice(hi,1);
    return this._applyEvolutionInto(pl,t,cd,newCardId);}

  /**
   * 「从自己的牌库选择1张从这只宝可梦进化而来的卡牌，放置于这只宝可梦身上进行进化」
   * （共鸣进化等）。牌库里所有 `evolvesFrom === mon.name` 的宝可梦卡都是候选；
   * **当前是否允许进化**（本回合刚出场/本回合已进化、「抢先进化」例外）与从手牌进化同一套判定。
   */
  evolveCandidatesFromDeck(pl,mon){
    if(!mon||!pl)return [];
    return (pl.deck||[]).filter(cid=>{
      const cd=this.cardResolver?.getCard?.(cid);
      return cd&&cd.cardType==='pokemon'&&cd.evolvesFrom===mon.name;
    });
  }
  evolveFromDeck(pl,mon,cardId){
    const cd=this.cardResolver?.getCard?.(cardId);
    if(!this._canEvolveInto(pl,mon,cd))return false;
    const idx=(pl.deck||[]).indexOf(cardId);
    if(idx<0)return false;
    pl.deck.splice(idx,1);
    return this._applyEvolutionInto(pl,mon,cd,cardId);
  }

  /**
   * 「自己所有已经进化的宝可梦，可使用其所有进化前拥有的招式」
   * —— 沿 evolvesFrom 一路往上（2阶→1阶→基础）把进化前招式的定义收集起来。
   * 由 getAttacks 追加在自身招式之后（能量需求照旧由正常招式流程判定）。
   */
  _inheritedAttacksFor(mon){
    if(!mon?.evolvesFrom)return [];
    const owner=[this.player1,this.player2].find(p=>this.getPokemonInPlay(p).includes(mon));
    if(!owner)return [];
    const hasInherit=[owner.active,...(owner.bench||[])].filter(Boolean).some(src=>{
      if(this.isAbilityDisabled?.(src))return false;
      if(!this.isAbilityConditionMet(src))return false;
      return (this._enabledAbilityEffects(src)||[]).some(e=>e.action==='usage_condition'&&e.params?.kind==='evolve_move_inherit');
    });
    if(!hasInherit)return [];
    const out=[];const seen=new Set();let name=mon.evolvesFrom;
    while(name&&!seen.has(name)){
      seen.add(name);
      const ids=this.cardResolver?.findPokemonIdsByName?.(name)||[];
      if(!ids.length)break;
      const cd=this.cardResolver?.getCard?.(ids[0]);
      if(!cd)break;
      for(const a of (cd.attacks||[]))out.push(a);
      name=cd.evolvesFrom||null;
    }
    return out;
  }

  _toolLabel(tool){return (tool&&typeof tool==='object')?(tool.name||tool.cardId||'宝可梦道具'):tool;}
  _toolCardValue(tool){return (tool&&typeof tool==='object')?(tool.cardId||tool.name||tool):tool;}
  // 保留道具的 effects —— effectiveRetreatCost 等需要按「道具效果」通用判定
  // （原实现只存 cardId/name，导致紧急滑板「撤退费-1」这类效果无法生效，
  //   只能靠硬编码卡名，覆盖不了新卡）
  _makeToolState(cardId,cd){return {cardId,name:cd?.name||String(cardId),effects:cd?.effects||null,specialRules:cd?.specialRules||null,toolAttacks:cd?.toolAttacks||null};}

  /**
   * 该宝可梦当前可用招式 = 自身招式 + 身上「招式学习器」类道具提供的招式。
   * 独立成一处取用点，避免在「附上/离场」时增删 mon.attacks 带来的清理遗漏。
   */
  getAttacks(mon){return [...((mon&&mon.attacks)||[]),...this._inheritedAttacksFor(mon),...((mon&&mon.tool&&mon.tool.toolAttacks)||[])];}

  /**
   * 备战区已满、且该效果**全部**可执行动作都需要空备战位 → 视为不可用。
   * 只在这种“纯放宝可梦”的情况下拦截；如果一张卡还有别的可用效果则不拦
   * （例如既有检索又有其他收益的卡，规则上仍可打出）。
   */
  _benchSlotBlocked(pl, effects){
    // 上限可能被竞技场/特性改写（不再是固定 5 只）
    if((pl?.bench||[]).length < this.benchLimitOf(pl)) return false;
    // 排除元数据与附带动作后再判断：剩下的“实质效果”如果全是“放到备战区”，
    // 备战区已满时这张卡/这个竞技场就用不了（不能空发）。
    const relevant=(effects||[]).filter(e=>e.action!=='usage_condition'
      &&e.action!=='trainer_prerequisite'&&!INCIDENTAL_ACTIONS.has(e.action));
    if(!relevant.length) return false;
    return relevant.every(e=>BENCH_SLOT_ACTIONS.has(e.action));
  }

  canUseTrainer(pl, cd, targetSlot=null){
    if(!cd||cd.cardType!=='trainer')return {ok:false,reason:'not_trainer',message:'不是训练家卡'};
    const prereqFailure=this._trainerPrerequisiteFailure(pl,cd);
    if(prereqFailure)return prereqFailure;
    // 回收类效果（从弃牌区选择 N 张）：弃牌区没有合法目标时不能使用。
    // 规则：只有「卡组检索类」允许空发（玩家可以选择不拿），回收类无目标 = 使用前提不满足。
    const recoverFailure=this._recoverTargetFailure(pl,cd);
    if(recoverFailure)return recoverFailure;
    const tt=cd.trainerType;
    if(tt==='item'&&pl.playRestrictions?.item){return {ok:false,reason:'play_restriction_item',message:'受到招式效果，下回合无法从手牌使出物品卡'};}
    const hasFirstPlayerFirstTurnSupporterException=(cd.effects||[]).some(e=>e.action==='trainer_prerequisite'&&e.params?.kind==='first_player_first_turn_supporter_exception');
    if(tt==='supporter'&&pl===this.firstPlayer&&this.firstPlayerFirstTurnInProgress&&!hasFirstPlayerFirstTurnSupporterException)return {ok:false,reason:'first_player_first_turn_supporter',message:'先攻玩家最初回合不能使用支援者卡'};
    if(tt==='supporter'&&pl.supporterUsed)return {ok:false,reason:'supporter_used',message:'已用过支援者卡'};
    // ⑨「在下个对手的回合，对手无法从手牌使出支援者」
    if(tt==='supporter'&&pl.playRestrictions?.supporter)return {ok:false,reason:'play_restriction_supporter',message:'受到招式效果，下回合无法从手牌使出支援者卡'};
    // ⑨「也无法放置竞技场」
    if(tt==='stadium'&&pl.playRestrictions?.stadium)return {ok:false,reason:'play_restriction_stadium',message:'受到招式效果，下回合无法放置竞技场'};

    // 规则：每回合只能打出 1 张竞技场（原来没有限制，可以连放两张覆盖前一张）

    if(tt==='stadium'&&pl.stadiumPlayedThisTurn)return {ok:false,reason:'stadium_played',message:'这个回合已经打出过竞技场'};
    if(tt==='stadium'){
      const cur=this.getActiveStadium();
      if(cur&&cd.name&&cur.name===cd.name)return {ok:false,reason:'stadium_same_name',message:`场上已有「${cd.name}」，同名的竞技场不能发动`};
    }
    if(tt==='tool'){
      const t=targetSlot==='active'?pl.active:(targetSlot?.startsWith('bench-')?pl.bench[parseInt(targetSlot.replace('bench-',''))]:null);
      if(!t)return {ok:false,reason:'missing_tool_target',message:'请选择目标宝可梦'};
      if(t.tool)return {ok:false,reason:'tool_already_attached',message:`${t.name} 已装备 ${this._toolLabel(t.tool)}`};
    }
    // 需求：巢穴球这类「放于备战区」的效果，备战区已满时不能空发
    if(this._benchSlotBlocked(pl,cd.effects))return {ok:false,reason:'bench_full',message:'备战区已满，无法放置宝可梦'};
    return {ok:true,trainerType:tt};
  }

  _trainerPrerequisiteFailure(pl,cd){
    for(const eff of cd?.effects||[]){
      if(eff.action!=='trainer_prerequisite')continue;
      const p=eff.params||{};
      if(p.kind==='opponent_prizes_at_most'){
        const opp=this.getOpponent(pl);
        const limit=p.count??3;
        if((opp?.prizes?.length??0)>limit)return {ok:false,reason:'trainer_prerequisite',message:`使用前提未满足：对手剩余奖赏卡需为${limit}张以下`};
      }
      if(p.kind==='own_prizes_more_than_opponent'){
        const opp=this.getOpponent(pl);
        if((pl?.prizes?.length??0)<=(opp?.prizes?.length??0))return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：自己的剩余奖赏卡需多于对手'};
      }
      if(p.kind==='own_pokemon_knocked_out_last_opponent_turn'){
        if(!this.wasOwnPokemonKnockedOutLastOpponentTurn(pl))return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：上个对手的回合自己的宝可梦需被击倒'};
      }
      // 「这张卡，只有在自己放逐区有 N 张以上时才可使用」——放逐区是独立区域
      if(p.kind==='lost_zone_min'){
        const need=p.count??10;
        if((pl?.lostZone?.length??0)<need)return {ok:false,reason:'trainer_prerequisite',message:`使用前提未满足：自己放逐区需要 ${need} 张以上卡牌`};
      }
      if(p.kind==='first_turn'){
        const raw=p.raw||'';
        const isOwnFirstTurn=this._isOwnFirstTurn(pl);
        if(/后攻玩家/.test(raw)&&!(isOwnFirstTurn&&pl!==this.firstPlayer))return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：只可在后攻玩家自己的最初回合使用'};
        if(!/后攻玩家/.test(raw)&&!isOwnFirstTurn)return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：只可在自己的最初回合使用'};
      }
    }
    return null;
  }

  _trainerLegalityMessage(check){return check?.message||'无法使用训练家卡';}

  /** 回收类效果必需但弃牌区无合法目标 → 不可使用（返回失败对象，否则 null） */
  _recoverTargetFailure(pl,cd){
    for(const eff of cd?.effects||[]){
      if(eff.action!=='recover_from_discard')continue;
      const p=eff.params||{};
      const required=(p.minCount??p.count??1)>0&&!p.optional&&!p.allowEmpty&&!p.allowFewer;
      if(!required)continue;
      const hasTarget=(pl?.discard||[]).some(id=>this._cardMatchesLooseFilter(id,p.filter));
      if(!hasTarget)return {ok:false,reason:'no_recover_target',message:'弃牌区没有可回收的卡牌'};
    }
    return null;
  }

  /** 轻量卡牌类别匹配（仅供使用前提校验，不替代 EffectExecutor 的完整筛选） */
  _cardMatchesLooseFilter(id,filter){
    if(!filter)return true;
    const cd=this.cardResolver?.getCard?.(id)||null;
    const name=String(cd?.name||'');
    const f=String(filter).replace(/["“”「」]/g,'').replace(/\d+张/g,'').replace(/\s+/g,'');
    const isPokemon=cd?.cardType==='pokemon';
    const isBasicEnergy=cd?.cardType==='energy';
    const isEnergy=isBasicEnergy||cd?.cardType==='specialEnergy';
    if(!cd&&!name)return false;
    if(f.includes('宝可梦')&&isPokemon)return true;
    if(f.includes('基本能量')&&isBasicEnergy)return true;
    if(f.includes('能量')&&isEnergy)return true;
    if(/支援者/i.test(f)&&cd?.trainerType==='supporter')return true;
    if(/物品/i.test(f)&&cd?.trainerType==='item')return true;
    if(/竞技场/i.test(f)&&cd?.trainerType==='stadium')return true;
    if(/训练家/i.test(f)&&cd?.cardType==='trainer')return true;
    if(name&&f.includes(name))return true;
    return false;
  }

  useTrainer(pl, hi, cd, targetSlot=null, cardId=null){
    const check=this.canUseTrainer(pl,cd,targetSlot);
    if(!check.ok){this.addLog(this._trainerLegalityMessage(check));return false;}
    const tt=cd.trainerType;
    if(tt==='supporter')pl.supporterUsed=true;
    if(tt==='stadium'){
      this.setActiveStadium(pl,hi,cd);
      pl.stadiumPlayedThisTurn=true;
      this.recomputePassives();
      return true;
    }
    if(tt==='tool'){
      const t=targetSlot==='active'?pl.active:(targetSlot?.startsWith('bench-')?pl.bench[parseInt(targetSlot.replace('bench-',''))]:null);
      if(!t){this.addLog('请选择目标宝可梦');return false;}
      if(t.tool){this.addLog(`${t.name} 已装备 ${this._toolLabel(t.tool)}`);return false;}
      const attached=cardId??pl.hand[hi];
      pl.hand.splice(hi,1);
      t.tool=this._makeToolState(attached,cd);
      this.addLog(`${pl.name} 为 ${t.name} 装备了「${cd.name}」`);
      return true;
    }
    // 物品卡：弃牌区统一存卡牌 ID（曾错误地存卡名，导致「夜间担架」等回收后显示为「未知」）
    const used = pl.hand.splice(hi,1)[0];
    pl.discard.push(cardId ?? used);
    this.addLog(`${pl.name} 使用了「${cd.name}」`);
    return true;
  }

  getActiveStadium(){return this.stadium||this.player1.stadium||this.player2.stadium||null;}

  /**
   * 备战区上限。基础 5 只，可被两类持续效果改写：
   *   ① 竞技场：「双方玩家可以放于备战区的宝可梦数量，变为N只」
   *              「自己场上有「X」宝可梦的玩家，可以放于备战区的宝可梦数量变为N只」
   *   ② 场上特性：「对手可放于备战区的宝可梦数量就会变为N只」（`只要这只宝可梦在场上/战斗场上`）
   *
   * 多条同时生效时按官方规则取**数量更少**的那条（「优先执行数量更少的效果」），
   * 所以这里是 Math.min 而不是 max。
   */
  benchLimitOf(pl){
    // 只收集**真正生效的「数量变更」效果**，再取其中最小的一条。
    // ⚠️ 不能拿它们和基础值 5 取 min：「能够放于自己备战区的宝可梦数量变为8只」这类
    //    **放宽**效果在没有其它效果竞争时就是 8 只（官方「优先执行数量更少的效果」说的是
    //    多个变更效果之间比，不是与基础值比）。实测踩过：min(5,8)=5 导致 8 只失效。
    const limits = [];
    const st = this.getActiveStadium();
    for (const eff of (st?.effects || [])) {
      if (eff.action !== 'usage_condition') continue;
      const p = eff.params || {};
      if (p.kind === 'bench_limit' && p.limit > 0) limits.push(p.limit);
      else if (p.kind === 'bench_limit_cond' && p.limit > 0 && this._benchLimitCondMet(pl, p)) limits.push(p.limit);
    }
    const opp = this.getOpponent(pl);
    const oppMons = [opp?.active, ...(opp?.bench || [])].filter(Boolean);
    for (const src of oppMons) {
      if (!src?.ability?.effects?.length || src.abilityDisabled) continue;
      for (const eff of this._enabledAbilityEffects(src)) {
        if (eff.action !== 'usage_condition') continue;
        const p = eff.params || {};
        if (p.kind !== 'opp_bench_limit' || !(p.limit > 0)) continue;
        // 该特性若带「只有当自己场上所有的宝可梦都是【X】属性」的前提，前提不满足时不生效
        if (!this.isAbilityConditionMet(src)) continue;
        // 「只要这只宝可梦在**战斗场上**」→ 不在出战位就不生效。
        // 注意：归一化会把「只要这只宝可梦在战斗场上，」整段删掉，所以**不能只靠正则捕获**，
        // 要用 CardResolver._abilityZone 在原始卡面文本上算出的 ability.zone（被动扫描也是这么判的）。
        if ((p.requiresActive || src.ability?.zone === 'active') && src !== opp.active) continue;
        limits.push(p.limit);
      }
    }
    return limits.length ? Math.max(1, Math.min(...limits)) : BENCH_MAX;
  }
  /**
   * 「这个特性只有当自己场上所有的宝可梦都是【X】属性的场合才生效」
   * —— 该前提**不满足时这个特性的全部效果都不生效**（含它给的上限/限制/伤害加成）。
   * 返回该特性要求的属性；没有该前提时返回 null。
   */
  abilityMonoTypeOf(src){
    if (!src?.ability?.effects?.length) return null;
    for (const eff of src.ability.effects) {
      if (eff.action === 'usage_condition' && eff.params?.kind === 'type_mono_ability' && eff.params.type) return eff.params.type;
    }
    return null;
  }
  hasMonoTypeField(pl, type){
    const mons = [pl?.active, ...(pl?.bench || [])].filter(Boolean);
    if (!mons.length) return false;
    const want = this._normalizeType(type);
    return mons.every(m => this._normalizeType(m.element || m.type || '') === want);
  }
  /** 我方场上是否有带「只有当自己场上所有的宝可梦都是【X】属性」前提的特性；返回该属性 */
  _monoTypeGateOf(pl){
    for (const src of [pl?.active, ...(pl?.bench || [])].filter(Boolean)) {
      const need = this.abilityMonoTypeOf(src);
      if (need) return need;
    }
    return null;
  }

  /** 这只宝可梦的特性当前是否生效（含「单属性场」前提） */
  isAbilityConditionMet(src){
    const need = this.abilityMonoTypeOf(src);
    if (!need) return true;
    const owner = [this.player1, this.player2].find(pl => this.getPokemonInPlay(pl).includes(src));
    return owner ? this.hasMonoTypeField(owner, need) : false;
  }
  _monMatchesType(mon, type){
    const want = this._normalizeType(type);
    if (this._normalizeType(mon?.element || mon?.type || '') === want) return true;
    return String(mon?.name || '').includes(`【${type}】`);
  }
  _cardMatchesElement(card, type){
    if (!card) return false;
    // 兼容三种入参：卡牌 id / 卡牌对象 / {card, info} 包装（选择器里两种都会出现）
    const raw = (typeof card === 'object' && card.card) ? card.card : card;
    const cd = typeof raw === 'object' ? raw : (this.cardResolver?.getCard?.(raw) || null);
    if (!cd) return false;
    const want = this._normalizeType(type);
    if (this._normalizeType(cd.element || cd.type || '') === want) return true;
    if ((cd.types || []).some(t => this._normalizeType(t) === want)) return true;
    return String(cd.name || '').includes(`【${type}】`);
  }
  /**
   * 「能够放于自己备战区的【X】宝可梦的数量变为N只，且无法将其他属性的宝可梦放于自己场上」
   * 返回生效的属性规则（多条时取更严格的上限）。
   */
  benchTypeRule(pl){
    const rules = [];
    for (const src of [pl?.active, ...(pl?.bench || [])].filter(Boolean)) {
      if (!src?.ability?.effects?.length || src.abilityDisabled) continue;
      if (!this.isAbilityConditionMet(src)) continue;
      for (const eff of this._enabledAbilityEffects(src)) {
        if (eff.action !== 'usage_condition') continue;
        const p = eff.params || {};
        if (p.kind === 'bench_type_limit' && p.limit > 0 && p.type) rules.push(p);
      }
    }
    if (!rules.length) return null;
    return rules.reduce((a, b) => (b.limit < a.limit ? b : a));
  }
  /**
   * 这只卡还能往备战区放几只（0 表示不能放）。
   * 普通情况 = 上限 − 现有只数；有属性规则时：
   *   · 该属性 → 上限按规则里的 N 只算（按该属性的只数计）
   *   · 其他属性 → 规则带「无法将其他属性的宝可梦放于自己场上」时直接不可放
   */
  benchSlotsFor(pl, card){
    const rule = this.benchTypeRule(pl);
    const total = Math.max(0, this.benchLimitOf(pl) - (pl?.bench || []).length);
    if (!rule) return total;
    const used = (pl.bench || []).filter(Boolean).filter(m => this._monMatchesType(m, rule.type)).length;
    const typeSlots = Math.max(0, rule.limit - used);
    // card == null：还不知道要放哪张（如「任意数量」先问上限）→ 取**任何卡可用的最大值**
    if (card == null) return rule.restrictOthers ? typeSlots : Math.max(total, typeSlots);
    if (!this._cardMatchesElement(card, rule.type)) return rule.restrictOthers ? 0 : total;
    return typeSlots;
  }
  canPlaceOnBench(pl, card){ return this.benchSlotsFor(pl, card) > 0; }

  _benchLimitCondMet(pl, p){
    const want = String(p.requireName || '');
    if (!want) return true;
    return [pl?.active, ...(pl?.bench || [])].filter(Boolean).some(m => String(m.name || '').includes(want));
  }
  /**
   * 把超出上限的备战宝可梦丢到弃牌区（含身上附着的能量与道具）。
   * 这是**不变量**：上限被竞技场/特性改写后，任何时刻都应在下一检查点收敛到新上限。
   * 无 UI 自动从末尾开始丢（不会阻塞回合流转）。
   */
  enforceBenchLimits(opts = {}){
    const out = [];
    for (const pl of [this.player1, this.player2]) {
      const limit = this.benchLimitOf(pl);
      while ((pl.bench || []).length > limit) {
        const mon = pl.bench.pop();
        if (!mon) break;
        pl.discard.push(mon.cardId);
        for (const e of (mon.energy || [])) pl.discard.push(typeof e === 'string' ? e : (e?.cardId || e));
        if (mon.tool) pl.discard.push(mon.tool.cardId || mon.tool);
        out.push({ player: pl.name, name: mon.name || mon.cardId, limit });
      }
    }
    if (out.length) this.addLog(`备战区上限收窄：${out.map(o => `${o.player} 的 ${o.name}`).join('、')} 丢到弃牌区`);
    return out;
  }
  _stadiumDiscardCard(stadium){return stadium?.cardId||stadium?.name||stadium;}
  _makeStadiumState(owner,cardId,cd){return {cardId,name:cd?.name||String(cardId),card:cd,effects:cd?.effects||[],effectText:cd?.effectText||'',owner};}
  setActiveStadium(pl,hi,cd){
    const cardId=pl.hand.splice(hi,1)[0];
    const old=this.getActiveStadium();
    if(old){
      const oldOwner=old.owner||[this.player1,this.player2].find(p=>p.stadium===old)||pl;
      oldOwner.discard.push(this._stadiumDiscardCard(old));
      this.addLog(`${old.name||old} 被替换`);
    }
    const stadium=this._makeStadiumState(pl,cardId,cd);
    this.stadium=stadium;this.player1.stadium=stadium;this.player2.stadium=stadium;
    this.player1.stadiumUsedThisTurn={};this.player2.stadiumUsedThisTurn={};
    this.addLog(`${pl.name} 打出了竞技场「${stadium.name}」`);
    return stadium;
  }
  clearActiveStadium(discardOwner=null){
    const old=this.getActiveStadium();
    if(!old){this.stadium=null;this.player1.stadium=null;this.player2.stadium=null;return null;}
    const oldOwner=old.owner||[this.player1,this.player2].find(p=>p.stadium===old)||discardOwner;
    if(oldOwner)oldOwner.discard.push(this._stadiumDiscardCard(old));
    this.stadium=null;this.player1.stadium=null;this.player2.stadium=null;
    this.player1.stadiumUsedThisTurn={};this.player2.stadiumUsedThisTurn={};
    return old;
  }
  _stadiumUseKey(stadium){return `stadium:${stadium?.cardId||stadium?.name||'active'}`;}
  stadiumActivationEffects(stadium=this.getActiveStadium()){return (stadium?.effects||[]).filter(e=>e.action!=='usage_condition'&&e.action!=='trainer_prerequisite');}
  canActivateStadium(pl=this.currentPlayer){
    if(this.phase!==PHASE.MAIN)return {ok:false,reason:'wrong_phase',message:'只能在主要阶段使用竞技场'};
    if(pl!==this.currentPlayer)return {ok:false,reason:'not_current_player',message:'只能在自己的回合使用竞技场'};
    const stadium=this.getActiveStadium();
    if(!stadium)return {ok:false,reason:'missing_stadium',message:'没有可使用的竞技场'};
    const effects=this.stadiumActivationEffects(stadium);
    if(!effects.length)return {ok:false,reason:'no_effects',message:'这个竞技场暂无可执行效果'};
    // 需求：深钵镇这类「放于备战区」的竞技场效果，备战区已满时不能空发
    if(this._benchSlotBlocked(pl,effects))return {ok:false,reason:'bench_full',message:'备战区已满，这个竞技场无法放置宝可梦'};
    const key=this._stadiumUseKey(stadium);pl.stadiumUsedThisTurn=pl.stadiumUsedThisTurn||{};
    if(pl.stadiumUsedThisTurn[key])return {ok:false,reason:'already_used',message:'这个竞技场本回合已使用'};
    return {ok:true,stadium,effects,key};
  }
  markStadiumUsed(pl,stadium=this.getActiveStadium()){pl.stadiumUsedThisTurn=pl.stadiumUsedThisTurn||{};pl.stadiumUsedThisTurn[this._stadiumUseKey(stadium)]=true;}

  getOpponent(pl){return pl===this.player1?this.player2:this.player1;}
  _recordKnockout(owner){
    // 「如果因为这个招式对手的宝可梦【昏厥】的话」→ 用招式窗口(_koContext)内的 KO 计数精确判定
    if(this._koContext)this._koContext.koCount=(this._koContext.koCount||0)+1;
    this.knockoutHistory=this.knockoutHistory||[];this.knockoutHistory.push({owner,turn:this.turn,by:this.getOpponent(owner),phase:this.phase});}
  wasOwnPokemonKnockedOutLastOpponentTurn(pl){
    const opp=this.getOpponent(pl);
    const turn=this.turn-1;
    return (this.knockoutHistory||[]).some(k=>k.owner===pl&&k.by===opp&&k.turn===turn);
  }
  getPokemonInPlay(pl){return [pl.active,...pl.bench].filter(Boolean);}
  getAllPokemonInPlay(){return [...this.getPokemonInPlay(this.player1),...this.getPokemonInPlay(this.player2)];}
  normalizeAbilityZone(zone){const z=zone||'field';return ({in_play:'field',場:'field',手牌:'hand',手札:'hand',弃牌区:'discard',トラッシュ:'discard'}[z]||z);}
  inferAbilityZone(pl,source){if(!source)return null;if(source===pl.active)return 'active';if(pl.bench.includes(source))return 'bench';return null;}
  isAbilityDisabled(mon){return !!mon?.abilityDisabled;}
  _abilityUseKey(source,ability,zone){return `${this.normalizeAbilityZone(zone)}:${source?.cardId||source?.name||'card'}:${ability?.name||'ability'}`;}
  _abilityReasonText(reason){return ({missing_ability:'没有特性',not_active_ability:'不是可主动使用的特性',no_effects:'这个特性暂无可执行效果',wrong_zone:'特性不在当前区域生效',ability_disabled:'这个特性已被消除',already_used:'这个特性本回合已使用',invalid_source:'特性来源无效'}[reason]||'无法使用特性');}

  canUseAbility(pl,source,ability=null,zone=null){
    const ab=ability||source?.ability;
    if(!ab)return {ok:false,reason:'missing_ability'};
    if(!ab.active)return {ok:false,reason:'not_active_ability',ability:ab};
    if(!ab.effects?.length)return {ok:false,reason:'no_effects',ability:ab};
    const srcZone=this.normalizeAbilityZone(zone||this.inferAbilityZone(pl,source)||ab.zone||'field');
    const abZone=this.normalizeAbilityZone(ab.zone||'field');
    if(abZone==='active'&&srcZone!=='active')return {ok:false,reason:'wrong_zone',ability:ab,zone:srcZone};
    if(abZone==='bench'&&srcZone!=='bench')return {ok:false,reason:'wrong_zone',ability:ab,zone:srcZone};
    if(['hand','discard'].includes(abZone)&&srcZone!==abZone)return {ok:false,reason:'wrong_zone',ability:ab,zone:srcZone};
    if(['active','bench','field'].includes(srcZone)){
      if(!this.getPokemonInPlay(pl).includes(source))return {ok:false,reason:'invalid_source',ability:ab,zone:srcZone};
      if(this.isAbilityDisabled(source))return {ok:false,reason:'ability_disabled',ability:ab,zone:srcZone};
      if(source.abilityUsed)return {ok:false,reason:'already_used',ability:ab,zone:srcZone};
      const usageFailure=this._abilityUsageFailure(pl,ab,source);
      if(usageFailure)return {ok:false,reason:usageFailure.reason,ability:ab,zone:srcZone,message:usageFailure.message};
    }else{
      const key=this._abilityUseKey(source,ab,srcZone);
      if(pl.abilityUsedThisTurn?.[key])return {ok:false,reason:'already_used',ability:ab,zone:srcZone};
      const usageFailure=this._abilityUsageFailure(pl,ab,source);
      if(usageFailure)return {ok:false,reason:usageFailure.reason,ability:ab,zone:srcZone,message:usageFailure.message};
    }
    return {ok:true,ability:ab,zone:srcZone};}

  /**
   * 招式可用性（供界面置灰用；与 BattleEngine.attack 内的校验保持一致）。
   * 只判断**确定性**条件，混乱是随机判定（50%）所以不置灰。
   * 需求来源：先攻玩家最初回合不能使用招式，界面应像能量不足一样置灰，
   * 而不是点下去才提示不可用。
   */
  /**
   * 胜利条件进度（未知图腾「伤害 / 手牌 / 放逐」）。
   * 返回当前值；与 win_condition 的 threshold 比较决定能否发动/是否获胜。
   */
  _winConditionProgress(pl, kind){
    switch(kind){
      case 'bench_damage_counters_total':
        return (pl?.bench||[]).filter(Boolean).reduce((s,m)=>s+Math.max(0,(m.maxHp||0)-(m.hp||0)),0);
      case 'hand_count':
        return pl?.hand?.length||0;
      case 'opponent_lost_zone_supporter_count':{
        const opp=this.getOpponent(pl);
        let c=0;
        for(const v of (opp?.lostZone||[])){
          const id=typeof v==='object'&&v?(v.cardId||v.name):v;
          const cd=this.cardResolver?.getCard?.(id);
          if(cd?.cardType==='trainer'&&cd?.trainerType==='supporter')c++;
        }
        return c;
      }
      default: return 0;
    }
  }

  /**
   * 「其中」的计数源：上一个动作**处理过的那批卡**（查看手牌 / 翻牌库顶 / 丢弃并查看…）。
   * 由各执行器在处理完时写入 gs._lastProcessed。
   * kind 可以是类别（trainer/supporter/item/pokemon/energy）或卡名片段。
   */
  _countLastProcessed(kind){
    const list=this._lastProcessed||[];
    const want=String(kind||'');
    if(!want)return list.length;
    // 卡面用的是中文类别名（训练家/支援者/物品/宝可梦/能量），也要能映射
    const kindMap={
      trainer:['trainer',null],supporter:['trainer','supporter'],item:['trainer','item'],
      pokemon:['pokemon',null],energy:['energy',null],basicEnergy:['energy',null],
      '训练家':['trainer',null],'支援者':['trainer','supporter'],'物品':['trainer','item'],
      '宝可梦':['pokemon',null],'能量':['energy',null],'基本能量':['energy',null],
    };
    const mapped=kindMap[want];
    let c=0;
    for(const d of list){
      const cd=(typeof d==='object'&&d&&d.cardType)?d:this.cardResolver?.getCard?.(typeof d==='object'?(d.cardId||d.name):d);
      if(!cd){continue;}
      if(mapped){
        if(cd.cardType!==mapped[0])continue;
        if(mapped[1]&&cd.trainerType!==mapped[1])continue;
        c++;
      }else if(String(cd.name||'').includes(want)){c++;}
    }
    return c;
  }

  /**
   * 判断一个「附着能量」表示是否属于某属性。
   * 兼容：① 带 provides 的规范表示 ②「基本【火】能量」③「基本火能量」三种写法。
   */
  _energyCardMatchesType(e, wantCn){
    const want = String(wantCn || '');
    if (!want) return true;
    const ELEM = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting','恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };
    const wantKey = ELEM[want] || want;
    const o = (e && typeof e === 'object') ? e : null;
    if (o && o.provides) return o.provides === wantKey;
    const s = String(o ? (o.name || o.cardId || '') : e);
    return s.includes(`【${want}】`) || (s.includes('基本') && s.includes(want));
  }

  /** damage_place 的计数来源取值（只读，给「与…张数相同数量的伤害指示物」用） */
  _counterValueForDamage(pl, kind, type){
    switch(kind){
      // 「掷与这只宝可梦身上附有的（【X】）能量数量相同次数的硬币」
      case 'self_energy': return pl.active?.energy?.length || 0;
      // 能量属性判断要兼容两种卡名写法（「基本【火】能量」与「基本火能量」）：
      // 优先用能量对象上的 provides（引擎规范的属性键），没有再做名字匹配。
      case 'self_energy_type': return (pl.active?.energy||[]).filter(e=>this._energyCardMatchesType(e, type)).length;
      case 'both_active_energy': return (pl.active?.energy?.length||0) + (this.getOpponent(pl).active?.energy?.length||0);
      case 'discard_pokemon': return (pl.discard||[]).filter(d=>{const cd=(typeof d==='object'&&d)?d:this.cardResolver?.getCard?.(d);return cd&&cd.cardType==='pokemon';}).length;
      case 'opponent_prizes_taken': { const opp=this.getOpponent(pl); return Math.max(0, (opp?.prizes?.length!=null? (6-(opp.prizes.length)) : 0)); }
      case 'hand_count': return pl?.hand?.length||0;
      case 'own_field_pokemon_count': return [pl.active,...(pl.bench||[])].filter(Boolean).length;
      // 「最多与对手备战宝可梦数量相同数量」——数对手备战区的只数
      case 'opponent_bench': return (this.getOpponent(pl).bench||[]).filter(Boolean).length;
      // 「最多与出现正面次数相同数量」——读同一次效果里前面 coin_flip 记下的正面数
      case 'coin_heads': return this._lastCoinHeads || 0;
      default: return 0;
    }
  }

  /** 放逐区里的「宝可梦」张数（不是全部卡牌） */
  _lostZonePokemonCount(pl){
    let c=0;
    for(const v of (pl?.lostZone||[])){
      const id=typeof v==='object'&&v?(v.cardId||v.name):v;
      const cd=this.cardResolver?.getCard?.(id);
      if(cd?.cardType==='pokemon')c++;
    }
    return c;
  }

  /** 该宝可梦是否带「放逐区有 N 张以上则招式能量全部消除」的被动 */
  _passiveCostEliminatedByLostZone(mon){
    if(!mon||!mon.ability?.effects?.length||this.isAbilityDisabled?.(mon))return false;
    for(const eff of (this._enabledAbilityEffects(mon)||[])){
      if(eff.action!=='cost_eliminated_if_lost_zone')continue;
      const need=+((eff.params||{}).minLostZone||0);
      const owner=[this.player1,this.player2].find(p=>[p.active,...(p.bench||[])].filter(Boolean).includes(mon));
      if(owner&&(owner.lostZone?.length||0)>=need)return true;
    }
    return false;
  }

  /**
   * 招式前提判定：「若<条件>，则这个招式失败」。
   * 返回失败原因（字符串）或 null（可以打）。**认不出的条件不拦**（宽松放行，
   * 避免把卡直接变成不能用；那类条件句仍以残句形式留在索引里可见）。
   */
  _attackPreconditionFailure(pl, mon, attackIndex = 0){
    const effs = this.getAttacks(mon)[attackIndex]?.effects || [];
    // 前提有三种既有表示，都要认：
    //   ① usage_condition{kind:'attack_requires', conditionText}（本批新增的通用写法）
    //   ② conditional_effect{condition, effect:{action:'attack_fail'}}（引擎既有写法，
    //      原来只在**执行时**抛 RequiredEffectFailed，canUseAttack 不知道 → 不会置灰）
    //   ③ usage_condition{kind:'fail_if_hand_diff'}
    const conds = [];
    for (const e of effs) {
      if (e.action === 'usage_condition' && e.params?.kind === 'attack_requires') conds.push({ text:String(e.params?.conditionText || '') });
      else if (e.action === 'conditional_effect' && e.params?.effect?.action === 'attack_fail') conds.push({ key:String(e.params?.condition || '') });
      else if (e.action === 'usage_condition' && e.params?.kind === 'fail_if_hand_diff') conds.push({ key:'hand_diff' });
    }
    if (!conds.length) return null;
    const opp = this.getOpponent(pl);
    for (const c of conds) {
      if (c.key) {
        if (c.key === 'stadium_not_in_play') { if (!this.getActiveStadium()) return '场上没有竞技场，这个招式会失败'; continue; }
        if (c.key === 'opponent_active_no_damage') { const d = opp?.active; if (!d || !(d.maxHp && d.hp < d.maxHp)) return '对手战斗宝可梦身上没有伤害指示物，这个招式会失败'; continue; }
        if (c.key === 'self_no_damage') { if (!(mon?.maxHp && mon.hp < mon.maxHp)) return '这只宝可梦身上没有伤害指示物，这个招式会失败'; continue; }
        if (c.key === 'hand_diff') { if ((pl?.hand?.length || 0) !== (opp?.hand?.length || 0)) return '双方手牌张数不同，这个招式会失败'; continue; }
        continue; // 其它条件键：宽松放行
      }
      const t = c.text;
      // 「无法将卡牌放于弃牌区」——实测这批卡都是「先把场上的竞技场丢掉」的招式
      if (/无法将卡牌(?:丢到|放于)弃牌区/.test(t)) { if (!this.getActiveStadium()) return '场上没有竞技场，这个招式会失败'; continue; }
      if (/场上没有竞技场/.test(t)) { if (!this.getActiveStadium()) return '场上没有竞技场，这个招式会失败'; continue; }
      if (/对手(?:的)?备战区没有宝可梦|对手没有备战宝可梦/.test(t)) { if (!(opp?.bench || []).filter(Boolean).length) return '对手没有备战宝可梦，这个招式会失败'; continue; }
      if (/对手的战斗宝可梦身上没有放置伤害指示物/.test(t)) { const d = opp?.active; if (!d || !(d.maxHp && d.hp < d.maxHp)) return '对手战斗宝可梦身上没有伤害指示物，这个招式会失败'; continue; }
      if (/这只宝可梦身上没有放置伤害指示物/.test(t)) { if (!(mon?.maxHp && mon.hp < mon.maxHp)) return '这只宝可梦身上没有伤害指示物，这个招式会失败'; continue; }
      if (/自己的手牌与对手的手牌张数不同/.test(t)) { if ((pl?.hand?.length || 0) !== (opp?.hand?.length || 0)) return '双方手牌张数不同，这个招式会失败'; continue; }
      { const m = t.match(/自己的手牌数量不为(\d+)张/); if (m) { if ((pl?.hand?.length || 0) !== +m[1]) return `手牌不是 ${m[1]} 张，这个招式会失败`; continue; } }
      if (/自己的备战区中没有/.test(t)) {
        const names = [...String(t).matchAll(/[「"“]([^」"”]+)[」"”]/g)].map(x => x[1]);
        if (names.length && !(pl?.bench || []).filter(Boolean).some(x => names.some(n => String(x.name || '').includes(n)))) {
          return `备战区没有${names.join('或')}，这个招式会失败`;
        }
        continue;
      }
      if (/这只宝可梦没有从备战区被放置于战斗场上/.test(t)) { if (!mon?.cameFromBenchThisTurn) return '这只宝可梦本回合不是从备战区上场的，这个招式会失败'; continue; }
      // 认不出的条件：不拦（宽松放行）
    }
    return null;
  }

  /** 该招式是否要求场上存在竞技场（无极汰那「世界终焉」：没有竞技场则招式失败） */
  _attackRequiresStadium(mon,attackIndex=0){
    const effs=this.getAttacks(mon)[attackIndex]?.effects||[];
    return effs.some(e=>e.action==='usage_condition'&&e.params?.kind==='attack_requires_stadium');
  }

  /** 是否是该玩家**自己的最初回合**（回合 1 属于先攻方，回合 2 属于后攻方） */
  _isOwnFirstTurn(pl){
    if(!this.firstPlayer)return false;
    return (this.turn===1&&pl===this.firstPlayer)||(this.turn===2&&pl!==this.firstPlayer);
  }

  /**
   * 该招式是否带「即使是先攻玩家的最初回合也可使用」标签
   * （CBB6C-0301~0322 等卡面明确写了例外的招式）。
   */
  _attackAllowsFirstTurn(mon,attackIndex=0){
    const effs=this.getAttacks(mon)[attackIndex]?.effects||[];
    return effs.some(e=>e.action==='usage_condition'&&e.params?.kind==='attack_first_turn_ok');
  }

  /**
   * 该宝可梦是否可在「后攻玩家的最初回合」即使刚出场也进化
   * （烈雀 151C-021「抢先进化」这类特性）。
   */
  _canEvolveOnFirstTurn(pl,mon){
    if(!mon||!this.firstPlayer)return false;
    if(pl===this.firstPlayer)return false;                 // 只对后攻方生效
    if(!this.firstPlayerFirstTurnInProgress)return false;
    return (mon.ability?.effects||[]).some(e=>e.action==='usage_condition'&&e.params?.kind==='evolve_on_first_turn_going_second');
  }

  /**
   * 「[对战中，己方的GX招式只能使用1次。]」/「[对战中，己方的VSTAR力量只能使用1次。]」
   *
   * 卡面把这条写在方括号里，解析端记成了 `gx_once_per_game` / `vstar_power_once` 标记，
   * 但**引擎此前根本不读它** → 同一局能用出 2 个以上 GX/VSTAR 招式 ✗。
   * 这里按招式名的后缀识别（简中卡面就是「日神爆诞GX」「…VSTAR」这种写法）。
   */
  _isGxAttack(attack){return /GX\s*$/i.test(String(attack?.name||''));}
  _isVstarAttack(attack){return /VSTAR\s*$/i.test(String(attack?.name||''));}
  _oncePerGameAttackFailure(pl,attack){
    if(!pl||!attack)return null;
    if(this._isGxAttack(attack)&&pl.gxUsed)return {reason:'gx_used',message:'这一局已经使用过GX招式'};
    if(this._isVstarAttack(attack)&&pl.vstarUsed)return {reason:'vstar_used',message:'这一局已经使用过VSTAR力量'};
    return null;
  }
  markOncePerGameAttackUsed(pl,attack){
    if(!pl||!attack)return;
    if(this._isGxAttack(attack))pl.gxUsed=true;
    if(this._isVstarAttack(attack))pl.vstarUsed=true;
  }

  canUseAttack(pl,mon,attackIndex=0){
    if(!pl||!mon)return {ok:false,reason:'no_pokemon',message:'没有宝可梦'};
    if(this.phase===PHASE.GAME_OVER||this.phase===PHASE.SETUP)return {ok:false,reason:'wrong_phase',message:'当前阶段不能使用招式'};
    // 例外：卡面写着「这个招式，即使是先攻玩家的最初回合也可使用」的招式要放行
    if(this.firstPlayerFirstTurnInProgress&&pl===this.firstPlayer&&!this._attackAllowsFirstTurn(mon,attackIndex))return {ok:false,reason:'first_turn',message:'先攻玩家的最初回合不能使用招式'};
    const st=String(mon.status||'');
    if(st.includes('sleep'))return {ok:false,reason:'asleep',message:'睡眠中无法使用招式'};
    if(st.includes('paralysis'))return {ok:false,reason:'paralyzed',message:'麻痹中无法使用招式'};
    if(mon.cannotAttackNext)return {ok:false,reason:'cannot_attack_next',message:'这个回合无法使用招式'};
    if(!mon.costEliminated&&!this._passiveCostEliminatedByLostZone(mon)&&!this.checkEnergy(mon,attackIndex))return {ok:false,reason:'energy',message:'能量不足'};
    // 场上没有竞技场时「世界终焉」必定失败 → 直接置灰，别让玩家白费一个回合
    if(this._attackRequiresStadium(mon,attackIndex)&&!this.getActiveStadium())return {ok:false,reason:'requires_stadium',message:'场上没有竞技场，这个招式会失败'};
    // 通用招式前提（「若…则这个招式失败」）：不满足时同样置灰并说明原因
    { const pre=this._attackPreconditionFailure(pl,mon,attackIndex); if(pre)return {ok:false,reason:'attack_precondition',message:pre}; }
    // GX/VSTAR 每局一次
    { const once=this._oncePerGameAttackFailure(pl,this.getAttacks(mon)?.[attackIndex]); if(once)return {ok:false,reason:once.reason,message:once.message}; }
    return {ok:true};
  }

  _abilityUsageFailure(pl,ability,source=null){
    for(const eff of ability?.effects||[]){
      const p=eff.params||{};
      // 胜利条件类特性（未知图腾）：进度未达成时置灰，并把进度写进提示
      if(eff.action==='win_condition'){
        const need=+p.threshold||0;
        const have=this._winConditionProgress(pl,p.kind);
        if(have<need)return {reason:'usage_condition',message:`胜利条件未达成：${have}/${need}`};
      }
      // 「转放伤害指示物」类特性（如愿增猿「亢奋脑力」）：
      // 「自己场上有宝可梦带着伤害指示物」是发动前提。没有指示物时该置灰，
      // 而不是点下去才提示（用户反馈：身上有恶能量、但己方场上无指示物仍然可按）。
      if(eff.action==='damage_place'&&p.source==='own_field'){
        const inPlay=this.getPokemonInPlay(pl).filter(Boolean);
        if(!inPlay.some(m=>(m.maxHp-m.hp)>0))return {reason:'usage_condition',message:'发动条件未满足：自己场上需要有带着伤害指示物的宝可梦'};
      }
      if(eff.action!=='usage_condition')continue;
      if(p.kind==='own_pokemon_knocked_out_last_opponent_turn'&&!this.wasOwnPokemonKnockedOutLastOpponentTurn(pl))return {reason:'usage_condition',message:'使用前提未满足：上个对手的回合自己的宝可梦需被击倒'};
      // 怒鹦哥ex「英武重抽」这类「只有在最初的自己的回合可使用1次」→ 不是最初回合就置灰
      if(p.kind==='own_first_turn_only'&&!this._isOwnFirstTurn(pl))return {reason:'usage_condition',message:'只能在最初的自己的回合使用'};
      // 「如果这只宝可梦在战斗场上的话，则…」：来源不在战斗场就不能使用
      if(p.kind==='requires_active'&&source&&pl.active!==source)return {reason:'usage_condition',message:'发动条件未满足：这只宝可梦需在战斗场上'};
      // 「这张卡，只有在自己放逐区有 N 张以上时才可使用」
      if(p.kind==='lost_zone_min'&&(pl?.lostZone?.length||0)<(+p.count||0))return {reason:'trainer_prerequisite',message:`使用前提未满足：自己放逐区需要 ${+p.count||0} 张以上卡牌`};
      if(p.kind==='ability_name_once_per_turn'&&pl.abilityUsedThisTurn?.[`ability-name:${p.abilityName||ability.name}`])return {reason:'already_used',message:'这个名字的特性本回合已使用'};
      // 需求：像愿增猿「亢奋脑力」这种「若这只宝可梦身上附着了【恶】能量」的发动条件，未满足时应判定为不可用（按钮置灰），而不是点了才提示
      if(p.kind==='requires_attached_energy'){
        const want=this._normalizeType(p.type||'colorless');
        const energy=(source&&source.energy)||[];
        const ok=energy.some(e=>{
          const types=(this._energyProvides(e,null)||[]).flat().map(t=>this._normalizeType(t));
          return types.includes(want)||types.includes('any')||(want==='colorless'&&types.length>0);
        });
        if(!ok){
          const zh=({grass:'草',fire:'火',water:'水',lightning:'雷',psychic:'超',fighting:'斗',dark:'恶',metal:'钢',dragon:'龙',fairy:'妖',colorless:'无'})[want]||p.type||'';
          return {reason:'usage_condition',message:`发动条件未满足：需要附着【${zh}】能量`};
        }
      }
    }
    return null;}
  markAbilityUsed(pl,source,ability,zone){const z=this.normalizeAbilityZone(zone||this.inferAbilityZone(pl,source)||ability?.zone||'field');
    if(['active','bench','field'].includes(z)&&this.getPokemonInPlay(pl).includes(source))source.abilityUsed=true;
    else{pl.abilityUsedThisTurn=pl.abilityUsedThisTurn||{};pl.abilityUsedThisTurn[this._abilityUseKey(source,ability,z)]=true;}
    for(const eff of ability?.effects||[]){
      if(eff.action==='usage_condition'&&eff.params?.kind==='ability_name_once_per_turn'){
        pl.abilityUsedThisTurn=pl.abilityUsedThisTurn||{};
        pl.abilityUsedThisTurn[`ability-name:${eff.params.abilityName||ability.name}`]=true;
      }
    }}
  addTemporaryAbilityLock(owner,scope='opponent_active',reason='临时效果'){
    this.temporaryAbilityLocks=this.temporaryAbilityLocks||[];
    this.temporaryAbilityLocks.push({owner,scope,reason,expires:'turn'});
    this.recomputePassives();
  }

  recomputePassives(){
    for(const mon of this.getAllPokemonInPlay()){mon.abilityDisabled=false;mon.abilityDisabledBy=null;}
    // 简化的一轮处理：不做复杂互相消除 fixed-point，足够覆盖常见主动/被动锁特性。
    for(const lock of this.temporaryAbilityLocks||[]){
      const opp=this.getOpponent(lock.owner);
      for(const target of this._abilityNullifyTargets(lock.owner,opp,lock.scope)){
        target.abilityDisabled=true;target.abilityDisabledBy=lock.reason||'临时效果';
      }
    }
    for(const pl of [this.player1,this.player2]){
      const opp=this.getOpponent(pl);
      for(const source of this.getPokemonInPlay(pl)){
        if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
        if(source.ability.zone==='active'&&source!==pl.active)continue;
        for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='ability_nullify')){
          if(eff.params?.sourceZone==='active'&&source!==pl.active)continue;
          for(const target of this._abilityNullifyTargets(pl,opp,eff.params?.scope||'opponent_active')){
            if(target===source||!target?.ability)continue;
            if((eff.params?.exceptAbilityNames||[]).includes(target.ability.name))continue;
            target.abilityDisabled=true;target.abilityDisabledBy=source.ability.name;
          }
        }
      }
    }}
  _abilityNullifyTargets(pl,opp,scope){
    if(scope==='opponent_active')return [opp.active].filter(Boolean);
    if(scope==='opponent_field')return this.getPokemonInPlay(opp);
    if(scope==='self_field')return this.getPokemonInPlay(pl);
    if(scope==='both_field')return [...this.getPokemonInPlay(pl),...this.getPokemonInPlay(opp)];
    return [opp.active].filter(Boolean);}

  getPassiveDamageModifier(attacker,defender,move,pl){let total=0;
    for(const {source,params:p} of this._passiveEffectsFor(attacker,'passive_damage_mod')){
      if((p.target==='self'||p.target==='this')&&source!==attacker)continue;
      if(p.attackerType&&attacker?.element!==this._normalizeType(p.attackerType))continue;
      if(p.attackerName&&attacker?.name&&!attacker.name.includes(p.attackerName))continue;
      if(p.attackerStage==='basic'&&!this._isBasicPokemonInPlay(attacker))continue;
      if(p.excludeSourceName&&attacker?.name===p.excludeSourceName)continue;
      if(p.defenderRule&&!this._isRuleMon(defender,p.defenderRule))continue;
      total+=p.amount||0;
    }
    return total;}
  // 统一计数类条件求值（counter conditions）
  _counterValue(pl, attacker, defender, kind, extra = {}) {
    const opp = this.getOpponent(pl);
    const inPlay = [...(pl.active ? [pl.active] : []), ...(pl.bench || [])].filter(Boolean);
    switch (kind) {
      case 'hand': return pl.hand?.length || 0;
      case 'opponent_hand': return opp.hand?.length || 0;
      case 'own_field_pokemon_count': return inPlay.length;
      case 'own_prizes_taken': return Math.max(0, 6 - (pl.prizes?.length ?? 6));
      case 'own_field_basic_energy_types': { const a = extra.typeA || ''; const b = extra.typeB || ''; let c = 0; for (const m of inPlay) { for (const e of (m.energy || [])) { const s = String(typeof e === 'object' ? (e.cardId || e.name || e) : e); if (s.includes(`【${a}】`) || s.includes(`【${b}】`)) c++; } } return c; }
      case 'own_bench_energy_type_count': { const want = extra.type || ''; let c = 0; for (const m of (pl.bench || [])) { for (const e of (m.energy || [])) { const s = String(typeof e === 'object' ? (e.cardId || e.name || e) : e); if (s.includes(`【${want}】`)) c++; } } return c; }
      case 'own_field_energy_type_count': { const want = extra.type || ''; let c = 0; for (const m of inPlay) { for (const e of (m.energy || [])) { const s = String(typeof e === 'object' ? (e.cardId || e.name || e) : e); if (s.includes(`【${want}】`)) c++; } } return c; }
      // ⚠️ 「造成自己放逐区中宝可梦的张数×N伤害」计的是**宝可梦**，不是全部卡牌
      case 'own_lost_zone_pokemon': return this._lostZonePokemonCount(pl);
      case 'own_lost_zone_total': return (pl.lostZone || []).length;
      case 'opponent_field_ability_count': return [opp.active, ...(opp.bench || [])].filter(Boolean).filter(m => m.ability).length;
      case 'own_field_has_damage': return inPlay.filter(m => m && m.maxHp && m.hp < m.maxHp).length;
      case 'own_field_pokemon_type': {
        // 这条计数只服务于「只有当自己场上所有的宝可梦都是【X】属性的场合才生效」的特性
        //（如 SSP-088「造成自己场上【恶】宝可梦数量×30伤害」）。前提不满足时该特性整体不生效，
        // 加成必须归零——实测此前非全恶场也会照常 +30×N。
        const gate = this._monoTypeGateOf(pl);
        if (gate && !this.hasMonoTypeField(pl, gate)) return 0;
        const ty = this._normalizeType(extra.type || '');
        return inPlay.filter(m => m && this._normalizeType(m.element) === ty).length;
      }
      case 'own_bench_pokemon_type': { const ty = this._normalizeType(extra.type || ''); return (pl.bench || []).filter(m => m && this._normalizeType(m.element) === ty).length; }
      case 'own_field_tool': return inPlay.filter(m => m && m.tool).length;
      case 'self_basic_type_count': { const ts = new Set(); for (const e of (attacker?.energy || [])) { const s = String(typeof e === 'object' ? (e.cardId || e.name || e) : e); const mm = s.match(/【(.+?)】/); if (mm && (s.includes('基本') || !String(e).includes('特殊'))) ts.add(mm[1]); } return ts.size; }
      case 'discard_supporter': { let c = 0; for (const d of (pl.discard || [])) { const cd = (typeof d === 'object' && d) ? d : this.cardResolver?.getCard?.(d); if (!cd) continue; if ((cd.cardType === 'trainer' && cd.trainerType === 'supporter') || String(cd.name || cd['卡牌名字'] || '').includes('支援者')) c++; } return c; }
      case 'opponent_discard_supporter': { let c = 0; for (const d of (opp.discard || [])) { const cd = (typeof d === 'object' && d) ? d : this.cardResolver?.getCard?.(d); if (!cd) continue; if ((cd.cardType === 'trainer' && cd.trainerType === 'supporter') || String(cd.name || cd['卡牌名字'] || '').includes('支援者')) c++; } return c; }
      case 'discard_name': { const want = extra.name || ''; let c = 0; for (const d of (pl.discard || [])) { const cd = (typeof d === 'object' && d) ? d : this.cardResolver?.getCard?.(d); if (!cd) continue; if (String(cd.name || cd['卡牌名字'] || '').includes(want)) c++; } return c; }
      case 'discard_pokemon': { let c = 0; for (const d of (pl.discard || [])) { const cd = (typeof d === 'object' && d) ? d : this.cardResolver?.getCard?.(d); if (!cd) continue; if (cd.cardType === 'pokemon' || (cd['类型'] || cd['类别'] || '') === '宝可梦') c++; } return c; }
      case 'discard_energy_type': { const want = extra.type || ''; let c = 0; for (const d of (pl.discard || [])) { const s = String(typeof d === 'object' ? (d.name || d.cardId || d) : d); if (s.includes(`【${want}】`)) c++; } return c; }
      case 'opponent_field_rule': { const rule = extra.rule || ''; return [opp.active, ...(opp.bench || [])].filter(Boolean).filter(m => this._isRuleMon(m, rule)).length; }
      case 'opponent_active_status_count': return opp.active?.status ? String(opp.active.status).split(',').filter(Boolean).length : 0;
      default: return 0;
    }
  }
  // 判断场上宝可梦是否为特定规则（宝可梦V/GX/ex），用于防守方限定伤害加成
  _isRuleMon(mon, rule){
    if(!mon)return false;
    if(rule==='ex')return !!mon.isEx;
    if(rule==='宝可梦V'){const name=mon.name||'';if(/(?:^|[^a-zA-Z0-9])(?:VMAX|VSTAR|V)$/.test(name))return true;const cd=mon.cardId&&this.cardResolver?.getCard?.(mon.cardId);return !!(cd&&['V','VMAX','VSTAR'].includes(cd.mechanic));}
    if(rule==='宝可梦GX・EX'){const name=mon.name||'';if(/(?:^|[^a-zA-Z0-9])GX$/.test(name))return true;if(mon.isEx)return true;const cd=mon.cardId&&this.cardResolver?.getCard?.(mon.cardId);return !!(cd&&(cd.mechanic==='GX'||cd.mechanic==='ex'));}
    if(/V(?:MAX|STAR)?|GX|ex/i.test(rule)){return this._isRuleMon(mon, rule.includes('GX')?'宝可梦GX・EX':rule.includes('V')?'宝可梦V':'ex');}
    return false;}
  getConditionalDamageModifier(attacker,defender,move,pl){let total=0;
    for(const eff of move?.effects||[]){
      if(eff.action==='discard_energy_for_damage'){const cnt=eff.params?.mode==='type_count'?(eff._discardedTypeCount||0):(eff._discardedCount||0);total+=(eff.params?.amountPer||0)*cnt;continue;}
      if(eff.params?.mode==='reduce'){const dmg=attacker?Math.max(0,(attacker.maxHp||0)-attacker.hp):0;total-=(eff.params?.amount||0)*Math.floor(dmg/10);continue;}
      if(eff.params?.condition==='counter'){total+=(eff.params?.amount||0)*this._counterValue(pl,attacker,defender,eff.params?.counter||'',eff.params||{});continue;}
      if(eff.action!=='conditional_damage_mod')continue;
      const p=eff.params||{};
      if(p.condition==='own_pokemon_knocked_out_last_opponent_turn'){if(!this.wasOwnPokemonKnockedOutLastOpponentTurn(pl))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_retreat_cost'){total+=(p.amount||0)*(defender?.retreatCostOverride??defender?.retreatCost??0);continue;}
      if(p.condition==='opponent_active_energy_count'){total+=(p.amount||0)*(defender?.energy?.length||0);continue;}
      if(p.condition==='self_has_damage'){if(!(attacker&&attacker.maxHp&&attacker.hp<attacker.maxHp))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_has_damage'){if(!(defender&&defender.maxHp&&defender.hp<defender.maxHp))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_type'){if(!defender||this._normalizeType(defender.element)!==this._normalizeType(p.type))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_damage_counters'){const dmg=defender?Math.max(0,defender.maxHp-defender.hp):0;total+=(p.amount||0)*Math.floor(dmg/10);continue;}
      // ===== z2：按来源文本映射出来的 counter =====
      if(p.condition==='own_prizes'){total+=(p.amount||0)*(pl.prizes?.length||0);continue;}
      if(p.condition==='opponent_active_status_count'){const st=String(defender?.status||'');total+=(p.amount||0)*(st?st.split(',').filter(Boolean).length:0);continue;}
      if(p.condition==='own_field_evolved_count'){total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).filter(m=>m.evolvesFrom).length;continue;}
      if(p.condition==='own_field_energy_name'){const want=String(p.name||'');total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).reduce((s,m)=>s+(m.energy||[]).filter(e=>String(typeof e==='object'?(e.name||e.cardId):e).includes(want)).length,0);continue;}
      if(p.condition==='own_field_pokemon_with_energy_type'){const want=String(p.type||'');total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).filter(m=>(m.energy||[]).some(e=>String(typeof e==='object'?(e.name||e.cardId):e).includes(`【${want}】`))).length;continue;}
      if(p.condition==='own_field_basic_energy_type_count'){const ts=new Set();for(const m of [pl.active,...(pl.bench||[])].filter(Boolean)){for(const e of (m.energy||[])){const s=String(typeof e==='object'?(e.name||e.cardId):e);if(!s.includes('基本'))continue;const mm=s.match(/【(.+?)】/);if(mm)ts.add(mm[1]);}}total+=(p.amount||0)*ts.size;continue;}
      if(p.condition==='own_bench_name_count'){const want=String(p.name||'');total+=(p.amount||0)*(pl.bench||[]).filter(Boolean).filter(m=>String(m.name||'').includes(want)).length;continue;}
      if(p.condition==='opponent_field_name_count'){const opp=this.getOpponent(pl);const want=String(p.name||'');total+=(p.amount||0)*[opp.active,...(opp.bench||[])].filter(Boolean).filter(m=>String(m.name||'').includes(want)).length;continue;}
      // 「造成自己场上的「X」数量×N伤害」（按名字匹配自己场上的宝可梦）
      if(p.condition==='own_field_name_count'){const want=String(p.name||'');total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).filter(m=>String(m.name||'').includes(want)).length;continue;}
      // 「造成其中X张数×N伤害」——「其中」指上一个动作处理过的那批卡（记录在 gs._lastProcessed）
      if(p.condition==='last_processed_kind'){total+=(p.amount||0)*this._countLastProcessed(p.kind);continue;}
      // 「造成自己弃牌区中能量张数×N伤害」（不限定属性）
      if(p.condition==='discard_energy_total'){total+=(p.amount||0)*(pl.discard||[]).filter(d=>{const cd=(typeof d==='object'&&d)?d:this.cardResolver?.getCard?.(d);return cd&&(cd.cardType==='energy'||cd.cardType==='specialEnergy');}).length;continue;}
      // 「与自己弃牌区中的宝可梦张数相同数量」
      if(p.condition==='discard_pokemon'){total+=(p.amount||0)*(pl.discard||[]).filter(d=>{const cd=(typeof d==='object'&&d)?d:this.cardResolver?.getCard?.(d);return cd&&cd.cardType==='pokemon';}).length;continue;}
      if(p.condition==='self_damage_counters'){const dmg=attacker?Math.max(0,attacker.maxHp-attacker.hp):0;total+=(p.amount||0)*Math.floor(dmg/10);continue;}
      if(p.condition==='self_energy'){total+=(p.amount||0)*(attacker?.energy?.length||0);continue;}
      if(p.condition==='total_bench'){total+=(p.amount||0)*((this.player1.bench?.length||0)+(this.player2.bench?.length||0));continue;}
      if(p.condition==='count'){total+=p.amount||0;continue;}
      if(p.condition==='opponent_field_energy'){const opp=this.getOpponent(pl);total+=(p.amount||0)*[opp.active,...(opp.bench||[])].filter(Boolean).reduce((s,m)=>s+(m.energy?.length||0),0);continue;}
      if(p.condition==='own_field_energy'){total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).reduce((s,m)=>s+(m.energy?.length||0),0);continue;}
      if(p.condition==='opponent_field_energy_type'){const opp=this.getOpponent(pl);const want=p.type||'';total+=(p.amount||0)*[opp.active,...(opp.bench||[])].filter(Boolean).reduce((s,m)=>s+(m.energy||[]).filter(e=>String(e).includes(`【${want}】`)).length,0);continue;}
      if(p.condition==='opponent_bench_count'){const opp=this.getOpponent(pl);total+=(p.amount||0)*(opp.bench?.length||0);continue;}
      if(p.condition==='opponent_prizes_taken'){const opp=this.getOpponent(pl);total+=(p.amount||0)*Math.max(0,6-(opp.prizes?.length??6));continue;}
      if(p.condition==='both_active_energy_count'){total+=(p.amount||0)*((attacker?.energy?.length||0)+(defender?.energy?.length||0));continue;}
      if(p.condition==='own_bench_count'){total+=(p.amount||0)*(pl.bench?.length||0);continue;}
      if(p.condition==='own_bench_type_count'){const ts=new Set();for(const m of (pl.bench||[])){if(!m)continue;for(const e of (m.energy||[])){const mm=String(e).match(/【(.+?)】/);if(mm)ts.add(mm[1]);}}total+=(p.amount||0)*ts.size;continue;}
      if(p.condition==='own_discard_move_count'){const want=p.moveName||'';let c=0;for(const d of (pl.discard||[])){const cd=(typeof d==='object'&&d)?d:this.cardResolver?.getCard?.(d);if(!cd)continue;const atks=Array.isArray(cd.attacks)?cd.attacks:(Array.isArray(cd['技能列表'])?cd['技能列表']:[]);if(atks.some(a=>String(a?.name||a?.名字||'').includes(want)))c++;}total+=(p.amount||0)*c;continue;}
      if(p.condition==='own_bench_move_count'){const want=p.moveName||'';let c=0;for(const m of (pl.bench||[])){if(!m?.attacks)continue;if(m.attacks.some(a=>String(a?.name||'').includes(want)))c++;}total+=(p.amount||0)*c;continue;}
      if(p.condition==='own_discard_type_count'){const want=p.energyType||'';let c=0;for(const d of (pl.discard||[])){const cd=(typeof d==='object'&&d)?d:this.cardResolver?.getCard?.(d);if(!cd)continue;if(String(cd['属性']||cd.element||'').includes(want))c++;}total+=(p.amount||0)*c;continue;}
      if(p.condition==='own_field_energy_type_count'){const ts=new Set();for(const m of [pl.active,...(pl.bench||[])]){if(!m)continue;for(const e of (m.energy||[])){const mm=String(e).match(/【(.+?)】/);if(mm)ts.add(mm[1]);}}total+=(p.amount||0)*ts.size;continue;}
      if(p.condition==='own_field_energy_type'){const want=p.type||'';total+=(p.amount||0)*[pl.active,...(pl.bench||[])].filter(Boolean).reduce((s,m)=>s+(m.energy||[]).filter(e=>String(e).includes(`【${want}】`)).length,0);continue;}
      if(p.condition==='opponent_active_status'){if(!defender?.status||!String(defender.status).includes(p.status))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_any_status'){if(!defender?.status)continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_is_evolved'){if(!defender)continue;const st=String(defender.stage||'');if(!defender.evolvesFrom&&(!st||st==='基础'||/^basic$/i.test(st)))continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_name'){if(!defender?.name||!String(defender.name).includes(p.name))continue;total+=p.amount||0;continue;}
      if(p.condition==='self_has_tool'){if(!attacker?.tool)continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_has_tool'){if(!defender?.tool)continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_active_no_damage'){if(defender&&defender.maxHp&&defender.hp<defender.maxHp)continue;total+=p.amount||0;continue;}
      if(p.condition==='self_no_damage'){if(attacker&&attacker.maxHp&&attacker.hp<attacker.maxHp)continue;total+=p.amount||0;continue;}
      if(p.condition==='self_no_hand'){if((pl.hand?.length||0)!==0)continue;total+=p.amount||0;continue;}
      if(p.condition==='hand_count_equal'){const opp=this.getOpponent(pl);if((pl.hand?.length||0)!==(opp.hand?.length||0))continue;total+=p.amount||0;continue;}
      if(p.condition==='supporter_used_this_turn'){if(!pl.supporterUsed)continue;total+=p.amount||0;continue;}
      if(p.condition==='opponent_prizes'){const opp=this.getOpponent(pl);if((opp.prizes?.length??6)!==(p.count??1))continue;total+=p.amount||0;continue;}
      if(p.condition==='own_prizes_more'){const opp=this.getOpponent(pl);if((pl.prizes?.length??6)<=(opp.prizes?.length??6))continue;total+=p.amount||0;continue;}
      if(p.condition==='self_has_energy_type'){const want=p.type||'';if(!(attacker?.energy||[]).some(e=>String(e).includes(`【${want}】`)))continue;total+=p.amount||0;continue;}
      if(p.condition==='self_has_special_energy'){if(!(attacker?.energy||[]).some(e=>String(e).includes('特殊')))continue;total+=p.amount||0;continue;}
      if(p.condition==='own_bench_has_damage'){if(!(pl.bench||[]).some(m=>m&&m.maxHp&&m.hp<m.maxHp))continue;total+=p.amount||0;continue;}
      if(p.condition==='stadium_in_play'){if(!this.getActiveStadium())continue;total+=p.amount||0;continue;}
      // 兜底：**没有条件**的 conditional_damage_mod 就是一笔固定加成（「在这种情况下，增加N伤害」）。
      // ⚠️ 此前没有兜底 → 这类项恒加 0（与 __zero 同类的静默归零）。
      //    注意只对「condition 缺失」兜底；写了但不认识的条件仍然按 0 处理（如实保留未建模语义）。
      if(p.condition===undefined&&p.amount)total+=p.amount;
      // 未知条件：默认不加伤，避免误判（不再落入无条件加伤）
    }
    total+=this._applyTurnAttackModifiers(attacker,defender,move,pl);
    return total;}
  // 条件分支判断：供 conditional_effect / conditional_damage_mod 复用
  _conditionSatisfied(attacker,condition,p={}){
    const pl=[this.player1,this.player2].find(x=>this.getPokemonInPlay(x).includes(attacker))||this.currentPlayer;
    const defender=this.getOpponent(pl)?.active;
    switch(condition){
      case 'own_pokemon_knocked_out_last_opponent_turn': return this.wasOwnPokemonKnockedOutLastOpponentTurn(pl);
      case 'self_has_damage': return !!(attacker&&attacker.maxHp&&attacker.hp<attacker.maxHp);
      case 'opponent_active_has_damage': return !!(defender&&defender.maxHp&&defender.hp<defender.maxHp);
      case 'opponent_active_type': return !!(defender&&this._normalizeType(defender.element)===this._normalizeType(p.type));
      case 'opponent_active_status': return !!(defender?.status&&String(defender.status).includes(p.status));
      case 'opponent_active_any_status': return !!defender?.status;
      case 'opponent_active_is_evolved': {if(!defender)return false;const st=String(defender.stage||'');return !!(defender.evolvesFrom||(st&&st!=='基础'&&!/^basic$/i.test(st)));}
      case 'opponent_active_name': return !!(defender?.name&&String(defender.name).includes(p.name));
      case 'self_has_tool': return !!attacker?.tool;
      case 'opponent_active_has_tool': return !!defender?.tool;
      case 'opponent_active_no_damage': return !(defender&&defender.maxHp&&defender.hp<defender.maxHp);
      case 'self_no_damage': return !(attacker&&attacker.maxHp&&attacker.hp<attacker.maxHp);
      case 'self_no_energy': return (attacker?.energy?.length||0)===0;
      case 'self_no_hand': return (pl.hand?.length||0)===0;
      case 'hand_count_equal': return (pl.hand?.length||0)===(this.getOpponent(pl).hand?.length||0);
      case 'opponent_prizes': return (this.getOpponent(pl).prizes?.length??6)===(p.count??1);
      case 'own_prizes_more': return (pl.prizes?.length??6)>(this.getOpponent(pl).prizes?.length??6);
      case 'self_has_energy_type': return (attacker?.energy||[]).some(e=>String(e).includes(`【${p.type}】`));
      case 'self_has_special_energy': return (attacker?.energy||[]).some(e=>String(e).includes('特殊'));
      case 'own_bench_has_damage': return (pl.bench||[]).some(m=>m&&m.maxHp&&m.hp<m.maxHp);
      case 'stadium_in_play': return !!this.getActiveStadium();
      case 'supporter_used_this_turn': return !!pl.supporterUsed;
      case 'evolved_this_turn': return !!attacker?.evolvedThisTurn;
      case 'own_discard_items_gte': {
        let c=0;
        for(const d of (pl.discard||[])){const s=String((typeof d==='object'&&d)?(d.name||d.cardId||d):d);if(s.includes('宝可梦道具')||s.includes('工具'))c++;}
        return c>=(p.count||9);
      }
      case 'stadium_not_in_play': return !this.getActiveStadium();
      case 'own_energy_eq_opponent': return (attacker?.energy?.length || 0) === (defender?.energy?.length || 0);
      default: return false;
    }
  }
  isBenchProtectedFromOpponentAttack(owner,mon,kind='damage',attackerOwner=null){
    if(!owner?.bench?.includes(mon))return false;
    if(attackerOwner&&attackerOwner!==this.getOpponent(owner))return false;
    for(const source of this.getPokemonInPlay(owner)){
      if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
      for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='bench_attack_shield')){
        const p=eff.params||{};
        if(p.target!=='own_bench')continue;
        if(kind==='damage'&&p.preventDamage!==false)return true;
        if(kind==='effect'&&p.preventEffect!==false)return true;
      }
    }
    return false;}
  _isBasicPokemonInPlay(mon){const owner=[this.player1,this.player2].find(pl=>this.getPokemonInPlay(pl).includes(mon));
    const card=mon?.cardId&&this.cardResolver?.getCard?.(mon.cardId);
    if(card)return card.cardType==='pokemon'&&(!card.evolvesFrom)&&(!card.stage||card.stage==='基础');
    return !mon?.evolvesFrom&&(!mon?.stage||mon.stage==='基础'||mon.stage==='basic');}
  _enabledAbilityEffects(mon){return mon?.ability?.effects||[];}
  /**
   * ③ 「当这只宝可梦受到招式的伤害时，抛掷硬币；正面则不受到该伤害」——**自身**限定特性。
   * 注意不能用 _hasPassive / _passiveEffectsFor：那两个是**全场**搜索（用于光环类特性），
   * 而卡面写的是「这只宝可梦」，套到队友身上就错了。
   */
  hasAbilityDamageFlipShield(mon){
    if(!mon||!mon.ability?.effects?.length)return false;
    if(this.isAbilityDisabled?.(mon))return false;
    return (this._enabledAbilityEffects(mon)||[]).some(e=>e.action==='coin_flip_damage_shield');
  }
  // 统一被动查询入口：返回 mon 所属阵营场上所有来源的某 action 生效效果（已跳过 disabled）
  _passiveEffectsFor(mon,action){
    const owner=[this.player1,this.player2].find(pl=>this.getPokemonInPlay(pl).includes(mon));
    if(!owner)return this.isAbilityDisabled(mon)?[]:(this._enabledAbilityEffects(mon)||[]).filter(e=>e.action===action).map(e=>({source:mon,params:e.params||{}}));
    const out=[];
    for(const source of this.getPokemonInPlay(owner)){
      if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
      for(const eff of this._enabledAbilityEffects(source)){if(eff.action===action)out.push({source,params:eff.params||{}});}
    }
    return out;}
  _hasPassive(mon,action){return this._passiveEffectsFor(mon,action).length>0;}
  // 触发式事件分发：由 EffectExecutor 注入 handler（_emitTriggers）
  emitTriggerEvent(event,payload={}){if(this._triggerHandler){try{this._triggerHandler(event,payload);}catch(e){/* 忽略 */}}}
  // 最大 HP 被动加成（特性「附特殊能量则最大HP+N」）
  getPassiveMaxHpModifier(mon){let total=0;for(const {source,params:p} of this._passiveEffectsFor(mon,'max_hp_mod')){if(p.condition==='self_has_special_energy'&&!(mon?.energy||[]).some(e=>String(e).includes('特殊')))continue;total+=p.amount||0;}return total;}
  // 检查 pl 的对手场上是否有某被动（“对手的…无法…”类）
  _opponentHasPassive(pl,action){const opp=this.getOpponent(pl);return this._passiveEffectsFor(opp.active,action).length>0;}
  // 防守方受击时的被动受伤修正（能力“只要在场上…受到伤害±N”）
  getPassiveDamageReceivedModifier(mon){let total=0;
    for(const {source,params:p} of this._passiveEffectsFor(mon,'damage_received_mod')){
      if((p.target==='self'||p.target==='this')&&source!==mon)continue;
      total+=p.amount||0;
    }
    return total;}
  _energyMultiplierEffectsFor(mon){
    const owner=[this.player1,this.player2].find(pl=>this.getPokemonInPlay(pl).includes(mon));
    if(!owner)return this.isAbilityDisabled(mon)?[]:this._enabledAbilityEffects(mon).filter(e=>e.action==='energy_provides_multiplier');
    const effects=[];
    for(const source of this.getPokemonInPlay(owner)){
      if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
      for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='energy_provides_multiplier')){
        const target=eff.params?.target||'self';
        if(target==='self'&&source!==mon)continue;
        effects.push(eff);
      }
    }
    return effects;
  }
  _energyMatchesType(provides,type){return provides.some(p=>p.includes(type)||p.includes('any'));}
  _normalizeType(type){return TYPE_EN[type]||type||'colorless';}

  takePrize(pl){
    // ⑨「在下个对手的回合，对手也无法拿取奖赏卡」
    if(pl.playRestrictions?.prizes){this.addLog(`${pl.name} 下回合无法拿取奖赏卡`);return;}
    if(pl.prizes.length>0){const prize=pl.prizes.pop();pl.hand.push(prize);this.addLog(`${pl.name} 获奖品卡 剩${pl.prizes.length}`);
    if(pl.prizes.length===0){this.winner=pl;this.phase=PHASE.GAME_OVER;this.addLog(`${pl.name} 胜利！`);}}}
  prizesForKnockout(mon){return this.isExPokemon(mon)?2:1;}
  takePrizesForKnockout(pl,mon){const count=this.prizesForKnockout(mon);for(let i=0;i<count&&pl?.prizes?.length>0&&this.phase!==PHASE.GAME_OVER;i++)this.takePrize(pl);}

  /**
   * 昏厥的宝可梦该进哪个区域、身上的卡牌是否一起走。
   * 卡面来源：
   *   场地「放逐市」：双方昏厥都进放逐区（只算宝可梦本体）
   *   耿鬼（战斗场上的对手方）：对手的宝可梦昏厥时进放逐区
   *   达克莱伊（本招式）/ 班基拉斯GX（本宝可梦的招式）：那个昏厥的宝可梦+身上所有卡牌进放逐区
   */
  /**
   * 「（除宝可梦以外的卡牌，全部放于弃牌区。）」
   * —— 这只宝可梦被放入放逐区时，身上附着的能量/道具**进弃牌区**（而不是跟着进放逐区）。
   * 卡面把这条写在括号里，解析端记成 `attachments_to_discard` 标记；此处据标记改目的地。
   */
  _hasAttachmentsToDiscard(mon){
    if(!mon?.ability?.effects?.length)return false;
    return (this._enabledAbilityEffects(mon)||[]).some(e=>e.action==='usage_condition'&&e.params?.kind==='attachments_to_discard');
  }

  _knockoutDestination(ownerPl){
    const ctx=this._koContext||null;
    // ③ 招式型：由本招式的效果直接标记
    if(ctx?.toLostZone)return {toLostZone:true,withAttachments:!!ctx.withAttachments};
    // ④ 招式伤害型特性：攻击者是带该特性的宝可梦
    if(ctx?.attacker){
      for(const eff of (this._enabledAbilityEffects(ctx.attacker)||[])){
        if(eff.action==='ko_to_lost_zone'&&eff.params?.scope==='own_attack')
          return {toLostZone:true,withAttachments:!!eff.params.withAttachments};
      }
    }
    // ① 场地持续效果
    const stadium=this.getActiveStadium();
    for(const eff of (stadium?.effects||[])){
      if(eff.action==='ko_to_lost_zone'&&eff.params?.scope==='both')
        return {toLostZone:true,withAttachments:!!eff.params.withAttachments};
    }
    // ② 对手场上（出战位）的光圈型特性
    const opp=this.getOpponent(ownerPl);
    if(opp?.active&&!opp.active.abilityDisabled){
      for(const eff of (this._enabledAbilityEffects(opp.active)||[])){
        if(eff.action==='ko_to_lost_zone'&&eff.params?.scope==='opponent')
          return {toLostZone:true,withAttachments:!!eff.params.withAttachments};
      }
    }
    return {toLostZone:false,withAttachments:false};
  }

  knockout(pl){if(!pl.active)return;const knockedOut=pl.active;
    const dest=this._knockoutDestination(pl);
    const zone=dest.toLostZone?(pl.lostZone=pl.lostZone||[]):pl.discard;
    zone.push(knockedOut.cardId);
    // 身上的能量/道具：以前**直接丢失**（既没进弃牌区也没进放逐区）→ 现在按目的地放好
    // 「除宝可梦以外的卡牌全部放于弃牌区」→ 即便宝可梦进放逐区，附着卡也进弃牌区
    const attachZone=(dest.toLostZone&&dest.withAttachments&&!this._hasAttachmentsToDiscard(knockedOut))?zone:pl.discard;
    for(const e of (knockedOut.energy||[]))attachZone.push(this._toolCardValue(e));
    if(knockedOut.tool)attachZone.push(this._toolCardValue(knockedOut.tool));
    this._recordKnockout(pl);
    this.addLog(`${pl.name} 的 ${knockedOut.name} 被击倒！${dest.toLostZone?'（放于放逐区）':''}`);
    const opp=this.getOpponent(pl);this.takePrizesForKnockout(opp,knockedOut);
    if(pl.bench.length>0){pl.active=pl.bench.shift();this.addLog(`${pl.name} 换上 ${pl.active.name}`);this.recomputePassives();}
    else{this.winner=opp;this.phase=PHASE.GAME_OVER;this.addLog(`${opp.name} 胜利！`);}}

  // 起手是否有基础宝可梦（用于开局重新抽牌判定）
  hasBasicInHand(pl){
    return (pl?.hand||[]).some(cid=>{
      const cd=this.cardResolver?.getCard?.(cid);
      if(!cd||cd.cardType!=='pokemon')return false;
      const stage=String(cd.stage||'');
      return !cd.evolvesFrom&&(!stage||stage==='基础');
    });
  }

  // 重新抽起始手牌：展示手牌 → 洗回牌库 → 重抽 7 张（并计数）
  mulliganHand(pl){
    this.mulliganCount=this.mulliganCount||{player1:0,player2:0};
    const key=pl===this.player1?'player1':'player2';
    this.mulliganCount[key]++;
    pl.deck=this._shuffle([...pl.deck,...pl.hand]);
    pl.hand=[];
    pl.draw(7);
    this.addLog(`${pl.name} 没有基础宝可梦，重新抽起始手牌（第${this.mulliganCount[key]}次）`);
    return this.mulliganCount[key];
  }

  addLog(msg){
    if(!Array.isArray(this.log))this.log=[];
    this.log.push(msg);
    if(this.log.length>MAX_LOG_ENTRIES)this.log.splice(0,this.log.length-MAX_LOG_ENTRIES);
    // 桥接 UI：玩家/对手的卡牌使用与场上变化写入左上信息栏
    try { this.onLog?.(msg); } catch (e) { /* UI 回调异常不影响对局 */ }
  }
  _shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
}
