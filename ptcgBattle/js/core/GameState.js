// js/core/GameState.js — (含能量+进化+特性)

export const PHASE = { SETUP:'setup',DRAW:'draw',MAIN:'main',BATTLE:'battle',END:'end',GAME_OVER:'game_over' };
export const MAX_LOG_ENTRIES = 200;

const TYPE_CN = { grass:'草',fire:'火',water:'水',lightning:'雷',psychic:'超',fighting:'斗',dark:'恶',metal:'钢',dragon:'龙',fairy:'妖',colorless:'无' };
const TYPE_EN = Object.fromEntries(Object.entries(TYPE_CN).map(([k,v])=>[v,k]));

export class PlayerState {
  constructor(name){this.name=name;this.deck=[];this.hand=[];this.discard=[];this.prizes=[];this.active=null;this.bench=[];
    this.stadium=null;this.supporterUsed=false;this.energyAttached=false;this.retreatUsed=false;this.abilityUsedThisTurn={};this.stadiumUsedThisTurn={};}
  draw(n=1){const d=[];for(let i=n;i>0&&this.deck.length;i--){const c=this.deck.pop();this.hand.push(c);d.push(c);}return d;}
}

export class GameState {
  constructor(){this.player1=new PlayerState('玩家');this.player2=new PlayerState('对手');
    this.currentPlayer=this.player1;this.phase=PHASE.SETUP;this.turn=0;this.log=[];this.winner=null;this.temporaryAbilityLocks=[];
    this.firstPlayer=null;this.firstPlayerFirstTurnInProgress=false;
    this.stadium=null;this.pendingPick=null;this.pendingPokemonPick=null;this.knockoutHistory=[];}

  waitForPick(cards,count,options={}){return new Promise(r=>{this.pendingPick={cards,count,options,resolve:r};this._onPendingPick?.(this.pendingPick);});}
  waitForPokemonPick(player, options={}){return new Promise(r=>{this.pendingPokemonPick={player,options,resolve:r};this._onPendingPokemonPick?.(this.pendingPokemonPick);});}
  resolvePokemonPick(slot){if(this.pendingPokemonPick){const r=this.pendingPokemonPick.resolve;this.pendingPokemonPick=null;r(slot);}}
  resolvePick(selected){if(this.pendingPick){const r=this.pendingPick.resolve;this.pendingPick=null;r(selected);}}

  init(p1,p2){for(const pl of[this.player1,this.player2]){pl.hand=[];pl.discard=[];pl.active=null;pl.bench=[];pl.stadium=null;pl.abilityUsedThisTurn={};pl.stadiumUsedThisTurn={};}
    this.stadium=null;
    this.player1.deck=this._shuffle([...p1]);this.player2.deck=this._shuffle([...p2]);
    this.player1.prizes=this.player1.deck.splice(-6,6);this.player2.prizes=this.player2.deck.splice(-6,6);
    this.player1.draw(7);this.player2.draw(7);
    this.turn=0;this.phase=PHASE.SETUP;this.winner=null;this.log=[];this.currentPlayer=this.player1;this.temporaryAbilityLocks=[];
    this.firstPlayer=null;this.firstPlayerFirstTurnInProgress=false;this.knockoutHistory=[];
    this.addLog('请放置1只基础宝可梦到战斗区');}

  setPhase(p){this.phase=p;}
  nextPhase(){const o=[PHASE.DRAW,PHASE.MAIN,PHASE.BATTLE,PHASE.END];const i=o.indexOf(this.phase);
    i>=0&&i<o.length-1?this.setPhase(o[i+1]):(i===o.length-1&&this.endTurn());}

