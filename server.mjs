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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

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
const origin = (q) => process.env.BASE_URL ? BASE_URL : `${q.protocol}://${q.get('host')}`;

// Everything is locked to one country: no shipping across borders.
const COUNTRIES = {
  DE: { name: 'Germany', currency: 'EUR' }, AT: { name: 'Austria', currency: 'EUR' }, CH: { name: 'Switzerland', currency: 'CHF' },
  FR: { name: 'France', currency: 'EUR' }, NL: { name: 'Netherlands', currency: 'EUR' }, ES: { name: 'Spain', currency: 'EUR' },
  IT: { name: 'Italy', currency: 'EUR' }, GB: { name: 'United Kingdom', currency: 'GBP' }, US: { name: 'United States', currency: 'USD' },
};
const CATEGORIES = ['Furniture', 'Home & kitchen', 'Electronics', 'Music', 'Bikes & sport', 'Fashion', 'Plants', 'Other'];

// ---------- tiny JSON store ----------
const file = (n) => path.join(DATA, n);
const seed = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', n), 'utf8'));
const load = (n) => { try { const v = JSON.parse(fs.readFileSync(file(n), 'utf8')); if (Array.isArray(v) && (n !== 'listings.json' || v[0]?.sellerId)) return v; } catch {} return seed(n); };
let users = load('users.json');
let listings = load('listings.json');
let wants = load('wants.json');
const persist = () => { for (const [n, v] of [['users.json', users], ['listings.json', listings], ['wants.json', wants]]) fs.writeFileSync(file(n), JSON.stringify(v, null, 2)); };
persist();
const id = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const userOf = (uid) => users.find((u) => u.id === uid);
const currencyOf = (c) => COUNTRIES[c]?.currency || 'EUR';

// ---------- Gemini ----------
async function gemini(parts, prompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is missing in .env');
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
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(12000) });
    } catch (e) { last = `${m}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { last = `${m}: ${j.error?.message || r.status}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text.replace(/^```json\s*|```$/g, '')); } catch { last = `${m}: bad JSON`; }
  }
  throw new Error('AI is busy, try again: ' + last);
}

