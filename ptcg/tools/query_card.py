#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PTCG 卡牌查询脚本：按卡名（模糊搜索）或 ID（精确查询）输出卡牌完整数据。
数据源：ptcg/data_fast/*.tsv（本地数据库，无需联网）

TSV 列结构（来自 build-cn-data.py）：
  {type}.idx.tsv:    [ck, name, dex_num, attr_cn, qty, eq_key, active]
  {type}.filter.tsv: [ck, hp, stage, attr_en, retreat, flags, costs, dmg, std]
  {type}.detail.tsv: [ck, description, evolves_from, weakness, resistance, artist,
                      set_name, rarity, mechanic, regulation_mark, name_en]
  attacks.tsv:       [ck, set, idx, order, name, cost, damage, text, is_vstar]
  abilities.tsv:     [ck, set, idx, order, name, text]

用法：
  python ptcg/tools/query_card.py "派帕的獒教父ex"     # 按卡名模糊搜索，输出候选 + 最佳匹配详情
  python ptcg/tools/query_card.py CSV10C-151           # 按 ID 精确查询
  python ptcg/tools/query_card.py --search "博士"       # 只列出候选，不输出详情

语义查询（基于构建期生成的效果索引 data_fast/effects.tsv，
由 ptcg/tools/build-effect-index.mjs 生成；应用内也读同一份数据）：
  python ptcg/tools/query_card.py --actions                     # 列出全部动作及出现次数
  python ptcg/tools/query_card.py --action draw --count-min 3   # 一次抽 3 张以上
  python ptcg/tools/query_card.py --action damage_place --param source=own_field
  python ptcg/tools/query_card.py --action-like search_deck     # 按动作名前缀
  python ptcg/tools/query_card.py --intent 转放指示物            # 常用意图别名
  python ptcg/tools/query_card.py --action draw --json          # 机器可读输出

说明：action='usage_condition' 的行是元数据（前提条件 / 未建模残余），
      默认从语义查询结果里排除；要查它需显式 --action usage_condition --include-meta。
"""

import os
import re
import json
import sys

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data_fast')

TYPES = ['pokemon', 'supporter', 'item', 'pokemon-tool', 'stadium',
         'basic-energy', 'special-energy']
TYPE_CN = {
    'pokemon': '宝可梦', 'supporter': '支援者', 'item': '物品',
    'pokemon-tool': '宝可梦道具', 'stadium': '竞技场',
    'basic-energy': '基本能量', 'special-energy': '特殊能量'
}
ATTR_CODES = {'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超',
              'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'N': '龙', 'C': '无'}
STAGE_NAMES = {'0': '基础', '1': '1阶进化', '2': '2阶进化'}
ENERGY_CN = {'G': '草', 'R': '火', 'W': '水', 'L': '雷', 'P': '超',
             'F': '斗', 'D': '恶', 'M': '钢', 'Y': '妖', 'C': '无', 'N': '龙'}

EFFECTS_FILE = 'effects.tsv'

# 常用「意图 → 结构化条件」别名。这些说法不会出现在卡面原文里，
# 所以纯文本检索表达不了，必须靠效果索引。
INTENTS = {
    '抽牌':         {'action': ['draw', 'draw_until', 'draw_until_opp_hand_plus']},
    '搜牌库':       {'action_like': ['search_deck']},
    '搜牌库放备战': {'action': ['search_deck_to_bench']},
    '附能量':       {'action_like': ['attach_energy']},
    '丢弃能量':     {'action': ['discard_energy']},
    '回复HP':       {'action_like': ['heal']},
    '特殊状态':     {'action': ['inflict_status']},
    '转放指示物':   {'action': ['damage_place'], 'param': {'source': 'own_field'}},
    '放伤害指示物': {'action': ['damage_place']},
    '换位':         {'action_like': ['switch']},
    '弃对手手牌':   {'action': ['discard_opponent_hand', 'opponent_hand_discard']},
    '查看牌库顶':   {'action': ['peek_and_keep', 'manipulate_deck_top']},
    '减少撤退能量': {'action': ['retreat_cost_reduce', 'retreat_cost_zero']},
}


def load_tsv(filename):
    path = os.path.join(BASE, filename)
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            line = line.rstrip('\r\n')
            if not line.strip() or line.startswith('#'):
                continue
            rows.append(line.split('\t'))
    return rows


class CardDB:
    def __init__(self):
        self.cards = {}       # id -> {id, name, type, mark, search}
        self.filters = {}     # id -> {hp, stage, attr, retreat}
        self.attacks = {}     # id -> [ {name, cost, damage, effect} ]
        self.abilities = {}   # id -> [ {name, effect} ]
        self.details = {}     # id -> {effect, evolves_from, weakness, resistance}
        self.effects = {}     # id -> [ {scope, slot, seq, action, params} ]
        self.effect_hash = ''  # 效果索引的输入指纹，用于判断是否过期
        self._build()

    def _build(self):
        # idx + search + detail（所有类型）
        for t in TYPES:
            for row in load_tsv(f'{t}.idx.tsv'):
                if len(row) < 2:
                    continue
                cid = row[0]
                self.cards[cid] = {'id': cid, 'name': row[1], 'type': t,
                                   'mark': '', 'search': ''}
            for row in load_tsv(f'{t}.search.tsv'):
                if len(row) < 2:
                    continue
                cid = row[0]
                if cid in self.cards:
                    self.cards[cid]['search'] = row[1]
            # detail.tsv: [0]=id [1]=描述/效果 [2]=进化自 [3]=弱点 [4]=抵抗力 [9]=环境标记
            for row in load_tsv(f'{t}.detail.tsv'):
                if len(row) < 10:
                    continue
                cid = row[0]
                if cid not in self.cards:
                    continue
                self.details[cid] = {
                    'effect': row[1],
                    'evolves_from': row[2],
                    'weakness': row[3],
                    'resistance': row[4],
                }
                mark = (row[9] or '').strip().upper()
                if mark and not self.cards[cid]['mark']:
                    self.cards[cid]['mark'] = mark

        # 效果索引（构建期生成）：
        # [0]=id [1]=scope [2]=slot [3]=seq [4]=action [5]=paramsJson
        for row in load_tsv(EFFECTS_FILE):
            if len(row) < 6:
                continue
            cid = row[0]
            try:
                params = json.loads(row[5]) if row[5] else {}
            except (ValueError, TypeError):
                params = {}
            self.effects.setdefault(cid, []).append({
                'scope': row[1], 'slot': row[2], 'seq': int(row[3] or 0),
                'action': row[4], 'params': params,
            })
        head_path = os.path.join(BASE, EFFECTS_FILE)
        if os.path.exists(head_path):
            with open(head_path, encoding='utf-8-sig') as f:
                first = f.readline().strip()
            m = re.search(r'hash=([0-9a-f]{16})', first)
            if m:
                self.effect_hash = m.group(1)

        # pokemon filter: [0]=id [1]=hp [2]=stage [3]=attr_en [4]=retreat
        for row in load_tsv('pokemon.filter.tsv'):
            if len(row) < 5:
                continue
            cid = row[0]
            if cid not in self.cards:
                continue
            self.filters[cid] = {
                'hp': row[1],
                'stage': STAGE_NAMES.get(row[2], '基础'),
                'attr': ATTR_CODES.get(row[3], row[3]),
                'retreat': row[4],
            }

        # attacks: [0]=id [3]=order [4]=name [5]=cost [6]=damage [7]=text
        for row in load_tsv('attacks.tsv'):
            if len(row) < 8:
                continue
            cid = row[0]
            self.attacks.setdefault(cid, []).append({
                'name': row[4],
                'cost': row[5],
                'damage': row[6],
                'effect': row[7],
            })

        # abilities: [0]=id [3]=order [4]=name [5]=text
        for row in load_tsv('abilities.tsv'):
            if len(row) < 6:
                continue
            cid = row[0]
            self.abilities.setdefault(cid, []).append({
                'name': row[4],
                'effect': row[5],
            })

    def by_id(self, card_id):
        c = self.cards.get(card_id)
        if not c:
            return None
        return self._format(c)

    def search(self, query, limit=10):
        q = query.strip().lower()
        results = []
        for cid, c in self.cards.items():
            name = c['name'].lower()
            search_text = c['search'].lower()
            if cid.lower() == q:
                score = 100
            elif name == q:
                score = 95
            elif name.startswith(q):
                score = 80
            elif q in name:
                score = 70
            elif q in search_text:
                score = 50
            else:
                continue
            results.append((score, cid, c))
        results.sort(key=lambda x: (-x[0], x[1]))
        return results[:limit]

    def _format(self, c):
        t = c['type']
        lines = []
        mark = c['mark'] or '?'
        lines.append(f"**{c['name']}** [{mark}标]  ID:`{c['id']}`  [{TYPE_CN.get(t, t)}]")

        d = self.details.get(c['id'], {})
        if t == 'pokemon':
            f = self.filters.get(c['id'], {})
            lines.append(f"- 宝可梦 | {f.get('attr', '?')} | HP{f.get('hp', '?')} | {f.get('stage', '基础')}")
            if d.get('evolves_from'):
                lines.append(f"- 进化自: {d['evolves_from']}")
            if d.get('weakness'):
                lines.append(f"- 弱点: {d['weakness']} | 抵抗力: {d.get('resistance') or '无'} | 撤退: {f.get('retreat', '?')}")
            for ab in self.abilities.get(c['id'], []):
                lines.append(f"- 特性「{ab['name']}」: {ab['effect']}")
            for atk in self.attacks.get(c['id'], []):
                cost = self._fmt_cost(atk['cost'])
                dmg = f" {atk['damage']}" if atk['damage'] else ''
                eff = f"。{atk['effect']}" if atk['effect'] else ''
                lines.append(f"- {cost}「{atk['name']}」{dmg}{eff}")
        else:
            eff = d.get('effect', '') or self._search_to_effect(c)
            if eff:
                lines.append(f"- 效果: {eff}")
        return '\n'.join(lines)

    def query_effects(self, action=None, action_like=None, params=None,
                      count_min=None, include_meta=False, limit=None):
        """按结构化动作检索卡牌。返回 [(cid, [命中动作...])]。"""
        params = params or {}
        hits = []
        for cid, effs in self.effects.items():
            matched = []
            for e in effs:
                if not include_meta and e['action'] == 'usage_condition':
                    continue
                if action and e['action'] not in action:
                    continue
                if action_like and not any(e['action'].startswith(p) for p in action_like):
                    continue
                if params and not all(str(e['params'].get(k, '')) == str(v) for k, v in params.items()):
                    continue
                if count_min is not None:
                    c = e['params'].get('count')
                    if not isinstance(c, (int, float)) or c < count_min:
                        continue
                matched.append(e)
            if matched:
                hits.append((cid, matched))
        hits.sort(key=lambda x: (-len(x[1]), x[0]))
        return hits[:limit] if limit else hits

    @staticmethod
    def action_counts(effects):
        """统计每个 action 的出现次数（用于 --actions 发现有哪些能力）"""
        from collections import Counter
        c = Counter()
        for effs in effects.values():
            for e in effs:
                c[e['action']] += 1
        return c

    def _fmt_cost(self, cost):
        if not cost:
            return '无'
        # 消耗可能是 "GC" 连写，或 "G,C" 逗号分隔
        parts = cost.split(',') if ',' in cost else list(cost)
        cn = [ENERGY_CN.get(p, p) for p in parts if p]
        return '·'.join(cn)

    def _search_to_effect(self, c):
        st = c['search']
        if not st:
            return ''
        name = c['name']
        i = st.lower().find(name.lower())
        if i >= 0:
            return st[i + len(name):].strip()[:200]
        return ''


def _run_effect_query(db, argv):
    """处理语义查询模式；返回 True 表示已处理，主流程应直接结束。"""
    if not any(a in argv for a in ('--actions', '--action', '--action-like', '--intent')):
        return False

    def take(flag):
        if flag in argv:
            i = argv.index(flag)
            return argv[i + 1] if i + 1 < len(argv) else ''
        return None

    if '--actions' in argv:
        counts = db.action_counts(db.effects)
        print(f'效果索引：{sum(counts.values())} 条动作 / {len(counts)} 种'
              f'（输入指纹 {db.effect_hash or "无"}）')
        print('按出现次数排序：')
        for name, n in counts.most_common():
            print(f'  {n:>6}  {name}')
        return True

    action = take('--action')
    action_like = take('--action-like')
    intent = take('--intent')
    count_min = take('--count-min')
    limit = take('--limit')
    as_json = '--json' in argv
    include_meta = '--include-meta' in argv

    params = {}
    for i, a in enumerate(argv):
        if a == '--param' and i + 1 < len(argv) and '=' in argv[i + 1]:
            k, v = argv[i + 1].split('=', 1)
            params[k] = v

    actions = [action] if action else None
    likes = [action_like] if action_like else None
    label = action or action_like or ''

    if intent:
        spec = INTENTS.get(intent)
        if not spec:
            print(f'未知意图「{intent}」。可用：{", ".join(INTENTS)}')
            return True
        actions = spec.get('action')
        likes = spec.get('action_like')
        params = {**spec.get('param', {}), **params}
        label = intent

    all_hits = db.query_effects(
        action=actions, action_like=likes, params=params,
        count_min=int(count_min) if count_min else None,
        include_meta=include_meta,
    )
    total = len(all_hits)
    hits = all_hits[:int(limit)] if limit else all_hits

    if as_json:
        out = []
        for cid, matched in hits:
            c = db.cards.get(cid, {})
            out.append({
                'id': cid, 'name': c.get('name', ''),
                'type': TYPE_CN.get(c.get('type'), c.get('type', '')),
                'mark': c.get('mark', ''),
                'matched': [{'scope': m['scope'], 'slot': m['slot'], 'seq': m['seq'],
                             'action': m['action'], 'params': m['params']} for m in matched],
            })
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return True

    print(f'语义查询「{label}」'
          + (f' count>={count_min}' if count_min else '')
          + (f' params={params}' if params else '')
          + f' → 命中 {total} 张卡'
          + (f'（显示前 {len(hits)} 张）' if total > len(hits) else ''))
    for cid, matched in hits:
        c = db.cards.get(cid, {})
        mark = c.get('mark') or '?'
        acts = '、'.join(
            f"{m['scope']}{m['slot']}:{m['action']}"
            + (f"({json.dumps(m['params'], ensure_ascii=False)})" if m['params'] else '')
            for m in matched[:3])
        more = f' …共{len(matched)}条' if len(matched) > 3 else ''
        print(f"  - **{c.get('name', '?')}** [{mark}标] `{cid}`"
              f" [{TYPE_CN.get(c.get('type'), c.get('type'))}]: {acts}{more}")
    return True


def main():
    args = [a for a in sys.argv[1:]]
    only_search = '--search' in args
    args = [a for a in args if a != '--search']
    db = CardDB()
    if _run_effect_query(db, args):
        return
    if not args:
        print('用法: python query_card.py "卡名" 或 python query_card.py ID 或 python query_card.py --search "卡名"')
        sys.exit(1)

    query = args[0]

    if query in db.cards:
        print(db.by_id(query))
        return

    results = db.search(query)
    if not results:
        print(f'未找到与「{query}」匹配的卡牌。请检查卡名拼写，或用更短的关键词。')
        sys.exit(0)

    if only_search:
        for score, cid, c in results:
            print(f"- **{c['name']}** [ID:{cid}] [{TYPE_CN.get(c['type'], c['type'])}] [{(c['mark'] or '?')}标]")
        return

    print(f'找到 {len(results)} 张匹配「{query}」的卡牌：\n')
    for score, cid, c in results[:10]:
        print(f"- **{c['name']}** [ID:{cid}] [{TYPE_CN.get(c['type'], c['type'])}] [{(c['mark'] or '?')}标]")
    print('\n--- 最佳匹配详情 ---\n')
    print(db.by_id(results[0][1]))


if __name__ == '__main__':
    main()

