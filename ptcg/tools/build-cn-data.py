"""
ptcg/tools/build-cn-data.py
从 E:\PTCG-CN-Sync\data\tsv\ 读取简中卡牌数据，
生成增强版分层 TSV 到 ptcg/data_fast/，
复制卡图到 ptcg/images/。
"""
import csv
import hashlib
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# ── 路径 ──────────────────────────────────────────
CN_SYNC = Path(r"E:\PTCG-CN-Sync")
CN_TSV = CN_SYNC / "data" / "tsv"
CN_IMG = CN_SYNC / "data" / "images"

PTCG = Path(__file__).resolve().parents[1]
OUT_TSV = PTCG / "data_fast"
OUT_IMG = PTCG / "images"

# ── 卡牌类型映射 (CN-Sync type → Chinese display name) ──
TYPE_MAP = {
    "Pokemon":        "宝可梦",
    "Supporter":      "支援者",
    "Item":           "物品",
    "Tool":           "宝可梦道具",
    "Stadium":        "竞技场",
    "Basic Energy":   "基本能量",
    "Special Energy": "特殊能量",
}
TYPE_SLUG = {
    "宝可梦":     "pokemon",
    "支援者":     "supporter",
    "物品":       "item",
    "宝可梦道具": "pokemon-tool",
    "竞技场":     "stadium",
    "基本能量":   "basic-energy",
    "特殊能量":   "special-energy",
}

# ── 能量属性代码 ──
ATTR_CODES = {"G":"草","R":"火","W":"水","L":"雷","P":"超","F":"斗","D":"恶","M":"钢","Y":"妖","N":"龙","C":"无"}
ATTR_TO_CN = {v:k for k,v in ATTR_CODES.items()}

STAGE_CODES = {"Basic":"0","Stage 1":"1","Stage 2":"2","VMAX":"2","VSTAR":"2","V-UNION":"2"}

# ── 过滤器位标志规则 (同 generate-tsv-data.js) ──
FLAG_RULES = [
    (0,  ["__HAS_ABILITY__"]),
    (1,  ["抽","抽出"]),
    (2,  ["选择","加入手牌","搜索","牌库选择","从自己的牌库"]),
    (3,  ["恢复","回复","HP","治疗"]),
    (4,  ["中毒","灼伤","麻痹","睡眠","混乱","异常状态"]),
    (5,  ["附于","附上","能量加速","基本能量卡附"]),
    (6,  ["交换","换位","替换","退回备战区"]),
    (7,  ["丢弃能量","弃能"]),
    (8,  ["从弃牌区","回到手牌","返回手牌","回收"]),
    (9,  ["伤害指示物","放置"]),
    (10, ["不受伤害","防止","减少"]),
    (11, ["不能撤退","无法撤退"]),
    (12, ["对自己"]),
    (13, ["投币","硬币","正面","反面"]),
    (14, ["ACE SPEC","ACE","王牌"]),
    (15, ["宝可梦道具","道具"]),
    (16, ["竞技场"]),
    (17, ["弃牌","丢到弃牌区"]),
    (18, ["放逐区"]),
    (19, ["特性"]),
]

# ── TSV 工具 ──
def tsv_escape(v: str) -> str:
    return str(v or "").replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")

