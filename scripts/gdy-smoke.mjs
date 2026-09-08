// 干瞪眼端到端冒烟：三游戏并存服务内创建干瞪眼房、加入、开局、出牌、观察视角
import { io } from 'socket.io-client';
import { createRealtimeApp } from '../src/realtime-app.js';

class MemoryStore {
  constructor() { this.rooms = new Map(); this.history = new Map(); }
  saveRoom(room) { this.rooms.set(room.code, structuredClone(room)); }
  listRooms() { return [...this.rooms.values()].map((room) => structuredClone(room)); }
  saveHandHistory(code, _n, summary) { if (!this.history.has(code)) this.history.set(code, []); this.history.get(code).push(structuredClone(summary)); }
  listHandHistory(code) { return [...(this.history.get(code) || [])]; }
  deleteRoom(code) { this.rooms.delete(code); }
  close() {}
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack ${event} 超时`)), 5000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

const app = createRealtimeApp({ store: new MemoryStore() });
await new Promise((resolve) => app.server.listen(0, resolve));
const port = app.server.address().port;
const url = `http://127.0.0.1:${port}`;

const connect = () => {
  const socket = io(url, { transports: ['websocket'], autoConnect: false });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    socket.connect();
  });
};

try {
  const alice = await connect();
  const bob = await connect();

  const created = await emit(alice, 'room:create', { gameType: 'gdy', playerName: '甲', roomName: '冒烟桌', config: { maxSeats: 5 } });
  if (!created.ok) throw new Error('创建失败: ' + created.error);
  console.log('创建房间 OK:', created.roomCode, 'gameType =', created.room.gameType);

  const joined = await emit(bob, 'room:join', { roomCode: created.roomCode, playerName: '乙' });
  if (!joined.ok) throw new Error('加入失败: ' + joined.error);
  await emit(bob, 'room:sit', { roomCode: created.roomCode, seatIndex: 1 });
  await emit(alice, 'room:ready', { roomCode: created.roomCode });
  // 全员准备后自动开局，用乙的视角取最新房间状态
  const started = await emit(bob, 'room:ready', { roomCode: created.roomCode });
  if (!started.ok) throw new Error('开局失败: ' + started.error);

  const list = await emit(alice, 'rooms:list', {});
  console.log('大厅列表:', list.rooms.map((room) => `${room.gameType}:${room.code}`).join(', '));

  const dealer = started.room.players.find((player) => player.seatIndex === started.room.dealerSeat);
  console.log('开局 OK，庄家:', dealer.name, '牌数:', dealer.holeCards.length, '倍率:', started.room.hand.multiplier, '甲手牌:', started.room.players.find((p) => p.name === '甲')?.holeCards.length, '张');

  const me = started.room.players.find((player) => player.isViewer);
  if (started.room.hand.availableActions && me.holeCards.length >= 1) {
    const played = await emit(bob, 'room:action', { roomCode: created.roomCode, action: { type: 'play', cards: [me.holeCards[0]] } });
    console.log(played.ok ? '出牌: 成功' : `出牌: 失败 ${played.error}`);
  } else {
    console.log('当前轮到甲，乙等待');
  }

  const bobView = await emit(bob, 'room:action', { roomCode: created.roomCode, action: { type: 'pass' } });
  console.log('乙跟牌过:', bobView.ok ? '成功' : `失败 ${bobView.error}`);

  const state = await emit(bob, 'rooms:list', {});
  if (!state.ok) throw new Error('rooms:list 失败');
  const hist = await fetch(`${url}/api/rooms/${created.roomCode}/history`);
  console.log('历史接口:', hist.ok ? 'OK' : `FAIL ${hist.status}`);

  alice.disconnect();
  bob.disconnect();
  console.log('冒烟验证完成 ✔');
} finally {
  await app.close();
}
