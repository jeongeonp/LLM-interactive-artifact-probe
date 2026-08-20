// Logging layer. Single flat `events` table so every activity (chat turns and
// interaction telemetry) is one row — this maps 1:1 onto a Firebase collection.
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "probe.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    TEXT NOT NULL,   -- server ISO timestamp
    pid   TEXT,            -- participant id
    cond  TEXT,            -- condition: interactive | static
    task  TEXT,            -- task: practice | sd | relocation
    kind  TEXT,            -- 'chat' | 'artifact' | 'telemetry'
    type  TEXT,            -- chat: 'turn'; telemetry: click/input/scroll/heartbeat/...
    data  TEXT             -- JSON blob
  );
  CREATE INDEX IF NOT EXISTS idx_events_pid ON events(pid);
  CREATE TABLE IF NOT EXISTS scenarios (
    task    TEXT PRIMARY KEY,  -- practice | sd | relocation
    text    TEXT,              -- researcher-edited instruction shown to participants
    updated TEXT
  );
`);
try { db.exec("ALTER TABLE events ADD COLUMN task TEXT"); } catch { /* column already exists */ }

const insertStmt = db.prepare(
  "INSERT INTO events (ts, pid, cond, task, kind, type, data) VALUES (?, ?, ?, ?, ?, ?, ?)"
);

export function logEvent({ pid, cond, task, kind, type, data }) {
  insertStmt.run(
    new Date().toISOString(),
    pid ?? null,
    cond ?? null,
    task ?? null,
    kind ?? null,
    type ?? null,
    data == null ? null : JSON.stringify(data)
  );
}

// Events for a session — narrow by pid, then optionally cond and task.
export function allEvents(pid, cond, task) {
  const hasCond = cond != null && cond !== "";
  const hasTask = task != null && task !== "";
  if (pid && hasCond && hasTask)
    return db.prepare("SELECT * FROM events WHERE pid = ? AND cond IS ? AND task IS ? ORDER BY id").all(pid, cond, task);
  if (pid && hasCond)
    return db.prepare("SELECT * FROM events WHERE pid = ? AND cond IS ? ORDER BY id").all(pid, cond);
  if (pid) return db.prepare("SELECT * FROM events WHERE pid = ? ORDER BY id").all(pid);
  return db.prepare("SELECT * FROM events ORDER BY id").all();
}

export function countAllArtifacts() {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact'").get().n;
}

export function artifactEvents(pid, cond, task) {
  return allEvents(pid, cond, task).filter((r) => r.kind === "artifact");
}

export function summary() {
  return db
    .prepare(
      `SELECT pid, cond, task,
              COUNT(*)                       AS events,
              SUM(kind = 'chat')             AS chat_turns,
              SUM(kind = 'artifact')         AS artifacts,
              SUM(kind = 'telemetry')        AS interactions,
              MIN(ts) AS first_ts, MAX(ts)   AS last_ts
       FROM events
       GROUP BY pid, cond, task
       ORDER BY pid`
    )
    .all();
}

// Next per-session (pid+cond+task) artifact number (1-based).
export function countArtifacts(pid, cond, task) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'artifact' AND pid IS ? AND cond IS ? AND task IS ?")
    .get(pid ?? null, cond ?? null, task ?? null).n;
}

// Researcher-editable task instruction (overrides the built-in default when set).
export function getScenario(task) {
  const r = db.prepare("SELECT text FROM scenarios WHERE task = ?").get(String(task ?? ""));
  return r ? r.text : null;
}
export function setScenario(task, text) {
  db.prepare(
    `INSERT INTO scenarios (task, text, updated) VALUES (?, ?, ?)
     ON CONFLICT(task) DO UPDATE SET text = excluded.text, updated = excluded.updated`
  ).run(String(task ?? ""), text, new Date().toISOString());
}
