// js/core/EffectExecutor.js — 异步执行指令 (v3 全效果)
import { PHASE, toCardRef } from './GameState.js';

export async function payDiscardCostFromHand(gs, pl, params = {}, options = {}) {
  const originalTrainerIndex = Number.isInteger(options.trainerHandIndex) ? options.trainerHandIndex : -1;
  const count = params.count === 'all' ? Math.max(0, pl.hand.length - (originalTrainerIndex >= 0 ? 1 : 0)) : (params.count || 1);
  if (count <= 0) return { ok: true, handIndex: originalTrainerIndex };

  const candidates = (pl.hand || [])
    .map((card, index) => ({ card, index }))
    .filter(item => item.index !== originalTrainerIndex)
    .filter(item => _cardMatchesFilter(gs, item.card, params.filter || null));

  if (candidates.length < count) {
    gs.addLog(`使用前提未满足：需要丢弃 ${count} 张匹配手牌`);
    return { ok: false, handIndex: originalTrainerIndex };
  }

  let selected = [];
  const shouldUsePicker = pl === gs.player1 && !options.auto && gs._onPendingPick;
  if (!shouldUsePicker || candidates.length <= count) {
    selected = candidates.slice(0, count);
  } else {
    const picked = await gs.waitForPick(candidates.map(c => _cardLabel(gs, c.card)), count, {
      source: 'trainer-discard-cost',
      filter: params.filter || null,
      prompt: '选择要作为使用费用丢弃的手牌',
      allowEmpty: false,
      required: true,
    });
    if (!picked || picked.length < count) {
      gs.addLog('使用前提未满足：未支付丢弃费用');
      return { ok: false, handIndex: originalTrainerIndex };
    }
    selected = picked.map(i => candidates[i]).filter(Boolean);
    const unique = new Map(selected.map(item => [item.index, item]));
    selected = [...unique.values()].slice(0, count);
    if (selected.length < count) {
      gs.addLog('使用前提未满足：丢弃费用选择无效');
      return { ok: false, handIndex: originalTrainerIndex };
    }
  }

  let adjustedTrainerIndex = originalTrainerIndex;
  // toLostZone：代价是「放于放逐区」（如「这张卡，只有将自己的1张手牌放于放逐区后才可使用」）
  const costZone = params.toLostZone ? (pl.lostZone = pl.lostZone || []) : pl.discard;
  for (const item of selected.sort((a, b) => b.index - a.index)) {
    costZone.push(pl.hand.splice(item.index, 1)[0]);
    if (item.index < adjustedTrainerIndex) adjustedTrainerIndex -= 1;
  }
  gs.addLog(params.toLostZone ? `支付费用：放逐 ${selected.length} 张手牌` : `支付费用：丢弃 ${selected.length} 张手牌`);
  return { ok: true, handIndex: adjustedTrainerIndex };
}

export class RequiredEffectFailed extends Error {
  constructor(action, reason = 'required_effect_failed') {
    super(reason);
    this.name = 'RequiredEffectFailed';
    this.action = action;
    this.requiredEffectFailed = true;
  }
}

function _effectIsRequired(eff, params = eff?.params || {}, options = {}) {
  if (!options.failRequired) return false;
  if (params.optional || params.allowEmpty || params.allowFewer || params.minCount === 0) return false;
  return params.required !== false;
}

function _requiredFailure(action, reason) {
  throw new RequiredEffectFailed(action, reason);
}

export async function executeEffects(gs, player, effects, options = {}) {
  if (!gs._triggerHandler) gs._triggerHandler = (event, payload) => _emitTriggers(gs, event, payload);
  // 供 GameState 结算「延迟到回合结束的效果」（endTurn 是同步的，这里异步执行、不阻塞）
  if (!gs._runEffects) gs._runEffects = (player, effects) => { try { Promise.resolve(executeEffects(gs, player, effects)).catch(() => {}); } catch (e) { /* 忽略 */ } };
  for (const eff of effects) {
    try {
      const fn = EXECUTORS[eff.action];
      if (fn) {
        await fn(gs, player, eff.params || {}, eff, options);
      } else {
        gs.addLog(`[未实现: ${eff.action}]`);
      }
    } catch (e) {
      gs.addLog(`[效果失败: ${eff.action}] ${e.message}`);
      if (options.propagateFailure || e?.requiredEffectFailed) throw e;
    }
  }
}

/**
 * 「造成其张数×N伤害」：伤害 = 本动作**实际移动的卡牌数** × N。
 * 卡面没有指定目标时，按规则打到对手的出战宝可梦。
 * 返回实际造成的伤害（0 表示这条卡面没有这个效果）。
 */
function _applyCountedDamage(gs, pl, p, movedCount) {
  const per = +((p && p.damagePerCard) || 0);
  if (!per || !movedCount) return 0;
  const opp = _opponent(gs, pl);
  if (!opp || !opp.active) return 0;
  const dmg = per * movedCount;
  _applyDamageToPokemon(gs, opp, opp.active, dmg);
  gs.addLog(`造成其张数×${per}＝${dmg} 伤害`);
  return dmg;
}

/**
 * 掷硬币的**唯一入口**（效果驱动的掷硬币都走这里）。
 * 集中处理「一树」类效果：「在这个回合，使用了这张卡后，首次由于招式、特性、训练家的效果
 * 自己掷硬币时，其第一次的结果，可由自己决定是正面还是反面。」
 * 注意：中毒/灼伤/睡眠的恢复判定不属于「招式/特性/训练家的效果」，不走这里。
 */
async function _flipCoin(gs, pl) {
  if (pl && pl.coinChoiceArmed) {
    pl.coinChoiceArmed = false;
    if (pl === gs.player1 && gs._onPendingPick) {
      const picked = await gs.waitForPick(['正面', '反面'], 1, {
        source: 'coin-choice', prompt: '选择这次硬币的结果', minCount:1, maxCount:1,
      });
      const heads = (picked?.[0] ?? 0) === 0;
      gs.addLog(`（一树）本次硬币结果选为${heads ? '正面' : '反面'}`);
      return heads;
    }
    // 自动决策（AI/无 UI）：按正面处理（对使用者有利）
    gs.addLog('（一树）本次硬币结果按正面处理');
    return true;
  }
  return Math.random() < 0.5;
}

/**
 * 附能后发出 energy_attached 事件，供「每次将【X】能量附着于这只宝可梦身上时」这类触发式效果。
 * 约定：
 *   · 只有「附着」才发事件；**能量在宝可梦之间移动不算附着**（那些地方不调本函数）
 *   · fromHand 必须如实传 —— 卡面写「从自己的手牌将…附着」的特性只认 fromHand:true
 *   · 逐张发一次，多张附能触发多次（与卡面「每次…时」一致）
 *   · 卡名要经过 resolver 解析：牌库/弃牌区里存的是卡 id，直接比较会漏（能量筛选条件用得上）
 */
function _emitEnergyAttached(gs, owner, mon, cards, fromHand) {
  if (!mon || !cards || !cards.length) return;
  for (const c of cards) {
    const resolved = (c && typeof c === 'object') ? c : (gs?.cardResolver?.getCard?.(c) || null);
    const name = resolved?.name || (typeof c === 'string' ? c : '') || '';
    try { gs.emitTriggerEvent?.('energy_attached', { target: mon, owner, fromHand: !!fromHand, cardName: String(name) }); }
    catch (e) { /* 触发失败不影响附能本身 */ }
  }
}

/** 道具显示名（与 GameState._toolLabel 同义，这里是模块级实现，供执行器使用） */
function _toolLabelOf(gs, tool) {
  if (!tool) return '道具';
  return tool.name || (typeof tool === 'string' ? tool : '道具');
}

/** 返回宝可梦在己方场上的槽位名（'active' / 'bench-N'），不在场上返回 null */
function _slotOfMon(pl, mon) {
  if (!pl || !mon) return null;
  if (pl.active === mon) return 'active';
  const i = (pl.bench || []).indexOf(mon);
  return i >= 0 ? `bench-${i}` : null;
}

function _toolCardValue(tool) {
  return (tool && typeof tool === 'object') ? (tool.cardId || tool.id || tool.name || tool) : tool;
}

function _returnAttachedCardsToHand(pl, mon, withAttachments = false) {
  if (!withAttachments) {
    pl.hand.push(mon.cardId);
    return;
  }

  const hasEnergy = Array.isArray(mon.energy) && mon.energy.length > 0;
  if (hasEnergy) {
    for (const energy of mon.energy) pl.hand.push(_toolCardValue(energy));
    mon.energy = [];
    if (mon.tool) {
      pl.hand.push(_toolCardValue(mon.tool));
      mon.tool = null;
    }
    pl.hand.push(mon.cardId);
    return;
  }

  pl.hand.push(mon.cardId);
  if (Array.isArray(mon.energy)) mon.energy = [];
  if (mon.tool) {
    pl.hand.push(_toolCardValue(mon.tool));
    mon.tool = null;
  }
}

// === 选卡 UI 交互 ===
async function _pickCards(gs, pl, cards, count, options = {}) {
  const n = Math.min(count || 1, (cards || []).length);
  if (n <= 0) return [];
  if (pl !== gs.player1 || options.auto || !gs._onPendingPick) return Array.from({ length: n }, (_, i) => i);
  const pick = await gs.waitForPick(cards, n, options);
  return pick;
}

function _selectionLimit(count, available, options = {}) {
  const requested = count === 'all' ? available : (Number.isFinite(options.maxCount) ? options.maxCount : (Number.isFinite(count) ? count : 1));
  const max = Math.max(0, Math.min(requested, available));
  const allowEmpty = !!options.allowEmpty || !!options.optional;
  const allowFewer = allowEmpty || !!options.allowFewer || Number.isFinite(options.maxCount);
  let min;
  if (Number.isFinite(options.minCount)) min = options.minCount;
  else if (Number.isFinite(options.requiredMin)) min = options.requiredMin;
  else if (allowEmpty) min = 0;
  else if (allowFewer) min = max > 0 ? 1 : 0;
  else min = max;
  min = Math.max(0, Math.min(min, max));
  return { max, min, allowEmpty, allowFewer };
}

