import { extractYouTubeId } from './youtube-utils.js';
import { CATALOGUE, fuzzySearch } from './search.js';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_SERVER_URL = window.SYNCVIBE_SERVER_URL || 'https://watch-party-9s9m.onrender.com';
const $ = id => document.getElementById(id);

/* Sync tuning. The poll runs every 100 ms, so a host seek is detected well inside the 250 ms control budget. */
const POLL_MS = 100;
const HARD_SEEK_SECONDS = 0.75;   // beyond this, jump straight to the host's position
const NUDGE_SECONDS = 0.2;        // between this and the hard-seek limit, change speed briefly instead of jumping
const SETTLED_SECONDS = 0.08;     // inside this, stop nudging
const HOST_JUMP_SECONDS = 1.0;    // host playhead jumps bigger than this are treated as a seek
const CLOCK_RESAMPLE_MS = 30_000;

const VIEWS = ['home', 'watch', 'discover', 'queue', 'polls', 'room'];
const PRE_ROOM_VIEWS = ['home', 'discover'];

const store = {
  get(key, fallback = '') { try { return localStorage.getItem(`syncvibe.${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`syncvibe.${key}`, value); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(`syncvibe.${key}`); } catch { /* storage unavailable */ } }
};

const state = {
  socket: null, player: null, playerReady: false, playerInitStarted: false, playerPoll: null,
  room: null, meId: null, view: 'home',
  resumeToken: store.get('resumeToken'), roomCode: store.get('roomCode'), displayName: store.get('displayName'),
  serverUrl: store.get('serverUrl', DEFAULT_SERVER_URL),
  modalMode: 'create', pendingJoinCode: new URL(location.href).searchParams.get('room')?.toUpperCase() || '', pendingVideo: null,
  latestPlayback: null, lastAppliedRevision: -1,
  serverClockOffset: 0, clockTimer: null,
  suppressHostEventsUntil: 0, isApplyingRemote: false, autoplayBlocked: false, lastPlayerState: -1,
  host: { lastTime: null, lastAt: 0 },
  nudge: { active: false, baseRate: 1 },
  chatIds: new Set(),
  gallery: { items: [], center: 0, drag: null, lastWheel: 0 }
};

const isHost = () => !!state.room && state.meId === state.room.hostId;

/* ---------- small helpers ---------- */
function toast(message, type = 'success', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = message;
  $('toastRegion').append(el);
  window.setTimeout(() => el.remove(), duration);
}
function setConnection(kind, text) { $('connectionDot').className = `dot ${kind}`; $('connectionText').textContent = text; }
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--';
  const n = Math.floor(seconds), h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
const timeLabel = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const thumbUrl = (id, size = 'mqdefault') => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`;
const titleFor = id => CATALOGUE.find(item => item.id === id)?.title;
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function ack(socket, event, payload, timeout = 7000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Not connected to the server. Open connection settings and check the address.'));
    socket.timeout(timeout).emit(event, payload, (error, result) => {
      if (error) return reject(new Error('The server did not respond in time. Try again.'));
      if (!result?.ok) return reject(new Error(result?.error || 'The request failed.'));
      resolve(result);
    });
  });
}
const withToast = fn => async (...args) => { try { return await fn(...args); } catch (error) { toast(error.message, 'error'); return null; } };

/* ---------- views (sections) ---------- */
function allowedView(name) {
  if (!VIEWS.includes(name)) name = state.room ? 'watch' : 'home';
  if (!state.room && !PRE_ROOM_VIEWS.includes(name)) return 'home';
  if (state.room && name === 'home') return 'watch';
  return name;
}
function showView(name, { focus = true } = {}) {
  name = allowedView(name);
  const changed = name !== state.view;
  state.view = name;
  document.body.dataset.view = name;
  document.querySelectorAll('.view').forEach(section => section.classList.toggle('is-active', section.dataset.view === name));
  document.querySelectorAll('#viewNav button').forEach(button => {
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(history.state, '', `${location.pathname}${location.search}#${name}`);
  if (name === 'discover') layoutGallery();
  if (changed && focus) $(`view-${name}`).querySelector('h1')?.focus({ preventScroll: true });
}

/* ---------- dialogs ---------- */
function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
function setRoomFormMode(mode, code = '') {
  state.modalMode = mode;
  $('roomModalTitle').textContent = mode === 'create' ? 'Create a room' : 'Join a room';
  $('roomModalDescription').textContent = mode === 'create' ? 'Choose a display name, then invite your people.' : 'Enter your name and the code your friend shared.';
  $('roomFormSubmit').textContent = mode === 'create' ? 'Create room' : 'Join room';
  $('roomCodeField').hidden = mode !== 'join';
  $('customCodeField').hidden = mode !== 'create';
  $('roomCodeInput').value = code;
  if (mode === 'create') $('customRoomCode').value = '';
  $('roomFormError').hidden = true;
  $('displayName').value = state.displayName || '';
  openDialog('roomDialog');
  ($('displayName').value ? (mode === 'join' ? $('roomCodeInput') : $('displayName')) : $('displayName')).focus();
}
function showFormError(id, message) { const node = $(id); node.textContent = message; node.hidden = false; }

/* ---------- realtime connection ---------- */
function connect() {
  if (typeof window.io !== 'function') {
    setConnection('', 'Realtime client missing');
    toast('Could not load the realtime client. Check your connection and reload.', 'error', 6000);
    return;
  }
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
  setConnection('connecting', 'Connecting');
  state.socket = window.io(state.serverUrl, {
    path: '/socket.io/', transports: ['polling', 'websocket'], upgrade: true,
    auth: { resumeToken: state.resumeToken || undefined },
    reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 20000
  });
  const socket = state.socket;
  socket.on('connect', () => {
    setConnection('connected', 'Connected');
    measureClockOffset(socket);
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(() => measureClockOffset(socket), CLOCK_RESAMPLE_MS);
    if (!state.room) toast('Connected. Create a room or join with a code.');
  });
  socket.on('connect_error', error => { setConnection('connecting', 'Reconnecting'); $('playerNotice').textContent = `Server connection issue: ${error.message}. Open connection settings if this persists.`; });
  socket.on('disconnect', reason => { setConnection('connecting', 'Reconnecting'); toast(`Connection lost (${reason}). Reconnecting automatically.`, 'warning', 5000); });
  socket.on('room:resumed', data => {
    if (!data?.ok) return;
    state.resumeToken = data.resumeToken; state.meId = data.participantId || state.meId; store.set('resumeToken', state.resumeToken);
    applySnapshot(data.snapshot, data.participantId);
    toast('Welcome back. Your session was restored.');
  });
  socket.on('room:snapshot', snapshot => applySnapshot(snapshot));
  socket.on('playback:state', playback => applyPlayback(playback));
  socket.on('chat:message', message => appendChatMessage(message));
  socket.on('reaction:new', reaction => showFloatingReaction(reaction.emoji));
}

/** Estimate server-minus-client clock offset from the lowest-RTT of a few pings; device clocks are never assumed equal. */
function measureClockOffset(socket) {
  const samples = [];
  let attempts = 0;
  const finish = () => { if (samples.length) { samples.sort((a, b) => a.rtt - b.rtt); state.serverClockOffset = samples[0].offset; } };
  const ping = () => {
    if (!socket.connected || attempts >= 5) return finish();
    attempts += 1;
    const sent = Date.now();
    socket.timeout(2500).emit('sync:ping', { clientSentAt: sent }, (error, result) => {
      const received = Date.now();
      if (!error && result?.serverSentAt) samples.push({ rtt: received - sent, offset: result.serverSentAt - (sent + received) / 2 });
      if (attempts < 5) setTimeout(ping, 80); else finish();
    });
  };
  ping();
}
const serverNow = () => Date.now() + state.serverClockOffset;

function ensureConnected() {
  if (state.socket?.connected) return Promise.resolve();
  if (!state.socket) connect();
  return new Promise((resolve, reject) => {
    const socket = state.socket;
    if (!socket) return reject(new Error('The realtime client failed to start.'));
    const timer = setTimeout(() => { socket.off('connect', connected); reject(new Error('Could not connect. Check that the server is running and the address is right.')); }, 10000);
    function connected() { clearTimeout(timer); resolve(); }
    socket.once('connect', connected);
  });
}

/* ---------- room state -> UI ---------- */
function resetRoomUi() {
  state.room = null; state.meId = null; state.roomCode = ''; state.latestPlayback = null; state.lastAppliedRevision = -1;
  document.body.dataset.room = 'false';
  $('chatMessages').replaceChildren(el('p', 'empty', "Say hello once you're in a room."));
  state.chatIds.clear();
  ['chatInput', 'chatSend', 'reactionToggle', 'leaveRoomButton', 'newPollButton', 'syncChip'].forEach(id => { $(id).disabled = true; });
  $('reactionTray').hidden = true;
  $('onlineCount').textContent = '0 online';
  $('queueCount').hidden = true;
  $('playlistItems').replaceChildren(); $('pollsList').replaceChildren(); $('peopleList').replaceChildren();
  showIdle();
  syncStatus('', 'Waiting for a room');
  renderSpotlight();
}
function showIdle() {
  if (state.playerReady) state.player?.stopVideo?.();
  $('playerPlaceholder').classList.remove('is-gone');
  $('currentVideoTitle').textContent = 'No video selected';
  $('currentVideoSub').textContent = state.room ? (isHost() ? 'Paste a link above or pick something in Discover.' : 'Waiting for the host to choose something.') : 'Join a room to watch together.';
  $('openYoutube').href = '#'; $('openYoutube').classList.add('is-disabled'); $('openYoutube').setAttribute('aria-disabled', 'true'); $('openYoutube').tabIndex = -1;
  $('playerTime').textContent = '-:--';
}
function applySnapshot(snapshot, selfId = null) {
  if (!snapshot?.code) return;
  const previousCode = state.room?.code;
  if (previousCode && previousCode !== snapshot.code) { state.chatIds.clear(); $('chatMessages').replaceChildren(); }
  state.room = snapshot; state.roomCode = snapshot.code; store.set('roomCode', snapshot.code);
  if (selfId) state.meId = selfId;
  document.body.dataset.room = 'true';
  const members = snapshot.members || [];
  const online = members.filter(m => m.connected);
  const host = members.find(m => m.id === snapshot.hostId);

  $('roomChipCode').textContent = snapshot.code;
  $('roomCodeBig').textContent = snapshot.code;
  $('detailHost').textContent = host?.name || '-';
  $('peopleCount').textContent = `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
  $('onlineCount').textContent = `${online.length} online`;
  $('inviteLinkInput').value = inviteUrl();
  const queued = snapshot.playlist?.length || 0;
  $('queueCount').textContent = String(queued); $('queueCount').hidden = !queued;
  ['chatInput', 'chatSend', 'reactionToggle', 'leaveRoomButton', 'newPollButton', 'syncChip'].forEach(id => { $(id).disabled = false; });
  $('syncChip').title = isHost() ? 'Send your position to everyone' : 'Jump to the host\'s position';

  renderPeople(snapshot); renderPlaylist(snapshot); renderPolls(snapshot); renderSpotlight(); updateCommandActions();
  (snapshot.messages || []).forEach(appendChatMessage);
  if (snapshot.playback?.videoId) applyPlayback(snapshot.playback, { fromSnapshot: true });
  else showIdle();
  if (state.view === 'home') showView('watch', { focus: false });
}

function renderPeople(snapshot) {
  const list = $('peopleList'); list.replaceChildren();
  (snapshot.members || []).forEach(member => {
    const row = el('li', 'person');
    row.append(el('span', 'avatar', initials(member.name)), el('span', 'person-name', member.name + (member.id === state.meId ? ' (you)' : '')));
    if (member.id === snapshot.hostId) row.append(el('span', 'person-tag host', 'Host'));
    else if (!member.connected) row.append(el('span', 'person-tag', 'Reconnecting'));
    else if (isHost()) {
      const make = el('button', 'btn btn-text btn-sm', 'Make host');
      make.type = 'button';
      make.setAttribute('aria-label', `Make ${member.name} the host`);
      make.addEventListener('click', withToast(async () => { await ack(state.socket, 'host:transfer', { memberId: member.id }); toast(`${member.name} is now the host.`); }));
      row.append(make);
    }
    list.append(row);
  });
}

function renderPlaylist(snapshot) {
  const list = $('playlistItems'); list.replaceChildren();
  const items = snapshot.playlist || [];
  const current = snapshot.playback?.videoId;
  $('queueSummary').textContent = items.length ? `${items.length} queued. ${isHost() ? 'Start any of them, or let them play in order.' : 'The host starts them.'}` : 'Videos anyone adds land here. The host starts them.';
  if (!items.length) {
    const empty = el('li', 'empty-block');
    empty.append(el('p', '', 'The queue is empty.'));
    const go = el('button', 'btn btn-secondary btn-sm', 'Browse Discover'); go.type = 'button'; go.addEventListener('click', () => showView('discover'));
    empty.append(go); list.append(empty); return;
  }
  items.forEach(item => {
    const row = el('li', `q-item${item.videoId === current ? ' is-current' : ''}`);
    const img = el('img', 'q-thumb'); img.loading = 'lazy'; img.alt = ''; img.src = thumbUrl(item.videoId); img.onerror = () => { img.style.visibility = 'hidden'; };
    const copy = el('div', 'q-copy'); copy.append(el('strong', '', item.title), el('span', '', `${item.videoId === current ? 'Now playing. ' : ''}Added by ${item.addedBy}`));
    row.append(img, copy);
    if (isHost()) {
      const actions = el('div', 'q-actions');
      const play = el('button', 'btn btn-secondary btn-sm', 'Play'); play.type = 'button'; play.setAttribute('aria-label', `Play ${item.title}`);
      play.addEventListener('click', withToast(async () => { await ack(state.socket, 'playlist:play', { id: item.id }); showView('watch'); }));
      const remove = el('button', 'icon-btn', ''); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.title} from the queue`);
      remove.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-close"/></svg>';
      remove.addEventListener('click', withToast(() => ack(state.socket, 'playlist:remove', { id: item.id })));
      actions.append(play, remove); row.append(actions);
    }
    list.append(row);
  });
}

