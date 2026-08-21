"""
ptcg/tools/build-battle-data.py

为 ptcgBattle 生成对战引擎可直接消费的卡牌数据（旧字段结构 + 新 set-code ID + 完整卡池）。

数据来源（与 ptcg 主程序 data_fast 完全同源）：
- E:\\PTCG-CN-Sync\\data\\tsv\\cards.tsv      卡牌主表（含 mechanic/label/ancient_trait/弱点倍率等）
- E:\\PTCG-CN-Sync\\data\\tsv\\attacks.tsv    招式表
- E:\\PTCG-CN-Sync\\data\\tsv\\abilities.tsv  特性表
- ptcg/data_fast/*.idx.tsv                    全国图鉴编号（复用 build-cn-data.py 的 dex 传播结果）

输出（ptcg/data/battle/，与旧 ptcg/data/*.json 字段结构一致）：
- pokemon-cards.json / Item-cards.json / Supporter-cards.json / Stadium-cards.json
- PokemonTool-cards.json / BasicEnergy-cards.json / SpecialEnergy-cards.json

用法: python ptcg/tools/build-battle-data.py
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

CN_SYNC = Path(r"E:\PTCG-CN-Sync")
CN_TSV = CN_SYNC / "data" / "tsv"
PTCG = Path(__file__).resolve().parents[1]
OUT_DIR = PTCG / "data" / "battle"

# 能量代码 → 简中属性名（与 build-cn-data.py ATTR_CODES 一致）
ATTR_CN = {"G": "草", "R": "火", "W": "水", "L": "雷", "P": "超",
           "F": "斗", "D": "恶", "M": "钢", "Y": "妖", "N": "龙", "C": "无"}

STAGE_CN = {
    "Basic": "基础", "Stage 1": "1阶进化", "Stage 2": "2阶进化",
    "VMAX": "2阶进化", "VSTAR": "2阶进化", "V-UNION": "2阶进化",
    "BREAK": "1阶进化", "RESTORED": "基础",
}

TYPE_SLUG = {
    "Pokemon": "pokemon-cards.json",
    "Supporter": "Supporter-cards.json",
    "Item": "Item-cards.json",
    "Stadium": "Stadium-cards.json",
    "Tool": "PokemonTool-cards.json",
    "Basic Energy": "BasicEnergy-cards.json",
    "Special Energy": "SpecialEnergy-cards.json",
}

TYPE_CN = {
    "Supporter": "支援者卡", "Item": "物品卡", "Stadium": "竞技场卡",
    "Tool": "宝可梦道具卡", "Basic Energy": "基本能量卡", "Special Energy": "特殊能量卡",
}


def load_tsv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def rule_text(card):
    """根据 mechanic/label/名字 合成规则盒文本（旧 JSON 规则 字段）。"""
    name = card.get("card_name", "")
    mechanic = card.get("mechanic", "") or ""
    label = card.get("label", "") or ""
    if "TAG TEAM" in label:
        return "TAG TEAM【气绝】时，对手获得3张奖赏卡。"
    # VMAX/VSTAR/BREAK 在 mechanic 里统一记作 "V"，需先按名字判断
    if "VMAX" in name:
        return "宝可梦【VMAX】【昏厥】时，对手获得3张奖赏卡。"
    if "VSTAR" in name:
        return "宝可梦【VSTAR】【昏厥】时，对手获得2张奖赏卡。"
    if "BREAK" in name:
        return "宝可梦【BREAK】【昏厥】时，对手获得2张奖赏卡。"
    if mechanic == "ex":
        return "宝可梦【ex】【昏厥】时，对手获得2张奖赏卡。"
    if mechanic == "GX":
        return "宝可梦【GX】【昏厥】时，对手获得2张奖赏卡。"
    if mechanic == "V":
        return "宝可梦【V】【昏厥】时，对手获得2张奖赏卡。"
    if mechanic == "Radiant":
        return "1副牌组只可放1张光辉宝可梦卡。"
    if mechanic == "Prism Star":
        return "1副牌组只可放1张棱镜之星卡。"
    return ""


def rule2_text(card):
    if card.get("ancient_trait", "") == "Tera":
        return "太晶：只要这只宝可梦在备战区，不会受到招式的伤害。"
    return ""


def parse_cost(cost_str):
    """'GGC' → ['草','草','无']"""
    return [ATTR_CN.get(ch, "无") for ch in (cost_str or "")]


def build_dex_lookup():
    """从 data_fast 的 idx.tsv 读取已传播的全国图鉴编号。"""
    dex = {}
    for slug in TYPE_SLUG.values():
        stem = slug[:-len("-cards.json")]
        idx_path = PTCG / "data_fast" / f"{stem}.idx.tsv"
        if not idx_path.exists():
            continue
        with idx_path.open("r", encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t"):
                if not row or row[0].startswith("#"):
                    continue
                # idx: [card_key, name, dex, attr_cn, qty, eq_key, active]
                if len(row) > 2 and row[2] and row[2] != "0":
                    dex[row[0]] = int(row[2]) if str(row[2]).isdigit() else 0
    return dex


def main():
    print("=== PTCG Battle Data Builder ===")
    cards = load_tsv(CN_TSV / "cards.tsv")
    attacks = defaultdict(list)
    for a in load_tsv(CN_TSV / "attacks.tsv"):
        attacks[a["card_key"]].append(a)
    abilities = defaultdict(list)
    for a in load_tsv(CN_TSV / "abilities.tsv"):
        abilities[a["card_key"]].append(a)

    dex_lookup = build_dex_lookup()
    print(f"  cards={len(cards)}, dex entries={len(dex_lookup)}")

    buckets = defaultdict(list)

    for c in cards:
        ctype = c.get("card_type", "")
        slug = TYPE_SLUG.get(ctype)
        if not slug:
            continue

        ck = c["card_key"]
        atks = sorted(attacks.get(ck, []), key=lambda a: int(a.get("attack_order", 0) or 0))
        abis = sorted(abilities.get(ck, []), key=lambda a: int(a.get("ability_order", 0) or 0))

        common = {
            "卡牌ID": [ck],
            "卡牌版本": c.get("regulation_mark", ""),
            "拥有数量": 0,
        }

        if ctype == "Pokemon":
            entry = dict(common)
            entry.update({
                "编号": dex_lookup.get(ck, 0),
                "宝可梦名字": c.get("card_name", ""),
                "进化阶段": STAGE_CN.get(c.get("stage", ""), "基础"),
                "进化自": c.get("evolves_from", "") or "",
                "HP": int(c.get("hp", 0) or 0),
                "属性": ATTR_CN.get(c.get("energy_type", ""), ""),
                "规则": rule_text(c),
                "规则2": rule2_text(c),
                "弱点": ATTR_CN.get(c.get("weakness_energy", ""), ""),
                "抵抗力": ATTR_CN.get(c.get("resistance_energy", ""), ""),
                "撤退": int(c.get("retreat_cost", 0) or 0),
                "特性名字": abis[0].get("name", "") if abis else "",
                "特性效果": abis[0].get("text", "") if abis else "",
                # 扩展字段（对战引擎可逐步接入，旧字段不受影响）
                "mechanic": c.get("mechanic", ""),
                "label": c.get("label", ""),
                "ancient_trait": c.get("ancient_trait", ""),
                "弱点倍率": (c.get("weakness_value", "") or "").replace("×", "x"),
                "抵抗值": c.get("resistance_value", "") or "",
                "effect_id": c.get("effect_id", ""),
                "name_en": c.get("name_en", ""),
            })
            for i, a in enumerate(atks[:4], start=1):
                entry[f"技能{i}"] = {
                    "名字": a.get("name", ""),
                    "消耗": parse_cost(a.get("cost", "")),
                    "伤害": a.get("damage", ""),
                    "效果": a.get("text", "") or "无",
                }
            buckets["pokemon-cards.json"].append(entry)
        elif ctype in TYPE_CN:
            entry = dict(common)
            entry.update({
                "卡牌类型": TYPE_CN[ctype],
                "卡牌名字": c.get("card_name", ""),
                "效果": c.get("description", "") or "无",
                "mechanic": c.get("mechanic", ""),
                "effect_id": c.get("effect_id", ""),
            })
            buckets[slug].append(entry)

    # 输出
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for slug, items in sorted(buckets.items()):
        out = OUT_DIR / slug
        with out.open("w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=1)
        total += len(items)
        print(f"  {slug}: {len(items)}")
    print(f"  Total: {total}")
    print("=== Battle Data Build Complete ===")


if __name__ == "__main__":
    main()
