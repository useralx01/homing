// Homing: the fastest way to buy and sell near you.
// Sell: photo, what it is, category, price, full description. AI checks the photo and hands it
// to the people already looking for it. Buy: say what you want and your price range; AI finds it.
// Every deal is paid with PayPal. Reviews only exist on finished deals, so none can be faked.
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets tests (or a host with a mounted volume) keep everything somewhere else
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_PATH = path.resolve(process.env.DB_FILE || path.join(DATA, 'homing.db'));
const UPLOADS = path.join(DATA, 'uploads');
const BACKUPS = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(UPLOADS, { recursive: true });

// An error whose message is meant for the person (everything else becomes "Something went wrong.")
class UserError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new UserError(400, msg);

const PORT = Number(process.env.PORT || 4321);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.5-flash').split(',').map((s) => s.trim()).filter(Boolean);
const PP_ID = process.env.PAYPAL_CLIENT_ID || '';
const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const SANDBOX = process.env.PAYPAL_ENV !== 'live';
const PP_API = SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const PP_WEB = SANDBOX ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
// links that come back to us use the address the person opened (localhost on the PC, the LAN address on a phone)
// (a Host header that doesn't look like a host is ignored, so nobody can point our links elsewhere)
const HOST_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const origin = (q) => process.env.BASE_URL || !HOST_RE.test(q.get('host') || '') ? BASE_URL : `${q.protocol}://${q.get('host')}`;

// Everything is locked to one country: no shipping across borders.
const COUNTRIES = {
  DE: { name: 'Germany', currency: 'EUR' }, AT: { name: 'Austria', currency: 'EUR' }, CH: { name: 'Switzerland', currency: 'CHF' },
  FR: { name: 'France', currency: 'EUR' }, NL: { name: 'Netherlands', currency: 'EUR' }, ES: { name: 'Spain', currency: 'EUR' },
  IT: { name: 'Italy', currency: 'EUR' }, GB: { name: 'United Kingdom', currency: 'GBP' }, US: { name: 'United States', currency: 'USD' },
};
const CATEGORIES = ['Furniture', 'Home & kitchen', 'Electronics', 'Music', 'Bikes & sport', 'Fashion', 'Plants', 'Other'];
// the version of public/legal/terms.html; stored with every sign-in, listing and purchase
const TERMS_VERSION = '2026-11-11';
const accepted = () => ({ version: TERMS_VERSION, at: Date.now() });
const REPORT_REASONS = { illegal: 'Illegal item', banned: 'Banned item', fake: 'Fake or stolen', photo: 'Wrong photo', fraud: 'Fraud', review: 'Abusive review', other: 'Other' };

// ---------- storage: one SQLite database (data/homing.db) ----------
// Every person, item, want, review and shipment is a row. Rows are also kept in memory for speed;
// each change is written in one transaction, only the rows that changed. Photos live in data/uploads.
const file = (n) => path.join(DATA, n);
const seed = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', n), 'utf8'));
const legacy = (n) => { try { const v = JSON.parse(fs.readFileSync(file(n), 'utf8')); if (Array.isArray(v) && (n !== 'listings.json' || v[0]?.sellerId)) return v; } catch {} return seed(n); };
const db = new DatabaseSync(DB_PATH);
// WAL + one transaction per change: a crash mid-write rolls back to the last whole commit, never half a row.
db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS rows (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, buyer_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, at INTEGER NOT NULL, by_user TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL);`);
const KINDS = { users: 'users.json', listings: 'listings.json', wants: 'wants.json' };
const readKind = (k) => db.prepare('SELECT body FROM rows WHERE kind = ? ORDER BY rowid').all(k).map((r) => JSON.parse(r.body));
const putRow = db.prepare('INSERT INTO rows (kind, id, body) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body');
const delRow = db.prepare('DELETE FROM rows WHERE kind = ? AND id = ?');
const written = { users: new Map(), listings: new Map(), wants: new Map() };
for (const k of Object.keys(KINDS)) for (const r of readKind(k)) written[k].set(r.id, JSON.stringify(r));
const loadKind = (k) => { const v = readKind(k); return v.length ? v : legacy(KINDS[k]); }; // first run takes the old JSON files over
let users = loadKind('users');
let listings = loadKind('listings');
let wants = loadKind('wants');
const persist = () => {
  // work out the changes first, write them in one transaction, and only then remember them as written,
  // so a failed write is simply tried again next time
  const puts = [], dels = [];
  for (const [k, list] of [['users', users], ['listings', listings], ['wants', wants]]) {
    const seen = new Set();
    for (const r of list) { const b = JSON.stringify(r); seen.add(r.id); if (written[k].get(r.id) !== b) puts.push([k, r.id, b]); }
    for (const rid of written[k].keys()) if (!seen.has(rid)) dels.push([k, rid]);
  }
  if (!puts.length && !dels.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [k, rid, b] of puts) putRow.run(k, rid, b);
    for (const [k, rid] of dels) delRow.run(k, rid);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  for (const [k, rid, b] of puts) written[k].set(rid, b);
  for (const [k, rid] of dels) written[k].delete(rid);
};
persist();
const id = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const userOf = (uid) => users.find((u) => u.id === uid);
const currencyOf = (c) => COUNTRIES[c]?.currency || 'EUR';

// ---------- sessions: a random token in an httpOnly cookie; only its hash is stored ----------
const SID = 'homing_sid';
const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sessIns = db.prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?, ?, ?, ?)');
const sessGet = db.prepare('SELECT user_id, expires FROM sessions WHERE hash = ?');
const sessDel = db.prepare('DELETE FROM sessions WHERE hash = ?');
const sessPurge = db.prepare('DELETE FROM sessions WHERE expires < ?');
const cookies = (q) => {
  const out = Object.create(null);
  for (const part of String(q.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (!(k in out)) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
};
const tokenOf = (q) => { const t = cookies(q)[SID]; return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };
const cookieFlags = (q) => `Path=/; HttpOnly; SameSite=Lax${q.secure ? '; Secure' : ''}`;
function startSession(q, s, u) {
  const old = tokenOf(q); if (old) sessDel.run(sha(old)); // a fresh token at every sign-in
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessIns.run(sha(token), u.id, now, now + SESSION_DAYS * 86400e3);
  s.append('Set-Cookie', `${SID}=${token}; ${cookieFlags(q)}; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSession(q, s) {
  const t = tokenOf(q); if (t) sessDel.run(sha(t));
  s.append('Set-Cookie', `${SID}=; ${cookieFlags(q)}; Max-Age=0`);
}
const sessionUser = (q) => {
  const t = tokenOf(q); if (!t) return null;
  const row = sessGet.get(sha(t));
  if (!row || row.expires < Date.now()) return null;
  const u = userOf(row.user_id);
  return u && !u.deleted ? u : null;
};
setInterval(() => { try { sessPurge.run(Date.now()); } catch {} }, 3600e3).unref();

// ---------- daily backup: data/backups/homing-YYYY-MM-DD.db, the last 7 kept ----------
function backup() {
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const out = path.join(BACKUPS, `homing-${day}.db`);
    if (!fs.existsSync(out)) db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(BACKUPS).filter((f) => /^homing-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
    for (const f of old) fs.rmSync(path.join(BACKUPS, f), { force: true });
  } catch (e) { console.error('backup failed:', e.message); }
}
backup();
setInterval(backup, 3600e3).unref(); // checks every hour, writes once a day

// ---------- uploads: trust the bytes, never the browser's label or file name ----------
// Returns { ext, buf } with location and other metadata removed, or null if it is not a JPEG/PNG/WebP photo.
function cleanImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg', buf: stripJpeg(buf) };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png', buf: stripPng(buf) };
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp', buf: stripWebp(buf) };
  } catch { return null; }
  return null;
}
// JPEG: drop EXIF (GPS, camera, time), XMP, IPTC and comments. Keep the colour profile and, if the
// photo was turned, a tiny new EXIF block with only the turn so phones' photos still stand upright.
function stripJpeg(b) {
  const parts = [b.subarray(0, 2)];
  let i = 2, orientation = 1, ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('bad jpeg');
    while (b[i] === 0xff) i++; // fill bytes
    const m = b[i]; const start = i - 1; i++;
    if (m === 0xd9) { parts.push(Buffer.from([0xff, 0xd9])); ended = true; break; } // anything after the end (extra images with their own EXIF) is dropped
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(b.subarray(start, i)); continue; }
    if (i + 2 > b.length) throw new Error('bad jpeg');
    const len = b.readUInt16BE(i); if (len < 2 || i + len > b.length) throw new Error('bad jpeg');
    const seg = b.subarray(start, i + len), body = b.subarray(i + 2, i + len);
    if (m === 0xe1) { const o = exifOrientation(body); if (o) orientation = o; }
    const icc = m === 0xe2 && body.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
    const drop = m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee && !icc);
    if (!drop) parts.push(seg);
    i += len;
    if (m === 0xda) { // image data: copy up to the next real marker
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7) && b[j + 1] !== 0xff)) j++;
      parts.push(b.subarray(i, j)); i = j;
    }
  }
  if (!ended) throw new Error('bad jpeg');
  if (orientation !== 1) {
    const ex = Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    parts.splice(1, 0, ex);
  }
  return Buffer.concat(parts);
}
function exifOrientation(p) {
  try {
    if (p.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
    const t = p.subarray(6); const le = t.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = u32(4), n = u16(ifd);
    for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; } }
  } catch {}
  return 0;
}
// PNG: drop text, time and EXIF chunks
function stripPng(b) {
  const parts = [b.subarray(0, 8)]; let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (end > b.length) throw new Error('bad png');
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) parts.push(b.subarray(i, end));
    i = end; if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}
