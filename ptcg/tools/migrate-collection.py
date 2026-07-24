"""
ptcg/tools/migrate-collection.py
将旧版导出文件中的数字 ID 映射为新的 card_key。
"""
import json
import sys
from pathlib import Path

PTCG = Path(__file__).resolve().parents[1]

def main():
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <collection-export.json>")
        sys.exit(1)

    export_path = Path(sys.argv[1])
    if not export_path.exists():
        print(f"File not found: {export_path}")
        sys.exit(1)

    # Load mapping
    map_path = PTCG / "tools" / "id_mapping.json"
    with map_path.open("r", encoding="utf-8") as f:
        mapping = json.load(f)

    # Load export
    with export_path.open("r", encoding="utf-8") as f:
        export = json.load(f)

    print(f"Migrating: {export_path.name}")
    print(f"  Cards in export: {export['metadata']['totalCards']}")
    print(f"  Decks: {export['metadata']['totalDecks']}")

    # Migrate cards
    new_cards = {}
    total_mapped = 0
    total_dropped = 0
    total_qty_mapped = 0
    total_qty_dropped = 0
    dropped_details = []

    for card_type, card_list in export["cards"].items():
        # Use dict to aggregate quantities when multiple old IDs → same new card_key
        new_dict = {}
        for c in card_list:
            old_id = c["id"]
            qty = c["quantity"]
            if old_id in mapping:
                new_key = mapping[old_id]["new_key"]
                new_dict[new_key] = new_dict.get(new_key, 0) + qty
                total_qty_mapped += qty
            else:
                total_dropped += 1
                total_qty_dropped += qty
                dropped_details.append({"old_id": old_id, "type": card_type, "quantity": qty})

        if new_dict:
            new_cards[card_type] = [{"id": k, "quantity": v} for k, v in new_dict.items()]
            total_mapped += len(new_dict)

    print(f"\n  Cards mapped: {total_mapped} ({total_qty_mapped} pcs)")
    print(f"  Cards dropped: {total_dropped} ({total_qty_dropped} pcs)")

    # Migrate decks
    new_decks = []
    for deck in export.get("decks", []):
        new_deck_dict = {}  # aggregate quantities
        deck_dropped = 0
        for c in deck["cards"]:
            old_id = c["id"]
            if old_id in mapping:
                new_key = mapping[old_id]["new_key"]
                new_deck_dict[new_key] = new_deck_dict.get(new_key, 0) + c["quantity"]
            else:
                deck_dropped += 1

        if new_deck_dict:
            new_deck_cards = [{"id": k, "quantity": v} for k, v in new_deck_dict.items()]
            new_count = sum(c["quantity"] for c in new_deck_cards)
            new_decks.append({
                "name": deck["name"],
                "totalCount": new_count,
                "cards": new_deck_cards
            })
            if deck_dropped:
                print(f"  Deck '{deck['name']}': dropped {deck_dropped} cards, now {new_count}/60")

    # Write output
    out = {
        "version": "2.0",
        "exportTime": export.get("exportTime", ""),
        "metadata": {
            "totalCards": total_mapped,
            "totalDecks": len(new_decks),
            "appVersion": "2.0",
            "note": "Migrated to Simplified Chinese card_keys. Dropped cards are from retired marks A-E."
        },
        "cards": new_cards,
        "decks": new_decks,
        "dropped": {
            "totalCards": total_dropped,
            "totalQuantity": total_qty_dropped,
            "details": dropped_details[:50]  # first 50 for reference
        }
    }

    out_path = export_path.parent / f"{export_path.stem}-cn.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n  Output: {out_path}")

    # Also dump mapping summary
    methods = {}
    for v in mapping.values():
        methods[v["method"]] = methods.get(v["method"], 0) + 1
    print(f"\n  Mapping methods: {methods}")


if __name__ == "__main__":
    main()
