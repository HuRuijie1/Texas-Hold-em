import assert from 'node:assert/strict';
import test from 'node:test';
import { GameManager, hydrateRoom } from '../src/game-engine.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.history = new Map();
  }

  saveRoom(room) {
    this.rooms.set(room.code, structuredClone(room));
  }

  loadRoom() {
    return null;
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  cleanOldRooms() {}

  saveHandHistory(code, handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push({ handNo, summary });
  }

  listHandHistory(code) {
    return (this.history.get(code) || []).map((entry) => structuredClone(entry.summary));
  }
}

function createTable() {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({ token: 'a', roomName: 'Test', playerName: 'Alice', config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 } });
  manager.joinRoom(created.room.code, { token: 'b', playerName: 'Bob' });
  manager.seatPlayer(created.room.code, 'a', 0);
  manager.seatPlayer(created.room.code, 'b', 1);
  return { manager, store, code: created.room.code };
}

function readyTable(manager, code) {
  const room = manager.getRoom(code);
  for (const player of room.players.filter((candidate) => candidate.seatIndex !== null && !candidate.isBot && candidate.stack > 0 && !candidate.sitOut)) {
    manager.toggleReady(code, player.token);
  }
}

function foldWinTable() {
  const { manager, store, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  const folder = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, folder.token, { type: 'fold' });
  const winnerToken = folder.token === 'a' ? 'b' : 'a';
  return { manager, store, code, winnerToken, folderToken: folder.token };
}

function foldShowdownTable() {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({ token: 'a', roomName: 'Test', playerName: 'Alice', config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 } });
  const code = created.room.code;
  manager.joinRoom(code, { token: 'b', playerName: 'Bob' });
  manager.joinRoom(code, { token: 'c', playerName: 'Carol' });
  manager.seatPlayer(code, 'a', 0);
  manager.seatPlayer(code, 'b', 1);
  manager.seatPlayer(code, 'c', 2);
  for (const player of manager.getRoom(code).players) manager.toggleReady(code, player.token);

  const room = manager.getRoom(code);
  const folder = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, folder.token, { type: 'fold' });

  // 剩余两人强制全下，进入摊牌
  for (const player of manager.getRoom(code).players) {
    if (player.folded) continue;
    player.stack = 0;
    player.allIn = true;
    player.inHand = true;
    player.streetContribution = 100;
    player.handContribution = 100;
  }
  manager.getRoom(code).hand.actionQueue = [];
  manager.resolveHand(manager.getRoom(code));

  const liveCards = new Map(manager.getRoom(code).players.map((player) => [player.seatIndex, [...player.holeCards]]));
  return { manager, code, folderToken: folder.token, folderSeat: folder.seatIndex, liveCards };
}

test('fold-win creates showOffer visible only to the human winner', () => {
  const { manager, code, winnerToken, folderToken } = foldWinTable();

  const winnerView = manager.getRoomView(code, winnerToken).hand;
  assert.equal(winnerView.status, 'finished');
  assert.equal(winnerView.revealed, false);
  assert.equal(winnerView.showOffer?.token, winnerToken);
  assert.equal(winnerView.shownCards, null);

  const folderView = manager.getRoomView(code, folderToken).hand;
  assert.equal(folderView.showOffer, null);
  assert.equal(folderView.shownCards, null);
});

test('showing both cards reveals them to every viewer', () => {
  const { manager, code, winnerToken, folderToken } = foldWinTable();
  const realCards = manager.getRoom(code).players.find((p) => p.token === winnerToken).holeCards;

  manager.showCards(code, winnerToken, { showCount: 2 });

  for (const viewer of [winnerToken, folderToken]) {
    const hand = manager.getRoomView(code, viewer).hand;
    assert.deepEqual(hand.shownCards.cards, realCards);
    assert.deepEqual(hand.winners[0].holeCards, realCards);
  }
  const winnerSeat = manager.getRoomView(code, folderToken).players
    .find((p) => p.seatIndex === manager.getRoomView(code, folderToken).hand.shownCards.seatIndex);
  assert.deepEqual(winnerSeat.holeCards, realCards);
});

test('showing one card reveals only the chosen card', () => {
  const { manager, code, winnerToken } = foldWinTable();
  const realCards = manager.getRoom(code).players.find((p) => p.token === winnerToken).holeCards;

  manager.showCards(code, winnerToken, { showCount: 1, side: 0 });
  assert.deepEqual(manager.getRoomView(code, winnerToken).hand.shownCards.cards, [realCards[0]]);

  const { manager: manager2, code: code2, winnerToken: winner2 } = foldWinTable();
  const realCards2 = manager2.getRoom(code2).players.find((p) => p.token === winner2).holeCards;
  manager2.showCards(code2, winner2, { showCount: 1, side: 1 });
  assert.deepEqual(manager2.getRoomView(code2, winner2).hand.shownCards.cards, [realCards2[1]]);
});

