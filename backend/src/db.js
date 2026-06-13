import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "atomquest.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  invite_token TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  recording_status TEXT NOT NULL DEFAULT 'idle',
  recording_file TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  socket_id TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  left_at TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  participant_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  participant_id TEXT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  file_url TEXT,
  file_name TEXT,
  file_type TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
`);

export function nowIso() {
  return new Date().toISOString();
}

export function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    inviteToken: row.invite_token,
    title: row.title,
    status: row.status,
    recordingStatus: row.recording_status,
    recordingFile: row.recording_file,
    createdAt: row.created_at,
    endedAt: row.ended_at
  };
}

export function addEvent(sessionId, participantId, type, detail = "") {
  db.prepare(
    "INSERT INTO events (session_id, participant_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(sessionId, participantId || null, type, detail, nowIso());
}

export function getSessionHistory(sessionId) {
  const session = rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
  if (!session) return null;
  const participants = db.prepare("SELECT * FROM participants WHERE session_id = ? ORDER BY joined_at").all(sessionId);
  const events = db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY created_at").all(sessionId);
  const messages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId);
  return { session, participants, events, messages };
}
