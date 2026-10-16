import { extractYouTubeId } from './youtube-utils.js';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback = '') { try { return localStorage.getItem(`syncvibe.${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`syncvibe.${key}`, value); } catch {} },
  remove(key) { try { localStorage.removeItem(`syncvibe.${key}`); } catch {} }
};
const recommendations = [
  { id: 'LXb3EKWsInQ', title: 'Costa Rica in 4K 60fps', category: 'Nature', vibe: 'relax travel ocean mountains', creator: '4K Scenic Relaxation' },
  { id: 'jfKfPfyJRdk', title: 'lofi hip hop radio', category: 'Music', vibe: 'study chill beats focus', creator: 'Lofi Girl' },
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', category: 'Classics', vibe: 'retro pop nostalgic music', creator: 'Rick Astley' },
  { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny — Blender Open Movie', category: 'Classics', vibe: 'animation short film open movie', creator: 'Blender Studio' },
  { id: 'jNQXAC9IVRw', title: 'Me at the zoo', category: 'Classics', vibe: 'history first youtube video', creator: 'Jawed Karim' },
  { id: 'ScMzIvxBSi4', title: 'Relaxing nature ambience', category: 'Nature', vibe: 'calm ambient rain background', creator: 'Nature ambience' },
  { id: 'ysz5S6PUM-U', title: 'Creative Commons video sample', category: 'Learning', vibe: 'sample demo learning video', creator: 'Video sample' },
  { id: 'M7lc1UVf-VE', title: 'YouTube IFrame API demo', category: 'Learning', vibe: 'developer api demo tutorial', creator: 'YouTube Developers' }
];
const state = {
  socket: null, player: null, playerReady: false, playerInitStarted: false, room: null, meId: null,
  resumeToken: store.get('resumeToken'), roomCode: store.get('roomCode'), displayName: store.get('displayName'),
  latestPlayback: null, lastAppliedRevision: -1, lastHostTime: null, suppressHostEventsUntil: 0,
  modalMode: 'create', pendingJoinCode: new URL(location.href).searchParams.get('room')?.toUpperCase() || '',
  chatIds: new Set(), serverUrl: store.get('serverUrl', window.SYNCVIBE_SERVER_URL || 'http://localhost:3000'),
  lastPlayerState: -1, playerPoll: null, isApplyingRemote: false, serverClockOffset: 0, autoplayBlocked: false
};

function toast(message, type = 'success', duration = 3500) {
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message; $('toastRegion').append(el);
  window.setTimeout(() => el.remove(), duration);
}
function setConnection(kind, text) {
  $('connectionDot').className = `status-dot ${kind}`; $('connectionText').textContent = text;
}
function showModal(id) {
  $('modalBackdrop').classList.remove('hidden');
  ['roomModal','settingsModal','inviteModal','pollModal'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  const focusable = $(id).querySelector('input,textarea,button'); focusable?.focus();
}
function closeModal() { $('modalBackdrop').classList.add('hidden'); ['roomModal','settingsModal','inviteModal','pollModal'].forEach(id => $(id).classList.add('hidden')); }
function setRoomFormMode(mode, code = '') {
  state.modalMode = mode;
  $('roomModalTitle').textContent = mode === 'create' ? 'Create your room' : 'Join a room';
  $('roomModalDescription').textContent = mode === 'create' ? 'Choose a display name and invite your people.' : 'Enter your name and the room code your friend shared.';
  $('roomFormSubmit').textContent = mode === 'create' ? 'Create room' : 'Join room';
  $('roomCodeField').classList.toggle('hidden', mode !== 'join');
  $('customCodeField').classList.toggle('hidden', mode !== 'create');
  $('roomCodeInput').value = code;
  if (mode === 'create') $('customRoomCode').value = '';
  $('roomFormError').classList.add('hidden');
  $('displayName').value = state.displayName || '';
  showModal('roomModal');
}
function showErrorInRoomForm(message) { $('roomFormError').textContent = message; $('roomFormError').classList.remove('hidden'); }
function ack(socket, event, payload, timeout = 7000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Not connected to the realtime server. Check Settings and try again.'));
    socket.timeout(timeout).emit(event, payload, (error, result) => {
      if (error) return reject(new Error('The server did not respond in time. Please try again.'));
      if (!result?.ok) return reject(new Error(result?.error || 'The request failed.'));
      resolve(result);
    });
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—:—';
  const n = Math.floor(seconds), h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
function initials(name) { return (name || '?').trim().split(/\s+/).slice(0,2).map(s => s[0] || '').join('').toUpperCase(); }
function timeLabel(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function connect() {
  if (typeof window.io !== 'function') { setConnection('', 'Socket.IO unavailable'); toast('Could not load the realtime client. Check your connection and reload.', 'error', 6000); return; }
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
  setConnection('connecting', 'Connecting…');
  state.socket = window.io(state.serverUrl, { transports: ['websocket','polling'], auth: { resumeToken: state.resumeToken || undefined }, reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });
  const socket = state.socket;
  socket.on('connect', () => { setConnection('connected', 'Connected'); measureClockOffset(socket); if (!state.room) toast('Connected to SyncVibe server. Create a room or join with a code.'); });
  socket.on('connect_error', err => { setConnection('connecting', 'Reconnecting…'); $('playerNotice').textContent = `Server connection issue: ${err.message}. Check Settings if this persists.`; });
  socket.on('disconnect', reason => { setConnection('connecting', 'Reconnecting…'); toast(`Connection lost (${reason}). Reconnecting automatically…`, 'warning', 5000); });
  socket.on('room:resumed', data => {
    if (!data?.ok) return;
    state.resumeToken = data.resumeToken; state.meId = data.participantId || state.meId; store.set('resumeToken', state.resumeToken); applySnapshot(data.snapshot, data.participantId); toast('Welcome back — your room session was restored.');
  });
  socket.on('room:snapshot', snapshot => applySnapshot(snapshot));
  socket.on('playback:state', playback => applyPlayback(playback));
  socket.on('chat:message', message => appendChatMessage(message));
  socket.on('reaction:new', reaction => { showFloatingReaction(reaction.emoji); addReactionFeed(reaction); });
  if (state.playerReady && state.latestPlayback) applyPlayback(state.latestPlayback);
}
function measureClockOffset(socket) {
  // Estimate server-minus-client clock offset from low-RTT samples; never assume device clocks match.
  const samples = [];
  let attempts = 0;
  const ping = () => {
    if (!socket.connected || attempts >= 5) {
      if (samples.length) { samples.sort((a,b)=>a.rtt-b.rtt); state.serverClockOffset = samples[0].offset; }
      return;
    }
    attempts += 1; const sent = Date.now();
    socket.timeout(2500).emit('sync:ping', { clientSentAt: sent }, (err, result) => {
      const received = Date.now();
      if (!err && result?.serverSentAt) samples.push({ rtt: received - sent, offset: result.serverSentAt - (sent + received) / 2 });
      if (attempts < 5) setTimeout(ping, 80); else if (samples.length) { samples.sort((a,b)=>a.rtt-b.rtt); state.serverClockOffset = samples[0].offset; }
    });
  };
  ping();
}
function serverNow() { return Date.now() + state.serverClockOffset; }

function ensureConnected() {
  if (state.socket?.connected) return Promise.resolve();
  if (!state.socket) connect();
  return new Promise((resolve, reject) => {
    const socket = state.socket; if (!socket) return reject(new Error('Socket.IO failed to initialize.'));
    const timer = setTimeout(() => { socket.off('connect', connected); reject(new Error('Could not connect. Check that your backend is running and the URL is correct.')); }, 10000);
    function connected() { clearTimeout(timer); resolve(); }
    socket.once('connect', connected);
  });
}
function applySnapshot(snapshot, selfId = null) {
  if (!snapshot?.code) return;
  const previousRoomCode = state.room?.code;
  if (previousRoomCode && previousRoomCode !== snapshot.code) {
    state.chatIds.clear(); $('chatMessages').replaceChildren(); $('reactionFeed').innerHTML = '<p class="muted small">Reactions from the room will show up here.</p>';
  }
  state.room = snapshot; state.roomCode = snapshot.code; store.set('roomCode', snapshot.code);
  if (selfId) state.meId = selfId;
  const mine = snapshot.members?.find(m => m.id === state.meId) || null;
  state.latestPlayback = snapshot.playback || state.latestPlayback;
  $('sidebarRoomCode').textContent = snapshot.code;
  $('detailRoomCode').textContent = snapshot.code;
  $('roomSubtitle').textContent = `${snapshot.members?.filter(m => m.connected).length || 0} people sharing this room`;
  $('roomHeading').textContent = `Room ${snapshot.code} is ready.`;
  $('roomDescription').textContent = mine?.isHost ? 'You are hosting. Choose a video and your room will follow along.' : 'You are watching together. Playback follows the current host.';
  $('hostPill').textContent = mine?.isHost ? '✦ You are host' : 'Following host'; $('hostPill').classList.toggle('host', !!mine?.isHost);
  $('detailHost').textContent = snapshot.members?.find(m => m.id === snapshot.hostId)?.name || '—';
  const connected = (snapshot.members || []).filter(m => m.connected);
  $('onlineCount').textContent = `${connected.length} online`; $('peopleCount').textContent = String(snapshot.members?.length || 0); $('detailOnline').textContent = String(connected.length);
  $('playlistCount').textContent = String(snapshot.playlist?.length || 0); $('playlistHeadingCount').textContent = String(snapshot.playlist?.length || 0);
  $('inviteButton').disabled = false; $('sidebarInvite').disabled = false; $('leaveRoomButton').disabled = false; $('newPollButton').disabled = false;
  $('chatInput').disabled = false; $('chatForm').querySelector('button').disabled = false;
  $('addToPlaylist').disabled = !snapshot.playback?.videoId;
  ['playButton','pauseButton','backButton','forwardButton','playbackRate','resyncButton'].forEach(id => $(id).disabled = !mine?.isHost || !state.playerReady || !snapshot.playback?.videoId);
  renderPeople(snapshot); renderPlaylist(snapshot); renderPolls(snapshot);
  (snapshot.messages || []).forEach(m => appendChatMessage(m));
  if (snapshot.playback?.videoId) applyPlayback(snapshot.playback);
  else {
    if (state.playerReady) state.player?.stopVideo?.();
    $('playerPlaceholder').classList.remove('hidden'); $('currentVideoTitle').textContent = 'No video selected'; $('currentVideoSub').textContent = 'Paste a YouTube link or pick something below.'; $('openYoutube').href = '#'; $('openYoutube').classList.add('disabled'); $('addToPlaylist').disabled = true;
    $('syncLabel').textContent = 'Ready when you are'; $('playerNotice').textContent = 'Paste a YouTube URL above or choose a curated recommendation.';
  }
}
function renderPeople(snapshot) {
  const list = $('peopleList'); list.replaceChildren();
  const members = snapshot.members || [];
  if (!members.length) { list.innerHTML = '<div class="empty-state">No participants yet.</div>'; return; }
  members.forEach(member => {
    const row = document.createElement('div'); row.className = 'person-row';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = initials(member.name);
    const name = document.createElement('span'); name.className = 'person-name'; name.textContent = member.name;
    row.append(avatar, name);
    if (member.id === snapshot.hostId) { const tag = document.createElement('span'); tag.className = 'host-tag'; tag.textContent = 'HOST'; row.append(tag); }
    else if (member.connected && state.meId === snapshot.hostId) { const transfer = document.createElement('button'); transfer.className = 'mini-action transfer-button'; transfer.textContent = 'Make host'; transfer.addEventListener('click', async () => { try { await ack(state.socket,'host:transfer',{memberId:member.id}); toast(`${member.name} is now host.`); } catch(e) { toast(e.message,'error'); } }); row.append(transfer); }
    const status = document.createElement('span'); status.className = member.connected ? 'person-status' : 'muted tiny'; status.textContent = member.connected ? '●' : 'offline'; status.title = member.connected ? 'Connected' : 'Reconnecting'; row.append(status); list.append(row);
  });
}
function renderPlaylist(snapshot) {
  const list = $('playlistItems'); list.replaceChildren(); const items = snapshot.playlist || [];
  if (!items.length) { list.innerHTML = '<div class="empty-state">Your shared queue is empty. Add a video to get started.</div>'; return; }
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'playlist-item';
    const img = document.createElement('img'); img.className = 'playlist-thumb'; img.loading = 'lazy'; img.alt = ''; img.src = `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`; img.onerror = () => { img.style.visibility = 'hidden'; };
    const copy = document.createElement('div'); copy.className = 'playlist-copy'; const title = document.createElement('strong'); title.textContent = `${index + 1}. ${item.title}`; const by = document.createElement('span'); by.textContent = `Added by ${item.addedBy}`; copy.append(title, by);
    const actions = document.createElement('div'); actions.className = 'playlist-actions';
    const play = document.createElement('button'); play.className = 'mini-action'; play.textContent = '▶'; play.title = 'Play this video'; play.disabled = state.meId !== snapshot.hostId; play.addEventListener('click', async () => { try { await ack(state.socket,'playlist:play',{id:item.id}); } catch(e) { toast(e.message,'error'); } }); actions.append(play);
    if (state.meId === snapshot.hostId) { const remove = document.createElement('button'); remove.className = 'mini-action'; remove.textContent = '×'; remove.title = 'Remove from queue'; remove.addEventListener('click', async () => { try { await ack(state.socket,'playlist:remove',{id:item.id}); } catch(e) { toast(e.message,'error'); } }); actions.append(remove); }
    row.append(img,copy,actions); list.append(row);
  });
}
function renderPolls(snapshot) {
  const list = $('pollsList'); list.replaceChildren(); const polls = snapshot.polls || [];
  if (!polls.length) { list.innerHTML = '<div class="empty-state">Create a room poll and let everyone vote.</div>'; return; }
  polls.slice().reverse().forEach(poll => {
    const card = document.createElement('article'); card.className = 'poll-card'; const title = document.createElement('h3'); title.textContent = poll.question; card.append(title);
    const counts = Object.fromEntries(poll.options.map(o => [o, Object.values(poll.votes || {}).filter(v => v === o).length])); const total = Object.values(counts).reduce((a,b)=>a+b,0);
    poll.options.forEach(option => {
      const count = counts[option] || 0, percent = total ? Math.round(count / total * 100) : 0;
      const button = document.createElement('button'); button.className = `poll-option ${poll.votes?.[state.meId] === option ? 'voted' : ''}`; button.disabled = poll.closed;
      const progress = document.createElement('span'); progress.className = 'poll-progress'; progress.style.width = `${percent}%`;
      const label = document.createElement('span'); label.className = 'poll-option-label'; const text = document.createElement('span'); text.textContent = option; const countText = document.createElement('span'); countText.textContent = `${percent}% · ${count}`; label.append(text,countText); button.append(progress,label);
      button.addEventListener('click', async () => { try { await ack(state.socket,'poll:vote',{pollId:poll.id,option}); } catch(e) { toast(e.message,'error'); } }); card.append(button);
    });
    const foot = document.createElement('div'); foot.className = 'poll-foot'; const by = document.createElement('span'); by.textContent = `By ${poll.createdBy} · ${total} vote${total === 1 ? '' : 's'}`; const status = document.createElement('span'); status.textContent = poll.closed ? 'Closed' : 'Open'; foot.append(by,status); card.append(foot);
    if (!poll.closed && state.meId === snapshot.hostId) { const close = document.createElement('button'); close.className = 'mini-action'; close.textContent = 'Close poll'; close.style.marginTop = '8px'; close.addEventListener('click', async () => { try { await ack(state.socket,'poll:close',{pollId:poll.id}); } catch(e) { toast(e.message,'error'); } }); card.append(close); }
    list.append(card);
  });
}
function appendChatMessage(message) {
  if (!message?.id || state.chatIds.has(message.id)) return;
  state.chatIds.add(message.id); if (state.chatIds.size > 250) state.chatIds.delete(state.chatIds.values().next().value);
  const container = $('chatMessages'); if (container.querySelector('.empty-state')) container.replaceChildren();
  const row = document.createElement('div'); row.className = 'chat-message'; const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = initials(message.name);
  const body = document.createElement('div'); body.className = 'chat-message-body'; const head = document.createElement('div'); head.className = 'chat-message-head'; const name = document.createElement('strong'); name.textContent = message.name || 'Guest'; const time = document.createElement('time'); time.textContent = timeLabel(message.at || Date.now()); const text = document.createElement('p'); text.textContent = message.text || '';
  head.append(name,time); body.append(head,text); row.append(avatar,body); container.append(row); container.scrollTop = container.scrollHeight;
}
function addReactionFeed(reaction) {
  const feed = $('reactionFeed'); if (feed.querySelector('p')) feed.replaceChildren();
  const row = document.createElement('div'); row.className = 'reaction-entry'; const emoji = document.createElement('span'); emoji.textContent = reaction.emoji; const text = document.createElement('span'); text.textContent = `${reaction.name} reacted`;
  row.append(emoji,text); feed.prepend(row); while (feed.children.length > 12) feed.lastElementChild.remove();
}
function showFloatingReaction(emoji) {
  const overlay = $('reactionOverlay'); const el = document.createElement('span'); el.className = 'reaction-float'; el.textContent = emoji; el.style.left = `${10 + Math.random() * 75}%`; overlay.append(el); setTimeout(() => el.remove(), 2500);
}
function renderRecommendations(items = recommendations) {
  const grid = $('recommendationsGrid'); grid.replaceChildren(); $('emptySearch').classList.toggle('hidden', items.length !== 0);
  items.forEach(item => {
    const button = document.createElement('button'); button.className = 'video-tile'; button.type = 'button'; button.setAttribute('aria-label', `Load ${item.title}`);
    const thumb = document.createElement('div'); thumb.className = 'video-thumb'; const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`; img.onerror = () => { img.style.opacity = '.25'; }; const tag = document.createElement('span'); tag.className = 'category-tag'; tag.textContent = item.category; thumb.append(img,tag);
    const copy = document.createElement('div'); copy.className = 'video-tile-copy'; const title = document.createElement('strong'); title.textContent = item.title; const creator = document.createElement('span'); creator.textContent = item.creator; copy.append(title,creator); button.append(thumb,copy); button.addEventListener('click', () => chooseVideo(item.id, item.title)); grid.append(button);
  });
}
function fuzzySearch(query, category) {
  const q = query.trim().toLowerCase();
  const levenshtein = (a,b) => { if (Math.abs(a.length-b.length)>Math.max(2,Math.floor(b.length*.4))) return 99; let prev=Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++){let cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}return prev[b.length]; };
  return recommendations.filter(item => category === 'all' || item.category === category).map(item => {
    const corpus = `${item.title} ${item.category} ${item.vibe} ${item.creator}`.toLowerCase();
    let score = !q || corpus.includes(q) ? 0 : Math.min(...corpus.split(/\s+/).map(word => levenshtein(word,q)));
    return { item, score };
  }).filter(result => !q || result.score <= Math.max(1, Math.floor(q.length * .3)) || `${result.item.title} ${result.item.vibe}`.toLowerCase().includes(q))
    .sort((a,b)=>a.score-b.score).map(result=>result.item);
}