// WebP: drop EXIF and XMP chunks and their flags
function stripWebp(b) {
  const parts = []; let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) throw new Error('bad webp');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (type === 'VP8X') c[8] &= ~0x0c;
      parts.push(c);
    }
    i = end;
  }
  const body = Buffer.concat(parts), head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
// leftovers from the old upload code (temp files without an extension) are cleared at start
try {
  for (const f of fs.readdirSync(UPLOADS)) {
    const p = path.join(UPLOADS, f);
    if (!path.extname(f) && fs.statSync(p).isFile() && Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true });
  }
} catch {}

// ---------- input checks ----------
const ID_RE = /^[a-z]_[a-z0-9_]{1,40}$/;
const str = (v, { min = 0, max, name = 'text', msg } = {}) => {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(msg || `That ${name} is not valid.`);
  const t = v.trim();
  if (t.length > max) throw bad(`That ${name} is too long (max ${max}).`);
  if (t.length < min) throw bad(msg || `That ${name} is too short.`);
  return t;
};
const num = (v, { min, max, msg }) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw bad(msg);
  return n;
};
const MAX_PRICE = 100000;
// ---------- Gemini ----------
async function gemini(parts, prompt) {
  if (!GEMINI_KEY) throw new UserError(503, 'The AI check is not set up on this server.');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  // Try the chosen model first; if Google is busy, fall back so a deal never stalls.
  const models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
  let last;
  for (const m of models) {
    let r;
    try {
      // the key goes in a header, never in the URL (URLs end up in logs and error messages)
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body, signal: AbortSignal.timeout(12000) });
    } catch (e) { last = `${m}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { last = `${m}: ${j.error?.message || r.status}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text.replace(/^```json\s*|```$/g, '')); } catch { last = `${m}: bad JSON`; }
  }
  console.error('gemini failed:', String(last).slice(0, 200));
  throw new UserError(503, 'The AI is busy. Try again in a moment.');
}

// AI looks at the photo: is it really what the seller wrote, and what can be seen.
async function readPhoto(buf, mime, title, description) {
  const data = buf.toString('base64');
  const r = await gemini(
    [{ inline_data: { mime_type: mime, data } }],
    `A private person sells something. They wrote:
Title: "${title}"
Description: "${description}"
Look at the photo. Return JSON only:
{"shows_item": true if the photo shows a real photo of the item in the title, false if it shows something else, a screen, a drawing or nothing,
 "facts": [2-4 short things you can SEE in the photo, max 5 words each, never brand names],
 "missing": [things a buyer would want to know that the description does not say, max 2, max 6 words each; empty if complete]}`,
  );
  // the AI's answer is data too: keep only short strings
  const list = (v, n) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => x.trim().slice(0, 60));
  return { shows_item: r?.shows_item !== false, facts: list(r?.facts, 4), missing: list(r?.missing, 2) };
}

// One AI pass: which of these candidates is really the same kind of thing.
async function sameKind(item, candidates) {
  if (!candidates.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await gemini([], `Item: ${JSON.stringify(item)}
Candidates: ${JSON.stringify(candidates)}
For EVERY candidate (same order) say if it is the same kind of thing as the item, JSON:
{"results":[{"id": candidate id, "same_kind": true|false, "score": 0-100 fit, "why": max 10 words, never he/she}]}
Colour or small differences only lower the score. Different kinds of things are false.`);
    const raw0 = Array.isArray(res) ? res : res?.results;
    const raw = (Array.isArray(raw0) ? raw0 : []).filter((r) => r && typeof r === 'object');
    const hits = raw.map((r) => ({ id: String(r.id || '').trim(), score: Math.max(0, Math.min(100, Number(r.score) || 0)), why: String(r.why || '').slice(0, 80) }))
      .filter((r) => candidates.some((c) => c.id === r.id) && raw.find((x) => String(x.id).trim() === r.id)?.same_kind !== false && r.score >= 50);
    if (hits.length || attempt) return hits.sort((a, b) => b.score - a.score);
  }
  return [];
}

// A new listing goes to everyone in the same country looking for that category in that price range.
async function wantsFor(l) {
  const open = wants.filter((w) => w.status === 'open' && w.country === l.country && w.userId !== l.sellerId && w.category === l.category && l.price >= (w.minPrice || 0) && l.price <= w.maxPrice);
  const hits = await sameKind({ title: l.title, description: l.description }, open.map((w) => ({ id: w.id, looking_for: w.what })));
  for (const h of hits) {
    const w = wants.find((x) => x.id === h.id);
    if (!w.matches.some((m) => m.listingId === l.id)) w.matches.unshift({ listingId: l.id, score: h.score, why: h.why, at: Date.now() });
  }
  return hits.map((h) => ({ ...h, name: wants.find((w) => w.id === h.id).name }));
}

// A new want looks through what is already for sale.
async function listingsFor(w) {
  const open = listings.filter((l) => l.status === 'open' && l.country === w.country && l.sellerId !== w.userId && l.category === w.category && l.price >= (w.minPrice || 0) && l.price <= w.maxPrice);
  const hits = await sameKind({ looking_for: w.what }, open.map((l) => ({ id: l.id, title: l.title, description: l.description.slice(0, 200) })));
  w.matches = hits.map((h) => ({ listingId: h.id, score: h.score, why: h.why, at: Date.now() }));
  return w.matches;
}

