// 检查数据库中被 __storeRef 等内部引用污染的房间快照
// 用法: node scripts/inspect-poisoned-rooms.mjs <poker.sqlite 路径>
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法: node scripts/inspect-poisoned-rooms.mjs <poker.sqlite 路径>');
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db.prepare('SELECT room_code, length(snapshot) AS size, updated_at FROM rooms ORDER BY size DESC').all();
console.log('全部房间行:');
for (const row of rows) {
  console.log(`  ${row.room_code}  ${(row.size / 1024).toFixed(1)}KB  updated=${new Date(row.updated_at).toISOString()}`);
}

const poisoned = db.prepare("SELECT room_code, length(snapshot) AS size FROM rooms WHERE snapshot LIKE '%__storeRef%'").all();
console.log('被污染行(__storeRef):');
for (const row of poisoned) {
  console.log(`  ${row.room_code}  ${(row.size / 1048576).toFixed(1)}MB`);
}
db.close();
