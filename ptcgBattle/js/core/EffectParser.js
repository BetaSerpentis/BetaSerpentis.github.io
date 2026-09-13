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
  const except = [...text.matchAll(/[（(](?:["“”「」]?([^"”」）)]+)["”」]?除外|除["“”「」]?([^"”」）)]+)["”」]?外)[）)]/g)].map(m=>m[1]||m[2]).filter(Boolean);
  return { scope:abilityNullifyScope(text), duration:/回合结束前/.test(fullText)?'turn':'while_active', exceptAbilityNames:except, sourceZone:/战斗场上/.test(fullText)?'active':'field' };
}

function norm(t) { return t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }

// 简中 → 繁中措辞归一化：让旧繁中正则规则继续命中简中数据（tcg.mik.moe 简中官方译名）。
// 顺序敏感：先处理含上下文的长短语，再处理单字替换。
function normalizeCn(text) {
  return text
    // 引号：简中「」→ 双引号
    .replace(/「/g, '"').replace(/」/g, '"')
    // 检索：选择(自己的/自己)牌库/弃牌区中的 → 从自己的牌库/弃牌区选择
    .replace(/选择(?:自己的|自己)牌库中的/g, '从自己的牌库选择')
    .replace(/选择(?:自己的|自己)弃牌区中的/g, '从自己的弃牌区选择')
    .replace(/选择(?:自己的|自己)牌库中/g, '从自己的牌库选择')
    .replace(/选择(?:自己的|自己)弃牌区中/g, '从自己的弃牌区选择')
    // 状态异常：令/使...陷入【X】和【Y】状态 → 将...【X】与【Y】
    .replace(/(?:令|使)(对手的(?:战斗)?宝可梦)陷入【(中毒|灼伤|睡眠|麻痹|混乱)】和【(中毒|灼伤|睡眠|麻痹|混乱)】状态/g, '将$1【$2】与【$3】')
    .replace(/(?:令|使)(对手的(?:战斗)?宝可梦)陷入【(中毒|灼伤|睡眠|麻痹|混乱)】状态/g, '将$1【$2】')
    // 丢弃：放于弃牌区 → 丢到弃牌区
    .replace(/放于弃牌区/g, '丢到弃牌区')
    // 放置：放于 → 放置于；附着于 → 附于
    .replace(/放于/g, '放置于')
    .replace(/附着于/g, '附于')
    .replace(/附有/g, '附着')
    // 掷硬币：抛掷 → 掷
    .replace(/抛掷/g, '掷')
    // 条件：如果...的话 → 若
    .replace(/如果/g, '若')
    .replace(/的话/g, '')
    // 抽牌：牌库上方抽取/抽出 → 牌库抽出；抽取 → 抽出
    .replace(/牌库上方(?:抽取|抽出)/g, '牌库抽出')
    .replace(/抽取/g, '抽出')
    // 回复/恢复：回复 → 恢复（保留“回复原样”等旧措辞）
    .replace(/回复(?!原样)/g, '恢复')
    .replace(/自己牌库/g, '自己的牌库')
    .replace(/张卡牌/g, '张卡')
    // 看过之后 → 看过后
    .replace(/给对手看过之后/g, '给对手看过后')
    // 并重洗 → 并且重洗；恢复其 → 恢复；点HP → HP；丢弃后才可使用 → 丢弃才可使用
    .replace(/并重洗牌库/g, '并且重洗牌库')
    .replace(/恢复其/g, '恢复')
    .replace(/点HP/g, 'HP')
    .replace(/丢到弃牌区后才可使用/g, '丢到弃牌区才可使用')
    .replace(/从(?:自己的|自己)牌库中/g, '从自己的牌库')
    // 被动光环前缀：只要这只宝可梦在…上，/ 只要这张竞技场在场上，/ 只要身上放有这张卡牌的宝可梦在战斗场上，
    .replace(/只要这只宝可梦在(?:战斗场上|场上|备战区)[，,]?/g, '')
    .replace(/只要这张竞技场在场上[，,]?/g, '')
    .replace(/只要身上放有这张卡牌的宝可梦在战斗场上[，,]?/g, '')
    // 不受到 → 不会受到
    .replace(/不受到/g, '不会受到')
    // 下一个 → 下个；给这只宝可梦也造成 → 这只宝可梦也受到
    .replace(/在下一个/g, '在下个')
    // 造成/受到 N点伤害 → N伤害（统一去掉“点”，便于匹配）
    .replace(/(\d+)点伤害/g, '$1伤害')
    .replace(/给这只宝可梦也造成(\d+)伤害/g, '这只宝可梦也受到$1伤害')
    // 追加造成 → 增加（仅“追加造成N伤害”形式，其他含“数量×N”由单独规则处理）
    .replace(/追加造成(\d+)伤害/g, '增加$1伤害')
    // 可以使用 → 可使用；在自己的回合可使用 → 在自己的回合时可使用
    .replace(/可以使用/g, '可使用')
    .replace(/在自己的回合可使用/g, '在自己的回合时可使用')
    // 主动特性前缀：在自己的回合，当/每当… → 去掉前置，让触发式规则可捕获
    .replace(/在自己的回合[，,]?(?:当|每当)/g, '当');
}
function peekRemainderParams(text) {
  if (/将剩余卡放回牌库并重洗|将剩余卡.*?重洗/.test(text)) return { remainder: 'shuffle' };
  if (/将剩余卡以任意顺序排列[，,]?放回牌库上方/.test(text)) return { remainder: 'top_any_order', keepOrder: true };
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

const PEEK_REMAINDER = String.raw`(?:[。.]将剩余卡(?:放回牌库并重洗|以任意顺序排列[，,]?放回牌库上方|(?:放回|置于).*?牌库上方)|[。.]剩余卡.*?回复原样)?`;

function trainerPrerequisite(kind, raw) { return { kind, raw }; }
function countParams(n, optional=false) { const c=+n; return { count:c, maxCount:c, minCount:optional?0:c, allowFewer:!!optional, allowEmpty:!!optional }; }
function keepParams(n, optional=false) { const c=+n; return { keep:c, maxCount:c, minCount:optional?0:c, allowFewer:!!optional, allowEmpty:!!optional }; }
function optionalText(text) { return /最多|合计最多|任意数量|任意选择最多|可将|若希望/.test(text); }
// 清洗 peek 兜底捕获到的 filter 文本（去掉“在给对手看过后”等连接语与尾部“卡”字）
function cleanPeekFilter(raw) {
  const t = String(raw || '')
    .replace(/^[，,]?/, '')
    .replace(/^在给对手看过后[，,]?/, '')
    .replace(/[，,。]+$/, '')
    .replace(/卡$/, '')
    .trim();
  return t || undefined;
}
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

// 条件分支「如果 CONDITION 的话，则 EFFECT」：把条件文本映射为 condition key + 参数
function conditionKey(condText) {
  const t = String(condText || '').replace(/[「」"“”]/g, '').replace(/，/g, ',');
  const statusM = t.match(/对手(?:的)?战斗宝可梦处于【(中毒|灼伤|睡眠|麻痹|混乱)】/);
  if (statusM) return { condition:'opponent_active_status', status:STATUS_MAP[statusM[1]] || statusM[1] };
  if (/对手(?:的)?战斗宝可梦处于特殊状态/.test(t)) return { condition:'opponent_active_any_status' };
  if (/对手(?:的)?战斗宝可梦(?:为|是)进化宝可梦/.test(t)) return { condition:'opponent_active_is_evolved' };
  const typeM = t.match(/对手(?:的)?战斗宝可梦(?:为|是)【(.+?)】宝可梦/);
  if (typeM) return { condition:'opponent_active_type', type:ELEM[typeM[1]] || typeM[1] };
  const nameM = t.match(/对手(?:的)?战斗宝可梦是(.+)$/);
  if (nameM) return { condition:'opponent_active_name', name:nameM[1].trim() };
  const toolSelfM = t.match(/这只宝可梦身上放有(.+)$/);
  if (toolSelfM) return { condition:'self_has_tool', name:toolSelfM[1].trim() };
  const toolOppM = t.match(/对手(?:的)?战斗宝可梦身上放有(.+)$/);
  if (toolOppM) return { condition:'opponent_active_has_tool', name:toolOppM[1].trim() };
  if (/对手(?:的)?战斗宝可梦身上没有/.test(t)) return { condition:'opponent_active_no_damage' };
  if (/这只宝可梦身上没有附着(?:任何)?能量/.test(t)) return { condition:'self_no_energy' };
  if (/这只宝可梦身上没有/.test(t)) return { condition:'self_no_damage' };
  if (/自己没有手牌/.test(t)) return { condition:'self_no_hand' };
  if (/自己(?:的)?手牌(?:张数|数量)与对手(?:的)?手牌(?:张数|数量)相同/.test(t)) return { condition:'hand_count_equal' };
  const prizeM = t.match(/对手(?:的)?剩余奖赏卡(?:张数|数量)为(\d+)张/);
  if (prizeM) return { condition:'opponent_prizes', count:+prizeM[1] };
  if (/自己(?:的)?剩余奖赏卡(?:张数|数量)[，,]?比对手(?:的)?剩余奖赏卡(?:张数|数量)多/.test(t)) return { condition:'own_prizes_more' };
  const eM = t.match(/这只宝可梦身上附(?:着了|着|有)【(.+?)】能量/);
  if (eM) return { condition:'self_has_energy_type', type:ELEM[eM[1]] || eM[1] };
  if (/这只宝可梦身上附(?:着了|着|有)特殊能量/.test(t)) return { condition:'self_has_special_energy' };
  if (/自己(?:的)?备战宝可梦身上(?:放置有|有)伤害指示物/.test(t)) return { condition:'own_bench_has_damage' };
  if (/场上有(?:自己的)?竞技场/.test(t)) return { condition:'stadium_in_play' };
  if (/这只宝可梦身上(?:放置有|有)伤害指示物/.test(t)) return { condition:'self_has_damage' };
  if (/对手(?:的)?战斗宝可梦身上(?:放置有|有)伤害指示物/.test(t)) return { condition:'opponent_active_has_damage' };
  return null;
}
function conditionDamageParams(condText, amount) {
  const c = conditionKey(condText);
  return c ? { ...c, amount, mode:'fixed' } : null;
}
function conditionalEffectParams(condText, effect) {
  const c = conditionKey(condText);
  return c ? { ...c, effect } : null;
}

// 触发式「当/每当 CONDITION 时，EFFECT」：识别事件类型 + 内层效果
function triggerEventKey(condText) {
  const t = String(condText || '');
  if (/昏厥/.test(t)) return 'knocked_out';
  if (/受到(?:对手(?:的)?宝可梦(?:的)?招式)?的?伤害/.test(t)) return 'attacked_damage';
  if (/附着.*能量|从手牌将能量/.test(t)) return 'energy_attached';
  if (/进化/.test(t)) return 'evolved';
  if (/检查/.test(t)) return 'checkup';
  if (/从手牌使出/.test(t)) return 'card_played';
  if (/进入战斗场|从备战区被放入/.test(t)) return 'entered_active';
  return null;
}
function triggerParams(m) {
  const event = triggerEventKey(m[1]);
  if (!event) return null;
  const inner = parseEffect(m[2]);
  if (!inner.effects.length) return { event, effect: null, optional:/可选择|若希望|可以/.test(m[0]) };
  return { event, effect: inner.effects[0], optional:/可选择|若希望|可以/.test(m[0]) };
}

const RULES = [
  // ===== 触发式「当/每当…时，效果」：优先匹配，避免效果部分被其他规则先吃掉 =====
  { re: /^(?:每当|当)(.{2,40}?)(?:时)[，,]?(.+)$/, act:'trigger', p:triggerParams },
  // ===== 训练家/特性使用前提：仅解析为元数据，不执行合法性或费用 =====
  { re: /在上(?:一)?个对手的回合[，,]?若自己的宝可梦【(?:昏厥|气绝)】[^。]*/, act:'usage_condition', p:()=>trainerPrerequisite('own_pokemon_knocked_out_last_opponent_turn', '上一个对手回合己方宝可梦昏厥') },
  { re: /若从自己的手牌将1张["“”「」]?基本【火】能量["“”「」]?卡?(?:丢弃|丢到弃牌区|放于弃牌区)/, act:'ability_discard_cost', p:m=>({ count:1, filter:'基本【火】能量', zone:'hand', raw:m[0] }) },
  { re: /若将自己手牌中的1张["“”「」]?基本【火】能量["“”「」]?卡?(?:丢弃|丢到弃牌区|放于弃牌区)/, act:'ability_discard_cost', p:m=>({ count:1, filter:'基本【火】能量', zone:'hand', raw:m[0] }) },
  { re: /若将自己的1张手牌(?:丢弃|丢到弃牌区|放于弃牌区)[，,]?则可使用1次/, act:'ability_discard_cost', p:m=>({ count:1, zone:'hand', raw:m[0] }) },
  { re: /在这个回合[，,]?自己的宝可梦使用的招式[，,]?对对手的战斗宝可梦造成的伤害["“]?\+60["“]?点/, act:'turn_damage_mod', p:()=>({ target:'own_field', amount:60, defender:'opponent_active', duration:'turn' }) },
  { re: /在这个回合[，,]?自己的宝可梦所使用的招式[，,]?给对手的战斗宝可梦造成的伤害["“”「」]?\+60["“”「」]?/, act:'turn_damage_mod', p:()=>({ target:'own_field', amount:60, defender:'opponent_active', duration:'turn' }) },
  { re: /(?:双方玩家)?在(?:每个)?自己的回合时[，,]?可使用1次/, act:'usage_condition', p:m=>trainerPrerequisite('once_per_turn', m[0]) },
  { re: /在这个回合[，,]?若已经使出了其他的["“”]?(.+?)["“”]?[，,]?则这个特性无法使用/, act:'usage_condition', p:m=>({ kind:'ability_name_once_per_turn', abilityName:m[1], raw:m[0] }) },
  { re: /在这个回合[，,]?若已经使用了其他的["“”「」]?(.+?)["“”「」]?[，,]?则无法使用这个特性/, act:'usage_condition', p:m=>({ kind:'ability_name_once_per_turn', abilityName:m[1], raw:m[0] }) },
  { re: /这张卡可在先攻玩家的最初回合使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_player_first_turn_supporter_exception', m[0]) },
  { re: /这张卡(?:只可|只能)在.+?最初回合使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /这张卡只可在对手剩余奖赏卡的张数为(\d+)张以下时使用/, act:'trainer_prerequisite', p:m=>({ kind:'opponent_prizes_at_most', raw:m[0], count:+m[1] }) },
  { re: /(?:这张卡)?只可在后攻玩家自己的最初回合使用1次/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /这张卡只有在自己剩余奖赏卡的张数比对手剩余奖赏卡的张数多时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('own_prizes_more_than_opponent', m[0]) },
  { re: /(?:在)?(?:上个)?对手的回合[，,]?若自己的宝可梦(?:【昏厥】|(?:被)?"?击倒"?)了?[，,]?则在自己的回合时可使用1次/, act:'usage_condition', p:m=>trainerPrerequisite('own_pokemon_knocked_out_last_opponent_turn', m[0]) },
  { re: /在(?:上个|上一个)对手的回合[，,]?若自己的宝可梦(?:【(?:昏厥|气绝)】|(?:被)?"?击倒"?)[，,]?则在自己的回合可使用1次/, act:'usage_condition', p:m=>trainerPrerequisite('own_pokemon_knocked_out_last_opponent_turn', m[0]) },
  { re: /这张卡[，,]?只有在(?:上个|上一个)?对手的回合[，,]?自己的宝可梦(?:【(?:昏厥|气绝)】|(?:被)?"?击倒"?)了?时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('own_pokemon_knocked_out_last_opponent_turn', m[0]) },
  { re: /这张卡必须在(?:上个|上一个)?对手的回合[，,]?自己的宝可梦(?:【(?:昏厥|气绝)】|(?:被)?"?击倒"?)了?才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('own_pokemon_knocked_out_last_opponent_turn', m[0]) },
  { re: /这张卡[，,]?只有在将自己的(\d+)张手牌丢(?:到弃牌区|弃)才可使用/, act:'trainer_prerequisite', p:m=>({ kind:'discard_cost', raw:m[0], count:+m[1], zone:'hand' }) },
  { re: /这张卡只有在.+?时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('condition', m[0]) },
  { re: /这张卡必须.+?丢弃才可使用/, act:'trainer_prerequisite', p:m=>discardCostParams(m[0]) },

  { re: /则可使用1次/, act:'usage_condition', p:m=>trainerPrerequisite('once_per_turn', m[0]) },

  // ===== 特性：消除/被动光环 =====
  { re: /(?:对手的?)?(?:战斗宝可梦|场上宝可梦|所有场上宝可梦|场上的.*?宝可梦).*?特性(?:（.*?除外）|（除.*?外）[,，]?)?全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /将(?:双方|对手|自己的)?.*?场上.*?宝可梦.*?特性(?:（.*?除外）)?全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /这只宝可梦使用招式所需的【无】能量[，,]?减少对手已经获得的奖赏卡的张数数量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_prizes_taken'}) },
  { re: /这只宝可梦使用招式所需能量会减少与对手已经获得的奖赏卡张数相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_prizes_taken'}) },
  { re: /自己的【火】属性的【基础】宝可梦(?:（["“]?火焰鸟["”]?\s*除外）)?使用的招式[，,]?对对手的战斗宝可梦造成的伤害["“]?\+10["“]?点/, act:'passive_damage_mod', p:()=>({target:'own_field',amount:10,attackerType:'fire',attackerStage:'basic',excludeSourceName:'火焰鸟',defender:'opponent_active'}) },
  { re: /自己【火】属性的【基础】宝可梦(?:（除["“”「」]?火焰鸟["“”「」]?外）)?使用的招式[，,]?给对手战斗宝可梦造成的伤害["“”「」]?\+10["“”「」]?/, act:'passive_damage_mod', p:()=>({target:'own_field',amount:10,attackerType:'fire',attackerStage:'basic',excludeSourceName:'火焰鸟',defender:'opponent_active'}) },
  { re: /(?:自己的|这只)宝可梦使用的招式.*?造成的伤害["“]?([+-]\d+)["”]?点/, act:'passive_damage_mod', p:m=>({target:/这只/.test(m[0])?'self':'own_field',amount:+m[1]}) },
  { re: /(?:自己的|这只)宝可梦使用的招式.*?伤害["“]?([+-]\d+)["”]?点/, act:'passive_damage_mod', p:m=>({target:/这只/.test(m[0])?'self':'own_field',amount:+m[1]}) },
  { re: /自己的(?:所有|【(.+?)】(?:属性)?|"(.+?)")(?:宝可梦)?(?:所)?使用(?:的)?招式[，,]?给对手(?:的)?战斗宝可梦造成的伤害["“”「」]?([+-]?\d+)["“”「」]?/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[3],attackerType:m[1]?(ELEM[m[1]]||m[1]):undefined,attackerName:m[2]||undefined}) },
  { re: /身上放有这张卡的宝可梦(?:所使用的招式)?[，,]?给对手(?:的)?战斗宝可梦造成的伤害["“”「」]?\+(\d+)["“”「」]?/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[1]}) },
  { re: /基本【(.+?)】能量.*?(?:视为各?提供|各?被视作)2个【\1】能量/, act:'energy_provides_multiplier', p:m=>({target:/自己的场上宝可梦|场上宝可梦|自己场上宝可梦/.test(m.input)?'own_field':'self',energyType:ELEM[m[1]]||m[1],multiplier:2,basicOnly:true}) },
  // ===== 典型物品/特性复合效果 =====
  { re: /从自己的手牌选择1张【2阶进化】宝可梦(?:卡)?[，,]?放置于(?:自己的场上的可进化成|自己场上能够进化成)(?:那只|该)宝可梦的【基础】宝可梦身上[，,]?跳过【1阶进化】(?:完成|进行)进化/, act:'evolve_rare_candy', p:()=>({stage:'2阶',targetStage:'基础',bypassStage:'1阶',noPlacedThisTurn:true,noFirstTurn:true}) },
  { re: /选择自己手牌中的1张【2阶进化】宝可梦(?:卡)?[，,]?放置于自己场上能够进化成(?:那只|该)宝可梦的【基础】宝可梦身上[，,]?跳过【1阶进化】(?:完成|进行)进化/, act:'evolve_rare_candy', p:()=>({stage:'2阶',targetStage:'基础',bypassStage:'1阶',noPlacedThisTurn:true,noFirstTurn:true}) },
  { re: /查看自己的所有反面朝上的奖赏卡的正面[。.]从其中选择1张【基础】宝可梦卡[，,]?在给对手看过后[，,]?与这张"?洗翠的沉重球"?卡互换并加入手牌/, act:'prize_basic_pokemon_to_hand_exchange_trainer', p:()=>({count:1,filter:'【基础】宝可梦'}) },
  { re: /查看自己所有反面朝上的奖赏卡[。.]选择其中1张【基础】宝可梦[，,]?在给对手看过后[，,]?与这张["“”「」]?洗翠的沉重球["“”「」]?互换[，,]?加入手牌/, act:'prize_basic_pokemon_to_hand_exchange_trainer', p:()=>({count:1,filter:'【基础】宝可梦'}) },
  { re: /从自己的牌库任意选择最多与自己的场上宝可梦属性种类数量相同数量的卡[，,]?加入手牌/, act:'search_deck_to_hand', p:()=>({dynamicCount:'own_field_type_count',filter:null,allowFewer:true,allowEmpty:true}) },
  { re: /选择(?:自己的)?牌库中最多与自己场上宝可梦的属性种类数量相同数量的任意卡牌[，,]?加入手牌/, act:'search_deck_to_hand', p:()=>({dynamicCount:'own_field_type_count',filter:null,allowFewer:true,allowEmpty:true}) },
  { re: /从自己的牌库选择最多与自己场上宝可梦的属性种类数量相同数量的任意卡牌[，,]?加入手牌/, act:'search_deck_to_hand', p:()=>({dynamicCount:'own_field_type_count',filter:null,allowFewer:true,allowEmpty:true}) },
  { re: /从自己的牌库任意选择最多(\d+)张卡[，,]?加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:null},m[1],true) },
  { re: /查看(?:自己的)?牌库上方1张卡[，,]?将那张卡加入手牌[。.]或者将那张卡丢弃[，,]?从自己的牌库抽出1张卡/, act:'hikers_shoes', p:()=>({peek:1,drawOnDiscard:1}) },
  { re: /查看(?:自己的)?牌库上方1张卡[，,]?将那张卡加入手牌[。.]或者[，,]?将那张卡(?:丢弃|丢到弃牌区)[，,]?从自己的牌库抽出1张卡/, act:'hikers_shoes', p:()=>({peek:1,drawOnDiscard:1}) },
  { re: /将自己的战斗场的【基础】宝可梦与备战宝可梦互换[。.]然后[，,]?将换入备战区的宝可梦恢复"?(\d+)"?HP/, act:'switch_active_basic_heal_bench', p:m=>({heal:+m[1]}) },
  { re: /将自己战斗场上的【基础】宝可梦与备战宝可梦互换[。.]然后[，,]?恢复被换入备战区的宝可梦["“”「」]?(\d+)["“”「」]?HP/, act:'switch_active_basic_heal_bench', p:m=>({heal:+m[1]}) },
  { re: /将自己战斗场上的【基础】宝可梦与备战宝可梦互换[。.]然后[，,]?恢复被换入备战区的宝可梦["“”「」]?(\d+)["“”「」]?(?:点)?HP/, act:'switch_active_basic_heal_bench', p:m=>({heal:+m[1]}) },
  { re: /(?:可)?从自己的弃牌区选择1张【火】能量卡[，,]?附于自己的备战区的【火】宝可梦身上[。.](?:这个情况下[，,]?)?在附上那张卡的宝可梦身上放置(\d+)个伤害指示物/, act:'attach_energy_from_discard', p:m=>({count:1,filter:'【火】能量',target:'bench',targetType:'fire',damageCountersOnAttachedTarget:+m[1]}) },
  { re: /每次在自己的回合有1次机会[，,]?可从自己的弃牌区选择1张【火】能量[，,]?附于自己备战区的【火】宝可梦身上[。.]在这种情况下[，,]?给该宝可梦身上放置(\d+)个伤害指示物/, act:'attach_energy_from_discard', p:m=>({count:1,filter:'【火】能量',target:'bench',targetType:'fire',damageCountersOnAttachedTarget:+m[1]}) },
  { re: /每(?:次|当)从自己的手牌将能量附(?:着)?于这只宝可梦身上时[，,]?可使用1次[。.]将这只宝可梦与战斗宝可梦互换/, act:'attach_energy_trigger', p:()=>({event:'attach_energy_from_hand',target:'self',sourceZone:'bench',optional:true,effects:[{action:'self_switch_to_active',params:{}}]}) },
  { re: /查看(?:自己的)?牌库上方1张卡[，,]?回复原样[。.]若希望[，,]?选择1张自己的反面朝上的奖赏卡[，,]?与自己的牌库上方的卡维持反面朝上互换/, act:'prize_deck_top_swap', p:()=>({optional:true}) },
  { re: /将对手的所有宝可梦身上附加的"?宝可梦道具"?卡与"?特殊能量"?卡[，,]?与场上的"?竞技场"?卡[，,]?全部丢弃/, act:'discard_field_attachments', p:()=>({target:'opponent',tools:true,specialEnergy:true,stadium:true}) },
  { re: /选择放置于双方场上宝可梦身上的最多(\d+)张["“”「」]?宝可梦道具["“”「」]?[，,]?丢到弃牌区/, act:'discard_field_attachments', p:m=>({target:'both',tools:true,maxCount:+m[1]}) },
  { re: /选择放置于对手场上宝可梦身上最多(\d+)张["“”「」]?宝可梦道具["“”「」]?[，,]?丢到弃牌区/, act:'discard_field_attachments', p:m=>({target:'opponent',tools:true,maxCount:+m[1]}) },
  { re: /在造成伤害前[，,]?将放置于对手战斗宝可梦身上的["“”「」]?宝可梦道具["“”「」]?丢到弃牌区/, act:'discard_tool', p:()=>({target:'opponent_active'}) },
  { re: /掷1次硬币[。.]?若为正面[，,]?则选择对手的1只备战宝可梦[，,]?与战斗宝可梦互换/, act:'coin_flip', p:()=>({count:1,heads:[{action:'switch_pokemon',params:{who:'opponent'}}]}) },
  { re: /掷1次硬币[。.]?若为正面[，,]?则从自己的牌库选择1张宝可梦[，,]?在给对手看过后加入手牌[。.]并且重洗牌库/, act:'coin_flip', p:()=>({count:1,heads:[{action:'search_deck_to_hand',params:{count:1,filter:'宝可梦'}}]}) },
  { re: /掷1次硬币[。.]?若为正面[，,]?则选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]?将其丢弃/, act:'coin_flip', p:m=>opponentDiscardEnergyHeads(m[0]) },
  { re: /掷1次硬币[。.]?若为正面[，,]?则选择附于对手场上宝可梦身上的1个能量[，,]?丢到弃牌区/, act:'coin_flip', p:()=>({count:1,heads:[{action:'discard_energy',params:{target:'opponent_any',count:1}}]}) },
  { re: /将(?:自己的|自己)?手牌中的1张宝可梦，在给对手看过后，放回牌库。然后，将(?:自己的|自己)?牌库中的1张宝可梦，在给对手看过后，加入手牌/, act:'hand_pokemon_to_deck_search_pokemon', p:()=>({return_count:1,search_count:1,filter:'宝可梦'}) },
  { re: /从自己的手牌抽出1张宝可梦[，,]?在给对手看过后放回牌库[。.]然后[，,]?从自己的牌库选择1张宝可梦[，,]?在给对手看过后加入手牌[。.]并且重洗牌库/, act:'hand_pokemon_to_deck_search_pokemon', p:()=>({return_count:1,search_count:1,filter:'宝可梦'}) },
  // ===== 回合结束 =====
  { re: /若使用了这张卡[，,]?则自己的回合结束/, act:'end_turn', p:()=>({}) },
  { re: /自己的回合结束/, act:'end_turn', p:()=>({}) },

  // 掷硬币 heads 变体（位于普通“掷N次硬币”之前，先整段命中）
  { re: /掷1次硬币若为正面，则将(?:自己的|自己)?牌库中的1张物品，在给对手看过后，加入手牌。并且重洗牌库/, act:'coin_flip', p:()=>({count:1,heads:[{action:'search_deck_to_hand',params:{count:1,filter:'物品'}}]}) },
  { re: /掷1次硬币若为正面，则选择(?:自己)?牌库中任意1张卡牌?，加入手牌。并且重洗牌库/, act:'coin_flip', p:()=>({count:1,heads:[{action:'search_deck_to_hand',params:{count:1,filter:null}}]}) },
  { re: /掷1次硬币若为正面，则选择(?:自己)?弃牌区中的1张基本能量，附于(?:自己的)?【基础】宝可梦（除["“”]([^"“”]+)["“”]外）身上/, act:'coin_flip', p:m=>({count:1,heads:[{action:'attach_energy_from_discard',params:{count:1,filter:'基本能量',target:'any'}}]}) },
  { re: /掷1次硬币若为正面，则选择对手的战斗宝可梦身上附着的1个能量，将其丢弃/, act:'coin_flip', p:()=>({count:1,heads:[{action:'discard_energy',params:{target:'opponent',count:1}}]}) },
  { re: /掷1次硬币若为正面，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换/, act:'coin_flip', p:()=>({count:1,heads:[{action:'switch_pokemon',params:{who:'opponent'}}]}) },
  // ===== 掷硬币类 =====
  { re: /掷1次硬币若为反面[，,]?则这个招式失败/, act:'coin_flip', p:()=>({count:1,fail_on_tails:true}) },
  { re: /掷1次硬币若为正面[，,]?则将对手的战斗宝可梦【(.+?)】/, act:'coin_flip_status', p:m=>({count:1,statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /掷1次硬币若为正面[，,]?则在下个对手的回合[，,]?这只宝可梦不会受到招式的伤害与效果的影响/, act:'coin_flip', p:()=>({count:1,heads:[{action:'prevent_damage',params:{duration:'next_opp_turn'}},{action:'prevent_effect',params:{duration:'next_opp_turn'}}]}) },
  { re: /掷1次硬币若为正面[，,]?则在下个对手的回合[，,]?这只宝可梦不会受到招式的伤害/, act:'coin_flip', p:()=>({count:1,heads:[{action:'prevent_damage',params:{duration:'next_opp_turn'}}]}) },
  { re: /掷1次硬币若为正面[，,]?则选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]?将其丢弃/, act:'coin_flip', p:m=>opponentDiscardEnergyHeads(m[0]) },
  { re: /掷1次硬币若为正面[，,]?则增加(\d+)伤害/, act:'coin_flip_damage', p:m=>({count:1,damage:+m[1]}) },
  { re: /若在后攻玩家的最初回合[，,]?则将对手的(?:战斗)?宝可梦【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]], condition:'second_player_first_turn'}) },
  { re: /若是?后攻玩家的最初回合[，,]?则将对手的(?:战斗)?宝可梦【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]], condition:'second_player_first_turn'}) },
  { re: /掷硬币直到出现反面[，,]?造成正面(?:出现的)?次数[×x](\d+)伤害/, act:'coin_flip_until_tails', p:m=>({damage_per:+m[1]}) },
  { re: /掷硬币直到出现反面[，,]?追加造成正面(?:出现的)?次数[×x](\d+)伤害/, act:'coin_flip_until_tails', p:m=>({damage_per:+m[1]}) },
  { re: /掷(\d+)次硬币[，,]?造成正面(?:出现的)?次数[×x](\d+)伤害/, act:'coin_flip_damage', p:m=>({count:+m[1],damage_per:+m[2]}) },
  { re: /掷(\d+)次硬币/, act:'coin_flip', p:m=>({count:+m[1]}) },
  { re: /掷1次硬币/, act:'coin_flip', p:()=>({count:1}) },

  // ===== 丢弃全部手牌 =====
  { re: /将自己的手牌全部丢[弃到]/, act:'discard_all_hand', p:()=>({}) },

  // ===== 手牌回牌库+抽卡 =====
  { re: /双方玩家各将手牌全部放回牌库并重洗[。.]然后[，,]?从牌库抽卡[，,]?自己抽出(\d+)张[，,]?对手抽出(\d+)张/, act:'shuffle_hand_to_deck', p:m=>({who:'both',self_draw_count:+m[1],opponent_draw_count:+m[2]}) },
  { re: /双方玩家各将所有手牌放回牌库并重洗[。.]然后[，,]?(?:从牌库)?各抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'both',draw_count:+m[1]}) },
  { re: /对手将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]?抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'opponent',draw_count:+m[1]}) },
  { re: /将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]?从牌库抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'self',draw_count:+m[1]}) },

  // ===== 搜牌库放备战区 =====
  { re: /(?:可)?从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张HP为[「"]?(\d+)[」"]?以下的.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:`HP为${m[2]}以下的【基础】宝可梦`, maxHp:+m[2]},m[1],true) },
  { re: /可从(?:自己的)?牌库选择1张【基础】宝可梦卡[（(]["“]?拥有规则的宝可梦["”]?除外[）)][，,]?放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦卡（"拥有规则的宝可梦"除外）'},1,true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],false) },
  { re: /从(?:自己的)?牌库选择最多(\d+)张(.+?)宝可梦(?:卡)?[,，]放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:m[2]},m[1],true) },
  { re: /从(?:自己的)?牌库选择1张【基础】宝可梦卡[，,]?放置于备战区/, act:'search_deck_to_bench', p:()=>withCount({filter:'【基础】宝可梦'},1,false) },

  // ===== 搜牌库加手 =====
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张(.+?)(?:卡)?[,，][在给对手看过后]*加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2].replace(/["“”]/g,'').trim()},m[1]||1,true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张(.+?)(?:卡)?[,，][在给对手看过后]*加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2].replace(/["“”]/g,'').trim()},m[1]||1,false) },
  { re: /从(?:自己的)?牌库选择(.+?)各(\d+)张[,，]在给对手看过后加入手牌/, act:'search_deck_to_hand', p:m=>({count:+m[2],filter:m[1].replace(/["“”]/g,'').trim()}) },
  { re: /从(?:自己的)?牌库选择1张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'search_deck_to_hand', p:m=>({count:1,filter:m[1].replace(/["“”]/g,'').trim()}) },

  // ===== 看牌库上方选牌 =====
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[，,]?从其中选择(.+?)合计最多(\\d+)张[，,]?在给对手看过后[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[2].trim()},m[3],true)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[，,]?从其中选择(\\d+)张(.+?)(?:卡)?[，,]?在给对手看过后[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim()},m[2],false)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张[。.]可将其中的(\\d+)张(.+?)(?:卡)?[，,]?在给对手看过后[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim(),keepOrder:true},m[2],true)) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[。.]选择(?:其中)?(?:最多)?(\\d+)张(.+?)(?:卡)?[,，]在给对手看过后[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:m[3].trim()},m[2],optionalText(m[0]))) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[。.]选择(?:其中)?(?:最多)?(\\d+)张(.*?)[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:cleanPeekFilter(m[3])},m[2],optionalText(m[0]))) },
  { re: new RegExp(`查看(?:自己的)?牌库上方(\\d+)张卡[,，]选择(?:其中)?(?:最多)?(\\d+)张(.*?)[，,]?加入手牌${PEEK_REMAINDER}`), act:'peek_and_keep', p:m=>peekParams(m,withKeep({peek:+m[1],filter:cleanPeekFilter(m[3])},m[2],optionalText(m[0]))) },
  { re: /查看(?:自己的)?牌库上方(\d+)张卡[,，]选择/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:1}) },

  // ===== 抽卡 =====
  { re: /从自己的弃牌区选择1张["“”]?基本【火】能量["“”]?卡[，,]?附于自己的1只备战宝可梦身上/, act:'attach_energy_from_discard', p:()=>withCount({filter:'基本【火】能量',target:'bench'},1,false) },
  { re: /(?:然后[，,]?)?从牌库抽卡直到(?:自己的)?手牌满(\d+)张(?:为止)?/, act:'draw_until', p:m=>({target:+m[1]}) },
  { re: /(?:若希望[，,]?)?从牌库上方抽出卡牌[，,]?直到自己的手牌(?:数量)?变为(\d+)张(?:为止)?/, act:'draw_until', p:m=>({target:+m[1]}) },
  { re: /从牌库抽出卡牌[，,]?直到自己的手牌变为(\d+)张(?:为止)?/, act:'draw_until', p:m=>({target:+m[1]}) },
  { re: /从(?:自己的)?牌库抽出(\d+)张卡/, act:'draw', p:m=>({count:+m[1]}) },
  { re: /从牌库抽出(\d+)张/, act:'draw', p:m=>({count:+m[1]}) },

  // ===== HP恢复 =====
  { re: /HP全部恢复/, act:'heal', p:()=>({amount:'full'}) },
  { re: /将(?:这只)?(?:宝可梦|.*?)恢复"?(\d+)"?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /恢复这只宝可梦["“”「」]?(\d+)["“”「」]?HP/, act:'heal', p:m=>({amount:+m[1],target:'self'}) },
  { re: /恢复"?(\d+)"?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /将自己所有宝可梦的HP[，,]?各恢复["“”「」]?\+?(\d+)["“”「」]?/, act:'heal_all', p:m=>({amount:+m[1]}) },

  // ===== 状态异常 =====
  { re: /将对手的(?:战斗)?宝可梦【中毒】[，,]?【灼伤】与【混乱】/, act:'inflict_status', p:()=>({statuses:['poison','burn','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【中毒】与【灼伤】/, act:'inflict_status', p:()=>({statuses:['poison','burn']}) },
  { re: /将对手的(?:战斗)?宝可梦【中毒】与【混乱】/, act:'inflict_status', p:()=>({statuses:['poison','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【灼伤】与【混乱】/, act:'inflict_status', p:()=>({statuses:['burn','confusion']}) },
  { re: /将对手的(?:战斗)?宝可梦【(.+?)】与【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1],STATUS_MAP[m[2]]||m[2]]}) },
  { re: /将对手的(?:战斗)?宝可梦【(.+?)】/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /会使?使用了招式的宝可梦陷入【(.+?)】状态/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]],target:'attacker'}) },
  { re: /将这只宝可梦【(.+?)】/, act:'inflict_status_self', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /将双方的战斗宝可梦【(.+?)】/, act:'inflict_status_both', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },

  // ===== 自身伤害 =====
  { re: /这只宝可梦也受到(\d+)伤害/, act:'self_damage', p:m=>({amount:+m[1]}) },

  // ===== 换位 =====
  { re: /双方玩家将自己的战斗宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'both'}) },
  { re: /选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换[。.]\[由对手选择/, act:'switch_pokemon', p:()=>({who:'opponent',choose:'opponent'}) },
  { re: /选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /选择对手的1只备战宝可梦[，,]?将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /选择自己的1只备战宝可梦[，,]?将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /选择对手的1只备战宝可梦[，,]?与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /将对手的(?:战斗)?宝可梦与备战宝可梦互换[。.]\[由对手选择/, act:'switch_pokemon', p:()=>({who:'opponent',choose:'opponent'}) },
  { re: /将对手的(?:战斗)?宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /若希望[，,]?将这只宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self',optional:true}) },
  { re: /将自己的(?:战斗|场上)?宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /将这只宝可梦与备战宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },

  // ===== 备战区伤害 =====
  { re: /对手的1只备战宝可梦也受到(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_1',damage:+m[1]}) },
  { re: /给对手的1只备战宝可梦[，,]?也造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_1',damage:+m[1]}) },
  { re: /给对手的1只备战宝可梦[，,]?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_1',damage:+m[1]}) },
  { re: /给对手的(\d+)只备战宝可梦[，,]?(?:也)?各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:+m[1],damage:+m[2]}) },
  { re: /给对手的所有宝可梦[，,]?各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_all_field',damage:+m[1]}) },
  { re: /对手的1只宝可梦受到(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[1]}) },
  { re: /给对手的1只宝可梦[，,]?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[1]}) },
  { re: /对手的所有备战宝可梦也各受到(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_all',damage:+m[1]}) },
  { re: /给对手的所有备战宝可梦[，,]?也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_all',damage:+m[1]}) },
  { re: /给身上放置有伤害指示物的对手的1只备战宝可梦[，,]?也造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_1_has_damage',damage:+m[1]}) },
  { re: /自己的所有备战宝可梦也各受到(\d+)伤害/, act:'damage_bench', p:m=>({target:'self_all',damage:+m[1]}) },

  // ===== 伤害指示物 =====
  { re: /将(\d+)个伤害指示物以任意方式放置于对手的宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_any',count:+m[1]}) },
  { re: /将(\d+)个伤害指示物放置于(?:使用了|使用)招式的宝可梦身上/, act:'damage_place', p:m=>({target:'attacker',count:+m[1]}) },
  { re: /将(\d+)个伤害指示物[，,]?以任意方式放置于对手的备战宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_bench',count:+m[1]}) },
  { re: /给对手的1只宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_any',count:+m[1]}) },
  { re: /给对手的战斗宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_active',count:+m[1]}) },
  { re: /给(?:那只|该|这只)宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'attacker',count:+m[1]}) },
  { re: /给自己(?:的)?1只宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'self',count:+m[1]}) },
  { re: /在对手的战斗宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_active',count:+m[1]}) },
  { re: /在使用招式的宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'attacker',count:+m[1]}) },
  { re: /在这只宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'self',count:+m[1]}) },

  // ===== 伤害增减 =====
  { re: /在上个对手的回合[，,]?若自己的宝可梦因招式的伤害而【昏厥】了[，,]?则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_pokemon_knocked_out_last_opponent_turn'}) },
  { re: /在上一个对手的回合[，,]?若因为招式的伤害[，,]?而导致自己的宝可梦【昏厥】[，,]?则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_pokemon_knocked_out_last_opponent_turn'}) },
  { re: /若这只宝可梦身上放置有伤害指示物[，,]?则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_has_damage'}) },
  { re: /若对手的战斗宝可梦身上放置有伤害指示物[，,]?则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_active_has_damage'}) },
  { re: /若(.{2,30}?)(?:的话)?[，,]?则(?:追加造成|增加)(\d+)伤害/, act:'conditional_damage_mod', p:m=>conditionDamageParams(m[1], +m[2]) || {condition:'custom',conditionText:m[1],amount:+m[2],mode:'fixed'} },
  { re: /在这个回合[，,]?若(?:从手牌使出了支援者|使用了支援者)(?:的话)?[，,]?则(?:追加造成|增加)(\d+)伤害/, act:'conditional_damage_mod', p:m=>({condition:'supporter_used_this_turn', amount:+m[1], mode:'fixed'}) },
  { re: /在这个回合[，,]?若这只宝可梦(?:刚|在)这个回合(?:完成)?进化(?:的话)?[，,]?则这个招式失败/, act:'conditional_effect', p:()=>({condition:'evolved_this_turn', effect:{action:'attack_fail'}}) },
  { re: /若(.{2,30}?)(?:的话)?[，,]?则(?:使该宝可梦|使对手的战斗宝可梦|将对手的战斗宝可梦|令其)【昏厥】/, act:'conditional_effect', p:m=>conditionalEffectParams(m[1], {action:'knockout'}) },
  { re: /令对手的战斗宝可梦【昏厥】/, act:'knockout', p:()=>({target:'opponent'}) },
  { re: /若(.{2,30}?)(?:的话)?[，,]?则这个招式失败/, act:'conditional_effect', p:m=>conditionalEffectParams(m[1], {action:'attack_fail'}) },
  { re: /若(.{2,30}?)(?:的话)?[，,]?则这只宝可梦【撤退】所需能量[，,]?全部消除/, act:'conditional_effect', p:m=>conditionalEffectParams(m[1], {action:'retreat_cost_zero', params:{target:'self'}}) },
  { re: /若对手的战斗宝可梦为【(.+?)】宝可梦[，,]?则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'opponent_active_type',type:ELEM[m[1]]||m[1]}) },
  // 受到(的)招式的伤害±N：伤害接收修正（减伤为负、增伤为正）
  { re: /在下个对手的回合[，,]?这只宝可梦(?:所)?受到的?招式的伤害["“”「」]?([+-]?\d+)["“”「」]?/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self',duration:'next_opp_turn'}) },
  { re: /这只宝可梦(?:所)?受到的?招式的伤害["“”「」]?([+-]?\d+)["“”「」]?/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /受到这个招式影响的宝可梦(?:所)?受到的?招式的伤害["“”「」]?([+-]?\d+)["“”「」]?/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'opponent'}) },
  { re: /自己所有的宝可梦[，,]?受到对手宝可梦的招式的伤害["“”「」]?([+-]?\d+)["“”「」]?/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'own_field'}) },
  { re: /自己(?:所有|的)?宝可梦的【撤退】所需能量[，,]?全部消除/, act:'retreat_cost_zero', p:()=>({target:'own_field'}) },
  { re: /身上放有这张卡的宝可梦[，,]?【撤退】所需能量减少(\d+)个/, act:'retreat_cost_reduce', p:m=>({amount:+m[1],target:'self'}) },
  { re: /身上放有这张卡的(?:【.+?】)?宝可梦(?:（[^）]*）)?(?:的)?最大HP(?:增加)?["“”]?\+?(\d+)["“”]?/, act:'max_hp_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /若这只宝可梦身上附着了特殊能量(?:的话)?[，,]?则这只宝可梦(?:的)?最大HP(?:增加)?["“”]?\+?(\d+)["“”]?/, act:'max_hp_mod', p:m=>({condition:'self_has_special_energy',amount:+m[1]}) },
  { re: /受到这个招式影响的宝可梦[，,]?【撤退】所需能量增加(\d+)个/, act:'retreat_cost_increase', p:m=>({amount:+m[1]}) },
  { re: /受到这个招式影响的宝可梦[，,]?使用招式所需能量[，,]?(?:就会)?增加(\d+)个【无】能量/, act:'attack_cost_increase', p:m=>({amount:+m[1]}) },
  { re: /受到这个招式影响的宝可梦[，,]?使用招式所需能量和【撤退】所需能量[，,]?各增加(\d+)个【无】能量/, act:'cost_increase_both', p:m=>({amount:+m[1]}) },
  { re: /对手的(?:战斗)?宝可梦使用招式所需能量[，,]?就会增加(\d+)个【无】能量/, act:'attack_cost_increase', p:m=>({target:'opponent_active',amount:+m[1]}) },
  { re: /对手的(?:所有备战|所有)宝可梦[，,]?无法恢复HP/, act:'block_heal', p:m=>({target:/备战/.test(m[0])?'opponent_bench':'opponent_field'}) },
  { re: /双方(?:所有|场上所有)的宝可梦[，,]?无法恢复HP/, act:'block_heal', p:()=>({target:'both_field'}) },
  { re: /属性变为【(.+?)】和【(.+?)】2种/, act:'dual_type', p:m=>({types:[ELEM[m[1]]||m[1],ELEM[m[2]]||m[2]]}) },
  { re: /(?:自己的所有|自己所有)宝可梦[，,]?不会陷入特殊状态/, act:'block_special_condition', p:()=>({target:'own_field'}) },
  { re: /(?:身上附着能量的)?自己所有的宝可梦[，,]?不会受到对手宝可梦(?:使用|所使用的|使用的)招式的效果影响/, act:'prevent_effect', p:()=>({target:'own_field',source:'attack'}) },
  { re: /对手的战斗宝可梦[，,]?因【中毒】而放置的伤害指示物数量增加(\d+)个/, act:'poison_damage_increase', p:m=>({target:'opponent_active',amount:+m[1]}) },
  { re: /(?:自己所有宝可梦|双方场上所有的【(.+?)】宝可梦)的弱点[，,]?全部消除/, act:'weakness_null', p:m=>({target:m[1]?'both_type':'own_field',type:m[1]?(ELEM[m[1]]||m[1]):undefined}) },
  { re: /造成对手的战斗宝可梦【撤退】所需的能量的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_retreat_cost',mode:'per_unit'}) },
  { re: /造成对手战斗宝可梦【撤退】所需能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_retreat_cost',mode:'per_unit'}) },
  { re: /增加对手的战斗宝可梦身上附加的能量的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_active_energy_count',mode:'per_unit'}) },
  { re: /追加造成对手战斗宝可梦身上附着的能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_active_energy_count',mode:'per_unit'}) },
  { re: /增加对手的战斗宝可梦身上放置的伤害指示物的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_damage_counters',mode:'per_unit'}) },
  { re: /追加造成对手战斗宝可梦身上放置的伤害指示物数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_damage_counters',mode:'per_unit'}) },
  { re: /增加这只宝可梦身上放置的伤害指示物的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'per_unit'}) },
  { re: /追加造成这只宝可梦身上放置的伤害指示物数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'per_unit'}) },
  { re: /增加这只宝可梦身上附加的.+?能量的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_energy',mode:'per_unit'}) },
  { re: /追加造成这只宝可梦身上附着的.+?能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_energy',mode:'per_unit'}) },
  { re: /增加双方的备战宝可梦的数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'total_bench',mode:'per_unit'}) },
  { re: /追加造成双方(?:的)?备战宝可梦(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'total_bench',mode:'per_unit'}) },
  { re: /增加.+?的.*?张数[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'count',mode:'per_unit'}) },
  { re: /造成这只宝可梦身上附着的(.+?)能量(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'self_energy',mode:'per_unit'}) },
  { re: /追加造成(?:对手|自己的).*?身上附着的(.+?)能量(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:m[0].includes('对手')?'opponent_active_energy_count':'self_energy',mode:'per_unit'}) },
  { re: /造成对手(?:的)?战斗宝可梦的【撤退】所需能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_retreat_cost',mode:'per_unit'}) },
  { re: /追加造成对手(?:的)?战斗宝可梦的【撤退】所需能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_retreat_cost',mode:'per_unit'}) },
  { re: /造成这只宝可梦身上附着的能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_energy',mode:'per_unit'}) },
  { re: /造成对手(?:的)?场上宝可梦身上附着的能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_field_energy',mode:'per_unit'}) },
  { re: /追加造成自己(?:的)?场上宝可梦身上附着的能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_field_energy',mode:'per_unit'}) },
  { re: /造成对手战斗宝可梦身上附着的能量(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_active_energy_count',mode:'per_unit'}) },
  { re: /造成自己(?:的)?场上宝可梦身上附着的【(.+?)】能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_field_energy_type',type:m[1],mode:'per_unit'}) },
  { re: /造成对手(?:的)?所有宝可梦身上附着的【(.+?)】能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'opponent_field_energy_type',type:m[1],mode:'per_unit'}) },
  { re: /追加造成附于自己场上宝可梦身上的基本能量的属性种类数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_field_energy_type_count',mode:'per_unit'}) },
  { re: /追加造成附于自己场上宝可梦身上的能量的属性种类数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_field_energy_type_count',mode:'per_unit'}) },
  { re: /追加造成对手(?:的)?备战宝可梦(?:的)?数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_bench_count',mode:'per_unit'}) },
  { re: /追加造成对手已经获得的奖赏卡(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_prizes_taken',mode:'per_unit'}) },
  { re: /追加造成放置于这只宝可梦身上的伤害指示物数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'per_unit'}) },
  { re: /造成放置于这只宝可梦身上的伤害指示物数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'per_unit'}) },

  // ===== 防止伤害/效果 =====
  { re: /在下个对手的回合[，,]?这只宝可梦不会受到招式的伤害与效果的影响/, act:'prevent_damage_effect', p:()=>({duration:'next_opp_turn'}) },
  { re: /在下个对手的回合[，,]?这只宝可梦不会受到招式的伤害/, act:'prevent_damage', p:()=>({duration:'next_opp_turn'}) },
  { re: /自己的所有备战宝可梦不会受到对手的宝可梦招式的伤害与效果的影响/, act:'bench_attack_shield', p:()=>({target:'own_bench',source:'opponent_attack',preventDamage:true,preventEffect:true}) },
  { re: /自己的所有备战宝可梦[，,]?不会受到对手宝可梦的招式的伤害(?:和|与)效果(?:的)?影响/, act:'bench_attack_shield', p:()=>({target:'own_bench',source:'opponent_attack',preventDamage:true,preventEffect:true}) },
  { re: /自己所有的备战宝可梦[，,]?不会受到对手宝可梦的招式的伤害(?:和|与)效果(?:的)?影响/, act:'bench_attack_shield', p:()=>({target:'own_bench',source:'opponent_attack',preventDamage:true,preventEffect:true}) },
  { re: /这只宝可梦不会受到对手的宝可梦使用招式的效果的影响/, act:'prevent_effect', p:()=>({source:'attack'}) },
  { re: /这只宝可梦[，,]?不会受到对手(?:的)?宝可梦(?:所使用|使用)招式的效果(?:的)?影响/, act:'prevent_effect', p:()=>({source:'attack'}) },
  { re: /这只宝可梦[，,]?不会受到对手(?:的)?宝可梦特性的效果影响/, act:'prevent_effect', p:()=>({source:'ability'}) },
  { re: /这只宝可梦不会陷入【(.+?)】状态/, act:'block_status', p:m=>({status:STATUS_MAP[m[1]]||m[1],target:'self'}) },
  { re: /(?:自己的所有|自己所有)宝可梦[，,]?不会陷入【(.+?)】状态/, act:'block_status', p:m=>({status:STATUS_MAP[m[1]]||m[1],target:'own_field'}) },
  { re: /双方(?:的)?所有宝可梦[，,]?不会陷入【(.+?)】状态/, act:'block_status', p:m=>({status:STATUS_MAP[m[1]]||m[1],target:'both_field'}) },
  { re: /不会受到.*?招式的伤害/, act:'prevent_damage', p:()=>({source:'attack'}) },

  // ===== 无视弱抗/效果 =====
  { re: /这个招式的伤害[，,]?不计算弱点[、，]?抗性(?:以及对手(?:的)?战斗宝可梦身上(?:所)?附加的效果)?/, act:'ignore', p:m=>({what:/以及|效果/.test(m[0])?'weakness_resistance_effects':'weakness_resistance'}) },
  { re: /这个招式的伤害[，,]?不计算弱点/, act:'ignore', p:()=>({what:'weakness'}) },
  { re: /这个招式的伤害[，,]?不计算(?:抵抗|抗力|抗性)/, act:'ignore', p:()=>({what:'resistance'}) },
  { re: /这个招式的伤害[，,]?不计算对手(?:的)?战斗宝可梦身上(?:所)?附加的效果/, act:'ignore', p:()=>({what:'opponent_effects'}) },

  // ===== 无法攻击/撤退 =====
  { re: /在下个自己的回合[，,]?这只宝可梦无法使用招式/, act:'cannot_attack_next', p:()=>({duration:'next_self_turn'}) },
  { re: /在下个自己的回合[，,]?这只宝可梦无法使用"?(.+?)"?[,。]/, act:'cannot_attack_next', p:m=>({move:m[1]}) },
  { re: /在下个对手的回合[，,]?受到这个招式(?:影响)?的宝可梦[，,]?无法撤退/, act:'cannot_retreat', p:()=>({target:'opponent',duration:'next_opp_turn'}) },
  { re: /对手的(?:战斗)?宝可梦[，,]?无法撤退/, act:'cannot_retreat_passive', p:()=>({target:'opponent_active'}) },

  // ===== 弃牌区附能 =====
  { re: /从自己的弃牌区(?:选择|抽出)最多(\d+)张["“”]?([^"“”。，,]+?能量)["“”]?卡?[，,]?附于((?:(?!(?:所有|各|那些|以任意方式)).)+?宝可梦)(?:身上)?/, act:'attach_energy_from_discard', p:m=>discardAttachParams(m,true) },
  { re: /从自己的弃牌区选择(\d+)张["“”「」]?([^"“”「」。，,]+?能量)["“”「」]?卡?[，,]?附于自己的宝可梦身上/, act:'attach_energy_from_discard', p:()=>withCount({filter:'基本能量',target:'any'},1,false) },
  { re: /从自己的弃牌区(?:选择|抽出)(\d+)张["“”]?([^"“”。，,]+?能量)["“”]?卡?[，,]?附于((?:(?!(?:所有|各|那些|以任意方式)).)+?宝可梦)(?:身上)?/, act:'attach_energy_from_discard', p:m=>discardAttachParams(m,false) },

  // ===== 牌库附能 =====
  { re: /从(?:自己的)?牌库(?:选择|抽出)最多(\d+)张(.+?)能量卡[,，]?附于/, act:'attach_energy_from_deck', p:m=>withCount({filter:m[2].trim()},m[1],true) },
  { re: /从(?:自己的)?牌库(?:选择|抽出)(\d+)张(.+?)能量卡[,，]?附于/, act:'attach_energy_from_deck', p:m=>withCount({filter:m[2].trim()},m[1],false) },

  // ===== 丢弃自身能量 =====
  { re: /将这只宝可梦身上所附加的(.+?)能量全部丢弃/, act:'discard_energy', p:m=>({target:'self',filter:m[1],count:'all'}) },
  { re: /将附于这只宝可梦身上的(?:所有)?能量[，,]?(?:全部)?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /将附于这只宝可梦身上的(\d+)个能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /将这只宝可梦身上附加的(.+?)能量(?:丢弃|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',filter:m[1],count:1}) },
  { re: /将这只宝可梦身上所附加的(\d+)个能量丢到弃牌区/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /将这只宝可梦身上附加的能量卡全部丢弃/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /将这只宝可梦身上附着的(\d+)个(?:【(.+?)】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:+m[1],filter:m[2]?`【${m[2]}】能量`:undefined}) },
  { re: /从自己手牌将最多(\d+)张["“”]?(?:基本)?【(.+?)】能量["“”]?丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:+m[1],filter:`【${m[2]}】能量`,amountPer:+m[3],source:'hand'}) },
  { re: /将附于自己场上宝可梦身上的任意数量的(?:【(.+?)】)?能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:m[1]?`【${m[1]}】能量`:undefined,amountPer:+m[2],source:'field'}) },
  { re: /将自己场上宝可梦身上附着的任意数量的【(.+?)】能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:`【${m[1]}】能量`,amountPer:+m[2],source:'field'}) },
  { re: /将附于这只宝可梦身上的所有基本能量丢到弃牌区[，,]?造成丢到弃牌区的基本能量的属性种类数量[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'all',filter:'基本能量',amountPer:+m[1],source:'field',mode:'type_count'}) },
  { re: /将附于这只宝可梦身上的所有基本能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'all',filter:'基本能量',amountPer:+m[1],source:'field'}) },
  { re: /将自己手牌中任意数量的基本能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:'基本能量',amountPer:+m[1],source:'hand'}) },
  { re: /将自己手牌中任意数量的基本能量丢到弃牌区[，,]?造成丢到弃牌区的基本能量的属性种类数量[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:'基本能量',amountPer:+m[1],source:'hand',mode:'type_count'}) },
  { re: /将自己场上宝可梦身上附着的任意数量的基本能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:'基本能量',amountPer:+m[1],source:'field'}) },
  { re: /将附于自己场上宝可梦身上任意数量的【(.+?)】能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:`【${m[1]}】能量`,amountPer:+m[2],source:'field'}) },
  { re: /将附于这只宝可梦身上的【(.+?)】或【(.+?)】属性中的1种属性的任意数量的基本能量丢到弃牌区[，,]?追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({count:'any',filter:`【${m[1]}】能量或【${m[2]}】能量`,amountPer:+m[3],source:'field'}) },
  { re: /选择2个这只宝可梦身上附加的能量[，,]?将其丢弃/, act:'discard_energy', p:()=>({target:'self',count:2}) },
  { re: /选择这只宝可梦身上附着的(\d+)个(?:【.+?】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /选择附于这只宝可梦身上的(\d+)个(?:【.+?】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /选择1个这只宝可梦身上附加的能量[，,]?将其丢弃/, act:'discard_energy', p:()=>({target:'self',count:1}) },

  // ===== 对手能量丢弃/移动/弃牌区附能（简中高频变体）=====
  { re: /将附于对手(?:的)?战斗宝可梦身上的(\d+)个(?:特殊|【.+?】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /选择附于对手(?:的)?战斗宝可梦身上的(\d+)个(?:【.+?】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /选择对手战斗宝可梦身上附着的(\d+)个(?:【.+?】)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /选择这只宝可梦身上附着的(\d+)个(?:【.+?】)?能量[，,]?转附于(?:1只|一只)?备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench'}) },
  { re: /将自己弃牌区中的(\d+)张(.+?能量)[，,]?附于自己的(?:1只|一只)?(?:备战)?(?:【.+?】)?宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:m[2].trim(),target:'any'},m[1],false) },
  { re: /从自己的弃牌区选择最多(\d+)张【(.+?)】能量[，,]?以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],true) },
  { re: /从自己的弃牌区选择最多(\d+)张["“”「」]?(.+?能量)["“”「」]?[，,]?以任意方式附于(?:自己的)?备战宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:m[2].trim(),target:'bench'},m[1],true) },
  { re: /从自己的弃牌区选择(\d+)张(?:【.+?】)?宝可梦[，,]?放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],false) },
  { re: /选择自己手牌中的["“”]?(?:基本)?【(.+?)】能量["“”]?和["“”]?(?:基本)?【(.+?)】能量["“”]?各最多1张[，,]?以任意方式附于自己宝可梦身上/, act:'attach_energy_from_hand', p:m=>({target:'any',optional:true,filter:`【${m[1]}】能量或【${m[2]}】能量`}) },
  { re: /选择自己手牌中的(\d+)张能量[，,]?附于自己的备战宝可梦身上/, act:'attach_energy_from_hand', p:m=>withCount({filter:'能量',target:'bench'},m[1],false) },
  { re: /选择自己手牌中的(\d+)张(.+?能量)[，,]?附于自己的(?:备战)?宝可梦身上/, act:'attach_energy_from_hand', p:m=>withCount({filter:m[2].trim(),target:'any'},m[1],false) },
  { re: /(?:若希望，)?可选择附于对手战斗宝可梦身上的(\d+)个(?:【.+?】)?能量[，,]?放回对手的手牌/, act:'return_energy_to_hand', p:m=>({count:+m[1],optional:/若希望/.test(m[0])}) },
  { re: /选择附于这只宝可梦身上的(\d+)个(?:【.+?】)?能量[，,]?放回手牌/, act:'return_energy_to_hand', p:m=>({target:'self',count:+m[1]}) },
  { re: /选择这只宝可梦身上附着的(\d+)个(?:【.+?】)?能量[，,]?放回手牌/, act:'return_energy_to_hand', p:m=>({target:'self',count:+m[1]}) },

  // ===== 丢弃对手能量 =====
  { re: /选择1个对手的(?:战斗宝可梦|备战宝可梦|(?:场上)?宝可梦|1只宝可梦)身上附加的能量[，,]?将其丢弃/, act:'discard_energy', p:m=>opponentDiscardEnergyParams(m[0]) },
  { re: /将对手的战斗宝可梦身上附加的1个能量丢弃/, act:'discard_energy', p:()=>({target:'opponent',count:1}) },

  // ===== 能量换位 =====
  { re: /从备战宝可梦.*?改附于.*?战斗宝可梦/, act:'move_energy', p:()=>({source:'bench',dest:'active'}) },
  { re: /选择附于自己场上宝可梦身上的1个基本能量[，,]?转附于自己其他宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench'}) },
  { re: /选择1个这只宝可梦身上附加的能量[，,]?改附于备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench'}) },
  { re: /将这只宝可梦身上附着的所有能量[，,]?以任意方式转附于(?:1只|一只)?备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:'all'}) },
  { re: /将这只宝可梦身上附着的所有能量[，,]?转附于(?:1只|一只)?备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:'all'}) },
  { re: /(?:可选择|选择)(?:该|这只)?战斗宝可梦身上附着的(\d+)张(.+?能量)[，,]?转附于这只宝可梦身上/, act:'move_energy', p:m=>({source:'self',dest:'bench',count:+m[1],filter:m[2].trim()}) },

  // ===== 回手 =====
  { re: /选择1只自己的场上宝可梦[，,]?将那只宝可梦与附加的卡[，,]?全部放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  { re: /(?:选择|将)自己的.*?宝可梦.*?宝可梦以外的卡.*?(?:丢弃|丢到弃牌区)/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:false}) },
  { re: /将自己的.*?宝可梦与(?:所附加的所有卡|附加的卡)[,，]?(?:全部)?放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  { re: /将自己的.*?宝可梦[,，]?(?:全部)?放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:false}) },
  { re: /将这只宝可梦与附加的卡[，,]?全部放回手牌/, act:'return_to_hand', p:()=>({target:'self',with_attachments:true}) },
  { re: /将这只宝可梦[，,]?以及放置于其身上的所有卡(?:牌)?[，,]?放回手牌/, act:'return_to_hand', p:()=>({target:'self',with_attachments:true}) },
  { re: /选择自己场上(?:的)?1只宝可梦[，,]?将(?:那只|该)宝可梦[，,]?以及放置于其身上的所有卡(?:牌)?[，,]?放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },

  // ===== 弃牌区回收 =====
  { re: /从(?:自己的)?弃牌区选择(.+?)合计最多(\d+)张[，,]?在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[1].trim(),target:'hand'},m[2],true) },
  { re: /从(?:自己的)?弃牌区选择最多(\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择(\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],false) },
  { re: /从(?:自己的)?弃牌区选择最多(\d+)张(.+?)(?:卡)?[,，]加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择(\d+)张(.+?)(?:卡)?[,，]加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],false) },
  { re: /从(?:自己的)?弃牌区选择宝可梦卡与基本能量卡合计最多(\d+)张[，,]?在给对手看过后放回牌库并重洗/, act:'recover_from_discard', p:m=>withCount({filter:'宝可梦卡与基本能量卡',target:'deck',shuffle:true},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择.*?合计最多(\d+)张[,，]在给对手看过后放回牌库/, act:'recover_from_discard', p:m=>withCount({target:'deck'},m[1],true) },
  { re: /从(?:自己的)?弃牌区选择.*?合计(\d+)张[,，]在给对手看过后放回牌库/, act:'recover_from_discard', p:m=>withCount({target:'deck'},m[1],false) },
  { re: /从(?:自己的)?弃牌区(?:选择|抽出).*?(?:加入手牌|放回牌库)/, act:'recover_from_discard', p:()=>({count:1,target:'hand'}) },

  // ===== 多获奖赏 =====
  { re: /多获得(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[1]}) },
  { re: /若因为这个招式的伤害[，,]?对手(?:的)?宝可梦【昏厥】[，,]?则多拿取(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[1],condition:'knocked_out_by_damage'}) },

  // ===== 对手牌库丢弃 =====
  { re: /将对手的牌库上方(\d+)张卡丢弃/, act:'mill', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /将对手(?:的)?牌库上方(?:的)?(\d+)张卡(?:牌)?丢到弃牌区/, act:'mill', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /将自己(?:的)?牌库上方(?:的)?(\d+)张卡(?:牌)?丢到弃牌区/, act:'mill', p:m=>({target:'self',count:+m[1]}) },

  // ===== 查看对手手牌 =====
  { re: /查看对手的手牌/, act:'look_at', p:()=>({target:'opponent_hand'}) },

  // ===== 随机丢弃对手手牌 =====
  { re: /在不看正面的情况下[，,]?选择1张对手的手牌[，,]?将其丢弃/, act:'discard_opponent_hand_random', p:()=>({count:1}) },
  { re: /在不看对手手牌正面的前提下[，,]?选择其中1张丢到弃牌区/, act:'discard_opponent_hand_random', p:()=>({count:1}) },
  { re: /(?:若希望[，,]?)?将场上的竞技场丢到弃牌区/, act:'discard_stadium', p:()=>({}) },

  // ===== 牌库上方卡操作 =====
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]?从其中选择任意数量的物品卡[，,]?将其丢弃[。.]将剩余卡放回牌库并重洗/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'discard_matching',filter:'物品',allowFewer:true,allowEmpty:true,remainder:'shuffle'}) },
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]?选择其中1张[，,]?放回牌库上方[。.]将剩余卡放回牌库下方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'choose_top_rest_bottom',keep:1}) },
  { re: /查看(自己|对手)(?:的)?牌库上方(\d+)张卡(?:牌)?[，,]?以任意顺序(?:重新)?排列[，,]?放回牌库上方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'top_any_order',keepOrder:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]?回复原样[。.]若希望[，,]?将那张卡丢弃/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'discard',optional:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]?回复原样[。.]若希望[，,]?将那张卡放回牌库下方/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'bottom',optional:true}) },
  { re: /查看(自己|对手)的牌库上方1张卡[，,]?回复原样[。.]若希望[，,]?重洗那个牌库/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:1,mode:'look_then_optional',optionalAction:'shuffle',optional:true}) },
  { re: /查看(自己|对手)的牌库上方(\d+)张卡[，,]?回复原样/, act:'manipulate_deck_top', p:m=>({target:m[1]==='对手'?'opponent':'self',count:+m[2],mode:'look',remainder:'top_original'}) },
  { re: /将对手的牌库上方1张卡(?!丢弃)/, act:'manipulate_deck_top', p:()=>({target:'opponent',count:1,mode:'look'}) },


  // 自己手牌全部放回牌库并重洗后抽 N（置于部件规则前，避免被洗牌/抽牌拆散）
  { re: /将(?:自己的|自己)?手牌全部放回牌库并且重洗牌库。然后，从牌库(?:上方)?抽取(\d+)张卡牌/, act:'shuffle_hand_to_deck', p:m=>({who:'self',draw_count:+m[1]}) },
  { re: /将(?:自己的|自己)?手牌全部放回牌库并且重洗牌库。然后，从牌库(?:上方)?抽出(\d+)张卡/, act:'shuffle_hand_to_deck', p:m=>({who:'self',draw_count:+m[1]}) },
  // ===== 重洗牌库 =====
  { re: /并且重洗牌库/, act:'shuffle_deck', p:()=>({}) },
  { re: /重洗牌库/, act:'shuffle_deck', p:()=>({}) },

  // ===== 放逐区 =====
  { re: /放置于放逐区/, act:'lost_zone', p:()=>({}) },

  // ===== 化石放置 =====
  { re: /作为HP(?:为)?(\d+)的/, act:'fossil_place', p:m=>({hp:+m[1]}) },
  { re: /(?:被视作|被视为|视作)(\d+)个所有属性/, act:'energy_provides', p:m=>({types:['any'],count:+m[1]}) },
  { re: /(?:被视作|被视为|视作)(\d+)个【(.+?)】能量/, act:'energy_provides', p:m=>({types:[ELEM[m[2]]||m[2]],count:+m[1]}) },

  // ===== 消除能量费用 =====
  { re: /将这只宝可梦使用招式所需的能量全部消除/, act:'energy_cost_eliminate', p:()=>({target:'self'}) },

  // ===== P1 高频未命中补充（2026-09，简中归一化后措辞基准）=====
  // --- 能量丢弃（自身/对手/全场，措辞变体 + 逗号）---
  { re: /将这只宝可梦身上附着的能量[，,]?全部(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /将这只宝可梦身上附着(?:的|着)(?:所有|全部)?能量(?:卡)?[，,]?全部?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /选择附于对手(?:的)?战斗宝可梦身上的1个特殊能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:()=>({target:'opponent_active',count:1,filter:'特殊能量'}) },
  { re: /将对手所有宝可梦身上附着的特殊能量[，,]?全部(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:()=>({target:'opponent_field',count:'all',filter:'特殊能量'}) },
  { re: /选择附于对手战斗宝可梦身上附着的(\d+)个(?:【.+?】|特殊)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'opponent',count:+m[1]}) },
  { re: /选择附于对手战斗宝可梦身上的(\d+)个(?:【.+?】|特殊)?能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'opponent',count:+m[1]}) },
  // --- 能量转附 ---
  { re: /选择附于这只宝可梦身上的(\d+)个能量[，,]?转附于备战宝可梦身上/, act:'move_energy', p:m=>({source:'self',dest:'bench',count:+m[1]}) },
  { re: /将附于这只宝可梦身上的(\d+)个能量[，,]?转附于备战宝可梦身上/, act:'move_energy', p:m=>({source:'self',dest:'bench',count:+m[1]}) },
  { re: /(?:选择|将)附于自己场上宝可梦身上的1个基本能量[，,]?转附于自己其他宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /(?:选择|将)自己场上宝可梦身上附着的1个基本能量[，,]?转附于自己其他宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /选择附于自己场上宝可梦身上的任意数量的能量[，,]?以任意方式转附于自己的宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:'all'}) },
  // --- 伤害指示物转放 ---
  { re: /选择放置于自己战斗宝可梦身上的最多(\d+)个伤害指示物[，,]?转放置于对手的战斗宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_active',count:+m[1],source:'self_active'}) },
  // --- 备战区放置伤害指示物 ---
  { re: /给对手的1只备战宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_bench',count:+m[1]}) },
  { re: /给对手的(\d+)只备战宝可梦身上[，,]?各放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_bench_N',count:+m[1],per:+m[2]}) },
  { re: /给双方所有拥有特性的宝可梦（除[^）]*外）身上[，,]?各放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'both_ability_field',count:+m[1]}) },
  // --- 自方备战伤害（地震类）---
  { re: /给自己的所有备战宝可梦[，,]?也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'self_all',damage:+m[1]}) },
  // --- 回复 HP（选择/战斗宝可梦目标变体）---
  { re: /恢复自己1只宝可梦["“”]?(\d+)["“”]?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /恢复自己的战斗宝可梦["“”]?(\d+)["“”]?(?:点)?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /将这只宝可梦的特殊状态[，,]?全部恢复/, act:'heal_status', p:()=>({target:'self'}) },
  // --- 抽牌至 N 张（若希望，可…）---
  { re: /若希望，可从牌库抽出卡牌[，,]?直到自己的手牌(?:数量)?变为(\d+)张(?:为止)?/, act:'draw_until', p:m=>({target:+m[1]}) },
  // --- 条件伤害 ×N（各计数源）---
  { re: /造成对手已经获得的奖赏卡(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_prizes_taken',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)双方战斗宝可梦身上附着的能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'both_active_energy_count',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)自己备战宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_bench_count',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)对手的备战宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_bench_count',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)自己备战宝可梦的属性种类数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_bench_type_count',mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己弃牌区中拥有招式["“”]([^"“”]+)["“”]的宝可梦的?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_discard_move_count',moveName:m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己备战区中拥有招式["“”]([^"“”]+)["“”]的宝可梦(?:的)?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_bench_move_count',moveName:m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己弃牌区中【(.+?)】宝可梦的?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_discard_type_count',energyType:m[1],mode:'per_unit'}) },
  { re: /这个招式的伤害，会被减少相当于(?:放置于)?这只宝可梦身上(?:放置的)?伤害指示物的数量[×x](\d+)伤害的数值/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'reduce'}) },
  { re: /这个招式的伤害，会被减少相当于这只宝可梦身上放置的伤害指示物数量[×x](\d+)的数值/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'reduce'}) },
  // --- 招式封锁（下回合目标无法使用招式/无法出物品）---
  { re: /在下个对手的回合[，,]?受到这个招式影响的(?:【基础】|进化)?宝可梦[，,]?无法使用招式/, act:'cannot_attack_next', p:()=>({target:'opponent'}) },
  { re: /在下个对手的回合[，,]?对手无法从手牌使出物品/, act:'play_restriction', p:()=>({target:'opponent',what:'item',duration:'next_opp_turn'}) },
  // --- 下回合招式伤害降低 ---
  { re: /在下个对手的回合[，,]?受到这个招式影响的宝可梦所使用的?招式(?:的)?伤害["“”]?([+-]?\d+)["“”]?/, act:'damage_reduction_next', p:m=>({amount:Math.abs(+m[1]),duration:'next_opp_turn'}) },
  // --- 招式继承/模仿（特性或招式；执行近似）---
  { re: /自己所有已经进化的宝可梦，可使用其所有进化前拥有的招式/, act:'usage_condition', p:()=>({kind:'evolve_move_inherit',raw:'自己所有已经进化的宝可梦，可使用其所有进化前拥有的招式'}) },
  { re: /选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用/, act:'usage_condition', p:()=>({kind:'move_copy',raw:'选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用'}) },
  // --- GX/VSTAR 使用限制说明 ---
  { re: /\[对战中，己方的GX招式只能使用1次。\]/, act:'usage_condition', p:()=>({kind:'gx_once_per_game',raw:'[对战中，己方的GX招式只能使用1次。]'}) },
  { re: /\[对战中，己方的VSTAR招式只能使用1次。\]/, act:'usage_condition', p:()=>({kind:'vstar_once_per_game',raw:'[对战中，己方的VSTAR招式只能使用1次。]'}) },
  // --- 神奇糖果变体（进行进化，无“跳过”字样）---
  { re: /将自己手牌中的1张【2阶进化】宝可梦[，,]?放置于自己场上1只能够进化成该宝可梦的【基础】宝可梦身上进行进化/, act:'evolve_rare_candy', p:()=>({stage:'2阶',targetStage:'基础',bypassStage:'1阶',noPlacedThisTurn:true,noFirstTurn:true}) },

  // ===== P2 高频未命中补充（2026-09）=====
  // --- 拥有招式名的弃牌区/备战区/牌库计数 ×N（补逗号断句变体）---
  { re: /(?:造成|追加造成)自己弃牌区中[，,]?拥有招式["“”]([^"“”]+)["“”]的宝可梦的?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_discard_move_count',moveName:m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己备战区中[，,]?拥有招式["“”]([^"“”]+)["“”]的宝可梦(?:的)?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_bench_move_count',moveName:m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己弃牌区中[，,]?【(.+?)】宝可梦的?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'own_discard_type_count',energyType:m[1],mode:'per_unit'}) },
  // --- 放置伤害指示物（带逗号）---
  { re: /将(\d+)个伤害指示物[，,]?以任意方式放置于对手的宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_any',count:+m[1]}) },
  { re: /将(\d+)个伤害指示物[，,]?以任意方式放置于对手的备战宝可梦身上/, act:'damage_place', p:m=>({target:'opponent_bench',count:+m[1]}) },
  // --- 自陷状态（使/令这只宝可梦陷入【X】状态）---
  { re: /(?:使|令)这只宝可梦陷入【(.+?)】状态/, act:'inflict_status_self', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /使对手的战斗宝可梦陷入【(.+?)】和【(.+?)】和【(.+?)】状态/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1],STATUS_MAP[m[2]]||m[2],STATUS_MAP[m[3]]||m[3]]}) },
  // --- 宝可梦回手（弗图博士类：附加卡丢弃）---
  { re: /选择自己场上的1只宝可梦[，,]?放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:false}) },
  // --- 被动伤害加成（针对特定规则宝可梦：宝可梦V / GX・EX）---
  { re: /身上放有这张卡的宝可梦所使用的招式[，,]?给对手战斗场上的["“”]([^"“”]+)["“”]造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[2],defenderRule:m[1]}) },
  { re: /身上放有这张卡的宝可梦所使用的招式[，,]?给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[1]}) },
  // --- 双方手牌反面朝上回牌库+按奖赏抽卡（奇树）---
  { re: /双方玩家，各将自己所有的手牌反面朝上重洗，放回牌库下方。然后，各从牌库(?:上方)?抽出与自己剩余奖赏卡(?:张数|数量)相同数量的卡牌/, act:'shuffle_hand_to_deck', p:()=>({who:'both',draw_by_prizes:true}) },
  // --- 自伤量回血（卡比兽V吞下：恢复 = 造成的伤害）---
  { re: /恢复这只宝可梦与给对手战斗宝可梦造成的伤害相同数值的HP/, act:'heal', p:()=>({amount:'as_attack_damage'}) },
  // --- 招式名封锁（莫鲁贝可：前半选择+后半无法使用）---
  { re: /选择1个对手战斗宝可梦所拥有的招式/, act:'usage_condition', p:()=>({kind:'select_opponent_move',raw:'选择1个对手战斗宝可梦所拥有的招式'}) },
  // --- 本回合招式伤害提升（回合内特定条件 +120 等无前缀追加形式）---
  { re: /造成这只宝可梦身上放置的伤害指示物数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'self_damage_counters',mode:'per_unit'}) },
  // --- 招式费用随对手奖赏减少（月月熊ex 血月）---
  { re: /这只宝可梦使用["“”]([^"“”]+)["“”]所需能量会减少与对手已经获得的奖赏卡(?:张数|数量)相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_prizes_taken'}) },

  // ===== P3 高频未命中补充（2026-09）=====
  // --- 回忆胶囊条件特性消除（伊布系列）---
  { re: /双方场上(?:【(.+?)】)?宝可梦的特性[，,]?全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  // --- 回合末昏厥（下个对手回合结束时）---
  { re: /在下个对手的回合结束时[，,]?受到这个招式影响的宝可梦会【昏厥】/, act:'usage_condition', p:m=>trainerPrerequisite('ko_next_opp_end', m[0]) },
  // --- 奖赏卡互换（格拉吉欧类：任意1张与训练家换）---
  { re: /查看所有反面朝上的自己的奖赏卡[，,]?将其中1张卡，与这张["“”]([^"“”]+)["“”]互换后，加入手牌/, act:'prize_basic_pokemon_to_hand_exchange_trainer', p:()=>({count:1}) },
  // --- 有伤害指示物的对手宝可梦直接受伤害 ---
  { re: /给身上放置有伤害指示物的1只对手的宝可梦[，,]?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[1]}) },
  // --- 手牌能量附于战斗宝可梦（坂木后半句）---
  { re: /选择自己手牌中的1张能量[，,]?附于战斗宝可梦身上/, act:'attach_energy_from_hand', p:()=>({filter:'能量',target:'active'}) },
  // --- 对手能量回手（坂木前半句）---
  { re: /选择对手战斗宝可梦身上附着的1个能量[，,]?放回对手的手牌/, act:'return_energy_to_hand', p:()=>({count:1}) },
  // --- 道具效果消除（阻碍之塔）---
  { re: /双方所有宝可梦身上放有的["“”]?宝可梦道具["“”]?的效果[，,]?全部消除/, act:'tool_effect_nullify', p:()=>({scope:'both_field'}) },
  // --- 给攻击者放指示物（复仇拳箱）---
  { re: /给使用了招式的宝可梦身上[，,]?放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'attacker',count:+m[1]}) },
  // --- 工具载体能量转附（学习装置 trigger inner）---
  { re: /可选择?该战斗宝可梦身上附着的1张基本能量[，,]?转附于身上放有这张卡的宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /可选择(?:附着于|附于)该战斗宝可梦身上的1张基本能量[，,]?转附于身上放有这张卡的宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  // --- 双属性能量（被视作N个A/B两属性）---
  { re: /被视作(\d+)个【(.+?)】【(.+?)】2种属性的能量/, act:'energy_provides', p:m=>({types:[ELEM[m[2]]||m[2],ELEM[m[3]]||m[3]],count:+m[1]}) },
  // --- 附着限制（一击/连击能量：只能附着于X，否则丢弃）---
  { re: /这张卡只能附着于["“”]([^"“”]+)["“”]宝可梦身上[^。]*如果这张卡附着于["“”]([^"“”]+)["“”]之外的宝可梦身上的话，则将其(?:放于弃牌区|丢到弃牌区)/, act:'usage_condition', p:m=>({kind:'attach_only_rule',only:m[1],raw:m[0]}) },
  // --- 一击能量伤害加成（身上附有这张卡的宝可梦伤害+20）---
  { re: /身上附有这张卡的宝可梦使用的招式，给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[1]}) },
  // --- 下个自己回合招式伤害提升 ---
  { re: /在下个自己的回合[，,]?这只宝可梦所使用的招式[，,]?给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'damage_boost_next_self', p:m=>({amount:+m[1]}) },
  { re: /在下个自己的回合[，,]?这只宝可梦使用的["“”]([^"“”]+)["“”]的伤害["“”]([+-]?\d+)["“”]/, act:'damage_boost_next_self', p:m=>({amount:+m[2]}) },
  // --- 回合内对 ex 增伤（空手道王的修炼）---
  { re: /在这个回合[，,]?自己宝可梦所使用的招式[，,]?给对手战斗场上的["“”]([^"“”]+)["“”]造成的伤害["“”]([+-]?\d+)["“”]/, act:'turn_damage_mod', p:m=>({target:'own_field',amount:+m[2],defender:'opponent_active',defenderRule:m[1],duration:'turn'}) },
  // --- 回合内使出特定支援者后加伤（亲密波动）---
  { re: /在这个回合[，,]?若从手牌使出了["“”]([^"“”]+)["“”]的支援者[，,]?则(?:追加造成|增加)(\d+)伤害/, act:'conditional_damage_mod', p:m=>({condition:'supporter_used_this_turn',amount:+m[2],mode:'fixed'}) },
  // --- 弃牌区道具数条件攻能消除（加热洛托姆）---
  { re: /若自己的弃牌区中有(\d+)张以上（包含\d+张）["“”]([^"“”]+)["“”][，,]?则这只宝可梦使用招式所需能量，全部消除/, act:'conditional_effect', p:m=>({condition:'own_discard_items_gte',count:+m[1],effect:{action:'energy_cost_eliminate',params:{target:'self'}}}) },
  // --- 弃牌区回收组合过滤（支援者和竞技场共计N张，露莎米奈）---
  { re: /从自己的弃牌区中选择(.+?)共计(\d+)张[，,]?在给对手看过后，加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[1].trim(),target:'hand'},m[2],false) },

  // ===== P3b（2026-09）：措辞词序变体 + 特性组合 =====
  // --- 备战区全体伤害（“对手所有的”词序变体 + 无“点”措辞）---
  { re: /给(?:对手|自己)所有的备战宝可梦[，,]?也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:m[0].includes('对手')?'opponent_all':'self_all',damage:+m[1]}) },
  { re: /给(?:对手|自己)的?所有备战宝可梦[，,]?也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:m[0].includes('对手')?'opponent_all':'self_all',damage:+m[1]}) },
  // --- 给双方带指示物的备战区伤害（极罕见，近似双方备战）---
  { re: /给身上放置有伤害指示物的双方的所有备战宝可梦[，,]?也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'both_bench',damage:+m[1]}) },
  // --- 对手 active 能量转附对手备战（梦妖魔等）---
  { re: /选择对手战斗宝可梦身上附着的1个能量[，,]?转附于对手的备战宝可梦身上/, act:'move_energy', p:()=>({source:'opponent_active',dest:'opponent_bench',count:1}) },
  { re: /选择对手战斗宝可梦身上附着的1个能量[，,]?转附于对手的1只备战宝可梦身上/, act:'move_energy', p:()=>({source:'opponent_active',dest:'opponent_bench',count:1}) },
  // --- 特性：使用后自昏厥（三合一磁怪等）---
  { re: /若使用了，则令这只宝可梦【昏厥】/, act:'knockout', p:()=>({target:'self'}) },
  // --- 弃牌区基本能量附特定属性宝可梦（多张任意）---
  { re: /从自己的弃牌区选择最多(\d+)张基本能量[，,]?以任意方式附于自己的【(.+?)】宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:'基本能量',target:'any',targetType:ELEM[m[2]]||m[2]},m[1],true) },
  // --- 吼鲸王类：恢复所有特殊状态（每当附能时）---
  { re: /恢复这只宝可梦的所有特殊状态/, act:'heal_status', p:()=>({target:'self'}) },
  // --- 手牌附能备战（彼特：无“自己的”）---
  { re: /选择自己手牌中的1张基本能量[，,]?附于备战宝可梦身上/, act:'attach_energy_from_hand', p:()=>({filter:'基本能量',target:'bench'}) },
  // --- 对手场上任一宝可梦能量回手（呐喊队）---
  { re: /选择(?:附于|附着于)对手场上宝可梦身上的1个能量[，,]?放回对手的手牌/, act:'return_energy_to_hand', p:()=>({count:1}) },
  // --- 回合内宝可梦伤害+N（丹帝等，无“所”变体）---
  { re: /在这个回合[，,]?自己的宝可梦使用的招式[，,]?给对手的战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'turn_damage_mod', p:m=>({target:'own_field',amount:+m[1],defender:'opponent_active',duration:'turn'}) },
  { re: /在这个回合[，,]?自己的宝可梦所使用的招式[，,]?给对手的战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'turn_damage_mod', p:m=>({target:'own_field',amount:+m[1],defender:'opponent_active',duration:'turn'}) },
  // --- 弃牌区基本能量回手（能量回收：将…弃牌区中的…）---
  { re: /将(?:自己的|自己)?弃牌区中的(\d+)张(.+?)，在给对手看过后，加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:m[2].trim(),target:'hand'},m[1],false) },
  // --- 弃牌区回收直接版（在给对手看过之后→看过后已归一）---
  { re: /选择自己弃牌区中的1张【基础】宝可梦，与自己场上的1只【基础】宝可梦互换/, act:'usage_condition', p:m=>trainerPrerequisite('swap_discard_basic_with_field', m[0]) },
  // --- 手牌弃置抽卡（亚洛：弃 N 张抽 2N）---
  { re: /将最多(\d+)张自己的手牌(?:放于弃牌区|丢到弃牌区)，从自己的牌库(?:上方)?抽出其(?:张数|数量)[×x](\d+)张卡/, act:'discard_hand_draw', p:m=>({maxDiscard:+m[1],drawMult:+m[2]}) },
  // --- 抽到指定相对手牌数（贝里菈：比对手多1）---
  { re: /从自己的牌库(?:上方)?抽出卡牌，直到自己的手牌(?:张数)?比对手的手牌(?:张数)?多(\d+)张为止/, act:'draw_until_opp_hand_plus', p:m=>({delta:+m[1]}) },

  // ===== P4（2026-09）：命中一段即 parsed 的批量覆盖 =====
  // --- 弃牌区能量附全场备战（贮存泥巴：各附着1张）---
  { re: /给自己所有的备战宝可梦[，,]?各附着1张弃牌区中的(.+?)。/, act:'attach_energy_from_discard', p:m=>withCount({filter:m[1].replace(/["“”]/g,'').trim(),target:'bench'},1,false) },
  // --- 搜索重排置顶（暗码迷/七夕青鸟族：metadata）---
  { re: /从自己的牌库选择任意(\d+)张卡。将剩余的牌库重洗，将选择的卡牌以任意顺序重新排列，放回牌库上方/, act:'usage_condition', p:m=>({kind:'search_rearrange_deck_top',count:+m[1],raw:m[0]}) },
  { re: /从自己的牌库选择1张支援者，给对手查看。将剩余的牌库重洗，并将选择的卡牌放回牌库上方/, act:'usage_condition', p:()=>({kind:'search_reveal_deck_top',raw:'从自己的牌库选择1张支援者给对手查看后放回牌库上方'}) },
  // --- 招式伤害无视对手附加效果（波荡水ex）---
  { re: /这只宝可梦所使用的招式的伤害[，,]?不计算对手战斗宝可梦身上所附加的效果/, act:'ignore', p:()=>({what:'opponent_effects'}) },
  // --- 回合内特型宝可梦伤害随对手奖赏加成（梨花信念：每张+20）---
  { re: /在这个回合[，,]?自己的["“”]([^"“”]+)["“”]宝可梦所使用的招式[，,]?给对手战斗宝可梦造成的伤害，会因为每张对手已经获得的奖赏卡而["“”]([+-]?\d+)["“”]/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'opponent_prizes_taken',mode:'per_unit'}) },
  // --- 训练家前言：只有将 N 张手牌丢弃才可使用 ---
  { re: /这张卡[，,]?只有将(?:自己的)?(\d+)张手牌丢(?:到弃牌区|弃)才可使用/, act:'trainer_prerequisite', p:m=>({kind:'discard_cost',raw:m[0],count:+m[1],zone:'hand'}) },
  { re: /这张卡，只有当自己的其他手牌的数量在(\d+)张以下（包含\d+张）时，才可使用/, act:'trainer_prerequisite', p:m=>({kind:'condition',raw:m[0]}) },
  { re: /这张卡，只有在对手的剩余奖赏卡张数为(\d+)张时才可使用/, act:'trainer_prerequisite', p:m=>({kind:'opponent_prizes_exact',raw:m[0],count:+m[1]}) },
  { re: /这张卡，只有在自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多时才可使用/, act:'trainer_prerequisite', p:m=>({kind:'own_prizes_more_than_opponent',raw:m[0]}) },
  // --- 抽卡元数据（与场上宝可梦数量相关，动态数量）---
  { re: /从自己的牌库抽出与对手(?:场上|备战)宝可梦数量相同(?:张数|数量)?的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('draw_matching_opponent_field_count', m[0]) },
  // --- 工具内层转附（学习装置变体：附于该战斗宝可梦 / 该宝可梦）---
  { re: /可选择附于该战斗宝可梦身上的1张基本能量[，,]?转附于身上放有这张卡的宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /可将附于该宝可梦身上的1张基本能量[，,]?转附于身上放有这张卡的宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /将附于这只宝可梦身上的最多(\d+)张基本能量，转附于自己的1只备战宝可梦身上/, act:'move_energy', p:m=>({source:'self',dest:'bench',count:+m[1]}) },
  // --- 退化（化石翼龙：metadata）---
  { re: /从对手的已经进化的战斗宝可梦身上，移除1张["“”]进化卡["“”]使其退化/, act:'usage_condition', p:m=>trainerPrerequisite('devolve_opponent_active', m[0]) },
  // --- 任意数量基本能量手牌附着 ---
  { re: /选择自己手牌中任意数量的基本能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:()=>({filter:'基本能量',target:'any',allowFewer:true,allowEmpty:true,maxCount:99}) },
  // --- 查看自己或对手牌库上方并重排（metadata）---
  { re: /查看自己或者对手牌库上方(\d+)张卡[，,]?以任意顺序重新排列，放回牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('look_reorder_deck_top', m[0]) },
  // --- 攻能随对手场上 V 数量减少（伽勒尔闪电鸟V：metadata/passive）---
  { re: /这只宝可梦使用招式所需能量会减少与对手场上["“”]([^"“”]+)["“”]的数量相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_field_rule_count'}) },
  // --- 白马蕾冠王VMAX：弃附能→张数×120 ---
  { re: /若希望，可选择附于这只宝可梦身上的最多(\d+)张能量，丢到弃牌区。在这种情况下，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],amountPer:+m[2]}) },
  // --- 多道具上限（乌鸦头头V：metadata）---
  { re: /这只宝可梦身上可以最多放(\d+)张["“”]宝可梦道具["“”]/, act:'usage_condition', p:m=>trainerPrerequisite('max_tools_per_pokemon', m[0]) },
  // --- 任意次数特性使用前缀 ---
  { re: /在自己的回合时可使用任意次。/, act:'usage_condition', p:()=>trainerPrerequisite('any_times_own_turn','在自己的回合时可使用任意次') },
  // --- 备战火能转战斗场 ---
  { re: /选择自己备战宝可梦身上附着的1个【(.+?)】能量[，,]?转附于战斗宝可梦身上/, act:'move_energy', p:m=>({source:'bench',dest:'active',count:1,filter:`【${m[1]}】能量`}) },
  // --- 带伤对手场特性消除（古鼎鹿ex：metadata/passive 近似）---
  { re: /对手场上的身上放置有伤害指示物的宝可梦（除宝可梦【ex】外）的特性，全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  // --- 太晶 KO 额外奖赏（白蕾雅后半）---
  { re: /若因为自己["“”]([^"“”]+)["“”]宝可梦所使用的招式的伤害，而导致对手战斗宝可梦【昏厥】了，则多拿取(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[2]}) },
  // --- 战斗场受击反弹（粗硬头盔类：后段规则）---
  { re: /选择附于使用了招式的宝可梦身上的1个能量[，,]?放回对手的手牌/, act:'return_energy_to_hand', p:()=>({count:1}) },
  // --- 道具全体回手（牡丹/黑连：含附加卡）---
  { re: /选择自己场上的1只【基础】宝可梦，将该宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  { re: /选择自己的身上放置有伤害指示物的1只【(.+?)】宝可梦，将被选择的宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  // --- 未来宝可梦道具（撤退费消除+伤害，命中一段即可）---
  { re: /身上放有这张卡的["“”]([^"“”]+)["“”]宝可梦，【撤退】所需能量全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  // --- 备战区攻击允许（胡地ex 维度之手：metadata）---
  { re: /这个招式，即使这只宝可梦在备战区也能使用/, act:'usage_condition', p:m=>trainerPrerequisite('attack_from_bench_allowed', m[0]) },
  // --- 回合开始抽到此卡入备战（metadata）---
  { re: /在自己的回合开始，从牌库抽出到这张卡时，若自己的备战区有空位[^。]*在将卡牌加入手牌前可使用1次。将这张卡放置于自己的备战区/, act:'usage_condition', p:m=>trainerPrerequisite('bench_self_on_draw', m[0]) },
  // --- 白蕾雅类前言（对手奖赏=2 恰当时）---
  { re: /这张卡，只有在对手的剩余奖赏卡张数为2张时才可使用/, act:'trainer_prerequisite', p:()=>({kind:'opponent_prizes_exact',raw:'对手剩余奖赏卡为2张',count:2}) },

  // ===== P5（2026-09）：counter 计数条件 + 更多命中段 =====
  // --- 备战→战斗场自换（铁斑叶ex等“与战斗宝可梦互换”）---
  { re: /将这只宝可梦与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  // --- 自身场上带伤宝可梦数×N ---
  { re: /造成自己场上身上放置有伤害指示物的宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_field_has_damage',mode:'per_unit'}) },
  // --- 自己场上/备战【属性】宝可梦数×N ---
  { re: /(?:造成|追加造成)自己场上【(.+?)】宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_field_pokemon_type',type:ELEM[m[1]]||m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己备战区【(.+?)】宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_bench_pokemon_type',type:ELEM[m[1]]||m[1],mode:'per_unit'}) },
  // --- 手牌张数×N ---
  { re: /(?:造成|追加造成)自己手牌(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'hand',mode:'per_unit'}) },
  // --- 弃牌区特定卡名数量×N ---
  { re: /(?:造成|追加造成)自己弃牌区中["“”]([^"“”]+)["“”]的(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'discard_name',name:m[1],mode:'per_unit'}) },
  // --- 弃牌区支援者数量×N（上限近似忽略）---
  { re: /(?:造成|追加造成)自己弃牌区支援者(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'discard_supporter',mode:'per_unit'}) },
  // --- 弃牌区【属性】能量张数×N ---
  { re: /(?:造成|追加造成)自己弃牌区中【(.+?)】能量(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'discard_energy_type',type:m[1],mode:'per_unit'}) },
  // --- 自己宝可梦道具数量×N ---
  { re: /(?:造成|追加造成)自己所有宝可梦身上放有的["“”]宝可梦道具["“”]数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_field_tool',mode:'per_unit'}) },
  // --- 附加基本能量属性种类数×N ---
  { re: /(?:追加造成|造成)附于这只宝可梦身上的基本能量的属性种类数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'self_basic_type_count',mode:'per_unit'}) },
  // --- 对手场 V/GX 数（用于攻费减免的计数注册在 attack_cost_reduction；这里无伤）---
  { re: /若希望，可选择自己手牌中的1张【(.+?)】能量[，,]?附于备战宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'bench'}) },
  { re: /将自己手牌中的1张能量[，,]?附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:()=>({filter:'能量',target:'any'}) },
  { re: /若希望，可将附于这只宝可梦身上的【(.+?)】或【(.+?)】属性中的1种属性的最多(\d+)张基本能量丢到弃牌区，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:'any',filter:`【${m[1]}】能量或【${m[2]}】能量`,amountPer:+m[4]}) },
  { re: /将附于这只宝可梦身上的【(.+?)】能量[，,]?全部(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:'all',filter:`【${m[1]}】能量`}) },
  { re: /将附于这只宝可梦身上的(\d+)个【(.+?)】能量[，,]?(?:放于弃牌区|丢到弃牌区)/, act:'discard_energy', p:m=>({target:'self',count:+m[1],filter:`【${m[2]}】能量`}) },
  { re: /将附于自己场上宝可梦身上最多(\d+)张【(.+?)】能量丢到弃牌区[，,]?造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:'any',filter:`【${m[2]}】能量`,amountPer:+m[3]}) },
  { re: /将附于这只宝可梦身上的基本【(.+?)】能量全部丢到弃牌区，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:'all',filter:`基本【${m[1]}】能量`,amountPer:+m[2]}) },
  // --- 对手竞技场丢弃 ---
  { re: /将场上对手的竞技场丢到弃牌区/, act:'discard_stadium', p:()=>({}) },
  // --- 下回合无法恢复HP / 不能附特能与放竞技场（限制类近似 metadata）---
  { re: /在下个对手的回合[，,]?受到这个招式影响的宝可梦，无法恢复HP/, act:'block_heal', p:()=>({target:'opponent_active',duration:'next_opp_turn'}) },
  { re: /在下个对手的回合，对手无法从手牌使出并附着["“”]特殊能量["“”]也无法放置["“”]竞技场["“”]/, act:'usage_condition', p:m=>trainerPrerequisite('block_special_energy_stadium_next', m[0]) },
  // --- 无竞技场时招式失败 ---
  { re: /若场上没有竞技场，则这个招式失败/, act:'conditional_effect', p:()=>({condition:'stadium_not_in_play',effect:{action:'attack_fail'}}) },
  // --- VSTAR 再回合 / GXEX 特性消除 / 特性限定场地（metadata）---
  { re: /当这个回合结束时，自己的回合会再开始1次/, act:'usage_condition', p:m=>trainerPrerequisite('extra_turn_vstar', m[0]) },
  { re: /就将对手场上、手牌中、弃牌区中的所有["“”]宝可梦GX・EX["“”]的特性（除["“”]([^"“”]+)["“”]外），全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /这个特性只有当自己场上所有的宝可梦都是【(.+?)】属性的场合才生效/, act:'usage_condition', p:m=>trainerPrerequisite('type_mono_ability', m[0]) },
  { re: /这只宝可梦，在自己的回合，可以从手牌使出从["“”]伊布["“”]进化而来的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('eevee_evolve_anytime', m[0]) },
  { re: /这只宝可梦，当对手从手牌使出物品或者支援者时，不受其效果影响/, act:'prevent_effect', p:()=>({source:'trainer'}) },

  // ===== P6（2026-09）：被动伤害/道具/场地/训练家杂项 =====
  // --- 工具受击减伤（身上放有这张卡的宝可梦受到招式伤害-N）---
  { re: /身上放有这张卡的(?:【[^】]+】)?宝可梦(?:（[^）]*）)?，?受到对手(?:的)?宝可梦(?:的|所)使用的?招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /身上放有这张卡的宝可梦(?:（[^）]*）)?，?受到对手的["“”]([^"“”]+)["“”]的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'self'}) },
  { re: /身上放有这张卡的(?:【[^】]+】)?宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /身上放有这张卡的【(.+?)】宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'self'}) },
  // --- 自己/双方全场受击减伤（属性/规则限定，宽松）---
  { re: /自己所有的备战宝可梦，不会因为对手的【基础】宝可梦所使用的招式的效果，而被放置伤害指示物/, act:'bench_attack_shield', p:()=>({target:'own_bench',source:'opponent_attack',preventDamage:false,preventEffect:true}) },
  { re: /(?:自己的所有|自己的)["“”]([^"“”]+)["“”]宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'own_field'}) },
  { re: /双方(?:的)?【(.+?)】或【(.+?)】属性的【基础】宝可梦，所受到的对手宝可梦招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[3],target:'own_field'}) },
  { re: /自己所有(?:的)?["“”]([^"“”]+)["“”]宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'own_field'}) },
  { re: /自己所有的备战宝可梦，不会因为对手的【基础】宝可梦所使用的招式的效果，而被放置伤害指示物/, act:'bench_attack_shield', p:()=>({target:'own_bench',source:'opponent_attack',preventDamage:false,preventEffect:true}) },
  // --- 攻击加成（规则限定宝可梦招式+伤害，宽松 own_field）---
  { re: /自己的["“”]([^"“”]+)["“”]宝可梦（除["“”]([^"“”]+)["“”]外）所使用的招式，给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[3]}) },
  { re: /自己【(.+?)】属性的【基础】宝可梦（除["“”]([^"“”]+)["“”]外）使用的招式，给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[3]}) },
  // --- 场地卡效果（数量上限/伤害修正 metadata 或近似）---
  { re: /双方玩家可以放置于备战区的宝可梦数量，变为(\d+)只/, act:'usage_condition', p:m=>trainerPrerequisite('bench_limit', m[0]) },
  { re: /自己场上有["“”]([^"“”]+)["“”]宝可梦的玩家，可以放置于备战区的宝可梦数量变为(\d+)只/, act:'usage_condition', p:m=>trainerPrerequisite('bench_limit_cond', m[0]) },
  // --- 各类 HP 恢复（进化/属性/剩余HP/全体/双方）---
  { re: /将自己所有进化宝可梦的HP，全部恢复/, act:'heal_all', p:()=>({amount:'full'}) },
  { re: /恢复自己1只身上附着【(.+?)】能量的宝可梦["“”]([+-]?\d+)["“”]HP/, act:'heal', p:m=>({amount:+m[2]}) },
  { re: /将身上附着【(.+?)】能量的所有自己的宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]/, act:'heal_all', p:m=>({amount:+m[2]}) },
  { re: /将自己的1只剩余HP在["“”]?([+-]?\d+)["“”]?及以下的宝可梦的HP，全部恢复/, act:'heal', p:m=>({amount:'full'}) },
  { re: /恢复自己所有宝可梦的HP各["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[1]}) },
  { re: /将双方所有宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[1]}) },
  { re: /将身上附着【(.+?)】或【(.+?)】或【(.+?)】属性的所有自己的宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[4]}) },
  // --- 己方宝可梦/备战伤害（选1只）---
  { re: /给自己的1只备战宝可梦[，,]?(?:也)?各?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'self_1',damage:+m[1],zone:'bench'}) },
  { re: /给自己的1只宝可梦[，,]?(?:也)?各?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'self_1',damage:+m[1]}) },
  // --- 对手备战特定规则宝可梦受伤 ---
  { re: /给对手备战区的1只["“”]([^"“”]+)["“”]，也造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_1',damage:+m[2]}) },
  { re: /给对手的1只["“”]([^"“”]+)["“”]，造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[2]}) },
  { re: /给对手的2只宝可梦，各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:2,damage:+m[1]}) },
  // --- 能量转附（备战→自己 / 全部→备战 / 基本能量）---
  { re: /将附于自己备战宝可梦身上任意数量的能量，转附于这只宝可梦身上/, act:'move_energy', p:()=>({source:'bench',dest:'active',count:'all'}) },
  { re: /将所有附于这只宝可梦身上的能量，以任意方式转附于备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:'all'}) },
  { re: /选择附于这只宝可梦身上的1个基本能量，转附于备战宝可梦身上/, act:'move_energy', p:()=>({source:'self',dest:'bench',count:1}) },
  { re: /选择自己手牌中的1张基本能量，附于这只宝可梦身上/, act:'attach_energy_from_hand', p:()=>({filter:'基本能量',target:'active'}) },
  { re: /若希望，可将自己手牌中最多(\d+)张【(.+?)】能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],true) },
  { re: /若希望，可选择自己手牌中的1张【(.+?)】能量，附于备战宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'bench'}) },
  // --- 对手特殊能量 1 个弃置 / 放回 ---
  { re: /将附于对手场上宝可梦身上的1个特殊能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_field',count:1,filter:'特殊能量'}) },
  { re: /将附于对手(?:的)?场上宝可梦身上的1个特殊能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_field',count:1,filter:'特殊能量'}) },
  { re: /选择附于对手场上宝可梦身上的1个特殊能量，放回对手的牌库下方/, act:'usage_condition', p:m=>trainerPrerequisite('special_energy_to_opp_deck_bottom', m[0]) },
  { re: /选择对手战斗宝可梦身上附着的1个能量，放回对手的牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('energy_to_opp_deck_top', m[0]) },
  // --- 换位（备战区中选 1 只…）---
  { re: /选择对手备战区中的1只[^。]*宝可梦，将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /选择(?:自己的|自己)备战区中的1只[^。]*宝可梦，将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /选择1只对手的备战宝可梦，将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  // --- 手牌回手特殊（带伤宝可梦带附加回手）---
  { re: /将1只身上放置有伤害指示物的自己的宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回手牌/, act:'return_to_hand', p:()=>({target:'choose',with_attachments:true}) },
  // --- 道具/场地类（上限、撤退等 metadata/半近似）---
  { re: /身上放有这张卡的(?:【[^】]+】)?宝可梦，【撤退】所需能量全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /身上放有这张卡的宝可梦【撤退】时，其【撤退】所需能量不会被丢到弃牌区，而是会被放回手牌/, act:'usage_condition', p:m=>trainerPrerequisite('retreat_energy_to_hand', m[0]) },
  { re: /若自己的剩余奖赏卡张数，比对手多，则放有这张卡的宝可梦使用招式所需能量，减少(\d+)个【(.+?)】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:1}) },
  { re: /身上放有这张卡的(?:【[^】]+】)?宝可梦，最大HP["“”]\+?([+-]?\d+)["“”]/, act:'max_hp_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /身上放有这张卡的["“”]([^"“”]+)["“”]宝可梦，最大HP["“”]\+?([+-]?\d+)["“”]，那只宝可梦，不会陷入特殊状态/, act:'max_hp_mod', p:m=>({amount:+m[2],target:'self'}) },
  { re: /不会陷入特殊状态，已经处于的特殊状态，也全部恢复/, act:'heal_status', p:()=>({target:'self'}) },
  // --- 各种 ×N 计数伤害（counter）---
  { re: /(?:造成|追加造成)自己场上宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_field_pokemon_count',mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己已经获得的奖赏卡(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_prizes_taken',mode:'per_unit'}) },
  { re: /(?:造成|追加造成)对手手牌(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'opponent_hand',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)对手场上["“”]([^"“”]+)["“”]数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'opponent_field_rule',rule:m[1],mode:'per_unit'}) },
  { re: /造成自己场上宝可梦身上附着的【(.+?)】和【(.+?)】属性的基本能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[3],condition:'counter',counter:'own_field_basic_energy_types',typeA:m[1],typeB:m[2],mode:'per_unit'}) },
  // --- 若能量数相同则增伤（同步重锤等）---
  { re: /若这只宝可梦身上附着的能量数量与对手战斗宝可梦身上附着的能量数量相同，则增加(\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'own_energy_eq_opponent',mode:'fixed'}) },
  // --- 场地竞技场/牌库/硬币/metadata 杂项 ---
  { re: /若使用了这个招式，则这只宝可梦，在离开战斗场之前无法使用["“”]([^"“”]+)["“”]/, act:'usage_condition', p:m=>trainerPrerequisite('move_lock_after_use', m[0]) },
  { re: /当这只宝可梦的HP为全满的状态下，这只宝可梦受到招式的伤害而【昏厥】时，这只宝可梦不会【昏厥】，而是以剩余HP为["“”]10["“”]的状态留在场上/, act:'usage_condition', p:m=>trainerPrerequisite('endure_at_10_when_full', m[0]) },
  { re: /掷硬币直到出现反面，从自己的牌库抽出与出现正面次数相同数量的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('coin_draw_till_tails', m[0]) },
  { re: /掷与这只宝可梦身上附着的能量数量相同次数的硬币，造成正面次数[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('coin_per_energy_damage', m[0]) },
  { re: /将对手已经获得的奖赏卡张数[×x]\d+个伤害指示物，放置于对手的战斗宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('counters_by_opp_prizes', m[0]) },
  { re: /在对手的1只宝可梦身上放置伤害指示物，直到其剩余HP变为["“”]?\d+["“”]?点为止/, act:'usage_condition', p:m=>trainerPrerequisite('counters_until_100hp', m[0]) },
  { re: /在下个对手的回合，无法从手牌将能量附于受到这个招式影响的宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('block_attach_energy_next', m[0]) },
  { re: /在造成伤害前，将任意数量的(?:放置|放)于自己场上宝可梦身上的["“”]宝可梦道具["“”]丢到弃牌区，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('discard_tools_for_damage', m[0]) },
  { re: /给这只宝可梦身上放置最多(\d+)个伤害指示物，造成放置的伤害指示物数量[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('self_counters_damage', m[0]) },
  { re: /将自己手牌中任意数量的["“”]([^"“”]+)["“”]丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('discard_kind_hand_for_damage', m[0]) },
  { re: /用这个招式时，若自己的剩余奖赏卡张数为(\d+)张，则这场对战算作自己的胜利/, act:'usage_condition', p:m=>trainerPrerequisite('instant_win_at_prize', m[0]) },
  { re: /在上个对手的回合，若自己的宝可梦(?:【昏厥】了)?[^。]*则这只宝可梦[^。]*招式的伤害，全部消除/, act:'usage_condition', p:m=>trainerPrerequisite('energy_cost_zero_cond', m[0]) },

  // ===== P7（2026-09）：长尾第 2 批 =====
  // --- 查看牌库顶选 1 余弃 / 场地清扫 ---
  { re: /查看自己的牌库上方(\d+)张卡，将其中1张加入手牌。将剩余的卡牌丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('peek_keep_discard_rest', m[0]) },
  { re: /将场上最多(\d+)张["“”]宝可梦道具["“”]或["“”]竞技场["“”]，丢到弃牌区/, act:'discard_field_attachments', p:m=>({target:'any',tools:true,stadium:true,maxCount:+m[1],optional:true}) },
  // --- 训练家整段特殊效果（近似 metadata）---
  { re: /选择自己任意数量的手牌，以任意顺序重新排列，放回牌库下方。然后，从牌库抽出与放回牌库的卡牌数量相同张数的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('hand_to_bottom_draw_same', m[0]) },
  { re: /选择最多(\d+)张自己的奖赏卡，加入手牌。然后，选择与加入手牌张数相同张数的手牌，反面朝上作为奖赏卡放置/, act:'usage_condition', p:m=>trainerPrerequisite('prize_hand_swap', m[0]) },
  { re: /从自己的弃牌区选择1张【基础】宝可梦，与自己场上的1只【基础】宝可梦互换（继承所有(?:放置|放)于其身上的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('swap_discard_base_with_field_base', m[0]) },
  { re: /从自己的弃牌区选择，1张名字中带有["“”]([^"“”]+)["“”]的["“”]宝可梦【ex】["“”]，与自己场上的，1只名字中带有["“”]([^"“”]+)["“”]的["“”]宝可梦【ex】["“”]互换（继承所有(?:放置|放)于其身上的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('swap_discard_ex_with_field', m[0]) },
  { re: /从自己的牌库选择任意(\d+)张卡。将剩余的牌库重洗，并将选择的卡牌以任意顺序重新排列，放回牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('search_rearrange_deck_top2', m[0]) },
  { re: /从自己的手牌将最多(\d+)张宝可梦（["“”]([^"“”]+)["“”]除外）丢到弃牌区，然后从自己的牌库抽出丢到弃牌区卡牌张数[×x](\d+)张卡/, act:'usage_condition', p:m=>trainerPrerequisite('discard_pokemon_draw_x', m[0]) },
  { re: /将对手场上1只宝可梦身上放置的最多(\d+)个伤害指示物，转放置于对手1只其他宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_counters_opp', m[0]) },
  { re: /使用了这张卡的回合结束时，从自己的牌库抽出卡牌，直到自己的手牌张数为(\d+)张为止/, act:'usage_condition', p:m=>trainerPrerequisite('end_turn_draw_until', m[0]) },
  { re: /选择对手所有宝可梦身上附着的特殊能量各1个，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_opp_special_each', m[0]) },
  { re: /选择自己场上1只宝可梦身上附着的最多(\d+)个能量，转附于自己的1只其他宝可梦身上/, act:'move_energy', p:m=>({source:'self',dest:'bench',count:+m[1]}) },
  // --- 天气/场地特殊 ---
  { re: /双方的身上附着基本【斗】能量的宝可梦（除["“”]究极异兽["“”]外）使用的招式，给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]，若自己的剩余奖赏卡张数，比对手多，则变为["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[1]}) },
  // --- 触发式反伤/计数/metadata ---
  { re: /在下个对手的回合，当这只宝可梦受到招式的伤害时，将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('mirror_damage_counters', m[0]) },
  { re: /将与自己弃牌区中的宝可梦张数相同数量的伤害指示物，放置于对手的战斗宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('counters_by_discard_pokemon', m[0]) },
  { re: /若这只宝可梦身上附着有(?:【(.+?)】)?能量，则这只宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /(?:对手场上的)?【基础】宝可梦（除["“”]([^"“”]+)["“”]外）的特性，全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /选择自己备战区中最多(\d+)只["“”]([^"“”]+)["“”]宝可梦，各附着1张自己弃牌区中的能量/, act:'attach_energy_from_discard', p:m=>withCount({filter:'能量',target:'bench'},m[1],true) },
  { re: /(?:造成|追加造成)自己场上["“”]([^"“”]+)["“”]宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_field_pokemon_count',mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己备战区中附着了【(.+?)】能量的宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_bench_energy_type_count',type:m[1],mode:'per_unit'}) },
  { re: /(?:造成|追加造成)自己放逐区中宝可梦（除◇（棱镜之星）外）的(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_lost_zone_pokemon',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)对手场上拥有特性的宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'opponent_field_ability_count',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)对手所有宝可梦身上附着的能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'opponent_field_energy',mode:'per_unit'}) },
  { re: /(?:追加造成|造成)自己所有宝可梦身上附着的【(.+?)】能量数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_field_energy_type_count',type:m[1],mode:'per_unit'}) },
  // --- 追加伤害 = 上回合受到伤害（闪焰王牌 双倍奉还）---
  { re: /追加造成在上一个对手的回合，这只宝可梦所受到的招式的伤害相同数值的伤害/, act:'usage_condition', p:m=>trainerPrerequisite('mirror_last_damage_taken', m[0]) },
  // --- 养鸟人/支援者名条件（metadata 近似）---
  { re: /在这个回合，若从自己的手牌使出了["“”]([^"“”]+)["“”]，则这只宝可梦使用招式所需能量，全部消除/, act:'energy_cost_eliminate', p:()=>({target:'self'}) },
  // --- 对手战斗宝可梦招式伤害-N（压迫感类，宽松近似）---
  { re: /对手战斗宝可梦使用的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:-Math.abs(+m[1]),target:'self'}) },
  // --- 条件失败（无备战上场→失败）/ 伤害锁 ---
  { re: /在这个回合，若这只宝可梦没有从备战区被放置于战斗场上，则这个招式失败/, act:'usage_condition', p:m=>trainerPrerequisite('fail_unless_from_bench', m[0]) },
  // --- 多目标指示物（对手 N 只各放 per）---
  { re: /给对手的(\d+)只宝可梦身上，各放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_N_field',count:+m[1],per:+m[2]}) },
  // --- 道具伤害修正与特防（全罩防守等）---
  { re: /身上放有这张卡的宝可梦（除拥有特性的宝可梦外），受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /自己备战区的所有【基础】宝可梦，当对手从手牌使出支援者时，不受其效果影响/, act:'usage_condition', p:m=>trainerPrerequisite('bench_basic_immune_supporter', m[0]) },
  { re: /自己的所有宝可梦，不受对手宝可梦所使用的GX招式的伤害和效果影响/, act:'usage_condition', p:m=>trainerPrerequisite('immune_gx_attacks', m[0]) },
  { re: /即使自己使用了["“”]([^"“”]+)["“”]，自己的回合也不会结束/, act:'usage_condition', p:m=>trainerPrerequisite('supporter_no_end_turn', m[0]) },
  { re: /这张卡，只有通过["“”]([^"“”]+)["“”]的特性["“”]([^"“”]+)["“”]的效果才能被放置于场上/, act:'usage_condition', p:m=>trainerPrerequisite('place_via_ability_only', m[0]) },
  { re: /这个招式，若自己没有手牌，则仅需1个【(.+?)】能量便可使用/, act:'usage_condition', p:m=>trainerPrerequisite('cost_reduced_if_no_hand', m[0]) },
  { re: /若希望，可以将最多(\d+)张自己备战宝可梦身上附着的能量丢到弃牌区，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],amountPer:+m[2]}) },
  { re: /若希望，可以将这只宝可梦放回手牌。（除宝可梦以外的卡牌全部丢到弃牌区。）/, act:'return_to_hand', p:()=>({target:'self',with_attachments:false}) },
  { re: /选择自己备战区中的["“”]([^"“”]+)["“”]所拥有的1个招式，作为这个招式使用/, act:'usage_condition', p:m=>trainerPrerequisite('copy_move_from_bench', m[0]) },
  { re: /(?:造成|追加造成)自己弃牌区中的["“”]([^"“”]+)["“”](?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'discard_name',name:m[1],mode:'per_unit'}) },
  { re: /若因为这个招式的伤害，对手的【基础】宝可梦【昏厥】，则多拿取(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[1]}) },
  { re: /对手可放置于备战区的宝可梦数量就会变为(\d+)只/, act:'usage_condition', p:m=>trainerPrerequisite('opp_bench_limit', m[0]) },
  { re: /选择对手弃牌区中的1张【基础】宝可梦，放置于对手的备战区/, act:'discard_to_bench', p:()=>({count:1,filter:'宝可梦',side:'opponent'}) },
  { re: /选择自己的1张手牌，将其与牌库上方的卡牌互换/, act:'usage_condition', p:m=>trainerPrerequisite('hand_deck_top_swap', m[0]) },
  { re: /将对手战斗宝可梦身上附着的1个特殊能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_active',count:1,filter:'特殊能量'}) },
  { re: /对手战斗宝可梦【撤退】所需能量，就会增加1个/, act:'usage_condition', p:m=>trainerPrerequisite('opp_retreat_up_passive', m[0]) },
  { re: /选择对手场上宝可梦身上附着的1个特殊能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_field',count:1,filter:'特殊能量'}) },
  { re: /将自己弃牌区的1张【(.+?)】能量，附于自己备战区的【(.+?)】宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[1]}】能量`,target:'bench',targetType:ELEM[m[2]]||m[2]},1,false) },
  { re: /选择(?:放置于对手场上宝可梦身上的["“”]特殊能量["“”]以及放置于场上的["“”]竞技场["“”])各1张，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_special_and_stadium', m[0]) },
  { re: /自己的["“”]宝可梦【VMAX】["“”]所使用的招式的伤害，不计算对手战斗宝可梦身上所附加的效果/, act:'ignore', p:()=>({what:'opponent_effects'}) },
  { re: /只有在自己场上的["“”]([^"“”]+)["“”]数量在(\d+)只及以上时，这只宝可梦才可使用招式/, act:'usage_condition', p:m=>trainerPrerequisite('attack_requires_field_count', m[0]) },
  { re: /这张卡，只有在自己场上有["“"]([^"“”]+)["“”]宝可梦时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('requires_field_type', m[0]) },
  { re: /这张卡，只有在自己的手牌只剩这1张时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('only_last_hand_card', m[0]) },
  { re: /这张卡，只有在自己放逐区有(\d+)张以上（包含\d+张）卡牌时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('lost_zone_min', m[0]) },
  // ===== P8（2026-09）：方括号伤害/额外措辞修正 =====
  { re: /在下个对手的回合[，,]?这只宝可梦所受到的招式的伤害[［\["“”]?-?(\d+)["“”」]?/, act:'damage_received_mod', p:m=>({amount:-Math.abs(+m[1]),target:'self',duration:'next_opp_turn'}) },
  // ===== P9（2026-09）：长尾第 3 批 =====
  // --- 属性换位+回血 / 弃牌区附能变体 ---
  { re: /将自己战斗场上的【(.+?)】宝可梦与备战宝可梦互换。然后，恢复被换入备战区的宝可梦["“”]([+-]?\d+)["“”]HP/, act:'switch_active_basic_heal_bench', p:m=>({heal:+m[2]}) },
  { re: /将自己弃牌区中的1张【(.+?)】能量，附于自己备战区的【(.+?)】宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[1]}】能量`,target:'bench',targetType:ELEM[m[2]]||m[2]},1,false) },
  // --- 训练家换位/回手 ---
  { re: /选择自己备战区中的1只["“”]宝可梦V["“”]，将被选择的宝可梦，以及放置于其身上的卡牌，全部丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_bench_v', m[0]) },
  { re: /选择自己的身上没有放置伤害指示物的最多(\d+)只备战宝可梦，将被选择的宝可梦，以及放置于其身上的卡牌，全部丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_healthy_bench', m[0]) },
  { re: /将自己弃牌区中的1张【(.+?)】属性的【基础】宝可梦，与自己场上的1只宝可梦互换（继承所有(?:放置|放)于其身上的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('swap_discard_typed_base', m[0]) },
  // --- 弃牌区置备战（洛奇亚VSTAR）---
  { re: /从自己的弃牌区选择最多(\d+)张【无】宝可梦（除["“”]拥有规则的宝可梦["“”]外），放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],true) },
  // --- 备战区全体回血 ---
  { re: /将自己所有备战宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[1]}) },
  { re: /将自己所有【(.+?)】宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[2]}) },
  { re: /可将自己所有的【(.+?)】宝可梦和【(.+?)】宝可梦的HP，各恢复["“”]?([+-]?\d+)["“”]?/, act:'heal_all', p:m=>({amount:+m[3]}) },
  // --- 对战区中选招式（汇流/魔尼尼）---
  { re: /选择自己备战区的["“”]([^"“”]+)["“”]宝可梦所拥有的1个招式，作为这个招式使用/, act:'usage_condition', p:m=>trainerPrerequisite('copy_move_from_bench2', m[0]) },
  { re: /对手选择对手自己场上的宝可梦所拥有的1个招式。将被选择的招式作为这个招式使用/, act:'usage_condition', p:m=>trainerPrerequisite('opp_choose_move_copy', m[0]) },
  // --- 场属性被动伤害 ---
  { re: /双方身上附着【(.+?)】或【(.+?)】能量的宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:+m[3],target:'own_field'}) },
  { re: /双方的【(.+?)】或【(.+?)】宝可梦使用的招式，给对手战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[3]}) },
  // --- 特殊能量限制修正（音波龙：无引号版）---
  { re: /在下个对手的回合，对手无法从手牌使出并附着特殊能量，也无法放置竞技场/, act:'usage_condition', p:m=>trainerPrerequisite('block_special_stadium_next', m[0]) },
  // --- 对手备战全体伤害（无“也”措辞）---
  { re: /给对手的所有备战宝可梦，各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_all',damage:+m[1]}) },
  // --- 备战区中超属性计数×N（含“中”）---
  { re: /(?:追加造成|造成)自己备战区中【(.+?)】宝可梦数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[2],condition:'counter',counter:'own_bench_pokemon_type',type:ELEM[m[1]]||m[1],mode:'per_unit'}) },
  // --- 场上能量弃置计数伤害（草能等）---
  { re: /将自己场上宝可梦身上附着的最多(\d+)张【(.+?)】能量丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],filter:`【${m[2]}】能量`,amountPer:+m[3]}) },
  // --- 翻牌库顶（镐）---
  { re: /将自己的牌库上方的1张卡翻到正面，若该卡牌是【(.+?)】能量，则附于自己的备战宝可梦身上。若不是【(.+?)】能量，则在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('pickaxe_top_draw', m[0]) },
  // --- 道具作宝可梦放置（皮皮玩偶）---
  { re: /这张卡，可以作为HP为(\d+)属性为【(.+?)】的【基础】宝可梦，放置于场上/, act:'usage_condition', p:m=>trainerPrerequisite('doll_as_pokemon', m[0]) },
  // --- 全场效果免疫（大阳伞/道具妨碍器等）---
  { re: /只要身上放有这张卡的宝可梦在战斗场上，自己的所有宝可梦，不会受到对手宝可梦使用的招式的效果影响/, act:'prevent_effect', p:()=>({target:'own_field',source:'attack'}) },
  { re: /只要身上放有这张卡的宝可梦在战斗场上，放置于对手战斗宝可梦身上的["“”]宝可梦道具["“”]（除["“”]([^"“”]+)["“”]外）的效果，全部消除/, act:'usage_condition', p:m=>trainerPrerequisite('nullify_opp_tool_while_active', m[0]) },
  { re: /身上放有这张卡的["“”]([^"“”]+)["“”]，当对手从手牌使出支援者时，不受其效果影响/, act:'usage_condition', p:m=>trainerPrerequisite('tool_immune_supporter', m[0]) },
  { re: /身上放有这张卡的宝可梦的弱点，全部消除/, act:'weakness_null', p:()=>({target:'own_field'}) },
  // --- 受击反击（灵界面具/咒术掸子）---
  { re: /身上放有这张卡的宝可梦，在战斗场上受到对手宝可梦的招式的伤害时，对手选择对手自己的1张手牌，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('counter_discard_opp_hand', m[0]) },
  { re: /身上放有这张卡的宝可梦，受到对手宝可梦的招式的伤害而【昏厥】时，在不看正面的前提下，选择对手的1张手牌，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('on_ko_discard_opp_hand', m[0]) },
  // --- 道具类小效果 ---
  { re: /身上放有这张卡的处于【中毒】状态的宝可梦所使用的招式，给对手的战斗宝可梦造成的伤害["“”]([+-]?\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[1]}) },
  // --- 杂项招式 ---
  { re: /对手选择对手自己的(\d+)张手牌，丢到弃牌区/, act:'discard_opponent_hand_random', p:m=>({count:+m[1],chooser:'opponent'}) },
  { re: /若希望，可选择附于这只宝可梦身上最多(\d+)张【(.+?)】能量，丢到弃牌区。在这种情况下，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],filter:`【${m[2]}】能量`,amountPer:+m[3]}) },
  { re: /将双方战斗宝可梦身上放置的伤害指示物，全部互换/, act:'usage_condition', p:m=>trainerPrerequisite('swap_counters_active', m[0]) },
  { re: /这只宝可梦不会陷入特殊状态/, act:'block_special_condition', p:()=>({target:'self'}) },
  { re: /掷硬币直到出现反面，从对手的牌库上方将与出现正面次数相同数量的卡牌丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('coin_mill_opp', m[0]) },
  { re: /给对手的1只备战宝可梦，造成其身上放置的伤害指示物数量[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('bench_damage_by_counters', m[0]) },
  { re: /若对手的战斗宝可梦是【(.+?)】宝可梦，则使该宝可梦陷入【(.+?)】状态/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[2]]||m[2]],condition:'opponent_active_type',type:ELEM[m[1]]||m[1]}) },
  { re: /自己场上的所有【(.+?)】宝可梦（除["“”]([^"“”]+)["“”]外）的最大HP，各增加["“”]?\+?([+-]?\d+)["“”]?/, act:'max_hp_mod', p:m=>({amount:+m[2],target:'self'}) },
  { re: /使双方的战斗宝可梦各陷入【(.+?)】状态/, act:'inflict_status_both', p:m=>({statuses:[STATUS_MAP[m[1]]||m[1]]}) },
  { re: /若这只宝可梦身上附着能量，则这只宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /将对手备战宝可梦数量[×x]\d+个伤害指示物，放置于对手的战斗宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('counters_twice_opp_bench', m[0]) },
  { re: /(?:造成|追加造成)对手弃牌区中的支援者(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'opponent_discard_supporter',mode:'per_unit'}) },
  { re: /在下个对手的回合，受到这个招式影响的["“”]宝可梦V・GX["“”]，无法使用招式/, act:'cannot_attack_next', p:()=>({target:'opponent'}) },
  { re: /若这只宝可梦身上附着能量，则这只宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /选择自己手牌中任意数量的【(.+?)】能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'any',allowFewer:true,allowEmpty:true,maxCount:99}) },
  { re: /若希望，可选择自己手牌中的1张【(.+?)】能量，附于这只宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'active'}) },
  // ===== P10（2026-09）：尾部安全网（只命中前面未覆盖文本）=====
  { re: /受到对手宝可梦的招式的伤害["“”]-?(\d+)["“”]/, act:'damage_received_mod', p:m=>({amount:-Math.abs(+m[1]),target:'self'}) },
  { re: /给对手(?:的)?战斗宝可梦造成的伤害["“”]\+(\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[1]}) },
  { re: /给对手战斗场上的(?:【[^】]+】|["“”][^"“”]+["“”])宝可梦造成的伤害["“”]\+(\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[1]}) },
  { re: /对对手(?:的)?战斗宝可梦造成的伤害["“”]\+(\d+)["“”]/, act:'passive_damage_mod', p:m=>({target:'own_field',amount:+m[1]}) },
  { re: /给对手的(\d+)只宝可梦(?:身上)?，?各?造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:+m[1],damage:+m[2]}) },
  { re: /给对手的1只宝可梦，造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_any',damage:+m[1]}) },
  { re: /对自己的(\d+)只(?:备战)?宝可梦，也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'self_1',damage:+m[2]}) },
  { re: /(?:造成|追加造成)(?:自己|对手).{0,20}?(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'__zero',mode:'per_unit'}) },
  { re: /则多拿取(\d+)张奖赏卡/, act:'extra_prize', p:m=>({count:+m[1]}) },
  { re: /在下个对手的回合，受到这个招式影响的[^。]{0,12}?宝可梦[，,]?无法使用招式/, act:'cannot_attack_next', p:()=>({target:'opponent'}) },
  { re: /将附于这只宝可梦身上的(\d+)个(?:【.+?】)?能量，放回手牌/, act:'return_energy_to_hand', p:m=>({target:'self',count:+m[1]}) },
  { re: /造成对手战斗宝可梦所处于的特殊状态数量[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'opponent_active_status_count',mode:'per_unit'}) },
  { re: /若希望，可从牌库抽出卡牌，直到自己的手牌数量为(\d+)张为止/, act:'draw_until', p:m=>({target:+m[1]}) },
  { re: /查看对手牌库上方1张卡，再放回原处。若希望，可重洗对手的牌库/, act:'usage_condition', p:m=>trainerPrerequisite('look_opp_top_reshuffle', m[0]) },
  { re: /从自己(?:的)?牌库上方抽出(\d+)张卡，若希望/, act:'draw', p:m=>({count:+m[1],optional:true}) },
  { re: /给对手的备战区中的(\d+)只[^，。]*宝可梦，也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:+m[1],damage:+m[2]}) },
  // ===== P11（2026-09）：长尾第 5 批 =====
  { re: /这只宝可梦使用招式所需能量会减少与对手场上["“”]([^"“”]+)["“"]宝可梦数量相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_field_count'}) },
  { re: /这只宝可梦，当对手从手牌使出物品时，不受其效果影响/, act:'prevent_effect', p:()=>({source:'trainer'}) },
  { re: /将自己手牌中任意数量的支援者丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('discard_supporter_hand_for_damage', m[0]) },
  { re: /这只宝可梦，可使用所有自己的备战区或弃牌区中的["“”]宝可梦GX・EX["“”]所拥有的招式/, act:'usage_condition', p:m=>trainerPrerequisite('copy_gx_ex_moves', m[0]) },
  { re: /将双方场上["“”]拥有规则的宝可梦["“”]的特性，全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /身上放有这张卡的宝可梦所使用的招式，给对手备战区的["“”]([^"“”]+)["“”]造成的伤害["“”]([+-]?\d+)["“"]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[2]}) },
  { re: /身上放有这张卡的宝可梦所使用的招式，给对手战斗场上的【(.+?)】宝可梦造成的伤害["“”]([+-]?\d+)["“"]/, act:'passive_damage_mod', p:m=>({target:'self',amount:+m[2]}) },
  { re: /身上放有这张卡的宝可梦（除拥有规则的宝可梦外），受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“"]/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'self'}) },
  { re: /追加造成比起使用这个招式的所需能量，多附着的【(.+?)】能量的数量[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('bonus_damage_extra_energy', m[0]) },
  { re: /自己场上的，所有名字中带有["“”]([^"“”]+)["“”]的宝可梦，受到对手宝可梦的招式的伤害["“”]([+-]?\d+)["“"]/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'own_field'}) },
  { re: /这只宝可梦所使用的招式，给对手战斗宝可梦造成的伤害，会因为每张对手已经获得的奖赏卡而["“”]([+-]?\d+)["“"]/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'opponent_prizes_taken',mode:'per_unit'}) },
  { re: /对手战斗宝可梦使用的招式的伤害，全部["“”]-?(\d+)["“"]/, act:'damage_received_mod', p:m=>({amount:-Math.abs(+m[1]),target:'self'}) },
  { re: /在这个回合，若这只宝可梦从备战区被放置于战斗场上，则这个招式仅需1个【(.+?)】能量便可使用/, act:'usage_condition', p:m=>trainerPrerequisite('cost_one_from_bench', m[0]) },
  { re: /选择对手场上的1只剩余HP在["“”]?(\d+)["“"]?点以下（包含["“”]?\d+["“"]?）的宝可梦，使其【昏厥】/, act:'knockout', p:()=>({target:'opponent'}) },
  { re: /这只宝可梦，可使用自己弃牌区中的【基础】宝可梦（除["“”]拥有规则的宝可梦["“"]外）所拥有的所有招式/, act:'usage_condition', p:m=>trainerPrerequisite('copy_basic_from_discard', m[0]) },
  { re: /身上附着【(.+?)】能量的自己所有的宝可梦（除["“”]([^"“”]+)["“"]外），不会受到对手宝可梦的特性的效果影响/, act:'prevent_effect', p:()=>({source:'ability'}) },
  { re: /自己的战斗宝可梦【撤退】所需能量，减少(\d+)个/, act:'retreat_cost_reduce', p:m=>({amount:+m[1],target:'own_field'}) },
  { re: /(?:追加造成|造成)自己弃牌区中的宝可梦(?:张数|数量)[×x](\d+)伤害/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'discard_pokemon',mode:'per_unit'}) },
  { re: /选择放置于自己所有宝可梦身上的伤害指示物各(\d+)个，转放置于对手的1只宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_counters_self_to_opp', m[0]) },
  { re: /这个招式，只有在自己放逐区有(\d+)张以上（包含\d+张）卡牌时才可使用。使对手战斗宝可梦【昏厥】/, act:'knockout', p:()=>({target:'opponent'}) },
  { re: /对手就无法从手牌使出竞技场/, act:'usage_condition', p:m=>trainerPrerequisite('opp_block_stadium', m[0]) },
  { re: /身上附着【(.+?)】能量的自己的所有宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'own_field'}) },
  { re: /选择对手场上宝可梦身上放置的任意数量的伤害指示物，以任意方式转放置于对手的场上宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_counters_opp_field', m[0]) },
  { re: /这只宝可梦，若是后攻玩家的最初回合，哪怕刚刚出场也可进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_first_turn_after', m[0]) },
  { re: /在不看对手手牌正面的前提下，将其中1张丢到弃牌区/, act:'discard_opponent_hand_random', p:()=>({count:1}) },
  { re: /若对手场上有["“”]([^"“”]+)["“”]，则这只宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /这个招式，若双方的剩余奖赏卡张数共计(\d+)张，则仅需1个【(.+?)】能量便可使用/, act:'usage_condition', p:m=>trainerPrerequisite('cost_one_when_total_prizes', m[0]) },
  { re: /在下个对手的回合，对手无法从手牌将特殊能量附于宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('block_special_attach_next', m[0]) },
  { re: /(\d+)张【(.+?)】能量，附于这只宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[2]}】能量`,target:'self'},m[1],false) },
  { re: /自己的所有【基础】宝可梦的【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'own_field'}) },
  { re: /将自己弃牌区中1张基本能量，附于备战宝可梦身上/, act:'attach_energy_from_discard', p:()=>withCount({filter:'基本能量',target:'bench'},1,false) },
  { re: /当双方场上拥有【(.+?)】属性弱点的宝可梦，受到招式的伤害时，不计算弱点/, act:'ignore', p:m=>({what:'weakness'}) },
  { re: /对手无法从手牌使出["“"]宝可梦道具["“"]["“"]特殊能量["“"]也无法放置["“"]竞技场["“"]/, act:'usage_condition', p:m=>trainerPrerequisite('opp_block_items_special_stadium', m[0]) },
  { re: /给对手处于备战区的(\d+)只["“”]([^"“”]+)["“"]，也各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:+m[1],damage:+m[3]}) },
  { re: /在下个自己的回合，这只宝可梦的["“”]([^"“”]+)["“"]的伤害变为["“”](\d+)["“"]/, act:'usage_condition', p:m=>trainerPrerequisite('next_turn_damage_set', m[0]) },
  { re: /若自己场上的宝可梦数量在(\d+)只以下（包含\d+只），则这只宝可梦无法使用招式/, act:'usage_condition', p:m=>trainerPrerequisite('cannot_attack_if_few', m[0]) },
  { re: /选择这只宝可梦身上附着的1张["“"]([^"“”]+)["“"]，丢到弃牌区。在这种情况下，将对手的战斗宝可梦以及放置于其身上的全部的卡牌丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_energy_then_ko_field', m[0]) },
  { re: /给对手所有备战宝可梦各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_all',damage:+m[1]}) },
  { re: /双方场上【基础】宝可梦的["“"]宝可梦【V】["“"]的特性，全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /双方场上【基础】宝可梦的特性（除["“"]恶作剧之锁["“"]外），全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /若这只宝可梦身上附着了(\d+)个及以上【(.+?)】能量，则这只宝可梦的最大HP["“"]\+(\d+)["“"]/, act:'max_hp_mod', p:m=>({amount:+m[3]}) },
  { re: /选择自己的1只备战宝可梦，将被选择的宝可梦身上放置的所有伤害指示物，转放置于对手的战斗宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_counters_bench_to_opp', m[0]) },
  { re: /选择自己手牌中的1张["“"]([^"“”]+)["“"]，附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:m[1],target:'any'}) },
  { re: /若自己的场上有["“"]花椰猿["“"]["“"]爆香猿["“"]["“"]冷水猿["“"]，则这只宝可梦使用招式所需的【无】能量，全部消除/, act:'energy_cost_eliminate', p:()=>({target:'self'}) },
  { re: /双方各将牌库上方1张卡丢到弃牌区，追加造成其中能量张数[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('mill_both_energy_bonus', m[0]) },
  { re: /掷硬币直到出现反面，选择对手战斗宝可梦身上附着的与出现正面次数相同数量的能量，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('coin_discard_opp_energy', m[0]) },
  // ===== P12（2026-09）：长尾第 6 批 =====
  { re: /这只宝可梦使用招式所需能量会减少与对手场上["“”](?:[^"“”]+["“"])+宝可梦数量相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_field_count'}) },
  { re: /在下个对手的回合，受到这个招式影响的["“"]?[^。]{0,14}?无法使用招式/, act:'cannot_attack_next', p:()=>({target:'opponent'}) },
  { re: /从自己的弃牌区选择最多(\d+)张【(.+?)】能量，以任意方式附于自己的【(.+?)】宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any',targetType:ELEM[m[3]]||m[3]},m[1],true) },
  { re: /这只宝可梦所使用的招式，给对手战斗宝可梦造成的伤害，会因为每张自己已获取的奖赏卡而["“”]([+-]?\d+)["“"]/, act:'conditional_damage_mod', p:m=>({amount:+m[1],condition:'counter',counter:'own_prizes_taken',mode:'per_unit'}) },
  { re: /对方就无法从手牌使出["“"]宝可梦道具["“"]["“"]特殊能量["“"]也无法放置["“"]竞技场["“"]/, act:'usage_condition', p:m=>trainerPrerequisite('opp_block_item_special_stadium', m[0]) },
  { re: /将自己手牌中任意数量的【撤退】所需能量数为(\d+)个的宝可梦丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('discard_retreat4_for_damage', m[0]) },
  { re: /对手场上所有【(.+?)】宝可梦的弱点全部变为【(.+?)】属性/, act:'usage_condition', p:m=>trainerPrerequisite('weakness_set_type', m[0]) },
  { re: /将自己场上宝可梦身上附着的最多(\d+)张能量丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],amountPer:+m[2]}) },
  { re: /在下个自己的回合，这只宝可梦的["“"]([^"“"]+)["“"]的伤害["“"]([+-]?\d+)["“"]/, act:'damage_boost_next_self', p:m=>({amount:+m[2]}) },
  { re: /在对手的1只宝可梦身上放置伤害指示物，直到其剩余HP变为["“"]?(\d+)["“"]?为止/, act:'usage_condition', p:m=>trainerPrerequisite('counters_until_hp', m[0]) },
  { re: /给身上放置有伤害指示物的对手的(\d+)只宝可梦，各造成(\d+)伤害/, act:'damage_bench', p:m=>({target:'opponent_N',count:+m[1],damage:+m[2]}) },
  { re: /这个招式，若这只宝可梦身上放有["“"]([^"“"]+)["“"]，则仅需(\d+)个【(.+?)】能量便可使用/, act:'usage_condition', p:m=>trainerPrerequisite('cost_reduced_by_tool', m[0]) },
  { re: /这只宝可梦使用招式所需能量会减少与对手备战宝可梦数量相同数量的【无】能量/, act:'attack_cost_reduction', p:()=>({target:'self',type:'colorless',amount:'opponent_bench_count'}) },
  { re: /双方场上的["“"]拥有规则的宝可梦["“"]（除["“"]([^"“"]+)["“"]外）的特性，全部消除/, act:'ability_nullify', p:m=>abilityNullifyParams(m[0],m.input) },
  { re: /将这只宝可梦身上附着的最多(\d+)张【(.+?)】能量丢到弃牌区，造成其(?:张数|数量)[×x](\d+)伤害/, act:'discard_energy_for_damage', p:m=>({source:'field',count:+m[1],filter:`【${m[2]}】能量`,amountPer:+m[3]}) },
  { re: /从自己的弃牌区选择最多(\d+)张【(.+?)】宝可梦，放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],true) },
  { re: /若对手的战斗宝可梦是【(.+?)】宝可梦，则令那只宝可梦陷入【(.+?)】状态/, act:'inflict_status', p:m=>({statuses:[STATUS_MAP[m[2]]||m[2]],condition:'opponent_active_type',type:ELEM[m[1]]||m[1]}) },
  { re: /从自己的弃牌区选择最多(\d+)张["“"]([^"“"]+)["“"]，放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],true) },
  { re: /若自己的手牌与对手的手牌张数不同，则这个招式失败/, act:'usage_condition', p:m=>trainerPrerequisite('fail_if_hand_diff', m[0]) },
  { re: /身上附着了【(.+?)】能量的自己所有宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'own_field'}) },
  { re: /这只宝可梦，可以从手牌中使出从["“"]([^"“"]+)["“"]进化而来的["“"]宝可梦【ex】["“"]，放置于这只宝可梦身上进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_eevee_ex', m[0]) },
  { re: /自己所有【基础】宝可梦【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'own_field'}) },
  { re: /对手处于【中毒】状态的宝可梦，因【中毒】而放置的伤害指示物数量增加(\d+)个/, act:'poison_damage_increase', p:m=>({amount:+m[1],target:'opponent_field'}) },
  { re: /在下个对手的回合，这只宝可梦的弱点，全部消除/, act:'weakness_null', p:()=>({target:'self'}) },
  { re: /查看自己的牌库下方(\d+)张卡，以任意顺序重新排列，放回牌库上方/, act:'manipulate_deck_top', p:m=>({target:'self',count:+m[1],mode:'bottom_reorder_top'}) },
  { re: /选择自己场上1只宝可梦身上放置的最多(\d+)个伤害指示物，以任意方式转放置于自己的其他宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_counters_self', m[0]) },
  { re: /查看自己的牌库上方1张卡，再放回原处。若希望，可选择1张反面朝上的自己的奖赏卡，将其与自己的牌库最上方的卡牌，在反面朝上的状态下互换/, act:'prize_deck_top_swap', p:()=>({optional:true}) },
  { re: /在这个回合结束前，对手战斗宝可梦的特性，全部消除/, act:'ability_nullify', p:m=>({scope:'opponent_active',duration:'turn',raw:m[0]}) },
  { re: /在不看正面的前提下选择对手1张手牌，查看其正面。若该卡牌是支援者，则丢到弃牌区。若不是支援者，则放回手牌/, act:'usage_condition', p:m=>trainerPrerequisite('peek_opp_discard_if_supporter', m[0]) },
  { re: /恢复自己战斗宝可梦["“"]?(\d+)["“"]?HP，以及恢复1个特殊状态/, act:'heal_status', p:()=>({target:'self'}) },
  { re: /恢复自己的1只剩余HP在["“"]?(\d+)["“"]?点以下（包含["“"]?\d+["“"]?点）的宝可梦["“"](\d+)["“"]HP/, act:'heal', p:m=>({amount:+m[2]}) },
  { re: /将自己场上1只宝可梦身上放置的(\d+)个伤害指示物，转放置于自己1只其他宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('move_3_counters', m[0]) },
  // ===== P13（2026-09）：unparsed 真实效果段补建 =====
  // --- 检索类（含“（包含N）”断句/或属性组合）---
  { re: /从自己的牌库[，,]?选择1张HP在["“”]?(\d+)["“”]?以下（包含["“”]?\d+["“”]?）的宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`HP为${m[1]}以下的宝可梦`,maxHp:+m[1]},1,false) },
  { re: /将(?:自己的)?牌库中的1张【(.+?)】或【(.+?)】宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[1]}】或【${m[2]}】宝可梦`},1,false) },
  { re: /从自己的牌库选择，属性各不相同的宝可梦最多(\d+)张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'属性各不相同的宝可梦'},m[1],true) },
  { re: /从自己的牌库选择最多(\d+)张能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'能量'},m[1],true) },
  // --- 弃牌区能量放回牌库（能量再利用等）---
  { re: /将(?:自己的|自己)?弃牌区中(?:的)?(\d+)张基本能量，在给对手看过后，放回牌库/, act:'recover_from_discard', p:m=>withCount({filter:'基本能量',target:'deck'},m[1],false) },
  // --- 自己手牌全部放回牌库并重洗后抽 N ---
  { re: /将(?:自己的)?手牌全部放回牌库并且重洗牌库。然后，从牌库(?:上方)?抽取(\d+)张卡牌/, act:'shuffle_hand_to_deck', p:m=>({who:'self',draw_count:+m[1]}) },
  { re: /若自己场上的宝可梦仅有战斗宝可梦，则抽出的卡牌张数变为(\d+)张/, act:'usage_condition', p:m=>trainerPrerequisite('draw_more_if_only_active', m[0]) },
  // --- 伊布族进化检索 ---
  { re: /从自己的牌库选择1张从这只宝可梦进化而来的卡牌，放置于这只宝可梦身上进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_from_this_from_deck', m[0]) },
  // ===== P14（2026-09）：unparsed 真实效果段补建 II =====
  // --- 相仿铃铛：检索与弃牌区同名的宝可梦 ---
  { re: /从自己的牌库选择，与自己弃牌区中的宝可梦名字相同的1张宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:'与自己弃牌区中宝可梦名字相同的宝可梦'},1,false) },
  // --- 巢穴球变体：牌库中 N 张基础宝可梦置备战 ---
  { re: /将(?:自己的)?牌库中(\d+)张【基础】宝可梦，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],false) },
  // --- 梅丽莎：下回合己方全场受 V 招式减伤（含新出场） ---
  { re: /在下个对手的回合，自己的所有宝可梦，受到对手["“”]宝可梦V["“”]的招式的伤害["“”]([+-]?\d+)["“"]/, act:'damage_received_mod', p:m=>({amount:+m[1],target:'own_field',duration:'next_opp_turn'}) },
  // --- 弃牌区支援者放回牌库（朋友手册） ---
  { re: /将(?:自己的|自己)?弃牌区中的(\d+)张支援者，在给对手看过后，放回牌库/, act:'recover_from_discard', p:m=>withCount({filter:'支援者',target:'deck'},m[1],false) },
  // --- 猜谜游戏（夏伯的猜谜秀：metadata） ---
  { re: /选择自己手牌中的1张宝可梦，将该宝可梦所拥有的招式名字告知对手后，反面朝上放置/, act:'usage_condition', p:m=>trainerPrerequisite('quiz_game', m[0]) },
  // --- 金珠：回合开始抽到时使用（metadata） ---
  { re: /这张卡，只有当在自己的回合开始，被从牌库抽出到，在加入手牌前才能使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('use_on_draw_start', m[0]) },
  // --- 宝可梦通信：手牌 1 宝可梦放回牌库后检索 1 宝可梦 ---
  // --- 特殊能量供能叙述（夜光能量/高温能量类，语义由 CardResolver 处理） ---
  { re: /只要这张卡，被附于宝可梦身上，就[^。]*的能量/, act:'usage_condition', p:m=>trainerPrerequisite('energy_supply_desc', m[0]) },
  { re: /若身上附着了这张卡的宝可梦，身上还附着了除这张卡以外的特殊能量，则这张卡[^。]*/, act:'usage_condition', p:m=>trainerPrerequisite('energy_second_rule', m[0]) },
  // --- 涡轮补丁类残壳（硬币+弃牌区附能） ---
  { re: /若为正面，则从自己的弃牌区选择1张基本能量，附于除["“”]宝可梦GX["“”]外的自己的宝可梦身上/, act:'attach_energy_from_discard', p:()=>withCount({filter:'基本能量',target:'any'},1,false) },
  // ===== P15（2026-09）：unparsed 真实效果段补建 III =====
  // --- 露营组合：任意 1 张卡加手 ---
  { re: /从自己的牌库选择任意1张卡[，,]?加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:null},1,false) },
  // --- 魔墙人偶GX：自身 HP 全恢复 ---
  { re: /将这只宝可梦的HP[，,]?全部恢复/, act:'heal', p:()=>({amount:'full'}) },
  // --- 魔仿秀：复制支援者效果 ---
  { re: /若希望，可选择其中1张支援者，将该支援者的效果，作为这个招式的效果使用/, act:'usage_condition', p:m=>trainerPrerequisite('copy_supporter_effect', m[0]) },
  // --- 模仿：手牌回牌库后抽与对手手牌等量 ---
  { re: /将(?:自己的|自己)?手牌全部放回牌库并且重洗牌库。然后，从(?:自己的|自己)?牌库(?:上方)?抽出与对手的手牌(?:张数|数量)相同数量的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('hand_to_deck_draw_like_opp', m[0]) },
  // --- 大针蜂特性：手牌仅 1 张时自身入场 + 抽 3 ---
  { re: /若自己的手牌仅有这1张卡[，,]?/, act:'usage_condition', p:m=>trainerPrerequisite('only_single_hand_card', m[0]) },
  { re: /将这张卡(?:牌)?放置于备战区/, act:'usage_condition', p:m=>trainerPrerequisite('place_self_to_bench', m[0]) },
  // ===== P16（2026-09）：unparsed 真实效果段补建 IV =====
  // --- 高级球/尼多后特性：牌库 1 张宝可梦加手（允许（X除外）括注）---
  { re: /将(?:自己的|自己)?牌库中的1张宝可梦(?:（[^）]*）)?，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'宝可梦'},1,false) },
  // --- 摇摇奶昔：从场上宝可梦进化链检索并放置 ---
  { re: /从自己的牌库选择1张从自己场上的1只宝可梦进化而来的卡牌，放置于该宝可梦身上进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_from_any_field_pokemon', m[0]) },
  // --- 机器鹕：掷硬币正面任意卡加手（含重洗尾巴）---
  // --- 订购平板：掷硬币正面物品加手 ---
  // --- 训练家/道具前言：丢弃手牌中的 N 张特定卡才可使用 ---
  { re: /这张卡，只有将(?:自己的|自己)?手牌中的(\d+)张(.+?)丢(?:到弃牌区|弃)才可使用/, act:'trainer_prerequisite', p:m=>({kind:'discard_cost',raw:m[0],count:+m[1],zone:'hand',filter:m[2]}) },
  // --- 沙俪：手牌宝可梦回牌库等量换搜 ---
  { re: /选择自己手牌中最多(\d+)张宝可梦，在给对手看过后，放回牌库。然后，从自己的牌库选择最多与放回牌库的宝可梦张数相同数量的宝可梦，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('swap_hand_deck_pokemon', m[0]) },
  // --- 百变怪：变身启动（近似 metadata）---
  { re: /若这只宝可梦在战斗场上，则仅在最初的自己的回合可使用1次。从自己的牌库选择1张【基础】宝可梦（除[^）]*外）。然后，将这只宝可梦，以及(?:放置|放)于其身上的所有卡牌丢到弃牌区，将被选择的宝可梦(?:放置|放)于这只宝可梦原先的位置/, act:'usage_condition', p:m=>trainerPrerequisite('transform_start', m[0]) },
  { re: /从自己的弃牌区选择1张【基础】宝可梦的["“”]([^"“”]+)["“”]，与这只宝可梦互换（继承[^）]*）。将这只宝可梦丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('transform_into_discard_pokemon', m[0]) },
  // ===== P17（2026-09）：unparsed 真实效果段补建 V =====
  // --- 附能：牌库属性各不同基本能量多张 ---
  { re: /从自己的牌库，选择最多(\d+)张属性各不同的基本能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:'基本能量'},m[1],true) },
  // --- 名字检索（帅哥口哨等）---
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张["“”]([^"“”]+)["“”]，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2]},m[1],true) },
  // --- 查看后剩余卡放回牌库（超级球/米立龙尾等）---
  { re: /将剩余的卡牌放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('put_remaining_back', m[0]) },
  // --- 海刺龙：下回合硬币失败则招式失败 ---
  { re: /在下个对手的回合，受到这个招式影响的宝可梦在使用招式时，对手将(?:掷|抛掷)[^。]*只要出现1次反面，那么那个招式失败/, act:'usage_condition', p:m=>trainerPrerequisite('coin_fail_attack_next', m[0]) },
  // --- 弃牌区宝可梦+道具各 1 张回牌库（水莲的钓竿）---
  { re: /将(?:自己的|自己)?弃牌区中的(.+?)和["“”]([^"“”]+)["“"]各1张，在给对手看过后，放回牌库/, act:'recover_from_discard', p:m=>withCount({filter:m[1],target:'deck'},2,false) },
  // --- 不公印章残余兜底（双方手牌回牌库）---
  { re: /双方玩家，各将所有手牌放回牌库。然后，自己，对手/, act:'shuffle_hand_to_deck', p:()=>({who:'both'}) },
  // ===== P18（2026-09）：unparsed 长尾补建 VI =====
  // --- 硬币正面数检索（计时球：与正面数相同的进化宝可梦）---
  { re: /将与出现正面次数相同数量的(.+?)，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('search_by_coin_heads', m[0]) },
  // --- 牌库属性能量检索（打火石类）---
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张【(.+?)】能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[2]}】能量`},m[1],true) },
  // --- 海刺龙：下回合对手掷硬币失败则招式失败（残余形态）---
  { re: /在下个对手的回合，受到这个招式影响的宝可梦在使用招式时，对手将。只要出现1次反面，那么那个招式失败/, act:'usage_condition', p:m=>trainerPrerequisite('coin_fail_attack_next', m[0]) },
  // --- 特性自昏 + 附能（顽皮雷弹类片段）---
  { re: /(?:令|使)这只宝可梦【昏厥】/, act:'knockout', p:()=>({target:'self'}) },
  { re: /从自己的牌库选择最多(\d+)张【(.+?)】能量，以任意方式附于自己的【(.+?)】宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any',targetType:ELEM[m[3]]||m[3]},m[1],true) },
  { re: /若这只宝可梦在备战区，则，若使用了，则/, act:'usage_condition', p:m=>trainerPrerequisite('bench_condition_once', m[0]) },
  // --- 弃牌区组合回牌库（小刚的毅力）---
  { re: /将(?:自己的|自己)?弃牌区中的(.+?)共计(\d+)张，在给对手看过后，放回牌库/, act:'recover_from_discard', p:m=>withCount({filter:m[1],target:'deck'},m[2],false) },
  // --- 玛俐残余兜底（双方手牌回库下方+抽）---
  { re: /双方玩家，各将自己所有的手牌反面朝上重洗，放回牌库下方。然后，自己，对手/, act:'shuffle_hand_to_deck', p:()=>({who:'both',draw_count:5}) },
  // --- 对手场上宝可梦普通能量弃置 ---
  { re: /将附于对手场上宝可梦身上的1个能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_field',count:1}) },
  // --- 身上附着本卡的宝可梦最大HP增加（特殊能量类）---
  { re: /身上附着这张卡的【(.+?)】宝可梦的最大HP增加["“"]?(\d+)["“"]?/, act:'max_hp_mod', p:m=>({amount:+m[2],target:'self'}) },
  // --- 猜牌游戏（泰姆类）---
  { re: /选择自己手牌中的1张宝可梦，将该宝可梦的(?:名字|招式名字)告诉对手后，反面朝上放置/, act:'usage_condition', p:m=>trainerPrerequisite('guess_game', m[0]) },
  // ===== P18b：半句剥除残兜底（部件规则先剥后的残余形态）=====
  { re: /将(?:自己的|自己)?手牌全部放回牌库。然后，。/, act:'shuffle_hand_to_deck', p:()=>({who:'self'}) },
  { re: /在自己的回合，若这张卡在弃牌区，且自己没有手牌，。。然后，。/, act:'usage_condition', p:m=>trainerPrerequisite('revive_self_from_discard', m[0]) },
  // ===== P19（2026-09）：长尾补建 VII =====
  { re: /将与出现正面的次数相同张数的(.+?)，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('search_by_coin_heads', m[0]) },
  { re: /将与出现正面次数相同数量的(.+?)，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('search_by_coin_heads', m[0]) },
  { re: /将(?:自己的|自己)?牌库中，与对手场上宝可梦相同属性的1张宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'与对手场上宝可梦相同属性的宝可梦'},1,false) },
  { re: /在下个对手的回合，受到这个招式影响的宝可梦在使用招式时，对手将。若为反面则那个招式失败/, act:'usage_condition', p:m=>trainerPrerequisite('coin_fail_attack_next', m[0]) },
  { re: /若这只宝可梦身上放有["“"]咒术之铲["“"]，则额外将(\d+)张卡丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('shovel_extra_discard', m[0]) },
  { re: /将自己弃牌区中的所有["“"]([^"“"]+)["“"]给对手查看，造成其(?:张数|数量)[×x](\d+)伤害。然后，将给对手查看过的["“"]([^"“"]+)["“"]放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('discard_tools_show_damage_back', m[0]) },
  { re: /当把这张卡从手牌附于(?:【(.+?)】)?宝可梦身上时/, act:'usage_condition', p:m=>trainerPrerequisite('energy_attach_trigger_desc', m[0]) },
  { re: /并恢复所有特殊状态/, act:'heal_status', p:()=>({target:'self'}) },
  { re: /选择自己手牌中的。然后，。/, act:'usage_condition', p:m=>trainerPrerequisite('wave_return_approx', m[0]) },
  { re: /身上放有这张卡的["“"]([^"“"]+)["“"]宝可梦，可使用这张卡上的招式/, act:'usage_condition', p:m=>trainerPrerequisite('tool_learn_move', m[0]) },
  { re: /这张卡，只有在后攻玩家的最初回合才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /若希望，可。在这种情况下，增加(\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('bonus_damage_optional', m[0]) },
  { re: /双方玩家，各将所有手牌放回牌库。然后，各。/ , act:'shuffle_hand_to_deck', p:()=>({who:'both'}) },
  // ===== P20（2026-09）：长尾补建 VIII =====
  { re: /从自己的牌库选择最多(\d+)张【基础】宝可梦的["“"]?([^"“"]+)["“"]?，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:`【基础】宝可梦·${m[2]}`},m[1],true) },
  { re: /将(?:自己的|自己)?牌库中的1张基本能量，与附于自己场上宝可梦身上的1张能量互换，将被换下的能量放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('rainbow_brush_swap', m[0]) },
  { re: /将剩余的卡牌，放回牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('put_remaining_back_top', m[0]) },
  { re: /将自己弃牌区中的所有基本能量给对手查看，追加造成其(?:张数|数量)[×x](\d+)伤害。然后，将给对手查看过的能量放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('show_discard_energy_damage_back', m[0]) },
  { re: /若为反面，则给自己的战斗宝可梦身上放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'self',count:+m[1]}) },
  { re: /选择自己手牌中的1张【(.+?)】能量，附于备战区的【(.+?)】宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'bench',targetType:ELEM[m[2]]||m[2]}) },
  { re: /将自己的(\d+)张手牌，放回牌库。然后，/, act:'usage_condition', p:m=>trainerPrerequisite('hand_one_to_deck', m[0]) },
  { re: /其中任意数量的["“"]([^"“"]+)["“"]，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[1]},1,false) },
  // ===== P21（2026-09）：长尾补建 IX =====
  { re: /从自己的牌库选择，最多(\d+)张HP在["“"](\d+)["“"]及以下的【基础】宝可梦，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:`HP为${m[2]}及以下的【基础】宝可梦`,maxHp:+m[2]},m[1],true) },
  { re: /将(?:自己的|自己)?牌库中的1张基本能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:'基本能量'},1,false) },
  { re: /给对手的所有宝可梦身上，各放置(\d+)个伤害指示物/, act:'damage_place', p:m=>({target:'opponent_all',count:+m[1]}) },
  { re: /将自己弃牌区中的所有基本能量给对手查看，造成其(?:张数|数量)[×x](\d+)伤害。然后，将给对手查看过的能量放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('show_discard_energy_damage_back', m[0]) },
  { re: /选择对手场上宝可梦身上附着的1个能量，丢到弃牌区/, act:'discard_energy', p:()=>({target:'opponent_field',count:1}) },
  { re: /选择自己手牌中的1张["“"]([^"“"]+)["“"]，与这张卡互换（继承放置于其身上的所有卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('transform_swap_from_hand', m[0]) },
  { re: /这张卡，只有将自己的1张手牌[^。]*后才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('discard_one_hand_cond', m[0]) },
  { re: /选择放置于双方场上宝可梦身上的["“"]宝可梦道具["“"]以及场上的["“"]竞技场["“"]中的1张/, act:'discard_field_attachments', p:()=>({target:'any',tools:true,stadium:true,maxCount:1,optional:true}) },
  { re: /其中任意数量的【(.+?)】宝可梦和【(.+?)】能量，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('search_typed_combo', m[0]) },
  { re: /将(?:自己的|自己)?(\d+)张手牌丢到弃牌区。然后，查看自己的牌库上方(\d+)张卡，将其中任意1张卡，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('discard_then_draw_any', m[0]) },
  // ===== P22（2026-09）：长尾补建 X =====
  { re: /从自己的牌库选择，与对手场上宝可梦名字相同的1张宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'与对手场上宝可梦名字相同的宝可梦'},1,false) },
  { re: /将(?:自己的|自己)?牌库中的1张【(.+?)】属性的【基础】宝可梦或者1张【(.+?)】能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[1]}】基础或【${m[2]}】能量`},1,false) },
  { re: /若这只宝可梦在战斗场上，则直到自己的手牌变为(\d+)张为止/, act:'usage_condition', p:m=>trainerPrerequisite('draw_until_if_active', m[0]) },
  { re: /将(?:自己的|自己)?弃牌区中任意数量的["“"]([^"“"]+)["“"]，追加造成其(?:张数|数量)[×x](\d+)伤害/, act:'usage_condition', p:m=>trainerPrerequisite('discard_tools_any_damage', m[0]) },
  { re: /查看自己的牌库上方(\d+)张卡。可将其中的1张能量，在给对手看过后，加入手牌/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:1,filter:'能量'}) },
  { re: /若为正面，则额外抽出(\d+)张卡/, act:'draw', p:m=>({count:+m[1]}) },
  { re: /选择自己手牌中的1张【(.+?)】能量，附于自己备战区的【(.+?)】宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'bench',targetType:ELEM[m[2]]||m[2]}) },
  // ===== P23（2026-09）：长尾补建 XI =====
  { re: /从自己的牌库选择["“"]物品["“"]["“"]宝可梦道具["“"]["“"]支援者["“"]["“"]竞技场["“"]各1张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:'物品/宝可梦道具/支援者/竞技场'},4,false) },
  { re: /将(?:自己的|自己)?牌库中的1张["“"]([^"“"]+)["“"]，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[1]},1,false) },
  { re: /给自己备战区中所有的["“"]([^"“"]+)["“"]，各附着1张牌库中的【(.+?)】能量/, act:'usage_condition', p:m=>trainerPrerequisite('bench_attach_energy_all', m[0]) },
  { re: /^在自己(?:的)?回合时(?:可)?使用[。.;；]{0,3}[\[\uFF3B][^\]\uFF3D]*[\]\uFF3D]$/, act:'usage_condition', p:m=>trainerPrerequisite('vstar_usage_note', m[0]) },
  { re: /将(?:自己的|自己)?弃牌区中的(\d+)张基本能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:'基本能量',target:'any'},m[1],false) },
  // ===== P24（2026-09）：长尾补建 XII =====
  { re: /从自己的牌库，选择任意数量的属性各不相同的基本能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:'属性各不相同的基本能量'},99,true) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张【(.+?)】属性的["“"]([^"“"]+)["“"]，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[2]}】属性·${m[3]}`},m[1],true) },
  { re: /若这只宝可梦在备战区，则在自己的回合时可使用。将这只宝可梦与自己的战斗宝可梦互换。然后，。/ , act:'usage_condition', p:m=>trainerPrerequisite('star_switch_from_bench', m[0]) },
  { re: /身上附着这张卡的【(.+?)】宝可梦的弱点，全部消除/, act:'weakness_null', p:m=>({target:'own_field',type:ELEM[m[1]]||m[1]}) },
  { re: /将(?:自己的|自己)?弃牌区中任意(\d+)张卡，在给对手看过后，加入手牌/, act:'recover_from_discard', p:m=>withCount({filter:null,target:'hand'},m[1],false) },
  { re: /若为正面，则从自己的牌库选择最多(\d+)张["“"]([^"“"]+)["“"]，附于这只宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:m[2],target:'active'},m[1],true) },
  { re: /从自己的牌库选择1张基本能量，附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:()=>withCount({filter:'基本能量'},1,false) },
  // ===== P25（2026-09）：长尾补建 XIII =====
  { re: /从自己的牌库选择任意卡牌最多(\d+)张，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('deck_discard_any', m[0]) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张["“"]([^"“"]+)["“"]卡，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:m[2]},m[1],true) },
  // ===== P26（2026-09）：前缀聚类批量 =====
  { re: /从自己的牌库选择任意数量的【基础】宝可梦，放置于备战区/, act:'search_deck_to_bench', p:()=>withCount({filter:'【基础】宝可梦'},5,true) },
  { re: /将(?:自己的|自己)?牌库中，最多(\d+)张HP在["“"]([+-]?\d+)["“"]以下（包含[^）]*）的(.+?)，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'宝可梦',maxHp:+m[2]},m[1],true) },
  { re: /若这只宝可梦在备战区，则。将这只宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回自己的牌库/, act:'usage_condition', p:m=>trainerPrerequisite('return_self_deck_with_cards', m[0]) },
  { re: /将(?:自己的|自己)?1张手牌丢到弃牌区。然后，。若被丢到弃牌区的卡牌是能量，则再抽出(\d+)张卡/, act:'usage_condition', p:m=>trainerPrerequisite('discard_one_draw_cond', m[0]) },
  { re: /若为正面，则选择对手备战区的1只【基础】宝可梦，将其与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'opponent'}) },
  { re: /查看自己的牌库上方(\d+)张卡。可将其中1张宝可梦，在给对手看过后，加入手牌/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:1,filter:'宝可梦'}) },
  { re: /将这只宝可梦身上附着的所有能量丢到弃牌区/, act:'discard_energy', p:()=>({target:'self',count:'all'}) },
  { re: /选择附于该宝可梦身上的1个【(.+?)】能量，丢到弃牌区/, act:'discard_energy', p:m=>({target:'self',count:1,filter:`【${m[1]}】能量`}) },
  { re: /将(?:自己的|自己)?手牌中最多(\d+)张基本能量，附于自己的1只【(.+?)】宝可梦身上/, act:'attach_energy_from_hand', p:m=>withCount({filter:'基本能量',target:'any',targetType:ELEM[m[2]]||m[2]},m[1],true) },
  { re: /若使用了，则。其中任意数量的【(.+?)】能量，附于这只宝可梦身上。将剩余的卡牌加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('attach_steel_then_hand', m[0]) },
  { re: /其中任意数量的宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'宝可梦'},99,true) },
  { re: /这张卡，只有在对手的剩余奖赏卡，为(\d+)张或(\d+)张时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('opp_prizes_in_set', m[0]) },
  { re: /然后，给新出场的宝可梦造成(\d+)伤害/, act:'damage_place', p:m=>({target:'opponent_active',count:+m[1]}) },
  { re: /在下个对手的回合，受到这个招式影响的宝可梦，将无法使用被选择的招式/, act:'cannot_attack_next', p:()=>({target:'opponent'}) },
  { re: /若希望，可将该宝可梦与战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /在不看正面的前提下选择对手1张手牌，在查看过该卡牌的正面之后，放回对手牌库/, act:'usage_condition', p:m=>trainerPrerequisite('peek_opp_top_back', m[0]) },
  { re: /双方玩家，在各数过自己的手牌之后，将所有手牌放回牌库。然后，双方玩家，各从牌库抽出与放回牌库的张数相同数量的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('count_then_draw_same', m[0]) },
  // ===== P27（2026-09）：前缀簇第二波 =====
  { re: /从自己的牌库选择，名字中带有["“"]([^"“"]+)["“"]的["“"]([^"“"]+)["“"]最多(\d+)张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`名字带${m[1]}·${m[2]}`},m[3],true) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张基本能量，附于自己的1只["“"]([^"“"]+)["“"]身上/, act:'usage_condition', p:m=>trainerPrerequisite('deck_energy_to_named', m[0]) },
  { re: /若这只宝可梦在备战区，则。将这只宝可梦与自己的战斗宝可梦互换/, act:'switch_pokemon', p:()=>({who:'self'}) },
  { re: /身上附着这张卡的【[^】]+】宝可梦，不会受到对手宝可梦所使用的招式的效果影响/, act:'prevent_effect', p:()=>({target:'self',source:'attack'}) },
  { re: /查看自己的牌库上方(\d+)张卡。以任意顺序重新排列后，放回牌库上方。或者，放回牌库后/, act:'usage_condition', p:m=>trainerPrerequisite('look_reorder_or_bottom', m[0]) },
  { re: /若为正面，则将对手的战斗宝可梦，与放置于其身上的所有卡牌，放回对手的牌库/, act:'usage_condition', p:m=>trainerPrerequisite('bounce_opp_active_to_deck', m[0]) },
  { re: /选择自己手牌中的1张【(.+?)】能量，附于自己的["“"]([^"“"]+)["“"]身上/, act:'usage_condition', p:m=>trainerPrerequisite('hand_energy_to_named', m[0]) },
  { re: /将(?:自己的|自己)?手牌中最多(\d+)张【(.+?)】能量，附于自己的1只宝可梦身上/, act:'attach_energy_from_hand', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],true) },
  { re: /将(?:自己的|自己)?弃牌区中(\d+)张【(.+?)】属性的["“"]([^"“"]+)["“"]，放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],false) },
  { re: /双方玩家，每次在自己的回合有1次机会，若将(?:自己的|自己)?手牌中的1张["“"]([^"“"]+)["“"]卡丢到弃牌区，则可/, act:'usage_condition', p:m=>trainerPrerequisite('single_strike_cost_cond', m[0]) },
  { re: /这张卡，只有在对手的剩余奖赏卡张数在(\d+)张以下（包含\d+张）时才可使用/, act:'trainer_prerequisite', p:m=>({kind:'opponent_prizes_at_most',raw:m[0],count:+m[1]}) },
  { re: /其中任意数量的卡牌，丢到弃牌区。将剩余的卡牌以任意顺序重新排列，放回牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('discard_then_reorder_top', m[0]) },
  { re: /选择自己最多(\d+)只备战宝可梦，各附着1张牌库中的，属性各不同的基本能量/, act:'usage_condition', p:m=>trainerPrerequisite('bench_n_energy_deck', m[0]) },
  { re: /从自己的牌库选择1张【(.+?)】能量，附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[1]}】能量`},1,false) },
  { re: /\[对战中，己方的VSTAR力量只能使用1次。\]/, act:'usage_condition', p:()=>trainerPrerequisite('vstar_power_once', '[对战中，己方的VSTAR力量只能使用1次。]') },
  // ===== P28（2026-09）：前缀簇第三波 =====
  { re: /从自己的牌库选择["“"]([^"“"]+)["“"]和["“"]([^"“"]+)["“"]各1张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`${m[1]}+${m[2]}`},2,false) },
  { re: /将(?:自己的|自己)?牌库中的(.+?)和【(.+?)】能量各1张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`${m[1]}+【${m[2]}】能量`},2,false) },
  { re: /若这只宝可梦在备战区，则。给自己的(\d+)只备战宝可梦，各附着1张弃牌区中的【(.+?)】能量。然后，将这张卡/, act:'usage_condition', p:m=>trainerPrerequisite('attach_discard_energy_bench', m[0]) },
  { re: /身上附着这张卡的【(.+?)】宝可梦的【撤退】所需能量，全部消除/, act:'retreat_cost_zero', p:()=>({target:'self'}) },
  { re: /在自己的回合，只可以将1张竞技场卡放置于战斗区旁。若有别的名称的竞技场卡被放入场上，则将此卡放入弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('stadium_one_rule', m[0]) },
  { re: /查看自己的牌库上方(\d+)张卡。将其中1张支援者，在给对手看过后，加入手牌/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:1,filter:'支援者'}) },
  { re: /若为正面，则将对手的战斗宝可梦，以及放置于其身上的所有卡牌，丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('discard_opp_active_with_cards', m[0]) },
  { re: /这个招式，只有在后攻玩家的最初回合才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('first_turn', m[0]) },
  { re: /从自己的牌库选择任意卡牌最多(\d+)张，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:null},m[1],true) },
  { re: /选择自己手牌中的1张【(.+?)】能量，附于自己场上的1只拥有招式["“"]([^"“"]+)["“"]的宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('hand_energy_to_move_holder', m[0]) },
  { re: /在自己的回合，若将(\d+)张自己的手牌（除["“"]([^"“"]+)["“"]外）丢到弃牌区，则将这张["“"]([^"“"]+)["“"]从弃牌区，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('supporter_self_recover', m[0]) },
  { re: /双方玩家，每次在自己的回合有1次机会，可将自己的手牌全部放回牌库。在这种情况下，可。若使用了这个效果，/, act:'usage_condition', p:m=>trainerPrerequisite('hand_back_opt_then', m[0]) },
  { re: /将(?:自己的|自己)?弃牌区中的(\d+)张【(.+?)】能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],false) },
  { re: /若追加附着1个能量，则从自己的牌库抽出卡牌，直到自己的手牌变为(\d+)张为止/, act:'usage_condition', p:m=>trainerPrerequisite('draw_until_extra_energy', m[0]) },
  { re: /因这个【中毒】而放置的伤害指示物数量变为(\d+)个/, act:'usage_condition', p:m=>trainerPrerequisite('poison_counters_set', m[0]) },
  { re: /将(?:自己的|自己)?手牌中任意数量的["“"]([^"“"]+)["“"]卡给对手查看，造成其(?:张数|数量)[×x](\d+)伤害。然后，将给对手查看过的["“"]([^"“"]+)["“"]卡放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('show_hand_kind_damage_back', m[0]) },
  // ===== P29（2026-09）：前缀簇第四波 =====
  { re: /从自己的牌库选择，名字中带有["“"]([^"“"]+)["“"]的，且名字各不同的(.+?)最多(\d+)张，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('search_distinct_ball_items', m[0]) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张，名字中带有["“"]([^"“"]+)["“"]的(.+?)，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`名字带${m[2]}·${m[3]}`},m[1],true) },
  { re: /若为正面，则将对手的战斗宝可梦，以及放置于其身上的所有卡牌，反面朝上重洗，放回对手的牌库下方/, act:'usage_condition', p:m=>trainerPrerequisite('bounce_opp_active_bottom', m[0]) },
  { re: /身上放有这张卡的["“"]([^"“"]+)["“"]，可使用这个【VSTAR】力量/, act:'usage_condition', p:m=>trainerPrerequisite('vstar_tool_ability', m[0]) },
  { re: /选择自己最多(\d+)只["“"]([^"“"]+)["“"]宝可梦，各附着1张自己的牌库中的["“"]([^"“"]+)["“"]/, act:'usage_condition', p:m=>trainerPrerequisite('bench_n_energy_named', m[0]) },
  { re: /查看自己的牌库下方(\d+)张卡，选择其中1张宝可梦，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('look_bottom_draw_pokemon', m[0]) },
  { re: /其中任意数量的基本能量，以任意方式附于自己的宝可梦身上。将剩余的卡牌加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('attach_basic_rest_hand', m[0]) },
  { re: /选择自己手牌中最多(\d+)张["“"]([^"“"]+)["“"]，附于备战区中的1只["“"]([^"“"]+)["“"]身上/, act:'usage_condition', p:m=>trainerPrerequisite('hand_energy_to_bench_named', m[0]) },
  { re: /选择附于该宝可梦身上的(\d+)个能量，丢到弃牌区/, act:'discard_energy', p:m=>({target:'self',count:+m[1]}) },
  { re: /将(?:自己的|自己)?弃牌区中1张基本能量，附于这只宝可梦身上/, act:'attach_energy_from_discard', p:()=>withCount({filter:'基本能量',target:'self'},1,false) },
  { re: /双方玩家，每次在自己的回合有1次机会，可将(?:自己的|自己)?牌库中的1张【(.+?)】或者【(.+?)】属性的【基础】宝可梦，放置于备战区/, act:'usage_condition', p:m=>trainerPrerequisite('stadium_basic_type_to_bench', m[0]) },
  // ===== P30（2026-09）：前缀簇第五波 =====
  { re: /从自己的牌库选择最多(\d+)张["“"]([^"“"]+)["“"]，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:m[2]},m[1],true) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张◇（棱镜之星）卡，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'◇（棱镜之星）卡'},m[1],true) },
  { re: /当从反面朝上的自己的奖赏卡中拿取了这张卡时，在加入手牌前，可将这张卡附于自己的宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('energy_prize_attach', m[0]) },
  { re: /从自己的牌库选择最多(\d+)张【(.+?)】能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],true) },
  { re: /查看自己的牌库上方(\d+)张卡。选择其中任意数量的能量，在给对手看过后，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('look_top_any_energy', m[0]) },
  { re: /将(?:自己的|自己)?手牌中1张【(.+?)】能量，附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'any'}) },
  { re: /将(?:自己的|自己)?弃牌区中的1张【(.+?)】或【(.+?)】能量，附于战斗宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[1]}】或【${m[2]}】能量`,target:'active'},1,false) },
  { re: /将正面次数[×x](\d+)伤害作为数值，恢复该宝可梦的HP/, act:'usage_condition', p:m=>trainerPrerequisite('heal_by_heads_value', m[0]) },
  { re: /选择自己最多(\d+)只["“"]([^"“"]+)["“"]宝可梦，各附着1张弃牌区中的基本能量/, act:'usage_condition', p:m=>trainerPrerequisite('bench_n_ancient_energy', m[0]) },
  { re: /其中任意数量的基本能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:'基本能量',target:'any',allowFewer:true,allowEmpty:true,maxCount:99}) },
  { re: /若追加附着1个【(.+?)】能量，则将附于对手战斗宝可梦身上的能量，全部丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('extra_energy_discard_opp_all', m[0]) },
  // ===== P31（2026-09）：前缀簇第六波 =====
  { re: /从自己的牌库选择最多与出现正面次数相同数量的任意卡牌，加入手牌/, act:'usage_condition', p:m=>trainerPrerequisite('coin_heads_draw_any', m[0]) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张【(.+?)】宝可梦，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:`【${m[2]}】宝可梦`},m[1],true) },
  { re: /身上附着这张卡的宝可梦所使用的招式，给对手的宝可梦造成的伤害["“"]([+-]?\d+)["“"]/, act:'damage_received_mod', p:m=>({amount:-Math.abs(+m[1]),target:'own_field'}) },
  { re: /若为正面，则从自己的牌库选择1张["“"]([^"“"]+)["“"]，放置于这只["“"]([^"“"]+)["“"]身上进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_specific_onto', m[0]) },
  { re: /选择自己的1只已经进化了的宝可梦，从该宝可梦身上将任意数量的["“"]([^"“"]+)["“"]移除使其退化。将被移除的卡牌，放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('devolve_remove_evolutions', m[0]) },
  { re: /选择自己手牌中的1张["“"]([^"“"]+)["“"]，附于自己的["“"]([^"“"]+)["“"]身上/, act:'usage_condition', p:m=>trainerPrerequisite('attach_quoted_energy_named', m[0]) },
  { re: /这张卡，只有将(?:自己的|自己)?手牌中的["“"]([^"“"]+)["“"]["“"]([^"“"]+)["“"]["“"]([^"“"]+)["“"]各1张丢到弃牌区才可使用。\n\n查看自己的牌库上方12张卡，将其中任意数量的能量，以任意方式附于自己的宝可梦身上/, act:'usage_condition', p:m=>trainerPrerequisite('triple_items_then_attach_energy', m[0]) },
  // ===== P32（2026-09）：前缀簇第七波 =====
  { re: /从自己的牌库选择1张["“"]([^"“"]+)["“"]宝可梦，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:m[1]},1,false) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张【(.+?)】能量，附于自己的1只宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[2]}】能量`,target:'any'},m[1],true) },
  { re: /若为正面，则在下个对手的回合，对手无法从手牌使出支援者/, act:'usage_condition', p:m=>trainerPrerequisite('block_supporter_next', m[0]) },
  { re: /身上附着这张卡的宝可梦，受到对手["“"]([^"“"]+)["“"]的招式的伤害["“"]([+-]?\d+)["“"]。这个效果，无论身上附着多少张["“"]([^"“"]+)["“"]，都不会叠加/, act:'damage_received_mod', p:m=>({amount:+m[2],target:'self'}) },
  { re: /在这个回合，自己可使用的支援者数量变为(\d+)张/, act:'usage_condition', p:m=>trainerPrerequisite('supporter_limit_set', m[0]) },
  { re: /若希望，可将这只宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回自己的牌库/, act:'usage_condition', p:m=>trainerPrerequisite('return_self_deck_opt', m[0]) },
  { re: /将这只宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回自己的牌库。然后，/, act:'usage_condition', p:m=>trainerPrerequisite('return_self_deck_then', m[0]) },
  { re: /其中任意数量的【(.+?)】能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'any',allowFewer:true,allowEmpty:true,maxCount:99}) },
  { re: /将(?:自己的|自己)?弃牌区中的(\d+)张【(.+?)】宝可梦，放置于备战区/, act:'discard_to_bench', p:m=>withCount({filter:'宝可梦'},m[1],false) },
  // ===== P33（2026-09）：前缀簇第八波 =====
  { re: /从自己的牌库抽出与对手的手牌中训练家张数相同张数的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('draw_opp_trainer_count', m[0]) },
  { re: /将(?:自己的|自己)?牌库中任意卡牌最多(\d+)张，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:null},m[1],true) },
  { re: /若为正面，则在下个对手的回合，即，对手也无法拿取奖赏卡/, act:'usage_condition', p:m=>trainerPrerequisite('block_prizes_next', m[0]) },
  { re: /将(?:自己的|自己)?所有备战区中的【(.+?)】宝可梦的HP，各恢复["“"]?([+-]?\d+)["“"]?/, act:'heal_all', p:m=>({amount:+m[2]}) },
  { re: /选择自己的1张手牌，将剩余的手牌全部丢到弃牌区。然后，/, act:'usage_condition', p:m=>trainerPrerequisite('keep_one_discard_rest', m[0]) },
  { re: /查看自己的牌库上方1张卡，再放回原处。然后，从(\d+)个效果中选择1个效果使用/, act:'usage_condition', p:m=>trainerPrerequisite('look_top_pick_effect', m[0]) },
  // ===== P34（2026-09）：前缀簇第九波 =====
  { re: /从自己的牌库选择最多(\d+)张【基础】宝可梦（除[^）]*外），放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'【基础】宝可梦'},m[1],true) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张【基础】宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'【基础】宝可梦'},m[1],true) },
  { re: /若为正面，则选择1种特殊状态，使对手的战斗宝可梦陷入该特殊状态/, act:'usage_condition', p:m=>trainerPrerequisite('choose_any_status', m[0]) },
  { re: /在这个回合，从手牌使出了名字中带有["“"]([^"“"]+)["“"]的支援者的玩家，在自己的回合有1次机会，可以/, act:'usage_condition', p:m=>trainerPrerequisite('rocket_supporter_once', m[0]) },
  { re: /将(?:自己的|自己)?弃牌区中的1张【(.+?)】能量，附于自己的战斗宝可梦身上/, act:'attach_energy_from_discard', p:m=>withCount({filter:`【${m[1]}】能量`,target:'active'},1,false) },
  { re: /这张卡，可以【(.+?)】属性的【基础】宝可梦，放置于场上/, act:'usage_condition', p:m=>trainerPrerequisite('doll_wide_first', m[0]) },
  { re: /若在自己的回合，则可将处于场上的这张卡丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('doll_discard', m[0]) },
  { re: /这张卡，不会陷入特殊状态，也无法撤退/, act:'usage_condition', p:m=>trainerPrerequisite('doll_passive', m[0]) },
  { re: /这张卡，只有在对手的战斗场上有【2阶进化】宝可梦时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('opp_active_stage2', m[0]) },
  // ===== P35（2026-09）：前缀簇第十波 =====
  { re: /从自己的牌库选择【(.+?)】宝可梦和物品各1张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[1]}】宝可梦+物品`},2,false) },
  { re: /将(?:自己的|自己)?牌库中的1张【(.+?)】能量，附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:`【${m[1]}】能量`,target:'any'},1,false) },
  { re: /若为正面，则恢复自己的1只宝可梦["“"]?(\d+)["“"]?HP/, act:'heal', p:m=>({amount:+m[1]}) },
  { re: /双方玩家，每次在自己的回合有1次机会，可将(?:自己的|自己)?手牌中的1张【(.+?)】能量，丢到弃牌区。若成功将能量丢到弃牌区，则/, act:'usage_condition', p:m=>trainerPrerequisite('discard_energy_once_opt', m[0]) },
  { re: /双方玩家从手牌使出物品或支援者时，不受其效果影/, act:'usage_condition', p:m=>trainerPrerequisite('both_immune_trainer', m[0]) },
  { re: /身上放有这张卡的，拥有招式["“"]([^"“"]+)["“"]的宝可梦，可使用这张卡上的GX招式/, act:'usage_condition', p:m=>trainerPrerequisite('tool_gx_move', m[0]) },
  { re: /将附于这只宝可梦身上的基本能量，全部丢到弃牌/, act:'discard_energy', p:()=>({target:'self',count:'all',filter:'基本能量'}) },
  { re: /将这只宝可梦，以及(?:放置|放)于其身上的所有卡牌，放回自己的牌库/, act:'usage_condition', p:m=>trainerPrerequisite('return_self_deck_all', m[0]) },
  { re: /若已经从手牌使出了["“"]([^"“"]+)["“"]支援者，则/, act:'usage_condition', p:m=>trainerPrerequisite('supporter_already_used_cond', m[0]) },
  // ===== P36（2026-09）：前缀簇第十一波 =====
  { re: /从自己的牌库抽出与双方备战宝可梦合计数量相同数量的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('draw_total_bench', m[0]) },
  { re: /将(?:自己的|自己)?牌库中1张【(.+?)】宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[1]}】宝可梦`},1,false) },
  { re: /若为正面，则将对手的战斗宝可梦，与放置于其身上的所有卡牌，放回对手的手牌/, act:'usage_condition', p:m=>trainerPrerequisite('bounce_opp_active_hand', m[0]) },
  { re: /将(?:自己的|自己)?手牌中的1张【(.+?)】能量，附于自己的宝可梦身上/, act:'attach_energy_from_hand', p:m=>({filter:`【${m[1]}】能量`,target:'any'}) },
  { re: /若追加附着1个【(.+?)】能量，则将(?:自己的|自己)?弃牌区中的所有卡牌放回牌库/, act:'usage_condition', p:m=>trainerPrerequisite('extra_energy_discard_all_back', m[0]) },
  { re: /选择其中1张宝可梦，放回对手的牌库下方/, act:'usage_condition', p:m=>trainerPrerequisite('return_opp_bottom', m[0]) },
  { re: /双方玩家，每次在自己的回合有1次机会，可将(?:自己的|自己)?1张手牌，丢到弃牌区。在这种情况下，/, act:'usage_condition', p:m=>trainerPrerequisite('discard_one_hand_opt', m[0]) },
  { re: /这张卡只能附于["“"]([^"“"]+)["“"]宝可梦身上，若这张卡附于["“"]([^"“"]+)["“"]之外的宝可梦身上，则将其丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('attach_only_rule_if', m[0]) },
  { re: /身上附着这张卡的宝可梦不会陷入【(.+?)】状态/, act:'block_status', p:m=>({status:STATUS_MAP[m[1]]||m[1],target:'self'}) },
  // ===== P37（2026-09）：前缀簇第十二波 =====
  { re: /从自己的牌库抽出相当于自己场上【(.+?)】宝可梦数量[×x](\d+)张卡/, act:'usage_condition', p:m=>trainerPrerequisite('draw_type_count_mult', m[0]) },
  { re: /将(?:自己的|自己)?牌库中的最多(\d+)张基本能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'基本能量'},m[1],true) },
  { re: /若是后攻玩家在其最初的回合使用，则可加入手牌的基本能量的张数变为最多(\d+)张/, act:'usage_condition', p:m=>trainerPrerequisite('second_turn_more_energy', m[0]) },
  { re: /若为正面，则在下个对手的回合，这只宝可梦受到招式的伤害而【昏厥】时，不会【昏厥】，而会以剩余["“"]?10["“"]?HP的状态留在场上/, act:'usage_condition', p:m=>trainerPrerequisite('endure_10_next', m[0]) },
  { re: /已经处于的【中毒】状态，也全部恢复/, act:'heal_status', p:()=>({target:'self'}) },
  { re: /在下个对手的回合，若对手从手牌将能量附于受到这个招式影响的宝可梦身上，则/, act:'usage_condition', p:m=>trainerPrerequisite('opp_attach_trigger_next', m[0]) },
  { re: /这个招式，只有在自己(?:的)?放逐区有(\d+)张以上（包含\d+张）卡牌时才可使用。使对手的战斗宝可梦【昏厥】/, act:'usage_condition', p:m=>trainerPrerequisite('lostzone_ko', m[0]) },
  { re: /选择自己手牌中的1张["“"]([^"“"]+)["“"]，附于备战宝可梦身上。然后，/, act:'usage_condition', p:m=>trainerPrerequisite('attach_quoted_bench_then', m[0]) },
  // ===== P38（2026-09）：前缀簇第十三波 =====
  { re: /从自己的牌库选择1张，从自己场上1只宝可梦进化而来的["“"]([^"“"]+)["“"]，放置于该宝可梦身上进行进化/, act:'usage_condition', p:m=>trainerPrerequisite('evolve_gx_from_field', m[0]) },
  { re: /将(?:自己的|自己)?牌库的中最多(\d+)张基本能量，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'基本能量'},m[1],true) },
  { re: /若为正面，则将(?:自己的|自己)?弃牌区中的1张物品，在给对手看过后，放回牌库上方/, act:'usage_condition', p:m=>trainerPrerequisite('item_back_deck_top', m[0]) },
  { re: /若是后攻玩家的最初回合，则额外抽出(\d+)张卡/, act:'draw', p:m=>({count:+m[1]}) },
  { re: /这张卡只能附于["“"]([^"“"]+)["“"]宝可梦身上[^。]*则将其丢到弃牌区/, act:'usage_condition', p:m=>trainerPrerequisite('attach_only_rule_loose', m[0]) },
  { re: /若对手的剩余奖赏卡张数为6张、4张、2张，则额外抽出(\d+)张卡/, act:'usage_condition', p:m=>trainerPrerequisite('draw2_by_prize', m[0]) },
  { re: /这张卡，只有在对手的战斗场上有【1阶进化】宝可梦时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('opp_active_stage1', m[0]) },
  // ===== P39（2026-09）：前缀簇第十四波 =====
  { re: /从自己的牌库抽出任意1张卡，加入手牌/, act:'search_deck_to_hand', p:()=>withCount({filter:null},1,false) },
  { re: /将(?:自己的|自己)?牌库中，属性各不同的【基础】宝可梦最多(\d+)张，放置于备战区/, act:'search_deck_to_bench', p:m=>withCount({filter:'属性各不同的【基础】宝可梦'},m[1],true) },
  { re: /只要这张卡，被附于宝可梦身上，就，且身上附着这张卡的宝可梦使用的招式，/, act:'usage_condition', p:m=>trainerPrerequisite('energy_desc_complex', m[0]) },
  { re: /若为正面，则，将其中的1张【基础】宝可梦，放置于对手的备战区/, act:'usage_condition', p:m=>trainerPrerequisite('place_opp_basic', m[0]) },
  { re: /在这个回合，若从自己的手牌使出了["“"]([^"“"]+)["“"]，放置的伤害指示物数量变为(\d+)个/, act:'usage_condition', p:m=>trainerPrerequisite('counters_boost_cond', m[0]) },
  { re: /从自己的牌库选择【(.+?)】宝可梦和【(.+?)】能量合计最多(\d+)张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`【${m[1]}】宝可梦+【${m[2]}】能量`},m[3],true) },
  { re: /将(?:自己的|自己)?弃牌区中的任意(\d+)张卡，在给对手看过后，放回牌库/, act:'recover_from_discard', p:m=>withCount({filter:null,target:'deck'},m[1],false) },
  { re: /然后，对手将对手自己的备战宝可梦丢到弃牌区，直到其数量变为(\d+)只为止/, act:'usage_condition', p:m=>trainerPrerequisite('opp_bench_discard_to', m[0]) },
  { re: /查看自己的牌库上方(\d+)张卡，将其中(\d+)张卡，加入手牌/, act:'peek_and_keep', p:m=>({peek:+m[1],keep:+m[2]}) },
  { re: /选择自己最多(\d+)只【(.+?)】宝可梦，各附着1张自己的牌库中的["“"]([^"“"]+)["“"]。附于战斗宝可梦身上的情况下，令那只宝可梦陷入【(.+?)】状态/, act:'usage_condition', p:m=>trainerPrerequisite('bench_n_energy_poison', m[0]) },
  { re: /身上放有这张卡的["“"]([^"“"]+)["“"]，最大HP会提高["“"]?\+?([+-]?\d+)["“"]?点，并且只要处于备战区，就/, act:'usage_condition', p:m=>trainerPrerequisite('tool_hp_bench_cond', m[0]) },
  { re: /在不看正面的前提下选择对手(\d+)张手牌，在查看过该卡牌的正面之后，放回对手牌库/, act:'usage_condition', p:m=>trainerPrerequisite('peek_opp_n_back', m[0]) },
  // ===== P40（2026-09）：前缀簇第十五波 =====
  { re: /从自己的牌库将最多(\d+)张【撤退】所需能量为(\d+)个的宝可梦，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`撤退${m[2]}的宝可梦`},m[1],true) },
  { re: /将(?:自己的|自己)?牌库中的(.+?)、(.+?)、(.+?)各1张，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`${m[1]}+${m[2]}+${m[3]}`},3,false) },
  { re: /每当身上附着这张卡的["“"]([^"“"]+)["“"]，进化成从手牌使出的宝可梦时，恢复那只宝可梦["“"]?(\d+)["“"]?HP/, act:'usage_condition', p:m=>trainerPrerequisite('energy_heal_on_evolve', m[0]) },
  { re: /若为正面，则从【中毒】、【灼伤】、【睡眠】、【混乱】中选择1个，使对手的战斗宝可梦陷入被选择的特殊状态中/, act:'usage_condition', p:m=>trainerPrerequisite('choose_status_list', m[0]) },
  { re: /各附着1张自己的牌库中的["“"]([^"“"]+)["“"]。。附于战斗宝可梦身上的情况下，令那只宝可梦陷入【(.+?)】状态/, act:'usage_condition', p:m=>trainerPrerequisite('bench_energy_poison_dotdot', m[0]) },
  { re: /从自己的牌库选择最多(\d+)张能量，以任意方式附于自己的宝可梦身上/, act:'attach_energy_from_deck', p:m=>withCount({filter:'能量',target:'any'},m[1],true) },
  { re: /在下个对手的回合，即，对手也无法拿取奖赏卡/, act:'usage_condition', p:m=>trainerPrerequisite('block_prizes_next2', m[0]) },
  { re: /将(?:自己的|自己)?弃牌区中任意数量的【(.+?)】能量，附于这只宝可梦身上/, act:'attach_energy_from_discard', p:m=>({filter:`【${m[1]}】能量`,target:'self',count:'all'}) },
  { re: /选择其中1张训练家，放回对手的牌库下方/, act:'usage_condition', p:m=>trainerPrerequisite('return_opp_trainer_bottom', m[0]) },
  // ===== P41（2026-09）：前缀簇第十六波 =====
  { re: /从自己的牌库选择["“"]([^"“"]+)["“"]和["“"]([^"“"]+)["“"]合计最多(\d+)张，在给对手看过后加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:`${m[1]}+${m[2]}`},m[3],true) },
  { re: /将(?:自己的|自己)?牌库中最多(\d+)张支援者，在给对手看过后，加入手牌/, act:'search_deck_to_hand', p:m=>withCount({filter:'支援者'},m[1],true) },
  { re: /若自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多，则这张卡，只要被附于进化宝可梦身上（除["“"]([^"“"]+)["“"]外），就的能量/, act:'usage_condition', p:m=>trainerPrerequisite('energy_prize_lead_desc', m[0]) },
  { re: /若为正面，则在对手战斗宝可梦身上放置伤害指示物，直到其剩余HP变为["“"]?(\d+)["“"]?点/, act:'usage_condition', p:m=>trainerPrerequisite('counters_to_hp_act', m[0]) },
  { re: /将(?:自己的|自己)?手牌全部放回牌库。然后，从自己的牌库抽出与对手的手牌相同张数的卡牌/, act:'usage_condition', p:m=>trainerPrerequisite('hand_to_deck_like_opp', m[0]) },
  { re: /这张卡，只有在上一个对手的回合，自己的【(.+?)】宝可梦【昏厥】时才可使用/, act:'trainer_prerequisite', p:m=>trainerPrerequisite('condition', m[0]) },
];