// ---------- PayPal ----------
let ppToken = { value: '', exp: 0 };
async function paypalToken() {
  if (!PP_ID || !PP_SECRET) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env');
  if (ppToken.value && Date.now() < ppToken.exp) return ppToken.value;
  const r = await fetch(PP_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(PP_ID + ':' + PP_SECRET).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal auth: ' + (j.error_description || r.status));
  ppToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return ppToken.value;
}
async function pp(method, p, body) {
  const r = await fetch(PP_API + p, {
    method,
    headers: { authorization: 'Bearer ' + (await paypalToken()), 'content-type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID(), prefer: 'return=representation' }, // full answer, so the capture can be checked
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal: ' + (j.details?.[0]?.description || j.message || r.status));
  return j;
}
// text that goes to PayPal: no markup characters (PayPal's firewall refuses them with a 406)
const ppText = (v, n) => String(v ?? '').replace(/[<>"'`{}\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function purchaseUnit(l, buyer) {
  const unit = {
    reference_id: l.id,
    custom_id: `${l.id}:${buyer.id}`,
    description: ppText(`${l.title} (Homing)`, 127),
    amount: { currency_code: currencyOf(l.country), value: Number(l.price).toFixed(2) },
  };
  const seller = userOf(l.sellerId);
  if (seller?.paypal) unit.payee = { email_address: seller.paypal };
  if (buyer.address) unit.shipping = { name: { full_name: ppText(buyer.fullName || buyer.name, 120) || 'Buyer' }, address: ppAddress(buyer.address) };
  return unit;
}
const ppAddress = (a) => ({ address_line_1: ppText(a.line1, 300), ...(a.line2 ? { address_line_2: ppText(a.line2, 300) } : {}), admin_area_2: ppText(a.city, 120), postal_code: ppText(a.zip, 60), country_code: a.country });
async function paypalCheckout(l, buyer, base) {
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(l, buyer)],
    payment_source: { paypal: { experience_context: {
      brand_name: 'Homing', user_action: 'PAY_NOW', shipping_preference: buyer.address ? 'SET_PROVIDED_ADDRESS' : 'GET_FROM_FILE',
      // no ids in the link: the server remembers which order belongs to which item and buyer
      return_url: `${base}/paypal/return`,
      cancel_url: `${base}/?item=${encodeURIComponent(l.id)}`,
    } } },
  });
  const payUrl = order.links?.find((l2) => l2.rel === 'payer-action')?.href;
  if (!order.id || !payUrl) throw new Error('PayPal: no approval link');
  orderIns.run(order.id, l.id, buyer.id, Date.now());
  return { orderId: order.id, payUrl };
}
const orderIns = db.prepare('INSERT OR REPLACE INTO orders (id, listing_id, buyer_id, at) VALUES (?, ?, ?, ?)');
const orderGet = db.prepare('SELECT listing_id, buyer_id, at FROM orders WHERE id = ?');
const orderDel = db.prepare('DELETE FROM orders WHERE id = ?');
const ORDER_TTL = 3 * 3600e3; // PayPal approvals run out after about 3 hours
// Sandbox only: PayPal's own test card, so anyone can try a full payment without a sandbox login.
async function sandboxCardPay(l, buyer) {
  if (!SANDBOX || !PP_API.includes('sandbox')) throw new UserError(400, 'Test card only works in sandbox.');
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(l, buyer)],
    payment_source: { card: { number: '4111111111111111', expiry: '2030-12', name: ppText(buyer.name, 60) || 'Buyer', security_code: '123' } },
  });
  if (order.status !== 'COMPLETED') return captureOrder(order.id);
  return order;
}
async function captureOrder(orderId) {
  const oid = encodeURIComponent(orderId);
  try { return await pp('POST', `/v2/checkout/orders/${oid}/capture`); }
  catch (e) {
    // A refresh can arrive after PayPal already captured it: read the order instead of failing.
    const o = await pp('GET', `/v2/checkout/orders/${oid}`);
    if (o.status !== 'COMPLETED') throw e;
    return o;
  }
}
// The money really arrived: completed, for this item, the full price in the right currency.
function checkCapture(l, cap) {
  const pu = cap?.purchase_units?.[0];
  const c = pu?.payments?.captures?.[0];
  if (cap?.status !== 'COMPLETED' || !c || c.status !== 'COMPLETED') return 'not completed';
  if (pu.reference_id && pu.reference_id !== l.id) return 'other item';
  if (c.amount?.currency_code !== currencyOf(l.country)) return 'wrong currency';
  if (Math.round(Number(c.amount?.value) * 100) !== Math.round(Number(l.price) * 100)) return 'wrong amount';
  return '';
}
async function refund(cap, why) {
  const c = cap?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!c?.id || c.status !== 'COMPLETED') return;
  try { await pp('POST', `/v2/payments/captures/${encodeURIComponent(c.id)}/refund`, {}); console.error('refunded capture:', why); }
  catch (e) { console.error('REFUND FAILED, refund by hand in PayPal:', c.id, why, e.message); }
}
// One payment per item at a time, so two buyers racing can never both be charged.
const paying = new Set();
function markSold(l, buyer, cap, via) {
  const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
  l.status = 'sold'; l.buyerId = buyer.id; l.soldAt = Date.now();
  l.capture = { id: c?.id || cap.id, orderId: cap.id, status: c?.status || cap.status, amount: c?.amount, via };
  l.reviews = {};
  l.buyerAccepted = accepted(); // the buy sheet says "By buying you accept the Terms"
  // where it goes: the address PayPal confirmed for this payment, else the buyer's PayPal profile
  const sh = cap.purchase_units?.[0]?.shipping;
  const a = sh?.address;
  l.ship = {
    name: sh?.name?.full_name || buyer.fullName || buyer.name,
    ...(a ? { line1: a.address_line_1 || '', line2: a.address_line_2 || '', city: a.admin_area_2 || '', zip: a.postal_code || '', country: a.country_code || l.country } : buyer.address || {}),
    code: 'HM-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    labelKey: crypto.randomBytes(12).toString('hex'),
  };
  shipNotes(l).then((n) => { l.ship.notes = n; persist(); }).catch(() => {});
  ensureShipment(l);
  // anyone else who was matched to it simply sees it's gone; the buyer's want is done
  for (const w of wants) if (w.userId === buyer.id && w.status === 'open' && w.matches.some((m) => m.listingId === l.id)) w.status = 'done';
  persist();
}

// AI writes short packing notes for this exact item
async function shipNotes(l) {
  try {
    const r = await gemini([], `Someone sold "${l.title}" (${l.category}) and must post it in ${COUNTRIES[l.country]?.name}. Description: "${l.description.slice(0, 400)}".
Return JSON only: {"box":"which parcel size and why, max 8 words","steps":["3 short packing steps, max 9 words each"]}`);
    if (r?.box && Array.isArray(r.steps)) return { box: String(r.box), steps: r.steps.slice(0, 3).map(String) };
  } catch {}
  return { box: 'A box that fits it with a little room', steps: ['Wrap it in paper or bubble wrap', 'Fill the gaps so nothing moves', 'Write the code on the box'] };
}