function renderPolls(snapshot) {
  const list = $('pollsList'); list.replaceChildren();
  const polls = snapshot.polls || [];
  if (!polls.length) {
    const empty = el('div', 'empty-block'); empty.append(el('p', '', 'No polls yet. Start one to decide what to watch.')); list.append(empty); return;
  }
  polls.slice().reverse().forEach(poll => {
    const card = el('article', 'poll'); card.append(el('h2', '', poll.question));
    const counts = Object.fromEntries(poll.options.map(o => [o, Object.values(poll.votes || {}).filter(v => v === o).length]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    poll.options.forEach(option => {
      const count = counts[option] || 0, percent = total ? Math.round(count / total * 100) : 0;
      const button = el('button', `poll-option${poll.votes?.[state.meId] === option ? ' voted' : ''}`); button.type = 'button'; button.disabled = poll.closed;
      button.setAttribute('aria-pressed', String(poll.votes?.[state.meId] === option));
      const fill = el('span', 'bar-fill'); fill.style.width = `${percent}%`;
      const row = el('span', 'row'); row.append(el('span', '', option), el('span', '', `${percent}% (${count})`));
      button.append(fill, row);
      button.addEventListener('click', withToast(() => ack(state.socket, 'poll:vote', { pollId: poll.id, option })));
      card.append(button);
    });
    const foot = el('div', 'poll-foot'); foot.append(el('span', '', `By ${poll.createdBy}. ${total} vote${total === 1 ? '' : 's'}. ${poll.closed ? 'Closed.' : 'Open.'}`));
    if (!poll.closed && isHost()) {
      const close = el('button', 'btn btn-text btn-sm', 'Close poll'); close.type = 'button';
      close.addEventListener('click', withToast(() => ack(state.socket, 'poll:close', { pollId: poll.id })));
      foot.append(close);
    }
    card.append(foot); list.append(card);
  });
}

/* ---------- chat and reactions ---------- */
function appendChatMessage(message) {
  if (!message?.id || state.chatIds.has(message.id)) return;
  state.chatIds.add(message.id);
  if (state.chatIds.size > 250) state.chatIds.delete(state.chatIds.values().next().value);
  const container = $('chatMessages');
  if (container.querySelector('.empty')) container.replaceChildren();
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const row = el('div', `msg${message.participantId && message.participantId === state.meId ? ' mine' : ''}`);
  const head = el('div', 'msg-head'); head.append(el('strong', '', message.name || 'Guest'), el('time', '', timeLabel(message.at || Date.now())));
  const text = document.createElement('p'); text.textContent = message.text || '';
  row.append(head, text); container.append(row);
  if (nearBottom || message.participantId === state.meId) container.scrollTop = container.scrollHeight;
}
function showFloatingReaction(emoji) {
  const overlay = $('reactionOverlay');
  const node = el('span', 'reaction-float', emoji);
  node.style.left = `${10 + Math.random() * 75}%`;
  overlay.append(node); setTimeout(() => node.remove(), 2500);
}

/* ---------- discover: search + 3D gallery ---------- */
function currentResults() {
  const query = $('searchInput').value.trim();
  const pastedId = query ? extractYouTubeId(query) : null;
  if (pastedId) return [{ id: pastedId, title: titleFor(pastedId) || 'Pasted YouTube link', creator: 'YouTube', category: 'Link', year: null }];
  return fuzzySearch(query);
}
function renderGallery() {
  const items = currentResults();
  state.gallery.items = items; state.gallery.center = Math.min(state.gallery.center, Math.max(0, items.length - 1));
  const track = $('galleryTrack'); track.replaceChildren();
  items.forEach((item, index) => {
    const li = el('li'); const button = el('button', 'poster'); button.type = 'button';
    button.setAttribute('aria-label', `${item.title}, ${item.creator}`);
    const img = el('img'); img.loading = index < 7 ? 'eager' : 'lazy'; img.alt = ''; img.draggable = false; img.src = thumbUrl(item.id, 'hqdefault'); img.onerror = () => { img.style.opacity = '.3'; };
    button.append(img, el('span', 'cap', item.title));
    button.addEventListener('click', () => { if (state.gallery.center !== index) setCenter(index); });
    button.addEventListener('focus', () => { if (state.gallery.center !== index) setCenter(index); });
    li.append(button); track.append(li);
  });
  $('emptySearch').hidden = items.length > 0;
  $('resultCount').textContent = items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'No results';
  layoutGallery(); renderSpotlight();
}
function layoutGallery() {
  const { items, center } = state.gallery;
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  [...$('galleryTrack').children].forEach((li, index) => {
    const offset = index - center, distance = Math.abs(offset), side = Math.sign(offset);
    const visible = distance <= 3;
    const shift = narrow ? 62 : 56;
    li.style.transform = `translate(-50%, -50%) translateX(${offset * shift}%) translateZ(${-distance * 150}px) rotateY(${side * -34}deg) scale(${1 - Math.min(distance, 3) * .04})`;
    li.style.opacity = visible ? String(Math.max(.25, 1 - distance * .22)) : '0';
    li.style.zIndex = String(50 - distance);
    li.style.pointerEvents = visible ? 'auto' : 'none';
    li.dataset.active = String(index === center);
    const button = li.firstElementChild; button.tabIndex = (index === center || !items.length) ? 0 : -1;
  });
}
function setCenter(index) {
  const max = state.gallery.items.length - 1;
  if (max < 0) return;
  state.gallery.center = Math.max(0, Math.min(max, index));
  layoutGallery(); renderSpotlight();
}
function renderSpotlight() {
  const item = state.gallery.items[state.gallery.center];
  const play = $('spotlightPlay'), queue = $('spotlightQueue');
  $('spotlight').hidden = !item;
  if (!item) return;
  $('spotlightTitle').textContent = item.title;
  $('spotlightMeta').textContent = [item.creator, item.year, item.category].filter(Boolean).join(', ');
  if (!state.room) { play.textContent = 'Create a room to play'; queue.hidden = true; }
  else if (isHost()) { play.textContent = 'Play for the room'; queue.hidden = false; }
  else { play.textContent = 'Add to queue'; queue.hidden = true; }
}
async function spotlightAction(forceQueue = false) {
  const item = state.gallery.items[state.gallery.center]; if (!item) return;
  if (!state.room) { state.pendingVideo = { id: item.id, title: item.title }; setRoomFormMode('create'); return; }
  if (forceQueue || !isHost()) return queueVideo(item.id, item.title);
  if (await chooseVideo(item.id, item.title)) showView('watch');
}
function bindGallery() {
  const gallery = $('gallery');
  $('searchInput').addEventListener('input', () => { state.gallery.center = 0; renderGallery(); });
  gallery.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (event.key === 'Home') { event.preventDefault(); setCenter(0); focusCenter(); }
    else if (event.key === 'End') { event.preventDefault(); setCenter(state.gallery.items.length - 1); focusCenter(); }
    else if (step) { event.preventDefault(); setCenter(state.gallery.center + step); focusCenter(); }
  });
  gallery.addEventListener('wheel', event => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 6 || Date.now() - state.gallery.lastWheel < 180) return;
    event.preventDefault(); state.gallery.lastWheel = Date.now(); setCenter(state.gallery.center + Math.sign(delta));
  }, { passive: false });
  gallery.addEventListener('pointerdown', event => { state.gallery.drag = { x: event.clientX, moved: false }; });
  gallery.addEventListener('pointermove', event => {
    const drag = state.gallery.drag; if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 60) { drag.x = event.clientX; drag.moved = true; setCenter(state.gallery.center + (dx < 0 ? 1 : -1)); }
  });
  const end = () => { state.gallery.drag = null; };
  gallery.addEventListener('pointerup', end); gallery.addEventListener('pointercancel', end); gallery.addEventListener('pointerleave', end);
  gallery.addEventListener('click', event => { if (state.gallery.drag?.moved) { event.stopImmediatePropagation(); event.preventDefault(); } }, true);
  $('spotlightPlay').addEventListener('click', () => spotlightAction(false));
  $('spotlightQueue').addEventListener('click', () => spotlightAction(true));
  window.addEventListener('resize', () => layoutGallery());
}
function focusCenter() { $('galleryTrack').children[state.gallery.center]?.firstElementChild?.focus({ preventScroll: true }); }

