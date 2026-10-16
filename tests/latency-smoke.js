// Lightweight smoke benchmark. Run with server running: npm run test:latency
// This measures command acknowledgement round-trip latency from this machine, not guaranteed one-way propagation.
import { io } from 'socket.io-client';
const URL = process.env.SYNCVIBE_URL || 'http://localhost:3000';
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5500';
const samples = Number(process.env.SAMPLES || 100);
const socket = io(URL, { extraHeaders: { Origin: ORIGIN }, transports: ['websocket', 'polling'] });
const emitAck = (event, data) => new Promise(resolve => socket.emit(event, data, resolve));
const percentile = (values, p) => values.slice().sort((a,b)=>a-b)[Math.min(values.length-1, Math.ceil(p*values.length)-1)];
try {
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const created = await emitAck('room:create', { name: 'Latency host' });
  if (!created?.ok) throw new Error(created?.error || 'room:create failed');
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const result = await emitAck('sync:ping', { clientSentAt: Date.now() });
    if (!result) throw new Error('No ping acknowledgement');
    times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ endpoint: URL, samples, rttMs: { p50: +percentile(times, .50).toFixed(2), p95: +percentile(times, .95).toFixed(2), max: +Math.max(...times).toFixed(2) }, note: 'RTT is not one-way event propagation; run multi-client tests on the target LAN to measure host-command-to-viewer-receive p95.' }, null, 2));
} finally { socket.disconnect(); }
