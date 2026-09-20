#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把战斗立绘从网络改成本地：下载 PokeAPI 的正/背两套精灵图。

为什么要单独放一个目录（不复用 /ddp/images/）：
  实测 /ddp/images/*.png 是 **256×64 像素风 4 帧切片**（来自仓库里的 ddp 子项目），
  与战斗现在显示的 PokeAPI **96×96** 立绘**不是同一套美术**。
  混在同一个目录里会出现「一部分像素风、一部分官方风」的画风突变，
  而且同名覆盖还会破坏 ddp 项目自己的资源。
  => 统一放到 /ptcg/images/sprites/，正面 sprites/NNN.png、背面 sprites/back/NNN.png。

用法：
  python3 ptcg/tools/fetch-battle-sprites.py            # 下载（已存在则跳过）
  python3 ptcg/tools/fetch-battle-sprites.py --verify   # 只校验，不下载
  python3 ptcg/tools/fetch-battle-sprites.py --force    # 重新下载已存在的
"""

import io
import json
import os
import sys
import time
import urllib.request

BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images', 'sprites')
CARDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'battle', 'pokemon-cards.json')

FORCE = '--force' in sys.argv
VERIFY_ONLY = '--verify' in sys.argv


def needed_dex():
    """战斗卡池涉及的去重图鉴号（只这些需要落本地）"""
    with io.open(CARDS, encoding='utf-8') as f:
        cards = json.load(f)
    return sorted({int(c['编号']) for c in cards if c.get('编号')})


def local_path(dex, back):
    name = str(dex).zfill(3) + '.png'
    return os.path.join(ROOT, 'back', name) if back else os.path.join(ROOT, name)


def fetch(url, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'ptcg-sprite-fetch'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:  # 网络抖动重试
            last = e
            time.sleep(0.6 * (i + 1))
    raise last


def main():
    dex_list = needed_dex()
    print(f'  战斗卡池需要图鉴号: {len(dex_list)} 个')
    print(f'  目标目录: {os.path.normpath(ROOT)}')

    if VERIFY_ONLY:
        miss_f = [d for d in dex_list if not os.path.exists(local_path(d, False))]
        miss_b = [d for d in dex_list if not os.path.exists(local_path(d, True))]
        size = 0
        count = 0
        for d in dex_list:
            for back in (False, True):
                p = local_path(d, back)
                if os.path.exists(p):
                    size += os.path.getsize(p)
                    count += 1
        print(f'  本地已有: {count} 个文件, {size / 1048576:.2f} MB')
        print(f'  缺正面: {len(miss_f)} 个 {miss_f[:10]}')
        print(f'  缺背面: {len(miss_b)} 个 {miss_b[:10]}')
        return 0 if not miss_f and not miss_b else 1

    os.makedirs(os.path.join(ROOT, 'back'), exist_ok=True)

    added = skipped = failed = 0
    total_bytes = 0
    failures = []
    for i, dex in enumerate(dex_list, 1):
        for back in (False, True):
            path = local_path(dex, back)
            if os.path.exists(path) and not FORCE:
                skipped += 1
                continue
            url = f'{BASE}{"back/" if back else ""}{dex}.png'
            try:
                data = fetch(url)
                with open(path, 'wb') as f:
                    f.write(data)
                added += 1
                total_bytes += len(data)
            except Exception as e:
                failed += 1
                failures.append((dex, back, str(e)[:60]))
        if i % 100 == 0:
            print(f'    进度 {i}/{len(dex_list)}：新增 {added}，跳过 {skipped}，失败 {failed}')
        time.sleep(0.03)

    print('')
    print(f'  完成：新增 {added}，跳过 {skipped}，失败 {failed}，新增体积 {total_bytes / 1048576:.2f} MB')
    if failures:
        print('  失败明细（前 10）:')
        for dex, back, msg in failures[:10]:
            print(f'    #{dex} {"back" if back else "front"}: {msg}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