async function _pickCardsFromZone(gs, actingPlayer, owner, zoneCards, count, options = {}) {
  const filter = options.filter || null;
  const candidates = (zoneCards || []).map((card, index) => ({ card, index })).filter(item => !options.excludeIndices?.includes?.(item.index)).filter(item => _cardMatchesFilter(gs, item.card, filter));
  const limit = _selectionLimit(count, candidates.length, options);
  if (limit.max <= 0) {
    // 规则：检索/查看类效果「没有合法候选」时视为空发（卡已发动但不拿卡），不算失败；
    // 只有玩家在有候选的情况下取消/未选够（下方 required_pick_cancelled）才回滚。
    return [];
  }
  const shouldUsePicker = actingPlayer === gs.player1 && !options.auto && gs._onPendingPick;
  if (!shouldUsePicker) return candidates.slice(0, limit.max);
  if (candidates.length <= limit.max && !limit.allowFewer) return candidates.slice(0, limit.max);
  const picked = await gs.waitForPick(candidates.map(c => _cardLabel(gs, c.card)), limit.max, { ...options, maxCount:limit.max, minCount:limit.min, allowFewer:limit.allowFewer, allowEmpty:limit.allowEmpty });
  const selected = (picked || []).map(i => candidates[i]).filter(Boolean).slice(0, limit.max);
  if (selected.length < limit.min) {
    if (options.failRequired && limit.min > 0 && !limit.allowEmpty && !limit.allowFewer && !options.optional) _requiredFailure(options.requiredAction || 'pick_cards', 'required_pick_cancelled');
    return [];
  }
  return selected;
}
function _resolveZoneCard(gs, card) {
  const fromObject = card && typeof card === 'object';
  const resolver = gs?.cardResolver;
  let info = null;
  let full = fromObject ? card : null;
  if (!fromObject && resolver) {
    try { info = resolver.getInfo?.(card) || null; } catch(e) { info = null; }
    try { full = resolver.getCard?.(card) || null; } catch(e) { full = null; }
  }
  const label = String(fromObject ? (card.name || card.cardId || JSON.stringify(card)) : (full?.name || info?.name || card));
  const resolved = !!(fromObject || full || (info && info.type && info.type !== 'unknown'));
  const cardType = String(full?.cardType || card?.cardType || info?.type || card?.type || card?.supertype || '').toLowerCase();
  const trainerType = String(full?.trainerType || card?.trainerType || card?.subtype || card?.subtypes || info?.type || '').toLowerCase();
  const element = full?.element || card?.element || null;
  return { original: card, label, cardType, trainerType, element, resolved, full, info };
}
function _cardLabel(gs, card) { return _resolveZoneCard(gs, card).label; }
function _cardMatchesFilter(gs, card, filter) {
  if (!filter) return true;
  if (typeof filter === 'function') return filter(card);
  if (filter && typeof filter === 'object') {
    const textFilter = filter.filter ?? filter.text ?? null;
    if (textFilter && !_cardMatchesFilter(gs, card, textFilter)) return false;
    const meta = _resolveZoneCard(gs, card);
    if (Number.isFinite(filter.maxHp) && _pokemonCardHp(meta, card) > filter.maxHp) return false;
    if (filter.nonRuleBox && _isRuleBoxPokemon(meta, card)) return false;
    return true;
  }
  const meta = _resolveZoneCard(gs, card);
  const text = meta.label;
  const f = String(filter).replace(/["“”]/g, '').replace(/\d+张/g, '').replace(/\s+/g, '').trim();
  const trainerSubtype = _trainerSubtypeWanted(f);
  if (trainerSubtype) return _isTrainerSubtypeMeta(meta, trainerSubtype);
  const wantsPokemon = f.includes('宝可梦') || /pokemon/i.test(f);
  const wantsEnergy = f.includes('能量');
  const wantsBasic = f.includes('基本') || f.includes('基础');
  const wantsSpecial = f.includes('特殊');
  const typeMatches = [...f.matchAll(/【(.+?)】/g)].map(m => m[1]);
  const hasEnergyClause = wantsEnergy || wantsBasic || wantsSpecial;

  if (/^(基础|基本)$/.test(f)) return _isBasicPokemonCard(gs, card);

  if (!f || text.includes(f)) {
    if (wantsPokemon && hasEnergyClause) {
      return _pokemonMatchesFilter(gs, card, meta, f, typeMatches) || _energyMatchesFilter(meta, f, typeMatches, wantsEnergy, wantsBasic, wantsSpecial);
    }
    if (wantsPokemon) return _pokemonMatchesFilter(gs, card, meta, f, typeMatches);
    if (hasEnergyClause || typeMatches.length > 0) return _energyMatchesFilter(meta, f, typeMatches, wantsEnergy, wantsBasic, wantsSpecial);
    return true;
  }

  if (wantsPokemon && hasEnergyClause) {
    return _pokemonMatchesFilter(gs, card, meta, f, typeMatches) || _energyMatchesFilter(meta, f, typeMatches, wantsEnergy, wantsBasic, wantsSpecial);
  }
  if (wantsPokemon) return _pokemonMatchesFilter(gs, card, meta, f, typeMatches);
  if (hasEnergyClause || typeMatches.length > 0) return _energyMatchesFilter(meta, f, typeMatches, wantsEnergy, wantsBasic, wantsSpecial);
  return false;
}
function _trainerSubtypeWanted(f) {
  if (/宝可梦道具|pokemon\s*tool|\btool\b/i.test(f)) return 'tool';
  if (/支援者|supporter/i.test(f)) return 'supporter';
  if (/竞技场|stadium/i.test(f)) return 'stadium';
  if (/物品|\bitem\b/i.test(f)) return 'item';
  return null;
}
function _isTrainerSubtypeMeta(meta, subtype) {
  const cardType = String(meta.cardType || '').toLowerCase();
  const trainerType = String(meta.trainerType || '').toLowerCase();
  const infoType = String(meta.info?.type || '').toLowerCase();
  const label = String(meta.label || '').toLowerCase();
  const trainerTypes = ['item','supporter','stadium','tool'];
  const knownNonTrainer = /pokemon|pokémon|宝可梦|energy|能量/.test(cardType) || ['pokemon','energy','specialenergy'].includes(infoType);
  const knownTrainer = /trainer|训练/.test(cardType) || trainerTypes.includes(trainerType) || trainerTypes.includes(infoType);
  if (!knownTrainer) {
    if (knownNonTrainer) return false;
    // Unresolved string labels may still carry subtype tags from converted text fixtures.
    if (subtype === 'tool' && /宝可梦道具|pokemon\s*tool|\btool\b/i.test(label)) return true;
    if (subtype === 'supporter' && /支援者|supporter/i.test(label)) return true;
    if (subtype === 'stadium' && /竞技场|stadium/i.test(label)) return true;
    if (subtype === 'item' && /物品|\bitem\b/i.test(label)) return true;
    return false;
  }
  if (trainerType === subtype || infoType === subtype) return true;
  if (subtype === 'tool' && /宝可梦道具|pokemon\s*tool|\btool\b/i.test(label)) return true;
  if (subtype === 'supporter' && /支援者|supporter/i.test(label)) return true;
  if (subtype === 'stadium' && /竞技场|stadium/i.test(label)) return true;
  if (subtype === 'item' && /物品|\bitem\b/i.test(label)) return true;
  return false;
}
function _pokemonMatchesFilter(gs, card, meta, f, typeMatches) {
  if (!_isPokemonCard(gs, card)) return false;
  const maxHp = _maxHpFromFilter(f);
  if (Number.isFinite(maxHp) && _pokemonCardHp(meta, card) > maxHp) return false;
  if (/拥有规则的宝可梦.*?除外|规则.*?除外/.test(f) && _isRuleBoxPokemon(meta, card)) return false;
  if ((/【(?:基础|基本)】\s*宝可梦|(?:基础|基本)宝可梦/.test(f)) && !_isBasicPokemonCard(gs, card)) return false;
  const pokemonTypeMatches = _pokemonClauseTypes(f, typeMatches);
  if (!pokemonTypeMatches.length) return true;
  return pokemonTypeMatches.some(t => _metaHasPokemonType(meta, t));
}
function _maxHpFromFilter(f) {
  const m = String(f || '').match(/HP(?:为)?[「"]?(\d+)[」"]?以下/);
  return m ? +m[1] : null;
}
function _pokemonCardHp(meta, card) {
  const hp = meta.full?.hp ?? card?.hp ?? meta.info?.hp;
  const n = typeof hp === 'number' ? hp : parseInt(String(hp || ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function _pokemonClauseTypes(f, typeMatches) {
  const validTypes = typeMatches.filter(t => !_isNonElementQualifier(t));
  const types = [];
  for (const m of f.matchAll(/【(.+?)】[^与或,，。]*宝可梦/g)) {
    if (!_isNonElementQualifier(m[1])) types.push(m[1]);
  }
  return types.length ? types : validTypes;
}
function _isNonElementQualifier(value) {
  return /^(基础|基本|进化|一阶|1阶|二阶|2阶|太晶|规则)$/i.test(String(value || '').trim());
}
function _isRuleBoxPokemon(meta, card) {
  if (meta.full?.hasRuleBox || card?.hasRuleBox || meta.full?.isEx || card?.isEx || meta.full?.isRadiant || card?.isRadiant) return true;
  const raw = `${meta.label || ''} ${meta.full?.ruleBox || ''} ${meta.full?.ruleText || ''} ${meta.full?.rule2Text || ''} ${card?.ruleBox || ''} ${card?.ruleText || ''} ${card?.rule2Text || ''} ${(meta.full?.tags || []).join(' ')} ${(card?.tags || []).join(' ')}`;
  if (/拥有规则的宝可梦|规则宝可梦|光辉宝可梦|太晶|\b(rule\s*box|pokemon\s+with\s+a\s+rule\s+box)\b/i.test(raw)) return true;
  return /(?:宝可梦)?(?:ex|EX|GX|V|VMAX|VSTAR|BREAK)\b/.test(raw) || /(?:ex|EX|GX|V|VMAX|VSTAR|BREAK)(?:宝可梦)?/.test(raw);
}
function _metaHasPokemonType(meta, cnType) {
  if (meta.label.includes(`【${cnType}】`)) return true;
  const map = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting','恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };
  const want = map[cnType] || cnType;
  return meta.element === cnType || meta.element === want;
}
function _isEnergyCard(gs, card, filter = null) {
  const meta = _resolveZoneCard(gs, card);
  if (!_isEnergyMeta(meta) && !meta.label.includes('能量')) return false;
  if (filter) {
    const f = String(filter).replace(/["“”]/g, '').trim();
    const typeMatches = [...f.matchAll(/【(.+?)】/g)].map(m => m[1]);
    return _energyMatchesFilter(meta, f, typeMatches, f.includes('能量'), f.includes('基本'), f.includes('特殊'));
  }
  return true;
}
function _energyMatchesFilter(meta, f, typeMatches, wantsEnergy, wantsBasic, wantsSpecial) {
  if (!_isEnergyMeta(meta) && !meta.label.includes('能量')) return false;
  if (wantsEnergy && !_isEnergyMeta(meta) && !meta.label.includes('能量')) return false;
  if (wantsBasic && !_isBasicEnergyMeta(meta)) return false;
  if (wantsSpecial && !_isSpecialEnergyMeta(meta)) return false;
  const energyTypes = typeMatches.filter(t => !_isNonElementQualifier(t));
  if (energyTypes.length && !energyTypes.some(t => _metaHasEnergyType(meta, t))) return false;
  return true;
}
function _isEnergyMeta(meta) { return /energy|能量/.test(meta.cardType) || /energy|能量/.test(meta.trainerType) || meta.info?.type === 'energy' || meta.info?.type === 'specialEnergy'; }
function _isBasicEnergyMeta(meta) { return meta.info?.type === 'energy' || meta.cardType === 'energy' || (meta.label.includes('基本') && meta.label.includes('能量')); }
function _isSpecialEnergyMeta(meta) { return meta.info?.type === 'specialEnergy' || meta.cardType === 'specialenergy' || (meta.label.includes('特殊') && meta.label.includes('能量')); }
function _isSpecialEnergyAttachment(gs, energy) {
  const meta = _resolveZoneCard(gs, energy);
  if (_isSpecialEnergyMeta(meta)) return true;
  if (_isBasicEnergyMeta(meta)) return false;
  const value = _toolCardValue(energy);
  const text = String(value ?? energy);
  return text.includes('特殊') || !text.includes('基本');
}
function _metaHasEnergyType(meta, cnType) {
  if (meta.label.includes(`【${cnType}】`) || meta.label.includes(cnType)) return true;
  const map = { '草':'grass','火':'fire','水':'water','雷':'lightning','斗':'fighting','恶':'dark','钢':'metal','超':'psychic','无':'colorless','龙':'dragon','妖':'fairy' };
  const want = map[cnType] || cnType;
  if (meta.element === cnType || meta.element === want) return true;
  return (meta.full?.provides || []).some(p => (p.types || []).includes(want) || (p.types || []).includes('any'));
}
function _isPokemonCard(gs, card) {
  const nonPokemonLabelPattern = /宝可梦道具|能量|支援者|物品|道具|竞技场|训练家|trainer|supporter|item|stadium|energy|tool/i;
  const meta = _resolveZoneCard(gs, card);
  const cardType = meta.cardType;
  if (cardType.includes('energy') || cardType.includes('trainer') || cardType.includes('能量') || cardType.includes('训练')) return false;
  const trainerType = meta.trainerType;
  if (/supporter|item|stadium|tool|支援者|物品|道具|竞技场|训练家/i.test(trainerType)) return false;
  if (cardType.includes('pokemon') || cardType.includes('宝可梦') || cardType.includes('pokémon') || meta.info?.type === 'pokemon') return true;
  const text = meta.label;
  if (nonPokemonLabelPattern.test(text)) return false;
  const lower = text.toLowerCase();
  if (text.includes('宝可梦') || lower.includes('pokemon') || lower.includes('pokémon')) return true;
  // 未解析的值：只有「像个 ID」时才保留宽容回退（历史行为）。
  // 中文卡名不能当作宝可梦 —— 否则弃牌区里的卡名（如「夜间担架」）会被误认为合法目标而回收。
  const looksLikeId = !/[\u4e00-\u9fa5]/.test(text) && !/\s/.test(text);
  return !meta.resolved && looksLikeId;
}
function _isBasicPokemonCard(gs, card) {
  if (!_isPokemonCard(gs, card)) return false;
  const meta = _resolveZoneCard(gs, card);
  if (!meta.resolved) return false;
  const stage = String(meta.full?.stage || card?.stage || '').trim();
  const evolvesFrom = meta.full?.evolvesFrom || card?.evolvesFrom || null;
  if (evolvesFrom) return false;
  if (!stage) return meta.info?.type === 'pokemon' || meta.full?.cardType === 'pokemon' || card?.cardType === 'pokemon';
  return stage === '基础' || /^basic$/i.test(stage);
}
function _makeBenchPokemonFromCard(gs, cid) {
  const meta = _resolveZoneCard(gs, cid);
  const cd = meta.full && meta.full.cardType === 'pokemon' ? meta.full : (cid?.cardType === 'pokemon' ? cid : null);
  const name = cd?.name || meta.info?.name || meta.label || '宝可梦';
  const hp = cd?.hp || 60;
  return {
    cardId: cid,
    name,
    hp,
    maxHp: hp,
    element: cd?.element || 'colorless',
    weakness: cd?.weakness || null,
    resistance: cd?.resistance || null,
    attacks: cd?.attacks || [{ name: '撞击', damage: 20, cost: [], effect: '' }],
    energy: [],
    status: null,
    placedThisTurn: true,
    tool: null,
    ability: cd?.ability || null,
    stage: cd?.stage || '基础',
    evolvesFrom: cd?.evolvesFrom || null,
    ruleText: cd?.ruleText || '',
    rule2Text: cd?.rule2Text || '',
    ruleBox: cd?.ruleBox || '',
    isEx: !!cd?.isEx,
    isRadiant: !!cd?.isRadiant,
    hasRuleBox: !!cd?.hasRuleBox,
    abilityUsed: false,
    abilityDisabled: false,
    abilityDisabledBy: null,
    damageMod: 0,
    preventDamage: false,
    preventEffect: false,
    cannotAttackNext: false,
    cannotRetreat: false,
    ignore: [],
    costEliminated: false,
    retreatCost: cd?.retreatCost ?? 1,
  };
}

// === 辅助 ===
function _opponent(gs, pl) { return pl === gs.player1 ? gs.player2 : gs.player1; }
function _applyStatus(mon, statuses) {
  if (!mon || !statuses || !statuses.length) return;
  const cur = mon.status ? mon.status.split(',') : [];
  for (const s of statuses) { if (!cur.includes(s)) cur.push(s); }
  mon.status = cur.join(',') || null;
}
function _getMon(pl, slot) {
  if (slot === 'active') return pl.active;
  if (slot?.startsWith('bench-')) return pl.bench[parseInt(slot.replace('bench-', ''))];
  return null;
}
function _monSlot(pl, mon) {
  if (pl.active === mon) return 'active';
  const i = pl.bench.indexOf(mon);
  return i >= 0 ? `bench-${i}` : null;
}
function _attachedEnergyItems(gs, owner, mon, slot, filter) {
  return (mon?.energy || []).map((energy, energyIndex) => ({ owner, mon, slot, energy, energyIndex })).filter(item => _isEnergyCard(gs, item.energy, filter));
}
async function _pickAttachedEnergy(gs, actingPlayer, items, count, options = {}) {
  const limit = _selectionLimit(count, items.length, options);
  if (limit.max <= 0) return [];
  if (actingPlayer !== gs.player1 || options.auto || !gs._onPendingPick) return items.slice(0, limit.max);
  if (items.length <= limit.max && !limit.allowFewer) return items.slice(0, limit.max);
  const picked = await gs.waitForPick(items.map(i => _cardLabel(gs, i.energy)), limit.max, { source:'attached-energy', ...options, maxCount:limit.max, minCount:limit.min, allowFewer:limit.allowFewer, allowEmpty:limit.allowEmpty });
  const selected = (picked || []).map(i => items[i]).filter(Boolean).slice(0, limit.max);
  return selected.length >= limit.min ? selected : [];
}
function _removeAttachedEnergy(selected) {
  const byMon = new Map();
  for (const item of selected) {
    if (!byMon.has(item.mon)) byMon.set(item.mon, []);
    byMon.get(item.mon).push(item);
  }
  const removed = [];
  for (const items of byMon.values()) {
    items.sort((a,b)=>b.energyIndex-a.energyIndex);
    for (const item of items) removed.push({ ...item, energy:item.mon.energy.splice(item.energyIndex, 1)[0] });
  }
  return removed;
}
function _pushEnergyDiscard(owner, energy) { owner.discard.push(toCardRef(energy)); }
function _slotsForPokemonPick(pl, options = {}) {
  const slots = [];
  if (options.allowActive !== false && pl.active) slots.push('active');
  if (options.allowBench !== false) {
    for (let i = 0; i < pl.bench.length; i++) if (pl.bench[i]) slots.push(`bench-${i}`);
  }
  return slots;
}
async function _pickPokemonTarget(gs, actingPlayer, targetPlayer, options = {}) {
  const slots = _slotsForPokemonPick(targetPlayer, options);
  const eligibleSlots = typeof options.slotFilter === 'function'
    ? slots.filter(slot => options.slotFilter(slot, targetPlayer))
    : slots;
  if (!slots.length || !eligibleSlots.length) {
    if (options.failRequired && !options.optional && !options.allowEmpty) _requiredFailure(options.requiredAction || 'pokemon_pick', 'required_no_target');
    return null;
  }
  const choosingPlayer = options.chooser || actingPlayer;
  if (eligibleSlots.length === 1 || choosingPlayer !== gs.player1 || options.auto || !gs._onPendingPokemonPick) return eligibleSlots[0];
  const slot = await gs.waitForPokemonPick(targetPlayer, {
    mode: options.mode || 'target',
    side: options.side || (targetPlayer === actingPlayer ? 'self' : 'opponent'),
    chooser: choosingPlayer === targetPlayer ? 'target' : 'acting',
    allowActive: options.allowActive !== false,
    allowBench: options.allowBench !== false,
    selectableSlots: eligibleSlots,
    prompt: options.prompt || '选择宝可梦',
  });
  if (!eligibleSlots.includes(slot)) {
    if (options.failRequired && !options.optional && !options.allowEmpty) _requiredFailure(options.requiredAction || 'pokemon_pick', 'required_pokemon_pick_cancelled');
    return null;
  }
  return slot;
}
function _slotHasMatchingAttachedEnergy(gs, owner, slot, filter) {
  const mon = _getMon(owner, slot);
  return _attachedEnergyItems(gs, owner, mon, slot, filter).length > 0;
}
function _monMatchesType(mon, type) {
  if (!type) return true;
  return mon?.element === type;
}
function _ownFieldTypeCount(pl) {
  return new Set([pl.active, ...(pl.bench || [])].filter(Boolean).map(mon => mon.element || 'colorless')).size;
}
function _isBasicMon(gs, mon) {
  const card = mon?.cardId ? gs.cardResolver?.getCard?.(mon.cardId) : null;
  return !card || !card.evolvesFrom && (!card.stage || card.stage === '基础');
}
function _allResolvedCards(gs) {
  const rawIds = Object.keys(gs.cardResolver?.raw || {});
  return rawIds.map(id => ({ id, card:gs.cardResolver.getCard?.(id) })).filter(x => x.card);
}
function _basicCanRareCandyTo(gs, mon, stage2) {
  if (!_isBasicMon(gs, mon) || !stage2?.evolvesFrom) return false;
  for (const item of _allResolvedCards(gs)) {
    const mid = item.card;
    if (mid?.cardType === 'pokemon' && mid.name === stage2.evolvesFrom && mid.evolvesFrom === mon.name) return true;
  }
  return false;
}
function _applyEvolutionToMon(gs, mon, cd, evolvedThisTurn = true) {
  const dmg = mon.maxHp - mon.hp;
  mon.name = cd.name; mon.maxHp = cd.hp; mon.hp = Math.max(cd.hp - dmg, 10);
  mon.stage = cd.stage || mon.stage; mon.evolvesFrom = cd.evolvesFrom || null;
  mon.ruleText = cd.ruleText || ''; mon.rule2Text = cd.rule2Text || ''; mon.ruleBox = cd.ruleBox || '';
  mon.isEx = !!cd.isEx; mon.isRadiant = !!cd.isRadiant; mon.hasRuleBox = !!cd.hasRuleBox;
  mon.attacks = cd.attacks; mon.element = cd.element; mon.weakness = cd.weakness || null; mon.resistance = cd.resistance || null;
  mon.retreatCost = cd.retreatCost ?? 1; mon.ability = cd.ability || null; mon.abilityUsed = false; mon.abilityDisabled = false; mon.abilityDisabledBy = null;
  mon.placedThisTurn = false; mon.evolvedThisTurn = evolvedThisTurn;
  gs.recomputePassives?.();
}
function _removeFirstFromDiscard(pl, card) {
  const idx = pl.discard.lastIndexOf(card);
  if (idx >= 0) pl.discard.splice(idx, 1);
}
function _conditionSatisfied(gs, player, condition) {
  if (!condition) return true;
  if (condition === 'second_player_first_turn') return !!(gs && player && gs.firstPlayer && player !== gs.firstPlayer && gs.turn === 2);
  return false;
}
function _isOwnFirstTurn(gs, player) {
  return !!(gs && player && gs.firstPlayer && ((gs.turn === 1 && player === gs.firstPlayer) || (gs.turn === 2 && player !== gs.firstPlayer)));
}

let _emitDepth = 0;
/**
 * 触发式效果的「附加条件」判定（卡面里「如果…的话，则…」那半句）。
 * 目前支持三类，都是回合结束道具用到的：
 *   damage_counters_at_least / has_special_condition / hp_at_most_with_counters
 */
function _triggerConditionMet(gs, mon, cond, payload = {}, ownerPl = null, event = '') {
  // 能量附着事件的方向/范围：卡面写「每次从自己的手牌将【X】能量附着于这只宝可梦身上时」
  // 与「每当对手附着能量时」是两回事。默认仍是旧行为（只处理对手附着）。
  if (event === 'energy_attached') {
    const owner = payload?.owner;
    const wantOwner = cond?.owner; // 'self' | 'opponent' | undefined(=旧默认: 对手)
    if (wantOwner === 'self') { if (owner !== ownerPl) return false; }
    else if (owner === ownerPl) return false;
    if (cond?.toSelf && payload?.target !== mon) return false;
    if (cond?.fromHand && payload?.fromHand === false) return false;
    if (cond?.energyFilter) {
      // 两侧都去掉【】：能量卡名可能是「基本【草】能量」也可能是「基本草能量」
      const strip = t => String(t || '').replace(/[【】]/g, '');
      if (!strip(payload?.cardName).includes(strip(cond.energyFilter))) return false;
    }
    return true;
  }
  if (cond?.requiresActive && ownerPl && ownerPl.active !== mon) return false;
  if (!cond) return true;
  const counters = Math.max(0, (mon.maxHp || 0) - (mon.hp || 0));
  switch (cond.kind) {
    case 'has_damage_counters': return counters > 0;
    case 'damage_counters_at_least': return counters >= (cond.count || 0) * 10;
    case 'has_special_condition': return !!mon.status;
    case 'hp_at_most_with_counters': return counters > 0 && (mon.hp || 0) <= (cond.hp || 0);
    default: return true;
  }
}

function _shouldTrigger(event, mon, payload, ownerPl) {
  switch (event) {
    case 'attacked_damage':
    case 'knocked_out':
    case 'evolved': return payload.target === mon; // 自身事件
    // 方向判定交给 _triggerConditionMet（那里能看到具体效果的 condition）
    case 'energy_attached': return true;
    // 「在自己的回合结束时」只对**结束回合的这一方**生效；「对手的回合结束时」则相反
    case 'turn_end': return payload.player === ownerPl;
    case 'opponent_turn_end': return !!payload.player && payload.player !== ownerPl;
    default: return true;
  }
}
function _emitTriggers(gs, event, payload = {}) {
  if (_emitDepth > 6) return; // 防重入循环
  _emitDepth++;
  try {
    for (const pl of [gs.player1, gs.player2]) {
      for (const mon of [pl.active, ...(pl.bench || [])]) {
        if (!mon) continue;
        if (!_shouldTrigger(event, mon, payload, pl)) continue;
        const abilityEffects = gs._enabledAbilityEffects?.(mon) || [];
        // 宝可梦道具的触发式效果（如幸运头盔：受击时抽卡）；「在战斗场上」类限定出战位
        const toolEffects = Array.isArray(mon.tool?.effects) ? mon.tool.effects : [];
        const effects = [...abilityEffects, ...toolEffects];
        for (const eff of effects) {
          // 道具触发默认只对出战宝可梦生效（卡面写「在战斗场上」）；
          // anyPosition 用于卡面只写「身上放有这张卡牌的宝可梦」的一族（文柚果等）
          if (toolEffects.includes(eff) && mon !== pl.active && !eff.params?.anyPosition) continue;
          if (eff.action !== 'trigger' || eff.params?.event !== event) continue;
          // 卡面「如果…的话」的附加条件不满足则不触发
          if (!_triggerConditionMet(gs, mon, eff.params?.condition, payload, pl, event)) continue;
          // 依次执行全部内层效果（兼容旧的单 effect 结构）
          const innerList = Array.isArray(eff.params?.effects) && eff.params.effects.length
            ? eff.params.effects
            : (eff.params?.effect ? [eff.params.effect] : []);
          for (const inner of innerList) {
            if (!inner?.action) continue;
            const fn = EXECUTORS[inner.action];
            if (!fn) continue;
            // target:'attacker' 应指向事件源（使用招式的宝可梦）
            const execPl = (inner.params?.target === 'attacker' && payload.source)
              ? ([gs.player1, gs.player2].find(p => p.active === payload.source || p.bench?.includes(payload.source)) || pl)
              : pl;
            // triggerSource：内层效果需要知道「是哪只宝可梦触发的」（heal target:'trigger_source' 等）
            const innerParams = { ...(inner.params || {}), triggerSource: mon };
            try { Promise.resolve(fn(gs, execPl, innerParams, eff)).catch(() => {}); } catch (e) { /* 忽略触发式执行错误 */ }
          }
        }
      }
    }
  } finally { _emitDepth--; }
}
// 把牌库/弃牌区的能量卡包装成与 GameState.attachEnergy 一致的附着表示：
// {cardId, name, provides, specialRules}。
// 注意：本文件里另外几处 attach_energy_* 直接把卡牌原值 push 进 mon.energy，
// 那样 _energyProvides 只能从名字猜属性；新代码统一走这里。
function _energyStateFor(gs, card) {
  const fromObject = card && typeof card === 'object';
  let cd = fromObject ? card : null;
  if (!fromObject && gs?.cardResolver?.getCard) { try { cd = gs.cardResolver.getCard(card) || null; } catch (e) { cd = null; } }
  const name = cd?.name || (typeof card === 'string' ? card : String(card));
  return {
    cardId: fromObject ? (card.cardId || name) : card,
    name,
    provides: cd?.provides || null,
    specialRules: cd?.specialRules || null,
  };
}

/**
 * 施加「不受招式伤害/效果」防护。
 * 必须是**模块级函数**：executeEffects 里是以 `fn(gs, player, params, ...)` 形式调用执行器的，
 * `this` 为 undefined，写成 EXECUTORS 的方法会在顶层调用时抛错、效果静默失效。
 * duration='next_opp_turn'（如大岩蛇「坚硬头锤」）时用 attackShieldArmed 标记，
 * 让 GameState.endTurn 在自己回合结束时保留、改由对手回合结束时清除。
 */
function _applyAttackShield(gs, mon, { damage = false, effect = false, duration = null } = {}) {
  if (!mon) return;
  if (damage) mon.preventDamage = true;
  if (effect) mon.preventEffect = true;
  if (duration === 'next_opp_turn') {
    mon.attackShieldArmed = true;
    const parts = [];
    if (damage) parts.push('伤害');
    if (effect) parts.push('效果');
    gs.addLog(`${mon.name} 在下一个对手的回合不会受到招式的${parts.join('和')}影响`);
  } else {
    gs.addLog(damage && effect ? '防伤防效' : damage ? '防止伤害' : '防止效果');
  }
}

/**
 * 判断宝可梦是否会因再放置 count 个伤害指示物而被昏厥。
 * 用于「（对会被【昏厥】的宝可梦，无法使用这个特性。）」这类卡面明文限制：
 * 卡面括号在归一化时会被剥掉，所以不去解析那句话，而是让**执行端**排除会被打死的目标，
 * 取得同样的规则效果。
 */
function _wouldBeKnockedOutByCounters(mon, count) {
  if (!mon || !count) return false;
  return (mon.hp ?? 0) <= count * 10;
}

function _applyDamageToPokemon(gs, owner, mon, amount, logSuffix = '受到', options = {}) {
  if (!mon || !amount) return false;
  if (options.source === 'attack' && gs.isBenchProtectedFromOpponentAttack?.(owner, mon, 'damage')) { gs.addLog(`${mon.name} 防止了备战伤害`); return false; }
  // 伤害溢出时血量最低为 0，不出现负值
  mon.hp = Math.max(0, mon.hp - amount);
  gs.addLog(`${mon.name} ${logSuffix} ${amount} 伤害`);
  if (mon.hp <= 0) _knockoutPokemon(gs, owner, mon);
  const attacker = options.attacker || gs.getOpponent?.(owner)?.active || null;
  // 只有「招式造成的伤害」才触发受击类效果（幸运头盔/尖钉能量等）。
  // 特性或效果「放置伤害指示物」不算招式伤害，不应触发（如仿徨夜灵的指示物曾误触发幸运头盔）。
  if (options.source === 'attack') _emitTriggers(gs, 'attacked_damage', { target: mon, source: attacker });
  return true;
}
function _knockoutPokemon(gs, owner, mon) {
  if (!owner || !mon) return;
  if (owner.active === mon) {
    gs.knockout(owner);
    _emitTriggers(gs, 'knocked_out', { target: mon, owner });
    return;
  }
  const benchIndex = owner.bench.indexOf(mon);
  if (benchIndex < 0) return;
  owner.bench.splice(benchIndex, 1);
  // ⚠️ 备战区击倒与出战位击倒必须一致：
  //   ① 也要走「昏厥 → 放逐区」的替代效果判定（放逐市/耿鬼 对备战区同样有效）
  //   ② 身上的能量/道具以前会**凭空消失**（只 push 了 cardId），现在按目的地放好
  const dest = gs._knockoutDestination ? gs._knockoutDestination(owner) : { toLostZone:false, withAttachments:false };
  const zone = dest.toLostZone ? (owner.lostZone = owner.lostZone || []) : owner.discard;
  zone.push(mon.cardId);
  const attachZone = (dest.toLostZone && dest.withAttachments) ? zone : owner.discard;
  for (const e of (mon.energy || [])) attachZone.push(_toolCardValue(e));
  if (mon.tool) attachZone.push(_toolCardValue(mon.tool));
  gs.addLog(`${owner.name} 的 ${mon.name} 被击倒！${dest.toLostZone ? '（放于放逐区）' : ''}`);
  _emitTriggers(gs, 'knocked_out', { target: mon, owner });
  const prizeTaker = gs.getOpponent?.(owner) || [gs.player1, gs.player2].find(p => p !== owner);
  if (typeof gs._recordKnockout === 'function') gs._recordKnockout(owner);
  if (prizeTaker) {
    // 注意：不能用 `?? gs.takePrize(...)` —— takePrizesForKnockout 没有返回值（undefined），
    // `undefined ?? x` 会执行右操作数，导致备战区宝可梦被击倒时重复拿奖赏卡（拿 2 张）。
    if (typeof gs.takePrizesForKnockout === 'function') gs.takePrizesForKnockout(prizeTaker, mon);
    else gs.takePrize(prizeTaker);
  }
  gs.recomputePassives?.();
}

const EXECUTORS = {
  // ===== 元数据/使用前提（当前仅记录，不强制执行） =====
  trainer_prerequisite(gs, pl, p) { gs.addLog(`使用前提: ${p.kind}`); },
  usage_condition(gs, pl, p) { gs.addLog(`使用条件: ${p.kind}`); },

  ability_discard_cost: async (gs, pl, p) => {
    const paid = await payDiscardCostFromHand(gs, pl, p, { auto:p.auto });
    if (!paid.ok) throw new Error('ability_cost_unpaid');
  },
  turn_damage_mod(gs, pl, p) {
    pl.turnAttackModifiers = pl.turnAttackModifiers || [];
    pl.turnAttackModifiers.push({ target:p.target || 'own_field', defender:p.defender || 'opponent_active', amount:p.amount || 0 });
    gs.addLog(`本回合招式伤害 ${p.amount > 0 ? '+' : ''}${p.amount}`);
  },

  // ===== 抽卡 =====
  draw(gs, pl, p, eff) {
    // ③ 「若这只宝可梦在战斗场上，则额外抽出N张卡」：
    //    特性执行时每个 effect 都带 source / sourceZone（见 BattleEngine.useAbility），
    //    用它判断来源是否在战斗场；拿不到来源信息时按「不额外抽」保守处理。
    if (p.requiresSourceActive) {
      const src = eff?.source;
      const onActive = eff?.sourceZone === 'active' || (!!src && pl.active === src);
      if (!onActive) { gs.addLog('（来源不在战斗场上，不额外抽卡）'); return; }
    }
    // 「对手从牌库抽出与对手剩余奖赏卡张数相同数量的卡牌」：抽取方是对手，张数取自对手自己的剩余奖赏卡
    if (p.who === 'opponent') {
      const opp = _opponent(gs, pl);
      const n = p.countFrom === 'prizes' ? (opp.prizes ? opp.prizes.length : 0) : (p.count || 1);
      opp.draw(n);
      gs.addLog(`${opp.name} 抽了 ${n} 张卡（其剩余奖赏卡 ${opp.prizes ? opp.prizes.length : 0} 张）`);
      return;
    }
    // 条件改写：「莉莉艾的决心」——若自己的剩余奖赏卡为 6 张，则抽取张数由 6 变为 8。
    const ownPrizes = pl.prizes ? pl.prizes.length : 0;
    const boosted = p.ownPrizesExactly != null && ownPrizes === p.ownPrizesExactly;
    const n = boosted ? (p.countThen ?? p.count ?? 1) : (p.count || 1);
    pl.draw(n);
    gs.addLog(boosted ? `抽了 ${n} 张卡（剩余奖赏卡 ${ownPrizes} 张）` : `抽了 ${n} 张卡`);
  },
  async draw_until(gs, pl, p) {
    const t = p.target || 6;
    // ① 「若希望，在抽出卡牌前，可将任意数量的自己的手牌丢到弃牌区」
    //    只在有 UI（人类玩家）时询问；AI 走自动路径会「全弃」，对「抽到 N 张」只有坏处，故直接跳过。
    if (p.preDiscardAny && gs._onPendingPick && pl.hand.length > 0) {
      const sel = await _pickCardsFromZone(gs, pl, pl, pl.hand, pl.hand.length, {
        source:'pre-draw-discard', prompt:'可先弃掉任意数量手牌（也可以不选）',
        allowFewer:true, allowEmpty:true, maxCount:pl.hand.length, minCount:0, optional:true,
      });
      for (const item of sel.sort((a, b) => b.index - a.index)) pl.discard.push(pl.hand.splice(item.index, 1)[0]);
      if (sel.length) gs.addLog(`抽卡前弃掉 ${sel.length} 张手牌`);
    }
    while (pl.hand.length < t && pl.deck.length > 0) pl.draw(1);
    gs.addLog(`抽卡至 ${t} 张`);
  },
  // 相对抽卡：直到自己的手牌比对手多 delta 张
  draw_until_opp_hand_plus(gs, pl, p) { const opp = _opponent(gs, pl); const target = (opp.hand?.length || 0) + (p.delta || 1); while (pl.hand.length < target && pl.deck.length > 0) pl.draw(1); gs.addLog(`抽卡至比对手多 ${p.delta || 1} 张`); },
  // 弃 N 张手牌抽 N*mult（亚洛）
  async discard_hand_draw(gs, pl, p, eff, options) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, p.maxDiscard || 2, {
      source:'discard-hand-draw', prompt:'选择要丢弃的手牌', allowFewer:true, allowEmpty:true, maxCount:p.maxDiscard || 2, minCount:0, optional:true
    });
    const n = selected.length;
    for (const item of selected.sort((a,b)=>b.index-a.index)) { const c = pl.hand.splice(item.index, 1)[0]; pl.discard.push(c); }
    const drawN = n * (p.drawMult || 2);
    for (let i = 0; i < drawN && pl.deck.length > 0; i++) pl.draw(1);
    gs.addLog(`弃 ${n} 张手牌，抽 ${drawN} 张`);
  },

  // ===== 结束回合 / 丢所有手牌 / 洗牌 =====
  end_turn(gs, pl, p) { gs.endTurn?.(); gs.addLog('回合结束'); },
  discard_all_hand(gs, pl, p) { pl.discard.push(...pl.hand); pl.hand = []; gs.addLog('丢弃所有手牌'); },
  shuffle_deck(gs, pl, p) { gs._shuffle?.(pl.deck); gs.addLog('重洗牌库'); },

  // ===== 搜牌库加手 =====
  async search_deck_to_hand(gs, pl, p, eff, options) {
    if (pl.deck.length === 0) {
      gs.addLog('牌库为空，没有可检索的卡'); // 检索类允许空发
      return;
    }
    const cards = [...pl.deck].reverse();
    const count = p.dynamicCount === 'own_field_type_count' ? _ownFieldTypeCount(pl) : (p.count || 1);
    const selected = await _pickCardsFromZone(gs, pl, pl, cards, count, {
      source:'deck-search',
      filter:p.filter || null,
      prompt:'选择加入手牌的牌库卡',
      allowFewer:!!p.allowFewer,
      allowEmpty:!!p.allowEmpty,
      maxCount:p.maxCount,
      minCount:p.minCount,
      optional:!!p.optional,
      failRequired:_effectIsRequired(eff, p, options),
      requiredAction:eff?.action
    });
    if (!selected.length) { gs._shuffle(pl.deck); return; }
    const selectedCards = selected.map(item => item.card);
    for (const card of selectedCards) { const idx = pl.deck.indexOf(card); if (idx >= 0) pl.deck.splice(idx, 1); }
    gs._shuffle(pl.deck);
    pl.hand.push(...selectedCards);
    gs.addLog(`搜牌库拿了 ${selectedCards.length} 张`);
  },

  // 赤松（CSV9.5C-183/249）等：
  // 「选择自己牌库中，属性各不相同的基本能量最多 N 张，给对手看过后其中 1 张加入手牌，
  //   将剩余的能量附着于自己的宝可梦身上。并重洗牌库。」
  // 关键点：① 属性必须互不相同（原实现允许连选两张同属性）
  //         ② 只有 1 张进手牌，剩余必须附着（原实现把两张都塞进了手牌）
  async search_deck_energy_split(gs, pl, p) {
    const maxN = Math.max(1, p.count || 2);
    const toHandN = Math.max(0, p.toHand ?? 1);
    const filter = p.filter || '基本能量';
    // 保留真实下标（reverse 只改展示顺序，方便按“牌库顶优先”选择）
    const pool = pl.deck.map((card, index) => ({ card, index })).reverse();
    const baseCands = pool.filter(it => _isEnergyCard(gs, it.card, filter));
    if (!baseCands.length) { gs._shuffle(pl.deck); gs.addLog('牌库中没有可选择的基本能量'); return; }

    // 用名字/属性推导能量属性，用于「属性各不相同」的去重
    const typeOf = card => {
      const meta = _resolveZoneCard(gs, card);
      try {
        const t = gs._energyProvides ? gs._energyProvides(meta.label, null) : null;
        if (t && t.length && t[0] && t[0].length) return String(t[0][0]);
      } catch (e) { /* ignore */ }
      return String(meta.element || meta.label);
    };

    // 逐张选择：每选定一张就把同属性候选排除，从机制上杜绝重复属性
    const picked = [];
    const usedTypes = new Set();
    for (let i = 0; i < maxN; i++) {
      const cands = baseCands.filter(it => !picked.includes(it) && !usedTypes.has(typeOf(it.card)));
      if (!cands.length) break;
      const sel = await _pickCardsFromZone(gs, pl, pl, cands.map(c => c.card), 1, {
        source: 'deck-energy-distinct',
        prompt: i === 0 ? '选择牌库中的基本能量（属性各不相同）' : '选择另一种属性的基本能量（可跳过）',
        allowFewer: true, allowEmpty: true, maxCount: 1, minCount: 0, optional: true,
      });
      if (!sel.length) break;
      const chosen = cands[sel[0].index];
      if (!chosen) break;
      picked.push(chosen);
      usedTypes.add(typeOf(chosen.card));
    }
    if (!picked.length) { gs._shuffle(pl.deck); gs.addLog('未选择任何能量'); return; }

    // 从牌库取出（按下标倒序删，避免位移）
    const chosenCards = [];
    for (const it of [...picked].sort((a, b) => b.index - a.index)) {
      if (it.index >= 0 && it.index < pl.deck.length) { pl.deck.splice(it.index, 1); chosenCards.push(it.card); }
    }
    gs._shuffle(pl.deck);

    // 其中 toHandN 张加入手牌；选了多张时让玩家挑哪张入手，其余附着
    let toHand = chosenCards.slice(0, Math.max(1, toHandN));
    let rest = chosenCards.slice(Math.max(1, toHandN));
    if (chosenCards.length > Math.max(1, toHandN)) {
      const sel = await _pickCardsFromZone(gs, pl, pl, chosenCards, Math.max(1, toHandN), {
        source: 'deck-energy-to-hand', prompt: '选择加入手牌的能量（其余附着于宝可梦）',
        maxCount: Math.max(1, toHandN), minCount: Math.max(1, toHandN),
      });
      if (sel.length) {
        const handIdx = new Set(sel.map(s => s.index));
        toHand = chosenCards.filter((_, i) => handIdx.has(i));
        rest = chosenCards.filter((_, i) => !handIdx.has(i));
      }
    }
    pl.hand.push(...toHand);
    gs.addLog(`从牌库给对手看过 ${chosenCards.length} 张基本能量，其中 ${toHand.length} 张加入手牌`);

    // 剩余能量附着于己方宝可梦身上
    if (rest.length) {
      const slot = await _pickPokemonTarget(gs, pl, pl, {
        mode: 'attach-energy', side: 'self', allowActive: true, allowBench: true,
        prompt: '选择附着剩余能量的宝可梦',
      });
      const mon = _getMon(pl, slot);
      if (mon) {
        for (const card of rest) mon.energy.push(_energyStateFor(gs, card));
        _emitEnergyAttached(gs, pl, mon, rest, false);
        gs.addLog(`${mon.name} 身上附着了 ${rest.length} 张能量`);
      } else {
        pl.hand.push(...rest);
        gs.addLog('没有可附着的宝可梦，剩余能量改为加入手牌');
      }
    }
  },

  // ===== 搜牌库放备战 =====
  async search_deck_to_bench(gs, pl, p, eff, options) {
    if (pl.deck.length === 0) { gs.addLog('牌库为空，无法搜索宝可梦'); return; } // 检索类允许空发
    const openSlots = Math.max(0, 5 - pl.bench.length);
    if (openSlots <= 0) { gs.addLog('备战区已满，无法放置宝可梦'); gs._shuffle(pl.deck); return; } // 无位置可放也属空发
    const count = Math.min(p.count || 1, openSlots);
    const cards = [...pl.deck].reverse();
    const filter = card => _cardMatchesFilter(gs, card, { filter:p.filter || '宝可梦', maxHp:p.maxHp, nonRuleBox:p.nonRuleBox }) && _isBasicPokemonCard(gs, card);
    const hasCandidates = cards.some(filter);
    const selected = hasCandidates ? await _pickCardsFromZone(gs, pl, pl, cards, count, {
      source:'deck-to-bench',
      filter,
      prompt:'选择放置到备战区的基础宝可梦',
      allowFewer:!!p.allowFewer,
      allowEmpty:!!p.allowEmpty,
      maxCount:p.maxCount,
      minCount:p.minCount,
      optional:!!p.optional,
      failRequired:_effectIsRequired(eff, p, options),
      requiredAction:eff?.action
    }) : [];
    if (!selected.length) { gs.addLog('牌库中没有可放置的基础宝可梦'); gs._shuffle(pl.deck); if (_effectIsRequired(eff, p, options) && hasCandidates) _requiredFailure(eff?.action, 'required_no_candidates'); return; }
    let placed = 0;
    for (const item of selected) {
      if (pl.bench.length >= 5) break;
      const idx = pl.deck.indexOf(item.card);
      if (idx < 0) continue;
      const cid = pl.deck.splice(idx, 1)[0];
      pl.bench.push(_makeBenchPokemonFromCard(gs, cid));
      placed++;
    }
    gs._shuffle(pl.deck);
    gs.addLog(`放置了 ${placed} 只宝可梦`);
  },

  // ===== 看牌库上方选牌 =====
  async peek_and_keep(gs, pl, p, eff, options) {
    const peek = Math.min(p.peek || 6, pl.deck.length);
    const keep = Math.min(p.keep || 1, peek);
    const peeked = pl.deck.splice(-peek, peek);
    const topCards = [...peeked].reverse();
    const candidates = topCards.map((card, topIndex) => ({ card, topIndex })).filter(item => _cardMatchesFilter(gs, item.card, p.filter || null));
    // 问题3：这是「查看牌库顶 → 选择其中若干张加入手牌」的效果性选择，取消应视为「不拿任何卡」，而不是让整个训练家使用失败回滚
    // （代价类选择如高级球的 discard_cost 仍走 payDiscardCostFromHand，取消=放弃发动）
    const peekSelOpts = p.required === true ? p : { ...p, allowEmpty: true };
    const limit = _selectionLimit(keep, candidates.length, peekSelOpts);
    let selected = [];
    if (candidates.length === 0) {
      const filterText = p.filter ? `符合${p.filter}条件的卡` : '符合条件的卡';
      gs.addLog(`查看了 ${peek} 张，没有${filterText}`);
    }
    // 无候选 → 空发成功（如宝可装置3.0 牌库上方没有支援者时）
    if (limit.max > 0) {
      const shouldUsePicker = pl === gs.player1 && !p.auto && gs._onPendingPick;
      if (!shouldUsePicker) {
        selected = candidates.slice(0, limit.max);
      } else {
        const picked = await gs.waitForPick(candidates.map(c => _cardLabel(gs, c.card)), limit.max, { source: 'peek', filter: p.filter || null, maxCount:limit.max, minCount:limit.min, allowFewer:limit.allowFewer, allowEmpty:limit.allowEmpty });
        selected = (picked || []).map(i => candidates[i]).filter(Boolean).slice(0, limit.max);
        if (selected.length < limit.min) {
          if (_effectIsRequired(eff, p, options)) _requiredFailure(eff?.action, 'required_pick_cancelled');
          selected = [];
        }
      }
    }
    const selectedTopPositions = new Set(selected.map(item => item.topIndex));
    const selectedCards = selected.map(item => item.card);
    const remainder = peeked.filter((_, peekedIndex) => !selectedTopPositions.has(peek - 1 - peekedIndex));
    pl.hand.push(...selectedCards);

    const remainderMode = p.remainder || (p.keepOrder ? 'top_original' : 'shuffle');
    if (remainderMode === 'discard') {
      // D「将剩余的卡牌丢到弃牌区」
      pl.discard.push(...remainder);
      gs.addLog(`剩余的 ${remainder.length} 张卡丢到弃牌区`);
    } else if (remainderMode === 'lost_zone') {
      // 「将剩余的卡牌放置于放逐区」：放逐区的卡不能再被回收，必须真的分开存
      (pl.lostZone = pl.lostZone || []).push(...remainder);
      gs.addLog(`剩余的 ${remainder.length} 张卡放于放逐区`);
    } else if (remainderMode === 'deck_bottom') {
      // D2「将剩余的卡牌全部翻到反面重洗，放回牌库下方」
      // draw() 用 deck.pop() 取牌，所以牌库下方 = 数组前端
      pl.deck.unshift(...remainder);
      gs.addLog(`剩余的 ${remainder.length} 张卡放回牌库下方`);
    } else if (remainderMode === 'shuffle') {
      pl.deck.push(...remainder);
      gs._shuffle(pl.deck);
    } else {
      // "任意顺序" UI is intentionally not implemented yet; preserve original relative order deterministically.
      pl.deck.push(...remainder);
    }
    gs.addLog(`看了 ${peek} 张选了 ${selectedCards.length} 张`);
  },

  // ===== 神奇糖果：基础宝可梦跳过1阶进化为2阶 =====
  async evolve_rare_candy(gs, pl, p, eff, options) {
    const failRequired = _effectIsRequired(eff, p, options);
    if (p.noFirstTurn && _isOwnFirstTurn(gs, pl)) {
      gs.addLog('自己的最初回合不能使用神奇糖果');
      if (failRequired) _requiredFailure(eff?.action, 'required_first_turn_prohibited');
      return;
    }
    const stage2Candidates = (pl.hand || [])
      .map((card, index) => ({ card, index, data:gs.cardResolver?.getCard?.(card) }))
      .filter(item => item.data?.cardType === 'pokemon' && item.data.stage === '2阶' && item.data.evolvesFrom);
    if (!stage2Candidates.length) { gs.addLog('手牌中没有可用的2阶进化宝可梦'); if (failRequired) _requiredFailure(eff?.action, 'required_no_stage2'); return; }
    const chosenCards = await _pickCardsFromZone(gs, pl, pl, pl.hand, 1, {
      source:'rare-candy-evolution-card',
      filter:card => stage2Candidates.some(item => item.card === card),
      excludeIndices:[],
      prompt:'选择神奇糖果进化的2阶宝可梦',
      failRequired,
      requiredAction:eff?.action
    });
    const chosen = chosenCards[0];
    if (!chosen) { if (failRequired) _requiredFailure(eff?.action, 'required_stage2_cancelled'); return; }
    const cd = gs.cardResolver?.getCard?.(chosen.card);
    const eligibleSlots = ['active', ...pl.bench.map((_, i) => `bench-${i}`)].filter(slot => {
      const mon = _getMon(pl, slot);
      return mon && !mon.placedThisTurn && !mon.evolvedThisTurn && _basicCanRareCandyTo(gs, mon, cd);
    });
    if (!eligibleSlots.length) { gs.addLog('场上没有可用神奇糖果进化的基础宝可梦'); if (failRequired) _requiredFailure(eff?.action, 'required_no_eligible_basic'); return; }
    const slot = await _pickPokemonTarget(gs, pl, pl, {
      mode:'evolve', side:'self', allowActive:true, allowBench:true, selectableSlots:eligibleSlots,
      slotFilter:candidateSlot => eligibleSlots.includes(candidateSlot),
      prompt:'选择要使用神奇糖果进化的基础宝可梦',
      failRequired,
      requiredAction:eff?.action
    });
    if (!eligibleSlots.includes(slot)) { if (failRequired) _requiredFailure(eff?.action, 'required_rare_candy_target_cancelled'); return; }
    const mon = _getMon(pl, slot);
    const handIndex = pl.hand.indexOf(chosen.card);
    if (handIndex < 0) { if (failRequired) _requiredFailure(eff?.action, 'required_stage2_missing'); return; }
    pl.hand.splice(handIndex, 1);
    _applyEvolutionToMon(gs, mon, cd, true);
    gs.addLog(`${pl.name} 使用神奇糖果让 ${mon.name} 完成进化！`);
  },

  // ===== 洗翠的沉重球：奖赏基础宝可梦与本卡互换 =====
  async prize_basic_pokemon_to_hand_exchange_trainer(gs, pl, p, eff, options) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.prizes, p.count || 1, {
      source:'hisuian-heavy-ball-prize',
      filter:card => _isBasicPokemonCard(gs, card),
      prompt:'选择奖赏卡中的基础宝可梦'
    });
    if (!selected.length) { gs.addLog('奖赏卡中没有可选择的基础宝可梦'); return; }
    const item = selected[0];
    const prizeCard = pl.prizes[item.index];
    const trainerCard = options?.trainerCard || options?.trainerCardData?.name || '洗翠的沉重球';
    const discardedTrainer = options?.trainerCardData?.name || trainerCard;
    pl.hand.push(prizeCard);
    pl.prizes[item.index] = trainerCard;
    _removeFirstFromDiscard(pl, discardedTrainer);
    gs.addLog('洗翠的沉重球：奖赏卡与本卡互换');
  },

  // ===== 窄口径牌库顶操作：按解析器结构化参数查看/丢弃/置底/洗牌 =====
  async manipulate_deck_top(gs, pl, p = {}) {
    const owner = p.target === 'opponent' ? _opponent(gs, pl) : pl;
    const count = Math.min(p.count || 1, owner.deck.length);
    if (count <= 0) return;
    const pickedTop = owner.deck.splice(-count, count);
    const topCards = [...pickedTop].reverse();
    const actorCanPick = pl === gs.player1 && !p.auto && gs._onPendingPick;

    const restoreTop = cards => owner.deck.push(...cards);
    const labels = topCards.map(card => _cardLabel(gs, card));

    if (p.mode === 'discard_matching') {
      const candidates = topCards.map((card, topIndex) => ({ card, topIndex })).filter(item => _cardMatchesFilter(gs, item.card, p.filter || null));
      const limit = _selectionLimit(p.keep ?? p.count ?? count, candidates.length, { ...p, maxCount:p.maxCount ?? candidates.length });
      let selected = [];
      if (limit.max > 0) {
        if (actorCanPick) {
          const picked = await gs.waitForPick(candidates.map(c => _cardLabel(gs, c.card)), limit.max, { source:'manipulate-deck-top-discard', filter:p.filter || null, prompt:'选择要从牌库上方丢弃的卡', maxCount:limit.max, minCount:limit.min, allowFewer:limit.allowFewer, allowEmpty:limit.allowEmpty });
          selected = (picked || []).map(i => candidates[i]).filter(Boolean).slice(0, limit.max);
          if (selected.length < limit.min) selected = [];
        } else {
          selected = candidates.slice(0, limit.max);
        }
      }
      const selectedTopPositions = new Set(selected.map(item => item.topIndex));
      const selectedCards = selected.map(item => item.card);
      const remainder = pickedTop.filter((_, pickedIndex) => !selectedTopPositions.has(count - 1 - pickedIndex));
      owner.discard.push(...selectedCards);
      owner.deck.push(...remainder);
      if ((p.remainder || 'top_original') === 'shuffle') gs._shuffle(owner.deck);
      gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，丢弃 ${selectedCards.length} 张`);
      return;
    }

    if (p.mode === 'choose_top_rest_bottom') {
      let chosenTopIndex = 0;
      if (actorCanPick && topCards.length > 1) {
        const picked = await gs.waitForPick(labels, 1, { source:'manipulate-deck-top-choose-top', prompt:'选择放回牌库上方的卡', allowEmpty:false, required:true });
        if (!picked || picked.length < 1 || !Number.isInteger(picked[0]) || picked[0] < 0 || picked[0] >= topCards.length) {
          restoreTop(pickedTop);
          gs.addLog('牌库上方操作取消');
          throw new Error('required_choice_cancelled');
        }
        chosenTopIndex = picked[0];
      }
      const chosen = topCards[chosenTopIndex];
      const restTopOrder = topCards.filter((_, i) => i !== chosenTopIndex);
      const restBottomToTop = [...restTopOrder].reverse();
      owner.deck.unshift(...restBottomToTop);
      owner.deck.push(chosen);
      gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，1 张放回上方，其余置于下方`);
      return;
    }

    if (p.mode === 'top_any_order') {
      // 任意顺序 UI 尚未展开；当前明确采用原相对顺序作为无 UI/AI 和 UI 的确定性回退。
      restoreTop(pickedTop);
      gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，按原顺序放回上方`);
      return;
    }

    if (p.mode === 'look') {
      restoreTop(pickedTop);
      gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，回复原样`);
      return;
    }

    if (p.mode === 'look_then_optional') {
      let doAction = false;
      if (actorCanPick) {
        const verb = p.optionalAction === 'discard' ? '丢弃' : p.optionalAction === 'bottom' ? '放回牌库下方' : p.optionalAction === 'shuffle' ? '重洗牌库' : '执行';
        const picked = await gs.waitForPick([`不处理：${labels[0]}`, `${verb}：${labels[0]}`], 1, { source:'manipulate-deck-top-optional', prompt:'选择牌库上方卡的处理方式', allowEmpty:true, optional:true });
        doAction = picked?.[0] === 1;
      }
      if (!doAction) {
        restoreTop(pickedTop);
        gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，回复原样`);
        return;
      }
      const top = topCards[0];
      if (p.optionalAction === 'discard') owner.discard.push(top);
      else if (p.optionalAction === 'bottom') owner.deck.unshift(top);
      else if (p.optionalAction === 'shuffle') { restoreTop(pickedTop); gs._shuffle(owner.deck); }
      else restoreTop(pickedTop);
      gs.addLog(`查看${owner === pl ? '自己' : '对手'}牌库上方 ${count} 张，执行${p.optionalAction || 'optional'}`);
      return;
    }

    restoreTop(pickedTop);
    gs.addLog(`[未实现: manipulate_deck_top.${p.mode || 'unknown'}]`);
  },

  // ===== 健行鞋：看牌库顶，加入手牌或丢弃后抽1 =====
  async hikers_shoes(gs, pl, p) {
    if (!pl.deck.length) return;
    const top = pl.deck.pop();
    let discardTop = false;
    if (pl === gs.player1 && gs._onPendingPick) {
      const picked = await gs.waitForPick([`加入手牌：${_cardLabel(gs, top)}`, `丢弃并抽${p.drawOnDiscard || 1}张`], 1, {
        source:'hikers-shoes',
        prompt:'健行鞋：选择牌库上方卡的处理方式',
        allowEmpty:false,
        required:true,
      });
      discardTop = picked?.[0] === 1;
    }
    if (discardTop) {
      pl.discard.push(top);
      pl.draw(p.drawOnDiscard || 1);
      gs.addLog('健行鞋：丢弃牌库上方卡并抽卡');
    } else {
      pl.hand.push(top);
      gs.addLog('健行鞋：将牌库上方卡加入手牌');
    }
  },

  // ===== 阿尔宙斯手机：奖赏与牌库顶互换 =====
  async prize_deck_top_swap(gs, pl, p) {
    if (pl.deck.length === 0 || pl.prizes.length === 0) return;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.prizes, 1, {
      source:'prize-deck-top-swap',
      prompt:'选择1张奖赏卡与牌库顶互换',
      allowEmpty: !!p?.optional
    });
    if (!selected.length) return;
    const prizeIndex = selected[0].index;
    if (prizeIndex < 0 || prizeIndex >= pl.prizes.length) return;
    const top = pl.deck[pl.deck.length - 1];
    pl.deck[pl.deck.length - 1] = pl.prizes[prizeIndex];
    pl.prizes[prizeIndex] = top;
    gs.addLog('奖赏卡与牌库上方互换');
  },

  // ===== 百万吨吹风机：丢对手道具/特殊能量/竞技场 =====
  discard_field_attachments(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const owners = (p.target === 'both') ? [pl, opp] : (p.target === 'self' ? [pl] : [opp]);
    const maxCount = p.maxCount || Infinity;
    // toLostZone：这些卡进放逐区而不是弃牌区
    const zoneOf = owner => (p.toLostZone ? (owner.lostZone = owner.lostZone || []) : owner.discard);
    let n = 0;
    for (const owner of owners) {
      for (const mon of [owner.active, ...(owner.bench || [])]) {
        if (!mon) continue;
        if (n >= maxCount) break;
        if (p.tools && mon.tool) { zoneOf(owner).push(_toolCardValue(mon.tool)); mon.tool = null; n++; }
        if (n >= maxCount) break;
        if (p.specialEnergy && mon.energy?.length) {
          const kept = [];
          for (const e of mon.energy) {
            if (n >= maxCount) { kept.push(e); continue; }
            if (_isSpecialEnergyAttachment(gs, e)) { zoneOf(owner).push(toCardRef(e)); n++; }
            else kept.push(e);
          }
          mon.energy = kept;
        }
      }
    }
    if (p.stadium) {
      const old = gs.clearActiveStadium?.();
      if (old) n++;
    }
    gs.addLog(`丢弃场上附加卡 ${n} 张`);
    _applyCountedDamage(gs, pl, p, n);
  },

  // ===== 宝可梦通信：手牌宝可梦回牌库后搜宝可梦 =====
  async hand_pokemon_to_deck_search_pokemon(gs, pl, p) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, p.return_count || 1, {
      source:'hand-pokemon-return',
      filter:_isPokemonCard.bind(null, gs),
      prompt:'选择放回牌库的手牌宝可梦'
    });
    if (!selected.length) {
      gs._shuffle(pl.deck);
      await EXECUTORS.search_deck_to_hand(gs, pl, { count: p.search_count || 1, filter: p.filter || '宝可梦' });
      return;
    }
    for (const item of selected.sort((a,b)=>b.index-a.index)) pl.deck.push(pl.hand.splice(item.index, 1)[0]);
    gs.addLog(`手牌${selected.length}张宝可梦放回牌库`);
    gs._shuffle(pl.deck);
    await EXECUTORS.search_deck_to_hand(gs, pl, { count: p.search_count || 1, filter: p.filter || '宝可梦' });
  },

  // ===== 恢复HP =====
  async heal(gs, pl, p, eff) {
    // 「恢复自己的身上附着能量的1只宝可梦「N」点HP」→ 需要选目标（且目标必须附有能量）
    let mon = pl.active;
    // 触发式效果：目标是「触发的持有者」（文柚果等道具可能挂在备战宝可梦身上）
    if (p.target === 'trigger_source' && p.triggerSource) mon = p.triggerSource;
    if (p.target === 'previous_switched') {
      // F 玛奥&水莲：「回复被换到备战区的宝可梦N点HP」
      const rec = gs._switchToBench;
      mon = (rec && rec.player === pl && (pl.bench || []).includes(rec.mon)) ? rec.mon : pl.active;
    }
    if (p.target === 'choose') {
      const slot = await _pickPokemonTarget(gs, pl, pl, {
        mode:'heal', side:'self', allowActive:true, allowBench:true, prompt:'选择要回复的宝可梦',
        slotFilter: s => !p.requireEnergy || (_getMon(pl, s)?.energy?.length || 0) > 0,
      });
      mon = _getMon(pl, slot) || pl.active;
    }
    if (!mon) return;
    const opp = _opponent(gs, pl);
    if ((gs._passiveEffectsFor?.(opp.active, 'block_heal') || []).some(e => ['both_field', 'opponent_field', 'opponent_bench'].includes(e.params?.target))) { gs.addLog('无法回复HP'); return; }
    let amount = p.amount === 'full' ? mon.maxHp : p.amount === 'as_attack_damage' ? (eff?._attackDamage || 0) : (p.amount || 20);
    // 条件回复量：如「派帕的三明治」——如果那只宝可梦是「派帕的宝可梦」则回复量由 30 变为 100。
    // 注意「派帕的宝可梦」是**持有者前缀**分类，不是名字里真的含这几个字：
    // 判定方式是名字以「派帕的」开头（「派帕的藏饱栗鼠」✓、「藏饱栗鼠」✗）。
    if (p.ifNamePrefix && String(mon.name || '').startsWith(String(p.ifNamePrefix))) {
      amount = p.amountThen !== undefined ? p.amountThen : amount;
      gs.addLog(`（${mon.name} 是「${p.ifNamePrefix}宝可梦」，回复量提升为 ${amount}）`);
    }
    mon.hp = Math.min(mon.maxHp, mon.hp + amount);
    gs.addLog(`恢复 ${amount} HP`);
  },

  // ===== 己方全体回复 =====
  heal_all(gs, pl, p) {
    const amount = p.amount || 10;
    for (const mon of [pl.active, ...(pl.bench || [])]) { if (mon) mon.hp = Math.min(mon.maxHp, mon.hp + amount); }
    gs.addLog(`己方所有宝可梦恢复 ${amount} HP`);
  },

  // ===== 丢弃竞技场 =====
  // 注意把 pl 作为**兜底归属方**传进去：正常情况竞技场自带 owner，
  // 但万一没有（旧数据/异常流程），以前会既不清场也不进弃牌区、卡直接消失。
  discard_stadium(gs, pl, p) { const old = gs.clearActiveStadium?.(pl); gs.addLog(old ? '丢弃竞技场' : '无竞技场'); },

  // ===== 自身伤害 =====
  self_damage(gs, pl, p) {
    const mon = pl.active;
    if (!mon) return;
    mon.hp -= (p.amount || 10);
    gs.addLog(`受到 ${p.amount || 10} 自伤`);
    if (mon.hp <= 0) gs.knockout(pl);
  },

  // ===== 伤害指示物放置 =====
  async damage_place(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const dmg = (p.count || 1) * 10;
    const target = p.target || 'opponent_active';
    if (target === 'opponent_active') {
      _applyDamageToPokemon(gs, opp, opp.active, dmg);
      return;
    }
    if (target === 'self' || target === 'attacker') {
      _applyDamageToPokemon(gs, pl, pl.active, dmg);
      return;
    }
    if (target === 'opponent_any') {
      // First step: choose one concrete opponent Pokemon for all counters. Full arbitrary split distribution is not implemented yet.
      const slot = await _pickPokemonTarget(gs, pl, opp, { mode:'damage', side:'opponent', allowActive:true, allowBench:true, prompt:'选择放置伤害指示物的对手宝可梦' });
      _applyDamageToPokemon(gs, opp, _getMon(opp, slot), dmg);
      return;
    }
    if (target === 'opponent_bench') {
      const slot = await _pickPokemonTarget(gs, pl, opp, { mode:'damage', side:'opponent', allowActive:false, allowBench:true, prompt:'选择放置伤害指示物的对手备战宝可梦' });
      _applyDamageToPokemon(gs, opp, _getMon(opp, slot), dmg);
      return;
    }
    if (target === 'opponent_bench_N') {
      const n = Math.min(p.count || 1, opp.bench.length);
      const per = (p.per || 1) * 10;
      for (let i = 0; i < n; i++) { const mon = opp.bench[i]; if (mon) _applyDamageToPokemon(gs, opp, mon, per); }
      gs.addLog(`对手 ${n} 只备战宝可梦各放 ${p.per || 1} 个伤害指示物`);
      return;
    }
    if (target === 'opponent_all') {
      for (const mon of [opp.active, ...opp.bench]) _applyDamageToPokemon(gs, opp, mon, dmg);
      return;
    }
    // 「转放伤害指示物」：从自己场上有指示物的宝可梦身上移走最多 count 个，
    // 放到对手场上的一只宝可梦身上（愿增猿「亢奋脑力」等）。
    // 注意：原实现没有分支处理 opponent_field，效果会静默什么都不做。
    if (target === 'opponent_field' || target === 'opponent_any_field') {
      const hasCounters = mon => !!mon && (mon.maxHp - mon.hp) > 0;
      const srcSlot = await _pickPokemonTarget(gs, pl, pl, {
        mode:'damage-remove', side:'self', allowActive:true, allowBench:true,
        prompt:'选择要移走伤害指示物的己方宝可梦',
        slotFilter: slot => hasCounters(_getMon(pl, slot)),
      });
      const srcMon = srcSlot ? _getMon(pl, srcSlot) : null;
      if (!srcMon) { gs.addLog('己方场上没有可移走的伤害指示物'); return; }
      // 伤害指示物的「个数」= 已损失HP / 10。
      // 原先写成 Math.min(p.count, maxHp - hp)：把伤害值当成个数，
      // 导致身上只有 2 个指示物（20 伤害）却能转放 3 个（min(3,20)=3）。
      const availableCounters = Math.floor(Math.max(0, srcMon.maxHp - srcMon.hp) / 10);
      const movable = Math.max(0, Math.min(p.count || 1, availableCounters));
      if (movable <= 0) { gs.addLog('己方场上没有可移走的伤害指示物'); return; }
      const dstSlot = await _pickPokemonTarget(gs, pl, opp, {
        mode:'damage', side:'opponent', allowActive:true, allowBench:true,
        prompt:'选择要转放伤害指示物的对手宝可梦',
      });
      const dstMon = dstSlot ? _getMon(opp, dstSlot) : null;
      if (!dstMon) return;
      srcMon.hp = Math.min(srcMon.maxHp, srcMon.hp + movable * 10);
      _applyDamageToPokemon(gs, opp, dstMon, movable * 10);
      gs.addLog(`将 ${srcMon.name} 身上的 ${movable} 个伤害指示物转放到 ${dstMon.name} 身上`);
    }
  },

  // ===== 备战区伤害 =====
  async damage_bench(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const dmg = p.damage || 20;
    if (p.target === 'opponent_1' || p.target === 'opponent_any') {
      const slot = await _pickPokemonTarget(gs, pl, opp, { mode:'damage', side:'opponent', allowActive:p.target === 'opponent_any', allowBench:true, prompt:'选择受到伤害的宝可梦' });
      const mon = _getMon(opp, slot);
      if (mon) _applyDamageToPokemon(gs, opp, mon, dmg, slot === 'active' ? '受到' : '备战受', { source:'attack' });
    } else if (p.target === 'opponent_all') {
      for (const mon of [...opp.bench]) if (mon) _applyDamageToPokemon(gs, opp, mon, dmg, '备战受', { source:'attack' });
      gs.addLog(`对手备战区各受 ${dmg}`);
    } else if (p.target === 'opponent_N') {
      const n = Math.min(p.count || 1, opp.bench.length);
      for (let i = 0; i < n; i++) { const mon = opp.bench[i]; if (mon) _applyDamageToPokemon(gs, opp, mon, dmg, '备战受', { source:'attack' }); }
      gs.addLog(`对手 ${n} 只备战宝可梦各受 ${dmg}`);
    } else if (p.target === 'opponent_all_field') {
      for (const mon of [opp.active, ...opp.bench]) if (mon) _applyDamageToPokemon(gs, opp, mon, dmg, mon === opp.active ? '受到' : '备战受', { source:'attack' });
      gs.addLog(`对手所有宝可梦各受 ${dmg}`);
    } else if (p.target === 'self_all') {
      for (const mon of [...pl.bench]) if (mon) _applyDamageToPokemon(gs, pl, mon, dmg, '备战受', { source:'attack' });
      gs.addLog(`己方备战区各受 ${dmg}`);
    } else if (p.target === 'both_bench') {
      for (const mon of [...pl.bench]) if (mon) _applyDamageToPokemon(gs, pl, mon, dmg, '备战受', { source:'attack' });
      for (const mon of [...opp.bench]) if (mon) _applyDamageToPokemon(gs, opp, mon, dmg, '备战受', { source:'attack' });
      gs.addLog(`双方备战区各受 ${dmg}`);
    }
  },

  // ===== 状态异常 =====
  inflict_status(gs, pl, p) {
    if (!_conditionSatisfied(gs, pl, p.condition)) return;
    const target = (p.target === 'attacker') ? pl.active : _opponent(gs, pl).active;
    if (target && p.statuses) { if (gs._hasPassive?.(target, 'block_special_condition')) { gs.addLog('目标免疫特殊状态'); return; } const applied = (p.statuses||[]).filter(s => !(gs._passiveEffectsFor?.(target, 'block_status')||[]).some(e => e.params?.status === s)); if (!applied.length) { gs.addLog('目标免疫该状态'); return; } _applyStatus(target, applied); gs.addLog(`对手 ${applied.join('、')}`); }
  },
  inflict_status_self(gs, pl, p) {
    if (pl.active && p.statuses) { if (gs._hasPassive?.(pl.active, 'block_special_condition')) { gs.addLog('自身免疫特殊状态'); return; } const applied = (p.statuses||[]).filter(s => !(gs._passiveEffectsFor?.(pl.active, 'block_status')||[]).some(e => e.params?.status === s)); if (!applied.length) { gs.addLog('自身免疫该状态'); return; } _applyStatus(pl.active, applied); gs.addLog(`陷入 ${applied.join('、')}`); }
  },
  inflict_status_both(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (pl.active && p.statuses) _applyStatus(pl.active, p.statuses);
    if (opp.active && p.statuses) _applyStatus(opp.active, p.statuses);
    gs.addLog(`双方 ${p.statuses.join('、')}`);
  },

  // ===== 换位 =====
  async switch_active_basic_heal_bench(gs, pl, p) {
    if (!pl.active || !pl.bench.length) return;
    if (!_isBasicMon(gs, pl.active)) { gs.addLog('交替推车只能换下基础宝可梦'); return; }
    const oldActive = pl.active;
    const slot = await _pickPokemonTarget(gs, pl, pl, { mode:'switch', side:'self', allowActive:false, allowBench:true, prompt:'选择换上场的备战宝可梦' });
    const idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
    if (!pl.bench[idx]) return;
    pl.active = pl.bench.splice(idx, 1)[0];
    pl.bench.push(oldActive);
    gs._removeSpecialConditions?.(oldActive);
    const heal = p.heal || 30;
    oldActive.hp = Math.min(oldActive.maxHp, oldActive.hp + heal);
    gs.addLog(`交替推车：换位并恢复 ${heal} HP`);
    gs.recomputePassives?.();
  },
  async self_switch_to_active(gs, pl, p, eff) {
    const source = eff?.source;
    const idx = pl.bench.indexOf(source);
    if (idx < 0) return;
    const oldActive = pl.active;
    pl.active = pl.bench.splice(idx, 1)[0];
    if (oldActive) pl.bench.push(oldActive);
    gs._removeSpecialConditions?.(oldActive);
    gs.addLog(`${pl.active.name} 因特性换到战斗场`);
    gs.recomputePassives?.();
  },
  async switch_pokemon(gs, pl, p, eff, options) {
    const failRequired = _effectIsRequired(eff, p, options);
    if (failRequired && p.who !== 'both') {
      const targetPlayer = p.who === 'opponent' ? _opponent(gs, pl) : pl;
      if (!targetPlayer.active || !(targetPlayer.bench || []).some(Boolean)) _requiredFailure(eff?.action, 'required_no_switch_target');
    }
    if (p.who === 'opponent') {
      const opp = _opponent(gs, pl);
      const chooser = p.choose === 'opponent' ? opp : pl;
      const slot = await _pickPokemonTarget(gs, pl, opp, {
        mode:'switch', side:'opponent', allowActive:false, allowBench:true,
        chooser,
        prompt: p.choose === 'opponent'
          ? (chooser === gs.player1 ? '选择自己要换上场的备战宝可梦' : '对手选择换上场的备战宝可梦')
          : '选择换上场的对手备战宝可梦',
        failRequired, requiredAction:eff?.action
      });
      const idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
      if (opp.bench[idx]) { const t = opp.active; opp.active = opp.bench.splice(idx,1)[0]; if (t) { opp.bench.push(t); gs._removeSpecialConditions?.(t); } gs.addLog('对手换位'); }
      else if (failRequired) _requiredFailure(eff?.action, 'required_invalid_switch_target');
    } else if (p.who === 'both') {
      for (const pp of [pl, _opponent(gs, pl)]) {
        if (pp.bench.length > 0) { const t = pp.active; pp.active = pp.bench.shift(); if (t) { pp.bench.push(t); gs._removeSpecialConditions?.(t); } }
      }
      gs.addLog('双方换位');
    } else {
      const slot = await _pickPokemonTarget(gs, pl, pl, { mode:'switch', side:'self', allowActive:false, allowBench:true, prompt:'选择换上场的备战宝可梦', failRequired, requiredAction:eff?.action });
      const idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
      if (pl.bench[idx]) { const t = pl.active; pl.active = pl.bench.splice(idx,1)[0]; if (t) { pl.bench.push(t); gs._removeSpecialConditions?.(t); gs._switchToBench = { player: pl, mon: t }; } gs.addLog('换位'); }
      else if (failRequired) _requiredFailure(eff?.action, 'required_invalid_switch_target');
    }
  },

  // ===== 回手 =====
  async return_to_hand(gs, pl, p = {}) {
    if (!pl.active) return;
    const returnActiveToHand = async () => {
      const returned = pl.active;
      _returnAttachedCardsToHand(pl, returned, !!p.with_attachments);
      pl.active = null;
      if (pl.bench.length > 0) {
        const slot = await _pickPokemonTarget(gs, pl, pl, {
          mode:'switch', side:'self', allowActive:false, allowBench:true,
          prompt:'选择换上场的备战宝可梦'
        });
        let idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
        if (!pl.bench[idx]) idx = 0;
        pl.active = pl.bench.splice(idx, 1)[0] || null;
      }
      gs.recomputePassives?.();
      gs.addLog('宝可梦回手');
    };

    if (p.target === 'choose') {
      const slot = await _pickPokemonTarget(gs, pl, pl, {
        mode:'return-to-hand', side:'self', allowActive:true, allowBench:true,
        prompt:'选择回到手牌的己方宝可梦'
      });
      if (slot === 'active') {
        await returnActiveToHand();
        return;
      }
      const idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
      const returned = pl.bench[idx];
      if (!returned) return;
      _returnAttachedCardsToHand(pl, returned, !!p.with_attachments);
      pl.bench.splice(idx, 1);
      gs.recomputePassives?.();
      gs.addLog('宝可梦回手');
      return;
    }

    await returnActiveToHand();
  },

  // ===== 丢弃手牌 =====
  async discard_hand(gs, pl, p = {}) {
    const count = p.count === 'all' ? pl.hand.length : (p.count || 1);
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, count, {
      source:'hand-discard',
      filter:p.filter || null,
      prompt:p.prompt || '选择要丢弃的手牌',
      // 「（必须至少选择1张。）」类要求：minCount>0 时不允许空选
      allowEmpty: !p.minCount,
      allowFewer: !!p.allowFewer || !!p.minCount,
      minCount: p.minCount || 0,
      maxCount: p.maxCount || count,
    });
    if (!selected.length) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) pl.discard.push(pl.hand.splice(item.index, 1)[0]);
    gs.addLog(`丢弃 ${selected.length} 张手牌`);
    _applyCountedDamage(gs, pl, p, selected.length);
  },
  discard_all_hand(gs, pl) { while (pl.hand.length > 0) pl.discard.push(pl.hand.pop()); gs.addLog('丢弃全部手牌'); },

  // ===== 手牌回牌库 =====
  shuffle_hand_to_deck(gs, pl, p) {
    const targets = p.who === 'both' ? [gs.player1, gs.player2] : p.who === 'opponent' ? [_opponent(gs, pl)] : [pl];
    for (const pp of targets) { while (pp.hand.length > 0) pp.deck.push(pp.hand.pop()); gs._shuffle(pp.deck); }
    // 奇树类：各抽与自己剩余奖赏卡张数相同数量（放回牌库下方近似为重洗+抽卡）
    if (p.draw_by_prizes) {
      for (const pp of targets) { const n = pp.prizes?.length || 0; for (let i = 0; i < n && pp.deck.length > 0; i++) pp.draw(1); gs.addLog(`${pp.name} 抽 ${n} 张`); }
      return;
    }
    if (p.who === 'both' && (p.self_draw_count || p.opponent_draw_count)) {
      const opp = _opponent(gs, pl);
      const selfDraw = p.self_draw_count ?? p.draw_count ?? 4;
      const oppDraw = p.opponent_draw_count ?? p.draw_count ?? 4;
      pl.draw(selfDraw);
      opp.draw(oppDraw);
      gs.addLog(`双方手牌回牌库，自己抽 ${selfDraw} 张，对手抽 ${oppDraw} 张`);
      return;
    }
    const dc = (p.ownPrizesExactly != null && (pl.prizes ? pl.prizes.length : 0) === p.ownPrizesExactly)
      ? (p.countThen ?? (p.draw_count || 4))
      : (p.draw_count || 4);
    for (const pp of targets) pp.draw(dc);
    gs.addLog(`手牌回牌库，抽 ${dc} 张`);
  },

  // ===== 手牌附能 =====
  async attach_energy_from_hand(gs, pl, p) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, p.count || 1, {
      source:'hand-energy', filter:p.filter || '能量', prompt:'选择从手牌附着的能量',
      allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional
    });
    if (!selected.length) return;
    const allowActive = p.target !== 'bench';
    const allowBench = p.target !== 'active';
    const slot = await _pickPokemonTarget(gs, pl, pl, {
      mode:'attach-energy', side:'self', allowActive, allowBench, prompt:'选择附能目标',
      slotFilter: candidateSlot => _monMatchesType(_getMon(pl, candidateSlot), p.targetType)
    });
    const mon = _getMon(pl, slot);
    if (!mon) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) mon.energy.push(pl.hand.splice(item.index, 1)[0]);
    _emitEnergyAttached(gs, pl, mon, selected.map(x => x.card), true);
    gs.addLog(`从手牌附能 ${selected.length} 张`);
  },

  // ===== 对手能量回手 =====
  async return_energy_to_hand(gs, pl, p) {
    const owner = (p.target === 'self') ? pl : _opponent(gs, pl);
    const mon = owner.active;
    if (!mon?.energy?.length) return;
    const items = _attachedEnergyItems(gs, owner, mon, 'active', p.filter);
    const selected = await _pickAttachedEnergy(gs, pl, items, p.count || 1, { filter:p.filter || null, allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, optional:!!p.optional });
    for (const item of _removeAttachedEnergy(selected)) owner.hand.push(item.energy);
    if (selected.length) gs.addLog(`能量回手 ${selected.length} 张`);
  },

  // ===== 弃牌区放备战 =====
  async discard_to_bench(gs, pl, p) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.discard, p.count || 1, {
      source:'discard-to-bench', filter:p.filter || '宝可梦', prompt:'选择放到备战区的宝可梦',
      allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional
    });
    for (const item of selected) { const idx = pl.discard.indexOf(item.card); if (idx >= 0) pl.discard.splice(idx, 1); const mon = _makeBenchPokemonFromCard(gs, item.card); if (mon && pl.bench.length < 5) pl.bench.push(mon); }
    gs.addLog(`从弃牌区放置 ${selected.length} 只宝可梦到备战区`);
  },

  // ===== 弃牌区附能 =====
  async attach_energy_from_discard(gs, pl, p) {
    const allowActive = p.target !== 'bench';
    const allowBench = p.target !== 'active';
    const slot = await _pickPokemonTarget(gs, pl, pl, {
      mode:'attach-energy', side:'self', allowActive, allowBench, prompt:'选择附能目标',
      // ② 卡面写明「对会被【昏厥】的宝可梦，无法使用这个特性」→ 排除会因指示物被昏厥的目标
      slotFilter: candidateSlot => _monMatchesType(_getMon(pl, candidateSlot), p.targetType)
        && !_wouldBeKnockedOutByCounters(_getMon(pl, candidateSlot), p.damageCountersOnAttachedTarget)
    });
    const mon = _getMon(pl, slot);
    if (!mon) return;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.discard, p.count || 1, { source:'discard-energy', filter:card=>_isEnergyCard(gs, card, p.filter), allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) mon.energy.push(pl.discard.splice(item.index, 1)[0]);
    _emitEnergyAttached(gs, pl, mon, selected.map(x => x.card), false);
    if (p.damageCountersOnAttachedTarget) _applyDamageToPokemon(gs, pl, mon, p.damageCountersOnAttachedTarget * 10);
    gs.addLog(`从弃牌区附能 ${selected.length} 张`);
  },

  // ===== 牌库附能 =====
  async attach_energy_from_deck(gs, pl, p) {
    // F 赤红&青绿：「附着于进化后的宝可梦身上」
    const evolvedRec = gs._lastEvolved;
    const evolvedSlot = p.target === 'previous_evolved' && evolvedRec && evolvedRec.player === pl
      ? _slotOfMon(pl, evolvedRec.mon) : null;
    // target:'self' = 「附于这只宝可梦身上」（招式效果，指使用者自己），不要再弹目标选择
    const slot = evolvedSlot
      || (p.target === 'self' && pl.active ? 'active' : null)
      || await _pickPokemonTarget(gs, pl, pl, { mode:'attach-energy', side:'self', allowActive:p.target !== 'bench', allowBench:true, prompt:'选择附能目标',
          // ② 同弃牌区版：排除会因指示物被昏厥的目标
          slotFilter: candidateSlot => !_wouldBeKnockedOutByCounters(_getMon(pl, candidateSlot), p.damageCountersOnAttachedTarget)
        });
    const mon = _getMon(pl, slot);
    if (!mon) return;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.deck, p.count || 1, { source:'deck-energy', filter:card=>_isEnergyCard(gs, card, p.filter), allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) { gs._shuffle(pl.deck); return; }
    for (const item of selected.sort((a,b)=>b.index-a.index)) mon.energy.push(pl.deck.splice(item.index, 1)[0]);
    _emitEnergyAttached(gs, pl, mon, selected.map(x => x.card), false);
    // ② 「然后，在被附着的宝可梦身上放置N个伤害指示物」
    if (p.damageCountersOnAttachedTarget) _applyDamageToPokemon(gs, pl, mon, p.damageCountersOnAttachedTarget * 10);
    gs._shuffle(pl.deck);
    gs.addLog(`从牌库附能 ${selected.length} 张`);
  },

  // ===== 丢弃能量 =====
  async discard_energy_for_damage(gs, pl, p, eff) {
    const source = p.source || 'hand';
    let n = 0;
    const types = new Set();
    const record = e => { const m = String(e).match(/【(.+?)】/); if (m) types.add(m[1]); };
    if (source === 'hand') {
      const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, p.count === 'any' || p.count === 'all' ? pl.hand.length : (p.count || 1), {
        source:'discard-energy-for-damage', filter:p.filter || '能量', prompt:'选择丢弃的能量',
        allowFewer:true, allowEmpty:true, maxCount:p.count === 'any' || p.count === 'all' ? undefined : p.count, minCount:0, optional:true
      });
      n = selected.length;
      for (const item of selected.sort((a,b)=>b.index-a.index)) { const card = pl.hand.splice(item.index, 1)[0]; pl.discard.push(card); record(card); }
    } else {
      const mon = pl.active;
      const items = _attachedEnergyItems(gs, pl, mon, 'active', p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, p.count === 'any' || p.count === 'all' ? items.length : (p.count || 1), { filter:p.filter || null, allowFewer:true, allowEmpty:true, optional:true });
      n = selected.length;
      for (const item of _removeAttachedEnergy(selected)) { _pushEnergyDiscard(item.owner, item.energy); record(item.energy); }
    }
    if (eff) { eff._discardedCount = n; eff._discardedTypeCount = types.size; }
    gs.addLog(`丢弃 ${n} 张能量（用于伤害）`);
  },

  // ===== 丢弃能量 =====
  async discard_energy(gs, pl, p) {
    const owner = p.target?.startsWith?.('opponent') ? _opponent(gs, pl) : pl;
    let mon = null;
    let slot = null;
    if (p.target === 'opponent_bench') {
      slot = await _pickPokemonTarget(gs, pl, owner, {
        mode:'discard-energy-target', side:'opponent', allowActive:false, allowBench:true,
        slotFilter: candidateSlot => _slotHasMatchingAttachedEnergy(gs, owner, candidateSlot, p.filter) && !gs.isBenchProtectedFromOpponentAttack?.(owner, _getMon(owner, candidateSlot), 'effect'),
        prompt:'选择丢弃能量的对手备战宝可梦'
      });
      mon = _getMon(owner, slot);
    } else if (p.target === 'opponent_any' || p.target === 'opponent_field') {
      slot = await _pickPokemonTarget(gs, pl, owner, {
        mode:'discard-energy-target', side:'opponent', allowActive:true, allowBench:true,
        slotFilter: candidateSlot => _slotHasMatchingAttachedEnergy(gs, owner, candidateSlot, p.filter),
        prompt:'选择丢弃能量的对手宝可梦'
      });
      mon = _getMon(owner, slot);
    } else if (p.target === 'own_field') {
      // 「将附于自己场上宝可梦身上的任意数量的能量丢到弃牌区」——范围是自己**全场**，
      // 不是只有出战位（旧实现只有 self/opponent 两种，落到这里是出战位）
      const candidates = [pl.active, ...(pl.bench || [])].filter(Boolean);
      const items = candidates.flatMap(m => _attachedEnergyItems(gs, pl, m, _monSlot(pl, m), p.filter));
      if (!items.length) return;
      const selected = await _pickAttachedEnergy(gs, pl, items, p.count === 'all' ? 'all' : (p.count || 1), { filter:p.filter || null, allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
      if (!selected.length) return;
      for (const item of _removeAttachedEnergy(selected)) _pushEnergyDiscard(item.owner, item.energy);
      gs.addLog(`丢弃场上 ${selected.length} 个能量`);
      _applyCountedDamage(gs, pl, p, selected.length);
      return;
    } else {
      mon = p.target === 'opponent' || p.target === 'opponent_active' ? owner.active : pl.active;
      slot = _monSlot(owner, mon);
    }
    if (!mon || mon.energy.length === 0) return;
    const items = _attachedEnergyItems(gs, owner, mon, slot, p.filter);
    const selected = await _pickAttachedEnergy(gs, pl, items, p.count === 'all' ? 'all' : (p.count || 1), { filter:p.filter || null, allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) return;
    for (const item of _removeAttachedEnergy(selected)) _pushEnergyDiscard(item.owner, item.energy);
    gs.addLog(`丢弃 ${selected.length} 个能量`);
    _applyCountedDamage(gs, pl, p, selected.length);
  },

  // ===== 能量换位 =====
  async move_energy(gs, pl, p) {
    const wantCount = p.count === 'all' ? Infinity : (p.count || 1);
    if (p.source === 'bench' && p.dest === 'active' && pl.active) {
      const sourceSlot = await _pickPokemonTarget(gs, pl, pl, { mode:'move-energy-source', side:'self', allowActive:false, allowBench:true, prompt:'选择移动能量来源' });
      const sourceMon = _getMon(pl, sourceSlot);
      const items = _attachedEnergyItems(gs, pl, sourceMon, sourceSlot, p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, wantCount, { filter:p.filter || null, allowFewer:p.count === 'all' });
      for (const item of _removeAttachedEnergy(selected)) pl.active.energy.push(item.energy);
      if (selected.length) gs.addLog('能量转至出战');
    } else if (p.source === 'opponent_active' && p.dest === 'opponent_bench') {
      const opp = _opponent(gs, pl);
      const destSlot = await _pickPokemonTarget(gs, pl, opp, { mode:'move-energy-dest', side:'opponent', allowActive:false, allowBench:true, prompt:'选择对手转附能量的备战宝可梦' });
      const destMon = _getMon(opp, destSlot);
      if (!destMon) return;
      const items = _attachedEnergyItems(gs, opp, opp.active, 'active', p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, wantCount, { filter:p.filter || null, allowFewer:p.count === 'all' });
      for (const item of _removeAttachedEnergy(selected)) destMon.energy.push(item.energy);
      if (selected.length) gs.addLog('对手能量转至备战');
    } else if (p.source === 'self' && p.dest === 'bench' && pl.active) {
      const destSlot = await _pickPokemonTarget(gs, pl, pl, { mode:'move-energy-dest', side:'self', allowActive:false, allowBench:true, prompt:'选择移动能量目标' });
      const destMon = _getMon(pl, destSlot);
      if (!destMon) return;
      const items = _attachedEnergyItems(gs, pl, pl.active, 'active', p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, wantCount, { filter:p.filter || null, allowFewer:p.count === 'all' });
      for (const item of _removeAttachedEnergy(selected)) destMon.energy.push(item.energy);
      if (selected.length) gs.addLog('能量转至备战');
    }
  },

  // ===== 弃牌区回收 =====
  async recover_from_discard(gs, pl, p) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.discard, p.count || 1, { source:'discard', filter:p.filter || null, allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) {
      // 回收类效果：弃牌区没有合法目标时不能发动（否则会白用一张卡，甚至把不合规的卡回手）
      const required = (p.minCount ?? p.count ?? 1) > 0 && !p.optional && !p.allowEmpty && !p.allowFewer;
      if (required) _requiredFailure('recover_from_discard', 'no_target');
      return;
    }
    for (const item of selected.sort((a,b)=>b.index-a.index)) {
      // 统一存卡牌 ID：弃牌区可能残留能量对象（历史数据/旧的弃能量路径）
      const card = toCardRef(pl.discard.splice(item.index, 1)[0]);
      if (p.target === 'deck') pl.deck.push(card); else pl.hand.push(card);
    }
    if (p.target === 'deck' && p.shuffle) gs._shuffle(pl.deck);
    gs.addLog(`回收 ${selected.length} 张卡`);
  },

  // ===== 反射屏障类：下个对手回合受到招式伤害时反伤 =====
  mirror_damage_counters(gs, pl) {
    const mon = pl?.active;
    if (!mon) return;
    mon.mirrorDamageCounters = true;
    gs.addLog(`${mon.name} 进入反射状态：下个对手回合受到招式伤害时将反伤`);
  },

  // ===== 「招式学习器」类道具的回合结束丢弃（元数据；实际丢弃在 GameState.endTurn）=====
  tool_end_of_turn_discard() { /* no-op：标记类效果，由回合结束流程消费 */ },

  // ===== 多获奖赏 =====
  extra_prize(gs, pl) { gs.takePrize(pl); },

  // ===== 回合结束 =====
  end_turn(gs, pl) { gs.endTurn(); if (gs.phase === PHASE.DRAW) gs.nextPhase(); gs.addLog('回合结束'); },

  // ===== 重洗牌库 =====
  shuffle_deck(gs, pl) { gs._shuffle(pl.deck); },

  // ===== 掷硬币 =====
  async coin_flip(gs, pl, p) {
    const count = p.count || 1;
    let heads = 0;
    for (let i = 0; i < count; i++) { if (await _flipCoin(gs, pl)) heads++; }
    gs.addLog(`掷${count}次硬币: ${heads}正${count - heads}反`);
    if (p.fail_on_tails && heads < count) { gs.addLog('招式失败'); throw new Error('attack_failed'); }
    if (p.heads && heads > 0) {
      for (const eff of p.heads) { await EXECUTORS[eff.action]?.(gs, pl, eff.params); }
    }
    return { heads, tails: count - heads };
  },
  async coin_flip_status(gs, pl, p) {
    if (await _flipCoin(gs, pl)) {
      const opp = _opponent(gs, pl);
      if (opp.active && p.statuses) { _applyStatus(opp.active, p.statuses); gs.addLog(`硬币正面→${p.statuses.join('、')}`); }
    } else { gs.addLog('硬币反面'); }
  },
  async coin_flip_damage(gs, pl, p) {
    const count = p.count || 1;
    let heads = 0;
    for (let i = 0; i < count; i++) { if (await _flipCoin(gs, pl)) heads++; }
    const damagePer = Number.isFinite(p.damage_per) ? p.damage_per : (Number.isFinite(p.damage) ? p.damage : 20);
    const extra = heads * damagePer;
    const opp = _opponent(gs, pl);
    if (opp.active && extra > 0) { opp.active.hp -= extra; gs.addLog(`硬币+${extra}伤害`); if (opp.active.hp <= 0) gs.knockout(opp); }
    return { heads };
  },
  async coin_flip_until_tails(gs, pl, p) {
    let heads = 0;
    while (await _flipCoin(gs, pl)) heads++;
    const extra = heads * (p.damage_per || 20);
    const opp = _opponent(gs, pl);
    if (opp.active && extra > 0) { opp.active.hp -= extra; gs.addLog(`掷至反面+${extra}`); if (opp.active.hp <= 0) gs.knockout(opp); }
  },

  // ===== 伤害增减 =====
  damage_modify(gs, pl, p) {
    // Apply as buff on the active pokemon
    if (pl.active) {
      pl.active.damageMod = pl.active.damageMod || 0;
      pl.active.damageMod += (p.amount || 0);
      gs.addLog(`伤害修正 ${p.amount > 0 ? '+' : ''}${p.amount}`);
    }
  },
  damage_received_mod(gs, pl, p) {
    // 受到的招式的伤害±N：作用于目标宝可梦（self=这只 / opponent=对手 / own_field=自己所有）
    if (p.target === 'own_field') {
      for (const mon of [pl.active, ...(pl.bench||[])]) {
        if (!mon) continue;
        mon.damageReceivedMod = (mon.damageReceivedMod || 0) + (p.amount || 0);
      }
      gs.addLog(`己方所有宝可梦受到的伤害修正 ${p.amount > 0 ? '+' : ''}${p.amount}`);
      return;
    }
    const mon = (p.target === 'opponent') ? _opponent(gs, pl)?.active : pl.active;
    if (mon) {
      mon.damageReceivedMod = mon.damageReceivedMod || 0;
      mon.damageReceivedMod += (p.amount || 0);
      gs.addLog(`${mon.name} 受到的伤害修正 ${p.amount > 0 ? '+' : ''}${p.amount}`);
    }
  },

  // ===== 防止伤害 =====
  // duration='next_opp_turn' 时（如大岩蛇「坚硬头锤」）：生效窗口是**对手的下一个回合**，
  // 用 attackShieldArmed 标记它，让 GameState.endTurn 在自己回合结束时不要清掉，
  // 改由对手回合结束时清除（见 GameState.endTurn 的 1 / 1.1 两段）。
  /**
   * 「这张卡，可以从2个效果中选择1个使用」→ 弹出**效果描述**选择（不是选卡名）。
   * 选项文案来自分支效果的「精炼描述」（见解析端 _describeBranch）。
   * AI 侧固定选第一个分支（确定性；后续可接入 AiPolicy 打分）。
   */
  async choose_effect(gs, pl, p) {
    const branches = Array.isArray(p?.branches) ? p.branches : [];
    if (!branches.length) return;
    if (branches.length === 1) { await executeEffects(gs, pl, branches[0].effects || []); return; }
    const labels = branches.map(b => b.label || b.text || '效果');
    if (pl === gs.player1 && gs._onPendingPick) {
      const picked = await gs.waitForPick(labels, 1, {
        source:'choose-effect', prompt:'选择要使用的效果', minCount:1, maxCount:1,
      });
      const idx = Math.min(Math.max(Number(picked?.[0]) || 0, 0), branches.length - 1);
      gs.addLog(`选择了效果：${labels[idx]}`);
      await executeEffects(gs, pl, branches[idx].effects || []);
      return;
    }
    gs.addLog(`（自动决策）选择效果：${labels[0]}`);
    await executeEffects(gs, pl, branches[0].effects || []);
  },

  /**
   * E 「然后，将这只宝可梦，以及放置于其身上的所有卡牌，丢到弃牌区」
   * ⚠️ 这**不是昏厥**：不拿奖赏卡，只把这张卡与它身上的能量/道具放进弃牌区。
   * 「这只宝可梦」= 特性/招式的来源（eff.source，由 BattleEngine 注入）；拿不到就退回出战宝可梦。
   */
  discard_self_with_attachments(gs, pl, p, eff) {
    // who:'opponent' = 「将对手的战斗宝可梦，以及放置于其身上的所有卡牌，放置于放逐区」
    const owner = p.who === 'opponent' ? _opponent(gs, pl) : pl;
    const mon = p.who === 'opponent' ? owner.active : (eff?.source || pl.active);
    if (!mon) return;
    if (![owner.active, ...(owner.bench || [])].filter(Boolean).includes(mon)) {
      gs.addLog('（该宝可梦已不在场上）');
      return;
    }
    // toLostZone：放进放逐区而不是弃牌区（放逐区的卡不能被回收）
    const zone = p.toLostZone ? (owner.lostZone = owner.lostZone || []) : owner.discard;
    zone.push(_toolCardValue(mon));
    for (const e of (mon.energy || [])) zone.push(_toolCardValue(e));
    if (mon.tool) zone.push(_toolCardValue(mon.tool));
    const wasActive = owner.active === mon;
    const bi = (owner.bench || []).indexOf(mon);
    if (bi >= 0) owner.bench.splice(bi, 1);
    if (wasActive) {
      owner.active = owner.bench.length ? owner.bench.shift() : null;
      if (owner.active) gs.addLog(`${owner.name} 换上 ${owner.active.name}`);
    }
    gs.recomputePassives?.();
    gs.addLog(`${mon.name} 与身上的所有卡牌被${p.toLostZone ? '放于放逐区' : '丢到弃牌区'}`);
  },

  /**
   * F 可选代价：「另外，当使用这张卡时，可将N张自己的手牌丢到弃牌区。在这种情况下，…」
   * 支付成功才执行 then 里的效果；选不满 N 张视为不支付，整段跳过。
   * AI（无 UI）路径直接不支付 —— 自动选择会「全选」，等于无条件支付代价，反而更差。
   */
  async optional_hand_cost(gs, pl, p, eff, options) {
    const need = p.count || 1;
    const then = Array.isArray(p.then) ? p.then : [];
    if (!then.length) { gs.addLog('（该卡没有可选代价的后续效果）'); return; }
    if (!gs._onPendingPick) { gs.addLog('（自动决策不支付可选代价，跳过后续效果）'); return; }
    const sel = await _pickCardsFromZone(gs, pl, pl, pl.hand, need, {
      source:'optional-cost', prompt:`可选择弃掉 ${need} 张手牌来发动后续效果（不选则跳过）`,
      allowFewer:true, allowEmpty:true, maxCount:need, minCount:0, optional:true,
    });
    if (sel.length < need) { gs.addLog('未支付可选代价，跳过后续效果'); return; }
    for (const item of sel.sort((a, b) => b.index - a.index)) pl.discard.push(pl.hand.splice(item.index, 1)[0]);
    gs.addLog(`弃掉 ${need} 张手牌`);
    await executeEffects(gs, pl, then);
  },

  /** F 古兹马&哈拉：「将「宝可梦道具」和「特殊能量」各1张加入手牌」→ 依次各检索 1 张 */
  async search_deck_multi(gs, pl, p) {
    for (const spec of (p.specs || [])) {
      const selected = await _pickCardsFromZone(gs, pl, pl, pl.deck, spec.count || 1, {
        source:'search-deck', filter: card => _cardMatchesFilter(gs, card, spec.filter),
        allowFewer:true, optional:true, failRequired:false,
      });
      for (const item of selected.sort((a, b) => b.index - a.index)) pl.hand.push(pl.deck.splice(item.index, 1)[0]);
      if (selected.length) gs.addLog(`从牌库拿了「${spec.filter}」${selected.length} 张`);
    }
    gs._shuffle?.(pl.deck);
  },

  // ③ 招式版伤害硬币护盾（残影斩）：在下一个对手的回合，每次受到招式伤害都要重掷硬币
  attack_damage_flip_shield(gs, pl, p) {
    const mon = pl.active;
    if (!mon) return;
    mon.damageFlipShieldArmed = true;
    if (p?.duration === 'next_opp_turn') {
      mon.attackShieldArmed = true; // 复用「撑过自己回合结束、对手回合结束时清除」的既有语义
      gs.addLog(`${mon.name} 在下一个对手的回合受到招式伤害时会抛掷硬币`);
    }
  },
  // ③ 特性版（被动）：这里故意什么都不做，由 BattleEngine 结算伤害时读取标记。
  //    写成空实现是为了避免执行层把它记为「[未实现]」。
  coin_flip_damage_shield() {},
  prevent_damage(gs, pl, p) {
    _applyAttackShield(gs, pl.active, { damage: true, duration: p?.duration });
  },
  prevent_effect(gs, pl, p) {
    _applyAttackShield(gs, pl.active, { effect: true, duration: p?.duration });
  },
  prevent_damage_effect(gs, pl, p) {
    _applyAttackShield(gs, pl.active, { damage: true, effect: true, duration: p?.duration });
  },
  bench_attack_shield(gs, pl, p) {
    gs.addLog('备战保护生效');
  },

  // ===== 无视 =====
  ignore(gs, pl, p) {
    if (pl.active) {
      pl.active.ignore = pl.active.ignore || [];
      // 组合值拆分为 BattleEngine 可识别的单个标记
      const whats = p.what === 'weakness_resistance_effects' ? ['weakness', 'resistance', 'opponent_effects'] : [p.what];
      for (const w of whats) { if (!pl.active.ignore.includes(w)) pl.active.ignore.push(w); }
      gs.addLog(`无视${p.what}`);
    }
  },

  // ===== 无法攻击 =====
  cannot_attack_next(gs, pl, p) {
    const target = p.target === 'opponent' ? _opponent(gs, pl).active : pl.active;
    if (target) { target.cannotAttackNext = true; gs.addLog(p.target === 'opponent' ? '对手下回合无法使用招式' : '下回合无法攻击'); }
  },

  // ===== 下回合招式伤害降低（对手受击宝可梦攻击伤害 -N）=====
  damage_reduction_next(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.active) { opp.active.attackDamageReduction = (opp.active.attackDamageReduction || 0) + (p.amount || 0); gs.addLog(`对手下回合招式伤害 -${p.amount || 0}`); }
  },

  // ===== 下个自己回合招式伤害提升 =====
  damage_boost_next_self(gs, pl, p) {
    if (pl.active) { pl.active.nextOwnTurnDamageBoost = (pl.active.nextOwnTurnDamageBoost || 0) + (p.amount || 0); gs.addLog(`下个自己回合招式伤害 +${p.amount || 0}`); }
  },

  // ===== 道具效果消除（被动近似）=====
  tool_effect_nullify(gs, pl, p) {
    if (p.scope === 'both_field') { gs.toolEffectNullified = true; gs.addLog('双方宝可梦道具的效果被消除（近似）'); }
  },

  // ===== 出牌限制（下回合对手无法使出物品等；由 canUseTrainer 查询）=====
  play_restriction(gs, pl, p) {
    const opp = _opponent(gs, pl);
    opp.playRestrictions = opp.playRestrictions || {};
    opp.playRestrictions[p.what || 'item'] = 'next_opp_turn';
    gs.addLog(`对手下回合无法使用${p.what === 'item' ? '物品' : (p.what || '指定卡')}`);
  },

  /** 一树：本回合第一次由效果触发的掷硬币可由自己决定结果（记一个一次性标记） */
  coin_choice_this_turn(gs, pl) {
    pl.coinChoiceArmed = true;
    gs.addLog('本回合首次掷硬币的结果可由自己决定');
  },

  /**
   * 「将自己弃牌区中的所有基本能量给对手查看，造成其张数×N伤害。然后，将给对手查看过的能量放回牌库」
   * 计数来自**区域**（弃牌区），不是上一个动作移动的张数；所以不走 _applyCountedDamage。
   */
  async discard_energy_peek_damage(gs, pl, p) {
    const filter = p.filter || '基本能量';
    const matches = (pl.discard || []).filter(c => _cardMatchesFilter(gs, c, filter));
    const per = +p.per || 0;
    gs.addLog(`给对手查看弃牌区中的 ${matches.length} 张${filter}`);
    if (per && matches.length) {
      const opp = _opponent(gs, pl);
      if (opp?.active) _applyDamageToPokemon(gs, opp, opp.active, per * matches.length);
      gs.addLog(`造成其张数×${per}＝${per * matches.length} 伤害`);
    }
    if (p.returnToDeck) {
      for (const c of matches) {
        const i = pl.discard.indexOf(c);
        if (i >= 0) pl.deck.push(pl.discard.splice(i, 1)[0]);
      }
      gs._shuffle?.(pl.deck);
      gs.addLog(`查看过的 ${matches.length} 张能量放回牌库并重洗`);
    }
  },

  /** 「将自己手牌中任意数量的「X」给对手查看，造成其张数×N伤害」——只展示，不改动手牌 */
  async reveal_hand_for_damage(gs, pl, p) {
    const per = +p.per || 0;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.hand, pl.hand.length, {
      source:'reveal-hand', filter: card => _cardMatchesFilter(gs, card, p.filter || null),
      prompt:`选择要给对手查看的「${p.filter || '卡'}」`, allowFewer:true, allowEmpty:true, optional:true,
    });
    gs.addLog(`给对手查看手牌 ${selected.length} 张`);
    if (per && selected.length) {
      const opp = _opponent(gs, pl);
      if (opp?.active) _applyDamageToPokemon(gs, opp, opp.active, per * selected.length);
      gs.addLog(`造成其张数×${per}＝${per * selected.length} 伤害`);
    }
  },

  /** 「将自己场上宝可梦身上附着的任意数量的能量放回牌库，造成其张数×N伤害」 */
  async energy_to_deck_for_damage(gs, pl, p) {
    const candidates = [pl.active, ...(pl.bench || [])].filter(Boolean);
    const items = candidates.flatMap(m => _attachedEnergyItems(gs, pl, m, _monSlot(pl, m), p.filter));
    if (!items.length) return;
    const selected = await _pickAttachedEnergy(gs, pl, items, 'all', { filter:p.filter || null, allowFewer:true, allowEmpty:true, optional:true });
    if (!selected.length) return;
    for (const item of _removeAttachedEnergy(selected)) pl.deck.push(toCardRef(item.energy));
    gs._shuffle?.(pl.deck);
    gs.addLog(`${selected.length} 个能量放回牌库并重洗`);
    const per = +p.per || 0;
    if (per) {
      const opp = _opponent(gs, pl);
      if (opp?.active) _applyDamageToPokemon(gs, opp, opp.active, per * selected.length);
      gs.addLog(`造成其张数×${per}＝${per * selected.length} 伤害`);
    }
  },

  /**
   * 「昏厥 → 放逐区」替代效果。
   * scope:'attack'（达克莱伊）由本动作当场设标记；其余三种 scope 是**持续/场地**效果，
   * 由 GameState._knockoutDestination 在被昏厥时读取（这里注册空实现，避免执行层记为「未实现」）。
   */
  ko_to_lost_zone(gs, pl, p) {
    if (p?.scope !== 'attack') return;
    gs._koContext = { ...(gs._koContext || {}), toLostZone:true, withAttachments:!!p.withAttachments };
    gs.addLog('本次招式造成的昏厥将放于放逐区');
  },

  /**
   * 胜利条件（未知图腾「伤害 / 手牌 / 放逐」）：
   * 达成即立刻结束对战并判自己获胜；未达成时什么都不做（特性本身已被置灰）。
   */
  win_condition(gs, pl, p) {
    const need = +p?.threshold || 0;
    const have = gs._winConditionProgress ? gs._winConditionProgress(pl, p?.kind) : 0;
    if (have < need) { gs.addLog(`胜利条件未达成（${have}/${need}）`); return; }
    gs.winner = pl;
    gs.phase = PHASE.GAME_OVER;
    gs.addLog(`${pl.name} 达成胜利条件（${p?.kind} ${have}/${need}），获得胜利！`);
  },

  /**
   * 「(在)使用了这张卡牌的回合结束时，<效果>」——把效果挂到回合结束时结算。
   * endTurn 是同步流程，所以这里只登记；由 GameState.endTurn 在回合末取出并执行。
   */
  defer_to_turn_end(gs, pl, p) {
    const effects = Array.isArray(p?.effects) ? p.effects : [];
    if (!effects.length) return;
    (gs.pendingTurnEnd = gs.pendingTurnEnd || []).push({ player: pl, effects });
    gs.addLog(`（已登记回合结束时结算的效果 ×${effects.length}）`);
  },

  /** 弱丁鱼：「将这只宝可梦，以及放置于其身上的所有卡牌，放回自己的牌库并重洗牌库」 */
  return_self_to_deck(gs, pl, p, eff) {
    const mon = p?.triggerSource || eff?.source || pl.active;
    if (!mon) return;
    const bi = (pl.bench || []).indexOf(mon);
    const wasActive = pl.active === mon;
    const cards = [_toolCardValue(mon), ...((mon.energy || []).map(_toolCardValue))];
    if (mon.tool) cards.push(_toolCardValue(mon.tool));
    pl.deck.push(...cards);
    if (bi >= 0) pl.bench.splice(bi, 1);
    if (wasActive) {
      pl.active = pl.bench.length ? pl.bench.shift() : null;
      if (pl.active) gs.addLog(`${pl.name} 换上 ${pl.active.name}`);
    }
    gs._shuffle?.(pl.deck);
    gs.recomputePassives?.();
    gs.addLog(`${mon.name} 与身上的卡牌被放回牌库并重洗`);
  },

  /** 「然后，将这张卡牌放于弃牌区」——触发式道具在触发后自弃（如文柚果/木子果/应急果冻） */
  discard_self_tool(gs, pl, p) {
    const mon = p?.triggerSource || pl.active;
    if (!mon || !mon.tool) return;
    (pl.discard = pl.discard || []).push(_toolCardValue(mon.tool));
    gs.addLog(`${mon.name} 身上的「${_toolLabelOf(gs, mon.tool)}」被放入弃牌区`);
    mon.tool = null;
  },

  // ===== 特殊状态全恢复 =====
  heal_status(gs, pl, p) {
    const target = p.target === 'trigger_source' && p.triggerSource ? p.triggerSource
      : (p.target === 'opponent' ? _opponent(gs, pl).active : pl.active);
    if (target) { gs._removeSpecialConditions?.(target); gs.addLog('特殊状态全部恢复'); }
  },

  // ===== 无法撤退 =====
  cannot_retreat(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (p.target === 'opponent' && opp.active) { opp.active.cannotRetreat = true; gs.addLog('对手无法撤退'); }
  },

  // ===== 对手牌库丢弃 =====
  mill(gs, pl, p) {
    const owner = (p.target === 'self') ? pl : _opponent(gs, pl);
    const n = Math.min(p.count || 1, owner.deck.length);
    for (let i = 0; i < n; i++) owner.discard.push(owner.deck.pop());
    gs.addLog(`${p.target === 'self' ? '自己' : '对手'}弃 ${n} 张`);
    _applyCountedDamage(gs, pl, p, n);
  },

  // ===== 查看对手手牌 =====
  look_at(gs, pl, p) { gs.addLog('查看了对手手牌'); },

  // ===== 随机丢弃对手手牌 =====
  discard_opponent_hand_random(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.hand.length > 0) { const i = Math.floor(Math.random() * opp.hand.length); opp.discard.push(opp.hand.splice(i, 1)[0]); gs.addLog('随机丢弃对手1张手牌'); }
  },

  // ===== 放逐区 =====
  /**
   * 放逐区：把卡真正移入 pl.lostZone。
   * 「放逐」与「弃牌」必须分开存 —— 放逐区的卡不能被回收类效果拿回来，
   * 而「放逐区张数」也是不少卡的条件（own_lost_zone_pokemon / lost_zone_min）。
   */
  async lost_zone(gs, pl, p = {}) {
    const zone = pl.lostZone = pl.lostZone || [];
    const move = (owner, cards) => { for (const c of cards) (owner.lostZone = owner.lostZone || []).push(c); };
    const take = (arr, n) => (n === 'any' ? arr.splice(0, arr.length) : arr.splice(Math.max(0, arr.length - n), n));
    switch (p.from) {
      case 'deck_top': {
        const n = Math.min(p.count || 1, pl.deck.length);
        const cards = pl.deck.splice(pl.deck.length - n, n);
        zone.push(...cards);
        gs.addLog(`牌库上方 ${cards.length} 张放入放逐区`);
        _applyCountedDamage(gs, pl, p, cards.length);
        return;
      }
      case 'discard': {
        // 「将自己弃牌区中任意数量的「宝可梦道具」放置于放逐区」
        const n = p.count === 'any' ? 99 : (p.count || 1);
        const sel = await _pickCardsFromZone(gs, pl, pl, pl.discard, n, {
          source:'lost-zone-discard', filter: card => _cardMatchesFilter(gs, card, p.filter || null),
          prompt:'选择要放于放逐区的卡', allowFewer:true, allowEmpty:true, optional:true,
        });
        for (const item of sel.sort((a, b) => b.index - a.index)) zone.push(pl.discard.splice(item.index, 1)[0]);
        gs.addLog(`弃牌区 ${sel.length} 张放入放逐区`);
        _applyCountedDamage(gs, pl, p, sel.length);
        return;
      }
      case 'hand': {
        const n = p.count === 'any' ? pl.hand.length : (p.count || 1);
        const sel = await _pickCardsFromZone(gs, pl, pl, pl.hand, n, {
          source:'lost-zone-hand', filter: card => _cardMatchesFilter(gs, card, p.filter || null),
          prompt:'选择要放于放逐区的手牌', allowFewer:true, allowEmpty:true, optional:true,
        });
        for (const item of sel.sort((a, b) => b.index - a.index)) zone.push(pl.hand.splice(item.index, 1)[0]);
        gs.addLog(`手牌 ${sel.length} 张放入放逐区`);
        _applyCountedDamage(gs, pl, p, sel.length);
        return;
      }
      case 'field_energy':
      case 'self_energy': {
        // 「选择附于（自己场上|这只）宝可梦身上的N个能量，放置于放逐区」
        const mons = p.from === 'self_energy' ? [pl.active].filter(Boolean) : [pl.active, ...(pl.bench || [])].filter(Boolean);
        const pool = [];
        for (const mon of mons) for (const e of (mon.energy || [])) pool.push({ mon, e });
        const want = p.count === 'any' ? pool.length : (p.count || 1);
        const picked = [];
        if (pl === gs.player1 && gs._onPendingPick && pool.length > want) {
          const labels = pool.map(x => `【${x.mon.name}】${(x.e && (x.e.name || x.e.cardId)) || x.e}`);
          const got = await gs.waitForPick(labels, want, { source:'lost-zone-energy', prompt:'选择要放于放逐区的能量', minCount:want, maxCount:want });
          for (const i of (got || [])) if (pool[i]) picked.push(pool[i]);
        } else {
          for (const x of pool.slice(0, want)) picked.push(x);
        }
        for (const x of picked) {
          const idx = x.mon.energy.indexOf(x.e);
          if (idx >= 0) x.mon.energy.splice(idx, 1);
          zone.push(toCardRef(x.e));
        }
        gs.addLog(`${picked.length} 个能量放入放逐区`);
        _applyCountedDamage(gs, pl, p, picked.length);
        return;
      }
      default:
        gs.addLog('（放逐区：未识别的来源，什么都没做）');
    }
  },

  // 被动标记：由 checkEnergy 读取（这里不做任何事，避免执行层记为「未实现」）
  cost_eliminated_if_lost_zone() {},

  // ===== 消除能量费用 =====
  energy_cost_eliminate(gs, pl, p) {
    if (pl.active) { pl.active.costEliminated = true; gs.addLog('招式费用消除'); }
  },

  // ===== 撤退费用增减 =====
  retreat_cost_increase(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.active) { opp.active.retreatCostIncrease = (opp.active.retreatCostIncrease || 0) + (p.amount || 1); gs.addLog(`对手撤退费用 +${p.amount || 1}`); }
  },

  // ===== 最大HP加成（被动：由 specialRules.maxHpBonus 附着时应用 + 特性由 getPassiveMaxHpModifier 查询）=====
  max_hp_mod(gs, pl, p) { gs.addLog('最大HP加成'); },

  // ===== 使用招式所需能量增加（一次性）=====
  attack_cost_increase(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.active) { opp.active.attackCostIncrease = (opp.active.attackCostIncrease || 0) + (p.amount || 1); gs.addLog(`对手使用招式所需能量 +${p.amount || 1}`); }
  },

  // ===== 使用招式 + 撤退所需能量同时增加（一次性）=====
  cost_increase_both(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.active) { opp.active.attackCostIncrease = (opp.active.attackCostIncrease || 0) + (p.amount || 1); opp.active.retreatCostIncrease = (opp.active.retreatCostIncrease || 0) + (p.amount || 1); gs.addLog(`对手使用招式与撤退所需能量各 +${p.amount || 1}`); }
  },

  // ===== 丢弃对手道具 =====
  discard_tool(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const mon = opp.active;
    if (mon?.tool) { opp.discard.push(mon.tool); mon.tool = null; gs.addLog('丢弃对手道具'); }
  },

  // ===== 条件效果（如果…则…：先判条件，再执行内层效果）=====
  async conditional_effect(gs, pl, p, eff, options) {
    if (!gs._conditionSatisfied?.(pl.active, p.condition, p)) return;
    const inner = p.effect;
    if (!inner) return;
    if (inner.action === 'knockout') {
      const target = inner.params?.target === 'self' ? pl.active : _opponent(gs, pl).active;
      if (target) { target.hp = 0; gs.knockout?.(target); gs.addLog(`${target.name} 被击倒`); }
      return;
    }
    if (inner.action === 'attack_fail') {
      gs.addLog('条件不满足，招式失败');
      throw new RequiredEffectFailed('attack_fail', '条件不满足，招式失败');
    }
    const fn = EXECUTORS[inner.action];
    if (fn) await fn(gs, pl, inner.params || {}, eff, options);
  },

  // ===== 直接击倒 =====
  knockout(gs, pl, p, eff) {
    // 「令这只宝可梦昏厥」中的「这只」= 效果的**来源宝可梦**，而不是战斗场的宝可梦。
    // （例：备战区的仿徨夜灵发动「咒怨炸弹」，应令它自己昏厥；
    //   原实现误取 pl.active，导致把战斗场的宝可梦弄昏厥）
    const opponent = _opponent(gs, pl);
    const inPlay = mon => !!mon && (mon === pl.active || (pl.bench || []).includes(mon));
    if (p?.target === 'self') {
      const source = eff?.source || null;
      const target = inPlay(source) ? source : pl.active;
      if (!target) return;
      target.hp = 0;
      _knockoutPokemon(gs, pl, target);
      gs.addLog(`${target.name} 被击倒`);
      return;
    }
    if (opponent?.active) {
      opponent.active.hp = 0;
      _knockoutPokemon(gs, opponent, opponent.active);
      gs.addLog(`${opponent.active?.name || ''} 被击倒`);
    }
  },

  // ===== 特性消除（主动/临时效果）=====
  ability_nullify(gs, pl, p) {
    if (p.duration !== 'turn') return;
    gs.addTemporaryAbilityLock?.(pl, p.scope || 'opponent_active', '临时效果');
    gs.addLog('特性被消除');
  },

  // ===== 化石放置 =====
  fossil_place(gs, pl, p) { gs.addLog('化石放置'); },
  // ===== 被动光环（解析已支持；连续生效的执行需在 GameState 被动层接入）=====
  retreat_cost_zero(gs, pl, p) { /* 被动：由 GameState.effectiveRetreatCost 运行时查询 */ },
  cannot_retreat_passive(gs, pl, p) { /* 被动：由 GameState.retreat 运行时查询 */ },
  energy_provides(gs, pl, p) { /* 特殊能量供能由 CardResolver 处理，此处 no-op */ },
  energy_provides_multiplier(gs, pl, p) { /* 特殊能量倍增供能由 CardResolver 处理，此处 no-op */ },
  block_heal(gs, pl, p) { /* 被动：由 heal 执行器运行时查询 */ },
  block_special_condition(gs, pl, p) { /* 被动：由 inflict_status 运行时查询 */ },
  block_status(gs, pl, p) { /* 被动：由 inflict_status 运行时查询 */ },
  dual_type(gs, pl, p) { /* 双属性：元素判断待接入 */ },
  weakness_null(gs, pl, p) { /* 被动：由 BattleEngine 弱点计算查询 */ },
  poison_damage_increase(gs, pl, p) { /* 被动：由 endTurn 中毒结算查询 */ },
  attack_cost_reduction(gs, pl, p) { /* 被动：由 adjustedAttackCost 查询 */ },
  retreat_cost_reduce(gs, pl, p) { /* 被动：由 effectiveRetreatCost 查询 */ },
  attach_energy_trigger(gs, pl, p) { /* 触发式：由事件系统处理 */ },
  conditional_damage_mod(gs, pl, p) { /* 由 getConditionalDamageModifier 运行时计算 */ },
  passive_damage_mod(gs, pl, p) { /* 由 getPassiveDamageModifier 运行时计算 */ },
  trigger(gs, pl, p) { /* 由事件系统 _emitTriggers 处理 */ },

  // ===== 竞技场 =====
  // stadium effects are handled as passives, not here

  // ===== 工具模板（忽略）=====
  tool_template() {},
};