/* ---------- loading videos ---------- */
async function chooseVideo(videoId, title) {
  if (!state.room) { state.pendingVideo = { id: videoId, title }; toast('Create or join a room first.', 'warning'); setRoomFormMode('create'); return false; }
  if (!isHost()) { toast('Only the host can change the video. You can add it to the queue instead.', 'warning'); return false; }
  try {
    await ack(state.socket, 'playback:command', { action: 'load', videoId, position: 0, playing: false });
    $('playerNotice').textContent = `Loaded "${title}" for everyone in the room. Press play in the player to start.`;
    return true;
  } catch (error) { toast(error.message, 'error'); return false; }
}
async function queueVideo(videoId, title) {
  if (!state.room) { toast('Create or join a room first.', 'warning'); return false; }
  try { await ack(state.socket, 'playlist:add', { videoId, title: title || titleFor(videoId) || 'YouTube video' }); toast('Added to the queue.'); return true; }
  catch (error) { toast(error.message, 'error'); return false; }
}
function updateCommandActions() {
  const id = extractYouTubeId($('youtubeUrlInput').value);
  $('commandActions').hidden = !id || !state.room;
  $('playNowButton').hidden = !isHost();
}

/* ---------- playback: remote -> local ---------- */
function expectedPosition(playback) {
  if (!playback.playing) return playback.position;
  const elapsed = (serverNow() - (playback.updatedAt || serverNow())) / 1000;
  return Math.max(0, playback.position + elapsed * (playback.rate || 1));
}
function syncStatus(kind, label, title = '') {
  $('syncDot').className = `dot ${kind}`; $('syncLabel').textContent = label; $('syncChip').title = title || $('syncChip').title;
}
function applyPlayback(playback, { fromSnapshot = false } = {}) {
  if (!playback?.videoId || !VIDEO_ID_RE.test(playback.videoId)) { state.latestPlayback = playback || null; return; }
  if (!fromSnapshot && Number.isFinite(playback.revision) && playback.revision < state.lastAppliedRevision) return;
  const previous = state.latestPlayback;
  state.latestPlayback = playback;

  const title = titleFor(playback.videoId);
  const sameVideo = previous?.videoId === playback.videoId;
  if (!sameVideo || title) $('currentVideoTitle').textContent = title || `YouTube video ${playback.videoId}`;
  $('currentVideoSub').textContent = isHost() ? 'You are the host. Use the player controls and the room follows.' : 'Following the host.';
  $('openYoutube').href = `https://www.youtube.com/watch?v=${encodeURIComponent(playback.videoId)}`;
  $('openYoutube').classList.remove('is-disabled'); $('openYoutube').removeAttribute('aria-disabled'); $('openYoutube').tabIndex = 0;
  $('playerPlaceholder').classList.add('is-gone');
  updateCommandActions();
  if (!state.playerReady || !state.player) return;

  // The host already did this locally; only follow the echo if it is a video change we have not loaded yet.
  const echoOfOwnCommand = !fromSnapshot && playback.actorId && playback.actorId === state.meId;
  const currentId = state.player.getVideoData?.().video_id;
  const differentVideo = currentId !== playback.videoId;
  if (echoOfOwnCommand && !differentVideo) { state.lastAppliedRevision = Math.max(state.lastAppliedRevision, playback.revision || 0); return; }

  const target = expectedPosition(playback);
  // Programmatic player calls below fire their own events; ignore those briefly so they are not re-sent as host commands.
  state.isApplyingRemote = true; state.suppressHostEventsUntil = Date.now() + 500;
  try {
    stopNudge();
    if (differentVideo) {
      const args = { videoId: playback.videoId, startSeconds: target };
      if (playback.playing) state.player.loadVideoById(args); else state.player.cueVideoById(args);
    } else {
      if (Math.abs(target - (state.player.getCurrentTime?.() || 0)) > 0.4) state.player.seekTo(Math.max(0, target), true);
      const playerState = state.player.getPlayerState?.();
      const PLAYING = window.YT?.PlayerState?.PLAYING;
      if (playback.playing && playerState !== PLAYING) state.player.playVideo();
      if (!playback.playing && playerState === PLAYING) state.player.pauseVideo();
    }
    if (playback.rate && state.player.getPlaybackRate?.() !== playback.rate) state.player.setPlaybackRate?.(playback.rate);
    state.lastAppliedRevision = Math.max(state.lastAppliedRevision, playback.revision || 0);
    syncStatus('good', isHost() ? 'You control playback' : 'In sync', isHost() ? 'Send your position to everyone' : "Jump to the host's position");
    $('playerNotice').textContent = playback.playing ? 'Playing in sync. If your browser blocked autoplay, press play inside the video once.' : 'Paused. The host controls shared playback.';
  } catch (error) {
    console.warn('Playback sync error', error);
    $('playerNotice').textContent = 'The player could not synchronise. Check that this video allows embedding.';
  }
  setTimeout(() => { state.isApplyingRemote = false; }, 500);
}

