// 临时验证：房间列表无变化时应停止广播；history limit 边界应被夹紧
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as ioClient } from 'socket.io-client';
import { createRealtimeApp } from '../src/realtime-app.js';
import { RoomStore } from '../src/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = new RoomStore(join(mkdtempSync(join(tmpdir(), 'poker-bcast-')), 'v.sqlite'));
const { server, close } = createRealtimeApp({ store });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
let listCount = 0;
socket.on('rooms:list', () => { listCount += 1; });
await new Promise((r) => socket.on('connect', r));
await sleep(500);
const afterConnect = listCount;
console.log(`连接后收到的 rooms:list: ${afterConnect} 次（首次快照，符合预期）`);

// 建一个房间 → 列表内容变化，应广播 1 次
socket.emit('room:create', { playerName: 'A', gameType: 'texas' }, () => {});
await sleep(1200);
const afterCreate = listCount;
console.log(`创建房间后累计: ${afterCreate} 次（应 +1~2）`);

// 静默 6 秒：无变化，不应再广播
await sleep(6000);
const afterIdle = listCount;
console.log(`静默 6s 后累计: ${afterIdle} 次 → 空闲期新增 ${afterIdle - afterCreate} 次（期望 0，改造前约 12 次）`);

// history 接口边界
const roomCode = await new Promise((resolve) => {
  socket.emit('room:create', { playerName: 'B', gameType: 'texas' }, (res) => resolve(res?.roomCode));
});
for (const q of ['12', '99999999', 'abc', '-5', '']) {
  const r = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomCode}/history?limit=${encodeURIComponent(q)}`);
  const body = await r.json().catch(() => null);
  console.log(`limit=${q || '(空)'} → HTTP ${r.status}, history=${Array.isArray(body?.history) ? body.history.length : 'N/A'}`);
}

socket.close();
await close();
console.log(afterIdle - afterCreate === 0 ? '\n✅ 空闲期零广播，验证通过' : '\n❌ 空闲期仍在广播');