  endTurn(){
    // Clear per-turn buffs on current player's pokemon
    for(const mon of[this.currentPlayer.active,...this.currentPlayer.bench]){
      if(!mon)continue;
      mon.damageMod=0;mon.preventDamage=false;mon.preventEffect=false;
      mon.cannotAttackNext=false;mon.cannotRetreat=false;mon.ignore=[];
      mon.costEliminated=false;mon.abilityUsed=false;
      // Status damage: poison -10, burn -20
      if(mon.status){
        if(mon.status.includes('poison')){mon.hp-=10;this.addLog(`${mon.name} 中毒 -10`);}
        if(mon.status.includes('burn')){mon.hp-=20;this.addLog(`${mon.name} 灼伤 -20`);}
        if(mon.status.includes('paralysis')){mon.status=mon.status.split(',').filter(s=>s!=='paralysis').join(',')||null;this.addLog(`${mon.name} 麻痹恢复`);}
        if(mon.status&&mon.status.includes('sleep')&&Math.random()<0.5){mon.status=mon.status.split(',').filter(s=>s!=='sleep').join(',')||null;this.addLog(`${mon.name} 睡眠恢复`);}
        if(mon.hp<=0){
          const owner=[this.player1,this.player2].find(p=>p.active===mon||p.bench.includes(mon));
          if(owner)this.knockout(owner);
        }
      }
    }
    if(this.firstPlayerFirstTurnInProgress&&this.currentPlayer===this.firstPlayer)this.firstPlayerFirstTurnInProgress=false;
    this.currentPlayer.supporterUsed=false;this.currentPlayer.energyAttached=false;this.currentPlayer.retreatUsed=false;this.currentPlayer.abilityUsedThisTurn={};this.currentPlayer.stadiumUsedThisTurn={};
    this.temporaryAbilityLocks=(this.temporaryAbilityLocks||[]).filter(lock=>lock.expires!=='turn'&&lock.owner!==this.currentPlayer);
    for(const mon of[this.currentPlayer.active,...this.currentPlayer.bench]){if(mon){mon.placedThisTurn=false;mon.evolvedThisTurn=false;}}
    this.currentPlayer=(this.currentPlayer===this.player1)?this.player2:this.player1;
    this.turn++;this.setPhase(PHASE.DRAW);this.addLog(`第${this.turn}回合 — ${this.currentPlayer.name}`);this.currentPlayer.draw(1);this.recomputePassives();}