/* ---------- playback: local -> room (host) ---------- */
function sendPlayback(action, extra = {}) {
  if (!isHost()) { toast('Only the host can control playback.', 'warning'); return Promise.resolve(false); }
  const position = state.playerReady && state.player ? Math.max(0, state.player.getCurrentTime?.() || 0) : 0;
  const payload = { action, position, ...extra };
  // Remember what we just sent so the seek detector does not report the same jump twice
  // (a native seek while playing fires a "play" event AND moves the playhead).
  state.host.lastSent = { at: performance.now(), position: payload.position };
  return ack(state.socket, 'playback:command', payload).then(() => true).catch(error => { toast(error.message, 'error'); return false; });
}

/* ---------- YouTube player ---------- */
function initYouTubePlayer() {
  if (state.playerInitStarted || !window.YT?.Player) return;
  state.playerInitStarted = true;
  state.player = new window.YT.Player('youtubePlayer', {
    width: '100%', height: '100%', host: 'https://www.youtube-nocookie.com',
    playerVars: { enablejsapi: 1, origin: location.origin, playsinline: 1, autoplay: 0, controls: 1, rel: 0, iv_load_policy: 3 },
    events: {
      onReady: () => {
        state.playerReady = true;
        $('playerNotice').textContent = 'Player ready. Some videos block embedded playback.';
        if (state.latestPlayback?.videoId) applyPlayback(state.latestPlayback, { fromSnapshot: true });
        state.playerPoll = setInterval(pollPlayer, POLL_MS);
      },
      onStateChange: onPlayerStateChange,
      onPlaybackRateChange: onPlayerRateChange,
      onError: onPlayerError,
      onAutoplayBlocked: () => {
        state.autoplayBlocked = true;
        $('playerNotice').textContent = 'Your browser blocked autoplay. Press play inside the video once to allow it.';
        toast('Autoplay was blocked. Press play in the video to continue.', 'warning', 6000);
      }
    }
  });
}
window.onYouTubeIframeAPIReady = initYouTubePlayer;
if (window.YT?.Player) initYouTubePlayer();