// AI looks at the photo: is it really what the seller wrote, and what can be seen.
async function readPhoto(imagePath, mime, title, description) {
  const data = fs.readFileSync(imagePath).toString('base64');
  return gemini(
    [{ inline_data: { mime_type: mime, data } }],
    `A private person sells something. They wrote:
Title: "${title}"
Description: "${description}"
Look at the photo. Return JSON only:
{"shows_item": true if the photo shows a real photo of the item in the title, false if it shows something else, a screen, a drawing or nothing,
 "facts": [2-4 short things you can SEE in the photo, max 5 words each, never brand names],
 "missing": [things a buyer would want to know that the description does not say, max 2, max 6 words each; empty if complete]}`,
  );
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
    const raw = Array.isArray(res) ? res : res.results || [];
    const hits = raw.map((r) => ({ id: String(r.id || '').trim(), score: Number(r.score) || 0, why: r.why || '' }))
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
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal auth: ' + (j.error_description || r.status));
  ppToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return ppToken.value;
}
async function pp(method, p, body) {
  const r = await fetch(PP_API + p, {
    method,
    headers: { authorization: 'Bearer ' + (await paypalToken()), 'content-type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal: ' + (j.details?.[0]?.description || j.message || r.status));
  return j;
}
function purchaseUnit(l, buyer) {
  const unit = {
    reference_id: l.id,
    custom_id: `${l.id}:${buyer.id}`,
    description: `${l.title} (Homing)`.slice(0, 127),
    amount: { currency_code: currencyOf(l.country), value: Number(l.price).toFixed(2) },
  };
  const seller = userOf(l.sellerId);
  if (seller?.paypal) unit.payee = { email_address: seller.paypal };
  if (buyer.address) unit.shipping = { name: { full_name: buyer.fullName || buyer.name }, address: ppAddress(buyer.address) };
  return unit;
}
const ppAddress = (a) => ({ address_line_1: a.line1, ...(a.line2 ? { address_line_2: a.line2 } : {}), admin_area_2: a.city, postal_code: a.zip, country_code: a.country });
async function paypalCheckout(l, buyer, base) {
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(l, buyer)],
    payment_source: { paypal: { experience_context: {
      brand_name: 'Homing', user_action: 'PAY_NOW', shipping_preference: buyer.address ? 'SET_PROVIDED_ADDRESS' : 'GET_FROM_FILE',
      return_url: `${base}/paypal/return?listing=${l.id}&buyer=${buyer.id}`,
      cancel_url: `${base}/?item=${l.id}`,
    } } },
  });
  return { orderId: order.id, payUrl: order.links.find((l2) => l2.rel === 'payer-action')?.href };
}
// Sandbox only: PayPal's own test card, so anyone can try a full payment without a sandbox login.
async function sandboxCardPay(l, buyer) {
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(l, buyer)],
    payment_source: { card: { number: '4111111111111111', expiry: '2030-12', name: buyer.name, security_code: '123' } },
  });
  if (order.status !== 'COMPLETED') return captureOrder(order.id);
  return order;
}
async function captureOrder(orderId) {
  try { return await pp('POST', `/v2/checkout/orders/${orderId}/capture`); }
  catch (e) {
    // A refresh can arrive after PayPal already captured it: read the order instead of failing.
    const o = await pp('GET', `/v2/checkout/orders/${orderId}`);
    if (o.status !== 'COMPLETED') throw e;
    return o;
  }
}
function markSold(l, buyer, cap, via) {
  const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
  l.status = 'sold'; l.buyerId = buyer.id; l.soldAt = Date.now();
  l.capture = { id: c?.id || cap.id, orderId: cap.id, status: c?.status || cap.status, amount: c?.amount, via };
  l.reviews = {};
  // where it goes: the address PayPal confirmed for this payment, else the buyer's PayPal profile
  const sh = cap.purchase_units?.[0]?.shipping;
  const a = sh?.address;
  l.ship = {
    name: sh?.name?.full_name || buyer.fullName || buyer.name,
    ...(a ? { line1: a.address_line_1 || '', line2: a.address_line_2 || '', city: a.admin_area_2 || '', zip: a.postal_code || '', country: a.country_code || l.country } : buyer.address || {}),
    code: 'HM-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
  };
  shipNotes(l).then((n) => { l.ship.notes = n; persist(); }).catch(() => {});
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
  if (!r.ok) throw new Error('The map service is busy, try again in a moment.');
  const seen = new Set();
  const out = (await r.json()).map((e) => {
    const a = e.address || {}, at = { lat: +e.lat, lon: +e.lon };
    return { name: e.name || 'Post office', street: [a.road, a.house_number].filter(Boolean).join(' '), city: a.city || a.town || a.suburb || '', hours: e.extratags?.opening_hours || '', km: Math.round(km(p, at) * 10) / 10, lat: at.lat, lon: at.lon };
  }).filter((o) => !seen.has(o.name + o.street) && seen.add(o.name + o.street)).sort((a, b) => a.km - b.km).slice(0, 3);
  postCache.set(k, out); return out;
}

