// 单独处理超大污染快照：加大堆内存解析、剥离 __ 字段、写回并回收空间
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const roomCode = process.argv[3];
const db = new DatabaseSync(dbPath);

const row = db.prepare('SELECT snapshot FROM rooms WHERE room_code = ?').get(roomCode);
if (!row) {
  console.log(`房间 ${roomCode} 不存在`);
  process.exit(0);
}

console.log(`原始大小: ${(row.snapshot.length / 1048576).toFixed(1)}MB，开始解析...`);
const parsed = JSON.parse(row.snapshot);
const removed = [];
for (const key of Object.keys(parsed)) {
  if (key.startsWith('__')) {
    delete parsed[key];
    removed.push(key);
  }
}
const cleaned = JSON.stringify(parsed);
db.prepare('UPDATE rooms SET snapshot = ? WHERE room_code = ?').run(cleaned, roomCode);
console.log(`房间 ${roomCode}: ${(row.snapshot.length / 1048576).toFixed(1)}MB → ${(cleaned.length / 1024).toFixed(1)}KB（移除: ${removed.join(', ') || '无'}）`);
console.log(`房间概要: gameType=${parsed.gameType} 玩家数=${parsed.players?.length ?? 0} handNo=${parsed.handNo ?? '?'}`);

db.exec('VACUUM');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log('VACUUM 完成');