function onPlayerError(event) {
  const errors = {
    2: 'The video ID or request is invalid.',
    5: 'The video could not be played by the HTML5 player.',
    100: 'This video is private, removed or unavailable.',
    101: 'The video owner does not allow embedded playback.',
    150: 'The video owner does not allow embedded playback.',
    153: 'YouTube did not receive a Referer or client identification. Check HTTPS hosting, the referrer policy and privacy extensions.'
  };
  const message = errors[event.data] || `YouTube player error ${event.data}.`;
  $('playerNotice').textContent = `${message} Try another video or open this one on YouTube.`;
  $('playerPlaceholder').classList.remove('is-gone');
  $('placeholderText').textContent = message;
  toast(message, 'error', 7000);
}
function onPlayerStateChange(event) {
  const YT = window.YT; if (!YT) return;
  if ([YT.PlayerState.CUED, YT.PlayerState.PLAYING, YT.PlayerState.PAUSED, YT.PlayerState.BUFFERING].includes(event.data)) {
    $('playerPlaceholder').classList.add('is-gone');
    const data = state.player?.getVideoData?.();
    if (data?.title && data.video_id === state.latestPlayback?.videoId && !titleFor(data.video_id)) $('currentVideoTitle').textContent = data.title;
  }
  if (event.data === YT.PlayerState.PLAYING) state.autoplayBlocked = false;
  if (event.data === YT.PlayerState.ENDED) onVideoEnded();
  const quiet = !isHost() || Date.now() < state.suppressHostEventsUntil || state.isApplyingRemote;
  if (!quiet) {
    const position = state.player.getCurrentTime();
    if (event.data === YT.PlayerState.PLAYING && state.lastPlayerState !== YT.PlayerState.PLAYING) sendPlayback('play', { position });
    else if (event.data === YT.PlayerState.PAUSED && state.lastPlayerState !== YT.PlayerState.PAUSED) sendPlayback('pause', { position });
  }
  state.lastPlayerState = event.data;
}
function onPlayerRateChange(event) {
  if (!isHost() || Date.now() < state.suppressHostEventsUntil || state.isApplyingRemote) return;
  if (Number.isFinite(event.data) && event.data !== state.latestPlayback?.rate) sendPlayback('rate', { rate: event.data });
}
function onVideoEnded() {
  $('playerNotice').textContent = 'This video ended.';
  if (!isHost() || !state.room?.playlist?.length) return;
  const queue = state.room.playlist;
  const index = queue.findIndex(item => item.videoId === state.latestPlayback?.videoId);
  const next = queue[index + 1] || (index === -1 ? queue[0] : null);
  if (next) { $('playerNotice').textContent = `Up next: ${next.title}`; ack(state.socket, 'playlist:play', { id: next.id }).catch(error => toast(error.message, 'error')); }
}