// Post offices near the seller, from OpenStreetMap
const geoCache = new Map();
const UA = { 'user-agent': 'Homing-marketplace-demo/1.0', accept: 'application/json' };
async function geocode(a) {
  const k = [a.line1, a.zip, a.city, a.country].join('|');
  if (geoCache.has(k)) return geoCache.get(k);
  const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&' + new URLSearchParams({ street: a.line1 || '', postalcode: a.zip || '', city: a.city || '', countrycodes: (a.country || '').toLowerCase() });
  let j = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) })).json().catch(() => []);
  if (!j[0]) j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&' + new URLSearchParams({ q: [a.zip, a.city, a.country].join(' ') }), { headers: UA, signal: AbortSignal.timeout(15000) })).json().catch(() => []);
  const p = j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null;
  geoCache.set(k, p); return p;
}
const km = (a, b) => { const R = 6371, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r; const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const postCache = new Map();
async function postOffices(p) {
  const k = p.lat.toFixed(3) + ',' + p.lon.toFixed(3);
  if (postCache.has(k)) return postCache.get(k);
  // OpenStreetMap search for post offices in a box of about 3 km around the seller
  const d = 0.03, box = [p.lon - d * 1.6, p.lat + d, p.lon + d * 1.6, p.lat - d].join(',');
  const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', amenity: 'post_office', viewbox: box, bounded: '1', limit: '15', addressdetails: '1', extratags: '1' });
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new UserError(503, 'The map service is busy, try again in a moment.');
  const seen = new Set();
  const out = (await r.json()).map((e) => {
    const a = e.address || {}, at = { lat: +e.lat, lon: +e.lon };
    return { name: e.name || 'Post office', street: [a.road, a.house_number].filter(Boolean).join(' '), city: a.city || a.town || a.suburb || '', hours: e.extratags?.opening_hours || '', km: Math.round(km(p, at) * 10) / 10, lat: at.lat, lon: at.lon };
  }).filter((o) => !seen.has(o.name + o.street) && seen.add(o.name + o.street)).sort((a, b) => a.km - b.km).slice(0, 3);
  postCache.set(k, out); return out;
}

// ---------- automatic shipping + tracking (like a big shop: nobody types a tracking number) ----------
// At the sale Homing books the parcel with the carrier: the label carries the parcel number, the number goes
// into the PayPal payment by itself, and the steps update by themselves.
// Real DHL needs a DHL business customer account (GKP) + an API key from developer.dhl.com (DHL_API_KEY ...).
// Until then the carrier is a SANDBOX parcel: same flow, test number, steps move on a short demo clock,
// and every screen says "Sandbox". Never shown as a real parcel.
const CARRIER_MODE = process.env.DHL_API_KEY && process.env.DHL_GKP_USER ? 'dhl' : 'sandbox';
const MIN = 60 * 1000;
const DEMO_CLOCK = Number(process.env.TRACK_DEMO_MINUTES || 1); // 1 = one step per minute or two
const STEPS = [
  { key: 'paid', label: 'Paid with PayPal' },
  { key: 'label', label: 'Label ready' },
  { key: 'dropped', label: 'Handed to DHL' },
  { key: 'transit', label: 'On the way' },
  { key: 'out', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
];
// sandbox: minutes after the label is first opened (printing it = packing it)
const SANDBOX_AFTER = { dropped: 2, transit: 4, out: 7, delivered: 9 };
const HUBS = { DE: ['Berlin', 'Leipzig hub', 'Berlin delivery base'] };
function ensureShipment(l) {
  if (l.status !== 'sold') return null;
  const sh = l.ship || (l.ship = {});
  if (!l.shipment) {
    const number = l.tracking?.number || ('TEST' + String(crypto.randomInt(1e9)).padStart(9, '0') + String(crypto.randomInt(1e3)).padStart(3, '0'));
    l.shipment = { carrier: 'DHL', mode: l.tracking?.number ? 'manual' : CARRIER_MODE, number, bookedAt: l.soldAt || Date.now(), labelAt: null };
    l.tracking = { carrier: 'DHL', carrierName: l.shipment.mode === 'sandbox' ? 'DHL (sandbox)' : 'DHL', number, inPayPal: !!l.tracking?.inPayPal, at: Date.now(), auto: true };
    persist();
    pushTrackingToPayPal(l);
  }
  return l.shipment;
}
async function pushTrackingToPayPal(l) {
  if (l.tracking?.inPayPal || !l.capture?.orderId || !l.capture?.id) return;
  try {
    await pp('POST', `/v2/checkout/orders/${l.capture.orderId}/track`, { capture_id: l.capture.id, tracking_number: l.tracking.number, carrier: 'DHL', notify_payer: true });
    l.tracking.inPayPal = true; persist();
  } catch (e) { console.error('paypal track', e.message); }
}
// The status right now, worked out from the clock (sandbox) or from the carrier (real).
function trackOf(l) {
  const sm = ensureShipment(l); if (!sm) return null;
  const now = Date.now();
  const at = { paid: l.soldAt, label: sm.labelAt };
  if (sm.mode === 'sandbox' && sm.labelAt) for (const [k, m] of Object.entries(SANDBOX_AFTER)) if (now >= sm.labelAt + m * MIN * DEMO_CLOCK) at[k] = sm.labelAt + m * MIN * DEMO_CLOCK;
  for (const e of sm.events || []) at[e.key] = at[e.key] || e.at; // real carrier events
  const done = STEPS.filter((x) => at[x.key]);
  const cur = done[done.length - 1] || STEPS[0];
  const city = HUBS[l.country] || [];
  const where = { dropped: l.ship?.city ? 'Post office' : '', transit: city[1] || '', out: l.ship?.city || '', delivered: l.ship?.city || '' };
  const events = done.map((x) => ({ key: x.key, label: x.label, at: at[x.key], where: where[x.key] || '' })).reverse();
  // a simple promise like the shops give: 2 days after it is handed over
  const handed = at.dropped || (at.label ? at.label + 2 * 3600e3 : l.soldAt + 24 * 3600e3);
  const eta = at.delivered || (sm.mode === 'sandbox' && sm.labelAt ? sm.labelAt + SANDBOX_AFTER.delivered * MIN * DEMO_CLOCK : handed + 2 * 86400e3);
  const say = { paid: 'The seller is packing it', label: 'Packed, waiting for DHL', dropped: 'DHL has it', transit: 'On the way to you', out: 'Arriving today', delivered: 'Delivered' }[cur.key];
  return {
    carrier: 'DHL', number: sm.number, sandbox: sm.mode === 'sandbox', inPayPal: !!l.tracking?.inPayPal,
    status: cur.key, say, eta, delivered: !!at.delivered,
    steps: STEPS.map((x) => ({ key: x.key, label: x.label, at: at[x.key] || null })), events,
  };
}

// ---------- shapes sent to the page ----------
function stats(uid) {
  const sold = listings.filter((l) => l.status === 'sold' && l.sellerId === uid);
  const bought = listings.filter((l) => l.status === 'sold' && l.buyerId === uid);
  const got = [...sold.map((l) => l.reviews?.buyer), ...bought.map((l) => l.reviews?.seller)].filter(Boolean);
  const avg = got.length ? got.reduce((a, r) => a + r.stars, 0) / got.length : null;
  return { sold: sold.length, bought: bought.length, reviews: got.length, stars: avg && Math.round(avg * 10) / 10 };
}
const FORMER = 'Former member';
const person = (uid) => { const u = userOf(uid); if (u?.deleted) return { id: u.id, name: FORMER, avatar: null, deleted: true, ...stats(u.id) }; return u ? { id: u.id, name: u.name, avatar: u.avatar || null, ...stats(u.id) } : null; };
const card = (l) => ({ id: l.id, title: l.title, price: l.price, currency: currencyOf(l.country), photo: l.photo, category: l.category, status: l.status, at: l.at });
const full = (l, viewer) => ({
  ...card(l), description: l.description, facts: l.facts || [], country: l.country, seller: person(l.sellerId),
  buyer: l.buyerId ? person(l.buyerId) : null, mine: viewer === l.sellerId, boughtByMe: !!viewer && viewer === l.buyerId,
  reviews: l.status === 'sold' ? { buyer: l.reviews?.buyer || null, seller: l.reviews?.seller || null } : null,
  soldAt: l.soldAt || null, tracking: viewer && (viewer === l.sellerId || viewer === l.buyerId) ? l.tracking || null : null,
  track: l.status === 'sold' && viewer && (viewer === l.sellerId || viewer === l.buyerId) ? trackOf(l) : null,
});

// what a signed-in person sees about themselves (never PayPal ids, never other people's data)
const self = (u) => ({ id: u.id, name: u.name, fullName: u.fullName || u.name, country: u.country, avatar: u.avatar || null, via: u.via || 'name' });
const findListing = (lid) => (typeof lid === 'string' && ID_RE.test(lid) ? listings.find((x) => x.id === lid) : undefined);
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
// behind a proxy (a host with https in front) set TRUST_PROXY=1 so the real address and https are seen
app.set('trust proxy', process.env.TRUST_PROXY ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : 'loopback');

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self'", "img-src 'self' data: blob:", "media-src 'self' data: blob:",
  "connect-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((q, s, next) => {
  s.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), serial=(), hid=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (q.secure) s.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// Changes only from our own pages: a form or script on another site can't act for a signed-in person.
app.use((q, s, next) => {
  if (q.method === 'GET' || q.method === 'HEAD' || q.method === 'OPTIONS') return next();
  const o = q.get('origin');
  if (o !== undefined) { let h = ''; try { h = new URL(o).host; } catch {} if (h !== q.get('host')) return s.status(403).json({ error: 'Not allowed.' }); }
  if (q.get('sec-fetch-site') === 'cross-site') return s.status(403).json({ error: 'Not allowed.' });
  next();
});

// ---------- rate limits: a small token bucket per person or address ----------
const buckets = new Map();
// takes one token; returns 0, or how many seconds to wait
function take(k, cap, perMin) {
  const now = Date.now();
  let b = buckets.get(k);
  if (!b) { b = { t: cap, at: now }; buckets.set(k, b); }
  b.t = Math.min(cap, b.t + ((now - b.at) / 60000) * perMin); b.at = now;
  if (b.t < 1) return Math.ceil(((1 - b.t) / perMin) * 60);
  b.t -= 1; return 0;
}
const TOO_MANY = 'Too many tries. Wait a moment and try again.';
function limit(name, cap, perMin, keyOf = (q) => q.ip) {
  return (q, s, next) => {
    const wait = take(name + '|' + keyOf(q), cap, perMin);
    if (wait) { s.set('Retry-After', String(wait)); return s.status(429).json({ error: TOO_MANY }); }
    next();
  };
}
// the same, inside a route: used after the input is checked, so only real AI calls are counted
function gate(q, s, name, cap, perMin) {
  const wait = take(name + '|' + (q.user?.id || q.ip), cap, perMin);
  if (wait) { s.set('Retry-After', String(wait)); throw new UserError(429, TOO_MANY); }
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 3600e3) buckets.delete(k); }, 600e3).unref();
const byUser = (q) => q.user?.id || q.ip;

app.use('/api', limit('api', 300, 300), (_q, s, next) => { s.set('Cache-Control', 'no-store'); next(); });
const unsafeKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
app.use(express.json({ limit: '32kb', reviver: (k, v) => (unsafeKey(k) ? undefined : v) }));
app.use((q, _s, next) => { if (!q.body || typeof q.body !== 'object' || Array.isArray(q.body)) q.body = {}; next(); });

// photos: only our own random file names, never sniffed as anything but an image
app.use('/uploads', (q, s, next) => (/^\/[A-Za-z0-9_-]{1,80}\.(jpg|png|webp)$/.test(q.path) ? next() : s.status(404).end()));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1h', index: false, dotfiles: 'deny', fallthrough: false,
  setHeaders: (s) => { s.set('X-Content-Type-Options', 'nosniff'); s.set('Content-Security-Policy', "default-src 'none'; sandbox"); } }));
app.use('/photos', express.static(path.join(ROOT, 'seed', 'photos'), { maxAge: '1h', index: false, setHeaders: (s) => s.set('X-Content-Type-Options', 'nosniff') }));
// the old one-paragraph pages now live in public/legal/
app.get(['/privacy.html', '/terms.html'], (q, s) => s.redirect(301, '/legal' + q.path));
app.use(express.static(path.join(ROOT, 'public'), { dotfiles: 'ignore' }));

const photoUpload = (max) => multer({ storage: multer.memoryStorage(), limits: { fileSize: max, files: 1, fields: 8, fieldSize: 8 * 1024, parts: 10, headerPairs: 50 } }).single('photo');
const auth = (q, s, next) => { const u = sessionUser(q); if (!u) return s.status(401).json({ error: 'Sign in first.' }); q.user = u; next(); };

app.get('/api/meta', (_q, s) => s.json({ countries: COUNTRIES, categories: CATEGORIES, sandbox: SANDBOX, ai: !!GEMINI_KEY, paypal: !!(PP_ID && PP_SECRET), terms: { version: TERMS_VERSION }, reportReasons: REPORT_REASONS }));

// Sign in with a name and a country (not used by the app's screens; kept for tools). It always makes a
// NEW account: a name alone never proves who someone is, so it can never open somebody else's account.
app.post('/api/signin', limit('signin', 10, 2), (q, s) => {
  const name = clean(str(q.body.name, { min: 2, max: 30, name: 'name', msg: 'Your name, please.' }), 30);
  const country = typeof q.body.country === 'string' ? q.body.country : '';
  if (!COUNTRIES[country]) throw bad('Pick your country.');
  const u = { id: id('u'), name, country, at: Date.now(), via: 'name', terms: accepted() };
  users.push(u); persist();
  startSession(q, s, u);
  s.json(self(u));
});
app.post('/api/signout', (q, s) => { endSession(q, s); s.json({ ok: true }); });
app.get('/api/whoami', auth, (q, s) => s.json(self(q.user)));

