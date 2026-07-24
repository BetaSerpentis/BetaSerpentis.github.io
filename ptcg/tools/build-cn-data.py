"""
ptcg/tools/build-cn-data.py (v2)
从 E:\PTCG-CN-Sync\data\tsv\ 读取简中卡牌数据，
生成增强版分层 TSV 到 ptcg/data_fast/，
复制卡图到 ptcg/images/。

v2 改进：
- 映射增加属性/HP/阶段等二级校验
- 提取旧 JSON 中的全国图鉴编号用于排序
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

# ── 路径 ──
CN_SYNC = Path(r"E:\PTCG-CN-Sync")
CN_TSV = CN_SYNC / "data" / "tsv"
CN_IMG = CN_SYNC / "data" / "images"

PTCG = Path(__file__).resolve().parents[1]
OUT_TSV = PTCG / "data_fast"
OUT_IMG = PTCG / "images"

# ── 卡牌类型映射 ──
TYPE_MAP = {
    "Pokemon": "宝可梦", "Supporter": "支援者", "Item": "物品",
    "Tool": "宝可梦道具", "Stadium": "竞技场",
    "Basic Energy": "基本能量", "Special Energy": "特殊能量",
}
TYPE_SLUG = {
    "宝可梦": "pokemon", "支援者": "supporter", "物品": "item",
    "宝可梦道具": "pokemon-tool", "竞技场": "stadium",
    "基本能量": "basic-energy", "特殊能量": "special-energy",
}

ATTR_CODES = {"G":"草","R":"火","W":"水","L":"雷","P":"超","F":"斗","D":"恶","M":"钢","Y":"妖","N":"龙","C":"无"}
CN_TO_EN_ATTR = {v:k for k,v in ATTR_CODES.items()}
STAGE_CODES = {"Basic":"0","Stage 1":"1","Stage 2":"2","VMAX":"2","VSTAR":"2","V-UNION":"2"}

FLAG_RULES = [
    (0,["__HAS_ABILITY__"]),(1,["抽","抽出"]),(2,["选择","加入手牌","搜索","牌库选择","从自己的牌库"]),
    (3,["恢复","回复","HP","治疗"]),(4,["中毒","灼伤","麻痹","睡眠","混乱","异常状态"]),
    (5,["附于","附上","能量加速","基本能量卡附"]),(6,["交换","换位","替换","退回备战区"]),
    (7,["丢弃能量","弃能"]),(8,["从弃牌区","回到手牌","返回手牌","回收"]),
    (9,["伤害指示物","放置"]),(10,["不受伤害","防止","减少"]),(11,["不能撤退","无法撤退"]),
    (12,["对自己"]),(13,["投币","硬币","正面","反面"]),(14,["ACE SPEC","ACE","王牌"]),
    (15,["宝可梦道具","道具"]),(16,["竞技场"]),(17,["弃牌","丢到弃牌区"]),
    (18,["放逐区"]),(19,["特性"]),
]

def tsv_escape(v: str) -> str:
    return str(v or "").replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")

def write_tsv(path: Path, header: str, rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(f"#{header}\n")
        for r in rows:
            f.write("\t".join(tsv_escape(c) for c in r) + "\n")
    print(f"  {path.name}: {len(rows)} rows, {path.stat().st_size/1024:.0f} KB")

def load_cn_cards():
    cards = []
    with (CN_TSV / "cards.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            if row.get("standard_legal") == "1":
                cards.append(row)
    return cards

def load_cn_attacks():
    d = defaultdict(list)
    with (CN_TSV / "attacks.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            d[row["card_key"]].append(row)
    return d

def load_cn_abilities():
    d = defaultdict(list)
    with (CN_TSV / "abilities.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            d[row["card_key"]].append(row)
    return d

def load_cn_sets():
    sets = {}
    with (CN_TSV / "sets.tsv").open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            sets[row["set_code"]] = row
    return sets

# ── 旧 JSON → dex number 提取 ──
def build_dex_from_old():
    """从旧 JSON 提取 (繁中名, 属性, HP, 阶段) → 全国编号"""
    old_dir = PTCG / "data"
    old_tags = [
        ("pokemon-cards.json", "宝可梦名字"),
    ]
    dex_lookup = {}  # (name, attr_cn, hp, stage_cn) → dex_num (highest priority match)
    name_only_dex = {}  # name → dex_num (fallback)

    for fname, name_f in old_tags:
        with (old_dir / fname).open("r", encoding="utf-8") as f:
            old_cards = json.load(f)
        for c in old_cards:
            name = c.get(name_f, "")
            num = int(c.get("编号", 0) or 0)
            if not num:
                continue
            attr = c.get("属性", "")
            hp = str(c.get("HP", ""))
            stage = c.get("进化阶段", "")
            key = (name, attr, hp, stage)
            dex_lookup[key] = num
            if name not in name_only_dex:
                name_only_dex[name] = num
    return dex_lookup, name_only_dex

def build_search_text(card, attacks, abilities):
    parts = [card.get("card_name",""), card.get("name_en",""), card.get("card_type",""),
             card.get("mechanic",""), card.get("label",""), card.get("energy_type",""),
             card.get("stage",""), card.get("set_code",""), card.get("regulation_mark","")]
    for atk in attacks:
        parts.extend([atk.get("n",""), atk.get("c",""), atk.get("d",""), atk.get("t","")])
    for abi in abilities:
        parts.extend([abi.get("n",""), abi.get("t","")])
    return re.sub(r"[，。；：！？、（）【】《》「」『』""'',\.;:!?()\[\]{}<>]", " ",
                  " ".join(p for p in parts if p)).lower()

def build_flags(card, attacks, abilities):
    corpus = (card.get("description") or "") + " "
    for atk in attacks:
        corpus += (atk.get("text") or "") + " " + (atk.get("name") or "") + " "
    for abi in abilities:
        corpus += (abi.get("text") or "") + " " + (abi.get("name") or "") + " "
        corpus += "__HAS_ABILITY__ "
    flags = 0
    for bit, patterns in FLAG_RULES:
        for pat in patterns:
            if pat in corpus:
                flags |= (1 << bit)
                break
    return f"{flags:x}"

def get_skill_costs(attacks):
    return ",".join(a.get("cost","") for a in sorted(attacks, key=lambda a: int(a.get("attack_order",0) or 0)))

def get_skill_damage(attacks):
    return ",".join(a.get("damage","") for a in sorted(attacks, key=lambda a: int(a.get("attack_order",0) or 0)))

_EN_TO_DEX = {}  # English name → dex number, populated during mapping
def _score_cn_match(cn_card, old_card, dex_lookup):
    """给 CN 卡对旧卡的匹配打分：属性>特性>HP>阶段。返回 (score, cn_card)"""
    score = 0
    # 属性匹配（最重要）
    old_attr = old_card.get("attr_cn", "")
    cn_attr_en = cn_card.get("energy_type", "")
    cn_attr_cn = ATTR_CODES.get(cn_attr_en, "")
    if old_attr and cn_attr_cn == old_attr:
        score += 1000
    elif not old_attr:
        score += 0  # 非宝可梦，不影响
    # HP 匹配
    old_hp = old_card.get("hp", "")
    cn_hp = cn_card.get("hp", "")
    if old_hp and cn_hp == old_hp:
        score += 100
    # 有特性 vs 无特性
    old_has_abi = bool(old_card.get("has_ability"))
    cn_has_abi = bool(cn_card.get("description","") and "特性" in cn_card.get("description",""))
    if old_has_abi == cn_has_abi:
        score += 10
    # dex number consistency
    old_dex = old_card.get("dex_num", 0)
    if old_dex:
        cn_name_en = cn_card.get("name_en", "")
        cn_name_cn = cn_card.get("card_name", "")
        # Check if dex number is plausible for this Pokémon species
        # (We don't have exact dex→name mapping but we can check via name_only_dex)
        pass  # Skip for now, rely on name+attr
    return score

def build_old_to_new_map_v2(cards, dex_lookup, name_only_dex):
    """改进版映射：名称+版标+属性 三级匹配"""
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
            hp = str(c.get("HP", "") or "")
            attr_cn = c.get("属性", "") if fname == "pokemon-cards.json" else ""
            has_abi = bool(c.get("特性名字", ""))
            for oid in ids:
                old_by_id[str(oid)] = {
                    "name": c.get(name_f, ""),
                    "type": tag,
                    "ver": ver,
                    "effect": c.get("效果", ""),
                    "hp": hp,
                    "attr_cn": attr_cn,
                    "has_ability": has_abi,
                    "dex_num": int(c.get("编号", 0) or 0) if fname == "pokemon-cards.json" else 0,
                }

    # CN-Sync index
    cn_by_name = defaultdict(list)
    for c in cards:
        cn_by_name[c["card_name"]].append(c)

    mapping = {}
    unmatched = []

    def norm_eff(t):
        return re.sub(r"[\s　]+", "", str(t or ""))

    for oid, old in old_by_id.items():
        cn_matches = cn_by_name.get(old["name"], [])
        match = None

        if len(cn_matches) == 1:
            match = (cn_matches[0]["card_key"], "exact_name")
        elif len(cn_matches) > 1:
            # Filter by regulation_mark
            mm = [m for m in cn_matches if m.get("regulation_mark") == old["ver"]]
            if len(mm) == 1:
                match = (mm[0]["card_key"], "name_mark")
            elif len(mm) > 1 and old.get("attr_cn"):
                # Multiple name+mark matches — score by attributes
                best = max(mm, key=lambda m: _score_cn_match(m, old, dex_lookup))
                match = (best["card_key"], "name_mark_attr")
            elif len(mm) > 1:
                # Non-Pokemon, pick first
                match = (mm[0]["card_key"], "name_mark")
            else:
                # No mark match, try standard_legal
                lm = [m for m in cn_matches if m.get("standard_legal") == "1"]
                if lm:
                    match = (lm[0]["card_key"], "name_legal")
                else:
                    match = (cn_matches[0]["card_key"], "name_first")

        # Energy special case
        if not match and old["type"] in ("基本能量", "特殊能量"):
            stripped = old["name"].replace("【", "").replace("】", "")
            cm = cn_by_name.get(stripped, [])
            if cm:
                match = (cm[0]["card_key"], "energy_strip")

        # Effect text matching
        if not match and old.get("effect") and len(old["effect"]) > 4:
            old_eff = norm_eff(old["effect"])
            pool = [c for cl in cn_by_name.values() for c in cl if c.get("description")]
            best, best_s = None, 0
            for c in pool:
                c_eff = norm_eff(c.get("description", ""))
                if old_eff == c_eff:
                    best = (c["card_key"], "exact_effect")
                    break
                if len(c_eff) > 5 and len(old_eff) > 5:
                    if min(len(old_eff), len(c_eff)) / max(len(old_eff), len(c_eff)) > 0.3:
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


def get_dex_for_cn(card, cn_key_to_dex, mapping, dex_lookup, name_only_dex):
    """获取 CN 卡牌对应的全国图鉴编号"""
    ck = card["card_key"]
    cn_type = TYPE_MAP.get(card.get("card_type", ""))
    if cn_type != "宝可梦":
        return ""

    # 1. Direct lookup from reverse mapping (most reliable)
    if ck in cn_key_to_dex:
        return str(cn_key_to_dex[ck])

    # 2. Lookup by name in old data (simplified name may match)
    cn_name = card["card_name"]
    cn_attr = ATTR_CODES.get(card.get("energy_type", ""), "")
    cn_hp = card.get("hp", "")
    cn_stage_cn = {"Basic": "基础", "Stage 1": "1阶进化", "Stage 2": "2阶进化",
                   "VMAX": "V进化", "VSTAR": "VSTAR", "V-UNION": "其他"}.get(card.get("stage",""), "")

    # Try exact (name, attr_cn, hp, stage_cn) in dex_lookup
    for key_suffix in [
        (cn_name, cn_attr, cn_hp, cn_stage_cn),
        (cn_name, cn_attr, cn_hp, "基础"),  # fallback to basic
    ]:
        if key_suffix in dex_lookup:
            return str(dex_lookup[key_suffix])

    # 3. Name-only fallback (try simplified first, then English)
    if cn_name in name_only_dex:
        return str(name_only_dex[cn_name])

    # 4. Try name_en → look up in CN-Sync cards that DID get dex from mapping,
    #    then propagate by name_en
    name_en = card.get("name_en", "")
    if name_en and name_en in _EN_TO_DEX:
        return str(_EN_TO_DEX[name_en])

    return ""


def main():
    print("=== PTCG CN Data Builder v2 ===\n")

    # 1. Load data
    print("[1/6] Loading CN-Sync data...")
    cards = load_cn_cards()
    attacks_all = load_cn_attacks()
    abilities_all = load_cn_abilities()
    sets = load_cn_sets()
    print(f"  Standard-legal cards: {len(cards)}")

    # 2. Load old data for dex numbers
    print("\n[2/6] Extracting national dex numbers from old data...")
    dex_lookup, name_only_dex = build_dex_from_old()
    print(f"  Dex lookup entries: {len(dex_lookup)}")
    print(f"  Name-only fallback: {len(name_only_dex)}")

    # 3. Build improved mapping
    print("\n[3/6] Building old→new ID mapping (v2: name+mark+attr)...")
    # Need old_by_id for dex lookups later
    old_dir = PTCG / "data"
    old_tags_files = {
        "宝可梦": ("pokemon-cards.json", "宝可梦名字"),
        "支援者": ("Supporter-cards.json", "卡牌名字"),
        "物品": ("Item-cards.json", "卡牌名字"),
        "宝可梦道具": ("PokemonTool-cards.json", "卡牌名字"),
        "竞技场": ("Stadium-cards.json", "卡牌名字"),
        "基本能量": ("BasicEnergy-cards.json", "卡牌名字"),
        "特殊能量": ("SpecialEnergy-cards.json", "卡牌名字"),
    }
    old_by_id = {}
    for tag, (fname, name_f) in old_tags_files.items():
        with (old_dir / fname).open("r", encoding="utf-8") as f:
            for c in json.load(f):
                ids = c.get("卡牌ID", [])
                dex = int(c.get("编号", 0) or 0) if fname == "pokemon-cards.json" else 0
                for oid in ids:
                    old_by_id[str(oid)] = {
                        "name": c.get(name_f, ""), "type": tag, "dex_num": dex,
                    }

    mapping, unmatched = build_old_to_new_map_v2(cards, dex_lookup, name_only_dex)

    # Build cn_card_key → dex_num reverse index
    cn_key_to_dex = {}
    for oid, m in mapping.items():
        ck = m["new_key"]
        if ck not in cn_key_to_dex and oid in old_by_id:
            dex = old_by_id[oid].get("dex_num", 0)
            if dex:
                cn_key_to_dex[ck] = dex

    # Build English name → dex index for cross-species propagation
    for c in cards:
        ck = c["card_key"]
        en = c.get("name_en", "")
        if ck in cn_key_to_dex and en and en not in _EN_TO_DEX:
            _EN_TO_DEX[en] = cn_key_to_dex[ck]

    print(f"  Mapped: {len(mapping)} IDs")
    print(f"  cn_key_to_dex: {len(cn_key_to_dex)} entries")
    print(f"  _EN_TO_DEX: {len(_EN_TO_DEX)} entries")
    print(f"  Unmatched: {len(unmatched)} cards")
    method_stats = defaultdict(int)
    for v in mapping.values():
        method_stats[v["method"]] += 1
    print(f"  Methods: {dict(method_stats)}")

    # Save mapping
    map_path = PTCG / "tools" / "id_mapping.json"
    with map_path.open("w", encoding="utf-8") as f:
        json.dump({k: {"new_key": v["new_key"], "method": v["method"]} for k, v in mapping.items()},
                  f, ensure_ascii=False, indent=2)
    unm_path = PTCG / "tools" / "unmatched_cards.json"
    with unm_path.open("w", encoding="utf-8") as f:
        json.dump(unmatched, f, ensure_ascii=False, indent=2)

    # 4. Group by type and assign dex numbers
    print("\n[4/6] Grouping by card type, assigning dex numbers...")
    typed_cards = defaultdict(list)
    for c in cards:
        cn_type = TYPE_MAP.get(c.get("card_type", ""))
        if cn_type:
            typed_cards[cn_type].append(c)
    for t, clist in sorted(typed_cards.items()):
        print(f"  {t}: {len(clist)}")

    # 5. Generate TSV layers
    print("\n[5/6] Generating TSV layers...")
    OUT_TSV.mkdir(parents=True, exist_ok=True)

    for cn_type, clist in sorted(typed_cards.items()):
        slug = TYPE_SLUG[cn_type]
        is_pokemon = cn_type == "宝可梦"
        # Sort by dex number first, then by set_code+card_index for tiebreakers
        if is_pokemon:
            def sort_key(c):
                dex = int(get_dex_for_cn(c, cn_key_to_dex, mapping, dex_lookup, name_only_dex) or 0)
                return (dex, c.get("set_code",""), c.get("card_index",""))
            clist.sort(key=sort_key)

        idx_rows, search_rows, filter_rows, detail_rows = [], [], [], []

        for c in clist:
            ck = c["card_key"]
            atks = attacks_all.get(ck, [])
            abis = abilities_all.get(ck, [])
            name = c["card_name"]

            # idx: id, name, number(dex), attr_cn, qty(0), eqKey
            dex_num = get_dex_for_cn(c, cn_key_to_dex, mapping, dex_lookup, name_only_dex)
            attr_en = c.get("energy_type", "")
            attr_cn = ATTR_CODES.get(attr_en, attr_en) if attr_en else ""
            eq_key = (c.get("effect_id") or "")[:16]

            idx_rows.append([ck, name, dex_num, attr_cn, "0", eq_key])

            # search
            st = build_search_text(c, atks, abis)
            search_rows.append([ck, st])

            # filter
            stage_code = STAGE_CODES.get(c.get("stage",""), "") if is_pokemon else ""
            hp = c.get("hp","") if is_pokemon else ""
            retreat = c.get("retreat_cost","") if is_pokemon else ""
            flags = build_flags(c, atks, abis)
            costs = get_skill_costs(atks) if is_pokemon else ""
            dmg = get_skill_damage(atks) if is_pokemon else ""
            std = c.get("standard_legal","")
            filter_rows.append([ck, hp, stage_code, attr_en, retreat, flags, costs, dmg, std])

            # detail
            wk = f"{c.get('weakness_energy','')}{c.get('weakness_value','')}" if c.get("weakness_energy") else ""
            res = f"{c.get('resistance_energy','')}{c.get('resistance_value','')}" if c.get("resistance_energy") else ""
            set_name = sets.get(c.get("set_code",""),{}).get("name","")
            detail_rows.append([ck, c.get("description",""), c.get("evolves_from",""),
                               wk, res, c.get("artist",""), set_name, c.get("rarity",""),
                               c.get("mechanic",""), c.get("regulation_mark",""), c.get("name_en","")])

        write_tsv(OUT_TSV / f"{slug}.idx.tsv", "idx1", idx_rows)
        write_tsv(OUT_TSV / f"{slug}.search.tsv", "srch1", search_rows)
        write_tsv(OUT_TSV / f"{slug}.filter.tsv", "flt1", filter_rows)
        write_tsv(OUT_TSV / f"{slug}.detail.tsv", "dtl1", detail_rows)

    # Global attacks & abilities
    legal_keys = {c["card_key"] for c in cards}
    g_atk = []; g_abi = []
    for ck, atks in attacks_all.items():
        if ck in legal_keys:
            for a in atks:
                g_atk.append([ck, a.get("set_code",""), a.get("card_index",""),
                             a.get("attack_order",""), a.get("name",""), a.get("cost",""),
                             a.get("damage",""), a.get("text",""), a.get("is_vstar_power","")])
    for ck, abis in abilities_all.items():
        if ck in legal_keys:
            for a in abis:
                g_abi.append([ck, a.get("set_code",""), a.get("card_index",""),
                             a.get("ability_order",""), a.get("name",""), a.get("text","")])
    write_tsv(OUT_TSV / "attacks.tsv", "atk1", g_atk)
    write_tsv(OUT_TSV / "abilities.tsv", "abi1", g_abi)

    # 6. Images
    print("\n[6/6] Copying images...")
    OUT_IMG.mkdir(parents=True, exist_ok=True)
    copied, skipped, missing = 0, 0, 0
    for c in cards:
        img_path = c.get("image_path", "")
        if not img_path:
            missing += 1; continue
        src = CN_IMG / img_path.replace("\\", "/")
        dst = OUT_IMG / c["set_code"] / f"{c['card_index']}.webp"
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            skipped += 1; continue
        if src.exists():
            shutil.copy2(src, dst); copied += 1
        else:
            alt = src.with_suffix(".webp")
            if alt.exists():
                shutil.copy2(alt, dst); copied += 1
            else:
                missing += 1
        if copied % 2000 == 0 and copied > 0:
            print(f"  Copied: {copied}...")
    print(f"  Done: {copied} copied, {skipped} skipped, {missing} missing")

    # Generate updated meta.json
    print("\nGenerating meta.json...")
    meta = {
        "format": "简中标准环境 F/G/H/I 标",
        "currentMarks": ["F", "G", "H", "I"],
        "retiredMarks": ["A", "B", "C", "D", "E"],
        "description": "简中 PTCG 当前标准赛制为 F/G/H/I 标。数据来源：tcg.mik.moe",
        "markSeries": {
            "F": "SV1-SV3", "G": "SV4-SV5", "H": "SV6-SV7", "I": "SV8-SV9"
        },
        "basicEnergy": {
            "description": "基本能量卡ID速查表",
            "cards": [{"name": c["card_name"], "id": c["card_key"]}
                      for c in cards if c["card_type"] == "Basic Energy"]
        }
    }
    with (PTCG / "data" / "meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("\n=== Build Complete ===")

if __name__ == "__main__":
    main()