/* ---------- drift correction ---------- */
function stopNudge() {
  if (!state.nudge.active) return;
  state.nudge.active = false;
  try { state.player?.setPlaybackRate?.(state.latestPlayback?.rate || 1); } catch { /* player busy */ }
}
function canNudge(baseRate) {
  if (baseRate !== 1) return false;
  const rates = state.player?.getAvailablePlaybackRates?.() || [];
  return rates.includes(1.25) && rates.includes(0.75);
}
function pollPlayer() {
  if (!state.playerReady || !state.player) return;
  const current = state.player.getCurrentTime?.();
  const duration = state.player.getDuration?.();
  if (Number.isFinite(current)) {
    const label = `${formatTime(current)}${duration ? ` / ${formatTime(duration)}` : ''}`;
    if ($('playerTime').textContent !== label) $('playerTime').textContent = label;
  }
  if (!state.room || !state.latestPlayback?.videoId || !Number.isFinite(current)) { state.host.lastTime = null; return; }
  const now = performance.now();
  if (isHost()) return pollAsHost(current, now);
  stopHostTracking();

  const p = state.latestPlayback, PLAYING = window.YT?.PlayerState?.PLAYING, BUFFERING = window.YT?.PlayerState?.BUFFERING;
  const playerState = state.player.getPlayerState?.();
  if (p.playing && playerState !== PLAYING && playerState !== BUFFERING && !state.autoplayBlocked) { state.isApplyingRemote = true; state.player.playVideo(); setTimeout(() => { state.isApplyingRemote = false; }, 400); }
  if (!p.playing && playerState === PLAYING) { state.isApplyingRemote = true; state.player.pauseVideo(); setTimeout(() => { state.isApplyingRemote = false; }, 400); }

  const expected = expectedPosition(p);
  const drift = expected - current;                 // positive: we are behind the host
  const abs = Math.abs(drift);
  if (!p.playing) {
    if (abs > 0.3) { state.player.seekTo(expected, true); }
    syncStatus('good', 'In sync'); return;
  }
  const baseRate = p.rate || 1;
  if (abs > HARD_SEEK_SECONDS || (abs > NUDGE_SECONDS && !canNudge(baseRate))) {
    stopNudge();
    try { state.player.seekTo(expected, true); syncStatus('warn', 'Catching up', `Jumped ${drift > 0 ? 'forward' : 'back'} ${abs.toFixed(1)}s`); } catch { /* buffering */ }
  } else if (abs > NUDGE_SECONDS) {
    const wanted = drift > 0 ? 1.25 : 0.75;
    if (!state.nudge.active || state.player.getPlaybackRate?.() !== wanted) { state.nudge.active = true; state.player.setPlaybackRate(wanted); }
    syncStatus('warn', 'Catching up', `Off by ${Math.round(abs * 1000)} ms`);
  } else {
    if (state.nudge.active && (abs < SETTLED_SECONDS || Math.sign(drift) !== Math.sign(state.nudge.lastSign || drift))) stopNudge();
    else if (!state.nudge.active) syncStatus('good', 'In sync', `Within ${Math.max(10, Math.round(abs * 1000))} ms of the host`);
  }
  state.nudge.lastSign = Math.sign(drift);
}
function stopHostTracking() { state.host.lastTime = null; }
function pollAsHost(current, now) {
  stopNudge();
  const playing = state.player.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
  const rate = state.player.getPlaybackRate?.() || 1;
  const quiet = Date.now() < state.suppressHostEventsUntil || state.isApplyingRemote;
  if (state.host.lastTime !== null && !quiet) {
    const elapsed = (now - state.host.lastAt) / 1000;
    const expected = state.host.lastTime + (playing ? elapsed * rate : 0);
    const sent = state.host.lastSent;
    const alreadySent = sent && now - sent.at < 500 && Math.abs(sent.position - current) < 1.5;
    if (Math.abs(current - expected) > HOST_JUMP_SECONDS && !alreadySent) sendPlayback('seek', { position: current });
  }
  state.host.lastTime = current; state.host.lastAt = now;
}

