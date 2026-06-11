// js/data/decks.js — 测试卡组数据
export const TEST_DECKS = [
  {
    id: "1769875572212",
    name: "光辉喷火龙",
    coverCardId: "7970",
    cards: [
      { id: "7970", quantity: 1 },
      { id: "7202", quantity: 4 },
      { id: "9974", quantity: 3 },
      { id: "12770", quantity: 4 },
      { id: "6853", quantity: 1 },
      { id: "10024", quantity: 4 },
      { id: "1577", quantity: 4 },
      { id: "4809", quantity: 4 },
      { id: "10018", quantity: 3 },
      { id: "10930", quantity: 1 },
      { id: "10083", quantity: 3 },
      { id: "3976", quantity: 4 },
      { id: "6966", quantity: 4 },
      { id: "6965", quantity: 4 },
      { id: "8728", quantity: 3 },
      { id: "7034", quantity: 2 },
      { id: "6250", quantity: 3 },
      { id: "6782", quantity: 8 }
    ],
    totalCount: 60
  },
  {
    id: "1769487112371",
    name: "骨纹巨声鳄",
    coverCardId: "9811",
    cards: [
      { id: "7245", quantity: 1 },
      { id: "10046", quantity: 1 },
      { id: "7654", quantity: 1 },
      { id: "6639", quantity: 1 },
      { id: "9539", quantity: 1 },
      { id: "6824", quantity: 1 },
      { id: "9875", quantity: 1 },
      { id: "10658", quantity: 3 },
      { id: "10659", quantity: 1 },
      { id: "9811", quantity: 3 },
      { id: "10882", quantity: 1 },
      { id: "10883", quantity: 1 },
      { id: "11778", quantity: 1 },
      { id: "12770", quantity: 3 },
      { id: "6853", quantity: 1 },
      { id: "1587", quantity: 2 },
      { id: "11181", quantity: 2 },
      { id: "1577", quantity: 4 },
      { id: "3979", quantity: 3 },
      { id: "4809", quantity: 4 },
      { id: "10018", quantity: 2 },
      { id: "10860", quantity: 1 },
      { id: "3978", quantity: 3 },
      { id: "7035", quantity: 3 },
      { id: "9024", quantity: 1 },
      { id: "11176", quantity: 1 },
      { id: "9618", quantity: 2 },
      { id: "8659", quantity: 1 },
      { id: "6782", quantity: 10 }
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