app.get('/api/listings', (q, s) => {
  const country = String(q.query.country || '');
  const cat = String(q.query.category || '');
  s.json(listings.filter((l) => l.status === 'open' && l.country === country && l.photo && (!cat || l.category === cat)).sort((a, b) => b.at - a.at).map(card));
});

app.get('/api/listings/:id', (q, s) => {
  const l = findListing(q.params.id);
  if (!l || l.status === 'deleted') return s.status(404).json({ error: 'This item is gone.' });
  s.json(full(l, sessionUser(q)?.id));
});

// Sell. A photo is required; the description must say everything because buying is instant.
app.post('/api/sell', auth, limit('sell-ip', 20, 5), photoUpload(10 * 1024 * 1024), async (q, s) => {
  const u = q.user;
  if (!q.file) throw bad('Take a photo of it first.');
  const img = cleanImage(q.file.buffer);
  if (!img) throw bad('That file is not a photo (JPG, PNG or WebP).');
  const title = clean(str(q.body.title, { min: 3, max: 60, name: 'title', msg: 'Say what it is.' }), 60);
  const category = q.body.category;
  if (!CATEGORIES.includes(category)) throw bad('Pick a category.');
  const price = Math.round(num(q.body.price, { min: 1, max: MAX_PRICE, msg: 'Set a price.' }) * 100) / 100;
  const description = str(q.body.description, { min: 30, max: 1200, name: 'description', msg: 'Write everything about it: condition, flaws, what comes with it.' }).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  if (q.body.accept !== 'true') throw bad('Accept the Terms and the seller rules first.');
  gate(q, s, 'sell', 5, 1); // each post costs an AI call
  const t0 = Date.now();
  const seen = await readPhoto(img.buf, img.mime, title, description);
  if (!seen.shows_item) throw bad(`The photo doesn't show "${title}". Take a real photo of it.`);
  // the file is written only once everything is fine, with a random name (never the browser's)
  const photoName = crypto.randomBytes(16).toString('hex') + img.ext;
  fs.writeFileSync(path.join(UPLOADS, photoName), img.buf, { flag: 'wx' });
  const l = { id: id('l'), sellerId: u.id, country: u.country, photo: '/uploads/' + photoName, title, category, price, description, facts: seen.facts, status: 'open', at: Date.now(), accepted: { ...accepted(), private: true } };
  u.sellerTerms = accepted();
  listings.unshift(l);
  try { persist(); } catch (e) { listings.shift(); fs.rmSync(path.join(UPLOADS, photoName), { force: true }); throw e; }
  let sentTo = [];
  try { sentTo = await wantsFor(l); persist(); } catch (e) { console.error('matching failed:', e.message); }
  s.json({ listing: full(l, u.id), sentTo, missing: seen.missing, ms: Date.now() - t0 });
});

// Leave keeps it up, delete takes it down.
app.delete('/api/listings/:id', auth, (q, s) => {
  const l = findListing(q.params.id);
  if (!l || l.sellerId !== q.user.id || l.status === 'deleted') return s.status(404).json({ error: 'not found' });
  if (l.status === 'sold') return s.status(400).json({ error: 'Already sold.' });
  if (paying.has(l.id)) return s.status(409).json({ error: 'Someone is paying for it right now.' });
  l.status = 'deleted'; persist(); s.json({ ok: true });
});

// Buy: a small card of what you want; AI looks through everything for sale in your country.
app.post('/api/wants', auth, limit('wants-ip', 60, 20), async (q, s) => {
  const u = q.user;
  const what = clean(str(q.body.what, { min: 3, max: 80, name: 'text', msg: 'Say what you want.' }), 80);
  const category = q.body.category;
  if (!CATEGORIES.includes(category)) throw bad('Pick a category.');
  const minPrice = q.body.minPrice === undefined || q.body.minPrice === '' ? 0 : num(q.body.minPrice, { min: 0, max: MAX_PRICE, msg: 'Set your price range.' });
  const maxPrice = num(q.body.maxPrice, { min: 1, max: MAX_PRICE, msg: 'Set your price range.' });
  if (maxPrice < minPrice) throw bad('Set your price range.');
  gate(q, s, 'wants', 10, 3); // each want costs an AI call
  const t0 = Date.now();
  const w = { id: id('w'), userId: u.id, name: u.name, country: u.country, what, category, minPrice, maxPrice, status: 'open', matches: [], at: Date.now() };
  wants.unshift(w);
  try { await listingsFor(w); } catch (e) { wants.shift(); throw e; }
  persist();
  s.json({ want: w, found: w.matches.map((m) => ({ ...m, listing: card(listings.find((l) => l.id === m.listingId)) })), ms: Date.now() - t0 });
});

app.delete('/api/wants/:id', auth, (q, s) => {
  const w = typeof q.params.id === 'string' && ID_RE.test(q.params.id) && wants.find((x) => x.id === q.params.id && x.userId === q.user.id);
  if (!w) return s.status(404).json({ error: 'not found' });
  w.status = 'deleted'; persist(); s.json({ ok: true });
});

// Everything of mine: what I sell, what I look for (with what was found), deals to review.
app.get('/api/me', auth, (q, s) => {
  const u = q.user;
  const mine = listings.filter((l) => l.sellerId === u.id && l.status !== 'deleted' && l.photo).sort((a, b) => b.at - a.at).map((l) => full(l, u.id));
  const looking = wants.filter((w) => w.userId === u.id && w.status === 'open').map((w) => ({
    id: w.id, what: w.what, category: w.category, minPrice: w.minPrice, maxPrice: w.maxPrice, country: w.country, status: w.status, at: w.at,
    found: w.matches.map((m) => ({ ...m, listing: listings.find((l) => l.id === m.listingId) })).filter((m) => m.listing?.status === 'open').map((m) => ({ ...m, listing: card(m.listing) })),
  }));
  const bought = listings.filter((l) => l.buyerId === u.id && l.photo).sort((a, b) => b.soldAt - a.soldAt).map((l) => full(l, u.id));
  // (each bought item carries .track: status, steps, events, eta)
  s.json({ user: { ...self(u), ...stats(u.id) }, mine, looking, bought });
});

// Pay. The price always comes from the item on the server; the buyer must say they read the description.
app.post('/api/listings/:id/pay', auth, limit('pay', 10, 3, byUser), async (q, s) => {
  const u = q.user;
  const l = findListing(q.params.id);
  if (!l || l.status !== 'open' || paying.has(l.id)) return s.status(409).json({ error: 'Someone was faster. This is sold.' });
  if (l.sellerId === u.id) throw bad("That's your own item.");
  if (l.country !== u.country) throw bad(`Only buyers in ${COUNTRIES[l.country]?.name || 'its country'} can buy this.`);
  if (q.body.readDescription !== true) throw bad('Read the description first.');
  const method = q.body.method ?? 'paypal';
  if (method !== 'paypal' && method !== 'card') throw bad('Pick how to pay.');
  if (method === 'card') {
    if (!SANDBOX) throw bad('Test card only works in sandbox.');
    paying.add(l.id);
    try {
      let cap;
      try { cap = await sandboxCardPay(l, u); }
      catch (e) { if (e instanceof UserError) throw e; console.error('card pay:', e.message); throw new UserError(502, 'PayPal could not take the payment. You were not charged.'); }
      const why = checkCapture(l, cap);
      if (why) { await refund(cap, why); throw new UserError(502, 'PayPal did not confirm the payment. Any money taken is sent back.'); }
      if (l.status !== 'open') { await refund(cap, 'sold meanwhile'); return s.status(409).json({ error: 'Someone was faster. Your money is sent back.' }); }
      markSold(l, u, cap, 'card');
    } finally { paying.delete(l.id); }
    return s.json({ paid: true, listing: full(l, u.id) });
  }
  let out;
  try { out = await paypalCheckout(l, u, origin(q)); }
  catch (e) { console.error('paypal checkout:', e.message); throw new UserError(502, 'PayPal is not answering. Try again in a moment.'); }
  s.json({ payUrl: out.payUrl });
});

// PayPal sends the buyer back here with the order number. Which item and which buyer it was for comes
// from our own record of that order, never from the link. First to pay gets it.
const backTo = (s, p, err) => s.redirect(p + (err ? (p.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err) : ''));
app.get('/paypal/return', limit('pp-return', 20, 10), async (q, s) => {
  const token = typeof q.query.token === 'string' && /^[A-Za-z0-9-]{5,40}$/.test(q.query.token) ? q.query.token : '';
  const o = token ? orderGet.get(token) : null;
  if (!o || Date.now() - o.at > ORDER_TTL) return backTo(s, '/', 'This payment link is not valid any more.');
  const l = listings.find((x) => x.id === o.listing_id), u = userOf(o.buyer_id);
  if (!l || !u) return backTo(s, '/', 'This payment link is not valid any more.');
  const item = `/?item=${encodeURIComponent(l.id)}`;
  if (l.status === 'sold') return s.redirect(l.buyerId === u.id ? `/?paid=${encodeURIComponent(l.id)}` : item + '&late=1');
  if (l.status !== 'open' || paying.has(l.id)) return s.redirect(item + '&late=1');
  paying.add(l.id);
  try {
    const cap = await captureOrder(token);
    const why = checkCapture(l, cap);
    if (why) { await refund(cap, why); return backTo(s, item, 'PayPal did not confirm the payment. Any money taken is sent back.'); }
    if (l.status !== 'open') { await refund(cap, 'sold meanwhile'); return s.redirect(item + '&late=1'); }
    markSold(l, u, cap, 'paypal');
    s.redirect(`/?paid=${encodeURIComponent(l.id)}`);
  } catch (e) {
    console.error('paypal return:', e.message);
    backTo(s, item, 'PayPal could not finish the payment. You were not charged.');
  } finally { paying.delete(l.id); }
});
setInterval(() => { try { db.prepare('DELETE FROM orders WHERE at < ?').run(Date.now() - 86400e3); } catch {} }, 3600e3).unref();