/* ---------- forms and actions ---------- */
function inviteUrl() {
  const url = new URL(location.href); url.hash = ''; url.search = '';
  if (state.roomCode) url.searchParams.set('room', state.roomCode);
  return url.toString();
}
async function copyInvite() {
  if (!state.roomCode) return toast('Create or join a room first.', 'warning');
  const link = inviteUrl();
  try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
  catch {
    const input = $('inviteLinkInput'); input.value = link; showView('room'); input.focus(); input.select();
    toast('Copy failed. The link is selected, press Ctrl or Cmd+C.', 'warning');
  }
}
async function submitRoomForm(event) {
  event.preventDefault(); $('roomFormError').hidden = true;
  const name = $('displayName').value.trim();
  if (!name || name.length > 24) return showFormError('roomFormError', 'Enter a display name of 1 to 24 characters.');
  const code = (state.modalMode === 'join' ? $('roomCodeInput').value : $('customRoomCode').value).trim().toUpperCase();
  if (state.modalMode === 'join' && !code) return showFormError('roomFormError', "Enter the room code your friend shared.");
  if (state.modalMode === 'create' && code && !/^[A-Z0-9]{4,12}$/.test(code)) return showFormError('roomFormError', 'Custom codes use 4 to 12 letters or numbers.');
  const submit = $('roomFormSubmit'); const label = submit.textContent; submit.disabled = true; submit.textContent = 'Connecting';
  try {
    await ensureConnected();
    const created = state.modalMode === 'create';
    const result = created ? await ack(state.socket, 'room:create', { name, code: code || undefined }) : await ack(state.socket, 'room:join', { name, code });
    state.displayName = name; state.resumeToken = result.resumeToken; state.roomCode = result.snapshot.code;
    store.set('displayName', name); store.set('resumeToken', state.resumeToken); store.set('roomCode', state.roomCode);
    state.meId = result.participantId || state.meId;
    applySnapshot(result.snapshot, result.participantId);
    state.pendingJoinCode = ''; closeDialogs();
    const url = new URL(location.href); url.searchParams.set('room', state.roomCode); history.replaceState({}, '', url);
    showView('watch');
    toast(created ? `Room ${state.roomCode} is ready. Copy the invite link from the top bar.` : `Joined room ${state.roomCode}.`);
    if (created && state.pendingVideo) { const { id, title } = state.pendingVideo; state.pendingVideo = null; await chooseVideo(id, title); }
  } catch (error) { showFormError('roomFormError', error.message); }
  finally { submit.disabled = false; submit.textContent = label; }
}
async function leaveRoom() {
  if (!state.room) return;
  try { await ack(state.socket, 'room:leave', {}); } catch (error) { console.warn(error); }
  store.remove('roomCode'); store.remove('resumeToken'); state.resumeToken = '';
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState({}, '', url);
  resetRoomUi(); showView('home'); toast('You left the room.');
}
async function submitVideoForm(event) {
  event.preventDefault();
  const input = $('youtubeUrlInput'); const id = extractYouTubeId(input.value);
  if (!id) return toast('Paste a YouTube watch, short, embed or live link, or an 11-character video ID.', 'error');
  const done = isHost() ? await chooseVideo(id, titleFor(id) || 'YouTube video') : await queueVideo(id);
  if (done) { input.value = ''; updateCommandActions(); }
}

