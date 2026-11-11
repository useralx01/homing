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
  return unit;
}
async function paypalCheckout(l, buyer) {
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(l, buyer)],
    payment_source: { paypal: { experience_context: {
      brand_name: 'Homing', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
      return_url: `${BASE_URL}/paypal/return?listing=${l.id}&buyer=${buyer.id}`,
      cancel_url: `${BASE_URL}/?item=${l.id}`,
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
  l.capture = { id: c?.id || cap.id, status: c?.status || cap.status, amount: c?.amount, via };
  l.reviews = {};
  // anyone else who was matched to it simply sees it's gone; the buyer's want is done
  for (const w of wants) if (w.userId === buyer.id && w.status === 'open' && w.matches.some((m) => m.listingId === l.id)) w.status = 'done';
  persist();
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
  const { payUrl } = await paypalCheckout(l, u);
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