// ---------- Sign up with PayPal: name, country and address come from PayPal ----------
const states = new Map();
const STATE_TTL = 10 * 60e3;
app.get('/auth/paypal', limit('pp-auth', 20, 10), (q, s) => {
  const now = Date.now();
  for (const [k, v] of states) if (now - v.at > STATE_TTL || states.size > 5000) states.delete(k);
  const st = crypto.randomBytes(12).toString('hex');
  // PayPal only accepts public https return links, so it returns to a tiny page on GitHub Pages
  // (docs/return.html) that forwards the code back to this server. The state says where "back" is.
  const here = origin(q);
  states.set(st, { back: here, at: now });
  const bounce = process.env.AUTH_BOUNCE || 'https://useralx01.github.io/homing/return.html';
  const state = st + '.' + Buffer.from(here).toString('base64url');
  s.redirect(PP_WEB + '/signin/authorize?' + new URLSearchParams({ flowEntry: 'static', client_id: PP_ID, response_type: 'code', scope: 'openid profile email address', redirect_uri: bounce, state }));
});
app.get('/auth/paypal/return', limit('pp-auth', 20, 10), async (q, s) => {
  const key = String(q.query.state || '').split('.')[0];
  const st = /^[0-9a-f]{24}$/.test(key) ? states.get(key) : null; if (st) states.delete(key);
  if (q.query.error || typeof q.query.code !== 'string' || !q.query.code) return backTo(s, '/', 'PayPal sign-in was cancelled.');
  if (!st || Date.now() - st.at > STATE_TTL) return backTo(s, '/', 'Sign-in expired, try again.');
  try {
    const t = await fetch(PP_API + '/v1/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { authorization: 'Basic ' + Buffer.from(PP_ID + ':' + PP_SECRET).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.query.code.slice(0, 2000) }) });
    const tj = await t.json().catch(() => ({}));
    if (!t.ok || !tj.access_token) throw new Error('token: ' + (tj.error_description || t.status));
    const ui = await (await fetch(PP_API + '/v1/identity/openidconnect/userinfo?schema=openid', { signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + tj.access_token } })).json();
    if (!ui?.user_id || typeof ui.user_id !== 'string') throw new Error('userinfo: no user id');
    const a = ui.address && typeof ui.address === 'object' ? ui.address : {};
    const country = clean(a.country, 2).toUpperCase();
    if (!COUNTRIES[country]) throw new UserError(400, `Homing isn't open in your country (${/^[A-Z]{2}$/.test(country) ? country : 'unknown'}) yet.`);
    const fullName = clean(ui.name || [ui.given_name, ui.family_name].filter(Boolean).join(' '), 60) || 'PayPal user';
    const lines = String(a.street_address || '').split(/\n|, /).map((x) => clean(x, 100));
    const address = { line1: lines[0] || '', line2: lines.slice(1).join(', ').slice(0, 100), city: clean(a.locality, 80), zip: clean(a.postal_code, 20), country };
    let u = users.find((x) => x.paypalId === ui.user_id);
    if (!u) { u = { id: id('u'), at: Date.now() }; users.push(u); }
    Object.assign(u, { paypalId: ui.user_id, name: clean(ui.given_name, 30) || fullName.split(' ')[0], fullName, country, address, email: clean(ui.email, 120), via: 'paypal', terms: accepted() });
    persist();
    startSession(q, s, u);
    s.redirect('/#signed'); // no id in the link: the cookie is the sign-in
  } catch (e) {
    console.error('paypal sign-in:', e.message);
    backTo(s, '/', e instanceof UserError ? e.message : 'PayPal sign-in did not work. Try again.');
  }
});
// Demo for judges without a PayPal sandbox login: a made-up person with a made-up Berlin address.
const DEMO = [['Alex', 'Torstraße 45', '10119'], ['Sam', 'Oranienstraße 25', '10999'], ['Jo', 'Kastanienallee 12', '10435'], ['Robin', 'Bergmannstraße 8', '10961'], ['Kim', 'Schönhauser Allee 70', '10437']];
app.post('/api/signin/demo', limit('demo', 10, 2), (q, s) => {
  const [name, line1, zip] = DEMO[crypto.randomInt(DEMO.length)];
  const u = { id: id('u'), name, fullName: name + ' Demo', country: 'DE', address: { line1, line2: '', city: 'Berlin', zip, country: 'DE' }, at: Date.now(), via: 'demo', terms: accepted() };
  users.push(u); persist();
  startSession(q, s, u);
  s.json(self(u));
});

// ---------- after a sale: everything the seller needs to send it ----------
app.get('/api/listings/:id/ship', auth, async (q, s) => {
  const u = q.user;
  const l = findListing(q.params.id);
  if (!l || l.status !== 'sold' || l.sellerId !== u.id) return s.status(404).json({ error: 'Not your sale.' });
  const sh = l.ship || (l.ship = {});
  if (!sh.labelKey) { sh.labelKey = crypto.randomBytes(12).toString('hex'); persist(); }
  // the QR opens the full shipping label, ready to print and stick on the parcel
  const labelUrl = `${origin(q)}/label/${sh.labelKey}`;
  const qr = await QRCode.toString(labelUrl, { type: 'svg', margin: 0, color: { dark: '#0a0a0c', light: '#0000' }, errorCorrectionLevel: 'M' });
  const { labelKey, ...shipOut } = sh;
  s.json({ item: card(l), buyer: person(l.buyerId), ship: shipOut, qr, labelUrl, tracking: l.tracking || null, track: trackOf(l), paidAt: l.soldAt, from: u.address || null });
});
const CARRIERS = { DHL: 'DHL', DEUTSCHE_DE: 'Deutsche Post', HERMES: 'Hermes', DPD: 'DPD', GLS: 'GLS', UPS: 'UPS' };
app.post('/api/listings/:id/track', auth, limit('track', 10, 3, byUser), async (q, s) => {
  const l = findListing(q.params.id);
  if (!l || l.status !== 'sold' || l.sellerId !== q.user.id) return s.status(404).json({ error: 'Not your sale.' });
  const carrier = typeof q.body.carrier === 'string' ? q.body.carrier : '';
  if (!Object.hasOwn(CARRIERS, carrier)) throw bad('Pick who carries it.');
  const number = str(q.body.number, { max: 60, name: 'tracking number' }).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9-]{6,40}$/.test(number)) throw bad('Type the tracking number.');
  // tell PayPal, so the buyer sees it in their PayPal activity too
  let inPayPal = false;
  if (l.capture?.orderId && l.capture?.id) {
    try { await pp('POST', `/v2/checkout/orders/${encodeURIComponent(l.capture.orderId)}/track`, { capture_id: l.capture.id, tracking_number: number, carrier, notify_payer: true }); inPayPal = true; }
    catch (e) { console.error('track', e.message); }
  }
  l.tracking = { carrier, carrierName: CARRIERS[carrier], number, inPayPal, at: Date.now() };
  persist(); s.json(l.tracking);
});
app.get('/api/post-offices', auth, limit('posts', 10, 4, byUser), async (q, s) => {
  const u = q.user;
  let p = null;
  if (q.query.lat !== undefined || q.query.lon !== undefined) {
    p = { lat: num(String(q.query.lat ?? ''), { min: -90, max: 90, msg: 'Bad position.' }), lon: num(String(q.query.lon ?? ''), { min: -180, max: 180, msg: 'Bad position.' }) };
  }
  if (!p && u.address) p = await geocode(u.address).catch(() => null);
  if (!p) return s.json({ near: [], why: 'No address to search from.' });
  s.json({ near: await postOffices(p), from: q.query.lat !== undefined ? 'you' : 'address' });
});

