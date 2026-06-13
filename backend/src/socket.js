import crypto from "crypto";
import { Server } from "socket.io";
import { db, nowIso, addEvent } from "./db.js";
import { checkAgentToken } from "./auth.js";
import {
  getRoom,
  getRtpCapabilities,
  createWebRtcTransport,
  connectTransport,
  produce,
  listProducers,
  consume,
  resumeConsumer,
  closeRoom
} from "./sfu.js";

const disconnectTimers = new Map();

function ackWrap(fn) {
  return async (...args) => {
    const ack = typeof args.at(-1) === "function" ? args.pop() : () => {};
    try {
      ack({ ok: true, data: await fn(...args) });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: error.message || "Unexpected server error." });
    }
  };
}

function sessionSnapshot(sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  const participants = db.prepare("SELECT * FROM participants WHERE session_id = ? ORDER BY joined_at").all(sessionId);
  return { session, participants };
}

function validateJoin({ sessionId, role, token }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session || session.status === "ended") throw new Error("Session is not available.");
  if (role === "agent") {
    if (!checkAgentToken(token)) throw new Error("Agent access denied.");
  } else if (role === "customer") {
    if (session.invite_token !== token) throw new Error("Invalid invite token.");
  } else {
    throw new Error("Unsupported role.");
  }
  return session;
}

export function attachSocket(server, corsOrigin) {
  const io = new Server(server, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] }
  });

  io.on("connection", socket => {
    socket.on("session:join", ackWrap(async payload => {
      const session = validateJoin(payload);
      await getRoom(session.id);
      const now = nowIso();
      const name = String(payload.name || payload.role).slice(0, 60);
      const existing = db.prepare(
        "SELECT * FROM participants WHERE session_id = ? AND role = ? AND name = ? AND left_at IS NULL ORDER BY joined_at DESC"
      ).get(session.id, payload.role, name);
      const participantId = existing?.id || crypto.randomUUID();
      if (disconnectTimers.has(participantId)) {
        clearTimeout(disconnectTimers.get(participantId));
        disconnectTimers.delete(participantId);
        addEvent(session.id, participantId, "reconnected", `${name} reconnected within grace window`);
      }
      if (existing) {
        db.prepare("UPDATE participants SET socket_id = ?, connected = 1, last_seen_at = ? WHERE id = ?")
          .run(socket.id, now, participantId);
      } else {
        db.prepare(
          "INSERT INTO participants (id, session_id, role, name, socket_id, connected, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
        ).run(participantId, session.id, payload.role, name, socket.id, now, now);
        addEvent(session.id, participantId, "joined", `${name} joined as ${payload.role}`);
      }

      socket.data = { sessionId: session.id, participantId, role: payload.role, name };
      socket.join(session.id);
      io.to(session.id).emit("session:state", sessionSnapshot(session.id));
      socket.emit("producer:list", listProducers(session.id, participantId));
      return { participantId, rtpCapabilities: getRtpCapabilities(session.id), state: sessionSnapshot(session.id) };
    }));

    socket.on("transport:create", ackWrap(async ({ direction }) => {
      const { sessionId, participantId } = socket.data;
      if (!sessionId) throw new Error("Join a session first.");
      return createWebRtcTransport(sessionId, participantId, direction);
    }));

    socket.on("transport:connect", ackWrap(async ({ transportId, dtlsParameters }) => {
      await connectTransport(socket.data.sessionId, transportId, dtlsParameters);
      return true;
    }));

    socket.on("producer:create", ackWrap(async ({ transportId, kind, rtpParameters }) => {
      const producer = await produce(socket.data.sessionId, transportId, socket.data.participantId, kind, rtpParameters);
      socket.to(socket.data.sessionId).emit("producer:new", producer);
      return producer;
    }));

    socket.on("producer:list", ackWrap(async () => listProducers(socket.data.sessionId, socket.data.participantId)));

    socket.on("consumer:create", ackWrap(async ({ transportId, producerId, rtpCapabilities }) => {
      return consume(socket.data.sessionId, transportId, producerId, socket.data.participantId, rtpCapabilities);
    }));

    socket.on("consumer:resume", ackWrap(async ({ consumerId }) => {
      await resumeConsumer(socket.data.sessionId, consumerId);
      return true;
    }));

    socket.on("chat:send", ackWrap(async ({ body }) => {
      if (!socket.data.sessionId) throw new Error("Join a session first.");
      const clean = String(body || "").trim().slice(0, 2000);
      if (!clean) throw new Error("Message cannot be empty.");
      const createdAt = nowIso();
      const result = db.prepare(
        "INSERT INTO messages (session_id, participant_id, role, name, body, kind, created_at) VALUES (?, ?, ?, ?, ?, 'text', ?)"
      ).run(socket.data.sessionId, socket.data.participantId, socket.data.role, socket.data.name, clean, createdAt);
      const message = { id: result.lastInsertRowid, session_id: socket.data.sessionId, role: socket.data.role, name: socket.data.name, body: clean, kind: "text", created_at: createdAt };
      io.to(socket.data.sessionId).emit("chat:message", message);
      return message;
    }));

    socket.on("recording:set", ackWrap(async ({ status }) => {
      if (socket.data.role !== "agent") throw new Error("Only agents can control recording.");
      const allowed = new Set(["idle", "in_progress", "processing", "ready"]);
      if (!allowed.has(status)) throw new Error("Invalid recording status.");
      db.prepare("UPDATE sessions SET recording_status = ? WHERE id = ?").run(status, socket.data.sessionId);
      addEvent(socket.data.sessionId, socket.data.participantId, "recording", `Recording status: ${status}`);
      io.to(socket.data.sessionId).emit("recording:status", status);
      return status;
    }));

    socket.on("session:end", ackWrap(async () => {
      if (socket.data.role !== "agent") throw new Error("Only agents can end the whole session.");
      const endedAt = nowIso();
      db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(endedAt, socket.data.sessionId);
      db.prepare("UPDATE participants SET connected = 0, left_at = COALESCE(left_at, ?), last_seen_at = ? WHERE session_id = ?")
        .run(endedAt, endedAt, socket.data.sessionId);
      addEvent(socket.data.sessionId, socket.data.participantId, "ended", "Agent ended the session");
      io.to(socket.data.sessionId).emit("session:ended");
      closeRoom(socket.data.sessionId);
      return true;
    }));

    socket.on("disconnect", () => {
      const { sessionId, participantId, name } = socket.data || {};
      if (!sessionId || !participantId) return;
      db.prepare("UPDATE participants SET connected = 0, last_seen_at = ? WHERE id = ?").run(nowIso(), participantId);
      const timer = setTimeout(() => {
        const leftAt = nowIso();
        db.prepare("UPDATE participants SET left_at = COALESCE(left_at, ?), last_seen_at = ? WHERE id = ?").run(leftAt, leftAt, participantId);
        addEvent(sessionId, participantId, "left", `${name} left or did not reconnect`);
        io.to(sessionId).emit("session:state", sessionSnapshot(sessionId));
        disconnectTimers.delete(participantId);
      }, 15000);
      disconnectTimers.set(participantId, timer);
      io.to(sessionId).emit("session:state", sessionSnapshot(sessionId));
    });
  });

  return io;
}