async function chooseVideo(videoId, title) {
  if (!state.room) { $('youtubeUrlInput').value = `https://www.youtube.com/watch?v=${videoId}`; toast('Create or join a room before loading a shared video.', 'warning'); setRoomFormMode('create'); return false; }
  if (state.meId !== state.room.hostId) { toast('Only the host can change the shared video.', 'warning'); return false; }
  try { await ack(state.socket,'playback:command',{action:'load',videoId,position:0,playing:false}); $('playerNotice').textContent = `Loading “${title}” for everyone in the room.`; return true; }
  catch(e) { toast(e.message,'error'); return false; }
}
function applyPlayback(playback) {
  if (!playback?.videoId || !VIDEO_ID_RE.test(playback.videoId)) { state.latestPlayback = playback || null; return; }
  if (Number.isFinite(playback.revision) && playback.revision < state.lastAppliedRevision) return;
  state.latestPlayback = playback;
  $('addToPlaylist').disabled = !state.room || !playback.videoId;
  if (playback.rate) $('playbackRate').value = String(playback.rate);
  const recForMetadata = recommendations.find(r => r.id === playback.videoId);
  if (recForMetadata) $('currentVideoTitle').textContent = recForMetadata.title;
  else if (!$('currentVideoTitle').textContent || $('currentVideoTitle').textContent === 'No video selected') $('currentVideoTitle').textContent = `YouTube video ${playback.videoId}`;
  $('currentVideoSub').textContent = `Shared video · ${playback.videoId}`;
  $('openYoutube').href = `https://www.youtube.com/watch?v=${encodeURIComponent(playback.videoId)}`;
  $('openYoutube').classList.remove('disabled');
  if (!state.playerReady || !state.player) return;
  const target = Math.max(0, playback.position + (playback.playing ? (serverNow() - (playback.updatedAt || playback.serverNow || serverNow())) / 1000 * (playback.rate || 1) : 0));
  const currentId = state.player.getVideoData?.().video_id;
  const differentVideo = currentId !== playback.videoId;
  state.isApplyingRemote = true; state.suppressHostEventsUntil = Date.now() + 1300;
  try {
    if (differentVideo) {
      if (playback.playing) state.player.loadVideoById({ videoId: playback.videoId, startSeconds: target });
      else state.player.cueVideoById({ videoId: playback.videoId, startSeconds: target });
      const rec = recommendations.find(r => r.id === playback.videoId); $('currentVideoTitle').textContent = rec?.title || `YouTube video ${playback.videoId}`;
      $('currentVideoSub').textContent = `Shared by your room · ${playback.videoId}`; $('openYoutube').href = `https://www.youtube.com/watch?v=${playback.videoId}`; $('openYoutube').classList.remove('disabled'); $('playerPlaceholder').classList.add('hidden');
    } else {
      const current = state.player.getCurrentTime?.() || 0; const drift = target - current;
      if (Math.abs(drift) > 0.5) state.player.seekTo(Math.max(0,target), true);
      const playerState = state.player.getPlayerState?.();
      if (playback.playing && playerState !== window.YT?.PlayerState?.PLAYING) state.player.playVideo();
      if (!playback.playing && playerState === window.YT?.PlayerState?.PLAYING) state.player.pauseVideo();
    }
    if (playback.rate && state.player.setPlaybackRate) state.player.setPlaybackRate(playback.rate);
    state.lastAppliedRevision = Math.max(state.lastAppliedRevision, playback.revision || 0);
    $('syncLabel').textContent = state.meId === state.room?.hostId ? 'You control playback' : 'Following host'; $('syncLabel').title = `Last playback revision ${playback.revision ?? '—'}`;
    $('syncLabel').previousElementSibling?.classList.add('good');
    $('playerNotice').textContent = playback.playing ? 'Playing in sync. If autoplay is blocked, press play inside the video.' : 'Video ready. The host controls shared playback.';
    $('playButton').disabled = state.meId !== state.room?.hostId; $('pauseButton').disabled = state.meId !== state.room?.hostId; $('backButton').disabled = state.meId !== state.room?.hostId; $('forwardButton').disabled = state.meId !== state.room?.hostId; $('playbackRate').disabled = state.meId !== state.room?.hostId; $('resyncButton').disabled = state.meId !== state.room?.hostId;
  } catch (error) { console.warn('Playback sync error', error); $('playerNotice').textContent = 'The player could not synchronize. Check if this video allows embedding.'; }
  setTimeout(() => { state.isApplyingRemote = false; }, 500);
}
function sendPlayback(action, extra = {}) {
  if (!state.room || state.meId !== state.room.hostId) return toast('Only the host can control playback.', 'warning');
  const position = state.playerReady && state.player ? Math.max(0, state.player.getCurrentTime?.() || 0) : 0;
  return ack(state.socket,'playback:command',{action,position,...extra}).then(() => {
    state.suppressHostEventsUntil = Date.now() + 1400;
    if (action === 'play') state.player?.playVideo();
    if (action === 'pause') state.player?.pauseVideo();
    if (action === 'seek') state.player?.seekTo(extra.position, true);
    if (action === 'rate') state.player?.setPlaybackRate(extra.rate);
  }).then(() => true).catch(e => { toast(e.message,'error'); return false; });
}
function initYouTubePlayer() {
  if (state.playerInitStarted || !window.YT?.Player) return;
  state.playerInitStarted = true;
  state.player = new window.YT.Player('youtubePlayer', {
    width: '100%', height: '100%', host: 'https://www.youtube-nocookie.com',
    playerVars: { enablejsapi: 1, origin: location.origin, playsinline: 1, autoplay: 0, controls: 1, rel: 0, iv_load_policy: 3 },
    events: { onReady: () => {
      state.playerReady = true; $('playerNotice').textContent = 'YouTube player ready. Some videos may block embedded playback.';
      if (state.latestPlayback?.videoId) applyPlayback(state.latestPlayback);
      state.playerPoll = setInterval(pollPlayer, 800);
    }, onStateChange: onPlayerStateChange, onError: onPlayerError, onAutoplayBlocked: () => { state.autoplayBlocked = true; $('playerNotice').textContent = 'Your browser blocked autoplay. Press play inside the video once to allow playback.'; toast('Autoplay was blocked by your browser. Tap play in the video to continue.', 'warning', 6000); } }
  });
}
window.onYouTubeIframeAPIReady = initYouTubePlayer;
if (window.YT?.Player) initYouTubePlayer();
function onPlayerError(event) {
  const errors = { 2:'The video ID or request is invalid.', 5:'The video could not be played by YouTube’s HTML5 player.', 100:'This video is private, removed, or unavailable.', 101:'The video owner does not allow embedded playback.', 150:'The video owner does not allow embedded playback.', 153:'YouTube did not receive a Referer or equivalent client identification. Check HTTPS hosting, the page referrer policy, and privacy extensions.' };
  const message = errors[event.data] || `YouTube player error ${event.data}.`;
  $('playerNotice').textContent = `${message} You can try another video or open this one on YouTube.`; $('playerPlaceholder').classList.remove('hidden'); toast(message,'error',7000);
}
function onPlayerStateChange(event) {
  const YT = window.YT; if (!YT) return;
  if ([YT.PlayerState.CUED, YT.PlayerState.PLAYING, YT.PlayerState.PAUSED, YT.PlayerState.BUFFERING].includes(event.data)) {
    $('playerPlaceholder').classList.add('hidden');
    const data = state.player?.getVideoData?.();
    if (data?.title && data.video_id === state.latestPlayback?.videoId) { const rec = recommendations.find(r => r.id === data.video_id); $('currentVideoTitle').textContent = rec?.title || data.title; }
  }
  if (event.data === YT.PlayerState.PLAYING) state.autoplayBlocked = false;
  if (event.data === YT.PlayerState.ENDED) $('playerNotice').textContent = 'This video ended. The host can choose another video from the queue.';
  if (!state.room || state.meId !== state.room.hostId || Date.now() < state.suppressHostEventsUntil || state.isApplyingRemote) { state.lastPlayerState = event.data; return; }
  if (event.data === YT.PlayerState.PLAYING && state.lastPlayerState !== YT.PlayerState.PLAYING) {
    ack(state.socket,'playback:command',{action:'play',position:state.player.getCurrentTime()}).catch(e=>console.warn(e));
  } else if (event.data === YT.PlayerState.PAUSED && state.lastPlayerState !== YT.PlayerState.PAUSED) {
    ack(state.socket,'playback:command',{action:'pause',position:state.player.getCurrentTime()}).catch(e=>console.warn(e));
  }
  state.lastPlayerState = event.data;
}
function pollPlayer() {
  if (!state.playerReady || !state.player) return;
  const current = state.player.getCurrentTime?.();
  if (Number.isFinite(current)) $('playerTime').textContent = `${formatTime(current)}${state.player.getDuration?.() ? ` / ${formatTime(state.player.getDuration())}` : ''}`;
  if (!state.room || !state.latestPlayback?.videoId || !Number.isFinite(current)) { state.lastHostTime = current; return; }
  if (state.meId !== state.room.hostId) {
    const p = state.latestPlayback;
    const expected = Math.max(0, p.position + (p.playing ? (serverNow() - (p.updatedAt || serverNow())) / 1000 * (p.rate || 1) : 0));
    const drift = expected - current;
    const playerState = state.player.getPlayerState?.();
    if (p.playing && playerState !== window.YT?.PlayerState?.PLAYING && !state.autoplayBlocked) state.player.playVideo();
    if (!p.playing && playerState === window.YT?.PlayerState?.PLAYING) state.player.pauseVideo();
    if (Math.abs(drift) > 0.5 && p.playing) {
      try { state.player.seekTo(expected, true); $('syncLabel').textContent = `Correcting drift (${drift > 0 ? '+' : ''}${drift.toFixed(1)}s)`; }
      catch { /* player may be buffering */ }
    }
    state.lastHostTime = current; return;
  }
  if (Date.now() < state.suppressHostEventsUntil) { state.lastHostTime = current; return; }
  if (Number.isFinite(state.lastHostTime) && Math.abs(current - state.lastHostTime) > 2.25) {
    ack(state.socket,'playback:command',{action:'seek',position:current}).catch(e=>console.warn(e));
  }
  state.lastHostTime = current;
}
async function submitRoomForm(event) {
  event.preventDefault(); $('roomFormError').classList.add('hidden'); const name = $('displayName').value.trim();
  if (!name || name.length > 24) return showErrorInRoomForm('Please enter a display name between 1 and 24 characters.');
  const code = state.modalMode === 'join' ? $('roomCodeInput').value.trim().toUpperCase() : $('customRoomCode').value.trim().toUpperCase();
  if (state.modalMode === 'join' && !code) return showErrorInRoomForm('Enter the room code your friend shared.');
  if (state.modalMode === 'create' && code && !/^[A-Z0-9]{4,12}$/.test(code)) return showErrorInRoomForm('Custom room codes must be 4–12 letters or numbers.');
  $('roomFormSubmit').disabled = true; $('roomFormSubmit').textContent = 'Connecting…';
  try {
    await ensureConnected();
    const result = state.modalMode === 'create' ? await ack(state.socket,'room:create',{name,code:code || undefined}) : await ack(state.socket,'room:join',{name,code});
    state.displayName = name; state.resumeToken = result.resumeToken; state.roomCode = result.snapshot.code; store.set('displayName',name); store.set('resumeToken',state.resumeToken); store.set('roomCode',state.roomCode);
    state.meId = result.participantId || state.meId;
    applySnapshot(result.snapshot, result.participantId); state.pendingJoinCode = ''; closeModal(); toast(state.modalMode === 'create' ? `Room ${state.roomCode} created. Invite your friends!` : `Joined room ${state.roomCode}.`);
    const url = new URL(location.href); url.searchParams.set('room',state.roomCode); history.replaceState({},'',url);
  } catch (error) { showErrorInRoomForm(error.message); }
  finally { $('roomFormSubmit').disabled = false; $('roomFormSubmit').textContent = state.modalMode === 'create' ? 'Create room' : 'Join room'; }
}
async function inviteFriends() {
  if (!state.roomCode) return toast('Create or join a room first.','warning');
  const url = new URL(location.href); url.searchParams.set('room',state.roomCode); $('inviteLinkInput').value = url.toString(); showModal('inviteModal');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Invite link copied.','success'); }
  catch { const input = $('inviteLinkInput'); input.focus(); input.select(); try { document.execCommand('copy'); toast('Invite link copied.','success'); } catch { toast('Copy failed — select and copy the link manually.','warning'); } }
}
async function leaveRoom() {
  if (!state.room) return;
  try { await ack(state.socket,'room:leave',{}); } catch(e) { console.warn(e); }
  state.room = null; state.meId = null; state.roomCode = ''; state.latestPlayback = null; state.lastAppliedRevision = -1; if(state.playerReady) state.player?.stopVideo?.(); store.remove('roomCode'); store.remove('resumeToken'); state.resumeToken = ''; state.pendingJoinCode = ''; const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('room'); history.replaceState({}, '', cleanUrl);
  $('sidebarRoomCode').textContent = '— — — —'; $('detailRoomCode').textContent = '—'; $('detailHost').textContent = '—'; $('detailOnline').textContent = '0'; $('onlineCount').textContent = '0 online'; $('peopleCount').textContent = '0'; $('roomHeading').textContent = 'Good things are better together.'; $('roomDescription').textContent = 'Create a room to start watching with friends, or join with an invite code.'; $('roomSubtitle').textContent = 'Create a room or join a friend.'; $('hostPill').textContent = 'Not in a room'; $('hostPill').classList.remove('host'); $('syncLabel').textContent = 'Waiting for a room'; $('syncLabel').previousElementSibling?.classList.remove('good'); $('inviteButton').disabled = true; $('sidebarInvite').disabled = true; $('leaveRoomButton').disabled = true; $('newPollButton').disabled = true; $('chatInput').disabled = true; $('chatForm').querySelector('button').disabled = true; $('chatMessages').innerHTML = '<div class="empty-state">Your room conversation will appear here.</div>'; state.chatIds.clear(); $('peopleList').innerHTML = '<div class="empty-state">No participants yet.</div>'; $('playlistItems').innerHTML = '<div class="empty-state">Your shared queue is empty. Add a video to get started.</div>'; $('pollsList').innerHTML = '<div class="empty-state">Create a room to start a group poll.</div>'; ['playButton','pauseButton','backButton','forwardButton','playbackRate','resyncButton','addToPlaylist'].forEach(id=>$(id).disabled=true); $('playerPlaceholder').classList.remove('hidden'); $('currentVideoTitle').textContent = 'No video selected'; $('currentVideoSub').textContent = 'Paste a YouTube link or pick something below.'; toast('You left the room.');
}
function setupEvents() {
  $('createRoomButton').addEventListener('click',()=>setRoomFormMode('create'));
  $('joinRoomButton').addEventListener('click',()=>setRoomFormMode('join',state.pendingJoinCode));
  $('placeholderLoad').addEventListener('click',()=>{ $('youtubeUrlInput').focus(); $('youtubeUrlInput').scrollIntoView({behavior:'smooth',block:'center'}); });
  $('roomForm').addEventListener('submit',submitRoomForm);
  $('inviteButton').addEventListener('click',inviteFriends); $('sidebarInvite').addEventListener('click',inviteFriends);
  $('copyInviteModal').addEventListener('click',()=>copyText($('inviteLinkInput').value));
  $('leaveRoomButton').addEventListener('click',leaveRoom);
  $('settingsButton').addEventListener('click',()=>{ $('serverUrlInput').value=state.serverUrl; showModal('settingsModal'); });
  $('settingsForm').addEventListener('submit',async event=>{ event.preventDefault(); const url=$('serverUrlInput').value.trim().replace(/\/$/,''); try { const parsed=new URL(url); if(!['http:','https:'].includes(parsed.protocol)) throw new Error(); } catch { return toast('Enter a valid HTTP(S) server URL.','error'); } if (url !== state.serverUrl && state.room) await leaveRoom(); state.serverUrl=url; store.set('serverUrl',url); connect(); closeModal(); toast('Server URL saved. Connecting…'); });
  $('resetServerUrl').addEventListener('click',async()=>{ if(state.room && state.serverUrl!=='http://localhost:3000') await leaveRoom(); state.serverUrl='http://localhost:3000'; store.set('serverUrl',state.serverUrl); $('serverUrlInput').value=state.serverUrl; connect(); toast('Local server URL selected.'); });
  document.querySelectorAll('[data-close-modal]').forEach(button=>button.addEventListener('click',closeModal));
  $('modalBackdrop').addEventListener('click',event=>{ if(event.target===$('modalBackdrop')) closeModal(); });
  document.addEventListener('keydown',event=>{ if(event.key==='Escape') closeModal(); if(event.key==='/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName) && !event.ctrlKey && !event.metaKey){event.preventDefault();$('searchInput').focus();} });
  $('videoForm').addEventListener('submit',async event=>{ event.preventDefault(); const input=$('youtubeUrlInput'); const videoId=extractYouTubeId(input.value); if(!videoId) return toast('Paste a valid YouTube watch, short, embed, live link, or 11-character video ID.','error'); const rec=recommendations.find(x=>x.id===videoId); const loaded=await chooseVideo(videoId,rec?.title||'YouTube video'); if(loaded) input.value=''; });
  $('clearUrl').addEventListener('click',()=>{ $('youtubeUrlInput').value=''; $('youtubeUrlInput').focus(); });
  $('addToPlaylist').addEventListener('click',async()=>{ const id=state.latestPlayback?.videoId || state.player?.getVideoData?.().video_id; if(!id) return toast('Load a video first.','warning'); const title=$('currentVideoTitle').textContent; try { await ack(state.socket,'playlist:add',{videoId:id,title}); toast('Added to the shared playlist.'); } catch(e) { toast(e.message,'error'); } });
  $('playButton').addEventListener('click',()=>sendPlayback('play')); $('pauseButton').addEventListener('click',()=>sendPlayback('pause'));
  $('backButton').addEventListener('click',()=>{if(!state.playerReady)return;sendPlayback('seek',{position:Math.max(0,state.player.getCurrentTime()-10)});});
  $('forwardButton').addEventListener('click',()=>{if(!state.playerReady)return;sendPlayback('seek',{position:Math.max(0,state.player.getCurrentTime()+10)});});
  $('resyncButton').addEventListener('click',()=>{ if(!state.latestPlayback?.videoId)return; sendPlayback('seek',{position:state.player?.getCurrentTime?.()||0}).then(ok=>{if(ok)toast('Sync point sent to everyone.');}); });
  $('playbackRate').addEventListener('change',()=>sendPlayback('rate',{rate:Number($('playbackRate').value)}));
  $('searchInput').addEventListener('input',()=>renderRecommendations(fuzzySearch($('searchInput').value,$('categoryFilter').value)));
  $('categoryFilter').addEventListener('change',()=>renderRecommendations(fuzzySearch($('searchInput').value,$('categoryFilter').value)));
  document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
    const name=button.dataset.tab; document.querySelectorAll('[data-tab]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
    ['chat','reactions','people'].forEach(tab=>$(`tab${tab[0].toUpperCase()+tab.slice(1)}`).classList.toggle('hidden',tab!==name));
  }));
  document.querySelectorAll('[data-emoji]').forEach(button=>button.addEventListener('click',async()=>{if(!state.room)return toast('Create or join a room to react.','warning');try{await ack(state.socket,'reaction:send',{emoji:button.dataset.emoji});}catch(e){toast(e.message,'error');}}));
  $('chatForm').addEventListener('submit',async event=>{event.preventDefault();const input=$('chatInput'),text=input.value.trim();if(!text)return;try{await ack(state.socket,'chat:send',{text});input.value='';}catch(e){toast(e.message,'error');}});
  $('newPollButton').addEventListener('click',()=>{if(!state.room)return toast('Create or join a room first.','warning');$('pollQuestion').value='';$('pollOptions').value='';$('pollFormError').classList.add('hidden');showModal('pollModal');});
  $('pollForm').addEventListener('submit',async event=>{event.preventDefault();const question=$('pollQuestion').value.trim(),options=[...new Set($('pollOptions').value.split('\n').map(x=>x.trim()).filter(Boolean))];if(!question||options.length<2||options.length>6){$('pollFormError').textContent='Enter a question and 2–6 unique options.';$('pollFormError').classList.remove('hidden');return;}try{await ack(state.socket,'poll:create',{question,options});closeModal();toast('Poll created.');}catch(e){$('pollFormError').textContent=e.message;$('pollFormError').classList.remove('hidden');}});
  document.querySelectorAll('[data-scroll]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.scroll)?.scrollIntoView({behavior:'smooth',block:'start'})));
}

setupEvents(); renderRecommendations(); connect();
setTimeout(() => { if (!window.YT?.Player) { $('playerNotice').textContent = 'The YouTube player API has not loaded yet. Check your network, browser extensions, or try reloading.'; } }, 12000);
if (state.pendingJoinCode) { setTimeout(()=>setRoomFormMode('join',state.pendingJoinCode),250); }