// Reviews: only the buyer and the seller of a finished deal, once each.
app.post('/api/listings/:id/review', auth, limit('review', 10, 3, byUser), (q, s) => {
  const u = q.user;
  const l = findListing(q.params.id);
  if (!l || l.status !== 'sold') throw bad('You can only review a finished deal.');
  const side = l.buyerId === u.id ? 'buyer' : l.sellerId === u.id ? 'seller' : null;
  if (!side) return s.status(403).json({ error: 'Only the buyer and the seller can review this deal.' });
  if (l.reviews?.[side]) throw bad('You already reviewed this deal.');
  const stars = num(q.body.stars, { min: 1, max: 5, msg: 'Pick 1 to 5 stars.' });
  if (!Number.isInteger(stars)) throw bad('Pick 1 to 5 stars.');
  const text = str(q.body.text, { max: 600, name: 'review' }).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  l.reviews = { ...(l.reviews || {}), [side]: { stars, text, at: Date.now() } };
  persist();
  s.json(full(l, u.id));
});
// The person a review is about can answer it once, in words.
app.post('/api/listings/:id/review/reply', auth, limit('reply', 10, 3, byUser), (q, s) => {
  const u = q.user;
  const l = findListing(q.params.id);
  if (!l || l.status !== 'sold') throw bad('Not a finished deal.');
  // the buyer's review is about the seller; the seller's review is about the buyer
  const side = l.sellerId === u.id ? 'buyer' : l.buyerId === u.id ? 'seller' : null;
  if (!side) return s.status(403).json({ error: 'Only the buyer and the seller can answer here.' });
  const r = l.reviews?.[side];
  if (!r) throw bad('There is no review to answer.');
  if (r.reply) throw bad('You already answered.');
  const text = str(q.body.text, { min: 2, max: 600, name: 'answer', msg: 'Write your answer.' }).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  r.reply = { text, at: Date.now() };
  persist();
  s.json(full(l, u.id));
});

// Live numbers for the home screen.
app.get('/api/pulse', (q, s) => {
  const c = String(q.query.country || '');
  s.json({ forSale: listings.filter((l) => l.status === 'open' && l.country === c && l.photo).length, looking: wants.filter((w) => w.status === 'open' && w.country === c).length });
});

// A person's page: their numbers, what they sell, and every review from a real deal. Never an address.
app.get('/api/users/:id', (q, s) => {
  const u = typeof q.params.id === 'string' && ID_RE.test(q.params.id) ? userOf(q.params.id) : null;
  if (!u || u.deleted) return s.status(404).json({ error: 'not found' });
  const rv =(r) => ({ stars: r.stars, text: r.text || '', at: r.at, reply: r.reply ? { text: r.reply.text, at: r.reply.at } : null });
  const reviews = [];
  for (const l of listings) {
    if (l.status !== 'sold') continue;
    if (l.sellerId === u.id && l.reviews?.buyer) reviews.push({ ...rv(l.reviews.buyer), listingId: l.id, from: person(l.buyerId)?.name, fromId: l.buyerId, fromAvatar: userOf(l.buyerId)?.avatar || null, role: 'bought', item: l.title, price: l.price, currency: currencyOf(l.country) });
    if (l.buyerId === u.id && l.reviews?.seller) reviews.push({ ...rv(l.reviews.seller), listingId: l.id, from: person(l.sellerId)?.name, fromId: l.sellerId, fromAvatar: userOf(l.sellerId)?.avatar || null, role: 'sold', item: l.title, price: l.price, currency: currencyOf(l.country) });
  }
  reviews.sort((a, b) => b.at - a.at);
  const forSale = listings.filter((l) => l.sellerId === u.id && l.status === 'open' && l.photo).sort((a, b) => b.at - a.at).map(card);
  s.json({ id: u.id, name: u.name, avatar: u.avatar || null, country: u.country, since: u.at, ...stats(u.id), forSale, feed: reviews });
});

// Leaderboard per country: counts and stars come only from finished deals.
app.get('/api/leaderboard', (q, s) => {
  const country = String(q.query.country || '');
  const by = q.query.by === 'buyers' ? 'bought' : 'sold';
  s.json(users.filter((u) => u.country === country).map((u) => ({ id: u.id, name: u.name, avatar: u.avatar || null, ...stats(u.id) }))
    .filter((u) => u[by] > 0).sort((a, b) => b[by] - a[by] || (b.stars || 0) - (a.stars || 0)).slice(0, 20));
});

// Profile picture: one photo, shown on your page, your items, reviews and the leaderboard.
app.post('/api/me/avatar', auth, limit('avatar', 6, 2, byUser), photoUpload(5 * 1024 * 1024), (q, s) => {
  const u = q.user;
  if (!q.file) throw bad('Pick a photo (JPG, PNG or WebP).');
  // trust the bytes, not the label the browser sent; location and camera data are removed
  const img = cleanImage(q.file.buffer);
  if (!img) throw bad('That file is not a photo.');
  const name = 'avatar_' + crypto.randomBytes(16).toString('hex') + img.ext;
  fs.writeFileSync(path.join(UPLOADS, name), img.buf, { flag: 'wx' });
  const old = u.avatar;
  u.avatar = '/uploads/' + name;
  try { persist(); } catch (e) { u.avatar = old; fs.rmSync(path.join(UPLOADS, name), { force: true }); throw e; }
  if (old?.startsWith('/uploads/avatar_')) fs.rmSync(path.join(UPLOADS, path.basename(old)), { force: true });
  s.json(self(u));
});
app.delete('/api/me/avatar', auth, (q, s) => {
  const u = q.user;
  const old = u.avatar;
  delete u.avatar; persist();
  if (old?.startsWith('/uploads/avatar_')) fs.rmSync(path.join(UPLOADS, path.basename(old)), { force: true });
  s.json(self(u));
});

