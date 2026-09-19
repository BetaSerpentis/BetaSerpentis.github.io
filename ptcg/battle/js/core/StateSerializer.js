// js/core/StateSerializer.js — 把对战状态序列化成「给 LLM 看的紧凑文本」
//
// 设计约束：
//   1. **视角隔离**：以 player（AI 自己）为视角；只能看到自己的手牌。
//      对手手牌、双方牌库与奖赏卡只给「数量」，不给内容（否则等于 AI 作弊）。
//   2. **紧凑**：整个状态 + 候选动作控制在 ~1.2k tokens 内，便于低延迟调用。
//   3. **事实优先**：候选动作已由 ActionSpace 算好伤害/KO/奖赏，LLM 只需取舍，不需要算术。

/** 从字符串 ID / 能量对象 / 卡牌对象中取出可读卡名 */
export function cardNameOf(gs, ref) {
  if (ref === null || ref === undefined) return '?';
  if (typeof ref === 'object') return ref.name || ref.cardId || ref.id || '?';
  const resolver = gs?.cardResolver;
  try {
    return resolver?.getCard?.(ref)?.name || resolver?.getInfo?.(ref)?.name || String(ref);
  } catch (e) {
    return String(ref);
  }
}

function energySummary(gs, mon) {
  const list = mon?.energy || [];
  if (!list.length) return '无';
  const counts = new Map();
  for (const e of list) {
    const name = cardNameOf(gs, e).replace(/^基本/, '').replace(/能量$/, '') || '能量';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、');
}

function statusText(mon) {
  const raw = String(mon?.status || '').trim();
  if (!raw) return '正常';
  return ({ sleep: '睡眠', poison: '中毒', burn: '灼伤', paralysis: '麻痹', confusion: '混乱', frozen: '冰冻' })[raw] || raw;
}

function monLine(gs, mon) {
  if (!mon) return '（无）';
  const parts = [
    `${mon.name}`,
    `HP ${mon.hp}/${mon.maxHp}`,
    `能量[${energySummary(gs, mon)}]`,
    `状态[${statusText(mon)}]`,
  ];
  const tool = mon.tool ? cardNameOf(gs, mon.tool) : null;
  if (tool) parts.push(`道具[${tool}]`);
  return parts.join(' ');
}

function handSummary(gs, player) {
  const hand = player?.hand || [];
  if (!hand.length) return '（空）';
  const counts = new Map();
  for (const ref of hand) {
    const name = cardNameOf(gs, ref);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、');
}

/**
 * 生成状态文本（视角：player）。
 * @param {object} gs GameState
 * @param {object} player 视角玩家（AI 自己）
 * @param {object} options { recentLogs:number }
 */
export function serializeBattleState(gs, player, options = {}) {
  if (!gs || !player) return '';
  const opp = gs.getOpponent?.(player) || (player === gs.player1 ? gs.player2 : gs.player1);
  const phaseText = ({
    setup: '布置阶段', draw: '抽卡阶段', main: '主要阶段', battle: '战斗阶段', end: '回合结束', game_over: '对局结束',
  })[gs.phase] || gs.phase;
  const lines = [];

  lines.push(`你是「对手」方。当前回合 ${gs.turn}，阶段：${phaseText}`);
  lines.push(`奖赏卡剩余：你 ${player.prizes?.length ?? 0} 张 / 玩家 ${opp?.prizes?.length ?? 0} 张`);
  lines.push(`你的战斗场：${monLine(gs, player.active)}`);
  const myBench = (player.bench || []).filter(Boolean);
  lines.push(`你的备战区：${myBench.length ? myBench.map(m => monLine(gs, m)).join(' | ') : '（无）'}`);
  lines.push(`玩家的战斗场：${monLine(gs, opp?.active)}`);
  const oppBench = (opp?.bench || []).filter(Boolean);
  lines.push(`玩家的备战区：${oppBench.length ? `${oppBench.length} 只（内容未知）` : '（无）'}`);
  lines.push(`你的手牌（${(player.hand || []).length} 张）：${handSummary(gs, player)}`);
  // 隐藏信息：只给数量
  lines.push(`牌库：你 ${player.deck?.length ?? 0} 张 / 玩家 ${opp?.deck?.length ?? 0} 张；玩家手牌 ${opp?.hand?.length ?? 0} 张（内容未知）`);

  const stadium = gs.getActiveStadium?.();
  if (stadium) lines.push(`竞技场：${stadium.name || cardNameOf(gs, stadium.cardId || stadium)}`);
  if (player.supporterUsed) lines.push('本回合已使用过支援者');

  const recent = Math.max(0, options.recentLogs ?? 4);
  if (recent && Array.isArray(gs.log) && gs.log.length) {
    lines.push(`最近动作：${gs.log.slice(-recent).join('；')}`);
  }
  return lines.join('\n');
}

/** 候选动作文本（含 ActionSpace 已算好的事实） */
export function formatActionList(actions = []) {
  return actions.map(a => {
    const f = a.facts || {};
    const facts = [];
    if (a.kind === 'attack') {
      facts.push(`${f.damage} 伤害`);
      if (f.canKO) facts.push(`可击倒${f.defenderName ? ` ${f.defenderName}` : ''}、拿 ${f.prizes} 张奖赏卡`);
      if (f.cost) facts.push(`需要能量 ${f.cost}`);
    }
    if (a.kind === 'attach_energy' && f.enablesAttack) facts.push(`附上后可打 ${f.enablesAttack}`);
    if (a.kind === 'retreat') facts.push(`撤退费 ${f.cost}`);
    const factText = facts.length ? `（${facts.join('；')}）` : '';
    return `${a.id} [${a.kind}] ${a.desc}${factText}`;
  }).join('\n');
}

const SYSTEM_PROMPT = [
  '你是宝可梦集换式卡牌（PTCG）对战专家，正在替「对手」一方做单步决策。',
  '你只能从给出的候选动作里选一个，不能发明动作。',
  '关键规则：',
  '1. 攻击会立刻结束你的回合。若还想附能、进化、使用训练家或特性，应先做这些再攻击。',
  '2. 优先做出能击倒对手宝可梦、拿到奖赏卡的选择；避免让自己的宝可梦被击倒。',
  '3. 你只能看到自己的手牌；对手的手牌/牌库内容未知，不要假设。',
  '4. 候选动作后面的括号是已经算好的事实（伤害/能否击倒/奖赏卡数），请直接采信，不要自己重新计算。',
  '只输出 JSON，格式：{"action":"<候选动作 id>","reason":"<不超过20字的理由>"}，不要输出任何其它内容。',
].join('\n');

/** 组装给 LLM 的消息（system + user） */
export function buildLlmMessages(stateText, actionText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${stateText}\n\n=== 候选动作 ===\n${actionText}\n\n请只输出 JSON：{"action":"<id>","reason":"<简短理由>"}`,
    },
  ];
}

/** 从模型回复里提取动作 id（容错：纯 JSON / 代码块 / 夹带说明） */
export function extractActionId(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const brace = candidate.match(/\{[\s\S]*?\}/);
    if (brace) {
      try {
        const parsed = JSON.parse(brace[0]);
        const id = parsed?.action ?? parsed?.id ?? parsed?.choice;
        if (typeof id === 'string' && id.trim()) return id.trim();
      } catch (e) { /* 继续尝试 */ }
    }
    const loose = candidate.match(/\b(a\d+)\b/);
    if (loose) return loose[1];
  }
  return null;
}