  _makeMon(cid,cd,n,hp){return {cardId:cid,name:n,hp,maxHp:hp,element:cd?.element||'colorless',weakness:cd?.weakness||null,resistance:cd?.resistance||null,
    attacks:cd?.attacks||[{name:'撞击',damage:20,cost:[],effect:''}],energy:[],status:null,placedThisTurn:true,evolvedThisTurn:false,
    tool:null,ability:cd?.ability||null,abilityUsed:false,abilityDisabled:false,abilityDisabledBy:null,damageMod:0,preventDamage:false,preventEffect:false,cannotAttackNext:false,cannotRetreat:false,
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
    if(cd.specialRules?.requiresDiscardOnAttach&&pl.hand.length<=1){this.addLog('需要先丢弃1张其他手牌');return false;}
    const attached=pl.hand.splice(idx,1)[0];
    if(cd.specialRules?.requiresDiscardOnAttach&&pl.hand.length>0)pl.discard.push(pl.hand.pop());
    t.energy.push({cardId:attached,name:cd.name,provides:cd.provides||null,specialRules:cd.specialRules||null});
    if(cd.specialRules?.damageOnAttach){t.hp-=cd.specialRules.damageOnAttach;this.addLog(`${t.name} 因 ${cd.name} 受到${cd.specialRules.damageOnAttach}伤害`);}
    if(cd.specialRules?.maxHpBonus&&(!cd.element||t.element===cd.element||cd.name.includes(t.element))){t.maxHp+=cd.specialRules.maxHpBonus;t.hp+=cd.specialRules.maxHpBonus;}
    if(cd.specialRules?.preventWeakness)t.weakness=null;
    if(cd.specialRules?.retreatCostZero)t.retreatCostOverride=0;
    if(cd.specialRules?.blockAttackEffects)t.preventEffect=true;
    if(cd.specialRules?.blockSpecialCondition)t.status=null;
    pl.energyAttached=true;
    this.addLog(`${pl.name} 为 ${t.name} 附着了 ${cd.name}`);return true;}

  checkEnergy(mon,ai){const a=mon.attacks?.[ai];if(!a||!a.cost||a.cost.length===0)return true;
    return this._canPayEnergyCost(mon,a.cost);}

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
  _discardEnergyForRetreat(mon,count,pl,selectedIndices=null){
    if(count<=0)return true;
    if(selectedIndices){
      if(!this._canSelectedEnergyPayRetreat(mon,count,selectedIndices))return false;
      const unique=[...new Set(selectedIndices.map(Number))].sort((a,b)=>b-a);
      for(const idx of unique)pl.discard.push(mon.energy.splice(idx,1)[0]);
      return true;
    }
    let paid=0;
    while(paid<count){
      if(!mon.energy?.length)return false;
      const idx=mon.energy.length-1;
      const energy=mon.energy[idx];
      paid+=this._energyUnitsForRetreat(energy,mon);
      pl.discard.push(mon.energy.splice(idx,1)[0]);
    }
    return true;
  }
  retreat(pl,benchIndex,selectedEnergyIndices=null){if(pl.retreatUsed){this.addLog('本回合已撤退过');return false;}if(!pl.active||!pl.bench[benchIndex]){this.addLog('撤退目标不存在');return false;}
    const st=pl.active.status||'';if(st.includes('sleep')||st.includes('paralysis')||pl.active.cannotRetreat){this.addLog('无法撤退');return false;}
    const cost=pl.active.retreatCostOverride??pl.active.retreatCost??1;if(!this._canPayRetreatCost(pl.active,cost)){this.addLog('撤退能量不足');return false;}
    if(!this._discardEnergyForRetreat(pl.active,cost,pl,selectedEnergyIndices))return false;const old=pl.active;pl.active=pl.bench.splice(benchIndex,1)[0];pl.bench.push(old);pl.retreatUsed=true;this.addLog(`${pl.name} 撤退，换上 ${pl.active.name}`);this.recomputePassives();return true;}

  evolve(pl,hi,cd,slot){const t=slot==='active'?pl.active:pl.bench[parseInt(slot.replace('bench-',''))];
    if(!t){this.addLog('目标不存在');return false;}
    if(!cd?.evolvesFrom||t.name!==cd.evolvesFrom){this.addLog(`${t.name} 不能进化为 ${cd?.name||'?'}`);return false;}
    if(t.placedThisTurn||t.evolvedThisTurn){this.addLog(`${t.name} 本回合刚出场或已进化，下回合才能进化`);return false;}
    const dmg=t.maxHp-t.hp;pl.hand.splice(hi,1);
    t.name=cd.name;t.maxHp=cd.hp;t.hp=Math.max(cd.hp-dmg,10);
    t.attacks=cd.attacks;t.element=cd.element;t.weakness=cd.weakness||null;t.resistance=cd.resistance||null;t.retreatCost=cd.retreatCost??1;t.ability=cd.ability||null;t.abilityUsed=false;t.abilityDisabled=false;t.abilityDisabledBy=null;t.placedThisTurn=false;t.evolvedThisTurn=true;
    this.addLog(`${pl.name} 的宝可梦进化成了 ${cd.name}！`);this.recomputePassives();return true;}

  _toolLabel(tool){return (tool&&typeof tool==='object')?(tool.name||tool.cardId||'宝可梦道具'):tool;}
  _toolCardValue(tool){return (tool&&typeof tool==='object')?(tool.cardId||tool.name||tool):tool;}
  _makeToolState(cardId,cd){return {cardId,name:cd?.name||String(cardId)};}

  canUseTrainer(pl, cd, targetSlot=null){
    if(!cd||cd.cardType!=='trainer')return {ok:false,reason:'not_trainer',message:'不是训练家卡'};
    const prereqFailure=this._trainerPrerequisiteFailure(pl,cd);
    if(prereqFailure)return prereqFailure;
    const tt=cd.trainerType;
    const hasFirstPlayerFirstTurnSupporterException=(cd.effects||[]).some(e=>e.action==='trainer_prerequisite'&&e.params?.kind==='first_player_first_turn_supporter_exception');
    if(tt==='supporter'&&pl===this.firstPlayer&&this.firstPlayerFirstTurnInProgress&&!hasFirstPlayerFirstTurnSupporterException)return {ok:false,reason:'first_player_first_turn_supporter',message:'先攻玩家最初回合不能使用支援者卡'};
    if(tt==='supporter'&&pl.supporterUsed)return {ok:false,reason:'supporter_used',message:'已用过支援者卡'};
    if(tt==='tool'){
      const t=targetSlot==='active'?pl.active:(targetSlot?.startsWith('bench-')?pl.bench[parseInt(targetSlot.replace('bench-',''))]:null);
      if(!t)return {ok:false,reason:'missing_tool_target',message:'请选择目标宝可梦'};
      if(t.tool)return {ok:false,reason:'tool_already_attached',message:`${t.name} 已装备 ${this._toolLabel(t.tool)}`};
    }
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
      if(p.kind==='first_turn'){
        const raw=p.raw||'';
        const isOwnFirstTurn=this.turn===1&&pl===this.firstPlayer || this.turn===2&&pl!==this.firstPlayer;
        if(/后攻玩家/.test(raw)&&!(isOwnFirstTurn&&pl!==this.firstPlayer))return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：只可在后攻玩家自己的最初回合使用'};
        if(!/后攻玩家/.test(raw)&&!isOwnFirstTurn)return {ok:false,reason:'trainer_prerequisite',message:'使用前提未满足：只可在自己的最初回合使用'};
      }
    }
    return null;
  }

