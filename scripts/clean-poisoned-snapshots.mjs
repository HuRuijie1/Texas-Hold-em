// 一次性迁移：剥离数据库快照里的 __storeRef 等内部引用，回收磁盘空间。
// 保留房间本身的状态（玩家、筹码、房间配置），只删除污染字段。
// 必须先停掉服务器再运行！
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法: node scripts/clean-poisoned-snapshots.mjs <poker.sqlite 路径>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

const poisoned = db.prepare("SELECT room_code, snapshot FROM rooms WHERE snapshot LIKE '%\\_\\_storeRef%' ESCAPE '\\'").all()
  .concat(db.prepare("SELECT room_code, snapshot FROM rooms WHERE snapshot LIKE '%__storeRef%' AND snapshot NOT LIKE '%\\_\\_storeRef%' ESCAPE '\\'").all());
const seen = new Set();
let freedBytes = 0;

for (const row of poisoned) {
  if (seen.has(row.room_code)) continue;
  seen.add(row.room_code);
  const before = row.snapshot.length;
  if (before > 400_000_000) {
    console.warn(`房间 ${row.room_code} 快照 ${(before / 1048576).toFixed(1)}MB 过大，直接解析有内存风险，跳过（建议删除该行）`);
    continue;
  }
  const parsed = JSON.parse(row.snapshot);
  let removed = [];
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('__')) {
      delete parsed[key];
      removed.push(key);
    }
  }
  if (!removed.length) {
    console.log(`房间 ${row.room_code}: 快照含 __storeRef 但顶层无 __ 字段，按原样保留`);
    continue;
  }
  const cleaned = JSON.stringify(parsed);
  db.prepare('UPDATE rooms SET snapshot = ? WHERE room_code = ?').run(cleaned, row.room_code);
  freedBytes += before - cleaned.length;
  console.log(`房间 ${row.room_code}: ${(before / 1048576).toFixed(1)}MB → ${(cleaned.length / 1024).toFixed(1)}KB（移除: ${removed.join(', ')}）`);
}

db.exec('VACUUM');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const after = db.prepare('SELECT COUNT(*) AS n FROM rooms').get();
console.log(`完成: 处理 ${seen.size} 个房间，释放约 ${(freedBytes / 1048576).toFixed(1)}MB，剩余房间数 ${after.n}`);
db.close();
