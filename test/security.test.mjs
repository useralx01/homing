// Security + main-flow tests for Homing. No extra packages: node:test, fetch, node:sqlite.
// Run: node --test test/security.test.mjs
// It starts its own server on a spare port with a temp data folder, so the real data is never touched.
// The pay tests talk to the real PayPal SANDBOX (test money). Sell/want need Gemini and are skipped if it is down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homing-test-'));
const DB = path.join(TMP, 'homing.db');
const LAMP = fs.readFileSync(path.join(ROOT, 'test', 'lamp.jpg'));
let BASE, server, logs = '';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// secrets from .env, only to prove they never show up anywhere (never printed)
const SECRETS = (() => {
  try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^(PAYPAL_CLIENT_SECRET|GEMINI_API_KEY|PAYPAL_CLIENT_ID)=(.+)$/)?.[2]?.trim()).filter((v) => v && v.length > 8); } catch { return []; }
})();
const seenBodies = [];

// ---------- fixtures written into the temp DB before the server starts ----------
const SELLER_TOKEN = crypto.randomBytes(32).toString('base64url');
const now = Date.now();
const addr = (line1, zip) => ({ line1, line2: '', city: 'Berlin', zip, country: 'DE' });
const U = [
  { id: 'u_fixsell', name: 'Fixa', fullName: 'Fixa Seller', country: 'DE', address: addr('Sellerweg 1', '10115'), email: 'fixa@example.com', paypalId: 'PPID-SECRET-1', at: now, via: 'paypal' },
  { id: 'u_other1', name: 'Olli', fullName: 'Olli Other', country: 'DE', address: addr('Geheimstraße 9', '10117'), email: 'olli@example.com', at: now, via: 'demo' },
  { id: 'u_other2', name: 'Otto', fullName: 'Otto Other', country: 'DE', address: addr('Privatweg 3', '10119'), at: now, via: 'demo' },
];
const L = [
  { id: 'l_fixopen', sellerId: 'u_fixsell', country: 'DE', photo: '/photos/armchair.jpg', title: 'Desk lamp <script>alert(1)</script>', category: 'Home & kitchen', price: 12.5, description: 'A desk lamp in good shape, works fine, small scratch on the foot.', facts: [], status: 'open', at: now },
  { id: 'l_fixrace', sellerId: 'u_fixsell', country: 'DE', photo: '/photos/armchair.jpg', title: 'Race chair', category: 'Furniture', price: 7, description: 'A chair two people will try to buy at the very same moment.', facts: [], status: 'open', at: now - 1 },
  { id: 'l_fixpp', sellerId: 'u_fixsell', country: 'DE', photo: '/photos/armchair.jpg', title: 'PayPal chair', category: 'Furniture', price: 9, description: 'A chair bought through the PayPal button flow, never approved.', facts: [], status: 'open', at: now - 2 },
  { id: 'l_fixdone', sellerId: 'u_other1', buyerId: 'u_other2', country: 'DE', photo: '/photos/armchair.jpg', title: 'Old deal', category: 'Furniture', price: 20, description: 'A finished deal between two other people, nobody else may review.', facts: [], status: 'sold', at: now - 9, soldAt: now - 5,
    capture: { id: 'CAPSECRET', orderId: 'ORDSECRET', status: 'COMPLETED' }, ship: { name: 'Otto Other', ...addr('Privatweg 3', '10119'), code: 'HM-AAAAAA', labelKey: 'abcdefabcdefabcdefabcdef' }, reviews: {} },
  { id: 'l_fixwait', sellerId: 'u_other2', buyerId: 'u_other1', country: 'DE', photo: '/photos/armchair.jpg', title: 'Fresh deal', category: 'Furniture', price: 15, description: 'Sold a moment ago and not sent yet, so its seller cannot delete the account.', facts: [], status: 'sold', at: now - 9, soldAt: now - 5,
    capture: { id: 'CAPSECRET', orderId: 'ORDSECRET', status: 'COMPLETED' }, ship: { name: 'Olli Other', ...addr('Geheimstraße 9', '10117'), code: 'HM-BBBBBB' }, reviews: {} },
];
function writeFixtures() {
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE rows (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const ins = db.prepare('INSERT INTO rows VALUES (?, ?, ?)');
  for (const u of U) ins.run('users', u.id, JSON.stringify(u));
  for (const l of L) ins.run('listings', l.id, JSON.stringify(l));
  ins.run('wants', 'w_fixold', JSON.stringify({ id: 'w_fixold', userId: 'u_other1', name: 'Olli', country: 'DE', what: 'nothing', category: 'Other', minPrice: 0, maxPrice: 5, status: 'deleted', matches: [], at: now }));
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha(SELLER_TOKEN), 'u_fixsell', now, now + 86400e3);
  db.close();
}

