const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

/** Extract an 11-character YouTube video ID from common URL forms or a bare ID. */
export function extractYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (VIDEO_ID_RE.test(value)) return value;
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0];
  else if (YOUTUBE_HOSTS.has(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
  }
  return typeof id === 'string' && VIDEO_ID_RE.test(id) ? id : null;
}

export function isValidYouTubeId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}