// ---------- shapes sent to the page ----------
function stats(uid) {
  const sold = listings.filter((l) => l.status === 'sold' && l.sellerId === uid);
  const bought = listings.filter((l) => l.status === 'sold' && l.buyerId === uid);
  const got = [...sold.map((l) => l.reviews?.buyer), ...bought.map((l) => l.reviews?.seller)].filter(Boolean);
  const avg = got.length ? got.reduce((a, r) => a + r.stars, 0) / got.length : null;
  return { sold: sold.length, bought: bought.length, reviews: got.length, stars: avg && Math.round(avg * 10) / 10 };
}
const person = (uid) => { const u = userOf(uid); return u ? { id: u.id, name: u.name, ...stats(u.id) } : null; };
const card = (l) => ({ id: l.id, title: l.title, price: l.price, currency: currencyOf(l.country), photo: l.photo, category: l.category, status: l.status, at: l.at });
const full = (l, viewer) => ({
  ...card(l), description: l.description, facts: l.facts || [], country: l.country, seller: person(l.sellerId),
  buyer: l.buyerId ? person(l.buyerId) : null, mine: viewer === l.sellerId, boughtByMe: !!viewer && viewer === l.buyerId,
  reviews: l.status === 'sold' ? { buyer: l.reviews?.buyer || null, seller: l.reviews?.seller || null } : null,
  soldAt: l.soldAt || null, tracking: (viewer === l.sellerId || viewer === l.buyerId) ? l.tracking || null : null,
});

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1h' }));
app.use('/photos', express.static(path.join(ROOT, 'seed', 'photos'), { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public')));
const upload = multer({ dest: UPLOADS, limits: { fileSize: 10 * 1024 * 1024 } });
const wrap = (fn) => async (q, s) => { try { await fn(q, s); } catch (e) { console.error(e); s.status(500).json({ error: e.message }); } };
const need = (q, s) => { const u = userOf(String(q.body?.userId || q.query.userId || q.get('x-user') || '')); if (!u) { s.status(401).json({ error: 'Sign in first.' }); return null; } return u; };

app.get('/api/meta', (_q, s) => s.json({ countries: COUNTRIES, categories: CATEGORIES, sandbox: SANDBOX, ai: !!GEMINI_KEY, paypal: !!(PP_ID && PP_SECRET) }));

// Sign in: a name and a country. Same name in the same country is the same person (demo).
app.post('/api/signin', (q, s) => {
  const name = String(q.body.name || '').trim().slice(0, 30);
  const country = String(q.body.country || '');
  if (name.length < 2) return s.status(400).json({ error: 'Your name, please.' });
  if (!COUNTRIES[country]) return s.status(400).json({ error: 'Pick your country.' });
  let u = users.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.country === country);
  if (!u) { u = { id: id('u'), name, country, at: Date.now() }; users.push(u); persist(); }
  s.json(u);
});

app.get('/api/listings', (q, s) => {
  const country = String(q.query.country || '');
  const cat = String(q.query.category || '');
  s.json(listings.filter((l) => l.status === 'open' && l.country === country && l.photo && (!cat || l.category === cat)).sort((a, b) => b.at - a.at).map(card));
});

app.get('/api/listings/:id', (q, s) => {
  const l = listings.find((x) => x.id === q.params.id);
  if (!l || l.status === 'deleted') return s.status(404).json({ error: 'This item is gone.' });
  s.json(full(l, String(q.query.userId || '')));
});

// Sell. A photo is required; the description must say everything because buying is instant.
app.post('/api/sell', upload.single('photo'), wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  if (!q.file || !/^image\//.test(q.file.mimetype)) return s.status(400).json({ error: 'Take a photo of it first.' });
  const title = String(q.body.title || '').trim().slice(0, 60);
  const category = String(q.body.category || '');
  const price = Math.round(Number(q.body.price) * 100) / 100;
  const description = String(q.body.description || '').trim().slice(0, 1200);
  if (title.length < 3) return s.status(400).json({ error: 'Say what it is.' });
  if (!CATEGORIES.includes(category)) return s.status(400).json({ error: 'Pick a category.' });
  if (!(price >= 1 && price <= 100000)) return s.status(400).json({ error: 'Set a price.' });
  if (description.length < 30) return s.status(400).json({ error: 'Write everything about it: condition, flaws, what comes with it.' });
  const ext = { 'image/png': '.png', 'image/webp': '.webp' }[q.file.mimetype] || '.jpg';
  const photoName = q.file.filename + ext;
  fs.renameSync(q.file.path, path.join(UPLOADS, photoName));
  const t0 = Date.now();
  const seen = await readPhoto(path.join(UPLOADS, photoName), q.file.mimetype, title, description);
  if (seen.shows_item === false) { fs.rmSync(path.join(UPLOADS, photoName), { force: true }); return s.status(400).json({ error: `The photo doesn't show "${title}". Take a real photo of it.` }); }
  const l = { id: id('l'), sellerId: u.id, country: u.country, photo: '/uploads/' + photoName, title, category, price, description, facts: seen.facts || [], status: 'open', at: Date.now() };
  listings.unshift(l);
  const sentTo = await wantsFor(l);
  persist();
  s.json({ listing: full(l, u.id), sentTo, missing: seen.missing || [], ms: Date.now() - t0 });
}));

// Leave keeps it up, delete takes it down.
app.delete('/api/listings/:id', (q, s) => {
  const u = need(q, s); if (!u) return;
  const l = listings.find((x) => x.id === q.params.id && x.sellerId === u.id);
  if (!l) return s.status(404).json({ error: 'not found' });
  if (l.status === 'sold') return s.status(400).json({ error: 'Already sold.' });
  l.status = 'deleted'; persist(); s.json({ ok: true });
});

// Buy: a small card of what you want; AI looks through everything for sale in your country.
app.post('/api/wants', wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  const what = String(q.body.what || '').trim().slice(0, 80);
  const category = String(q.body.category || '');
  const minPrice = Math.max(0, Number(q.body.minPrice) || 0);
  const maxPrice = Number(q.body.maxPrice);
  if (what.length < 3) return s.status(400).json({ error: 'Say what you want.' });
  if (!CATEGORIES.includes(category)) return s.status(400).json({ error: 'Pick a category.' });
  if (!(maxPrice >= 1) || maxPrice < minPrice) return s.status(400).json({ error: 'Set your price range.' });
  const t0 = Date.now();
  const w = { id: id('w'), userId: u.id, name: u.name, country: u.country, what, category, minPrice, maxPrice, status: 'open', matches: [], at: Date.now() };
  wants.unshift(w);
  await listingsFor(w);
  persist();
  s.json({ want: w, found: w.matches.map((m) => ({ ...m, listing: card(listings.find((l) => l.id === m.listingId)) })), ms: Date.now() - t0 });
}));