// ---------- a tiny browser: one cookie jar per person ----------
class Person {
  constructor(cookie = '') { this.cookie = cookie; }
  async req(method, p, { json, form, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let body = raw;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const [k, v] = kv.split('=');
      if (k === 'homing_sid') this.cookie = v ? `homing_sid=${v}` : '';
    }
    const text = await r.text();
    seenBodies.push(text);
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, json: j };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, o) { return this.req('POST', p, o); }
}
const anon = new Person();
const seller = new Person(`homing_sid=${SELLER_TOKEN}`);
const PRIVATE = ['address', 'email', 'paypalId', 'capture', 'labelKey', 'line1', 'zip', 'fullAddress'];
const PRIVATE_VALUES = ['Geheimstraße', 'Privatweg', 'Sellerweg', 'example.com', 'PPID-SECRET', 'CAPSECRET', 'ORDSECRET', 'abcdefabcdef'];
function noLeaks(obj, where) {
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!PRIVATE.includes(k), `${where}: private field "${k}" at ${p}`); walk(x, `${p}.${k}`); }
  };
  walk(obj, '');
  const s = JSON.stringify(obj);
  for (const w of PRIVATE_VALUES) assert.ok(!s.includes(w), `${where}: leaks "${w}"`);
}
const photoForm = (buf, name = 'x.jpg', type = 'image/jpeg', fields = {}) => {
  const f = new FormData();
  f.append('photo', new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const uploadsNow = () => new Set(fs.readdirSync(path.join(TMP, 'uploads')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const skipped = [];
// a few shared demo people, so the sign-in rate limit is only hit on purpose
const shared = {};
async function demo(k) { if (!shared[k]) { shared[k] = new Person(); const r = await shared[k].post('/api/signin/demo', { json: {} }); assert.equal(r.status, 200, 'demo sign-in ' + k + ': ' + r.text); } return shared[k]; }

before(async () => {
  writeFixtures();
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), BASE_URL: BASE, DATA_DIR: TMP, DB_FILE: DB, TRACK_DEMO_MINUTES: '0.004', ADMIN_SECRET: '', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (logs += d)); server.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) { if (logs.includes('Homing on')) break; await wait(100); }
  assert.ok(logs.includes('Homing on'), 'server did not start: ' + logs.slice(0, 500));
});
after(() => {
  server?.kill();
  if (process.env.SHOW_SERVER_LOG) console.log('\n--- server log ---\n' + logs);
  if (skipped.length) console.log('\nSKIPPED (Gemini not reachable): ' + skipped.join(', '));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ===================== security =====================
test('security headers on the app', async () => {
  const r = await anon.get('/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'fonts are self-hosted'); assert.match(csp, /font-src 'self'(;|$)/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('referrer-policy'));
  assert.match(r.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS on plain http');
});

test('demo sign-in sets an httpOnly SameSite=Lax session cookie and leaks nothing', async () => {
  const p = new Person();
  const r = await p.post('/api/signin/demo', { json: {} });
  assert.equal(r.status, 200);
  const c = r.headers.getSetCookie().find((x) => x.startsWith('homing_sid='));
  assert.ok(c, 'cookie set'); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.doesNotMatch(c, /Secure/);
  noLeaks(r.json, 'demo sign-in');
  const w = await p.get('/api/whoami');
  assert.equal(w.status, 200); assert.equal(w.json.id, r.json.id);
  // the token is stored only as a hash
  const db = new DatabaseSync(DB, { readOnly: true });
  const token = p.cookie.split('=')[1];
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE hash = ?').get(token).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE hash = ?').get(sha(token)).n, 1);
  db.close();
});

test('cookie is Secure and HSTS is on behind an https proxy', async () => {
  const r = await new Person().post('/api/signin/demo', { json: {}, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(r.headers.getSetCookie().join(), /Secure/);
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=/);
});

test('impersonation with a user id fails everywhere', async () => {
  for (const [p, o] of [
    ['/api/me', { headers: { 'x-user': 'u_fixsell' } }],
    ['/api/me?userId=u_fixsell', {}],
    ['/api/whoami', { headers: { 'x-user': 'u_fixsell' } }],
    ['/api/listings/l_fixdone/ship', { headers: { 'x-user': 'u_other1' } }],
    ['/api/me', { headers: { cookie: 'homing_sid=u_fixsell' } }],
  ]) assert.equal((await anon.get(p, o)).status, 401, p);
  assert.equal((await anon.post('/api/wants', { json: { userId: 'u_fixsell', what: 'lamp', category: 'Other', maxPrice: 10 } })).status, 401);
  assert.equal((await anon.req('DELETE', '/api/listings/l_fixopen', { headers: { 'x-user': 'u_fixsell' } })).status, 401);
  assert.equal((await anon.post('/api/listings/l_fixopen/pay', { json: { userId: 'u_other1', readDescription: true, method: 'card' } })).status, 401);
  assert.equal((await anon.post('/api/me/avatar', { form: photoForm(LAMP), headers: { 'x-user': 'u_fixsell' } })).status, 401);
  // the old name sign-in can never open an existing account
  const n = await new Person().post('/api/signin', { json: { name: 'Fixa', country: 'DE' } });
  assert.equal(n.status, 200); assert.notEqual(n.json.id, 'u_fixsell');
});

test('PayPal return link carries no reusable id', async () => {
  const r = await anon.get('/#signed/u_fixsell'); // the hash never reaches the server; app reads /api/whoami
  assert.equal(r.status, 200);
  const w = await anon.get('/api/whoami');
  assert.equal(w.status, 401);
  const st = await anon.get('/auth/paypal/return?code=abc&state=' + 'a'.repeat(24));
  assert.equal(st.status, 302); assert.doesNotMatch(st.headers.get('location'), /u_|signed/);
});

test('sign-out ends the session on the server', async () => {
  const p = new Person();
  await p.post('/api/signin/demo', { json: {} });
  const saved = p.cookie;
  assert.equal((await p.get('/api/me')).status, 200);
  const o = await p.post('/api/signout', { json: {} });
  assert.equal(o.status, 200); assert.match(o.headers.getSetCookie().join(), /Max-Age=0/);
  assert.equal((await new Person(saved).get('/api/me')).status, 401, 'old token is dead');
});

test('cross-site requests are refused', async () => {
  const r = await seller.post('/api/wants', { json: { what: 'lamp', category: 'Other', maxPrice: 10 }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal((await seller.post('/api/signout', { json: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await seller.get('/api/me')).status, 200, 'seller still signed in');
});

test('no private data in public responses', async () => {
  const other = await demo('A');
  for (const p of ['/api/users/u_fixsell', '/api/users/u_other1', '/api/users/u_other2', '/api/leaderboard?country=DE', '/api/leaderboard?country=DE&by=buyers',
    '/api/listings?country=DE', '/api/listings/l_fixopen', '/api/listings/l_fixdone', '/api/pulse?country=DE', '/api/meta']) {
    const a = await anon.get(p); assert.equal(a.status, 200, p); noLeaks(a.json, 'anon ' + p);
    const b = await other.get(p); assert.equal(b.status, 200, p); noLeaks(b.json, 'other ' + p);
  }
  // my own data: no PayPal id, no email
  const me = await seller.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.paypalId, undefined); assert.equal(me.json.user.email, undefined);
  // a stranger can't open someone's shipping page or label key
  assert.equal((await other.get('/api/listings/l_fixdone/ship')).status, 404);
});

test('/api/reset is locked', async () => {
  assert.equal((await anon.post('/api/reset', { json: {} })).status, 404);
  assert.equal((await seller.post('/api/reset', { json: {}, headers: { 'x-admin-secret': 'x'.repeat(32) } })).status, 404);
  assert.equal((await anon.get('/api/users/u_fixsell')).status, 200, 'data still there');
});

test('bad input gives 400, never 500', async () => {
  const p = await demo('A');
  const want = (body) => p.post('/api/wants', { json: { what: 'a desk lamp', category: 'Home & kitchen', minPrice: 0, maxPrice: 20, ...body } });
  for (const b of [{ maxPrice: 'abc' }, { maxPrice: -5 }, { maxPrice: 1e12 }, { maxPrice: 'NaN' }, { maxPrice: 'Infinity' }, { minPrice: 50 }, { minPrice: -1 },
    { category: 'Weapons' }, { category: ['Other'] }, { what: { $gt: '' } }, { what: 'x'.repeat(500) }, { what: 'ab' }, { what: 42 }]) {
    const r = await want(b); assert.equal(r.status, 400, JSON.stringify(b) + ' -> ' + r.text);
  }
  for (const b of [{ stars: 'five' }, { stars: 9 }, { stars: 2.5 }, { stars: 4, text: { a: 1 } }]) assert.equal((await p.post('/api/listings/l_fixdone/review', { json: b })).status, 403, 'not their deal first');
  // broken JSON, huge JSON, prototype pollution
  const broken = await p.post('/api/wants', { raw: '{"what": ', headers: { 'content-type': 'application/json' } });
  assert.equal(broken.status, 400); assert.equal(broken.json.error, 'Bad request.'); assert.doesNotMatch(broken.text, /at .*\.js|SyntaxError|node_modules/);
  const huge = await p.post('/api/wants', { raw: JSON.stringify({ what: 'x'.repeat(100000) }), headers: { 'content-type': 'application/json' } });
  assert.equal(huge.status, 413);
  const poll = await p.post('/api/wants', { raw: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"what":"a","category":"Other","maxPrice":5}', headers: { 'content-type': 'application/json' } });
  assert.equal(poll.status, 400);
  // ids that are not ids
  for (const id of ['..%2F..%2Fetc', '%3Cscript%3E', 'l_' + 'x'.repeat(80), 'L_FIXOPEN']) assert.equal((await anon.get('/api/listings/' + id)).status, 404, id);
  assert.equal((await anon.get('/api/users/%3Cimg%3E')).status, 404);
  assert.equal((await p.post('/api/listings/l_fixopen/pay', { json: { readDescription: true, method: 'bitcoin' } })).status, 400);
  assert.equal((await p.post('/api/listings/l_fixopen/pay', { json: { readDescription: 'yes', method: 'card' } })).status, 400);
  assert.equal((await p.get('/api/post-offices?lat=999&lon=0')).status, 400);
  assert.equal((await anon.get('/api/nope')).status, 404);
  assert.doesNotMatch(logs, /TypeError|ReferenceError/, 'no crashes in the log');
});

test('fake images are refused and leave no files behind', async () => {
  const p = await demo('A');
  const before = uploadsNow();
  const fakes = [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('GIF89a' + 'x'.repeat(100)), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4]), Buffer.from('<svg onload=alert(1)>')])];
  for (const f of fakes) {
    assert.equal((await p.post('/api/me/avatar', { form: photoForm(f, 'a.jpg', 'image/jpeg') })).status, 400);
    const s = await p.post('/api/sell', { form: photoForm(f, 'a.jpg', 'image/jpeg', { title: 'Desk lamp', category: 'Home & kitchen', price: '10', description: 'x'.repeat(40) }) });
    assert.equal(s.status, 400, s.text);
  }
  const big = await p.post('/api/me/avatar', { form: photoForm(Buffer.concat([LAMP, Buffer.alloc(6 * 1024 * 1024)]), 'big.jpg') });
  assert.equal(big.status, 400);
  const wrong = new FormData(); wrong.append('other', new Blob([LAMP], { type: 'image/jpeg' }), 'x.jpg');
  assert.equal((await p.post('/api/me/avatar', { form: wrong })).status, 400, 'wrong field');
  assert.deepEqual([...uploadsNow()].filter((f) => !before.has(f)), [], 'no orphan files');
});

test('avatar: real photo works, GPS/EXIF removed, served with nosniff', async () => {
  const p = await demo('A');
  // put a fake EXIF block with a GPS marker (and orientation 6) into the lamp photo
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS-SECRET-52.5200N-13.4050E')]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const withGps = Buffer.concat([LAMP.subarray(0, 2), seg, LAMP.subarray(2), Buffer.from('TRAILING-SECRET')]);
  const r = await p.post('/api/me/avatar', { form: photoForm(withGps, '../../evil.html', 'text/html') });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.avatar, /^\/uploads\/avatar_[0-9a-f]{32}\.jpg$/);
  const img = await fetch(BASE + r.json.avatar);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const buf = Buffer.from(await img.arrayBuffer());
  assert.equal(buf.toString('latin1').includes('GPS-SECRET'), false, 'GPS gone');
  assert.equal(buf.toString('latin1').includes('TRAILING-SECRET'), false, 'trailing data gone');
  assert.ok(buf.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) && buf.subarray(-2).equals(Buffer.from([0xff, 0xd9])), 'still a JPEG');
  assert.ok(buf.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])), 'orientation kept');
  assert.ok(Math.abs(buf.length - LAMP.length) < 100, 'image data intact');
  assert.equal((await fetch(BASE + '/uploads/..%2F..%2F.env')).status, 404);
  assert.equal((await fetch(BASE + '/uploads/evil.html')).status, 404);
  const d = await p.req('DELETE', '/api/me/avatar');
  assert.equal(d.status, 200); assert.equal(d.json.avatar, null);
});

