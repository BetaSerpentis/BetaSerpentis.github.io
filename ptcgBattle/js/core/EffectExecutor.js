// js/core/EffectExecutor.js — 异步执行指令 (v3 全效果)
import { PHASE } from './GameState.js';

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
  for (const item of selected.sort((a, b) => b.index - a.index)) {
    pl.discard.push(pl.hand.splice(item.index, 1)[0]);
    if (item.index < adjustedTrainerIndex) adjustedTrainerIndex -= 1;
  }
  gs.addLog(`支付费用：丢弃 ${selected.length} 张手牌`);
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
    if (options.failRequired && limit.min > 0 && !limit.allowEmpty && !limit.allowFewer && !options.optional) _requiredFailure(options.requiredAction || 'pick_cards', 'required_no_candidates');
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
  const meta = _resolveZoneCard(gs, card);
  const text = meta.label;
  const f = String(filter).replace(/["“”]/g, '').trim();
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
  if (/拥有规则的宝可梦.*?除外|规则.*?除外/.test(f) && _isRuleBoxPokemon(meta, card)) return false;
  if ((/【(?:基础|基本)】\s*宝可梦|(?:基础|基本)宝可梦/.test(f)) && !_isBasicPokemonCard(gs, card)) return false;
  const pokemonTypeMatches = _pokemonClauseTypes(f, typeMatches);
  if (!pokemonTypeMatches.length) return true;
  return pokemonTypeMatches.some(t => _metaHasPokemonType(meta, t));
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
  const raw = `${meta.label || ''} ${meta.full?.ruleBox || ''} ${card?.ruleBox || ''} ${(meta.full?.tags || []).join(' ')} ${(card?.tags || []).join(' ')}`;
  if (/拥有规则的宝可梦|规则宝可梦|\b(rule\s*box|pokemon\s+with\s+a\s+rule\s+box)\b/i.test(raw)) return true;
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
  // Unknown string IDs keep the existing broad Pokémon safe fallback.
  return !meta.resolved;
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
function _pushEnergyDiscard(owner, energy) { owner.discard.push(energy); }
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
  mon.attacks = cd.attacks; mon.element = cd.element; mon.weakness = cd.weakness || null; mon.resistance = cd.resistance || null;
  mon.retreatCost = cd.retreatCost ?? 1; mon.ability = cd.ability || null; mon.abilityUsed = false; mon.abilityDisabled = false; mon.abilityDisabledBy = null;
  mon.placedThisTurn = false; mon.evolvedThisTurn = evolvedThisTurn;
  gs.recomputePassives?.();
}
function _removeFirstFromDiscard(pl, card) {
  const idx = pl.discard.lastIndexOf(card);
  if (idx >= 0) pl.discard.splice(idx, 1);
}
function _applyDamageToPokemon(gs, owner, mon, amount, logSuffix = '受到') {
  if (!mon || !amount) return false;
  mon.hp -= amount;
  gs.addLog(`${mon.name} ${logSuffix} ${amount} 伤害`);
  if (mon.hp <= 0) _knockoutPokemon(gs, owner, mon);
  return true;
}
function _knockoutPokemon(gs, owner, mon) {
  if (!owner || !mon) return;
  if (owner.active === mon) {
    gs.knockout(owner);
    return;
  }
  const benchIndex = owner.bench.indexOf(mon);
  if (benchIndex < 0) return;
  owner.bench.splice(benchIndex, 1);
  owner.discard.push(mon.cardId);
  gs.addLog(`${owner.name} 的 ${mon.name} 被击倒！`);
  const prizeTaker = gs.getOpponent?.(owner) || [gs.player1, gs.player2].find(p => p !== owner);
  if (prizeTaker) gs.takePrize(prizeTaker);
  gs.recomputePassives?.();
}

const EXECUTORS = {
  // ===== 元数据/使用前提（当前仅记录，不强制执行） =====
  trainer_prerequisite(gs, pl, p) { gs.addLog(`使用前提: ${p.kind}`); },
  usage_condition(gs, pl, p) { gs.addLog(`使用条件: ${p.kind}`); },

  // ===== 抽卡 =====
  draw(gs, pl, p) { const n = p.count || 1; pl.draw(n); gs.addLog(`抽了 ${n} 张卡`); },
  draw_until(gs, pl, p) { const t = p.target || 6; while (pl.hand.length < t && pl.deck.length > 0) pl.draw(1); gs.addLog(`抽卡至 ${t} 张`); },

  // ===== 搜牌库加手 =====
  async search_deck_to_hand(gs, pl, p, eff, options) {
    if (pl.deck.length === 0) {
      if (_effectIsRequired(eff, p, options)) _requiredFailure(eff?.action, 'required_empty_deck');
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

  // ===== 搜牌库放备战 =====
  async search_deck_to_bench(gs, pl, p, eff, options) {
    if (pl.deck.length === 0) { gs.addLog('牌库为空，无法搜索宝可梦'); if (_effectIsRequired(eff, p, options)) _requiredFailure(eff?.action, 'required_empty_deck'); return; }
    const openSlots = Math.max(0, 5 - pl.bench.length);
    if (openSlots <= 0) { gs.addLog('备战区已满，无法放置宝可梦'); gs._shuffle(pl.deck); if (_effectIsRequired(eff, p, options)) _requiredFailure(eff?.action, 'required_no_bench_space'); return; }
    const count = Math.min(p.count || 1, openSlots);
    const cards = [...pl.deck].reverse();
    const filter = card => _cardMatchesFilter(gs, card, p.filter || '宝可梦') && _isBasicPokemonCard(gs, card);
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
    const limit = _selectionLimit(keep, candidates.length, p);
    let selected = [];
    if (candidates.length === 0) {
      const filterText = p.filter ? `符合${p.filter}条件的卡` : '符合条件的卡';
      gs.addLog(`查看了 ${peek} 张，没有${filterText}`);
    }
    if (limit.max <= 0 && _effectIsRequired(eff, p, options)) _requiredFailure(eff?.action, 'required_no_candidates');
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
    if (remainderMode === 'shuffle') {
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
    const stage2Candidates = (pl.hand || [])
      .map((card, index) => ({ card, index, data:gs.cardResolver?.getCard?.(card) }))
      .filter(item => item.data?.cardType === 'pokemon' && item.data.stage === '2阶' && item.data.evolvesFrom);
    if (!stage2Candidates.length) { gs.addLog('手牌中没有可用的2阶进化宝可梦'); return; }
    const chosenCards = await _pickCardsFromZone(gs, pl, pl, pl.hand, 1, {
      source:'rare-candy-evolution-card',
      filter:card => stage2Candidates.some(item => item.card === card),
      excludeIndices:[],
      prompt:'选择神奇糖果进化的2阶宝可梦'
    });
    const chosen = chosenCards[0];
    if (!chosen) return;
    const cd = gs.cardResolver?.getCard?.(chosen.card);
    const eligibleSlots = ['active', ...pl.bench.map((_, i) => `bench-${i}`)].filter(slot => {
      const mon = _getMon(pl, slot);
      return mon && !mon.placedThisTurn && !mon.evolvedThisTurn && _basicCanRareCandyTo(gs, mon, cd);
    });
    if (!eligibleSlots.length) { gs.addLog('场上没有可用神奇糖果进化的基础宝可梦'); return; }
    const slot = await _pickPokemonTarget(gs, pl, pl, {
      mode:'evolve', side:'self', allowActive:true, allowBench:true, selectableSlots:eligibleSlots,
      slotFilter:candidateSlot => eligibleSlots.includes(candidateSlot),
      prompt:'选择要使用神奇糖果进化的基础宝可梦'
    });
    if (!eligibleSlots.includes(slot)) return;
    const mon = _getMon(pl, slot);
    const handIndex = pl.hand.indexOf(chosen.card);
    if (handIndex < 0) return;
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
    let n = 0;
    for (const mon of [opp.active, ...opp.bench]) {
      if (!mon) continue;
      if (p.tools && mon.tool) { opp.discard.push(mon.tool); mon.tool = null; n++; }
      if (p.specialEnergy && mon.energy?.length) {
        const kept = [];
        for (const e of mon.energy) {
          if (String(e).includes('特殊') || !String(e).includes('基本')) { opp.discard.push(e); n++; }
          else kept.push(e);
        }
        mon.energy = kept;
      }
    }
    if (p.stadium) {
      const old = gs.clearActiveStadium?.();
      if (old) n++;
    }
    gs.addLog(`丢弃场上附加卡 ${n} 张`);
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
  heal(gs, pl, p) {
    const mon = pl.active;
    if (!mon) return;
    const amount = p.amount === 'full' ? mon.maxHp : (p.amount || 20);
    mon.hp = Math.min(mon.maxHp, mon.hp + amount);
    gs.addLog(`恢复 ${amount} HP`);
  },

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
    if (target === 'opponent_all') {
      for (const mon of [opp.active, ...opp.bench]) _applyDamageToPokemon(gs, opp, mon, dmg);
    }
  },

  // ===== 备战区伤害 =====
  async damage_bench(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const dmg = p.damage || 20;
    if (p.target === 'opponent_1' || p.target === 'opponent_any') {
      const slot = await _pickPokemonTarget(gs, pl, opp, { mode:'damage', side:'opponent', allowActive:false, allowBench:true, prompt:'选择受到备战伤害的宝可梦' });
      const mon = _getMon(opp, slot);
      if (mon) { mon.hp -= dmg; gs.addLog(`${mon.name} 备战受 ${dmg}`); if (mon.hp <= 0) gs.knockout(opp); }
    } else if (p.target === 'opponent_all') {
      for (const mon of opp.bench) { if (mon) { mon.hp -= dmg; if (mon.hp <= 0) gs.knockout(opp); } }
      gs.addLog(`对手备战区各受 ${dmg}`);
    } else if (p.target === 'self_all') {
      for (const mon of pl.bench) { if (mon) { mon.hp -= dmg; if (mon.hp <= 0) gs.knockout(pl); } }
      gs.addLog(`己方备战区各受 ${dmg}`);
    }
  },

  // ===== 状态异常 =====
  inflict_status(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.active && p.statuses) { opp.active.status = p.statuses.join(','); gs.addLog(`对手 ${p.statuses.join('、')}`); }
  },
  inflict_status_self(gs, pl, p) {
    if (pl.active && p.statuses) { pl.active.status = p.statuses.join(','); gs.addLog(`陷入 ${p.statuses.join('、')}`); }
  },
  inflict_status_both(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (pl.active && p.statuses) pl.active.status = p.statuses.join(',');
    if (opp.active && p.statuses) opp.active.status = p.statuses.join(',');
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
    gs.addLog(`${pl.active.name} 因特性换到战斗场`);
    gs.recomputePassives?.();
  },
  async switch_pokemon(gs, pl, p, eff, options) {
    const failRequired = _effectIsRequired(eff, p, options);
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
      if (opp.bench[idx]) { const t = opp.active; opp.active = opp.bench.splice(idx,1)[0]; if (t) opp.bench.push(t); gs.addLog('对手换位'); }
    } else if (p.who === 'both') {
      for (const pp of [pl, _opponent(gs, pl)]) {
        if (pp.bench.length > 0) { const t = pp.active; pp.active = pp.bench.shift(); if (t) pp.bench.push(t); }
      }
      gs.addLog('双方换位');
    } else {
      const slot = await _pickPokemonTarget(gs, pl, pl, { mode:'switch', side:'self', allowActive:false, allowBench:true, prompt:'选择换上场的备战宝可梦', failRequired, requiredAction:eff?.action });
      const idx = slot?.startsWith('bench-') ? parseInt(slot.replace('bench-', '')) : -1;
      if (pl.bench[idx]) { const t = pl.active; pl.active = pl.bench.splice(idx,1)[0]; if (t) pl.bench.push(t); gs.addLog('换位'); }
    }
  },

  // ===== 回手 =====
  async return_to_hand(gs, pl, p) {
    if (!pl.active) return;
    const returnActiveToHand = async () => {
      const returned = pl.active;
      pl.hand.push(returned.cardId);
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
      pl.hand.push(returned.cardId);
      pl.bench.splice(idx, 1);
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
      prompt:'选择要丢弃的手牌',
      allowEmpty:true
    });
    if (!selected.length) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) pl.discard.push(pl.hand.splice(item.index, 1)[0]);
    gs.addLog(`丢弃 ${selected.length} 张手牌`);
  },
  discard_all_hand(gs, pl) { while (pl.hand.length > 0) pl.discard.push(pl.hand.pop()); gs.addLog('丢弃全部手牌'); },

  // ===== 手牌回牌库 =====
  shuffle_hand_to_deck(gs, pl, p) {
    const targets = p.who === 'both' ? [gs.player1, gs.player2] : p.who === 'opponent' ? [_opponent(gs, pl)] : [pl];
    for (const pp of targets) { while (pp.hand.length > 0) pp.deck.push(pp.hand.pop()); gs._shuffle(pp.deck); }
    if (p.who === 'both' && (p.self_draw_count || p.opponent_draw_count)) {
      const opp = _opponent(gs, pl);
      const selfDraw = p.self_draw_count ?? p.draw_count ?? 4;
      const oppDraw = p.opponent_draw_count ?? p.draw_count ?? 4;
      pl.draw(selfDraw);
      opp.draw(oppDraw);
      gs.addLog(`双方手牌回牌库，自己抽 ${selfDraw} 张，对手抽 ${oppDraw} 张`);
      return;
    }
    const dc = p.draw_count || 4;
    for (const pp of targets) pp.draw(dc);
    gs.addLog(`手牌回牌库，抽 ${dc} 张`);
  },

  // ===== 弃牌区附能 =====
  async attach_energy_from_discard(gs, pl, p) {
    const allowActive = p.target !== 'bench';
    const allowBench = p.target !== 'active';
    const slot = await _pickPokemonTarget(gs, pl, pl, {
      mode:'attach-energy', side:'self', allowActive, allowBench, prompt:'选择附能目标',
      slotFilter: candidateSlot => _monMatchesType(_getMon(pl, candidateSlot), p.targetType)
    });
    const mon = _getMon(pl, slot);
    if (!mon) return;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.discard, p.count || 1, { source:'discard-energy', filter:card=>_isEnergyCard(gs, card, p.filter), allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) mon.energy.push(pl.discard.splice(item.index, 1)[0]);
    if (p.damageCountersOnAttachedTarget) _applyDamageToPokemon(gs, pl, mon, p.damageCountersOnAttachedTarget * 10);
    gs.addLog(`从弃牌区附能 ${selected.length} 张`);
  },

  // ===== 牌库附能 =====
  async attach_energy_from_deck(gs, pl, p) {
    const slot = await _pickPokemonTarget(gs, pl, pl, { mode:'attach-energy', side:'self', allowActive:true, allowBench:true, prompt:'选择附能目标' });
    const mon = _getMon(pl, slot);
    if (!mon) return;
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.deck, p.count || 1, { source:'deck-energy', filter:card=>_isEnergyCard(gs, card, p.filter), allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) { gs._shuffle(pl.deck); return; }
    for (const item of selected.sort((a,b)=>b.index-a.index)) mon.energy.push(pl.deck.splice(item.index, 1)[0]);
    gs._shuffle(pl.deck);
    gs.addLog(`从牌库附能 ${selected.length} 张`);
  },

  // ===== 丢弃能量 =====
  async discard_energy(gs, pl, p) {
    const owner = p.target?.startsWith?.('opponent') ? _opponent(gs, pl) : pl;
    let mon = null;
    let slot = null;
    if (p.target === 'opponent_bench') {
      slot = await _pickPokemonTarget(gs, pl, owner, {
        mode:'discard-energy-target', side:'opponent', allowActive:false, allowBench:true,
        slotFilter: candidateSlot => _slotHasMatchingAttachedEnergy(gs, owner, candidateSlot, p.filter),
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
  },

  // ===== 能量换位 =====
  async move_energy(gs, pl, p) {
    if (p.source === 'bench' && p.dest === 'active' && pl.active) {
      const sourceSlot = await _pickPokemonTarget(gs, pl, pl, { mode:'move-energy-source', side:'self', allowActive:false, allowBench:true, prompt:'选择移动能量来源' });
      const sourceMon = _getMon(pl, sourceSlot);
      const items = _attachedEnergyItems(gs, pl, sourceMon, sourceSlot, p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, p.count || 1, { filter:p.filter || null });
      for (const item of _removeAttachedEnergy(selected)) pl.active.energy.push(item.energy);
      if (selected.length) gs.addLog('能量转至出战');
    } else if (p.source === 'self' && p.dest === 'bench' && pl.active) {
      const destSlot = await _pickPokemonTarget(gs, pl, pl, { mode:'move-energy-dest', side:'self', allowActive:false, allowBench:true, prompt:'选择移动能量目标' });
      const destMon = _getMon(pl, destSlot);
      if (!destMon) return;
      const items = _attachedEnergyItems(gs, pl, pl.active, 'active', p.filter);
      const selected = await _pickAttachedEnergy(gs, pl, items, p.count || 1, { filter:p.filter || null });
      for (const item of _removeAttachedEnergy(selected)) destMon.energy.push(item.energy);
      if (selected.length) gs.addLog('能量转至备战');
    }
  },

  // ===== 弃牌区回收 =====
  async recover_from_discard(gs, pl, p) {
    const selected = await _pickCardsFromZone(gs, pl, pl, pl.discard, p.count || 1, { source:'discard', filter:p.filter || null, allowFewer:!!p.allowFewer, allowEmpty:!!p.allowEmpty, maxCount:p.maxCount, minCount:p.minCount, optional:!!p.optional });
    if (!selected.length) return;
    for (const item of selected.sort((a,b)=>b.index-a.index)) {
      const card = pl.discard.splice(item.index, 1)[0];
      if (p.target === 'deck') pl.deck.push(card); else pl.hand.push(card);
    }
    gs.addLog(`回收 ${selected.length} 张卡`);
  },

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
    for (let i = 0; i < count; i++) { if (Math.random() < 0.5) heads++; }
    gs.addLog(`掷${count}次硬币: ${heads}正${count - heads}反`);
    if (p.fail_on_tails && heads < count) { gs.addLog('招式失败'); throw new Error('attack_failed'); }
    if (p.heads && heads > 0) {
      for (const eff of p.heads) { await EXECUTORS[eff.action]?.(gs, pl, eff.params); }
    }
    return { heads, tails: count - heads };
  },
  async coin_flip_status(gs, pl, p) {
    if (Math.random() < 0.5) {
      const opp = _opponent(gs, pl);
      if (opp.active && p.statuses) { opp.active.status = p.statuses.join(','); gs.addLog(`硬币正面→${p.statuses.join('、')}`); }
    } else { gs.addLog('硬币反面'); }
  },
  async coin_flip_damage(gs, pl, p) {
    const count = p.count || 1;
    let heads = 0;
    for (let i = 0; i < count; i++) { if (Math.random() < 0.5) heads++; }
    const extra = heads * (p.damage_per || 20);
    const opp = _opponent(gs, pl);
    if (opp.active && extra > 0) { opp.active.hp -= extra; gs.addLog(`硬币+${extra}伤害`); if (opp.active.hp <= 0) gs.knockout(opp); }
    return { heads };
  },
  async coin_flip_until_tails(gs, pl, p) {
    let heads = 0;
    while (Math.random() >= 0.5) heads++;
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

  // ===== 防止伤害 =====
  prevent_damage(gs, pl, p) {
    if (pl.active) { pl.active.preventDamage = true; gs.addLog('防止伤害'); }
  },
  prevent_effect(gs, pl, p) {
    if (pl.active) { pl.active.preventEffect = true; gs.addLog('防止效果'); }
  },
  prevent_damage_effect(gs, pl, p) {
    if (pl.active) { pl.active.preventDamage = true; pl.active.preventEffect = true; gs.addLog('防伤防效'); }
  },

  // ===== 无视 =====
  ignore(gs, pl, p) {
    if (pl.active) { pl.active.ignore = pl.active.ignore || []; pl.active.ignore.push(p.what); gs.addLog(`无视${p.what}`); }
  },

  // ===== 无法攻击 =====
  cannot_attack_next(gs, pl, p) {
    if (pl.active) { pl.active.cannotAttackNext = true; gs.addLog('下回合无法攻击'); }
  },

  // ===== 无法撤退 =====
  cannot_retreat(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (p.target === 'opponent' && opp.active) { opp.active.cannotRetreat = true; gs.addLog('对手无法撤退'); }
  },

  // ===== 对手牌库丢弃 =====
  mill(gs, pl, p) {
    const opp = _opponent(gs, pl);
    const n = Math.min(p.count || 1, opp.deck.length);
    for (let i = 0; i < n; i++) opp.discard.push(opp.deck.pop());
    gs.addLog(`对手弃 ${n} 张`);
  },

  // ===== 查看对手手牌 =====
  look_at(gs, pl, p) { gs.addLog('查看了对手手牌'); },

  // ===== 随机丢弃对手手牌 =====
  discard_opponent_hand_random(gs, pl, p) {
    const opp = _opponent(gs, pl);
    if (opp.hand.length > 0) { const i = Math.floor(Math.random() * opp.hand.length); opp.discard.push(opp.hand.splice(i, 1)[0]); gs.addLog('随机丢弃对手1张手牌'); }
  },

  // ===== 放逐区 =====
  lost_zone(gs, pl, p) { gs.addLog('放入放逐区'); },

  // ===== 消除能量费用 =====
  energy_cost_eliminate(gs, pl, p) {
    if (pl.active) { pl.active.costEliminated = true; gs.addLog('招式费用消除'); }
  },

  // ===== 特性消除（主动/临时效果）=====
  ability_nullify(gs, pl, p) {
    if (p.duration !== 'turn') return;
    gs.addTemporaryAbilityLock?.(pl, p.scope || 'opponent_active', '临时效果');
    gs.addLog('特性被消除');
  },

  // ===== 化石放置 =====
  fossil_place(gs, pl, p) { gs.addLog('化石放置'); },

  // ===== 竞技场 =====
  // stadium effects are handled as passives, not here

  // ===== 工具模板（忽略）=====
  tool_template() {},
};
