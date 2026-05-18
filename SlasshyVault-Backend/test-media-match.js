// ============================================================
// Comprehensive test suite for Watch Together media matching
// Run: node test-media-match.js
// ============================================================

// Extract functions from server.js inline (same logic)
function normalizeMediaMatchKey(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return value.toString().trim().toLowerCase();
}

function extractMediaMatchKeys(value) {
  const normalized = normalizeMediaMatchKey(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasMatchingMediaKey(roomKeyValue, joinKeyValue) {
  const roomKeys = extractMediaMatchKeys(roomKeyValue);
  const joinKeys = extractMediaMatchKeys(joinKeyValue);
  if (roomKeys.length === 0 || joinKeys.length === 0) {
    return null;
  }

  const identityPrefixes = ['cloud:', 'file:', 'tmdb:', 'title:'];
  const verifierPrefixes = ['size:', 'dur:', 'phash:'];

  const isIdentity = (key) => identityPrefixes.some((p) => key.startsWith(p));
  const isVerifier = (key) => verifierPrefixes.some((p) => key.startsWith(p));

  const roomIdentity = roomKeys.filter(isIdentity);
  const joinIdentity = joinKeys.filter(isIdentity);

  if (roomIdentity.length === 0 || joinIdentity.length === 0) {
    return null;
  }
  const roomIdentitySet = new Set(roomIdentity);
  const hasIdentityMatch = joinIdentity.some((key) => roomIdentitySet.has(key));
  if (!hasIdentityMatch) {
    return false;
  }

  const getVerifierMap = (keys) => {
    const map = new Map();
    for (const key of keys) {
      if (isVerifier(key)) {
        const sep = key.indexOf(':');
        const prefix = key.substring(0, sep + 1);
        const value = key.substring(sep + 1);
        map.set(prefix, value);
      }
    }
    return map;
  };

  const roomVerifiers = getVerifierMap(roomKeys);
  const joinVerifiers = getVerifierMap(joinKeys);

  for (const [prefix, roomValue] of roomVerifiers) {
    const joinValue = joinVerifiers.get(prefix);
    if (joinValue !== undefined && roomValue !== joinValue) {
      return false;
    }
  }

  return true;
}

// ============================================================
// Frontend buildMediaMatchKey (reimplemented for testing)
// ============================================================
function buildMediaMatchKey(media) {
  if (!media) return undefined;

  const tokens = [];

  if (media.cloud_file_id && media.cloud_file_id.trim()) {
    tokens.push(`cloud:${encodeURIComponent(media.cloud_file_id.trim().toLowerCase())}`);
  }

  if (media.file_path && media.file_path.trim()) {
    const normalizedPath = media.file_path.replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop().trim();
    if (fileName) {
      tokens.push(`file:${encodeURIComponent(fileName.toLowerCase())}`);
    }
  }

  if (media.tmdb_id && media.tmdb_id.trim()) {
    tokens.push(`tmdb:${encodeURIComponent(media.tmdb_id.trim().toLowerCase())}`);
  }

  const title = media.title && media.title.trim();
  if (title) {
    tokens.push(`title:${encodeURIComponent(title.toLowerCase())}`);
  }

  if (media.file_size_bytes && media.file_size_bytes > 0) {
    tokens.push(`size:${media.file_size_bytes}`);
  }

  if (media.duration_seconds && media.duration_seconds > 0) {
    tokens.push(`dur:${Math.round(media.duration_seconds)}`);
  }

  if (tokens.length === 0) {
    return undefined;
  }

  return [...new Set(tokens)].join('|');
}

// ============================================================
// Test runner
// ============================================================
let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, testName) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${testName}`);
  }
}

function assertEqual(actual, expected, testName) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${testName} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================
// TEST SET 1: Exact same file, all tokens match
// ============================================================
console.log('\n=== TEST SET 1: Exact same file (all tokens match) ===');

const exactRoom = 'file:movie.mkv|size:4837261312|dur:7200|phash:a3f2b1c0';
const exactJoin = 'file:movie.mkv|size:4837261312|dur:7200|phash:a3f2b1c0';
assertEqual(hasMatchingMediaKey(exactRoom, exactJoin), true, 'Identical full keys match');

// ============================================================
// TEST SET 2: Same file, different size (different encode)
// ============================================================
console.log('\n=== TEST SET 2: Same filename, different size ===');

const room2 = 'file:movie.mkv|size:4837261312|dur:7200';
const join2 = 'file:movie.mkv|size:2137261312|dur:7200';
assertEqual(hasMatchingMediaKey(room2, join2), false, 'Same filename + duration but different size → REJECT');

const room2b = 'file:movie.mkv|size:4837261312';
const join2b = 'file:movie.mkv|size:2137261312';
assertEqual(hasMatchingMediaKey(room2b, join2b), false, 'Same filename but different size (no duration) → REJECT');

// ============================================================
// TEST SET 3: Same file, different duration (different cut)
// ============================================================
console.log('\n=== TEST SET 3: Same filename, different duration ===');

const room3 = 'file:movie.mkv|size:4837261312|dur:7200';
const join3 = 'file:movie.mkv|size:4837261312|dur:5400';
assertEqual(hasMatchingMediaKey(room3, join3), false, 'Same filename + size but different duration → REJECT');

// ============================================================
// TEST SET 4: Same file, different partial hash
// ============================================================
console.log('\n=== TEST SET 4: Same filename, different partial hash ===');

const room4 = 'file:movie.mkv|size:4837261312|dur:7200|phash:a3f2b1c0';
const join4 = 'file:movie.mkv|size:4837261312|dur:7200|phash:deadbeef';
assertEqual(hasMatchingMediaKey(room4, join4), false, 'Same filename + size + dur but different phash → REJECT');

// ============================================================
// TEST SET 5: Same file, only filename matches (no verifiers)
// ============================================================
console.log('\n=== TEST SET 5: Same filename, no verifier tokens ===');

const room5 = 'file:movie.mkv';
const join5 = 'file:movie.mkv';
assertEqual(hasMatchingMediaKey(room5, join5), true, 'Same filename only, no verifiers → PASS (backward compat)');

// ============================================================
// TEST SET 6: Different filenames, same size
// ============================================================
console.log('\n=== TEST SET 6: Different filenames, same size ===');

const room6 = 'file:movie.mkv|size:4837261312';
const join6 = 'file:film.mkv|size:4837261312';
assertEqual(hasMatchingMediaKey(room6, join6), false, 'Different filenames, same size → REJECT (no identity match)');

// ============================================================
// TEST SET 7: Cloud file matching
// ============================================================
console.log('\n=== TEST SET 7: Cloud file matching ===');

const room7 = 'cloud:abc123|file:movie.mkv|size:4837261312|dur:7200';
const join7 = 'cloud:abc123|file:different.mkv|size:4837261312|dur:7200';
assertEqual(hasMatchingMediaKey(room7, join7), true, 'Cloud ID matches, verifiers match → PASS');

const room7b = 'cloud:abc123|size:4837261312';
const join7b = 'cloud:abc123|size:9999999999';
assertEqual(hasMatchingMediaKey(room7b, join7b), false, 'Cloud ID matches, size differs → REJECT');

// ============================================================
// TEST SET 8: TMDB ID matching
// ============================================================
console.log('\n=== TEST SET 8: TMDB ID matching ===');

const room8 = 'tmdb:550|title:fight club|size:4837261312|dur:7200';
const join8 = 'tmdb:550|title:fight club|size:4837261312|dur:7200';
assertEqual(hasMatchingMediaKey(room8, join8), true, 'TMDB + title + verifiers all match → PASS');

const room8b = 'tmdb:550|size:4837261312';
const join8b = 'tmdb:999|size:4837261312';
assertEqual(hasMatchingMediaKey(room8b, join8b), false, 'Different TMDB IDs, same size → REJECT');

// ============================================================
// TEST SET 9: Title-only matching (legacy)
// ============================================================
console.log('\n=== TEST SET 9: Title-only matching ===');

const room9 = 'title:the matrix';
const join9 = 'title:the matrix';
assertEqual(hasMatchingMediaKey(room9, join9), true, 'Same title only → PASS');

const room9b = 'title:the matrix|size:4837261312|dur:7200';
const join9b = 'title:the matrix|size:2137261312|dur:5400';
assertEqual(hasMatchingMediaKey(room9b, join9b), false, 'Same title but all verifiers differ → REJECT');

// ============================================================
// TEST SET 10: Cross-source matching (cloud + local)
// ============================================================
console.log('\n=== TEST SET 10: Cross-source matching ===');

const room10 = 'cloud:abc123|size:4837261312|dur:7200';
const join10 = 'file:movie.mkv|size:4837261312|dur:7200';
assertEqual(hasMatchingMediaKey(room10, join10), false, 'Cloud vs file, no shared identity → REJECT');

// ============================================================
// TEST SET 11: Empty / null / undefined inputs
// ============================================================
console.log('\n=== TEST SET 11: Edge cases — empty/null/undefined ===');

assertEqual(hasMatchingMediaKey(null, 'file:movie.mkv'), null, 'Room key null → null');
assertEqual(hasMatchingMediaKey('file:movie.mkv', null), null, 'Join key null → null');
assertEqual(hasMatchingMediaKey('', 'file:movie.mkv'), null, 'Room key empty → null');
assertEqual(hasMatchingMediaKey('file:movie.mkv', ''), null, 'Join key empty → null');
assertEqual(hasMatchingMediaKey(undefined, 'file:movie.mkv'), null, 'Room key undefined → null');
assertEqual(hasMatchingMediaKey('file:movie.mkv', undefined), null, 'Join key undefined → null');

// ============================================================
// TEST SET 12: Partial verifier tokens (one side missing)
// ============================================================
console.log('\n=== TEST SET 12: Partial verifier tokens ===');

const room12 = 'file:movie.mkv|size:4837261312|dur:7200|phash:a3f2b1c0';
const join12 = 'file:movie.mkv';
assertEqual(hasMatchingMediaKey(room12, join12), true, 'Room has verifiers, join has none → PASS (graceful)');

const room12b = 'file:movie.mkv';
const join12b = 'file:movie.mkv|size:4837261312|dur:7200|phash:a3f2b1c0';
assertEqual(hasMatchingMediaKey(room12b, join12b), true, 'Join has verifiers, room has none → PASS (graceful)');

// ============================================================
// TEST SET 13: Only verifier tokens, no identity
// ============================================================
console.log('\n=== TEST SET 13: Verifier-only keys (no identity) ===');

const room13 = 'size:4837261312|dur:7200';
const join13 = 'size:4837261312|dur:7200';
assertEqual(hasMatchingMediaKey(room13, join13), null, 'Verifier-only keys, no identity → null');

// ============================================================
// TEST SET 14: Case insensitivity
// ============================================================
console.log('\n=== TEST SET 14: Case insensitivity ===');

const room14 = 'file:Movie.MKV|size:4837261312';
const join14 = 'file:movie.mkv|size:4837261312';
assertEqual(hasMatchingMediaKey(room14, join14), true, 'Case insensitive filename match → PASS');

// ============================================================
// TEST SET 15: Windows path normalization
// ============================================================
console.log('\n=== TEST SET 15: buildMediaMatchKey — Windows paths ===');

const media15 = {
  title: 'Test Movie',
  file_path: 'C:\\Users\\test\\Videos\\movie.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 7200,
};
const key15 = buildMediaMatchKey(media15);
assert(key15.includes('file:movie.mkv'), 'Windows path normalized to filename');
assert(key15.includes('size:4837261312'), 'File size included');
assert(key15.includes('dur:7200'), 'Duration included');
assert(!key15.includes('C%3A'), 'No drive letter in key');

// ============================================================
// TEST SET 16: buildMediaMatchKey — Unix paths
// ============================================================
console.log('\n=== TEST SET 16: buildMediaMatchKey — Unix paths ===');

const media16 = {
  title: 'Test Movie',
  file_path: '/home/user/Videos/movie.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 7200,
};
const key16 = buildMediaMatchKey(media15);
assert(key16.includes('file:movie.mkv'), 'Unix path normalized to filename');

// ============================================================
// TEST SET 17: buildMediaMatchKey — Cloud file
// ============================================================
console.log('\n=== TEST SET 17: buildMediaMatchKey — Cloud file ===');

const media17 = {
  title: 'Test Movie',
  cloud_file_id: '1a2b3c4d5e',
  file_size_bytes: 4837261312,
  duration_seconds: 7200,
};
const key17 = buildMediaMatchKey(media17);
assert(key17.includes('cloud:1a2b3c4d5e'), 'Cloud file ID included');
assert(key17.includes('size:4837261312'), 'File size included');
assert(key17.includes('dur:7200'), 'Duration included');
assert(!key17.includes('file:'), 'No file token for cloud-only');

// ============================================================
// TEST SET 18: buildMediaMatchKey — Null/missing fields
// ============================================================
console.log('\n=== TEST SET 18: buildMediaMatchKey — Missing fields ===');

const media18a = { title: 'Test' };
const key18a = buildMediaMatchKey(media18a);
assertEqual(key18a, 'title:test', 'Title-only key when no other fields');

const media18b = {};
const key18b = buildMediaMatchKey(media18b);
assertEqual(key18b, undefined, 'Undefined when no fields at all');

const key18c = buildMediaMatchKey(null);
assertEqual(key18c, undefined, 'Undefined for null media');

const key18d = buildMediaMatchKey(undefined);
assertEqual(key18d, undefined, 'Undefined for undefined media');

// ============================================================
// TEST SET 19: buildMediaMatchKey — Duration rounding
// ============================================================
console.log('\n=== TEST SET 19: buildMediaMatchKey — Duration rounding ===');

const media19 = { title: 'Test', duration_seconds: 7200.7 };
const key19 = buildMediaMatchKey(media19);
assert(key19.includes('dur:7201'), 'Duration rounded to nearest second');

const media19b = { title: 'Test', duration_seconds: 7200.4 };
const key19b = buildMediaMatchKey(media19b);
assert(key19b.includes('dur:7200'), 'Duration rounds down');

// ============================================================
// TEST SET 20: buildMediaMatchKey — Zero/negative values
// ============================================================
console.log('\n=== TEST SET 20: buildMediaMatchKey — Zero/negative values ===');

const media20 = { title: 'Test', file_size_bytes: 0, duration_seconds: 0 };
const key20 = buildMediaMatchKey(media20);
assert(!key20.includes('size:'), 'Zero file size excluded');
assert(!key20.includes('dur:'), 'Zero duration excluded');

const media20b = { title: 'Test', file_size_bytes: -100, duration_seconds: -5 };
const key20b = buildMediaMatchKey(media20b);
assert(!key20b.includes('size:'), 'Negative file size excluded');
assert(!key20b.includes('dur:'), 'Negative duration excluded');

// ============================================================
// TEST SET 21: Real-world scenario — same movie, different sources
// ============================================================
console.log('\n=== TEST SET 21: Real-world — same movie, different sources ===');

// User A has a local file, User B has cloud version
const room21a = buildMediaMatchKey({
  title: 'Inception',
  file_path: 'D:\\Movies\\Inception.2010.1080p.BluRay.mkv',
  tmdb_id: '27205',
  file_size_bytes: 4837261312,
  duration_seconds: 8880,
});

const join21a = buildMediaMatchKey({
  title: 'Inception',
  cloud_file_id: '1abc123',
  tmdb_id: '27205',
  file_size_bytes: 4837261312,
  duration_seconds: 8880,
});

assertEqual(hasMatchingMediaKey(room21a, join21a), true, 'Local + cloud, TMDB match, verifiers match → PASS');

// ============================================================
// TEST SET 22: Real-world — same title, different release
// ============================================================
console.log('\n=== TEST SET 22: Real-world — same title, different release ===');

const room22 = buildMediaMatchKey({
  title: 'The Matrix',
  file_path: 'D:\\Movies\\The.Matrix.1999.1080p.BluRay.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 8160,
});

const join22 = buildMediaMatchKey({
  title: 'The Matrix',
  file_path: 'D:\\Movies\\The.Matrix.1999.2160p.WEB-DL.mkv',
  file_size_bytes: 15837261312,
  duration_seconds: 8160,
});

assertEqual(hasMatchingMediaKey(room22, join22), false, 'Same title + duration, different size → REJECT');

// ============================================================
// TEST SET 23: Real-world — same file, one user has more metadata
// ============================================================
console.log('\n=== TEST SET 23: Real-world — metadata asymmetry ===');

const room23 = buildMediaMatchKey({
  title: 'Fight Club',
  file_path: 'D:\\Movies\\Fight.Club.1999.mkv',
  tmdb_id: '550',
  file_size_bytes: 4837261312,
  duration_seconds: 7200,
});

const join23 = buildMediaMatchKey({
  title: 'Fight Club',
  file_path: 'D:\\Movies\\Fight.Club.1999.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 7200,
});

assertEqual(hasMatchingMediaKey(room23, join23), true, 'Same file, one has TMDB other does not → PASS');

// ============================================================
// TEST SET 24: Real-world — episode matching
// ============================================================
console.log('\n=== TEST SET 24: Real-world — TV episode matching ===');

const room24 = buildMediaMatchKey({
  title: 'Breaking Bad',
  episode_title: 'Ozymandias',
  file_path: 'D:\\TV\\Breaking.Bad.S05E14.Ozymandias.mkv',
  file_size_bytes: 524288000,
  duration_seconds: 2760,
});

const join24 = buildMediaMatchKey({
  title: 'Breaking Bad',
  episode_title: 'Ozymandias',
  file_path: 'D:\\TV\\Breaking.Bad.S05E14.720p.BluRay.mkv',
  file_size_bytes: 524288000,
  duration_seconds: 2760,
});

assertEqual(hasMatchingMediaKey(room24, join24), true, 'Same episode title + size + duration, different filename → PASS (title is identity)');

// ============================================================
// TEST SET 25: Real-world — re-encoded same file
// ============================================================
console.log('\n=== TEST SET 25: Real-world — re-encode detection ===');

const room25 = buildMediaMatchKey({
  title: 'Avatar',
  file_path: 'D:\\Movies\\Avatar.2009.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 9600,
});

const join25 = buildMediaMatchKey({
  title: 'Avatar',
  file_path: 'D:\\Movies\\Avatar.2009.mkv',
  file_size_bytes: 4837261312,
  duration_seconds: 9600,
  // phash would be computed by Rust backend
});

assertEqual(hasMatchingMediaKey(room25, join25), true, 'Same filename + size + duration → PASS');

// Now simulate different phash (re-encode)
const room25b = 'file:avatar.2009.mkv|title:avatar|size:4837261312|dur:9600|phash:aabbccdd';
const join25b = 'file:avatar.2009.mkv|title:avatar|size:4837261312|dur:9600|phash:11223344';
assertEqual(hasMatchingMediaKey(room25b, join25b), false, 'Same everything but different phash → REJECT');

// ============================================================
// TEST SET 26: Duplicate tokens
// ============================================================
console.log('\n=== TEST SET 26: Duplicate tokens ===');

const room26 = 'file:movie.mkv|file:movie.mkv|size:100';
const join26 = 'file:movie.mkv|size:100';
assertEqual(hasMatchingMediaKey(room26, join26), true, 'Duplicate tokens handled → PASS');

// ============================================================
// TEST SET 27: Whitespace handling
// ============================================================
console.log('\n=== TEST SET 27: Whitespace handling ===');

const room27 = ' file:movie.mkv | size:100 ';
const join27 = 'file:movie.mkv|size:100';
assertEqual(hasMatchingMediaKey(room27, join27), true, 'Whitespace trimmed → PASS');

// ============================================================
// TEST SET 28: Multiple verifier mismatches
// ============================================================
console.log('\n=== TEST SET 28: Multiple verifier mismatches ===');

const room28 = 'file:movie.mkv|size:100|dur:7200|phash:aaaa';
const join28 = 'file:movie.mkv|size:200|dur:5400|phash:bbbb';
assertEqual(hasMatchingMediaKey(room28, join28), false, 'All three verifiers mismatch → REJECT');

const room28b = 'file:movie.mkv|size:100|dur:7200|phash:aaaa';
const join28b = 'file:movie.mkv|size:100|dur:5400|phash:bbbb';
assertEqual(hasMatchingMediaKey(room28b, join28b), false, 'Size matches, dur + phash mismatch → REJECT');

const room28c = 'file:movie.mkv|size:100|dur:7200|phash:aaaa';
const join28c = 'file:movie.mkv|size:100|dur:7200|phash:aaaa';
assertEqual(hasMatchingMediaKey(room28c, join28c), true, 'All verifiers match → PASS');

// ============================================================
// TEST SET 29: URL-encoded title with special chars
// ============================================================
console.log('\n=== TEST SET 29: Special characters in title ===');

const media29 = { title: 'Amélie (2001)', file_size_bytes: 100, duration_seconds: 7200 };
const key29 = buildMediaMatchKey(media29);
assert(key29.includes('am%C3%A9lie'), 'Accented characters encoded');

const room29 = key29;
const join29 = buildMediaMatchKey({ title: 'Amélie (2001)', file_size_bytes: 100, duration_seconds: 7200 });
assertEqual(hasMatchingMediaKey(room29, join29), true, 'Special chars match → PASS');

// ============================================================
// SUMMARY
// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
  process.exit(0);
}