test('label links: no key, wrong key, someone else = 404', async () => {
  for (const k of ['', 'x', 'abcdef', '0'.repeat(24), 'abcdefabcdefabcdefabcdeg', 'ABCDEFABCDEFABCDEFABCDEF']) assert.equal((await anon.get('/label/' + k)).status, 404, k);
  const ok = await anon.get('/label/abcdefabcdefabcdefabcdef'); // the fixture deal's real key
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  assert.match(ok.headers.get('content-security-policy'), /script-src 'nonce-/);
});

test('reviewing or answering someone else\'s deal is 403', async () => {
  const p = await demo('A');
  assert.equal((await p.post('/api/listings/l_fixdone/review', { json: { stars: 5, text: 'fake' } })).status, 403);
  assert.equal((await p.post('/api/listings/l_fixdone/review/reply', { json: { text: 'fake answer' } })).status, 403);
  assert.equal((await seller.post('/api/listings/l_fixopen/review', { json: { stars: 5 } })).status, 400, 'no review before a sale');
});

test('secrets never reach the browser or the log', async () => {
  for (const p of ['/.env', '/server.mjs', '/package.json', '/data/homing.db', '/seed/users.json', '/.git/config']) assert.equal((await anon.get(p)).status, 404, p);
  const meta = await anon.get('/api/meta');
  for (const v of Object.values(meta.json)) assert.ok(typeof v !== 'string', 'meta only has flags and lists');
});

// ===================== main flows (real PayPal sandbox) =====================
let buyer, bought;
test('pay with the sandbox card: server price, verified capture', async () => {
  buyer = await demo('B');
  assert.equal((await seller.post('/api/listings/l_fixopen/pay', { json: { readDescription: true, method: 'card' } })).status, 400, 'not your own item');
  const r = await buyer.post('/api/listings/l_fixopen/pay', { json: { readDescription: true, method: 'card', price: 0.01, amount: 0.01, currency: 'USD' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.paid, true); assert.equal(r.json.listing.status, 'sold'); assert.equal(r.json.listing.price, 12.5);
  bought = r.json.listing;
  const db = new DatabaseSync(DB, { readOnly: true });
  const l = JSON.parse(db.prepare("SELECT body FROM rows WHERE kind='listings' AND id='l_fixopen'").get().body); db.close();
  assert.equal(l.capture.status, 'COMPLETED'); assert.equal(l.capture.amount.value, '12.50'); assert.equal(l.capture.amount.currency_code, 'EUR');
  assert.equal((await buyer.post('/api/listings/l_fixopen/pay', { json: { readDescription: true, method: 'card' } })).status, 409, 'cannot buy twice');
});

test('two buyers racing: only one gets it', async () => {
  const a = await demo('A'), b = await demo('C');
  const [x, y] = await Promise.all([a, b].map((p) => p.post('/api/listings/l_fixrace/pay', { json: { readDescription: true, method: 'card' } })));
  const codes = [x.status, y.status].sort();
  assert.deepEqual(codes, [200, 409], `${x.status} ${y.status} ${x.text} ${y.text}`);
});

test('PayPal button flow: return link can\'t be faked or replayed', async () => {
  const p = await demo('C');
  const r = await p.post('/api/listings/l_fixpp/pay', { json: { readDescription: true, method: 'paypal' } });
  assert.equal(r.status, 200, r.text); assert.match(r.json.payUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  const token = new URL(r.json.payUrl).searchParams.get('token');
  // old-style link with ids: ignored
  const fake = await anon.get(`/paypal/return?listing=l_fixpp&buyer=u_other1&token=FAKE123456`);
  assert.equal(fake.status, 302); assert.match(fake.headers.get('location'), /error=/);
  // the real order, but the buyer never approved it in PayPal: capture fails, nothing is sold
  const notApproved = await anon.get(`/paypal/return?token=${token}`);
  assert.equal(notApproved.status, 302); assert.match(notApproved.headers.get('location'), /error=/);
  const l = await anon.get('/api/listings/l_fixpp');
  assert.equal(l.json.status, 'open');
});

test('ship: seller gets the address and the label; nobody else does', async () => {
  const s = await seller.get('/api/listings/l_fixopen/ship');
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.ship.line1 && s.json.ship.zip, 'seller sees the buyer address');
  assert.equal(s.json.ship.labelKey, undefined);
  assert.equal((await buyer.get('/api/listings/l_fixopen/ship')).status, 404);
  const other = await demo('A');
  assert.equal((await other.get('/api/listings/l_fixopen/ship')).status, 404);
  noLeaks((await other.get('/api/listings/l_fixopen')).json, 'stranger on a sold item');
  const label = await anon.get(new URL(s.json.labelUrl).pathname);
  assert.equal(label.status, 200);
  assert.ok(label.text.includes(s.json.ship.line1.replace(/&/g, '&amp;')), 'label shows the address');
  assert.ok(label.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'title escaped');
  assert.doesNotMatch(label.text, /<script>alert/);
});

test('tracking advances by itself after the label is opened', async () => {
  await wait(2600); // TRACK_DEMO_MINUTES=0.004 makes 9 minutes about 2.2 s
  const r = await buyer.get('/api/listings/l_fixopen');
  assert.equal(r.status, 200); assert.ok(r.json.track, 'buyer sees tracking');
  assert.equal(r.json.track.delivered, true, 'status ' + r.json.track.status);
  assert.equal((await anon.get('/api/listings/l_fixopen')).json.track, null, 'strangers see no tracking');
});

test('review then reply, once each, text kept as plain text', async () => {
  const evil = '<img src=x onerror=alert(1)> great';
  const r = await buyer.post('/api/listings/l_fixopen/review', { json: { stars: 5, text: evil } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await buyer.post('/api/listings/l_fixopen/review', { json: { stars: 1 } })).status, 400, 'once');
  assert.equal((await seller.post('/api/listings/l_fixopen/review', { json: { stars: 2.5 } })).status, 400);
  assert.equal((await seller.post('/api/listings/l_fixopen/review', { json: { stars: 4, text: 'quick payer' } })).status, 200);
  assert.equal((await seller.post('/api/listings/l_fixopen/review/reply', { json: { text: 'Thanks!' } })).status, 200);
  assert.equal((await seller.post('/api/listings/l_fixopen/review/reply', { json: { text: 'again' } })).status, 400, 'once');
  const u = await anon.get('/api/users/u_fixsell');
  const rv = u.json.feed.find((x) => x.listingId === 'l_fixopen');
  assert.equal(rv.text, evil); assert.equal(rv.reply.text, 'Thanks!');
  noLeaks(u.json, 'person page after a deal');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(src, /\$\{esc\(r\.text\)\}/); assert.match(src, /\$\{esc\(r\.reply\.text\)\}/); assert.match(src, /\$\{esc\(done\.text\)\}/);
});

test('browse and my stuff', async () => {
  const b = await buyer.get('/api/listings?country=DE');
  assert.equal(b.status, 200); assert.ok(b.json.some((l) => l.id === 'l_fixpp')); assert.ok(!b.json.some((l) => l.id === 'l_fixopen'), 'sold item gone');
  const me = await buyer.get('/api/me');
  assert.ok(me.json.bought.some((l) => l.id === 'l_fixopen'));
});

test('sell (needs Gemini)', async (t) => {
  const p = await demo('C');
  const r = await p.post('/api/sell', { form: photoForm(LAMP, 'lamp.jpg', 'image/jpeg', { title: 'Desk lamp, silver', category: 'Home & kitchen', price: '18', description: 'Silver desk lamp, works, bulb included, a few light scratches on the base.', accept: 'true' }) });
  if (r.status === 503) { skipped.push('sell'); return t.skip('Gemini not reachable: ' + r.json?.error); }
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.listing.photo, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
  assert.equal(r.json.listing.price, 18);
  noLeaks(r.json, 'sell');
});

test('want (needs Gemini)', async (t) => {
  const p = await demo('C');
  const r = await p.post('/api/wants', { json: { what: 'a chair', category: 'Furniture', minPrice: 0, maxPrice: 30 } });
  if (r.status === 503) { skipped.push('want'); return t.skip('Gemini not reachable: ' + r.json?.error); }
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.want.what, 'a chair');
});

// ===================== legal: terms, reports, my data, delete account =====================
test('fonts are self-hosted and old legal links point to the new pages', async () => {
  for (const f of ['Inter-var.woff2', 'InterTight-var.woff2']) { const r = await anon.get('/fonts/' + f); assert.equal(r.status, 200, f); }
  const html = (await anon.get('/')).text;
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  for (const p of ['privacy', 'terms']) { const r = await anon.get('/' + p + '.html'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/legal/' + p + '.html'); }
  for (const p of ['terms', 'privacy', 'impressum', 'index', 'seller-rules', 'refunds', 'report', 'buyer-protection']) {
    const r = await anon.get('/legal/' + p + '.html'); assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+\s*=|fonts\.googleapis/i, p + ' has no inline script');
  }
  const m = await anon.get('/api/meta'); assert.equal(m.json.terms.version, '2026-11-11');
});

test('sell without accepting the terms is refused (before any AI call)', async () => {
  const p = await demo('D');
  const before = uploadsNow();
  const fields = { title: 'Desk lamp, silver', category: 'Home & kitchen', price: '18', description: 'Silver desk lamp, works, bulb included, a few light scratches on the base.' };
  for (const accept of [undefined, 'false', 'yes', '']) {
    const f = { ...fields }; if (accept !== undefined) f.accept = accept;
    const r = await p.post('/api/sell', { form: photoForm(LAMP, 'lamp.jpg', 'image/jpeg', f) });
    assert.equal(r.status, 400, String(accept) + ' -> ' + r.text); assert.match(r.json.error, /Terms/);
  }
  assert.deepEqual([...uploadsNow()].filter((f) => !before.has(f)), [], 'no files written');
});

test('report: signed-in only, checked, saved, rate-limited', async () => {
  const p = await demo('D');
  assert.equal((await anon.post('/api/report', { json: { kind: 'listing', id: 'l_fixpp', reason: 'fraud' } })).status, 401);
  for (const b of [{ kind: 'post', id: 'l_fixpp', reason: 'fraud' }, { kind: 'listing', id: 'l_fixpp', reason: 'meh' }, { kind: 'listing', id: 'l_fixpp', reason: 'fraud', text: 'x'.repeat(600) }, { kind: 'listing', id: 'l_fixpp', reason: ['fraud'] }, { kind: 'listing', id: 'l_fixpp', reason: 'fraud', text: { a: 1 } }, { kind: 'listing', id: 'l_fixpp', reason: 'toString' }])
    assert.equal((await p.post('/api/report', { json: b })).status, 400, JSON.stringify(b));
  assert.equal((await p.post('/api/report', { json: { kind: 'listing', id: 'l_nothere', reason: 'fraud' } })).status, 404);
  assert.equal((await p.post('/api/report', { json: { kind: 'user', id: 'u_nothere', reason: 'other' } })).status, 404);
  const ok = await p.post('/api/report', { json: { kind: 'listing', id: 'l_fixpp', reason: 'photo', text: '<b>not</b> the same chair' } });
  assert.equal(ok.status, 200, ok.text);
  const u = await p.post('/api/report', { json: { kind: 'user', id: 'u_fixsell', reason: 'fraud' } });
  assert.equal(u.status, 200, u.text);
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(ok.json.id); db.close();
  assert.equal(row.kind, 'listing'); assert.equal(row.target, 'l_fixpp'); assert.equal(row.reason, 'photo'); assert.equal(row.status, 'open'); assert.equal(row.text, '<b>not</b> the same chair');
  let hit = false;
  for (let i = 0; i < 8; i++) if ((await p.post('/api/report', { json: { kind: 'listing', id: 'l_fixpp', reason: 'other' } })).status === 429) { hit = true; break; }
  assert.ok(hit, 'reports are rate-limited');
});

test('export: a JSON file with only my own data', async () => {
  assert.equal((await anon.get('/api/me/export')).status, 401);
  const r = await seller.get('/api/me/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="homing-data\.json"/);
  const d = r.json;
  assert.equal(d.user.id, 'u_fixsell'); assert.equal(d.user.email, 'fixa@example.com');
  assert.ok(d.selling.some((l) => l.id === 'l_fixpp'));
  assert.ok(!r.text.includes('PPID-SECRET'), 'no PayPal id'); assert.ok(!r.text.includes('labelKey'), 'no label key');
  for (const w of ['Olli', 'Otto Other', 'Geheimstraße', 'olli@example.com', 'u_other1']) assert.ok(!r.text.includes(w), 'other people: ' + w);
  const p = await demo('D');
  const mine = (await p.get('/api/me/export')).json;
  assert.ok(mine.reports.length >= 2, 'my reports are in it');
  assert.ok(!JSON.stringify(mine).includes('fixa@example.com'));
});

test('delete my account: profile, photo, sessions gone; signed out', async () => {
  const p = new Person();
  const s = await p.post('/api/signin/demo', { json: {} }); assert.equal(s.status, 200, s.text);
  const uid = s.json.id;
  const second = new Person(p.cookie); // a second device with the same account
  const av = await p.post('/api/me/avatar', { form: photoForm(LAMP, 'me.jpg') }); assert.equal(av.status, 200, av.text);
  const file = path.join(TMP, 'uploads', path.basename(av.json.avatar));
  assert.ok(fs.existsSync(file));
  assert.equal((await anon.req('DELETE', '/api/me')).status, 401);
  assert.equal((await p.req('DELETE', '/api/me', { headers: { origin: 'https://evil.example' } })).status, 403, 'cross-site refused');
  const d = await p.req('DELETE', '/api/me');
  assert.equal(d.status, 200, d.text);
  assert.equal(p.cookie, '', 'cookie cleared');
  assert.ok(!fs.existsSync(file), 'avatar file removed');
  assert.equal((await second.get('/api/whoami')).status, 401, 'every session ended');
  assert.equal((await anon.get('/api/users/' + uid)).status, 404);
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = JSON.parse(db.prepare("SELECT body FROM rows WHERE kind = 'users' AND id = ?").get(uid).body);
  const n = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n; db.close();
  assert.deepEqual(Object.keys(row).sort(), ['at', 'deleted', 'id']); assert.equal(n, 0);
});

test('delete my account is refused while a recent deal is not delivered', async () => {
  // u_other2 sold "Fresh deal" just before the start and nobody opened its label: not delivered yet
  const t = crypto.randomBytes(32).toString('base64url');
  const db = new DatabaseSync(DB); db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha(t), 'u_other2', Date.now(), Date.now() + 86400e3); db.close();
  const r = await new Person('homing_sid=' + t).req('DELETE', '/api/me');
  assert.equal(r.status, 400, r.text); assert.match(r.json.error, /open deals/);
});

test('backup file is written', () => {
  const files = fs.readdirSync(path.join(TMP, 'backups'));
  assert.ok(files.some((f) => /^homing-\d{4}-\d{2}-\d{2}\.db$/.test(f)), files.join());
});

test('rate limit kicks in on demo sign-in', async () => {
  let hit = 0;
  for (let i = 0; i < 15; i++) { const r = await new Person().post('/api/signin/demo', { json: {} }); if (r.status === 429) { hit = i + 1; assert.ok(r.headers.get('retry-after')); break; } }
  assert.ok(hit > 0, 'got a 429');
});

test('no secret appears in any response or in the log', () => {
  assert.ok(SECRETS.length > 0 || true);
  for (const v of SECRETS) {
    assert.ok(!seenBodies.some((b) => b.includes(v)), 'a secret was in a response');
    assert.ok(!logs.includes(v), 'a secret was in the log');
  }
  assert.doesNotMatch(logs, /Something went wrong|TypeError|ReferenceError/);
});
