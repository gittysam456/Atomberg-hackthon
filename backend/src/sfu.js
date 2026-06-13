import mediasoup from "mediasoup";

let worker;
const rooms = new Map();

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 }
  }
];

export async function initSfu() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 40100
  });
  worker.on("died", () => {
    console.error("mediasoup worker died; exiting so the demo fails visibly");
    process.exit(1);
  });
}

export async function getRoom(sessionId) {
  if (rooms.has(sessionId)) return rooms.get(sessionId);
  const router = await worker.createRouter({ mediaCodecs });
  const room = {
    router,
    peers: new Map(),
    transports: new Map(),
    producers: new Map(),
    consumers: new Map()
  };
  rooms.set(sessionId, room);
  return room;
}

export function closeRoom(sessionId) {
  const room = rooms.get(sessionId);
  if (!room) return;
  for (const transport of room.transports.values()) transport.close();
  room.router.close();
  rooms.delete(sessionId);
}

export async function createWebRtcTransport(sessionId, peerId, direction) {
  const room = await getRoom(sessionId);
  const transport = await room.router.createWebRtcTransport({
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp: process.env.ANNOUNCED_IP || undefined
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000
  });
  room.transports.set(transport.id, transport);
  transport.appData = { peerId, direction };
  transport.on("dtlsstatechange", state => {
    if (state === "closed") transport.close();
  });
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters
  };
}

export function getRtpCapabilities(sessionId) {
  const room = rooms.get(sessionId);
  return room?.router.rtpCapabilities;
}

export async function connectTransport(sessionId, transportId, dtlsParameters) {
  const room = await getRoom(sessionId);
  const transport = room.transports.get(transportId);
  if (!transport) throw new Error("Transport not found.");
  await transport.connect({ dtlsParameters });
}

export async function produce(sessionId, transportId, peerId, kind, rtpParameters) {
  const room = await getRoom(sessionId);
  const transport = room.transports.get(transportId);
  if (!transport) throw new Error("Transport not found.");
  const producer = await transport.produce({ kind, rtpParameters, appData: { peerId } });
  room.producers.set(producer.id, producer);
  producer.on("transportclose", () => room.producers.delete(producer.id));
  return { id: producer.id, peerId, kind };
}

export function listProducers(sessionId, excludePeerId) {
  const room = rooms.get(sessionId);
  if (!room) return [];
  return [...room.producers.values()]
    .filter(producer => producer.appData.peerId !== excludePeerId)
    .map(producer => ({ producerId: producer.id, peerId: producer.appData.peerId, kind: producer.kind }));
}

export async function consume(sessionId, transportId, producerId, peerId, rtpCapabilities) {
  const room = await getRoom(sessionId);
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error("Client cannot consume this producer.");
  }
  const transport = room.transports.get(transportId);
  if (!transport) throw new Error("Transport not found.");
  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true,
    appData: { peerId }
  });
  room.consumers.set(consumer.id, consumer);
  consumer.on("transportclose", () => room.consumers.delete(consumer.id));
  consumer.on("producerclose", () => {
    room.consumers.delete(consumer.id);
    consumer.close();
  });
  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters
  };
}

export async function resumeConsumer(sessionId, consumerId) {
  const room = await getRoom(sessionId);
  const consumer = room.consumers.get(consumerId);
  if (!consumer) throw new Error("Consumer not found.");
  await consumer.resume();
}
