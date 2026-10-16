import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

test('frontend includes YouTube IFrame API, safe referrer policy, and safe text rendering', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const youtubeUtils = await readFile(path.join(root, 'public', 'youtube-utils.js'), 'utf8');
  assert.match(html, /name="referrer" content="strict-origin-when-cross-origin"/);
  assert.match(html, /youtube\.com\/iframe_api/);
  assert.match(js, /enablejsapi: 1/);
  assert.match(js, /origin: location\.origin/);
  assert.match(js, /153:/);
  assert.match(youtubeUtils, /function extractYouTubeId/);
  assert.match(js, /textContent = message\.text/);
});