app.delete('/api/wants/:id', (q, s) => {
  const u = need(q, s); if (!u) return;
  const w = wants.find((x) => x.id === q.params.id && x.userId === u.id);
  if (!w) return s.status(404).json({ error: 'not found' });
  w.status = 'deleted'; persist(); s.json({ ok: true });
});

// Everything of mine: what I sell, what I look for (with what was found), deals to review.
app.get('/api/me', (q, s) => {
  const u = need(q, s); if (!u) return;
  const mine = listings.filter((l) => l.sellerId === u.id && l.status !== 'deleted' && l.photo).sort((a, b) => b.at - a.at).map((l) => full(l, u.id));
  const looking = wants.filter((w) => w.userId === u.id && w.status === 'open').map((w) => ({
    ...w, found: w.matches.map((m) => ({ ...m, listing: listings.find((l) => l.id === m.listingId) })).filter((m) => m.listing?.status === 'open').map((m) => ({ ...m, listing: card(m.listing) })),
  }));
  const bought = listings.filter((l) => l.buyerId === u.id && l.photo).sort((a, b) => b.soldAt - a.soldAt).map((l) => full(l, u.id));
  s.json({ user: { ...u, ...stats(u.id) }, mine, looking, bought });
});

// Pay. The buyer must say they read the description: it's an instant buy.
app.post('/api/listings/:id/pay', wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  const l = listings.find((x) => x.id === q.params.id);
  if (!l || l.status !== 'open') return s.status(409).json({ error: 'Someone was faster. This is sold.' });
  if (l.sellerId === u.id) return s.status(400).json({ error: "That's your own item." });
  if (l.country !== u.country) return s.status(400).json({ error: `Only buyers in ${COUNTRIES[l.country].name} can buy this.` });
  if (q.body.readDescription !== true) return s.status(400).json({ error: 'Read the description first.' });
  if (q.body.method === 'card') {
    if (!SANDBOX) return s.status(400).json({ error: 'Test card only works in sandbox.' });
    const cap = await sandboxCardPay(l, u);
    if (l.status !== 'open') return s.status(409).json({ error: 'Someone was faster. You were not charged.' });
    markSold(l, u, cap, 'card');
    return s.json({ paid: true, listing: full(l, u.id) });
  }
  const { payUrl } = await paypalCheckout(l, u, origin(q));
  s.json({ payUrl });
}));

// PayPal sends the buyer back here. First to pay gets it.
app.get('/paypal/return', async (q, s) => {
  const { listing: lid, buyer: bid, token } = q.query;
  const l = listings.find((x) => x.id === lid);
  const u = userOf(String(bid));
  if (!l || !u || !token) return s.redirect('/?error=unknown-order');
  if (l.status === 'sold' && l.buyerId !== u.id) return s.redirect(`/?item=${l.id}&late=1`);
  try {
    if (l.status !== 'sold') markSold(l, u, await captureOrder(String(token)), 'paypal');
    s.redirect(`/?paid=${l.id}`);
  } catch (e) {
    console.error(e);
    s.redirect(`/?item=${l.id}&error=${encodeURIComponent(e.message)}`);
  }
});