test('non-winner cannot show cards', () => {
  const { manager, code, folderToken } = foldWinTable();
  assert.throws(() => manager.showCards(code, folderToken, { showCount: 2 }), /只有弃牌获胜者可以秀牌/);
});

test('double show is rejected', () => {
  const { manager, code, winnerToken } = foldWinTable();
  manager.showCards(code, winnerToken, { showCount: 2 });
  assert.throws(() => manager.showCards(code, winnerToken, { showCount: 2 }), /已经秀过牌了/);
});

test('folded cards stay hidden from other viewers at showdown', () => {
  const { manager, code, folderToken, folderSeat, liveCards } = foldShowdownTable();
  assert.equal(manager.getRoom(code).hand.revealed, true);

  for (const viewer of ['a', 'b', 'c']) {
    const view = manager.getRoomView(code, viewer);
    const folderView = view.players.find((player) => player.seatIndex === folderSeat);
    assert.equal(folderView.folded, true);
    if (viewer === folderToken) {
      assert.deepEqual(folderView.holeCards, liveCards.get(folderSeat));
    } else {
      assert.deepEqual(folderView.holeCards, ['??', '??']);
    }
    assert.equal(folderView.handLabel, null);
  }
});

test('live showdown hands are revealed to every viewer', () => {
  const { manager, code, liveCards } = foldShowdownTable();
  for (const viewer of ['a', 'b', 'c']) {
    const view = manager.getRoomView(code, viewer);
    for (const player of view.players) {
      if (player.folded) continue;
      assert.deepEqual(player.holeCards, liveCards.get(player.seatIndex));
    }
  }
});

test('invalid show side is rejected', () => {
  const { manager, code, winnerToken } = foldWinTable();
  assert.throws(() => manager.showCards(code, winnerToken, { showCount: 1, side: 2 }), /秀牌面无效/);
  assert.throws(() => manager.showCards(code, winnerToken, { showCount: 1, side: null }), /秀牌面无效/);
  assert.throws(() => manager.showCards(code, winnerToken, { showCount: 1, side: '1' }), /秀牌面无效/);

  const realCards = manager.getRoom(code).players.find((p) => p.token === winnerToken).holeCards;
  manager.showCards(code, winnerToken, { showCount: 1, side: 1 });
  assert.deepEqual(manager.getRoomView(code, winnerToken).hand.shownCards.cards, [realCards[1]]);
});

test('showdown hands cannot use fold-win show', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  room.players.forEach((player) => {
    player.stack = 0;
    player.allIn = true;
    player.inHand = true;
    player.streetContribution = 100;
    player.handContribution = 100;
    player.holeCards = ['AS', 'AD'];
  });
  room.hand.board = ['KS', 'QS', 'JS', 'TS', '9D'];
  room.hand.actionQueue = [];
  manager.resolveHand(room);
  assert.equal(manager.getRoom(code).hand.revealed, true);
  assert.throws(() => manager.showCards(code, 'a', { showCount: 2 }), /摊牌局无需秀牌/);
});

test('bot fold-winners get no showOffer', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  room.players.forEach((player) => {
    player.isBot = true;
    player.botLevel = 'beginner';
  });
  const folder = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, folder.token, { type: 'fold' });
  const hand = manager.getRoom(code).hand;
  assert.equal(hand.status, 'finished');
  assert.equal(hand.showOffer, null);
});

test('starting the next hand clears showOffer and shownCards', () => {
  const { manager, code, winnerToken } = foldWinTable();
  manager.showCards(code, winnerToken, { showCount: 2 });
  for (const player of manager.getRoom(code).players) {
    if (player.seatIndex !== null && player.stack > 0) player.ready = true;
  }
  manager.startHand(code, winnerToken);
  const hand = manager.getRoom(code).hand;
  assert.equal(hand.status, 'running');
  assert.equal(hand.showOffer, null);
  assert.equal(hand.shownCards, null);
});

test('showOffer and shownCards survive room snapshot round-trip', () => {
  const { manager, code, winnerToken } = foldWinTable();
  manager.showCards(code, winnerToken, { showCount: 1, side: 0 });
  const snapshot = structuredClone(manager.getRoom(code));
  const restored = hydrateRoom(snapshot);
  assert.deepEqual(restored.hand.shownCards.cards, snapshot.hand.shownCards.cards);
  assert.deepEqual(restored.hand.showOffer, snapshot.hand.showOffer);
});