function setupEvents() {
  // navigation
  document.querySelectorAll('#viewNav button').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  $('brandLink').addEventListener('click', event => { event.preventDefault(); showView(state.room ? 'watch' : 'home'); });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('viewNav').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('#viewNav button')].filter(b => b.offsetParent !== null);
    const index = buttons.indexOf(document.activeElement); if (index < 0) return;
    event.preventDefault(); buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  document.addEventListener('keydown', event => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !document.querySelector('dialog[open]')) { event.preventDefault(); showView('discover'); $('searchInput').focus(); }
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { $('reactionTray').hidden = true; $('reactionToggle').setAttribute('aria-expanded', 'false'); }
  });

  // rooms
  $('createRoomButton').addEventListener('click', () => setRoomFormMode('create'));
  $('joinRoomButton').addEventListener('click', () => setRoomFormMode('join', state.pendingJoinCode));
  $('roomForm').addEventListener('submit', submitRoomForm);
  $('roomChip').addEventListener('click', copyInvite); $('copyInvite').addEventListener('click', copyInvite);
  $('leaveRoomButton').addEventListener('click', leaveRoom);
  $('syncChip').addEventListener('click', () => {
    if (!state.room) return;
    if (isHost()) sendPlayback('seek', { position: state.player?.getCurrentTime?.() || 0 }).then(ok => ok && toast('Sent your position to everyone.'));
    else if (state.latestPlayback) { const expected = expectedPosition(state.latestPlayback); state.player?.seekTo(expected, true); if (state.latestPlayback.playing) state.player?.playVideo(); toast('Re-synced to the host.'); }
  });

  // dialogs
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeDialogs));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  $('settingsButton').addEventListener('click', () => { $('serverUrlInput').value = state.serverUrl; openDialog('settingsDialog'); });
  $('settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const url = $('serverUrlInput').value.trim().replace(/\/$/, '');
    try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); } catch { return toast('Enter a valid http or https address.', 'error'); }
    if (url !== state.serverUrl && state.room) await leaveRoom();
    state.serverUrl = url; store.set('serverUrl', url); connect(); closeDialogs(); toast('Saved. Connecting.');
  });
  $('resetServerUrl').addEventListener('click', async () => {
    if (state.room && state.serverUrl !== DEFAULT_SERVER_URL) await leaveRoom();
    state.serverUrl = DEFAULT_SERVER_URL; store.set('serverUrl', DEFAULT_SERVER_URL); $('serverUrlInput').value = DEFAULT_SERVER_URL; connect(); toast('Using the default server.');
  });

  // watch
  $('videoForm').addEventListener('submit', submitVideoForm);
  $('youtubeUrlInput').addEventListener('input', updateCommandActions);
  $('addToPlaylist').addEventListener('click', async () => { const id = extractYouTubeId($('youtubeUrlInput').value); if (id && await queueVideo(id)) { $('youtubeUrlInput').value = ''; updateCommandActions(); } });
  $('chatForm').addEventListener('submit', withToast(async event => {
    event.preventDefault(); const input = $('chatInput'), text = input.value.trim(); if (!text) return;
    await ack(state.socket, 'chat:send', { text }); input.value = '';
  }));
  $('reactionToggle').addEventListener('click', () => {
    const open = $('reactionTray').hidden; $('reactionTray').hidden = !open; $('reactionToggle').setAttribute('aria-expanded', String(open));
    if (open) $('reactionTray').querySelector('button').focus();
  });
  $('reactionTray').addEventListener('click', withToast(async event => {
    const button = event.target.closest('[data-emoji]'); if (!button) return;
    await ack(state.socket, 'reaction:send', { emoji: button.dataset.emoji });
    $('reactionTray').hidden = true; $('reactionToggle').setAttribute('aria-expanded', 'false'); $('reactionToggle').focus();
  }));

  // polls
  $('newPollButton').addEventListener('click', () => { $('pollQuestion').value = ''; $('pollOptions').value = ''; $('pollFormError').hidden = true; openDialog('pollDialog'); });
  $('pollForm').addEventListener('submit', async event => {
    event.preventDefault();
    const question = $('pollQuestion').value.trim();
    const options = [...new Set($('pollOptions').value.split('\n').map(x => x.trim()).filter(Boolean))];
    if (!question || options.length < 2 || options.length > 6) return showFormError('pollFormError', 'Add a question and 2 to 6 different options.');
    try { await ack(state.socket, 'poll:create', { question, options }); closeDialogs(); toast('Poll created.'); }
    catch (error) { showFormError('pollFormError', error.message); }
  });

  bindGallery();
  bindHomeParallax();
}

/* The one decorative motion: the home screen tilts a few degrees toward the pointer. */
function bindHomeParallax() {
  const stage = $('homeStage');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover)').matches) return;
  let frame = 0;
  document.querySelector('.view-home').addEventListener('pointermove', event => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const x = event.clientX / window.innerWidth - .5, y = event.clientY / window.innerHeight - .5;
      stage.style.setProperty('--ry', `${(x * 14).toFixed(2)}deg`); stage.style.setProperty('--rx', `${(-y * 10).toFixed(2)}deg`);
    });
  });
}

/* ---------- boot ---------- */
setupEvents();
renderGallery();
showView(location.hash.slice(1) || 'home', { focus: false });
connect();
setTimeout(() => { if (!window.YT?.Player) $('playerNotice').textContent = 'The YouTube player has not loaded. Check your network, browser extensions, or reload.'; }, 12000);
if (state.pendingJoinCode) setTimeout(() => setRoomFormMode('join', state.pendingJoinCode), 250);
