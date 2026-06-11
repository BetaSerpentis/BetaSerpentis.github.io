// convert.js — JSON卡牌数据 → txt表格格式 + 效果配置
// 用法: node convert.js

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'ptcg', 'data');
const OUT_DIR = path.join(__dirname, 'data_txt');
fs.mkdirSync(OUT_DIR, { recursive: true });

// === 效果原语定义 ===
// 格式: action:param1=val1;param2=val2
// 多个效果用 | 分隔
// 条件用 @ 前缀: @condition=...

const ELEM_MAP = { '草':'G', '火':'R', '水':'W', '雷':'L', '斗':'F', '恶':'D', '钢':'M', '超':'P', '龙':'N', '妖':'Y', '无':'C' };
const STAGE_MAP = { '基础':'0', '1阶进化':'1', '2阶进化':'2' };
const STATUS_MAP = { '中毒':'poison', '灼伤':'burn', '睡眠':'sleep', '麻痹':'paralysis', '混乱':'confusion' };

// === 效果解析器 ===
function parseEffectText(text) {
  if (!text || text === '无') return '';

  // Normalize unicode quotes to ASCII for consistent regex matching
  text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const effects = [];
  let remaining = text;

  const rules = [
    // ===== 高优先级：长复合效果 =====
    // 双方手牌回牌库+抽卡
    [/双方玩家各将所有手牌放回牌库并重洗[。.]然后[，,]各抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=both;draw_both:count=${m[1]}`],
    [/双方玩家各将所有手牌放回牌库并重洗[。.]然后[，,]从牌库各抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=both;draw_both:count=${m[1]}`],
    // 对手手牌回牌库+抽卡
    [/对手将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=opponent;draw_opponent:count=${m[1]}`],
    [/对手将(?:自己的)?手牌全部放回牌库并重洗[。.]然后[，,]从牌库抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=opponent;draw_opponent:count=${m[1]}`],
    // 自己手牌回牌库+抽卡
    [/将自己的手牌全部放回牌库并重洗[。.]然后[，,]从牌库抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=self;draw:count=${m[1]}`],
    [/将自己的手牌全部放回牌库并重洗。然后，从牌库抽出(\d+)张卡/, m => `shuffle_hand_to_deck:who=self;draw:count=${m[1]}`],

    // 竞技场/道具模板文本（忽略）
    [/宝可梦道具卡[，,]附于自己的宝可梦使用.+?保持附加状态/, () => 'tool_template'],
    [/这张卡只可在后攻玩家的最初回合使用/, () => 'condition:first_turn_second'],

    // ===== 回合结束 =====
    [/若使用了这张卡[，,]则自己的回合结束/, () => 'end_turn'],
    [/自己的回合结束/, () => 'end_turn'],

    // ===== 丢弃全部手牌 =====
    [/将自己的手牌全部丢[弃到]/, () => 'discard_all_hand'],

    // ===== 掷硬币类 =====
    // 掷到反面失败
    [/掷1次硬币若为反面[，,]则这个招式失败/, () => 'coin_flip:count=1;fail_on_tails=true'],
    // 掷硬币+状态
    [/掷1次硬币若为正面[，,]则将对手的战斗宝可梦【(.+?)】/, m => `coin_flip:count=1;heads=inflict_status:statuses=${STATUS_MAP[m[1]]||m[1]}`],
    // 掷硬币+伤害增加
    [/掷1次硬币若为正面[，,]则增加(\d+)点伤害/, m => `coin_flip:count=1;heads=damage_modify:amount=+${m[1]}`],
    // 掷硬币+防伤防效
    [/掷1次硬币若为正面[，,]则在下个对手的回合[，,]这只宝可梦不会受到招式的伤害与效果的影响/, () => 'coin_flip:count=1;heads=prevent_damage:duration=next_opp_turn;prevent_effect:duration=next_opp_turn'],
    // 掷硬币+防伤
    [/掷1次硬币若为正面[，,]则在下个对手的回合[，,]这只宝可梦不会受到招式的伤害/, () => 'coin_flip:count=1;heads=prevent_damage:duration=next_opp_turn'],
    // 掷硬币+弃对手能量
    [/掷1次硬币若为正面[，,]则选择1个对手的战斗宝可梦身上附加的能量[，,]将其丢弃/, () => 'coin_flip:count=1;heads=discard_energy:target=opponent;count=1'],
    // 掷硬币+对手混乱
    [/掷1次硬币若为正面[，,]则将对手的战斗宝可梦【混乱】/, () => 'coin_flip:count=1;heads=inflict_status:statuses=confusion'],
    // 掷硬币直到反面+N伤害
    [/掷硬币直到出现反面[，,]增加正面出现的次数[×x](\d+)点伤害/, m => `coin_flip_until_tails:damage_per=${m[1]}`],
    // 掷N次硬币+正面数x伤害
    [/掷(\d+)次硬币[，,]造成正面出现的次数[×x](\d+)点伤害/, m => `coin_flip_damage:count=${m[1]};damage_per=${m[2]}`],
    // 掷N次硬币
    [/掷(\d+)次硬币/, m => `coin_flip:count=${m[1]}`],
    [/掷1次硬币/, () => 'coin_flip:count=1'],

    // ===== 状态异常 =====
    [/将对手的(?:战斗)?宝可梦【中毒】[，,]【灼伤】与【混乱】/, () => 'inflict_status:statuses=poison,burn,confusion'],
    [/将对手的(?:战斗)?宝可梦【中毒】与【灼伤】/, () => 'inflict_status:statuses=poison,burn'],
    [/将对手的(?:战斗)?宝可梦【中毒】与【混乱】/, () => 'inflict_status:statuses=poison,confusion'],
    [/将对手的(?:战斗)?宝可梦【灼伤】与【混乱】/, () => 'inflict_status:statuses=burn,confusion'],
    [/将对手的(?:战斗)?宝可梦【(.+?)】与【(.+?)】/, m => `inflict_status:statuses=${STATUS_MAP[m[1]]||m[1]},${STATUS_MAP[m[2]]||m[2]}`],
    [/将对手的(?:战斗)?宝可梦【中毒】/, () => 'inflict_status:statuses=poison'],
    [/将对手的(?:战斗)?宝可梦【灼伤】/, () => 'inflict_status:statuses=burn'],
    [/将对手的(?:战斗)?宝可梦【睡眠】/, () => 'inflict_status:statuses=sleep'],
    [/将对手的(?:战斗)?宝可梦【麻痹】/, () => 'inflict_status:statuses=paralysis'],
    [/将对手的(?:战斗)?宝可梦【混乱】/, () => 'inflict_status:statuses=confusion'],

    // ===== 自身伤害 =====
    [/这只宝可梦也受到(\d+)点伤害/, m => `self_damage:amount=${m[1]}`],

    // ===== HP恢复 =====
    [/HP全部恢复/, () => 'heal:amount=full'],
    [/将(?:这只)?(?:宝可梦|.*?)恢复[“”"]?(\d+)[“”"]?HP/, m => `heal:amount=${m[1]}`],
    [/恢复[“”"]?(\d+)[“”"]?HP/, m => `heal:amount=${m[1]}`],

    // ===== 下回合无法使用招式 =====
    [/在下个自己的回合[，,]这只宝可梦无法使用招式/, () => 'cannot_attack_next:duration=next_self_turn'],
    [/在下个自己的回合[，,]这只宝可梦无法使用[「""](.+?)[」""]/, m => `cannot_attack_next:move=${m[1]}`],

    // ===== 无法撤退 =====
    [/在下个对手的回合[，,]受到这个招式的宝可梦无法撤退/, () => 'cannot_retreat:target=opponent;duration=next_opp_turn'],
    [/对手的(?:战斗)?宝可梦无法撤退/, () => 'cannot_retreat:target=opponent'],

    // ===== 伤害增减 =====
    [/在下个对手的回合[，,]这只宝可梦受到招式的伤害[「""]?([+-]\d+)[」""]?点/, m => `damage_modify:amount=${m[1]};duration=next_opp_turn;target=self`],
    [/这只宝可梦受到招式的伤害[「""]?([+-]\d+)[」""]?点/, m => `damage_modify:amount=${m[1]};target=self`],
    [/增加.+?的能量.*?[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=energy_count`],
    [/增加.+?的.*?张数[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=count`],

    // ===== 防止伤害/效果 =====
    [/在下个对手的回合[，,]这只宝可梦不会受到招式的伤害与效果的影响/, () => 'prevent_damage:duration=next_opp_turn;prevent_effect:duration=next_opp_turn'],
    [/在下个对手的回合[，,]这只宝可梦不会受到招式的伤害/, () => 'prevent_damage:duration=next_opp_turn'],
    [/不会受到.*?招式的伤害/, () => 'prevent_damage:source=attack'],
    [/不会受到效果的影响/, () => 'prevent_effect:source=attack'],

    // ===== 无视弱抗/效果 =====
    [/这个招式的伤害不计算抵抗力/, () => 'ignore:resistance'],
    [/这个招式的伤害不计算弱点/, () => 'ignore:weakness'],
    [/这个招式的伤害不计算对手的战斗宝可梦身上的附加效果/, () => 'ignore:opponent_effects'],
    [/这个招式的伤害不计算/, () => 'ignore:effects'],

    // ===== 换位 =====
    [/双方玩家将自己的战斗宝可梦与备战宝可梦互换/, () => 'switch_pokemon:who=both'],
    [/选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换[。.]\[由对手选择/, () => 'switch_pokemon:who=opponent;choose=opponent'],
    [/选择(?:1只\s*)?对手的备战宝可梦[，,]?与战斗宝可梦互换/, () => 'switch_pokemon:who=opponent'],
    [/将对手的(?:战斗)?宝可梦与备战宝可梦互换[。.]\[由对手选择/, () => 'switch_pokemon:who=opponent;choose=opponent'],
    [/将对手的(?:战斗)?宝可梦与备战宝可梦互换/, () => 'switch_pokemon:who=opponent'],
    [/若希望[，,]将这只宝可梦与备战宝可梦互换/, () => 'switch_pokemon:who=self;optional=true'],
    [/将自己的战斗宝可梦与备战宝可梦互换/, () => 'switch_pokemon:who=self'],
    [/将这只宝可梦与备战宝可梦互换/, () => 'switch_pokemon:who=self'],

    // ===== 备战区伤害 =====
    [/对手的1只备战宝可梦也受到(\d+)点伤害/, m => `damage_bench:target=opponent_1;damage=${m[1]}`],
    [/对手的1只宝可梦受到(\d+)点伤害/, m => `damage_bench:target=opponent_1;damage=${m[1]}`],
    [/对手的所有备战宝可梦各受到(\d+)点伤害/, m => `damage_bench:target=opponent_all;damage=${m[1]}`],

    // ===== 抽卡 =====
    [/从牌库抽卡直到手牌满(\d+)张/, m => `draw_until:target=${m[1]}`],
    [/从(?:自己的)?牌库抽出(\d+)张卡/, m => `draw:count=${m[1]}`],
    [/从牌库抽出(\d+)张/, m => `draw:count=${m[1]}`],

    // ===== 搜牌库放备战区 =====
    [/从(?:自己的)?牌库(?:选择|抽出)(?:最多)?(\d+)张.*?基础.*?宝可梦(?:卡)?[,，]\s*放置于备战区/, m => `search_deck_to_bench:count=${m[1]};filter=基础`],
    [/从(?:自己的)?牌库选择最多(\d+)张(.+?)宝可梦(?:卡)?[,，]放置于备战区/, m => `search_deck_to_bench:count=${m[1]};filter=${m[2]}`],
    [/从(?:自己的)?牌库选择1张【基础】宝可梦卡[，,]放置于备战区/, () => 'search_deck_to_bench:count=1;filter=基础'],

    // ===== 搜牌库加手 =====
    [/从(?:自己的)?牌库(?:选择|抽出)(?:最多)?(\d+)张(.+?)(?:卡)?[,，][在给对手看过后]*加入手牌/, m => `search_deck_to_hand:count=${m[1]};filter=${m[2]}`],
    [/从(?:自己的)?牌库选择(.+?)各(\d+)张[,，]在给对手看过后加入手牌/, m => `search_deck_to_hand:count=${m[2]};filter=${m[1]}`],
    [/从(?:自己的)?牌库选择1张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, m => `search_deck_to_hand:count=1;filter=${m[1]}`],

    // ===== 看牌库上方选牌 =====
    [/查看(?:自己的)?牌库上方(\d+)张卡[,，]选择(?:其中)?(?:最多)?(\d+)张.*?加入手牌/, m => `peek_and_keep:peek=${m[1]};keep=${m[2]}`],
    [/查看(?:自己的)?牌库上方(\d+)张卡[,，]选择/, m => `peek_and_keep:peek=${m[1]};keep=1`],

    // ===== 弃牌区附能 =====
    [/从(?:自己的)?弃牌区选择(?:最多)?(\d+)张(.+?)能量卡[,，]?附于(.+?)宝可梦/, m => `attach_energy_from_discard:count=${m[1]};filter=${m[2]};target=${m[3].includes('备战')?'bench':'any'}`],

    // ===== 牌库附能 =====
    [/从(?:自己的)?牌库(?:选择|抽出)(?:最多)?(\d+)张(.+?)能量卡[,，]?附于/, m => `attach_energy_from_deck:count=${m[1]};filter=${m[2]}`],

    // ===== 丢弃自身能量 =====
    [/将这只宝可梦身上所附加的(.+?)能量全部丢弃/, m => `discard_energy:target=self;filter=${m[1]};count=all`],
    [/将这只宝可梦身上附加的(.+?)能量(?:丢弃|丢到弃牌区)/, m => `discard_energy:target=self;filter=${m[1]};count=1`],
    [/将这只宝可梦身上所附加的(\d+)个能量丢到弃牌区/, m => `discard_energy:target=self;count=${m[1]}`],
    [/将这只宝可梦身上附加的能量卡全部丢弃/, () => 'discard_energy:target=self;count=all'],
    [/选择1个这只宝可梦身上附加的能量[，,]将其丢弃/, () => 'discard_energy:target=self;count=1'],
    [/选择2个这只宝可梦身上附加的能量[，,]将其丢弃/, () => 'discard_energy:target=self;count=2'],
    [/选择(\d+)个这只宝可梦身上附加的能量[，,]将其丢弃/, m => `discard_energy:target=self;count=${m[1]}`],

    // ===== 丢弃对手能量 =====
    [/选择1个对手的.*?身上附加的能量[，,]将其丢弃/, () => 'discard_energy:target=opponent;count=1'],
    [/将对手的战斗宝可梦身上附加的1个能量丢弃/, () => 'discard_energy:target=opponent;count=1'],

    // ===== 弃牌区回收 =====
    [/从(?:自己的)?弃牌区选择(?:最多)?(\d+)张(.+?)(?:卡)?[,，]在给对手看过后加入手牌/, m => `recover_from_discard:count=${m[1]};filter=${m[2]};target=hand`],
    [/从(?:自己的)?弃牌区选择(?:最多)?(\d+)张(.+?)(?:卡)?[,，]加入手牌/, m => `recover_from_discard:count=${m[1]};filter=${m[2]};target=hand`],
    [/从(?:自己的)?弃牌区选择.*?合计(?:最多)?(\d+)张[,，]在给对手看过后放回牌库/, m => `recover_from_discard:count=${m[1]};target=deck`],
    [/从(?:自己的)?弃牌区(?:选择|抽出).*?(?:加入手牌|放回牌库)/, () => 'recover_from_discard:count=1'],

    // ===== 回手 =====
    [/将自己的.*?宝可梦(?:与所附加的所有卡)?[,，]?(?:全部)?放回手牌/, () => 'return_to_hand:target=choose;with_attachments=true'],

    // ===== 多获奖赏 =====
    [/多获得(\d+)张奖赏卡/, m => `extra_prize:count=${m[1]}`],

    // ===== 对手牌库丢弃 =====
    [/将对手的牌库上方(\d+)张卡丢弃/, m => `mill:target=opponent;count=${m[1]}`],
    [/对手的牌库上方(\d+)张丢到弃牌区/, m => `mill:target=opponent;count=${m[1]}`],

    // ===== 查看对手手牌 =====
    [/查看对手的手牌/, () => 'look_at:target=opponent_hand'],

    // ===== 随机丢弃对手手牌 =====
    [/在不看正面的情况下[，,]选择1张对手的手牌[，,]将其丢弃/, () => 'discard_opponent_hand_random:count=1'],

    // ===== 能量换位 =====
    [/从备战宝可梦.*?改附于.*?战斗宝可梦/, () => 'move_energy:source=bench;dest=active'],
    [/选择1个这只宝可梦身上附加的能量[，,]改附于备战宝可梦身上/, () => 'move_energy:source=self;dest=bench'],

    // ===== 重洗牌库 =====
    [/并且重洗牌库/, () => 'shuffle_deck'],
    [/重洗牌库/, () => 'shuffle_deck'],

    // ===== 放逐区 =====
    [/放置于放逐区/, () => 'lost_zone'],
    [/放逐区/, () => 'lost_zone_ref'],

    // ===== 化石放置 =====
    [/作为HP(\d+)的/, m => `fossil_place:hp=${m[1]}`],

    // ===== 以下补充高频效果 =====
    // 伤害指示物放置（对手）
    [/将(\d+)个伤害指示物以任意方式放置于对手的宝可梦身上/, m => `damage_place:target=opponent_any;count=${m[1]}`],
    [/将(\d+)个伤害指示物以任意方式放置于对手的备战宝可梦身上/, m => `damage_place:target=opponent_bench;count=${m[1]}`],
    [/在对手的战斗宝可梦身上放置(\d+)个伤害指示物/, m => `damage_place:target=opponent_active;count=${m[1]}`],
    [/在使用招式的宝可梦身上放置(\d+)个伤害指示物/, m => `damage_place:target=attacker;count=${m[1]}`],
    [/在这只宝可梦身上放置(\d+)个伤害指示物/, m => `damage_place:target=self;count=${m[1]}`],
    [/放置(\d+)个伤害指示物/, m => `damage_place:count=${m[1]}`],

    // 伤害增减（含引号变体）
    [/在下个对手的回合[，,]这只宝可梦受到招式的伤害["""]?([+-]?\d+)["""]?点/, m => `damage_modify:amount=${m[1]};duration=next_opp_turn;target=self`],
    [/这只宝可梦受到招式的伤害["""]?([+-]?\d+)["""]?点/, m => `damage_modify:amount=${m[1]};target=self`],
    [/这只宝可梦使用的招式.*?造成的伤害["""]?([+-]\d+)["""]?点/, m => `damage_modify:amount=${m[1]};target=self_attack`],

    // 增加N×M伤害
    [/增加对手的战斗宝可梦身上放置的伤害指示物的数量[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=opponent_damage_counters`],
    [/增加这只宝可梦身上放置的伤害指示物的数量[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=self_damage_counters`],
    [/增加这只宝可梦身上附加的(.+?)能量的数量[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[2]};condition=self_energy_${m[1]}`],
    [/增加双方的备战宝可梦的数量[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=total_bench`],
    [/增加.*?的数量[×x](\d+)点伤害/, m => `damage_modify:amount=+${m[1]};condition=count`],

    // 掷硬币+伤害直到反面
    [/掷硬币直到出现反面[，,]造成正面出现的次数[×x](\d+)点伤害/, m => `coin_flip_until_tails:damage_per=${m[1]}`],

    // 自身状态
    [/将这只宝可梦【(.+?)】/, m => `inflict_status:statuses=${STATUS_MAP[m[1]]||m[1]};target=self`],
    [/将双方的战斗宝可梦【(.+?)】/, m => `inflict_status:statuses=${STATUS_MAP[m[1]]||m[1]};target=both`],

    // 防止效果（变体）
    [/这只宝可梦不会受到对手的宝可梦使用招式的效果的影响/, () => 'prevent_effect:source=attack;target=self'],

    // 回手（变体）
    [/将这只宝可梦与附加的卡[，,]全部放回手牌/, () => 'return_to_hand:target=self;with_attachments=true'],

    // 备战区全体伤害
    [/自己的所有备战宝可梦也各受到(\d+)点伤害/, m => `damage_bench:target=self_all;damage=${m[1]}`],
    [/对手的所有备战宝可梦也各受到(\d+)点伤害/, m => `damage_bench:target=opponent_all;damage=${m[1]}`],

    // 特定招式无法使用
    [/在下个自己的回合[，,]这只宝可梦无法使用["""](.+?)["""]/, m => `cannot_attack_next:move=${m[1]}`],

    // 消除能量费用
    [/将这只宝可梦使用招式所需的能量全部消除/, () => 'energy_cost_eliminate:target=self'],

    // 选择对手招式封锁
    [/选择对手的战斗宝可梦持有的1个招式/, () => 'lock_opponent_move:count=1'],
  ];

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [re, fn] of rules) {
      const m = remaining.match(re);
      if (m) {
        effects.push(fn(m));
        remaining = remaining.replace(re, '').replace(/^[,，。\s]+/, '').trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  // 去重并清理
  const result = effects.filter(e => e).join('|');
  if (remaining.length > 2 && remaining !== text) {
    // 有未解析的部分，标记
    return result ? result + `|unparsed:${remaining.substring(0, 50)}` : `unparsed:${text.substring(0, 80)}`;
  }
  if (!result && text !== '无') {
    return `raw:${text.substring(0, 80)}`;
  }
  return result;
}

// === 转换宝可梦卡 ===
function convertPokemon() {
  const cards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pokemon-cards.json'), 'utf8'));
  const rows = [];

  for (const c of cards) {
    const ids = (c['卡牌ID'] || []).join(',');
    const elem = ELEM_MAP[c['属性']] || 'C';
    const stage = STAGE_MAP[c['进化阶段']] || '0';
    const weakness = ELEM_MAP[c['弱点']] || '';
    const resistance = ELEM_MAP[c['抵抗力']] || '';
    const abilityEffect = parseEffectText(c['特性效果'] || '');

    // 技能
    const skills = [];
    for (let i = 1; i <= 4; i++) {
      const sk = c[`技能${i}`];
      if (sk && sk['名字']) {
        const cost = (sk['消耗'] || []).map(e => ELEM_MAP[e] || 'C').join('');
        const dmg = String(sk['伤害'] || '').replace(/[^0-9+]/g, '') || '0';
        const eff = parseEffectText(sk['效果'] || '');
        skills.push(`${sk['名字']}:${cost}:${dmg}:${eff}`);
      }
    }

    rows.push([
      c['编号'] || '',
      ids,
      c['宝可梦名字'] || '',
      stage,
      c['进化自'] || '',
      c['HP'] || '',
      elem,
      c['规则'] || '',
      weakness,
      resistance,
      c['撤退'] || '',
      c['卡牌版本'] || '',
      c['特性名字'] || '',
      abilityEffect,
      skills.join(';'),
    ]);
  }

  const header = `VALID\tDESC\tID
\t\t<I>number\t<VI>card_ids\t<S>name\t<B>stage\t<S>evolves_from\t<I>hp\t<B>element\t<S>rule\t<S>weakness\t<S>resistance\t<B>retreat\t<S>version\t<S>ability_name\t<S>ability_effect\t<S>skills

有效\t注释\t图鉴编号\t卡牌ID列表\t名称\t进化阶段(0基础1一阶2二阶)\t进化自\tHP\t属性(G/R/W/L/F/D/M/P/N/Y/C)\t规则\t弱点\t抵抗力\t撤退\t版本\t特性名\t特性效果\t技能(名字:消耗:伤害:效果;...)`;
  const data = rows.map(r => `\t\t${r.join('\t')}`).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'pokemon.txt'), header + '\n' + data + '\n', 'utf8');
  console.log(`pokemon.txt: ${rows.length} cards`);
}

// === 转换训练家卡 (物品/支援者/竞技场/道具) ===
function convertTrainer(type, filename, outName) {
  const cards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
  const typeCode = { '物品卡': 'I', '支援者卡': 'S', '竞技场卡': 'T', '宝可梦道具': 'E' }[type] || 'I';
  const rows = [];

  for (const c of cards) {
    const ids = (c['卡牌ID'] || []).join(',');
    const eff = parseEffectText(c['效果'] || '');
    rows.push([
      ids,
      c['卡牌名字'] || '',
      typeCode,
      eff,
      (c['卡牌版本'] || []).join(','),
    ]);
  }

  const header = `VALID\tDESC\tID
\t\t<VI>card_ids\t<S>name\t<B>type\t<S>effect\t<S>version

有效\t注释\t卡牌ID列表\t名称\t类型(I物品S支援者T竞技场E道具)\t效果指令\t版本`;
  const data = rows.map(r => `\t\t${r.join('\t')}`).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, outName), header + '\n' + data + '\n', 'utf8');
  console.log(`${outName}: ${rows.length} cards`);
}

// === 转换能量卡 ===
function convertEnergy() {
  // 特殊能量
  const spec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'SpecialEnergy-cards.json'), 'utf8'));
  const specRows = [];
  for (const c of spec) {
    const ids = (c['卡牌ID'] || []).join(',');
    const eff = parseEffectText(c['效果'] || '');
    specRows.push([ids, c['卡牌名字'] || '', 'S', eff, (c['卡牌版本'] || []).join(',')]);
  }

  // 基本能量
  const basic = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'BasicEnergy-cards.json'), 'utf8'));
  const basicRows = [];
  for (const c of basic) {
    const ids = (c['卡牌ID'] || []).join(',');
    const m = (c['卡牌名字'] || '').match(/【(.+?)】/);
    const elem = ELEM_MAP[m ? m[1] : '无'] || 'C';
    basicRows.push([ids, c['卡牌名字'] || '', 'B', elem, (c['卡牌版本'] || []).join(',')]);
  }

  const specHeader = `VALID\tDESC\tID
\t\t<VI>card_ids\t<S>name\t<B>type\t<S>effect\t<S>version

有效\t注释\t卡牌ID列表\t名称\t类型(S特殊)\t效果指令\t版本`;
  const basicHeader = `VALID\tDESC\tID
\t\t<VI>card_ids\t<S>name\t<B>type\t<B>element\t<S>version

有效\t注释\t卡牌ID列表\t名称\t类型(B基本)\t属性\t版本`;

  fs.writeFileSync(path.join(OUT_DIR, 'energy_special.txt'), specHeader + '\n' + specRows.map(r => `\t\t${r.join('\t')}`).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'energy_basic.txt'), basicHeader + '\n' + basicRows.map(r => `\t\t${r.join('\t')}`).join('\n') + '\n', 'utf8');
  console.log(`energy_special.txt: ${specRows.length} cards`);
  console.log(`energy_basic.txt: ${basicRows.length} cards`);
}

// === 效果原语总表 ===
function writeEffectRef() {
  const content = `VALID\tDESC\tID
\t\t<I>id\t<S>name\t<S>params\t<S>desc\t<S>examples

有效\t注释\t效果ID\t效果名\t参数\t描述\t示例卡牌
\t\tdraw\t抽卡\tcount=N\t从牌库抽N张卡\t博士的研究
\t\tdraw_until\t抽至满手\ttarget=N\t抽卡直到手牌满N张\t可尔妮的气势
\t\tsearch_deck_to_hand\t搜索牌库加手\tcount=N;filter=类型\t搜索牌库选择N张卡加入手牌\t大师球
\t\tsearch_deck_to_bench\t搜索牌库放备战\tcount=N;filter=类型\t搜索牌库放置N只宝可梦到备战区\t巢穴球
\t\tpeek_and_keep\t查看牌库选牌\tpeek=N;keep=M\t查看牌库上方N张选M张加入手牌\t超级球
\t\theal\t恢复HP\tamount=N/full\t恢复N点HP或全部恢复\t伤药
\t\tdamage_place\t放置伤害指示物\ttarget=目标;count=N\t在目标身上放置N个伤害指示物(每个10点)\t光辉水箭龟
\t\tdamage_move\t移动伤害指示物\tsource=源;dest=目标;count=N\t将N个伤害指示物从源移到目标\t伤害水泵
\t\tenergy_attach\t附加能量\tsource=deck/discard/hand;target=目标;filter=类型;count=N\t从指定区域附加能量\t电气发生器
\t\tenergy_discard\t丢弃能量\ttarget=self/opponent;filter=类型;count=N/all\t丢弃能量卡\t喷射火焰
\t\tenergy_move\t转移能量\tsource=源;dest=目标;count=N;filter=类型\t在宝可梦间转移能量\t能量转移
\t\tenergy_provide\t能量提供变更\tprovides=类型;count=N;condition=条件\t改变能量卡提供的属性和数量\t彩虹能量
\t\tinflict_status\t施加状态\tstatuses=poison/burn/sleep/paralysis/confusion\t施加特殊状态\t剧毒之鞭
\t\tstatus_remove\t消除状态\ttarget=目标;type=状态类型\t消除特殊状态\t万灵药
\t\tstatus_prevent\t防止状态\ttarget=目标;type=状态类型\t防止陷入特殊状态\t芳香草能量
\t\tswitch_pokemon\t交替宝可梦\twho=self/opponent/both\t交换战斗与备战宝可梦\t老大的指令
\t\tevolve\t进化\tsource=hand/deck;bypass=条件\t从手牌/牌库完成进化\t神奇糖果
\t\tdevolve\t退化\ttarget=目标;dest=hand/deck\t移除进化卡退化\t退化喷雾Z
\t\treturn_to_hand\t放回手牌\ttarget=目标;with_attachments=bool\t将卡牌放回手牌\t阿塞劳拉
\t\treturn_to_deck\t放回牌库\ttarget=目标;position=top/bottom/shuffle\t将卡牌放回牌库\t裁判
\t\tdiscard_hand\t丢弃手牌\twho=self/opponent;count=N/all;filter=类型\t丢弃手牌\t高级球
\t\tdiscard_all_hand\t丢弃全部手牌\twho=self/opponent\t丢弃全部手牌\t博士的研究
\t\tshuffle_hand_to_deck\t手牌回牌库\twho=self/opponent/both\t手牌放回牌库重洗\t玛俐
\t\trecover_from_discard\t弃牌区回收\tcount=N;filter=类型;target=hand/deck\t从弃牌区回收卡牌\t能量回收
\t\tcoin_flip\t掷硬币\tcount=N;heads_effect=效果;tails_effect=效果\t掷硬币决定效果\t精灵球
\t\tdamage_modify\t伤害增减\ttarget=目标;amount=+/-N;duration=持续;condition=条件\t修改伤害数值\t丹帝
\t\tprevent_damage\t防止伤害\ttarget=目标;threshold=N;condition=条件;duration=持续\t防止招式伤害\t天空之柱
\t\tprevent_effect\t防止效果\ttarget=目标;source=attack/ability/trainer\t防止效果影响\t铁壳蛹
\t\tcannot_attack\t无法攻击\ttarget=目标;duration=持续;move=招式名\t无法使用招式\t皮卡冲锋
\t\tcannot_retreat\t无法撤退\ttarget=目标;duration=持续\t无法撤退\t束缚
\t\tretreat_modify\t撤退费用变更\ttarget=目标;amount=+/-N/0\t修改撤退费用\t伽勒尔矿山
\t\thp_modify\t最大HP变更\ttarget=目标;amount=+/-N\t修改最大HP\t勇气护符
\t\tweakness_modify\t弱点变更\ttarget=目标;action=eliminate/change;type=属性\t消除或改变弱点\t安全护目镜
\t\tability_nullify\t特性消除\ttarget=目标;scope=范围\t消除特性效果\t无人发电厂
\t\tprize_manipulate\t奖赏卡操作\taction=take/return/swap/look;count=N\t操作奖赏卡\t格拉吉欧
\t\tlost_zone\t放逐区操作\tsource=来源;count=N;filter=类型\t将卡牌放入放逐区\t放逐搅拌器
\t\tend_turn\t回合结束\t\t结束当前回合\t阿枫
\t\tchoose_effect\t选择效果\toptions=效果列表\t从多个效果中选择\t枫与南
\t\tbench_size_modify\t备战区变更\tnew_limit=N\t修改备战区最大数量\t崩塌的竞技场
\t\tlook_at\t查看信息\ttarget=hand/deck/prize;count=N\t查看隐藏信息\t空拍洛托姆
\t\tdeck_manipulate\t牌库操作\taction=reorder/shuffle;count=N;position=top/bottom\t操控牌库顺序\t生存组合
\t\tfossil_place\t化石放置\thp=N\t作为化石宝可梦放置\t谜之化石
\t\ton_knockout\t昏厥时效果\ttrigger=self/opponent;effect=效果\t宝可梦昏厥时触发\t复仇拳箱
\t\tvstar_power\tVSTAR力量\teffect=效果\t每局只能使用一次\t喷火龙VSTAR
\t\tgx_attack\tGX招式\teffect=效果;bonus=额外效果\t每局只能使用一次GX招式\t怒火中烧GX
\t\tself_damage\t自身伤害\tamount=N\t对自己造成伤害\t舍身冲撞
\t\tshuffle_deck\t重洗牌库\t\t重洗牌库\t(大部分搜索效果后)
\t\tdamage_bench\t备战区伤害\ttarget=opponent_bench;damage=N\t对备战宝可梦造成伤害\t超极巨轰天裂水
\t\traw\t原始效果\ttext=原文\t未解析的效果保留原文\t(待完善)
\t\tunparsed\t未解析部分\ttext=原文\t自动解析后剩余的部分\t(待完善)`;
  fs.writeFileSync(path.join(OUT_DIR, 'effect_ref.txt'), content + '\n', 'utf8');
  console.log('effect_ref.txt: effect reference written');
}

// === 执行转换 ===
console.log('Converting card data...');
convertPokemon();
convertTrainer('物品卡', 'Item-cards.json', 'item.txt');
convertTrainer('支援者卡', 'Supporter-cards.json', 'supporter.txt');
convertTrainer('竞技场卡', 'Stadium-cards.json', 'stadium.txt');
convertTrainer('宝可梦道具', 'PokemonTool-cards.json', 'tool.txt');
convertEnergy();
writeEffectRef();
console.log('Done!');