// ---------- Sign up with PayPal: name, country and address come from PayPal ----------
const states = new Map();
app.get('/auth/paypal', (q, s) => {
  const st = crypto.randomBytes(12).toString('hex');
  const back = origin(q) + '/auth/paypal/return';
  states.set(st, { back, at: Date.now() });
  s.redirect(PP_WEB + '/signin/authorize?' + new URLSearchParams({ flowEntry: 'static', client_id: PP_ID, response_type: 'code', scope: 'openid profile email address', redirect_uri: back, state: st }));
});
app.get('/auth/paypal/return', async (q, s) => {
  const st = states.get(String(q.query.state || '')); states.delete(String(q.query.state || ''));
  if (q.query.error || !q.query.code) return s.redirect('/?error=' + encodeURIComponent(q.query.error_description || 'PayPal sign-in was cancelled.'));
  if (!st) return s.redirect('/?error=' + encodeURIComponent('Sign-in expired, try again.'));
  try {
    const t = await fetch(PP_API + '/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(PP_ID + ':' + PP_SECRET).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(q.query.code) }) });
    const tj = await t.json();
    if (!t.ok) throw new Error(tj.error_description || 'PayPal said no');
    const ui = await (await fetch(PP_API + '/v1/identity/openidconnect/userinfo?schema=openid', { headers: { authorization: 'Bearer ' + tj.access_token } })).json();
    const a = ui.address || {};
    const country = String(a.country || '').toUpperCase();
    if (!COUNTRIES[country]) throw new Error(`Homing isn't open in your country (${country || 'unknown'}) yet.`);
    const full = ui.name || [ui.given_name, ui.family_name].filter(Boolean).join(' ') || 'PayPal user';
    const lines = String(a.street_address || '').split(/\n|, /);
    const address = { line1: lines[0] || '', line2: lines.slice(1).join(', '), city: a.locality || '', zip: a.postal_code || '', country };
    let u = users.find((x) => x.paypalId === ui.user_id);
    if (!u) { u = { id: id('u'), at: Date.now() }; users.push(u); }
    Object.assign(u, { paypalId: ui.user_id, name: ui.given_name || full.split(' ')[0], fullName: full, country, address, email: ui.email || '', via: 'paypal' });
    persist();
    s.redirect('/#signed/' + u.id);
  } catch (e) { console.error(e); s.redirect('/?error=' + encodeURIComponent(e.message)); }
});
// Demo for judges without a PayPal sandbox login: a made-up person with a made-up Berlin address.
const DEMO = [['Alex', 'Torstraße 45', '10119'], ['Sam', 'Oranienstraße 25', '10999'], ['Jo', 'Kastanienallee 12', '10435'], ['Robin', 'Bergmannstraße 8', '10961'], ['Kim', 'Schönhauser Allee 70', '10437']];
app.post('/api/signin/demo', (q, s) => {
  const [name, line1, zip] = DEMO[crypto.randomInt(DEMO.length)];
  const u = { id: id('u'), name, fullName: name + ' Demo', country: 'DE', address: { line1, line2: '', city: 'Berlin', zip, country: 'DE' }, at: Date.now(), via: 'demo' };
  users.push(u); persist(); s.json(u);
});
app.get('/api/whoami', (q, s) => { const u = need(q, s); if (u) s.json(u); });

// ---------- after a sale: everything the seller needs to send it ----------
app.get('/api/listings/:id/ship', wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  const l = listings.find((x) => x.id === q.params.id);
  if (!l || l.status !== 'sold' || l.sellerId !== u.id) return s.status(404).json({ error: 'Not your sale.' });
  const sh = l.ship || {};
  const text = [`Homing ${sh.code}`, l.title, sh.name, sh.line1, sh.line2, `${sh.zip} ${sh.city}`, COUNTRIES[sh.country]?.name].filter((x) => x && x.trim()).join('\n');
  const qr = await QRCode.toString(text, { type: 'svg', margin: 0, color: { dark: '#0a0a0c', light: '#0000' }, errorCorrectionLevel: 'M' });
  s.json({ item: card(l), buyer: person(l.buyerId), ship: sh, qr, tracking: l.tracking || null, paidAt: l.soldAt, from: u.address || null });
}));
const CARRIERS = { DHL: 'DHL', DEUTSCHE_DE: 'Deutsche Post', HERMES: 'Hermes', DPD: 'DPD', GLS: 'GLS', UPS: 'UPS' };
app.post('/api/listings/:id/track', wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  const l = listings.find((x) => x.id === q.params.id);
  if (!l || l.status !== 'sold' || l.sellerId !== u.id) return s.status(404).json({ error: 'Not your sale.' });
  const carrier = String(q.body.carrier || ''); const number = String(q.body.number || '').replace(/\s+/g, '').slice(0, 40);
  if (!CARRIERS[carrier]) return s.status(400).json({ error: 'Pick who carries it.' });
  if (number.length < 6) return s.status(400).json({ error: 'Type the tracking number.' });
  // tell PayPal, so the buyer sees it in their PayPal activity too
  let inPayPal = false;
  if (l.capture?.orderId && l.capture?.id) {
    try { await pp('POST', `/v2/checkout/orders/${l.capture.orderId}/track`, { capture_id: l.capture.id, tracking_number: number, carrier, notify_payer: true }); inPayPal = true; }
    catch (e) { console.error('track', e.message); }
  }
  l.tracking = { carrier, carrierName: CARRIERS[carrier], number, inPayPal, at: Date.now() };
  persist(); s.json(l.tracking);
}));
app.get('/api/post-offices', wrap(async (q, s) => {
  const u = need(q, s); if (!u) return;
  let p = q.query.lat ? { lat: Number(q.query.lat), lon: Number(q.query.lon) } : null;
  if (!p && u.address) p = await geocode(u.address);
  if (!p) return s.json({ near: [], why: 'No address to search from.' });
  s.json({ near: await postOffices(p), from: q.query.lat ? 'you' : 'address' });
}));

