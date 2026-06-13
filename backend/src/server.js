import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { db, nowIso, rowToSession, getSessionHistory, addEvent } from "./db.js";
import { createAgentToken, requireAgent, checkAgentToken } from "./auth.js";
import { initSfu, closeRoom } from "./sfu.js";
import { attachSocket } from "./socket.js";

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 4000);
const corsOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadDir));

app.get("/health", (_req, res) => res.json({ ok: true, service: "atomquest-video-support" }));

app.post("/api/agent/login", (req, res) => {
  if (req.body?.passcode !== (process.env.AGENT_PASSCODE || "atomberg-agent")) {
    return res.status(401).json({ error: "Wrong passcode." });
  }
  res.json({ token: createAgentToken() });
});

app.post("/api/sessions", requireAgent, (req, res) => {
  const id = crypto.randomUUID();
  const inviteToken = crypto.randomBytes(18).toString("hex");
  const title = String(req.body?.title || "Video support call").slice(0, 90);
  const createdAt = nowIso();
  db.prepare(
    "INSERT INTO sessions (id, invite_token, title, status, created_at) VALUES (?, ?, ?, 'active', ?)"
  ).run(id, inviteToken, title, createdAt);
  addEvent(id, null, "created", "Agent created the support session");
  res.status(201).json({
    session: rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)),
    inviteUrl: `${corsOrigin}/?session=${id}&token=${inviteToken}`
  });
});

app.get("/api/sessions", requireAgent, (_req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all().map(rowToSession);
  res.json({ sessions });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  const auth = req.headers.authorization || "";
  const isAgent = auth.startsWith("Bearer ") && checkAgentToken(auth.slice(7));
  const isCustomer = req.query.token && req.query.token === session.invite_token;
  if (!isAgent && !isCustomer) return res.status(401).json({ error: "Valid invite required." });
  res.json({ history: getSessionHistory(req.params.id) });
});

app.post("/api/sessions/:id/end", requireAgent, (req, res) => {
  const endedAt = nowIso();
  db.prepare("UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(endedAt, req.params.id);
  db.prepare("UPDATE participants SET connected = 0, left_at = COALESCE(left_at, ?), last_seen_at = ? WHERE session_id = ?")
    .run(endedAt, endedAt, req.params.id);
  addEvent(req.params.id, null, "force_ended", "Admin ended the session");
  app.locals.io?.to(req.params.id).emit("session:ended");
  closeRoom(req.params.id);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/files", upload.single("file"), (req, res) => {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  const auth = req.headers.authorization || "";
  const isAgent = auth.startsWith("Bearer ") && checkAgentToken(auth.slice(7));
  const isCustomer = req.body?.token === session.invite_token;
  if (!isAgent && !isCustomer) return res.status(401).json({ error: "Valid invite required." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const safeName = req.file.originalname.replace(/[^\w.\- ]/g, "_");
  const finalName = `${Date.now()}-${safeName}`;
  fs.renameSync(req.file.path, path.join(uploadDir, finalName));
  const fileUrl = `/uploads/${finalName}`;
  const name = String(req.body.name || "Participant").slice(0, 60);
  const role = String(req.body.role || "customer").slice(0, 20);
  const createdAt = nowIso();
  const result = db.prepare(
    "INSERT INTO messages (session_id, participant_id, role, name, body, kind, file_url, file_name, file_type, created_at) VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?)"
  ).run(req.params.id, null, role, name, `Shared ${safeName}`, fileUrl, safeName, req.file.mimetype, createdAt);
  const message = { id: result.lastInsertRowid, session_id: req.params.id, role, name, body: `Shared ${safeName}`, kind: "file", file_url: fileUrl, file_name: safeName, file_type: req.file.mimetype, created_at: createdAt };
  app.locals.io?.to(req.params.id).emit("chat:message", message);
  res.status(201).json({ message });
});

app.post("/api/sessions/:id/recording", requireAgent, upload.single("recording"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No recording uploaded." });
  const finalName = `${Date.now()}-recording.webm`;
  fs.renameSync(req.file.path, path.join(uploadDir, finalName));
  const fileUrl = `/uploads/${finalName}`;
  db.prepare("UPDATE sessions SET recording_status = 'ready', recording_file = ? WHERE id = ?").run(fileUrl, req.params.id);
  addEvent(req.params.id, null, "recording_ready", "Recording file uploaded");
  app.locals.io?.to(req.params.id).emit("recording:status", "ready");
  res.status(201).json({ fileUrl });
});

app.get("/metrics", (_req, res) => {
  const activeSessions = db.prepare("SELECT COUNT(*) count FROM sessions WHERE status = 'active'").get().count;
  const connected = db.prepare("SELECT COUNT(*) count FROM participants WHERE connected = 1").get().count;
  const totalMessages = db.prepare("SELECT COUNT(*) count FROM messages").get().count;
  res.type("text/plain").send([
    "# HELP atomquest_active_sessions Active support sessions",
    "# TYPE atomquest_active_sessions gauge",
    `atomquest_active_sessions ${activeSessions}`,
    "# HELP atomquest_connected_participants Connected participants",
    "# TYPE atomquest_connected_participants gauge",
    `atomquest_connected_participants ${connected}`,
    "# HELP atomquest_total_messages Persisted chat messages",
    "# TYPE atomquest_total_messages counter",
    `atomquest_total_messages ${totalMessages}`
  ].join("\n"));
});

await initSfu();
app.locals.io = attachSocket(server, corsOrigin);
server.listen(port, () => {
  console.log(`AtomQuest backend listening on http://localhost:${port}`);
});