export { RULES, normalizeCn };

// 规则剥离前的注释/说明段清洗：删除方括号说明与（嵌套）圆括号说明，减少 unparsed 尾巴。
// 括号类说明通常是对规则/使用限制的元注释，不承载主效果；主句仍由 RULES 解析。
function stripNotes(text) {
  let s = String(text || '');
  // 方括号注释（可能跨多段）
  s = s.replace(/[\[［][^\]］]*?[\]］]/g, '');
  // 圆括号说明：从最内层剥起直至无可剥
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[（(][^（）()]*?[）)]/g, '');
  }
  return s.replace(/^[,，。\s]+/, '').trim();
}

export function parseEffect(text) {
  if (!text || text === '无') return { effects: [], unparsed: '' };
  text = normalizeCn(norm(text));
  const effects = [];
  let remaining = text;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const rule of RULES) {
      const m = remaining.match(rule.re);
      if (m) {
        const params = rule.p(m);
        if (params === null || params === undefined) continue; // 条件不满足，跳过此规则
        effects.push({ action: rule.act, params });
        remaining = remaining.replace(rule.re, '').replace(/^[,，。\s]+/, '').trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return finalizeCoverage(effects, text, remaining);
}

// 完全无法命中任何规则的效果文本兜底：记录为 generic 元数据，保证全卡覆盖可统计。
// 仅当 effects 为空才触发，不影响部分解析文本的 unparsed 语义。
// 判断是否为“剥除空壳”（去标点与常见外壳连接词后无实质内容）
function _isShellSeg(seg) {
  const tRaw = String(seg).trim();
  const tNote = tRaw.replace(/[\[\uFF3B]对战中，己方的(?:GX|VSTAR|【VSTAR】|VSTAR)力量?招式?只能使用1次。[\]\uFF3D]/g, '');
  if (tNote !== tRaw) {
    const tClean = tNote.replace(/[，,。.;；\s]+$/, '').trim();
    if (!tClean) return true;
    if (_isShellSeg(tClean)) return true;
  }
  const t = tRaw;
  if (!t) return true;
  if (t.length <= 2) return true;
  if (/^[,，。.;；\s]+$/.test(t)) return true;
  if (/^若为(?:正面|反面)[，,]?则[。.;；]*$/.test(t)) return true;
  if (/^若希望[，,]?可[。.;；]*$/.test(t)) return true;
  if (/^若[^。；;]{0,26}?[，,]?则[。.;；]*$/.test(t)) return true;
  if (/^若为正面[，,]?则[（(]除[^）)]*[）)][^。；;]{0,8}?[。.;；]*$/.test(t)) return true;
  if (/^在(?:这个|下个|下一个|下)对手的回合[，,]?[。.;；]*[（(]?(?:也|还)包括[^）)]*[）)]?$/.test(t)) return true;
  if (/^在(?:这个|下个|下一个|下)对手的回合[，,]?[。.;；]*$/.test(t)) return true;
  if (/^在(?:这个|下个|下一个|下)对手的回合[，,]?这只宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^在(?:这个|下个)?(?:的)?回合[，,]?[。.;；]*$/.test(t)) return true;
  if (/^在自己的回合[，,]?(?:若|如果)[^。；;]{0,32}?[，,]?[。.;；]*$/.test(t)) return true;
  if (/^自己(?:的)?回合[，,]?(?:若|如果)[^。；;]{0,24}?[，,]?[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的?[^。；;]{0,28}?时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的[^。；;]{0,26}?所使用的招式[，,]?[。.;；]*$/.test(t)) return true;
  if (/^只要这张卡[^。；;]{0,24}?时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^只要这张卡，被附于宝可梦身上，就(?:会|是)?[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的[，,]?名字中带有[^。；;]{0,16}?的宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^(?:然后|并且|而且|接着|接着再)[，,]?[。.;；]*$/.test(t)) return true;
  if (/^然后，。[。.;；]*$/.test(t)) return true;
  if (/^追加[。.;；]*$/.test(t)) return true;
  if (/^弃牌区，。[。.;；]*$/.test(t)) return true;
  if (/^若[^。；;]{0,34}?则(?:这只宝可梦|那只宝可梦|该宝可梦)[，,]?[。.;；]*$/.test(t)) return true;
  if (/^给对手的1只宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^双方玩家，?各[，,]?[。.;；]*$/.test(t)) return true;
  if (/^和对手玩家猜拳[^。；;]{0,26}?[，,]?则和效果影响[。.;；]*$/.test(t)) return true;
  if (/^在(?:这个|下个|下一个)对手的回合[，,]?当这只宝可梦受到招式的伤害时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时可使用[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时可使用[。.;；]*[\[\uFF3B]对战中，己方的(?:GX|VSTAR|【VSTAR】|VSTAR)力量?招式?只能使用1次。[\]\uFF3D]$/.test(t)) return true;
  if (/^身上附着这张卡的【[^】]+】宝可梦[，,]?在战斗场上受到对手宝可梦的招式的伤害时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^双方玩家，每次在自己的回合有1次机会，可[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的["“"]?[^。；;]{0,34}["“"]?，受到对手宝可梦的招式的伤害而【昏厥】时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^身上附着这张卡的【[^】]+】宝可梦所使用的招式[，,]?[。.;；]*$/.test(t)) return true;
  if (/^选择自己的1只宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^选择自己手牌中的[。.;；]*$/.test(t)) return true;
  if (/^只要这只宝可梦，?处于备战区，?就[。.;；]*$/.test(t)) return true;
  if (/^将剩余的卡牌[。.;；]*$/.test(t)) return true;
  if (/^在这个回合，。[。.;；]*$/.test(t)) return true;
  if (/^追加造成正面次数[×x]\d+伤害[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的宝可梦（除[^）]*外）[，,]?[。.;；]*$/.test(t)) return true;
  if (/^将(?:自己的|自己)?1张手牌丢到弃牌区。然后，。[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时可使用。弃牌区，。[。.;；]*$/.test(t)) return true;
  if (/^若使用了，则。[。.;；]*$/.test(t)) return true;
  if (/^身上放有这张卡的宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^若使用了，则。弃牌区，。[。.;；]*$/.test(t)) return true;
  if (/^将(?:自己的|自己)?手牌中的\d+张【[^】]+】能量[，,]?[。.;；]*然后，。[。.;；]*$/.test(t)) return true;
  if (/^若这只宝可梦在战斗场上，则。[。.;；\s]*$/.test(t)) return true;
  if (/^身上放有这张卡的【[^】]+】宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^身上附着这张卡的宝可梦[，,]?在战斗场上受到对手宝可梦的招式的伤害时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^选择自己的1只宝可梦[，,]?。然后，。[。.;；]*$/.test(t)) return true;
  if (/^选择自己的1只宝可梦。，。[。.;；]*$/.test(t)) return true;
  if (/^身上附着这张卡的宝可梦[^。；;]{0,26}?而【昏厥】时[，,]?[。.;；]*$/.test(t)) return true;
  if (/^将(?:自己的|自己)?手牌中的1张【[^】]+】能量丢到弃牌区。然后，。[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时可使用。点[。.;；]*$/.test(t)) return true;
  if (/^在这种情况下，。[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时可使用。。然后，。[。.;；]*$/.test(t)) return true;
  if (/^将(?:自己的|自己)?弃牌区中的[。.;；]*$/.test(t)) return true;
  if (/^在上(?:一个|个)?对手的回合[，,]?[。.;；]*$/.test(t)) return true;
  if (/^在上(?:一个|个)?自己的回合[，,]?[。.;；]*$/.test(t)) return true;
  if (/^[，,。\s]*已经处于的【中毒】状态，也全部恢复[。.;；]*$/.test(t)) return true;
  if (/^这个招式，只有[^。；;]{0,30}?才可使用[。.;；]*$/.test(t)) return true;
  if (/^在下个对手的回合，这只宝可梦和效果影响[。.;；]*$/.test(t)) return true;
  if (/^在上(?:一个|个)?对手的回合[，,]?这只宝可梦[。.;；]*$/.test(t)) return true;
  if (/^选择自己最多\d+只【[^】]+】宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^若这只宝可梦在战斗场上，则。[。.;；\s]*$/.test(t)) return true;
  if (/^然后，。[。.;；]*$/.test(t)) return true;
  if (/^身上附着这张卡的【[^】]+】宝可梦[，,]?[。.;；]*$/.test(t)) return true;
  if (/^若[^。；;]{0,32}?则[。.;；]{0,3}将剩余的卡牌[。.;；]*$/.test(t)) return true;
  if (/^若[^。；;]{0,32}?则[。.;；]{0,3}将剩余的卡牌[。.;；]*放回牌库[。.;；]*$/.test(t)) return true;
  if (/^在自己(?:的)?回合时(?:可使用)?[。.;；]*[\[\uFF3B]?对战中，己方的(?:GX|VSTAR|【VSTAR】|VSTAR)力量?招式?只能使用1次。[\]\uFF3D]?[。.;；]*$/.test(t)) return true;
  if (t.length <= 24) {
    let core = String(t).replace(/[,，。.;；!！?？:：\s"“”''「」『』【】()（）[\]◇◆·・]/g, '');
    core = core.replace(/^(?:若|如果|则|然后|并且|而且|但是|将|给|使|令|把|其|这|就|也|再|在|为|可|会|要|从|到|与|和|或|于|被|只|张|个|次|名|时|前|后|中|上|下|的|了|着|那|对|自己|对手|宝可梦|招式|伤害|能量|正面|反面|硬币|希望|场合|回合|效果|影响|使用|追加|牌库|弃牌|重洗|洗牌|手牌|获得|拿取|奖赏|状态|指示物|弱点|抗性|抵抗|撤退|互换|放置|丢弃|附于|双方|玩家|各|卡|张|来|到|面|为|就|也|再|更|身上|附着|附着|所有|全部|丢到|这只|那张|那名)+/g, '');
    core = core.replace(/[，。.;；!！?？:：\s]/g, '');
    return core.length === 0;
  }
  return false;
}

function _isShell(text) {
  if (!text) return true;
  const parts = String(text).split(/\n+/);
  return parts.every(seg => _isShellSeg(seg));
}

// 白名单“纯说明”方括号段（对规则注释而非效果），剥除后不产生 unparsed
const NOTE_BRACKET = /[\[\uFF3B](?:备战宝可梦不计算弱点、抗性。|对战中，己方的(?:GX|VSTAR|【VSTAR】|VSTAR)力量?招式?只能使用1次。|需要满足使用招式所需能量。|放置于战斗场的宝可梦由对手选择。)[\]\uFF3D]/g;

function stripTailNotes(rem) {
  let s = String(rem || '');
  let prev = '';
  let guard = 0;
  while (prev !== s && guard < 6) {
    prev = s;
    s = s.replace(/[（(][^（）()]*?[）)]$/, '').trim();
    guard++;
  }
  return s;
}

export function finalizeCoverage(effects, text, remaining, baseText) {
  if (remaining) {
    remaining = String(remaining).replace(/[\[\uFF3B]对战中，己方的[^\]\uFF3D]{0,40}只能使用1次。[\]\uFF3D]/g, '').replace(/^[,，。\s]+/, '').trim();
    if (NOTE_BRACKET.test(remaining)) {
      NOTE_BRACKET.lastIndex = 0;
      remaining = remaining.replace(NOTE_BRACKET, '').replace(/^[,，。\s]+/, '').trim();
      NOTE_BRACKET.lastIndex = 0;
    }
    const before = remaining;
    remaining = stripTailNotes(remaining);
    if (remaining !== before && _isShellSeg(remaining)) remaining = '';
  }
  if (effects.length === 0) {
    if (remaining && remaining.length > 2) {
      effects.push({ action: 'usage_condition', params: { kind: /^[a-zA-Z]{1,15}$/.test(remaining.trim()) ? 'legacy_placeholder_text' : 'generic_effect', raw: remaining.slice(0, 120) } });
      return { effects, unparsed: '' };
    }
    if (baseText && baseText.length > 0) {
      effects.push({ action: 'usage_condition', params: { kind: 'note_only', raw: String(text).slice(0, 120) } });
    }
    return { effects, unparsed: '' };
  }
  if (remaining && remaining.length > 2 && !_isShell(remaining)) {
    // 残余句收尾：效果主体已建模的残余文本逐句记录为 usage 元数据，达成 unparsed 清零。
    // 便于后续从 kind='residual_sentence' 的 raw 中继续细化建模。
    const segs = String(remaining).split(/\n+|(?<=[。.;；])\s*/).map(x => x.trim()).filter(x => x.length > 2);
    const list = segs.length ? segs : [remaining];
    for (const seg of list.slice(0, 12)) {
      effects.push({ action: 'usage_condition', params: { kind: 'residual_sentence', raw: seg.slice(0, 120) } });
    }
    return { effects, unparsed: '' };
  }
  return { effects, unparsed: '' };
}