// ---------- reports (DSA art. 16): an item or a person, a reason from the list, optional words ----------
const repIns = db.prepare('INSERT INTO reports (id, at, by_user, kind, target, reason, text, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const repMine = db.prepare('SELECT id, at, kind, target, reason, text, status FROM reports WHERE by_user = ? ORDER BY at');
const report = (q, s) => {
  const u = q.user;
  const kind = q.body.kind, target = q.body.id, reason = q.body.reason;
  if (kind !== 'listing' && kind !== 'user') throw bad('Pick what you report.');
  if (typeof reason !== 'string' || !Object.hasOwn(REPORT_REASONS, reason)) throw bad('Pick a reason.');
  const text = str(q.body.text, { max: 500, name: 'text' }).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  const ok = typeof target === 'string' && ID_RE.test(target) && (kind === 'listing'
    ? (() => { const l = findListing(target); return l && l.status !== 'deleted' && l.sellerId !== u.id; })()
    : (() => { const t = userOf(target); return t && !t.deleted && t.id !== u.id; })());
  if (!ok) return s.status(404).json({ error: 'Nothing to report there.' });
  gate(q, s, 'report', 5, 2); // counted once the report is valid
  const rid = id('r');
  repIns.run(rid, Date.now(), u.id, kind, target, reason, text, 'open');
  console.log(`report ${rid}: ${kind} ${target} (${reason})`); // the operator checks these
  s.json({ ok: true, id: rid });
};
app.post(['/api/report', '/api/reports'], auth, limit('report-ip', 30, 10), report);

// ---------- my data (GDPR art. 15/20): everything about me, and only me, as a file ----------
app.get('/api/me/export', auth, (q, s) => {
  const u = q.user;
  const shipOut = (sh) => { if (!sh) return null; const { labelKey, ...rest } = sh; return rest; };
  const amount = (l) => (l.capture?.amount ? { value: l.capture.amount.value, currency: l.capture.amount.currency_code } : { value: l.price, currency: currencyOf(l.country) });
  const item = (l) => ({ id: l.id, title: l.title, category: l.category, price: l.price, currency: currencyOf(l.country), description: l.description, photo: l.photo, status: l.status, postedAt: l.at, soldAt: l.soldAt || null, acceptedTerms: l.accepted || null });
  const out = {
    exportedAt: new Date().toISOString(), termsVersion: TERMS_VERSION,
    user: { id: u.id, name: u.name, fullName: u.fullName || u.name, country: u.country, address: u.address || null, email: u.email || null, avatar: u.avatar || null, signedUpWith: u.via || 'name', since: u.at, acceptedTerms: u.terms || null, acceptedSellerRules: u.sellerTerms || null },
    selling: listings.filter((l) => l.sellerId === u.id).map((l) => ({ ...item(l), ...(l.status === 'sold' ? { buyer: person(l.buyerId)?.name, paid: amount(l), shipTo: shipOut(l.ship), tracking: l.tracking || null } : {}) })),
    bought: listings.filter((l) => l.buyerId === u.id).map((l) => ({ id: l.id, title: l.title, seller: person(l.sellerId)?.name, paid: amount(l), boughtAt: l.soldAt, acceptedTerms: l.buyerAccepted || null, shipTo: shipOut(l.ship), tracking: l.tracking || null })),
    wants: wants.filter((w) => w.userId === u.id).map((w) => ({ id: w.id, what: w.what, category: w.category, minPrice: w.minPrice, maxPrice: w.maxPrice, status: w.status, at: w.at })),
    reviewsWritten: [], reviewsReceived: [],
    reports: repMine.all(u.id),
  };
  for (const l of listings) {
    if (l.status !== 'sold') continue;
    const r = (x) => ({ item: l.title, stars: x.stars, text: x.text || '', at: x.at, reply: x.reply || null });
    if (l.buyerId === u.id && l.reviews?.buyer) out.reviewsWritten.push(r(l.reviews.buyer));
    if (l.sellerId === u.id && l.reviews?.seller) out.reviewsWritten.push(r(l.reviews.seller));
    if (l.sellerId === u.id && l.reviews?.buyer) out.reviewsReceived.push(r(l.reviews.buyer));
    if (l.buyerId === u.id && l.reviews?.seller) out.reviewsReceived.push(r(l.reviews.seller));
  }
  s.set('Content-Disposition', 'attachment; filename="homing-data.json"');
  s.type('application/json').send(JSON.stringify(out, null, 2));
});

// ---------- delete my account (GDPR art. 17) ----------
// Finished deals stay (needed for 3 years), with the name shown as "Former member".
const sessKill = db.prepare('DELETE FROM sessions WHERE user_id = ?');
app.delete('/api/me', auth, limit('delete-me', 5, 2, byUser), (q, s) => {
  const u = q.user;
  const recent = Date.now() - 30 * 86400e3;
  const open = listings.some((l) => l.status === 'sold' && (l.sellerId === u.id || l.buyerId === u.id) && l.soldAt > recent && !trackOf(l)?.delivered);
  if (open) throw bad('Finish your open deals first. When the parcel is delivered you can delete your account.');
  if (listings.some((l) => l.sellerId === u.id && paying.has(l.id))) return s.status(409).json({ error: 'Someone is paying for one of your items right now. Try again in a minute.' });
  const files = [];
  if (u.avatar?.startsWith('/uploads/')) files.push(u.avatar);
  // open and deleted listings go, with their photos; sold ones stay
  listings = listings.filter((l) => { if (l.sellerId !== u.id || l.status === 'sold') return true; if (l.photo?.startsWith('/uploads/')) files.push(l.photo); return false; });
  wants = wants.filter((w) => w.userId !== u.id);
  // reviews this person wrote, and their answers to reviews about them
  for (const l of listings) {
    if (l.status !== 'sold' || !l.reviews) continue;
    if (l.buyerId === u.id) { delete l.reviews.buyer; if (l.reviews.seller) delete l.reviews.seller.reply; }
    if (l.sellerId === u.id) { delete l.reviews.seller; if (l.reviews.buyer) delete l.reviews.buyer.reply; }
  }
  const i = users.indexOf(u);
  users[i] = { id: u.id, deleted: true, at: Date.now() };
  persist();
  sessKill.run(u.id);
  endSession(q, s);
  for (const f of files) fs.rmSync(path.join(UPLOADS, path.basename(f)), { force: true });
  s.json({ ok: true });
});

// The shipping label the QR opens: both addresses, the order code and the item on one
// 100 x 150 mm sheet (the usual parcel label size), ready to print and stick on.
// The link itself is the key (96 random bits), so: compared in constant time, never cached, never sent on as a referrer.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labelByKey = (key) => {
  const want = Buffer.from(sha(key), 'hex'); let hit = null;
  for (const x of listings) {
    if (x.status !== 'sold' || typeof x.ship?.labelKey !== 'string') continue;
    if (crypto.timingSafeEqual(want, Buffer.from(sha(x.ship.labelKey), 'hex')) && !hit) hit = x;
  }
  return hit;
};
app.get('/label/:key', limit('label', 30, 20), async (q, s) => {
  s.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  const key = String(q.params.key);
  const l = /^[0-9a-f]{24}$/.test(key) ? labelByKey(key) : null;
  if (!l) return s.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">This label does not exist.</p>');
  const sm = ensureShipment(l);
  if (sm && !sm.labelAt) { sm.labelAt = Date.now(); persist(); }
  const sh = l.ship; const seller = userOf(l.sellerId) || {}; const fa = seller.address || {};
  const addr = (name, a) => [name, a.line1, a.line2, [a.zip, a.city].filter(Boolean).join(' '), COUNTRIES[a.country]?.name]
    .filter((x) => x && String(x).trim()).map(esc).join('<br>');
  const qr = await QRCode.toString(`${origin(q)}/label/${key}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  const tr = l.tracking; const sbx = sm?.mode === 'sandbox';
  const nonce = crypto.randomBytes(16).toString('base64');
  s.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  s.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Label ${esc(sh.code)}</title><style>
@page{size:100mm 150mm;margin:0}
*{box-sizing:border-box}html,body{margin:0;background:#eef1f6;font-family:"Inter Tight",Inter,system-ui,sans-serif;color:#0a0a0c}
.bar{display:flex;gap:10px;justify-content:center;align-items:center;padding:16px;font-size:14px;color:#555}
.bar button{font:600 15px "Inter Tight",Inter,system-ui,sans-serif;border:0;border-radius:999px;padding:12px 24px;background:#0b57d0;color:#fff;cursor:pointer;transition:transform .12s}
.bar button:active{transform:scale(.95)}
.label{width:100mm;height:150mm;margin:0 auto 24px;background:#fff;padding:6mm;display:flex;flex-direction:column;gap:3.5mm;box-shadow:0 2px 16px rgba(10,20,50,.12)}
.top{display:flex;justify-content:space-between;align-items:center;border-bottom:.6mm solid #0a0a0c;padding-bottom:2.5mm}
.brand{font-weight:800;font-size:5.4mm;letter-spacing:-.03em;color:#0b57d0}
.code{font:700 4.6mm ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em}
.k{font-size:2.5mm;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#555;margin-bottom:1mm}
.from{font-size:3.1mm;line-height:1.35}
.to{border:.6mm solid #0a0a0c;padding:3mm 3.5mm;font-size:5mm;line-height:1.3;font-weight:600}
.trk{font-size:3.3mm;line-height:1.4}.trk .num{font:700 4.2mm ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em}
.stamp{border:.4mm dashed #888;height:15mm;display:flex;align-items:center;justify-content:center;font-size:2.7mm;color:#666;text-align:center;padding:0 3mm}
.row{display:flex;gap:4mm;align-items:flex-end;margin-top:auto}
.row svg{width:28mm;height:28mm;flex:0 0 28mm}
.meta{font-size:2.9mm;line-height:1.45;flex:1}
@media print{html,body{background:#fff}.bar{display:none}.label{margin:0;box-shadow:none}}
</style></head><body>
<div class="bar"><button id="print" type="button">Print label</button></div>
<div class="label">
  <div class="top"><span class="brand">Homing</span><span class="code">${esc(sh.code)}</span></div>
  <div><div class="k">From</div><div class="from">${addr(seller.fullName || seller.name, fa)}</div></div>
  <div class="to"><div class="k">To</div>${addr(sh.name, sh)}</div>
  ${tr ? `<div class="trk"><div class="k">${sbx ? 'Parcel number (sandbox test, not real postage)' : 'Parcel number'}</div><b>DHL</b> <span class="num">${esc(tr.number)}</span></div>` : ''}
  <div class="row">${qr}<div class="meta"><b>${esc(l.title)}</b><br>Paid with PayPal · ${esc(new Date(l.soldAt).toLocaleDateString('en-GB'))}<br>Order ${esc(sh.code)}</div></div>
</div><script nonce="${nonce}">document.getElementById('print').onclick=function(){print()}</script></body></html>`);
});

// Wipes everything back to the seed. Locked: only with ADMIN_SECRET (16+ characters) set on the server,
// sent as the x-admin-secret header, and only from this computer. Otherwise it does not exist.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
app.post('/api/reset', (q, s) => {
  const ip = q.socket.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const given = String(q.get('x-admin-secret') || '');
  const ok = ADMIN_SECRET.length >= 16 && local && crypto.timingSafeEqual(Buffer.from(sha(given), 'hex'), Buffer.from(sha(ADMIN_SECRET), 'hex'));
  if (!ok) return s.status(404).json({ error: 'Not found.' });
  users = seed('users.json'); listings = seed('listings.json'); wants = seed('wants.json');
  persist();
  db.exec('DELETE FROM sessions; DELETE FROM orders;');
  s.json({ ok: true });
});

app.use('/api', (_q, s) => s.status(404).json({ error: 'Not found.' }));
// Errors: people get a plain sentence; the details stay in the server log.
app.use((e, _q, s, _next) => {
  if (s.headersSent) return;
  if (e instanceof UserError) return s.status(e.status).json({ error: e.message });
  if (e instanceof multer.MulterError) return s.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big.' : 'Send one photo.' });
  if (e?.type === 'entity.too.large') return s.status(413).json({ error: 'That is too much.' });
  if (e?.type === 'entity.parse.failed' || e?.type === 'encoding.unsupported' || e?.type === 'charset.unsupported' || e?.status === 400) return s.status(400).json({ error: 'Bad request.' });
  if (e?.status === 404 || e?.statusCode === 404) return s.status(404).end();
  console.error(e);
  s.status(500).json({ error: 'Something went wrong.' });
});
process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message || e));

app.listen(PORT, () => console.log(`Homing on ${BASE_URL}  ai=${!!GEMINI_KEY} paypal=${!!(PP_ID && PP_SECRET)} ${SANDBOX ? 'sandbox' : 'LIVE'}`));