def write_tsv(path: Path, header: str, rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(f"#{header}\n")
        for r in rows:
            f.write("\t".join(tsv_escape(c) for c in r) + "\n")
    size = path.stat().st_size
    print(f"  {path.name}: {len(rows)} rows, {size/1024:.0f} KB")

# ── 主要逻辑 ──
def load_cn_cards():
    """Load all CN-Sync cards, filter standard-legal"""
    cards = []
    with (CN_TSV / "cards.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            if row.get("standard_legal") == "1":
                cards.append(row)
    return cards

def load_cn_attacks():
    attacks_by_card = defaultdict(list)
    with (CN_TSV / "attacks.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            attacks_by_card[row["card_key"]].append(row)
    return attacks_by_card

def load_cn_abilities():
    abilities_by_card = defaultdict(list)
    with (CN_TSV / "abilities.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            abilities_by_card[row["card_key"]].append(row)
    return abilities_by_card

def load_cn_sets():
    sets = {}
    with (CN_TSV / "sets.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            sets[row["set_code"]] = row
    return sets

def build_search_text(card, attacks, abilities):
    """Combine all searchable fields into one text"""
    parts = [
        card.get("card_name", ""),
        card.get("name_en", ""),
        card.get("card_type", ""),
        card.get("mechanic", ""),
        card.get("label", ""),
        card.get("energy_type", ""),
        card.get("stage", ""),
        card.get("set_code", ""),
        card.get("regulation_mark", ""),
    ]
    for atk in attacks:
        parts.extend([atk.get("name",""), atk.get("cost",""), atk.get("damage",""), atk.get("text","")])
    for abi in abilities:
        parts.extend([abi.get("name",""), abi.get("text","")])
    text = " ".join(p for p in parts if p)
    # normalize: lowercase + remove punctuation
    return re.sub(r"[，。；：！？、（）【】《》「」『』""'',\.;:!?()\[\]{}<>]", " ",
                  text).lower()

def build_flags(card, attacks, abilities):
    """Compute bitflag set from card effect text"""
    corpus = card.get("description", "") or ""
    for atk in attacks:
        corpus += " " + (atk.get("text") or "") + " " + (atk.get("name") or "")
    for abi in abilities:
        corpus += " " + (abi.get("text") or "") + " " + (abi.get("name") or "")
        corpus += " __HAS_ABILITY__"
    flags = 0
    for bit, patterns in FLAG_RULES:
        for pat in patterns:
            if pat in corpus:
                flags |= (1 << bit)
                break
    return f"{flags:x}"

def get_skill_costs(attacks):
    costs = [a.get("cost","") for a in sorted(attacks, key=lambda a: int(a.get("attack_order",0) or 0))]
    return ",".join(costs)

def get_skill_damage(attacks):
    damages = [a.get("damage","") for a in sorted(attacks, key=lambda a: int(a.get("attack_order",0) or 0))]
    return ",".join(damages)

def generate_image_path(card):
    """Web-friendly image path: setCode/cardIndex.webp"""
    set_code = card.get("set_code", "")
    card_index = card.get("card_index", "")
    # CN-Sync stores as .png but actual content may be webp
    # We serve as .webp for browser consistency
    return f"{set_code}/{card_index}.webp"

def build_old_to_new_map(cards):
    """Build old numeric ID → new card_key mapping for migration"""
    # First load old JSON data
    old_dir = PTCG / "data"
    old_tags = {
        "宝可梦": ("pokemon-cards.json", "宝可梦名字"),
        "支援者": ("Supporter-cards.json", "卡牌名字"),
        "物品": ("Item-cards.json", "卡牌名字"),
        "宝可梦道具": ("PokemonTool-cards.json", "卡牌名字"),
        "竞技场": ("Stadium-cards.json", "卡牌名字"),
        "基本能量": ("BasicEnergy-cards.json", "卡牌名字"),
        "特殊能量": ("SpecialEnergy-cards.json", "卡牌名字"),
    }
    old_by_id = {}
    for tag, (fname, name_f) in old_tags.items():
        with (old_dir / fname).open("r", encoding="utf-8") as f:
            old_cards = json.load(f)
        for c in old_cards:
            ids = c.get("卡牌ID", [])
            ver = c.get("卡牌版本", "")
            if isinstance(ver, list):
                ver = ver[0] if ver else ""
            for oid in ids:
                old_by_id[str(oid)] = {
                    "name": c.get(name_f, ""),
                    "type": tag,
                    "ver": ver,
                    "effect": c.get("效果", ""),
                }

    # Build CN name index
    cn_by_name = defaultdict(list)
    for c in cards:
        cn_by_name[c["card_name"]].append(c)

    # Build CN Pokémon attribute index
    cn_poke_attrs = defaultdict(list)
    for c in cards:
        if c["card_type"] == "Pokemon":
            key = (c.get("energy_type",""), c.get("hp",""), c.get("stage",""))
            cn_poke_attrs[key].append(c)

    # Mapping
    mapping = {}  # old_id → {"new_key": str, "method": str, "name": str}
    unmatched = []

    def norm_eff(t):
        return re.sub(r"[\s　]+", "", str(t or ""))

    for oid, old in old_by_id.items():
        cn_matches = cn_by_name.get(old["name"], [])

        match = None
        if len(cn_matches) == 1:
            match = (cn_matches[0]["card_key"], "exact_name")
        elif len(cn_matches) > 1:
            mm = [m for m in cn_matches if m.get("regulation_mark") == old["ver"]]
            if mm:
                match = (mm[0]["card_key"], "name_mark")
            else:
                lm = [m for m in cn_matches if m.get("standard_legal") == "1"]
                if lm:
                    match = (lm[0]["card_key"], "name_legal")
                else:
                    match = (cn_matches[0]["card_key"], "name_first")

        # Energy special case: strip 【】
        if not match and old["type"] in ("基本能量", "特殊能量"):
            stripped = old["name"].replace("【", "").replace("】", "")
            cn_matches = cn_by_name.get(stripped, [])
            if cn_matches:
                match = (cn_matches[0]["card_key"], "energy_strip")

        # Effect text matching
        if not match and old.get("effect") and len(old["effect"]) > 4:
            old_eff = norm_eff(old["effect"])
            pool = [c for clist in cn_by_name.values() for c in clist if c.get("description")]
            best, best_s = None, 0
            for c in pool:
                c_eff = norm_eff(c.get("description", ""))
                if old_eff == c_eff:
                    best = (c["card_key"], "exact_effect")
                    break
                if len(c_eff) > 5 and len(old_eff) > 5 and min(len(old_eff), len(c_eff)) / max(len(old_eff), len(c_eff)) > 0.3:
                    matches = sum(1 for j in range(len(old_eff)-1) if old_eff[j:j+2] in c_eff)
                    score = matches / max(len(old_eff)-1, 1)
                    if score > best_s:
                        best_s = score
                        best = (c["card_key"], "fuzzy_effect")
            if best and (best[1] != "fuzzy_effect" or best_s > 0.55):
                match = best

        if match:
            mapping[oid] = {"new_key": match[0], "method": match[1], "name": old["name"]}
        else:
            unmatched.append({"id": oid, "name": old["name"], "type": old["type"], "ver": old["ver"]})

    return mapping, unmatched


def main():
    print("=== PTCG CN Data Builder ===\n")

    # 1. Load data
    print("[1/5] Loading CN-Sync data...")
    cards = load_cn_cards()
    attacks_all = load_cn_attacks()
    abilities_all = load_cn_abilities()
    sets = load_cn_sets()
    print(f"  Standard-legal cards: {len(cards)}")
    print(f"  Attacks: {sum(len(v) for v in attacks_all.values())}")
    print(f"  Abilities: {sum(len(v) for v in abilities_all.values())}")
    print(f"  Sets: {len(sets)}")

    # 2. Group by Chinese type
    print("\n[2/5] Grouping by card type...")
    typed_cards = defaultdict(list)
    for c in cards:
        cn_type = TYPE_MAP.get(c.get("card_type", ""))
        if cn_type:
            typed_cards[cn_type].append(c)
        else:
            print(f"  WARN: unknown card_type '{c.get('card_type')}' for {c.get('card_key')}")

    for t, clist in sorted(typed_cards.items()):
        print(f"  {t}: {len(clist)}")

    # 3. Generate TSV layers
    print("\n[3/5] Generating TSV layers...")
    OUT_TSV.mkdir(parents=True, exist_ok=True)

    for cn_type, clist in sorted(typed_cards.items()):
        slug = TYPE_SLUG[cn_type]
        is_pokemon = cn_type == "宝可梦"

        idx_rows = []
        search_rows = []
        filter_rows = []
        detail_rows = []

        for c in clist:
            ck = c["card_key"]
            atks = attacks_all.get(ck, [])
            abis = abilities_all.get(ck, [])

            # idx: id, name, number, attr(CN), quantity(0), equivalenceKey
            name = c["card_name"]
            number = c.get("card_index", "")
            attr_en = c.get("energy_type", "")
            attr_cn = ATTR_CODES.get(attr_en, attr_en) if attr_en else ""
            eq_key = c.get("effect_id", "")[:16]

            idx_rows.append([ck, name, number, attr_cn, "0", eq_key])

            # search: id, searchText
            st = build_search_text(c, atks, abis)
            search_rows.append([ck, st])

            # filter: id, hp, stage, attr(EN), retreat, flags, costs, dmg, standard_legal
            stage_code = STAGE_CODES.get(c.get("stage", ""), "") if is_pokemon else ""
            hp = c.get("hp", "") if is_pokemon else ""
            retreat = c.get("retreat_cost", "") if is_pokemon else ""
            flags = build_flags(c, atks, abis)
            costs = get_skill_costs(atks) if is_pokemon else ""
            dmg = get_skill_damage(atks) if is_pokemon else ""
            std_legal = c.get("standard_legal", "")

            filter_rows.append([ck, hp, stage_code, attr_en, retreat, flags, costs, dmg, std_legal])

            # detail: id, description, evolves_from, weakness, resistance, artist, set_name, rarity, mechanic, regulation_mark, name_en
            weakness = f"{c.get('weakness_energy','')}{c.get('weakness_value','')}" if c.get('weakness_energy') else ""
            resistance = f"{c.get('resistance_energy','')}{c.get('resistance_value','')}" if c.get('resistance_energy') else ""
            set_name = sets.get(c.get("set_code", ""), {}).get("name", "")

            detail_rows.append([
                ck, c.get("description", ""), c.get("evolves_from", ""),
                weakness, resistance, c.get("artist", ""),
                set_name, c.get("rarity", ""), c.get("mechanic", ""),
                c.get("regulation_mark", ""), c.get("name_en", ""),
            ])

        write_tsv(OUT_TSV / f"{slug}.idx.tsv", "idx1", idx_rows)
        write_tsv(OUT_TSV / f"{slug}.search.tsv", "srch1", search_rows)
        write_tsv(OUT_TSV / f"{slug}.filter.tsv", "flt1", filter_rows)
        write_tsv(OUT_TSV / f"{slug}.detail.tsv", "dtl1", detail_rows)

    # Also generate global attacks & abilities TSV (only for standard-legal cards)
    legal_keys = {c["card_key"] for c in cards}
    global_atk = []
    for ck, atks in attacks_all.items():
        if ck in legal_keys:
            for a in atks:
                global_atk.append([ck, a.get("set_code",""), a.get("card_index",""),
                                   a.get("attack_order",""), a.get("name",""),
                                   a.get("cost",""), a.get("damage",""), a.get("text",""),
                                   a.get("is_vstar_power","")])
    write_tsv(OUT_TSV / "attacks.tsv", "atk1", global_atk)

    global_abi = []
    for ck, abis in abilities_all.items():
        if ck in legal_keys:
            for a in abis:
                global_abi.append([ck, a.get("set_code",""), a.get("card_index",""),
                                   a.get("ability_order",""), a.get("name",""), a.get("text","")])
    write_tsv(OUT_TSV / "abilities.tsv", "abi1", global_abi)

    # 4. Build old→new ID mapping
    print("\n[4/5] Building old-to-new ID mapping...")
    mapping, unmatched = build_old_to_new_map(cards)
    print(f"  Mapped: {len(mapping)} IDs")
    print(f"  Unmatched: {len(unmatched)} cards")

    # Save mapping
    map_path = PTCG / "tools" / "id_mapping.json"
    map_data = {k: {"new_key": v["new_key"], "method": v["method"]} for k, v in mapping.items()}
    with map_path.open("w", encoding="utf-8") as f:
        json.dump(map_data, f, ensure_ascii=False, indent=2)
    print(f"  Saved to: {map_path}")

    # Save unmatched for manual review
    unm_path = PTCG / "tools" / "unmatched_cards.json"
    with unm_path.open("w", encoding="utf-8") as f:
        json.dump(unmatched, f, ensure_ascii=False, indent=2)
    print(f"  Unmatched saved to: {unm_path}")

    method_stats = defaultdict(int)
    for v in mapping.values():
        method_stats[v["method"]] += 1
    print(f"  Methods: {dict(method_stats)}")

    # 5. Copy images
    print("\n[5/5] Copying images...")
    OUT_IMG.mkdir(parents=True, exist_ok=True)
    copied, skipped, missing = 0, 0, 0
    for c in cards:
        img_path = c.get("image_path", "")
        if not img_path:
            missing += 1
            continue
        src = CN_IMG / img_path.replace("\\", "/")
        # Target: setCode/cardIndex.webp
        set_code = c["set_code"]
        card_index = c["card_index"]
        dst_dir = OUT_IMG / set_code
        dst_dir.mkdir(parents=True, exist_ok=True)

        # Try .webp first (most common in CN-Sync), then .png
        dst_webp = dst_dir / f"{card_index}.webp"
        dst_png = dst_dir / f"{card_index}.png"

        if dst_webp.exists() or dst_png.exists():
            skipped += 1
            continue

        if src.exists():
            shutil.copy2(src, dst_webp)
            copied += 1
        else:
            # Source might have different extension
            alt = src.with_suffix(".webp")
            if alt.exists():
                shutil.copy2(alt, dst_webp)
                copied += 1
            else:
                missing += 1
                if missing <= 10:
                    print(f"  MISS: {src}")

        if copied % 1000 == 0 and copied > 0:
            print(f"  Copied: {copied}...")

    print(f"  Done: {copied} copied, {skipped} skipped, {missing} missing")

    # Generate updated meta.json
    print("\n[6] Generating meta.json...")
    meta = {
        "format": "简中标准环境 F/G/H/I 标",
        "currentMarks": ["F", "G", "H", "I"],
        "retiredMarks": ["A", "B", "C", "D", "E"],
        "description": "简中 PTCG 当前标准赛制为 F/G/H/I 标。A-E 标已退环境。数据来源：tcg.mik.moe",
        "markSeries": {
            "F": "SV1-SV3（朱&紫 起始套装VSTAR/EX 等）",
            "G": "SV4-SV5（未来闪光/古代咆哮 等）",
            "H": "SV6-SV7（变换的假面/黑炎支配者 等）",
            "I": "SV8-SV9（乐园腾龙/巅峰之路 等）"
        },
        "basicEnergy": {
            "description": "基本能量卡ID速查表",
            "cards": []
        }
    }
    # Build energy ID list
    for c in cards:
        if c["card_type"] == "Basic Energy":
            meta["basicEnergy"]["cards"].append({
                "name": c["card_name"],
                "id": c["card_key"]
            })

    with (PTCG / "data" / "meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"  Updated meta.json")

    print("\n=== Build Complete ===")


if __name__ == "__main__":
    main()
