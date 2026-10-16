import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const origins = (
  process.env.CLIENT_ORIGINS ||
  'https://watch-party-server-steel.vercel.app,http://localhost:5500,http://127.0.0.1:5500,http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map(v => v.trim().replace(/\/$/, ''))
  .filter(Boolean);
const requestedMaxMembers = Number(process.env.MAX_MEMBERS || 30);
const MAX_MEMBERS = Number.isFinite(requestedMaxMembers) ? Math.max(10, Math.min(100, requestedMaxMembers)) : 30;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const RECONNECT_TTL_MS = 2 * 60 * 1000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;
const CHAT_LIMIT = 500;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'syncvibe', uptimeSeconds: Math.round(process.uptime()), timestamp: Date.now() }));
app.get('/', (_req, res) => res.json({ service: 'SyncVibe realtime server', health: '/health' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: origins, methods: ['GET', 'POST'] },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    callback(null, !origin || origins.includes(origin));
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: { maxDisconnectionDuration: RECONNECT_TTL_MS, skipMiddlewares: true }
});

// In-memory demo state: use a shared database + Socket.IO adapter before horizontal scaling.
const rooms = new Map();
const sessions = new Map(); // bearer resume token -> { roomCode, participantId }
const now = () => Date.now();
const randomCode = () => randomBytes(4).toString('hex').toUpperCase();
const cleanName = v => typeof v === 'string' && NAME_RE.test(v.trim()) ? v.trim() : null;
const cleanCode = v => typeof v === 'string' ? v.trim().toUpperCase() : '';
const safePosition = v => Number.isFinite(v) ? Math.max(0, Math.min(v, 24 * 60 * 60)) : null;
const safeTitle = v => typeof v === 'string' ? v.trim().replace(/[<>]/g, '').slice(0, 120) || 'YouTube video' : 'YouTube video';
function ackError(ack, error) { if (typeof ack === 'function') ack({ ok: false, error }); }
function findRoom(code) {
  const room = rooms.get(cleanCode(code));
  if (!room) return null;
  if (now() - room.updatedAt > ROOM_TTL_MS && room.members.size === 0) { rooms.delete(room.code); return null; }
  return room;
}
function estimatePosition(p, at = now()) { return p.playing ? Math.max(0, p.position + ((at - p.updatedAt) / 1000) * p.rate) : p.position; }
function publicSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    members: [...room.members.values()].map(m => ({ id: m.id, name: m.name, isHost: m.id === room.hostId, connected: m.connected })),
    playback: { ...room.playback, position: estimatePosition(room.playback), updatedAt: now() },
    playlist: room.playlist.map(item => ({ ...item })),
    polls: [...room.polls.values()].map(p => ({ id: p.id, question: p.question, options: p.options.slice(), votes: Object.fromEntries(p.votes), closed: p.closed, createdBy: p.createdBy })),
    messages: room.messages.slice(-80),
    updatedAt: room.updatedAt
  };
}
function broadcastSnapshot(room) { room.updatedAt = now(); io.to(room.code).emit('room:snapshot', publicSnapshot(room)); }
function memberContext(socket) {
  const room = socket.data.roomCode ? findRoom(socket.data.roomCode) : null;
  const member = room && room.members.get(socket.data.participantId);
  return room && member && member.socketId === socket.id ? { room, member } : null;
}
function electHost(room) {
  const next = [...room.members.values()].find(m => m.connected);
  room.hostId = next?.id || [...room.members.keys()][0] || null;
}
function detachMember(room, participantId, { removeSession = true } = {}) {
  const member = room?.members.get(participantId);
  if (!member) return;
  if (removeSession) sessions.delete(member.token);
  room.members.delete(participantId);
  if (room.hostId === participantId) electHost(room);
  if (!room.members.size) rooms.delete(room.code);
  else broadcastSnapshot(room);
}
function detachSocketFromCurrentRoom(socket) {
  const code = socket.data.roomCode, participantId = socket.data.participantId;
  if (!code || !participantId) return;
  const room = findRoom(code);
  const member = room?.members.get(participantId);
  socket.leave(code);
  delete socket.data.roomCode;
  delete socket.data.participantId;
  if (room && member && member.socketId === socket.id) detachMember(room, participantId);
}
function newRoom(code, socket, name, participantId, token) {
  return {
    code, hostId: participantId,
    members: new Map([[participantId, { id: participantId, name, connected: true, socketId: socket.id, token, disconnectedAt: null }]]),
    playback: { videoId: null, playing: false, position: 0, rate: 1, updatedAt: now(), revision: 0 },
    playlist: [], polls: new Map(), messages: [], createdAt: now(), updatedAt: now()
  };
}
function attach(socket, room, member) {
  member.connected = true; member.disconnectedAt = null; member.socketId = socket.id;
  socket.join(room.code); socket.data.roomCode = room.code; socket.data.participantId = member.id;
  sessions.set(member.token, { roomCode: room.code, participantId: member.id });
  return member.token;
}
function rateAllowed(socket, event) {
  const t = now();
  const all = socket.data.rateLimits || (socket.data.rateLimits = new Map());
  const item = all.get(event) || { start: t, count: 0 };
  if (t - item.start >= RATE_WINDOW_MS) { item.start = t; item.count = 0; }
  item.count += 1; all.set(event, item);
  return item.count <= RATE_MAX;
}
function guarded(socket, event, ack) {
  if (rateAllowed(socket, event)) return true;
  ackError(ack, 'You are doing that too quickly. Please wait a moment.');
  return false;
}
function emitPlayback(room, member, action, patch = {}) {
  const current = room.playback;
  const next = {
    videoId: patch.videoId ?? current.videoId,
    position: patch.position ?? estimatePosition(current),
    playing: patch.playing ?? current.playing,
    rate: patch.rate ?? current.rate,
    updatedAt: now(), revision: current.revision + 1
  };
  room.playback = next; room.updatedAt = now();
  io.to(room.code).emit('playback:state', { ...next, action, serverNow: now(), actorId: member.id });
}

