// js/core/EffectParser.js — 卡牌效果解析 (v3 全效果)

const STATUS_MAP = { '中毒':'poison','灼伤':'burn','睡眠':'sleep','麻痹':'paralysis','混乱':'confusion' };
const ELEM = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting',
  '恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };

function abilityNullifyScope(text) {
  if (/双方/.test(text) && /场上/.test(text)) return 'both_field';
  if (/对手/.test(text) && /场上/.test(text) && !/战斗/.test(text)) return 'opponent_field';
  if (/自己的|自己/.test(text) && /场上/.test(text)) return 'self_field';
  return 'opponent_active';
}
function abilityNullifyParams(text, fullText) {
  const except = [...text.matchAll(/[（(]["“]?([^"”）)]+)["”]?除外[）)]/g)].map(m=>m[1]);
  return { scope:abilityNullifyScope(text), duration:/回合结束前/.test(fullText)?'turn':'while_active', exceptAbilityNames:except, sourceZone:/战斗场上/.test(fullText)?'active':'field' };
}

function norm(t) { return t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
function peekRemainderParams(text) {
  if (/将剩余卡放回牌库并重洗|将剩余卡.*?重洗/.test(text)) return { remainder: 'shuffle' };
  if (/将剩余卡以任意顺序排列[，,]放回牌库上方/.test(text)) return { remainder: 'top_any_order', keepOrder: true };
  if (/将剩余卡(?:放回|置于).*?牌库上方|剩余卡.*?回复原样/.test(text)) return { remainder: 'top_original', keepOrder: true };
  return {};
}
function peekParams(m, base) { return { ...base, ...peekRemainderParams(m[0]) }; }
function opponentDiscardEnergyTarget(text) {
  if (/备战/.test(text)) return 'opponent_bench';
  if (/场上|1只|任意|所有/.test(text) && !/战斗/.test(text)) return 'opponent_any';
  return 'opponent';
}
function opponentDiscardEnergyParams(text) { return { target: opponentDiscardEnergyTarget(text), count: 1 }; }
function opponentDiscardEnergyHeads(text) { return { count: 1, heads: [{ action: 'discard_energy', params: opponentDiscardEnergyParams(text) }] }; }

const PEEK_REMAINDER = String.raw`(?:[。.]将剩余卡(?:放回牌库并重洗|以任意顺序排列[，,]放回牌库上方|(?:放回|置于).*?牌库上方)|[。.]剩余卡.*?回复原样)?`;

function trainerPrerequisite(kind, raw) { return { kind, raw }; }
function countParams(n, optional=false) { const c=+n; return { count:c, maxCount:c, minCount:optional?0:c, allowFewer:!!optional, allowEmpty:!!optional }; }
function keepParams(n, optional=false) { const c=+n; return { keep:c, maxCount:c, minCount:optional?0:c, allowFewer:!!optional, allowEmpty:!!optional }; }
function optionalText(text) { return /最多|合计最多|任意数量|任意选择最多|可将|若希望/.test(text); }
function withCount(base, n, optional=false) { return { ...base, ...countParams(n, optional) }; }
function withKeep(base, n, optional=false) { return { ...base, ...keepParams(n, optional) }; }
function discardCostParams(text) {
  const count = +(text.match(/(\d+)张/) || [])[1] || 1;
  const type = (text.match(/【(.+?)】能量/) || [])[1];
  return { kind:'discard_cost', raw:text, count, zone:'hand', filter:type ? `【${type}】能量` : undefined };
}
function discardAttachTarget(dest) {
  if (/这只|战斗/.test(dest)) return 'active';
  if (/备战/.test(dest)) return 'bench';
  return 'any';
}
function discardAttachTargetType(dest) {
  const type = (dest.match(/【(.+?)】宝可梦/) || [])[1];
  return type ? (ELEM[type] || type) : undefined;
}
function discardAttachParams(m, optional=false) {
  const dest = m[3];
  if (/所有|各|那些|以任意方式/.test(dest)) return null;
  return withCount({
    filter:m[2].replace(/^["“”]+|["“”]+$/g, '').trim(),
    target:discardAttachTarget(dest),
    targetType:discardAttachTargetType(dest)
  }, m[1], optional);
}

const RULES = [
  // ===== 训练家/特性使用前提：仅解析为元数据，不执行合法性或费用 =====
  { re: /(?:双方玩家)?在(?:每个)?自己的回合时[，,]可使用1次/, act:'usage_condition', p:m=>trainerPrerequisite('once_per_turn', m[0]) },
  { re: /这张卡可在先攻玩家的最初回合使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_player_first_turn_supporter_exception', m[0]) },
  { re: /这张卡(?:只可|只能)在.+?最初回合使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /这张卡只可在对手剩余奖赏卡的张数为(\d+)张以下时使用/, act:'trainer_prerequisite', p:m=>({ kind:'opponent_prizes_at_most', raw:m[0], count:+m[1] }) },
  { re: /(?:这张卡)?只可在后攻玩家自己的最初回合使用1次/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /这张卡只有在自己剩余奖赏卡的张数比对手剩余奖赏卡的张数多时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('own_prizes_more_than_opponent', m[0]) },
  { re: /这张卡只有在.+?时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('condition', m[0]) },
  { re: /这张卡必须.+?丢弃才可使用/, act:'trainer_prerequisite', p:m=>discardCostParams(m[0]) },

  // ===== 特性：消除/被动光环 =====
  { re: /(?:对手的)?(?:战斗宝可梦|场上宝可梦|所有场上宝可梦|场上的.*?宝可梦).*?特性(?:（.*?除外）)?全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /将(?:双方|对手|自己的)?.*?场上.*?宝可梦.*?特性(?:（.*?除外）)?全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /(?:自己的|这只)宝可梦使用的招式.*?造成的伤害["“]?([+-]\d+)["”]?点/, act:'passive_damage_mod', p:m=>({target:/这只/.test(m[0])?'self':'own_field',amount:+m[1]}) },
  { re: /(?:自己的|这只)宝可梦使用的招式.*?伤害["“]?([+-]\d+)["”]?点/, act:'passive_damage_mod', p:m=>({target:/这只/.test(m[0])?'self':'own_field',amount:+m[1]}) },
  { re: /基本【(.+?)】能量.*?视为各?提供2个【\1】能量/, act:'energy_provides_multiplier', p:m=>({target:/自己的场上宝可梦|场上宝可梦/.test(m.input)?'own_field':'self',energyType:ELEM[m[1]]||m[1],multiplier:2,basicOnly:true}) },
  // ===== 典型物品/特性复合效果 =====
  { re: /从自己的手牌选择1张【2阶进化】宝可梦卡[，,]放置于自己的场上的可进化成那只宝可梦的【基础】宝可梦身上[，,]跳过【1阶进化】完成进化/, act:'evolve_rare_candy', p:()=>({stage:'2阶',targetStage:'基础',bypassStage:'1阶',noPlacedThisTurn:true,noFirstTurn:true}) },
  { re: /查看自己的所有反面朝上的奖赏卡的正面[。.]从其中选择1张【基础】宝可梦卡[，,]在给对手看过后[，,]与这张"?洗翠的沉重球"?卡互换并加入手牌/, act:'prize_basic_pokemon_to_hand_exchange_trainer', p:()=>({count:1,filter:'【基础】宝可梦'}) },
  { re: /从自己的牌库任意选择最多与自己的场上宝可梦属性种类数量相同数量的卡[，,]加入手牌/, act:'search_deck_to_hand', p:()=>({dynamicCount:'own_field_type_count',filter:null,allowFewer:true,allowEmpty:true}) },
  { re: /从自己的牌库任意选择最多(\d+)张卡[，,]加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:null},m[1],true) },
  { re: /查看(?:自己的)?牌库上方1张卡[，,]将那张卡加入手牌[。.]或者将那张卡丢弃[，,]从自己的牌库抽出1张卡/, act:'hikers_shoes', p:()=>({peek:1,drawOnDiscard:1}) },
  { re: /将自己的战斗场的【基础】宝可梦与备战宝可梦互换[。.]然后[，,]将换入备战区的宝可梦恢复"?(\d+)"?HP/, act:'switch_active_basic_heal_bench', p:m=>({heal:+m[1]}) },
  { re: /(?:可)?从自己的弃牌区选择1张【火】能量卡[，,]附于自己的备战区的【火】宝可梦身上[。.](?:这个情况下[，,])?在附上那张卡的宝可梦身上放置(\d+)个伤害指示物/, act:'attach_energy_from_discard', p:m=>({count:1,filter:'【火】能量',target:'bench',targetType:'fire',damageCountersOnAttachedTarget:+m[1]}) },
  { re: /每次从自己的手牌将能量附于这只宝可梦身上时[，,]可使用1次[。.]将这只宝可梦与战斗宝可梦互换/, act:'attach_energy_trigger', p:()=>({event:'attach_energy_from_hand',target:'self',sourceZone:'bench',optional:true,effects:[{action:'self_switch_to_active',params:{}}]}) },
  { re: /查看(?:自己的)?牌库上方1张卡[，,]回复原样[。.]若希望[，,]选择1张自己的反面朝上的奖赏卡[，,]与自己的牌库上方的卡维持反面朝上互换/, act:'prize_deck_top_swap', p:()=>({optional:true}) },
  { re: /将对手的所有宝可梦身上附加的"?宝可梦道具"?卡与"?特殊能量"?卡[，,]与场上的"?竞技场"?卡[，,]全部丢弃/, act:'discard_field_attachments', p:()=>({target:'opponent',tools:true,specialEnergy:true,stadium:true}) },
  { re: /掷1次硬币[。.]?若为正面[，,]则选择对手的1只备战宝可梦[，,]与战斗宝可梦互换/, act:'coin_flip', p:()=>({count:1,heads:[{action:'switch_pokemon',params:{who:'opponent'}}]}) },
  { re: /掷1次硬币[。.]若为正面[，,]则从自己的牌库选择1张宝可梦[，,]在给对手看过后加入手牌[。.]并且重洗牌库/, act:'coin_flip', p:()=>({count:1,heads:[{action:'search_deck_to_hand',params:{count:1,filter:'宝可梦'}}]}) },
  { re: /掷1次硬币[。.]?若为正面[，,]则选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]将其丢弃/, act:'coin_flip', p:m=>opponentDiscardEnergyHeads(m[0]) },
  { re: /从自己的手牌抽出1张宝可梦[，,]在给对手看过后放回牌库[。.]然后[，,]从自己的牌库选择1张宝可梦[，,]在给对手看过后加入手牌[。.]并且重洗牌库/, act:'hand_pokemon_to_deck_search_pokemon', p:()=>({return_count:1,search_count:1,filter:'宝可梦'}) },
  // ===== 回合结束 =====
  { re: /若使用了这张卡[，,]则自己的回合结束/, act:'end_turn', p:()=>({}) },
  { re: /自己的回合结束/, act:'end_turn', p:()=>({}) },

  // ===== 掷硬币类 =====
  { re: /掷1次硬币若为反面[，,]则这个招式失败/, act:'coin_flip', p:()=>({count:1,fail_on_tails:true}) },
  { re: /掷1次硬币若为正面[，,]则将对手的战斗宝可梦【(.+?)】/, act:'coin_flip_status', p:m=>({count:1,statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /掷1次硬币若为正面[，,]则在下个对手的回合[，,]这只宝可梦不会受到招式的伤害与效果的影响/, act:'coin_flip', p:()=>({count:1,heads:[{action:'prevent_damage',params:{duration:'next_opp_turn'}},{action:'prevent_effect',params:{duration:'next_opp_turn'}}]}) },
  { re: /掷1次硬币若为正面[，,]则在下个对手的回合[，,]这只宝可梦不会受到招式的伤害/, act:'coin_flip', p:()=>({count:1,heads:[{action:'prevent_damage',params:{duration:'next_opp_turn'}}]}) },
  { re: /掷1次硬币若为正面[，,]则选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]将其丢弃/, act:'coin_flip', p:m=>opponentDiscardEnergyHeads(m[0]) },
  { re: /掷1次硬币若为正面[，,]则增加(\d+)点伤害/, act:'coin_flip_damage', p:m=>({count:1,damage:+m[1]}) },
  { re: /掷硬币直到出现反面[，,]造成正面出现的次数[×x](\d+)点伤害/, act:'coin_flip_until_tails', p:m=>({damage_per:+m[1]}) },
  { re: /掷(\d+)次硬币[，,]造成正面出现的次数[×x](\d+)点伤害/, act:'coin_flip_damage', p:m=>({count:+m[1],damage_per:+m[2]}) },
  { re: /掷(\d+)次硬币/, act:'coin_flip', p:m=>({count:+m[1]}) },
  { re: /掷1次硬币/, act:'coin_flip', p:()=>({count:1}) },

  // ===== 丢弃全部手牌 =====
  { re: /将自己的手牌全部丢[弃到]/, act:'discard_all_hand', p:()=>({}) },

  // ===== 手牌回牌库+抽卡 =====
  { re: /双方玩家各将手牌全部放回牌库并重洗[。.]然后[，,]从牌库抽卡[，,]自己抽出(\d+)张[，,]对手抽出(\d+)张/, act:'shuffle_hand_to_deck', p:m=>({who:'both',self_draw_count:+m[1],opponent_draw_count:+m[2]}) },
  { re: /双方玩家各将所有手牌放回牌库并重洗[。.]然后[，,](?:从牌库)?各抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'both',draw_count:+m[1]}) },
  { re: /对手将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'opponent',draw_count:+m[1]}) },
  { re: /将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]从牌库抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'self',draw_count:+m[1]}) },

  // ===== 搜牌库放备战区 =====
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],false) },
  { re: /从(?:自己的)?牌库选择最多(\d+)张(.+?)宝可梦(?:卡)?[,，]放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:m[2]},m[1],true) },
  { re: /从(?:自己的)?牌库选择1张【基础】宝可梦卡[，,]放置于备战区/, act:'search_deck_to_bench', p:()=>withCount({filter:'【基础】宝可梦'},1,false) },

  // ===== 搜牌库加手 =====
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张(.+?)(?:卡)?[,，][在给对手看过后]*加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2].replace(/["“”]/g,'').trim()},m[1]||1,true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张(.+?)(?:卡)?[,，][在给对手看过后]*加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2].replace(/["“”]/g,'').trim()},m[1]||1,false) },
  { re: /从(?:自己的)?牌库选择(.+?)各(\d+)张[,，]在给对手看过后加入手牌/, act:'search_deck_to_hand', p:m=>({count:+m[2],filter:m[1].replace(/["“”]/g,'').trim()}) },
  { re: /从(?:自己的)?牌库选择1张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'search_deck_to_hand', p:m=>({count:1,filter:m[1].replace(/["“”]/g,'').trim()}) },

  // ===== 看牌库上方选牌 =====
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[，,]从其中选择(.+?)合计最多(\\d+)张[，,]在给对手看过后加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[2].trim()},m[3],true)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[，,]从其中选择(\\d+)张(.+?)(?:卡)?[，,]在给对手看过后加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim()},m[2],false)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张[。.]可将其中的(\\d+)张(.+?)(?:卡)?[，,]在给对手看过后加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim(),keepOrder:true},m[2],true)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[。.]选择(?:其中)?(?:最多)?(\\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim()},m[2],optionalText(m[0]))) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[。.]选择(?:其中)?(?:最多)?(\\d+)张.*?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1]},m[2],optionalText(m[0]))) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[,，]选择(?:其中)?(?:最多)?(\\d+)张.*?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1]},m[2],optionalText(m[0]))) },
  { re: /查看(?:自己的)?牌库上方(\d+)张卡[,，]选择/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:1}) },

  // ===== 抽卡 =====
  { re: /从牌库抽卡直到(?:自己的)?手牌满(\d+)张/, act:'draw_until', p:m=>({target:+m[1]}) },
  { re: /从(?:自己的)?牌库抽出(\d+)张卡/, act:'draw', p:m=>({count:+m[1]}) },
  { re: /从牌库抽出(\d+)张/, act:'draw', p:m=>({count:+m[1]}) },

  // ===== HP恢复 =====
  { re: /HP全部恢复/, act:'heal', p:()=>({amount:'full'}) },
  { re: /将(?:这只)?(?:宝可梦|.*?)恢复"?(\d+)"?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /恢复"?(\d+)"?HP/, act:'heal', p:m=>({amount:+m[1]}) },

  // ===== 状态异常 =====
  { re: /将对手的(?:战斗)?宝可梦【中毒】[，,]【灼伤】与【混乱】/, act:'inflict_status', p:()=>({statuses:['poison','burn','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【中毒】与【灼伤】/, act:'inflict_status', p:()=>({statuses:['poison','burn']}) },
  { re: /将对手的(?:战斗)?宝可梦【中毒】与【混乱】/, act:'inflict_status', p:()=>({statuses:['poison','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【灼伤】与【混乱】/, act:'inflict_status', p:()=>({statuses:['burn','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【(.+?)】与【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1],STATUS_MAP[m[2]]||m[2]]}) },
  { re: /将对手的(?:战斗)?宝可梦【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /将这只宝可梦【(.+?)】/, act:'inflict_status_self', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /将双方的战斗宝可梦【(.+?)】/, act:'inflict_status_both', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },

  // ===== 自身伤害 =====
  { re: /这只宝可梦也受到(\d+)点伤害/, act:'self_damage', p:m=>({amount:+m[1]}) },

  // ===== 换位 =====
  { re: /双方玩家将自己的战斗宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'both'}) },
  { re: /选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换[。.]\[由对手选择/, act:'switch_pokemon', p:()=>({who:'opponent',choose:'opponent'}) },
  { re: /选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /将对手的(?:战斗)?宝可梦与备战宝可梦互换[。.]\[由对手选择/, act:'switch_pokemon', p:()=>({who:'opponent',choose:'opponent'}) },
  { re: /将对手的(?:战斗)?宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /若希望[，,]将这只宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self',optional:true}) },
  { re: /将自己的(?:战斗|场上)?宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /将这只宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },

  // ===== 备战区伤害 =====
  { re: /对手的1只备战宝可梦也受到(\d+)点伤害/, act:'damage_bench', p:m=>({target:'opponent_1',damage:+m[1]}) },
  { re: /对手的1只宝可梦受到(\d+)点伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[1]}) },
  { re: /对手的所有备战宝可梦也各受到(\d+)点伤害/, act:'damage_bench', p:m=>({target:'opponent_all',damage:+m[1]}) },
  { re: /自己的所有备战宝可梦也各受到(\d+)点伤害/, act:'damage_bench', p:m=>({target:'self_all',damage:+m[1]}) },

  // ===== 伤害指示物 =====
  { re: /将(\d+)个伤害指示物以任意方式放置于对手的宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_any',count:+m[1]}) },
  { re: /在对手的战斗宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_active',count:+m[1]}) },
  { re: /在使用招式的宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'attacker',count:+m[1]}) },
  { re: /在这只宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'self',count:+m[1]}) },

  // ===== 伤害增减 =====
  { re: /在下个对手的回合[，,]这只宝可梦受到招式的伤害"?([+-]?\d+)"?点/, act:'damage_modify', p:m=>({amount:+m[1],duration:'next_opp_turn',target:'self'}) },
  { re: /这只宝可梦受到招式的伤害"?([+-]?\d+)"?点/, act:'damage_modify', p:m=>({amount:+m[1],target:'self'}) },
  { re: /增加对手的战斗宝可梦身上放置的伤害指示物的数量[×x](\d+)点伤害/, act:'damage_modify', p:m=>({amount:+m[1],condition:'opponent_damage_counters'}) },
  { re: /增加这只宝可梦身上放置的伤害指示物的数量[×x](\d+)点伤害/, act:'damage_modify', p:m=>({amount:+m[1],condition:'self_damage_counters'}) },
  { re: /增加这只宝可梦身上附加的.+?能量的数量[×x](\d+)点伤害/, act:'damage_modify', p:m=>({amount:+m[1],condition:'self_energy'}) },
  { re: /增加双方的备战宝可梦的数量[×x](\d+)点伤害/, act:'damage_modify', p:m=>({amount:+m[1],condition:'total_bench'}) },
  { re: /增加.+?的.*?张数[×x](\d+)点伤害/, act:'damage_modify', p:m=>({amount:+m[1],condition:'count'}) },

  // ===== 防止伤害/效果 =====
  { re: /在下个对手的回合[，,]这只宝可梦不会受到招式的伤害与效果的影响/, act:'prevent_damage_effect', p:()=>({duration:'next_opp_turn'}) },
  { re: /在下个对手的回合[，,]这只宝可梦不会受到招式的伤害/, act:'prevent_damage', p:()=>({duration:'next_opp_turn'}) },
  { re: /这只宝可梦不会受到对手的宝可梦使用招式的效果的影响/, act:'prevent_effect', p:()=>({source:'attack'}) },
  { re: /不会受到.*?招式的伤害/, act:'prevent_damage', p:()=>({source:'attack'}) },

  // ===== 无视弱抗/效果 =====
  { re: /这个招式的伤害不计算抵抗力/, act:'ignore', p:()=>({what:'resistance'}) },
  { re: /这个招式的伤害不计算弱点/, act:'ignore', p:()=>({what:'weakness'}) },
  { re: /这个招式的伤害不计算对手的战斗宝可梦身上的附加效果/, act:'ignore', p:()=>({what:'opponent_effects'}) },

  // ===== 无法攻击/撤退 =====
  { re: /在下个自己的回合[，,]这只宝可梦无法使用招式/, act:'cannot_attack_next', p:()=>({duration:'next_self_turn'}) },
  { re: /在下个自己的回合[，,]这只宝可梦无法使用"?(.+?)"?[,。]/, act:'cannot_attack_next', p:m=>({move:m[1]}) },
  { re: /在下个对手的回合[，,]受到这个招式的宝可梦无法撤退/, act:'cannot_retreat', p:()=>({target:'opponent',duration:'next_opp_turn'}) },
  { re: /对手的(?:战斗)?宝可梦无法撤退/, act:'cannot_retreat', p:()=>({target:'opponent'}) },

  // ===== 弃牌区附能 =====
  { re: /从自己的弃牌区(?:选择|抽出)最多(\d+)张["“”]?([^"“”。，,]+?能量)["“”]?卡?[，,]附于((?:(?!(?:所有|各|那些|以任意方式)).)+?宝可梦)(?:身上)?/, act:'attach_energy_from_discard', p:m=>discardAttachParams(m,true) },
  { re: /从自己的弃牌区(?:选择|抽出)(\d+)张["“”]?([^"“”。，,]+?能量)["“”]?卡?[，,]附于((?:(?!(?:所有|各|那些|以任意方式)).)+?宝可梦)(?:身上)?/, act:'attach_energy_from_discard', p:m=>discardAttachParams(m,false) },

  // ===== 牌库附能 =====
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张(.+?)能量卡[,，]?附于/, act:'attach_energy_from_deck', p:m=>withCount({filter:m[2].trim()},m[1],true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张(.+?)能量卡[,，]?附于/, act:'attach_energy_from_deck', p:m=>withCount({filter:m[2].trim()},m[1],false) },

  // ===== 丢弃自身能量 =====
  { re: /将这只宝可梦身上所附加的(.+?)能量全部丢弃/, act:'discard_energy', p:m=>({target:'self',filter:m[1],count:'all'}) },
  { re: /将这只宝可梦身上附加的(.+?)能量(?:丢弃|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',filter:m[1],count:1}) },
  { re: /将这只宝可梦身上所附加的(\d+)个能量丢到弃牌区/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /将这只宝可梦身上附加的能量卡全部丢弃/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /选择2个这只宝可梦身上附加的能量[，,]将其丢弃/, act:'discard_energy', p:()=>({target:'self',count:2}) },
  { re: /选择1个这只宝可梦身上附加的能量[，,]将其丢弃/, act:'discard_energy', p:()=>({target:'self',count:1}) },

  // ===== 丢弃对手能量 =====
  { re: /选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]将其丢弃/, act:'discard_energy', p:m=>opponentDiscardEnergyParams(m[0]) },
  { re: /将对手的战斗宝可梦身上附加的1个能量丢弃/, act:'discard_energy', p:()=>({target:'opponent',count:1}) },

  // ===== 能量换位 =====
  { re: /从备战宝可梦.*?改附于.*?战斗宝可梦/, act:'move_energy', p:()=>({source:'bench',dest:'active'}) },
  { re: /选择1个这只宝可梦身上附加的能量[，,]改附于备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench'}) },

  // ===== 回手 =====
  { re: /将自己的.*?宝可梦(?:与所附加的所有卡)?[,，]?(?:全部)?放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  { re: /将这只宝可梦与附加的卡[，,]全部放回手牌/, act:'return_to_hand', p:()=>({target:'self',with_attachments:true}) },

  // ===== 弃牌区回收 =====
  { re: /从(?:自己的)?弃牌区选择(.+?)合计最多(\d+)张[，,]在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[1].trim(),target:'hand'},m[2],true) },
  { re: /从(?:自己的)?弃牌区选择最多(\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择(\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],false) },
  { re: /从(?:自己的)?弃牌区选择最多(\d+)张(.+?)(?:卡)?[,，]加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择(\d+)张(.+?)(?:卡)?[,，]加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],false) },
  { re: /从(?:自己的)?弃牌区选择.*?合计最多(\d+)张[,，]在给对手看过后放回牌库/, act:'recover_from_discard', p:m=>withCount({target:'deck'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择.*?合计(\d+)张[,，]在给对手看过后放回牌库/, act:'recover_from_discard', p:m=>withCount({target:'deck'},m[1],false) },
  { re: /从(?:自己的)?弃牌区(?:选择|抽出).*?(?:加入手牌|放回牌库)/, act:'recover_from_discard', p:()=>({count:1,target:'hand'}) },

  // ===== 多获奖赏 =====
  { re: /多获得(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[1]}) },

  // ===== 对手牌库丢弃 =====
  { re: /将对手的牌库上方(\d+)张卡丢弃/, act:'mill', p:m=>({target:'opponent',count:+m[1]}) },

  // ===== 查看对手手牌 =====
  { re: /查看对手的手牌/, act:'look_at', p:()=>({target:'opponent_hand'}) },

  // ===== 随机丢弃对手手牌 =====
  { re: /在不看正面的情况下[，,]选择1张对手的手牌[，,]将其丢弃/, act:'discard_opponent_hand_random', p:()=>({count:1}) },

  // ===== 牌库上方卡操作 =====
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]从其中选择任意数量的物品卡[，,]将其丢弃[。.]将剩余卡放回牌库并重洗/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'discard_matching',filter:'物品',allowFewer:true,allowEmpty:true,remainder:'shuffle'}) },
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]选择其中1张[，,]放回牌库上方[。.]将剩余卡放回牌库下方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'choose_top_rest_bottom',keep:1}) },
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]以任意顺序排列[，,]放回牌库上方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'top_any_order',keepOrder:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]回复原样[。.]若希望[，,]将那张卡丢弃/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'discard',optional:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]回复原样[。.]若希望[，,]将那张卡放回牌库下方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'bottom',optional:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]回复原样[。.]若希望[，,]重洗那个牌库/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'shuffle',optional:true}) },
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]回复原样/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'look',remainder:'top_original'}) },
  { re: /将对手的牌库上方1张卡(?!丢弃)/, act:'manipulate_deck_top', p:()=>({target:'opponent',count:1,mode:'look'}) },

  // ===== 重洗牌库 =====
  { re: /并且重洗牌库/, act:'shuffle_deck', p:()=>({}) },
  { re: /重洗牌库/, act:'shuffle_deck', p:()=>({}) },

  // ===== 放逐区 =====
  { re: /放置于放逐区/, act:'lost_zone', p:()=>({}) },

  // ===== 化石放置 =====
  { re: /作为HP(\d+)的/, act:'fossil_place', p:m=>({hp:+m[1]}) },

  // ===== 消除能量费用 =====
  { re: /将这只宝可梦使用招式所需的能量全部消除/, act:'energy_cost_eliminate', p:()=>({target:'self'}) },
];

export function parseEffect(text) {
  if (!text || text === '无') return { effects: [], unparsed: '' };
  text = norm(text);
  const effects = [];
  let remaining = text;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const rule of RULES) {
      const m = remaining.match(rule.re);
      if (m) {
        effects.push({ action: rule.act, params: rule.p(m) });
        remaining = remaining.replace(rule.re, '').replace(/^[,，。\s]+/, '').trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { effects, unparsed: remaining.length > 2 ? remaining : '' };
}
