import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class RoomStore {
  constructor(filePath = join(process.cwd(), 'data', 'poker.sqlite')) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS rooms (
        room_code TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hand_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL,
        hand_no INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hand_history_room ON hand_history(room_code, id DESC);
    `);
    this.saveStmt = this.db.prepare(`
      INSERT INTO rooms (room_code, snapshot, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(room_code) DO UPDATE SET
        snapshot = excluded.snapshot,
        updated_at = excluded.updated_at
    `);
    this.getStmt = this.db.prepare('SELECT snapshot FROM rooms WHERE room_code = ?');
    this.listStmt = this.db.prepare('SELECT snapshot FROM rooms ORDER BY updated_at DESC');
    this.deleteStmt = this.db.prepare('DELETE FROM rooms WHERE room_code = ?');
    this.historyInsertStmt = this.db.prepare(`
      INSERT INTO hand_history (room_code, hand_no, summary, created_at)
      VALUES (?, ?, ?, ?)
    `);
    this.historyListStmt = this.db.prepare(`
      SELECT summary FROM hand_history
      WHERE room_code = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this.deleteOldRoomsStmt = this.db.prepare('DELETE FROM rooms WHERE updated_at < ?');
  }

  saveRoom(room) {
    const now = Date.now();
    this.saveStmt.run(room.code, JSON.stringify(room), now);
  }

  loadRoom(code) {
    const row = this.getStmt.get(code);
    return row ? JSON.parse(row.snapshot) : null;
  }

  listRooms() {
    return this.listStmt.all().map((row) => JSON.parse(row.snapshot));
  }

  deleteRoom(code) {
    this.deleteStmt.run(code);
  }

  saveHandHistory(roomCode, handNo, summary) {
    this.historyInsertStmt.run(roomCode, handNo, JSON.stringify(summary), Date.now());
  }

  listHandHistory(roomCode, limit = 10) {
    return this.historyListStmt.all(roomCode, limit).map((row) => JSON.parse(row.summary));
  }

  cleanOldRooms(cutoffTime) {
    this.deleteOldRoomsStmt.run(cutoffTime);
  }

  close() {
    this.db.close();
  }
}
