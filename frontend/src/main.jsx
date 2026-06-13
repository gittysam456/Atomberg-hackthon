import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";
import { Copy, LogIn, Mic, MicOff, Phone, PhoneOff, Radio, Send, Shield, Upload, Video, VideoOff } from "lucide-react";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

function callSocket(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, response => {
      if (response?.ok) resolve(response.data);
      else reject(new Error(response?.error || "Socket request failed."));
    });
  });
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function App() {
  const params = new URLSearchParams(location.search);
  const invite = params.get("session") && params.get("token")
    ? { sessionId: params.get("session"), token: params.get("token") }
    : null;
  const [agentToken, setAgentToken] = useState(localStorage.getItem("agentToken") || "");
  const [activeCall, setActiveCall] = useState(invite ? { role: "customer", ...invite } : null);

  if (activeCall) {
    return <CallRoom call={activeCall} agentToken={agentToken} onExit={() => setActiveCall(null)} />;
  }

  return <Home agentToken={agentToken} setAgentToken={setAgentToken} startCall={setActiveCall} />;
}

function Home({ agentToken, setAgentToken, startCall }) {
  const [passcode, setPasscode] = useState("");
  const [title, setTitle] = useState("Kitchen fan installation support");
  const [sessions, setSessions] = useState([]);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");

  async function login(e) {
    e.preventDefault();
    setError("");
    try {
      const data = await api("/api/agent/login", { method: "POST", body: JSON.stringify({ passcode }) });
      localStorage.setItem("agentToken", data.token);
      setAgentToken(data.token);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createSession() {
    setError("");
    try {
      const data = await api("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ title })
      });
      await navigator.clipboard?.writeText(data.inviteUrl);
      startCall({ role: "agent", sessionId: data.session.id, token: agentToken, inviteUrl: data.inviteUrl });
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadSessions() {
    if (!agentToken) return;
    const data = await api("/api/sessions", { headers: { Authorization: `Bearer ${agentToken}` } });
    setSessions(data.sessions);
  }

  async function viewHistory(sessionId) {
    setError("");
    try {
      const data = await api(`/api/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${agentToken}` } });
      setHistory(data.history);
    } catch (err) {
      setError(err.message);
    }
  }

  async function forceEnd(sessionId) {
    setError("");
    try {
      await api(`/api/sessions/${sessionId}/end`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({})
      });
      await loadSessions();
      await viewHistory(sessionId);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadSessions().catch(() => {});
  }, [agentToken]);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">AtomQuest support console</p>
          <h1>Video help when the agent needs to see the problem.</h1>
          <p className="lead">Create a private support room, invite the customer, talk on routed video, share files, and keep the session record for review.</p>
        </div>
        <div className="statusPill"><Radio size={16} /> SFU routed media</div>
      </section>

      <section className="grid">
        <div className="panel">
          <h2><Shield size={20} /> Agent desk</h2>
          {!agentToken ? (
            <form onSubmit={login} className="stack">
              <label>Passcode</label>
              <input value={passcode} onChange={e => setPasscode(e.target.value)} placeholder="atomberg-agent" type="password" />
              <button><LogIn size={18} /> Login as agent</button>
            </form>
          ) : (
            <div className="stack">
              <label>Session title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} />
              <button onClick={createSession}><Phone size={18} /> Create support session</button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="panel">
          <h2>Operations dashboard</h2>
          <button className="secondary" onClick={loadSessions} disabled={!agentToken}>Refresh sessions</button>
          <div className="sessionList">
            {sessions.map(session => (
              <article key={session.id} className="sessionRow">
                <div>
                  <strong>{session.title}</strong>
                  <span>{session.status} · {new Date(session.createdAt).toLocaleString()}</span>
                </div>
                <div className="rowActions">
                  <button className="secondary" onClick={() => viewHistory(session.id)}>History</button>
                  {session.status === "active" && <button className="secondary" onClick={() => startCall({ role: "agent", sessionId: session.id, token: agentToken })}>Open</button>}
                  {session.status === "active" && <button className="danger" onClick={() => forceEnd(session.id)}>End</button>}
                </div>
              </article>
            ))}
            {!sessions.length && <p className="muted">Login to view live and past sessions.</p>}
          </div>
          {history && (
            <div className="historyBox">
              <h2>Session record</h2>
              <p><strong>{history.session.title}</strong></p>
              <p className="muted">{history.session.status} · recording {history.session.recordingStatus}</p>
              <h3>Participants</h3>
              {history.participants.map(person => (
                <p key={person.id} className="auditLine">{person.name} · {person.role} · joined {new Date(person.joined_at).toLocaleTimeString()}</p>
              ))}
              <h3>Event log</h3>
              {history.events.map(event => (
                <p key={event.id} className="auditLine">{new Date(event.created_at).toLocaleTimeString()} · {event.type} · {event.detail}</p>
              ))}
              <h3>Messages</h3>
              {history.messages.map(message => (
                <p key={message.id} className="auditLine">{message.name}: {message.file_name || message.body}</p>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function CallRoom({ call, agentToken, onExit }) {
  const [socket, setSocket] = useState(null);
  const [state, setState] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState("idle");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [inviteUrl, setInviteUrl] = useState(call.inviteUrl || "");
  const localVideo = useRef(null);
  const remoteVideo = useRef(null);
  const localStream = useRef(null);
  const remoteStream = useRef(new MediaStream());
  const device = useRef(null);
  const producerTransport = useRef(null);
  const consumerTransport = useRef(null);
  const mediaRecorder = useRef(null);
  const recordedChunks = useRef([]);

  const displayName = useMemo(() => call.role === "agent" ? "Support Agent" : "Customer", [call.role]);

  useEffect(() => {
    let live = true;
    const s = io(API, { transports: ["websocket"] });
    setSocket(s);

    async function boot() {
      try {
        localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (localVideo.current) localVideo.current.srcObject = localStream.current;

        const join = await callSocket(s, "session:join", {
          sessionId: call.sessionId,
          token: call.role === "agent" ? agentToken : call.token,
          role: call.role,
          name: displayName
        });
        if (!live) return;
        setState(join.state);
        setRecording(join.state.session.recording_status || "idle");

        device.current = new Device();
        await device.current.load({ routerRtpCapabilities: join.rtpCapabilities });
        await createSendTransport(s);
        await createRecvTransport(s);
        for (const producer of await callSocket(s, "producer:list")) await consumeProducer(s, producer.producerId);
      } catch (err) {
        setError(err.message);
      }
    }

    s.on("session:state", setState);
    s.on("session:ended", () => {
      setError("The session has ended.");
      cleanupMedia();
    });
    s.on("recording:status", setRecording);
    s.on("chat:message", msg => setMessages(prev => [...prev, msg]));
    s.on("producer:new", producer => consumeProducer(s, producer.id).catch(err => setError(err.message)));

    boot();
    loadHistory();
    return () => {
      live = false;
      s.disconnect();
      cleanupMedia();
    };
  }, []);

  async function createSendTransport(s) {
    const params = await callSocket(s, "transport:create", { direction: "send" });
    producerTransport.current = device.current.createSendTransport(params);
    producerTransport.current.on("connect", ({ dtlsParameters }, cb, eb) => {
      callSocket(s, "transport:connect", { transportId: params.id, dtlsParameters }).then(cb).catch(eb);
    });
    producerTransport.current.on("produce", ({ kind, rtpParameters }, cb, eb) => {
      callSocket(s, "producer:create", { transportId: params.id, kind, rtpParameters }).then(({ id }) => cb({ id })).catch(eb);
    });
    for (const track of localStream.current.getTracks()) {
      await producerTransport.current.produce({ track });
    }
  }

  async function createRecvTransport(s) {
    const params = await callSocket(s, "transport:create", { direction: "recv" });
    consumerTransport.current = device.current.createRecvTransport(params);
    consumerTransport.current.on("connect", ({ dtlsParameters }, cb, eb) => {
      callSocket(s, "transport:connect", { transportId: params.id, dtlsParameters }).then(cb).catch(eb);
    });
  }

  async function consumeProducer(s, producerId) {
    if (!consumerTransport.current || !device.current) return;
    const data = await callSocket(s, "consumer:create", {
      transportId: consumerTransport.current.id,
      producerId,
      rtpCapabilities: device.current.rtpCapabilities
    });
    const consumer = await consumerTransport.current.consume(data);
    remoteStream.current.addTrack(consumer.track);
    if (remoteVideo.current) remoteVideo.current.srcObject = remoteStream.current;
    await callSocket(s, "consumer:resume", { consumerId: consumer.id });
  }

  async function loadHistory() {
    try {
      const path = call.role === "agent"
        ? `/api/sessions/${call.sessionId}`
        : `/api/sessions/${call.sessionId}?token=${call.token}`;
      const headers = call.role === "agent" ? { Authorization: `Bearer ${agentToken}` } : {};
      const data = await api(path, { headers });
      setMessages(data.history.messages);
      setInviteUrl(`${location.origin}/?session=${data.history.session.id}&token=${data.history.session.inviteToken}`);
    } catch {
      // The socket join path will show the real access error if one exists.
    }
  }

  function cleanupMedia() {
    localStream.current?.getTracks().forEach(track => track.stop());
    remoteStream.current?.getTracks().forEach(track => track.stop());
    producerTransport.current?.close();
    consumerTransport.current?.close();
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!text.trim()) return;
    await callSocket(socket, "chat:send", { body: text });
    setText("");
  }

  function toggleMic() {
    const audio = localStream.current?.getAudioTracks()[0];
    if (audio) {
      audio.enabled = !audio.enabled;
      setMicOn(audio.enabled);
    }
  }

  function toggleCam() {
    const video = localStream.current?.getVideoTracks()[0];
    if (video) {
      video.enabled = !video.enabled;
      setCamOn(video.enabled);
    }
  }

  async function endSession() {
    if (call.role === "agent") await callSocket(socket, "session:end");
    cleanupMedia();
    onExit();
  }

  async function uploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    body.append("role", call.role);
    body.append("name", displayName);
    if (call.role === "customer") body.append("token", call.token);
    const res = await fetch(`${API}/api/sessions/${call.sessionId}/files`, {
      method: "POST",
      headers: call.role === "agent" ? { Authorization: `Bearer ${agentToken}` } : {},
      body
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "File upload failed.");
    }
  }

  async function toggleRecording() {
    if (recording !== "in_progress") {
      recordedChunks.current = [];
      const stream = localVideo.current.captureStream?.() || localStream.current;
      mediaRecorder.current = new MediaRecorder(stream, { mimeType: "video/webm" });
      mediaRecorder.current.ondataavailable = e => e.data.size && recordedChunks.current.push(e.data);
      mediaRecorder.current.onstop = uploadRecording;
      mediaRecorder.current.start();
      await callSocket(socket, "recording:set", { status: "in_progress" });
    } else {
      await callSocket(socket, "recording:set", { status: "processing" });
      mediaRecorder.current?.stop();
    }
  }

  async function uploadRecording() {
    const blob = new Blob(recordedChunks.current, { type: "video/webm" });
    const body = new FormData();
    body.append("recording", blob, "session-recording.webm");
    const res = await fetch(`${API}/api/sessions/${call.sessionId}/recording`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}` },
      body
    });
    if (res.ok) setRecording("ready");
  }

  const participants = state?.participants || [];

  return (
    <main className="callShell">
      <header className="callTop">
        <div>
          <p className="eyebrow">{call.role === "agent" ? "Agent room" : "Customer room"}</p>
          <h1>{state?.session?.title || "Video support session"}</h1>
        </div>
        <div className="topActions">
          {inviteUrl && call.role === "agent" && <button className="secondary" onClick={() => navigator.clipboard?.writeText(inviteUrl)}><Copy size={17} /> Copy invite</button>}
          {call.role === "agent" && <button className="secondary" onClick={toggleRecording}><Radio size={17} /> {recording === "in_progress" ? "Stop recording" : "Record"}</button>}
          <button className="danger" onClick={endSession}><PhoneOff size={17} /> {call.role === "agent" ? "End session" : "Leave"}</button>
        </div>
      </header>
      {error && <div className="banner">{error}</div>}

      <section className="callGrid">
        <div className="videoStage">
          <video ref={remoteVideo} autoPlay playsInline className="remoteVideo" />
          <video ref={localVideo} autoPlay muted playsInline className="localVideo" />
          <div className="controls">
            <button onClick={toggleMic}>{micOn ? <Mic size={20} /> : <MicOff size={20} />}</button>
            <button onClick={toggleCam}>{camOn ? <Video size={20} /> : <VideoOff size={20} />}</button>
            <span className="statusPill">{recording}</span>
          </div>
        </div>

        <aside className="sidePanel">
          <h2>Participants</h2>
          {participants.map(p => <div className="person" key={p.id}><strong>{p.name}</strong><span>{p.role} · {p.connected ? "online" : "away"}</span></div>)}
          <h2>Chat</h2>
          <div className="messages">
            {messages.map(msg => (
              <div className="message" key={`${msg.id}-${msg.created_at}`}>
                <strong>{msg.name}</strong>
                {msg.kind === "file" ? <a href={`${API}${msg.file_url}`} target="_blank">{msg.file_name}</a> : <p>{msg.body}</p>}
              </div>
            ))}
          </div>
          <form className="chatForm" onSubmit={sendMessage}>
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a note for the session..." />
            <button><Send size={17} /></button>
          </form>
          <label className="uploadButton"><Upload size={17} /> Share file<input type="file" onChange={uploadFile} /></label>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
