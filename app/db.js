const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'jobs.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate();
  }
  return db;
}

function migrate() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      playlist_name TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      track_count INTEGER,
      downloaded INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
  `);
  // Add include_groups column if missing (migration)
  const cols = d.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  if (!cols.includes('include_groups')) {
    d.exec("ALTER TABLE jobs ADD COLUMN include_groups TEXT");
  }
}

function createJob(url, playlistName, includeGroups) {
  const d = getDb();
  const stmt = d.prepare(
    'INSERT INTO jobs (url, playlist_name, status, include_groups) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(url, playlistName || null, 'queued', includeGroups || null);
  return getJob(result.lastInsertRowid);
}

function getJob(id) {
  const d = getDb();
  return d.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function listJobs(limit = 50, offset = 0) {
  const d = getDb();
  return d
    .prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

function updateJob(id, fields) {
  const d = getDb();
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  d.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...values, id);
  return getJob(id);
}

function deleteJob(id) {
  const d = getDb();
  d.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function getNextQueued() {
  const d = getDb();
  return d
    .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
    .get();
}

function hasRunning() {
  const d = getDb();
  const row = d
    .prepare("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'downloading'")
    .get();
  return row.cnt > 0;
}

module.exports = {
  getDb,
  createJob,
  getJob,
  listJobs,
  updateJob,
  deleteJob,
  getNextQueued,
  hasRunning,
};
