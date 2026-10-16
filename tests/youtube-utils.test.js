import test from 'node:test';
import assert from 'node:assert/strict';
import { extractYouTubeId, isValidYouTubeId } from '../public/youtube-utils.js';

test('YouTube URL parser accepts common official URL forms', () => {
  const id = 'dQw4w9WgXcQ';
  const cases = [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}&t=10`,
    `https://youtu.be/${id}?si=abc`,
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/embed/${id}?start=10`,
    `https://youtube.com/live/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtube-nocookie.com/embed/${id}`
  ];
  for (const value of cases) assert.equal(extractYouTubeId(value), id, value);
});

test('YouTube URL parser rejects invalid IDs and deceptive hosts', () => {
  for (const value of ['', 'not a url', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', 'https://youtube.com/watch?v=too-long-id-123']) {
    assert.equal(extractYouTubeId(value), null, value);
  }
  assert.equal(isValidYouTubeId('dQw4w9WgXcQ'), true);
  assert.equal(isValidYouTubeId('bad'), false);
});
