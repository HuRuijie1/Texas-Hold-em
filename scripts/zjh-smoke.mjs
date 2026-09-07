// 双游戏端到端冒烟：炸金花 + 德州在同一服务内并存
import { io } from 'socket.io-client';
import { createRealtimeApp } from '../src/realtime-app.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
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

const app = await createRealtimeApp();
await new Promise((resolve) => app.server.listen(0, resolve));
const port = app.server.address().port;
const url = `http://127.0.0.1:${port}`;

try {
  const client = io(url, { transports: ['websocket'] });
  await once(client, 'connect');

  // 1. 创建炸金花房间并添加机器人
  const created = await emit(client, 'room:create', {
    gameType: 'zjh',
    playerName: '冒烟玩家',
    roomName: '冒烟炸金花桌',
    config: { maxSeats: 4, ante: 5, baseStake: 5, startingStack: 500, actionTimeoutMs: 30000 },
  });
  if (!created.ok) throw new Error(`创建炸金花房间失败: ${created.error}`);
  const zjhCode = created.roomCode;
  console.log(`[OK] 创建炸金花房间 ${zjhCode} (gameType=${created.room.gameType})`);

  const botAdded = await emit(client, 'room:bot:add', { roomCode: zjhCode, level: 'beginner' });
  if (!botAdded.ok) throw new Error(`添加机器人失败: ${botAdded.error}`);
  console.log('[OK] 添加炸金花机器人');

  // 2. 开局并执行 看牌 → 跟注 → 弃牌
  const started = await emit(client, 'room:start', { roomCode: zjhCode });
  if (!started.ok) throw new Error(`开局失败: ${started.error}`);
  console.log(`[OK] 开局 handNo=${started.room.hand.id} pot=${started.room.hand.pot}`);
  if (started.room.gameType !== 'zjh') throw new Error('游戏类型标记丢失');

  let state = started.room;
  const self = () => state.players.find((player) => player.isViewer);
  for (let step = 0; step < 80 && state.hand.status === 'running'; step += 1) {
    const actions = state.hand.availableActions;
    if (actions) {
      const action = actions.canLook
        ? { type: 'look' }
        : (actions.canCall ? { type: 'call' } : { type: 'fold' });
      const result = await emit(client, 'room:action', { roomCode: zjhCode, action });
      if (!result.ok) throw new Error(`行动失败: ${result.error}`);
      state = result.room;
    } else {
      // 轮到 AI：等待下一次状态广播
      state = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(state), 2500);
        client.once('room:state', (room) => {
          clearTimeout(timer);
          resolve(room);
        });
      });
    }
  }
  if (state.hand.status !== 'finished') throw new Error('冒烟对局未能在预算内结束');
  console.log(`[OK] 炸金花对局打完，状态=${state.hand.status}，我的筹码=${self().stack}`);

  // 3. 结算炸金花房间
  const settled = await emit(client, 'room:settle', { roomCode: zjhCode });
  if (!settled.ok) throw new Error(`结算失败: ${settled.error}`);
  console.log(`[OK] 结算炸金花房间，参与者 ${settled.settlements.length} 人`);

  // 4. 创建德州房间验证共存
  const texasCreated = await emit(client, 'room:create', {
    gameType: 'texas',
    playerName: '冒烟玩家',
    roomName: '冒烟德州桌',
    config: { smallBlind: 5, bigBlind: 10, startingStack: 500, actionTimeoutMs: 30000 },
  });
  if (!texasCreated.ok) throw new Error(`创建德州房间失败: ${texasCreated.error}`);
  if (texasCreated.room.gameType !== 'texas') throw new Error('德州游戏类型标记丢失');
  console.log(`[OK] 创建德州房间 ${texasCreated.roomCode} (gameType=${texasCreated.room.gameType})`);

  const rooms = await emit(client, 'rooms:list');
  const gameTypes = rooms.rooms.map((room) => room.gameType);
  if (!gameTypes.includes('texas')) throw new Error('房间列表缺少德州房间');
  console.log(`[OK] 大厅房间列表 gameType 分布: ${gameTypes.join(', ')}`);

  // 5. REST 接口路由
  const res = await fetch(`${url}/api/rooms`);
  const data = await res.json();
  if (!data.rooms.some((room) => room.gameType === 'texas')) throw new Error('REST 房间列表缺少德州');
  console.log(`[OK] REST /api/rooms 返回 ${data.rooms.length} 个房间`);

  client.close();
  console.log('\n=== 双游戏冒烟全部通过 ===');
} finally {
  await app.close();
  process.exit(0);
}
