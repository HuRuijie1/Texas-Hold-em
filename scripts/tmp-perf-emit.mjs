// 临时探针：量化 emit / 落库 / 序列化 / tick 的微观成本
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameManager, DEFAULT_CONFIG } from '../src/game-engine.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from '../src/gdy-engine.js';
import { RoomStore } from '../src/store.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'poker-emit-')), 'perf.sqlite');
const store = new RoomStore(dbPath);

const stats = { stringifyMs: [], saveMs: [], serializeMs: [], viewBytes: [] };
let emitCount = 0;

const manager = new GameManager(store, {
  config: DEFAULT_CONFIG,
  onUpdate(room) {
    emitCount += 1;
    // 模拟真实广播：9 个在线玩家各构造一份视图
    const t2 = process.hrtime.bigint();
    let bytes = 0;
    for (const p of room.players) {
      const view = manager.getRoomView(room.code, p.token);
      bytes += JSON.stringify(view).length;
    }
    stats.serializeMs.push(Number(process.hrtime.bigint() - t2) / 1e6);
    stats.viewBytes.push(bytes);
  },
});

function measure(label, fn) {
  const t = process.hrtime.bigint();
  const out = fn();
  return { label, ms: Number(process.hrtime.bigint() - t) / 1e6, out };
}

// ===== 1. 单房间：满座 9 人 =====
const { room } = manager.createRoom({ token: 'host', roomName: '压测桌' });
for (let i = 0; i < 8; i += 1) {
  manager.joinRoom(room.code, { token: `bot${i}`, playerName: `机器人${i}` });
}
for (const p of room.players) {
  manager.seatPlayer(room.code, p.token, room.players.indexOf(p));
  room.players[room.players.indexOf(p)].isBot = true;
  room.players[room.players.indexOf(p)].botLevel = 'pro';
}
manager.startHand(room.code, 'host');

const snap = JSON.stringify(room);
console.log(`房间快照: ${(snap.length / 1024).toFixed(1)} KB，玩家数 ${room.players.length}`);

// 落库 200 次
{
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) store.saveRoom(room);
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`saveRoom x200: 总 ${total.toFixed(1)}ms，单次均值 ${(total / 200).toFixed(3)}ms`);
}
// stringify 200 次
{
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) JSON.stringify(room);
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`JSON.stringify x200: 总 ${total.toFixed(1)}ms，单次均值 ${(total / 200).toFixed(3)}ms`);
}
// 序列化 9 份视图 x200
{
  const t = process.hrtime.bigint();
  let bytes = 0;
  for (let i = 0; i < 200; i += 1) {
    for (const p of room.players) bytes += JSON.stringify(manager.getRoomView(room.code, p.token)).length;
  }
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`getRoomView x9 x200: 总 ${total.toFixed(1)}ms，单次(9份) ${(total / 200).toFixed(3)}ms，单份均值包体 ${(bytes / 1800 / 1024).toFixed(1)} KB`);
}

// ===== 2. 多房间：tick 遍历成本 =====
const gdy = new GdyManager(store, { config: GDY_DEFAULT_CONFIG });
const roomCodes = [room.code];
for (let i = 0; i < 300; i += 1) {
  const r = gdy.createRoom({ token: `h${i}`, roomName: `压测${i}` });
  roomCodes.push(r.room.code);
}
console.log(`\n构造房间总数: ${gdy.rooms.size} (干瞪眼) + ${manager.rooms.size} (德州)`);
{
  const t = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) gdy.tick(Date.now());
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`tick x50 (${gdy.rooms.size} 房间): 总 ${total.toFixed(1)}ms，单次 ${(total / 50).toFixed(3)}ms`);
}
{
  const t = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) gdy.listRooms();
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`listRooms x50 (${gdy.rooms.size} 房间): 总 ${total.toFixed(1)}ms，单次 ${(total / 50).toFixed(3)}ms`);
}
{
  const t = process.hrtime.bigint();
  let bytes = 0;
  for (let i = 0; i < 50; i += 1) bytes += JSON.stringify({ rooms: gdy.listRooms() }).length;
  const total = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`rooms:list 广播包: ${(bytes / 50 / 1024).toFixed(1)} KB，序列化单次 ${(total / 50).toFixed(3)}ms`);
}

// ===== 3. 启动加载成本 =====
{
  const t = process.hrtime.bigint();
  const s2 = new RoomStore(dbPath);
  const reloaded = s2.listRooms();
  const loadMs = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`\n启动 listRooms+parse: ${reloaded.length} 个房间，${loadMs.toFixed(1)}ms（三个引擎各加载一次 → x3）`);
  s2.close();
}

console.log(`\nemit 调用次数: ${emitCount}`);
store.close();