  _trainerLegalityMessage(check){return check?.message||'无法使用训练家卡';}

  useTrainer(pl, hi, cd, targetSlot=null, cardId=null){
    const check=this.canUseTrainer(pl,cd,targetSlot);
    if(!check.ok){this.addLog(this._trainerLegalityMessage(check));return false;}
    const tt=cd.trainerType;
    if(tt==='supporter')pl.supporterUsed=true;
    if(tt==='stadium'){
      this.setActiveStadium(pl,hi,cd);
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
    // 物品卡
    pl.hand.splice(hi,1); pl.discard.push(cd.name);
    this.addLog(`${pl.name} 使用了「${cd.name}」`);
    return true;
  }

  getActiveStadium(){return this.stadium||this.player1.stadium||this.player2.stadium||null;}
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
    const key=this._stadiumUseKey(stadium);pl.stadiumUsedThisTurn=pl.stadiumUsedThisTurn||{};
    if(pl.stadiumUsedThisTurn[key])return {ok:false,reason:'already_used',message:'这个竞技场本回合已使用'};
    return {ok:true,stadium,effects,key};
  }
  markStadiumUsed(pl,stadium=this.getActiveStadium()){pl.stadiumUsedThisTurn=pl.stadiumUsedThisTurn||{};pl.stadiumUsedThisTurn[this._stadiumUseKey(stadium)]=true;}

  getOpponent(pl){return pl===this.player1?this.player2:this.player1;}
  _recordKnockout(owner){this.knockoutHistory=this.knockoutHistory||[];this.knockoutHistory.push({owner,turn:this.turn,by:this.getOpponent(owner),phase:this.phase});}
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
    }else{
      const key=this._abilityUseKey(source,ab,srcZone);
      if(pl.abilityUsedThisTurn?.[key])return {ok:false,reason:'already_used',ability:ab,zone:srcZone};
    }
    return {ok:true,ability:ab,zone:srcZone};}

  markAbilityUsed(pl,source,ability,zone){const z=this.normalizeAbilityZone(zone||this.inferAbilityZone(pl,source)||ability?.zone||'field');
    if(['active','bench','field'].includes(z)&&this.getPokemonInPlay(pl).includes(source))source.abilityUsed=true;
    else{pl.abilityUsedThisTurn=pl.abilityUsedThisTurn||{};pl.abilityUsedThisTurn[this._abilityUseKey(source,ability,z)]=true;}}
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
    for(const source of this.getPokemonInPlay(pl)){
      if(!source?.ability?.effects?.length||source.abilityDisabled)continue;
      for(const eff of this._enabledAbilityEffects(source).filter(e=>e.action==='passive_damage_mod')){
        const p=eff.params||{};
        if((p.target==='self'||p.target==='this')&&source!==attacker)continue;
        total+=p.amount||0;
      }
    }
    return total;}
  _enabledAbilityEffects(mon){return mon?.ability?.effects||[];}
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

  takePrize(pl){if(pl.prizes.length>0){const prize=pl.prizes.pop();pl.hand.push(prize);this.addLog(`${pl.name} 获奖品卡 剩${pl.prizes.length}`);
    if(pl.prizes.length===0){this.winner=pl;this.phase=PHASE.GAME_OVER;this.addLog(`${pl.name} 胜利！`);}}}

  knockout(pl){if(!pl.active)return;this._recordKnockout(pl);pl.discard.push(pl.active.cardId);this.addLog(`${pl.name} 的 ${pl.active.name} 被击倒！`);
    const opp=this.getOpponent(pl);this.takePrize(opp);
    if(pl.bench.length>0){pl.active=pl.bench.shift();this.addLog(`${pl.name} 换上 ${pl.active.name}`);this.recomputePassives();}
    else{this.winner=opp;this.phase=PHASE.GAME_OVER;this.addLog(`${opp.name} 胜利！`);}}

  addLog(msg){
    if(!Array.isArray(this.log))this.log=[];
    this.log.push(msg);
    if(this.log.length>MAX_LOG_ENTRIES)this.log.splice(0,this.log.length-MAX_LOG_ENTRIES);
  }
  _shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
}