// Reviews: only the buyer and the seller of a finished deal, once each.
app.post('/api/listings/:id/review', (q, s) => {
  const u = need(q, s); if (!u) return;
  const l = listings.find((x) => x.id === q.params.id);
  if (!l || l.status !== 'sold') return s.status(400).json({ error: 'You can only review a finished deal.' });
  const side = l.buyerId === u.id ? 'buyer' : l.sellerId === u.id ? 'seller' : null;
  if (!side) return s.status(403).json({ error: 'Only the buyer and the seller can review this deal.' });
  if (l.reviews?.[side]) return s.status(400).json({ error: 'You already reviewed this deal.' });
  const stars = Math.round(Number(q.body.stars));
  if (!(stars >= 1 && stars <= 5)) return s.status(400).json({ error: 'Pick 1 to 5 stars.' });
  l.reviews = { ...(l.reviews || {}), [side]: { stars, text: String(q.body.text || '').trim().slice(0, 200), at: Date.now() } };
  persist();
  s.json(full(l, u.id));
});

// Live numbers for the home screen.
app.get('/api/pulse', (q, s) => {
  const c = String(q.query.country || '');
  s.json({ forSale: listings.filter((l) => l.status === 'open' && l.country === c && l.photo).length, looking: wants.filter((w) => w.status === 'open' && w.country === c).length });
});

// A person's page: their numbers, what they sell, and every review from a real deal.
app.get('/api/users/:id', (q, s) => {
  const u = userOf(q.params.id);
  if (!u) return s.status(404).json({ error: 'not found' });
  const reviews = [];
  for (const l of listings) {
    if (l.status !== 'sold') continue;
    if (l.sellerId === u.id && l.reviews?.buyer) reviews.push({ ...l.reviews.buyer, from: person(l.buyerId)?.name, role: 'bought', item: l.title, price: l.price, currency: currencyOf(l.country) });
    if (l.buyerId === u.id && l.reviews?.seller) reviews.push({ ...l.reviews.seller, from: person(l.sellerId)?.name, role: 'sold', item: l.title, price: l.price, currency: currencyOf(l.country) });
  }
  reviews.sort((a, b) => b.at - a.at);
  const forSale = listings.filter((l) => l.sellerId === u.id && l.status === 'open' && l.photo).sort((a, b) => b.at - a.at).map(card);
  s.json({ id: u.id, name: u.name, country: u.country, since: u.at, ...stats(u.id), forSale, feed: reviews });
});

// Leaderboard per country: counts and stars come only from finished deals.
app.get('/api/leaderboard', (q, s) => {
  const country = String(q.query.country || '');
  const by = q.query.by === 'buyers' ? 'bought' : 'sold';
  s.json(users.filter((u) => u.country === country).map((u) => ({ id: u.id, name: u.name, ...stats(u.id) }))
    .filter((u) => u[by] > 0).sort((a, b) => b[by] - a[by] || (b.stars || 0) - (a.stars || 0)).slice(0, 20));
});

app.post('/api/reset', (_q, s) => {
  users = seed('users.json'); listings = seed('listings.json'); wants = seed('wants.json');
  persist();
  s.json({ ok: true });
});

app.listen(PORT, () => console.log(`Homing on ${BASE_URL}  ai=${!!GEMINI_KEY} paypal=${!!(PP_ID && PP_SECRET)} ${SANDBOX ? 'sandbox' : 'LIVE'}`));
