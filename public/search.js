// Catalogue + fuzzy search. Pure ES module: no DOM access, so it can be unit-tested with `node --test`.
//
// The catalogue is a small curated set of freely embeddable videos (no YouTube Data API key needed).
// Anything outside it can still be played by pasting a link.

export const CATALOGUE = [
  { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', creator: 'Blender Studio', year: 2008, category: 'Animation', tags: 'open movie short film comedy rabbit forest family' },
  { id: 'eRsGyueVLvQ', title: 'Sintel', creator: 'Blender Studio', year: 2010, category: 'Animation', tags: 'open movie short film fantasy dragon adventure' },
  { id: 'R6MlUcmOul8', title: 'Tears of Steel', creator: 'Blender Studio', year: 2012, category: 'Sci-fi', tags: 'open movie short film robots science fiction live action vfx' },
  { id: 'TLkA0RELQ1g', title: 'Elephants Dream', creator: 'Blender Studio', year: 2006, category: 'Animation', tags: 'open movie short film surreal machines' },
  { id: 'Y-rmzh0PI3c', title: 'Cosmos Laundromat', creator: 'Blender Studio', year: 2015, category: 'Animation', tags: 'open movie short film sheep surreal comedy first cycle' },
  { id: 'WhWc3b3KhnY', title: 'Spring', creator: 'Blender Studio', year: 2019, category: 'Animation', tags: 'open movie short film shepherd spirits nature fantasy' },
  { id: 'mN0zPOpADL4', title: 'Agent 327: Operation Barbershop', creator: 'Blender Studio', year: 2017, category: 'Animation', tags: 'open movie short film spy comedy detective' },
  { id: 'SkVqJ1SGeL0', title: 'Caminandes: Llamigos', creator: 'Blender Studio', year: 2016, category: 'Animation', tags: 'open movie short film llama penguin snow comedy family' },
  { id: 'Z4C82eyhwgU', title: 'Caminandes: Gran Dillama', creator: 'Blender Studio', year: 2013, category: 'Animation', tags: 'open movie short film llama comedy family' },
  { id: 'jfKfPfyJRdk', title: 'lofi hip hop radio', creator: 'Lofi Girl', year: 2022, category: 'Music', tags: 'study chill beats focus relax live stream' },
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', creator: 'Rick Astley', year: 1987, category: 'Music', tags: 'retro pop nostalgic classic 80s music video' },
  { id: 'LXb3EKWsInQ', title: 'Costa Rica in 4K', creator: '4K Scenic Relaxation', year: 2018, category: 'Nature', tags: 'relax travel ocean mountains jungle scenic documentary' },
  { id: 'ScMzIvxBSi4', title: 'Relaxing nature ambience', creator: 'Nature ambience', year: 2020, category: 'Nature', tags: 'calm ambient rain background sleep' },
  { id: 'jNQXAC9IVRw', title: 'Me at the zoo', creator: 'Jawed Karim', year: 2005, category: 'History', tags: 'first youtube video elephants internet history' },
  { id: 'ysz5S6PUM-U', title: 'Creative Commons video sample', creator: 'Video sample', year: 2012, category: 'Learning', tags: 'sample demo learning' },
  { id: 'M7lc1UVf-VE', title: 'YouTube IFrame API demo', creator: 'YouTube Developers', year: 2013, category: 'Learning', tags: 'developer api demo tutorial coding' }
];

const FIELD_WEIGHTS = { title: 3, creator: 1.4, category: 1.4, tags: 1 };

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Optimal-string-alignment distance (Levenshtein plus adjacent transpositions), early exit above `max`. */
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

const allowedTypos = length => (length <= 3 ? 0 : length <= 6 ? 1 : 2);

function isSubsequence(small, big) {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

/** How well one query word matches one indexed word, from 0 (no match) to 1 (exact). */
export function wordScore(queryWord, word) {
  if (queryWord === word) return 1;
  if (queryWord.length >= 2 && word.startsWith(queryWord)) return 0.9;
  if (queryWord.length >= 3 && word.includes(queryWord)) return 0.7;
  // Three-letter words are too short for general typo tolerance, but a single dropped letter is common ("buk" for "buck").
  if (queryWord.length === 3 && word.length === 4 && isSubsequence(queryWord, word)) return 0.55;
  const typos = allowedTypos(queryWord.length);
  if (!typos) return 0;
  const whole = editDistance(queryWord, word, typos);
  if (whole <= typos) return 0.75 - whole * 0.15;
  // Typo while still typing: compare against the same-length prefix of the word.
  if (queryWord.length >= 4 && word.length > queryWord.length) {
    const prefix = editDistance(queryWord, word.slice(0, queryWord.length), 1);
    if (prefix <= 1) return 0.6;
  }
  return 0;
}

function indexItem(item) {
  const fields = {};
  for (const name of Object.keys(FIELD_WEIGHTS)) fields[name] = normalize(item[name]).split(' ').filter(Boolean);
  return { item, fields, title: normalize(item.title) };
}

let cachedFor = null;
let cachedIndex = null;
function indexFor(items) {
  if (cachedFor !== items) { cachedIndex = items.map(indexItem); cachedFor = items; }
  return cachedIndex;
}

/**
 * Rank `items` against `query`. Every query word must match something (typos tolerated),
 * title matches outrank creator/category/tag matches. An empty query returns the catalogue order.
 */
export function fuzzySearch(query, items = CATALOGUE) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return items.slice();
  const phrase = words.join(' ');
  const ranked = [];
  indexFor(items).forEach((entry, order) => {
    let total = 0;
    for (const word of words) {
      let best = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        for (const candidate of entry.fields[field]) {
          const s = wordScore(word, candidate) * weight;
          if (s > best) best = s;
        }
      }
      if (best === 0) return; // AND semantics: an unmatched word rules the item out
      total += best;
    }
    if (entry.title.includes(phrase)) total += 2;
    if (entry.title.startsWith(phrase)) total += 1;
    ranked.push({ item: entry.item, score: total, order });
  });
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map(r => r.item);
}
