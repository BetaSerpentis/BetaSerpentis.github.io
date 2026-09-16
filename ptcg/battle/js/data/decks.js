// js/data/decks.js — 测试卡组数据（已同步 ptcg 新 set-code ID）
export const TEST_DECKS = [
  {
    id: "1769875572212",
    name: "光辉喷火龙",
    coverCardId: "CSVE1pC-013",
    cards: [
      { id: "CSVE1pC-013", quantity: 1 },
      { id: "CS5.5C-008", quantity: 4 },
      { id: "CSVH3C-006", quantity: 3 },
      { id: "CS1DC-196", quantity: 4 },
      { id: "CSVE1C-154", quantity: 1 },
      { id: "CSVH3C-060", quantity: 4 },
      { id: "CS1DC-178", quantity: 4 },
      { id: "CBB3C-1902", quantity: 4 },
      { id: "CSVH4C-034", quantity: 3 },
      { id: "CSVM2aC-021", quantity: 1 },
      { id: "CSM1DC-236", quantity: 3 },
      { id: "CBB1C-1703", quantity: 4 },
      { id: "CSVE1C-116", quantity: 4 },
      { id: "CS5DC-116", quantity: 4 },
      { id: "CBB3C-1901", quantity: 3 },
      { id: "CSVE1C-120", quantity: 2 },
      { id: "CS5DC-152", quantity: 3 },
      { id: "CBB1C-1802", quantity: 8 }
    ],
    totalCount: 60
  },
  {
    id: "1769487112371",
    name: "骨纹巨声鳄",
    coverCardId: "CSV6C-099",
    cards: [
      { id: "CS5aC-092", quantity: 1 },
      { id: "CSV6C-044", quantity: 1 },
      { id: "CS4DaC-271", quantity: 1 },
      { id: "CS4DaC-272", quantity: 1 },
      { id: "CSV4C-024", quantity: 1 },
      { id: "CSVE2C-067", quantity: 1 },
      { id: "CSV5C-070", quantity: 1 },
      { id: "CBB1C-0306", quantity: 3 },
      { id: "CBB1C-0401", quantity: 1 },
      { id: "CSV6C-099", quantity: 3 },
      { id: "CSV7C-030", quantity: 1 },
      { id: "CSV7C-031", quantity: 1 },
      { id: "CSVM2aC-006", quantity: 1 },
      { id: "CS1DC-196", quantity: 3 },
      { id: "CSVE1C-154", quantity: 1 },
      { id: "CS1DC-200", quantity: 2 },
      { id: "CSVH4C-049", quantity: 2 },
      { id: "CS1DC-178", quantity: 4 },
      { id: "CBB3C-1903", quantity: 3 },
      { id: "CBB3C-1902", quantity: 4 },
      { id: "CSVH4C-034", quantity: 2 },
      { id: "CSVM1aC-013", quantity: 1 },
      { id: "CS1DC-176", quantity: 3 },
      { id: "CS5aC-118", quantity: 3 },
      { id: "CSV3C-119", quantity: 1 },
      { id: "CSV7C-186", quantity: 1 },
      { id: "CSVM1aC-031", quantity: 2 },
      { id: "CSVE2C-200", quantity: 1 },
      { id: "CBB1C-1802", quantity: 10 }
    ],
    totalCount: 60
  }
];

export function expandDeck(deck) {
  const result = [];
  for (const card of deck.cards) {
    for (let i = 0; i < card.quantity; i++) {
      result.push(card.id);
    }
  }
  return result;
}
