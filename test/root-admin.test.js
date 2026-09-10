import assert from 'node:assert/strict';
import test from 'node:test';
import { io as createClient } from 'socket.io-client';
import { createRealtimeApp } from '../src/realtime-app.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from '../src/gdy-engine.js';
import { GameManager } from '../src/game-engine.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.history = new Map();
  }

  saveRoom(room) {
    this.rooms.set(room.code, structuredClone(room));
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  saveHandHistory(code, _handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push(structuredClone(summary));
  }

  listHandHistory(code) {
    return [...(this.history.get(code) || [])];
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  close() {}
}

async function startServer(store) {
  const app = createRealtimeApp({ store });
  await new Promise((resolve) => app.server.listen(0, resolve));
  return app;
}

test('root 接口：密钥错误 403，正确返回全部房间', async () => {
  const app = await startServer(new MemoryStore());
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    app.manager.createRoom({ token: 't1', playerName: '甲' });
    app.zjhManager.createRoom({ token: 't1', playerName: '甲' });
    app.gdyManager.createRoom({ token: 't1', playerName: '甲' });

    const denied = await fetch(`${base}/api/root/rooms?key=wrong`);
    assert.equal(denied.status, 403);

    const ok = await fetch(`${base}/api/root/rooms?key=${app.rootKey}`);
    assert.equal(ok.status, 200);
    const data = await ok.json();
    const types = new Set(data.rooms.map((room) => room.gameType));
    assert.deepEqual([...types].sort(), ['gdy', 'texas', 'zjh']);
  } finally {
    await app.close();
  }
});

test('root 强删：空闲房间与对局进行中的房间都能删，玩家收到通知', async () => {
  const app = await startServer(new MemoryStore());
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    // 干瞪眼房间打到"进行中"
    const gdyCreated = app.gdyManager.createRoom({ token: 'ta', playerName: '甲' }, );
    const gdyCode = gdyCreated.room.code;
    app.gdyManager.joinRoom(gdyCode, { token: 'tb', playerName: '乙' });
    app.gdyManager.seatPlayer(gdyCode, 'tb', 1);
    app.gdyManager.toggleReady(gdyCode, 'ta');
    app.gdyManager.toggleReady(gdyCode, 'tb');
    assert.equal(app.gdyManager.getRoom(gdyCode).hand.status, 'running');

    // 玩家甲通过 socket 加入房间（进入 socketMap），监听 room:closed
    const player = createClient(base, { transports: ['websocket'], autoConnect: false, auth: { token: 'ta' } });
    const closedEvent = new Promise((resolve) => {
      player.once('room:closed', resolve);
    });
    await new Promise((resolve, reject) => {
      player.once('connect', resolve);
      player.once('connect_error', reject);
      player.connect();
    });
    await new Promise((resolve) => player.emit('room:join', { roomCode: gdyCode, token: 'ta', playerName: '甲' }, resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const denied = await fetch(`${base}/api/root/rooms/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nope', code: gdyCode }),
    });
    assert.equal(denied.status, 403);

    const removed = await fetch(`${base}/api/root/rooms/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: app.rootKey, code: gdyCode }),
    });
    assert.equal(removed.status, 200);
    const data = await removed.json();
    assert.equal(data.code, gdyCode);

    assert.equal(app.gdyManager.getRoom(gdyCode), null);
    const event = await Promise.race([closedEvent, new Promise((_, rej) => setTimeout(() => rej(new Error('未收到 room:closed')), 2000))]);
    assert.equal(event.reason, 'admin_removed');
    assert.equal(event.roomCode, gdyCode);

    // 房间不存在 → 404
    const missing = await fetch(`${base}/api/root/rooms/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: app.rootKey, code: gdyCode }),
    });
    assert.equal(missing.status, 404);

    player.disconnect();
  } finally {
    await app.close();
  }
});

test('德州引擎不再误恢复干瞪眼快照', () => {
  const store = new MemoryStore();
  const gdyManager = new GdyManager(store, { config: GDY_DEFAULT_CONFIG });
  const created = gdyManager.createRoom({ token: 't1', playerName: '甲' });
  const code = created.room.code;

  const manager = new GameManager(store, {});
  assert.ok(gdyManager.getRoom(code), '干瞪眼引擎应有该房间');
  assert.equal(manager.getRoom(code), null, '德州引擎不应误恢复干瞪眼房间');
});

test('cleanOldRooms 强化：无人在线且超时的进行中房间也会被清理并通知', async () => {
  const app = await startServer(new MemoryStore());
  try {
    const created = app.gdyManager.createRoom({ token: 'ta', playerName: '甲' });
    const code = created.room.code;
    app.gdyManager.joinRoom(code, { token: 'tb', playerName: '乙' });
    app.gdyManager.seatPlayer(code, 'tb', 1);
    app.gdyManager.toggleReady(code, 'ta');
    app.gdyManager.toggleReady(code, 'tb');
    const room = app.gdyManager.getRoom(code);
    assert.equal(room.hand.status, 'running');

    // 全员离线 + 最后活跃时间拨到 31 分钟前
    for (const player of room.players) {
      player.connected = false;
      player.disconnectedAt = Date.now() - 31 * 60 * 1000;
    }
    room.updatedAt = Date.now() - 31 * 60 * 1000;

    app.gdyManager.tick();
    assert.equal(app.gdyManager.getRoom(code), null, '僵尸房间应被清理');
  } finally {
    await app.close();
  }
});
