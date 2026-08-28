#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 query_card.py 的查询功能"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from query_card import CardDB


def main():
    db = CardDB()
    print(f'[INFO] 卡牌总数: {len(db.cards)}')

    # 1. 按 ID 精确查宝可梦
    r = db.by_id('CSV10C-151')
    assert r, 'CSV10C-151 未找到'
    assert '獒教父' in r, f'CSV10C-151 卡名异常: {r[:60]}'
    print('[PASS] ID 精确查询 CSV10C-151：')
    print(r)

    # 2. 按卡名模糊搜索
    results = db.search('派帕的獒教父ex')
    assert results, '「派帕的獒教父ex」未搜到'
    top = results[0]
    print(f'\n[PASS] 卡名搜索命中 {len(results)} 张，top1 = {top[2]["name"]} [{top[1]}]')

    # 3. 非宝可梦卡查询（支援者）
    r2 = db.by_id('CSV10C-204')
    assert r2, 'CSV10C-204 未找到'
    assert '抽取' in r2, f'CSV10C-204 效果异常: {r2[:80]}'
    print(f'\n[PASS] 非宝可梦查询 CSV10C-204：')
    print(r2)

    # 4. --search 只列候选（通过 search 方法模拟）
    cands = db.search('博士')
    assert cands, '「博士」未搜到候选'
    print(f'\n[PASS] 「博士」候选 {len(cands)} 张，前3: ' +
          ', '.join(f'{c[2]["name"]}[{c[1]}]' for c in cands[:3]))

    print('\n=== 全部验证通过 ===')


if __name__ == '__main__':
    main()
