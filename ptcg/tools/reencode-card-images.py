#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P1：卡图同分辨率重编码（保留 alpha、不改尺寸），用于压缩仓库体积。

背景：
  ptcg/images 下 12764 张原图占 1285.8 MB（中位 63 KB、P90 288 KB、最大 661 KB，
  尺寸仅 300×419），编码质量明显偏高 → 同分辨率重编码即可省下大半空间。

安全性（都已实测确认）：
  - 抽样 120 张：**无动图**（n_frames 全为 1）→ 重编码不会丢掉动画帧
  - 抽样 120 张：**全部含真实透明像素** → 必须保持 RGBA，不能转 RGB
  - 只改编码参数，**不改分辨率**；写入用临时文件再替换，失败不会留下半个文件
  - 文件都在 git 里，万一不满意可用 git checkout 还原

用法：
  python3 ptcg/tools/reencode-card-images.py --sample 60     # 只抽样估算收益
  python3 ptcg/tools/reencode-card-images.py --quality 85    # 全量重编码
  python3 ptcg/tools/reencode-card-images.py --quality 85 --thumbs   # 连缩略图一起
"""

import glob
import io
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images')

QUALITY = 85
METHOD = 5          # method=6 只比 5 小约 1%，却慢 40 倍（实测 2004ms vs 49ms/张）
THUMBS = False
SAMPLE = 0
RESUME = False      # 只处理「与 HEAD 一致」的文件，避免对已重编码的再做二次压缩
for i, a in enumerate(sys.argv):
    if a == '--quality' and i + 1 < len(sys.argv):
        QUALITY = int(sys.argv[i + 1])
    elif a == '--sample' and i + 1 < len(sys.argv):
        SAMPLE = int(sys.argv[i + 1])
    elif a == '--method' and i + 1 < len(sys.argv):
        METHOD = int(sys.argv[i + 1])
    elif a == '--thumbs':
        THUMBS = True
    elif a == '--resume':
        RESUME = True


def targets():
    all_files = glob.glob(os.path.join(ROOT, '*', '*.webp'))
    # 立绘本地化新增的 sprites 目录不参与（它们是 PNG，且已很小）
    full = [f for f in all_files if not f.endswith('.thumb.webp')]
    thumb = [f for f in all_files if f.endswith('.thumb.webp')]
    return full, thumb


def encode_one(args):
    """返回 (path, before, after, ok, err)"""
    path, quality = args
    tmp = path + '.tmp'
    try:
        before = os.path.getsize(path)
        with Image.open(path) as im:
            if getattr(im, 'n_frames', 1) > 1:
                return (path, before, before, False, 'animated')
            im = im.convert('RGBA')          # 保留透明像素
            size = im.size
            im.save(tmp, 'WEBP', quality=quality, method=METHOD)
        with Image.open(tmp) as chk:          # 校验产物可读且尺寸一致
            if chk.size != size:
                os.remove(tmp)
                return (path, before, before, False, f'size changed {chk.size} != {size}')
        after = os.path.getsize(tmp)
        os.replace(tmp, path)
        return (path, before, after, True, '')
    except Exception as e:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return (path, 0, 0, False, str(e)[:80])


def main():
    full, thumb = targets()
    work = list(full)
    if THUMBS:
        work += thumb
    if RESUME:
        # 用 git 判断哪些文件已经不是 HEAD 版本（即已重编码过），跳过它们
        import subprocess
        out = subprocess.run(['git', 'diff', '--name-only', 'ptcg/images/'],
                             capture_output=True, text=True).stdout
        # git 输出的是相对仓库根的路径，glob 给的是绝对路径 —— 统一成绝对路径再比，
        # 否则会一条都匹配不上（曾因此把已编码过的文件又压了一遍）。
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        mod = {str((repo_root / l.strip()).resolve()) for l in out.split('\n')
               if l.strip().endswith('.webp')}
        before_n = len(work)
        work = [f for f in work if str(Path(f).resolve()) not in mod]
        print(f'  --resume：跳过已处理的 {before_n - len(work)} 张，待处理 {len(work)} 张')
    print(f'  原图 {len(full)} 张，缩略图 {len(thumb)} 张；本次处理 {len(work)} 张（quality={QUALITY}）')

    if SAMPLE:
        # 只读估算：编码到内存，绝不写文件
        random.seed(3)
        pick = random.sample(work, min(SAMPLE, len(work)))
        before = sum(os.path.getsize(f) for f in pick)
        after = 0
        failed = 0
        for f in pick:
            try:
                with Image.open(f) as im:
                    im2 = im.convert('RGBA')
                    buf = io.BytesIO()
                    im2.save(buf, 'WEBP', quality=QUALITY, method=METHOD)
                    after += buf.tell()
            except Exception:
                failed += 1
        if failed:
            print(f'  抽样中有 {failed} 张失败（已排除）')
        n = len(pick) - failed
        if not n:
            return
        avg_b, avg_a = before / n, after / n
        all_before = sum(os.path.getsize(x) for x in work if os.path.exists(x))
        print(f'  抽样 {n} 张：平均 {avg_b/1024:.1f} KB → {avg_a/1024:.1f} KB（{avg_a/avg_b*100:.1f}%）')
        print(f'  全量 {len(work)} 张现有 {all_before/1048576:.1f} MB → 预计 {all_before*avg_a/avg_b/1048576:.1f} MB'
              f'（省 {(all_before - all_before*avg_a/avg_b)/1048576:.1f} MB）')
        return

    # 串行处理：method=5 下每张约 50ms，12764 张约 5~10 分钟；
    # 之前用 8 进程池时出现过 BrokenProcessPool（worker 被中止），串行更稳。
    t0 = time.time()
    total_before = total_after = 0
    ok = fail = 0
    failures = []
    for i, f in enumerate(work, 1):
        path, before, after, success, err = encode_one((f, QUALITY))
        if success:
            ok += 1
            total_before += before
            total_after += after
        else:
            fail += 1
            if len(failures) < 10:
                failures.append((path, err))
        if i % 2000 == 0:
            print(f'    进度 {i}/{len(work)}  已省 {(total_before - total_after) / 1048576:.0f} MB  '
                  f'耗时 {time.time() - t0:.0f}s')

    print('')
    print(f'  完成：成功 {ok}，失败 {fail}，耗时 {time.time() - t0:.0f}s')
    if ok:
        print(f'  体积：{total_before / 1048576:.1f} MB → {total_after / 1048576:.1f} MB '
              f'（{total_after / total_before * 100:.1f}%，省 {(total_before - total_after) / 1048576:.1f} MB）')
    for p, e in failures:
        print(f'    失败: {os.path.basename(p)} — {e}')


if __name__ == '__main__':
    main()
