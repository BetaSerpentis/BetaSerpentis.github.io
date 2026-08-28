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
"""

import os
import re
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


def main():
    args = [a for a in sys.argv[1:]]
    only_search = '--search' in args
    args = [a for a in args if a != '--search']
    if not args:
        print('用法: python query_card.py "卡名" 或 python query_card.py ID 或 python query_card.py --search "卡名"')
        sys.exit(1)

    db = CardDB()
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