io.on('connection', socket => {
  // A fresh socket may resume an existing member. The previous socket's disconnect handler is guarded by socketId.
  const token = typeof socket.handshake.auth?.resumeToken === 'string' ? socket.handshake.auth.resumeToken : '';
  const resume = token && sessions.get(token);
  if (resume) {
    const room = findRoom(resume.roomCode), member = room?.members.get(resume.participantId);
    const priorSocketAlive = member?.socketId ? io.sockets.sockets.has(member.socketId) : false;
    const canResume = member && (!member.connected || !priorSocketAlive) && member.disconnectedAt && now() - member.disconnectedAt <= RECONNECT_TTL_MS;
    if (room && member && canResume) {
      if (member.socketId) io.sockets.sockets.get(member.socketId)?.leave(room.code);
      attach(socket, room, member);
      socket.emit('room:resumed', { ok: true, resumeToken: member.token, participantId: member.id, snapshot: publicSnapshot(room) });
      broadcastSnapshot(room);
    }
  }

  socket.on('room:create', (payload = {}, ack) => {
    if (!guarded(socket, 'room:create', ack)) return;
    const name = cleanName(payload.name);
    if (!name) return ackError(ack, 'Name must be 1–24 letters, numbers, spaces, . _ or - characters.');
    let code = cleanCode(payload.code || '');
    if (code && !ROOM_CODE_RE.test(code)) return ackError(ack, 'Custom room code must be 4–12 letters or numbers.');
    if (code && rooms.has(code)) return ackError(ack, 'That room code is already in use.');
    if (!code) { do { code = randomCode(); } while (rooms.has(code)); }
    detachSocketFromCurrentRoom(socket);
    const participantId = randomUUID(), resumeToken = randomBytes(32).toString('base64url');
    const room = newRoom(code, socket, name, participantId, resumeToken);
    rooms.set(code, room); attach(socket, room, room.members.get(participantId));
    ack?.({ ok: true, resumeToken, participantId, snapshot: publicSnapshot(room) }); broadcastSnapshot(room);
  });

  socket.on('room:join', (payload = {}, ack) => {
    if (!guarded(socket, 'room:join', ack)) return;
    const name = cleanName(payload.name), code = cleanCode(payload.code);
    const room = findRoom(code);
    if (!name) return ackError(ack, 'Name must be 1–24 characters.');
    if (!ROOM_CODE_RE.test(code)) return ackError(ack, 'Enter a valid room code.');
    if (!room) return ackError(ack, 'Room not found. Check the invite code or invite link.');
    const existingInRoom = socket.data.roomCode === code && room.members.get(socket.data.participantId);
    if (room.members.size >= MAX_MEMBERS && !existingInRoom) return ackError(ack, `Room is full (limit ${MAX_MEMBERS}).`);
    if (existingInRoom) {
      existingInRoom.name = name; attach(socket, room, existingInRoom);
      ack?.({ ok: true, resumeToken: existingInRoom.token, participantId: existingInRoom.id, snapshot: publicSnapshot(room) }); broadcastSnapshot(room); return;
    }
    detachSocketFromCurrentRoom(socket);
    const participantId = randomUUID(), resumeToken = randomBytes(32).toString('base64url');
    const member = { id: participantId, name, connected: true, socketId: socket.id, token: resumeToken, disconnectedAt: null };
    room.members.set(participantId, member); attach(socket, room, member);
    ack?.({ ok: true, resumeToken, participantId, snapshot: publicSnapshot(room) }); broadcastSnapshot(room);
  });

  socket.on('room:leave', (_payload, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackError(ack, 'You are not in a room.');
    const { room, member } = ctx;
    socket.leave(room.code); delete socket.data.roomCode; delete socket.data.participantId;
    detachMember(room, member.id); ack?.({ ok: true });
  });

  socket.on('playback:command', (payload = {}, ack) => {
    if (!guarded(socket, 'playback:command', ack)) return;
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    const { room, member } = ctx;
    if (member.id !== room.hostId) return ackError(ack, 'Only the current host can control playback.');
    const action = payload.action;
    if (!['load', 'play', 'pause', 'seek', 'rate'].includes(action)) return ackError(ack, 'Unsupported playback action.');
    if (action === 'load') {
      if (typeof payload.videoId !== 'string' || !VIDEO_ID_RE.test(payload.videoId)) return ackError(ack, 'Invalid YouTube video ID.');
      emitPlayback(room, member, action, { videoId: payload.videoId, position: safePosition(payload.position) ?? 0, playing: payload.playing === true, rate: 1 });
    } else if (action === 'play' || action === 'pause') {
      emitPlayback(room, member, action, { position: safePosition(payload.position) ?? undefined, playing: action === 'play' });
    } else if (action === 'seek') {
      const position = safePosition(payload.position); if (position === null) return ackError(ack, 'Invalid seek position.');
      emitPlayback(room, member, action, { position });
    } else {
      if (!Number.isFinite(payload.rate) || payload.rate < 0.5 || payload.rate > 2) return ackError(ack, 'Playback rate must be between 0.5 and 2.');
      emitPlayback(room, member, action, { rate: payload.rate });
    }
    ack?.({ ok: true, revision: room.playback.revision, serverNow: now() });
  });

  socket.on('chat:send', (payload = {}, ack) => {
    if (!guarded(socket, 'chat:send', ack)) return;
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, CHAT_LIMIT) : '';
    if (!text) return ackError(ack, 'Message cannot be empty.');
    const message = { id: randomUUID(), participantId: ctx.member.id, name: ctx.member.name, text, at: now() };
    ctx.room.messages.push(message); if (ctx.room.messages.length > 100) ctx.room.messages.shift();
    io.to(ctx.room.code).emit('chat:message', message); ack?.({ ok: true, id: message.id });
  });

  socket.on('reaction:send', (payload = {}, ack) => {
    if (!guarded(socket, 'reaction:send', ack)) return;
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    const allowed = new Set(['😂', '❤️', '🔥', '👏', '😮', '😭', '👍', '👎', '🎉', '💀']);
    if (!allowed.has(payload.emoji)) return ackError(ack, 'Unsupported reaction.');
    io.to(ctx.room.code).emit('reaction:new', { participantId: ctx.member.id, name: ctx.member.name, emoji: payload.emoji, at: now() }); ack?.({ ok: true });
  });

  socket.on('playlist:add', (payload = {}, ack) => {
    if (!guarded(socket, 'playlist:add', ack)) return;
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    if (typeof payload.videoId !== 'string' || !VIDEO_ID_RE.test(payload.videoId)) return ackError(ack, 'Invalid YouTube video ID.');
    if (ctx.room.playlist.length >= 100) return ackError(ack, 'Playlist limit reached.');
    const item = { id: randomUUID(), videoId: payload.videoId, title: safeTitle(payload.title), addedBy: ctx.member.name, addedAt: now() };
    ctx.room.playlist.push(item); broadcastSnapshot(ctx.room); ack?.({ ok: true, item });
  });
  socket.on('playlist:remove', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    if (ctx.member.id !== ctx.room.hostId) return ackError(ack, 'Only the host can remove playlist items.');
    const before = ctx.room.playlist.length;
    ctx.room.playlist = ctx.room.playlist.filter(item => item.id !== payload.id);
    if (before === ctx.room.playlist.length) return ackError(ack, 'Playlist item not found.');
    broadcastSnapshot(ctx.room); ack?.({ ok: true });
  });
  socket.on('playlist:play', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    if (ctx.member.id !== ctx.room.hostId) return ackError(ack, 'Only the host can play playlist items.');
    const item = ctx.room.playlist.find(x => x.id === payload.id);
    if (!item) return ackError(ack, 'Playlist item not found.');
    emitPlayback(ctx.room, ctx.member, 'load', { videoId: item.videoId, position: 0, playing: true, rate: 1 }); ack?.({ ok: true });
  });

  socket.on('poll:create', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    const question = typeof payload.question === 'string' ? payload.question.trim().slice(0, 180) : '';
    const options = Array.isArray(payload.options) ? [...new Set(payload.options.map(x => typeof x === 'string' ? x.trim().slice(0, 80) : '').filter(Boolean))].slice(0, 6) : [];
    if (!question || options.length < 2) return ackError(ack, 'A poll needs a question and at least two options.');
    if (ctx.room.polls.size >= 20) return ackError(ack, 'Poll limit reached.');
    const poll = { id: randomUUID(), question, options, votes: new Map(), closed: false, createdBy: ctx.member.name };
    ctx.room.polls.set(poll.id, poll); broadcastSnapshot(ctx.room); ack?.({ ok: true, id: poll.id });
  });
  socket.on('poll:vote', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    const poll = ctx.room.polls.get(payload.pollId);
    if (!poll || poll.closed) return ackError(ack, 'Poll is unavailable or closed.');
    if (!poll.options.includes(payload.option)) return ackError(ack, 'Invalid poll option.');
    poll.votes.set(ctx.member.id, payload.option); broadcastSnapshot(ctx.room); ack?.({ ok: true });
  });
  socket.on('poll:close', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    if (ctx.member.id !== ctx.room.hostId) return ackError(ack, 'Only the host can close polls.');
    const poll = ctx.room.polls.get(payload.pollId); if (!poll) return ackError(ack, 'Poll not found.');
    poll.closed = true; broadcastSnapshot(ctx.room); ack?.({ ok: true });
  });
  socket.on('host:transfer', (payload = {}, ack) => {
    const ctx = memberContext(socket); if (!ctx) return ackError(ack, 'Join a room first.');
    if (ctx.member.id !== ctx.room.hostId) return ackError(ack, 'Only the host can transfer host.');
    const target = ctx.room.members.get(payload.memberId);
    if (!target || !target.connected) return ackError(ack, 'Choose a connected participant.');
    ctx.room.hostId = target.id; broadcastSnapshot(ctx.room); ack?.({ ok: true });
  });
  socket.on('sync:ping', (payload = {}, ack) => {
    ack?.({ clientSentAt: Number.isFinite(payload.clientSentAt) ? payload.clientSentAt : null, serverReceivedAt: now(), serverSentAt: now() });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode, participantId = socket.data.participantId;
    const room = code && findRoom(code), member = room?.members.get(participantId);
    if (!room || !member || member.socketId !== socket.id) return;
    member.connected = false; member.disconnectedAt = now();
    if (room.hostId === participantId) electHost(room);
    broadcastSnapshot(room);
    setTimeout(() => {
      const latest = findRoom(code), stale = latest?.members.get(participantId);
      if (stale && !stale.connected && now() - stale.disconnectedAt >= RECONNECT_TTL_MS) {
        detachMember(latest, participantId);
      }
    }, RECONNECT_TTL_MS + 500).unref?.();
  });
});

const cleanup = setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.members.size && now() - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 60 * 1000);
cleanup.unref?.();
httpServer.listen(PORT, '0.0.0.0', () => console.log(`SyncVibe server listening on :${PORT}; allowed origins: ${origins.join(', ')}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(cleanup);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref?.();
  });
}
