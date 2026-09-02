import assert from 'node:assert/strict';
import test from 'node:test';
import { io as createClient } from 'socket.io-client';
import { createRealtimeApp } from '../src/realtime-app.js';

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

  close() {}
}

function connectClient(port, token = '') {
  const client = createClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    autoConnect: false,
  });

  const connected = new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  const sessionToken = new Promise((resolve) => {
    client.once('session:token', ({ token: issuedToken }) => resolve(issuedToken));
  });

  client.connect();

  return Promise.all([connected, sessionToken]).then(([, issuedToken]) => ({ client, token: issuedToken }));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (result) => resolve(result));
  });
}

async function startServer() {
  const store = new MemoryStore();
  const runtime = createRealtimeApp({ store });
  await new Promise((resolve) => runtime.server.listen(0, resolve));
  const { port } = runtime.server.address();
  return { runtime, port };
}

test('socket flow can create, join, seat and start a hand', async () => {
  const { runtime, port } = await startServer();
  const host = await connectClient(port);
  const guest = await connectClient(port);

  try {
    const created = await emitAck(host.client, 'room:create', {
      token: host.token,
      roomName: 'Integration',
      playerName: 'Alice',
      config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
    });
    assert.equal(created.ok, true);

    const joined = await emitAck(guest.client, 'room:join', {
      roomCode: created.roomCode,
      token: guest.token,
      playerName: 'Bob',
    });
    assert.equal(joined.ok, true);

    assert.equal((await emitAck(host.client, 'room:sit', {
      roomCode: created.roomCode,
      token: created.token,
      seatIndex: 0,
    })).ok, true);

    assert.equal((await emitAck(guest.client, 'room:sit', {
      roomCode: created.roomCode,
      token: joined.token,
      seatIndex: 1,
    })).ok, true);

    const hostReady = await emitAck(host.client, 'room:ready', {
      roomCode: created.roomCode,
      token: created.token,
    });
    assert.equal(hostReady.ok, true);
    assert.equal(hostReady.room.summary.handStatus, 'idle');
    assert.equal(hostReady.room.self.ready, true);

    const started = await emitAck(guest.client, 'room:ready', {
      roomCode: created.roomCode,
      token: joined.token,
    });
    assert.equal(started.ok, true);
    assert.equal(started.room.hand.status, 'running');
    assert.equal(started.room.hand.pot, 15);
    assert.equal(started.room.hand.actionSeat, 0);
  } finally {
    host.client.disconnect();
    guest.client.disconnect();
    await runtime.close();
  }
});

test('session can resume after disconnect', async () => {
  const { runtime, port } = await startServer();
  const host = await connectClient(port);
  const guest = await connectClient(port);

  try {
    const created = await emitAck(host.client, 'room:create', {
      token: host.token,
      roomName: 'Reconnect',
      playerName: 'Alice',
      config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
    });
    assert.equal(created.ok, true);

    const joined = await emitAck(guest.client, 'room:join', {
      roomCode: created.roomCode,
      token: guest.token,
      playerName: 'Bob',
    });
    assert.equal(joined.ok, true);

    await emitAck(host.client, 'room:sit', {
      roomCode: created.roomCode,
      token: created.token,
      seatIndex: 0,
    });
    await emitAck(guest.client, 'room:sit', {
      roomCode: created.roomCode,
      token: joined.token,
      seatIndex: 1,
    });
    await emitAck(host.client, 'room:ready', {
      roomCode: created.roomCode,
      token: created.token,
    });
    await emitAck(guest.client, 'room:ready', {
      roomCode: created.roomCode,
      token: joined.token,
    });

    guest.client.disconnect();

    const resumed = await emitAck(host.client, 'session:resume', {
      roomCode: created.roomCode,
      token: joined.token,
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.room.summary.handStatus, 'running');
    assert.equal(resumed.room.players.some((player) => player.isViewer && player.connected), true);
  } finally {
    host.client.disconnect();
    guest.client.disconnect();
    await runtime.close();
  }
});

test('host can kick a guest, notify the guest, and allow the token to rejoin', async () => {
  const { runtime, port } = await startServer();
  const host = await connectClient(port);
  const guest = await connectClient(port);

  try {
    const created = await emitAck(host.client, 'room:create', {
      token: host.token,
      roomName: 'Kick flow',
      playerName: 'Alice',
      config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
    });
    assert.equal(created.ok, true);

    const joined = await emitAck(guest.client, 'room:join', {
      roomCode: created.roomCode,
      token: guest.token,
      playerName: 'Bob',
    });
    assert.equal(joined.ok, true);

    const kicked = new Promise((resolve) => guest.client.once('room:kicked', resolve));
    const result = await emitAck(host.client, 'room:player:kick', {
      roomCode: created.roomCode,
      token: created.token,
      targetToken: joined.token,
    });

    assert.equal(result.ok, true);
    assert.equal(result.room.players.some((player) => player.name === 'Bob'), false);
    assert.deepEqual(await kicked, {
      roomCode: created.roomCode,
      reason: '你已被房主移出房间',
    });

    const rejoined = await emitAck(guest.client, 'room:join', {
      roomCode: created.roomCode,
      token: guest.token,
      playerName: 'Bob Rejoined',
    });
    assert.equal(rejoined.ok, true);
    assert.equal(rejoined.token, guest.token);
    assert.equal(rejoined.room.players.some((player) => player.name === 'Bob Rejoined'), true);
  } finally {
    host.client.disconnect();
    guest.client.disconnect();
    await runtime.close();
  }
});

test('non-host cannot kick members and kicking is blocked during a hand', async () => {
  const { runtime, port } = await startServer();
  const host = await connectClient(port);
  const guest = await connectClient(port);

  try {
    const created = await emitAck(host.client, 'room:create', {
      token: host.token,
      roomName: 'Kick permissions',
      playerName: 'Alice',
      config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
    });
    const joined = await emitAck(guest.client, 'room:join', {
      roomCode: created.roomCode,
      token: guest.token,
      playerName: 'Bob',
    });

    const nonHostResult = await emitAck(guest.client, 'room:player:kick', {
      roomCode: created.roomCode,
      token: joined.token,
      targetToken: created.token,
    });
    assert.equal(nonHostResult.ok, false);

    assert.equal((await emitAck(guest.client, 'room:sit', {
      roomCode: created.roomCode,
      token: joined.token,
      seatIndex: 1,
    })).ok, true);
    assert.equal((await emitAck(host.client, 'room:ready', {
      roomCode: created.roomCode,
      token: created.token,
    })).ok, true);
    assert.equal((await emitAck(guest.client, 'room:ready', {
      roomCode: created.roomCode,
      token: joined.token,
    })).ok, true);

    const runningResult = await emitAck(host.client, 'room:player:kick', {
      roomCode: created.roomCode,
      token: created.token,
      targetToken: joined.token,
    });
    assert.equal(runningResult.ok, false);
    assert.match(runningResult.error, /对局进行中不能踢人/);
  } finally {
    host.client.disconnect();
    guest.client.disconnect();
    await runtime.close();
  }
});
