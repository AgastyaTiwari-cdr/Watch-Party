import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = 3199;
const url = `http://127.0.0.1:${port}`;
let server;
let host;
let guest;
const connectSocket = async () => {
  const socket = io(url, { transports: ['websocket'], timeout: 3000, reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
};
const emitAck = (socket, event, data = {}) => new Promise((resolve, reject) => {
  socket.timeout(3000).emit(event, data, (err, result) => {
    if (err) return reject(new Error(`Ack timeout for ${event}`));
    resolve(result);
  });
});
const waitFor = async (socket, event, predicate = () => true, timeout = 2500) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
  function handler(value) { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, handler); resolve(value); }
  socket.on(event, handler);
});

test('SyncVibe server integration: rooms, playback permissions, chat, polls, and room switching', async t => {
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(root, 'server'), env: { ...process.env, PORT: String(port), CLIENT_ORIGINS: 'http://localhost:5500,http://127.0.0.1:5500' }, stdio: 'ignore' });
  t.after(async () => { host?.disconnect(); guest?.disconnect(); if (server && !server.killed) { server.kill('SIGTERM'); await delay(150); } });
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { const res = await fetch(`${url}/health`); if (res.ok) { healthy = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(healthy, true, 'server should expose /health');
  host = await connectSocket(); guest = await connectSocket();

  const created = await emitAck(host, 'room:create', { name: 'Test Host', code: 'TESTROOM' });
  assert.equal(created.ok, true); assert.equal(created.snapshot.code, 'TESTROOM'); assert.ok(created.participantId);
  const joined = await emitAck(guest, 'room:join', { name: 'Test Guest', code: 'TESTROOM' });
  assert.equal(joined.ok, true); assert.equal(joined.snapshot.members.length, 2);

  const denied = await emitAck(guest, 'playback:command', { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false });
  assert.equal(denied.ok, false, 'non-host playback control must be rejected');
  const playbackPromise = waitFor(guest, 'playback:state', value => value.videoId === 'dQw4w9WgXcQ');
  const loaded = await emitAck(host, 'playback:command', { action: 'load', videoId: 'dQw4w9WgXcQ', position: 0, playing: false });
  assert.equal(loaded.ok, true); const playback = await playbackPromise; assert.equal(playback.action, 'load');

  const chatPromise = waitFor(guest, 'chat:message', value => value.text === 'hello room');
  assert.equal((await emitAck(host, 'chat:send', { text: 'hello room' })).ok, true);
  assert.equal((await chatPromise).name, 'Test Host');

  const pollCreated = await emitAck(host, 'poll:create', { question: 'What next?', options: ['Music', 'Comedy'] });
  assert.equal(pollCreated.ok, true);
  const pollSnapshotPromise = waitFor(host, 'room:snapshot', snap => snap.polls?.some(p => p.id === pollCreated.id && p.votes?.[joined.participantId] === 'Music'));
  assert.equal((await emitAck(guest, 'poll:vote', { pollId: pollCreated.id, option: 'Music' })).ok, true);
  assert.ok(await pollSnapshotPromise);
  const ping = await emitAck(host, 'sync:ping', { clientSentAt: Date.now() }); assert.ok(ping.serverSentAt);

  const hostSnapshotPromise = waitFor(host, 'room:snapshot', snap => snap.code === 'TESTROOM' && snap.members.length === 1);
  const switched = await emitAck(guest, 'room:create', { name: 'Test Guest', code: 'SECONDROOM' });
  assert.equal(switched.ok, true); assert.equal(switched.snapshot.code, 'SECONDROOM');
  await emitAck(guest, 'room:leave', {}); // Guest is in SECONDROOM now; it leaves that room cleanly.
  // Host should still be the only member in TESTROOM; ensure switching rooms did not crash the server.
  const health = await fetch(`${url}/health`); assert.equal(health.ok, true);
  assert.ok(await hostSnapshotPromise);
});

