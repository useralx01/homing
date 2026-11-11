// Sought: snap what you sell, AI hands it to the people already looking for it,
// each gets a short message, the full details, and a PayPal button.
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
const CURRENCY = process.env.CURRENCY || 'EUR';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-3-flash-preview,gemini-flash-latest,gemini-3.5-flash').split(',').map((s) => s.trim()).filter(Boolean);
const PP_ID = process.env.PAYPAL_CLIENT_ID || '';
const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PP_API = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

// ---------- tiny JSON store ----------
const file = (n) => path.join(DATA, n);
const load = (n, fallback) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return fallback; } };
const save = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 2));
let wants = load('wants.json', null) ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'wants.json'), 'utf8'));
let offers = load('offers.json', []);
const persist = () => { save('wants.json', wants); save('offers.json', offers); };
persist();
const id = (p) => p + '_' + crypto.randomBytes(5).toString('hex');

// ---------- Gemini ----------
async function gemini(parts, schemaHint) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is missing in .env');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [...parts, { text: schemaHint }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  // Try the chosen model first; if Google is busy or refuses, fall back so a demo never stalls.
  const models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
  let last;
  for (const m of models) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20000) });
    } catch (e) { last = `${m}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { last = `${m}: ${j.error?.message || r.status}`; if (process.env.DEBUG) console.log('gemini', last); continue; }
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text.replace(/^```json\s*|```$/g, '')); } catch { last = `${m}: bad JSON`; }
  }
  throw new Error('Gemini: ' + last);
}

async function readItem(imagePath, mime, sellerLine, sellerDetails) {
  const data = fs.readFileSync(imagePath).toString('base64');
  return gemini(
    [{ inline_data: { mime_type: mime, data } }],
    `You look at a photo of something a private person wants to sell, plus what they typed.
Seller typed: "${sellerLine}"
Seller details: "${sellerDetails || '(none)'}"
Return JSON only:
{"title": short product name a buyer would search for,
 "category": one or two words,
 "price": number in ${CURRENCY} (use the seller's price if given, else a fair used price),
 "condition": "new" | "like new" | "good" | "used" | "worn",
 "facts": [3-6 short concrete facts you can SEE or that the seller stated, e.g. "white", "original box included"],
 "flaws": [visible or stated flaws, short; empty if none],
 "handover": "shipping" | "pickup" | "both" | "unknown"}
Never invent facts you cannot see or that were not stated.`,
  );
}

async function matchWants(item, sellerLine, sellerDetails, open) {
  if (!open.length) return [];
  const list = open.map((w) => ({ id: w.id, looking_for: w.want, max_price: w.maxPrice, city: w.city, care_about: w.careAbout, note: w.note }));
  const res = await gemini(
    [],
    `An item is for sale:
${JSON.stringify({ ...item, seller_line: sellerLine, seller_details: sellerDetails })}

These people said they are looking for something (opt-in requests):
${JSON.stringify(list)}

Score EVERY person in the list (return one entry per person, same order), JSON:
{"matches":[{"id": person id,
  "same_kind": true if this item is the kind of thing the person is looking for (colour, small differences don't matter), else false,
  "score": 0-100 how well it fits (0 if not the same kind),
  "why": one short sentence (max 12 words) why it fits; use the name, never he/she/her/his,
  "message": a friendly 1-line message to that person from the seller, max 90 characters, mention the price,
  "checks":[{"need": each thing from care_about, "status":"ok"|"warn"|"unknown", "note": max 10 words}]}]}
A different colour only lowers the score a little. Be honest in checks: "unknown" if the photo/details don't prove it.`,
  );
  const raw = Array.isArray(res) ? res : res.matches || res.people || [];
  if (process.env.DEBUG) console.log('match raw', JSON.stringify(res).slice(0, 600));
  const price = Number(item.price) || 0;
  return raw
    .map((m) => ({ ...m, id: String(m.id || m.person_id || '').trim(), score: Number(m.score) || 0 }))
    .map((m) => ({ ...m, want: open.find((w) => w.id === m.id) }))
    .filter((m) => m.want && m.same_kind !== false && m.score >= 50)
    // budget is a hard rule, checked in code, not left to the model
    .filter((m) => !price || m.want.maxPrice == null || price <= m.want.maxPrice)
    .map(({ want, same_kind, ...m }) => m)
    .sort((a, b) => b.score - a.score);
}

async function parseWant(name, text) {
  return gemini(
    [],
    `A person describes what they are looking for to buy, in their own words:
"${text}"
Return JSON only:
{"want": short product they want (max 6 words),
 "maxPrice": number in ${CURRENCY} or null,
 "city": city if mentioned else "",
 "careAbout": [2-5 short things they care about / want checked, max 6 words each],
 "note": one short line in their voice (max 80 chars)}`,
  );
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
  if (!r.ok) throw new Error('PayPal ' + p + ': ' + (j.details?.[0]?.description || j.message || r.status));
  return j;
}
async function createOrder(offer, want, match) {
  const unit = {
    reference_id: offer.id,
    custom_id: `${offer.id}:${want.id}`,
    description: `${offer.item.title} (Sought)`.slice(0, 127),
    amount: { currency_code: CURRENCY, value: Number(offer.item.price).toFixed(2) },
  };
  if (offer.sellerPaypal) unit.payee = { email_address: offer.sellerPaypal };
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [unit],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Sought',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${BASE_URL}/paypal/return?offer=${offer.id}&want=${want.id}`,
          cancel_url: `${BASE_URL}/?inbox=${want.id}`,
        },
      },
    },
  });
  return { orderId: order.id, payUrl: order.links.find((l) => l.rel === 'payer-action')?.href };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public')));
const upload = multer({ dest: UPLOADS, limits: { fileSize: 8 * 1024 * 1024 } });

const publicOffer = (o, wantId) => {
  const d = o.deliveries.find((x) => x.wantId === wantId);
  return {
    id: o.id, at: o.at, seller: o.seller, photo: o.photo, item: o.item, sellerLine: o.sellerLine, sellerDetails: o.sellerDetails,
    status: o.soldTo ? (o.soldTo === wantId ? 'yours' : 'sold') : 'open',
    message: d?.message, why: d?.why, score: d?.score, checks: d?.checks, payUrl: o.soldTo ? null : d?.payUrl,
  };
};

app.get('/api/health', (_q, s) => s.json({ ai: !!GEMINI_KEY, paypal: !!(PP_ID && PP_SECRET), model: GEMINI_MODEL, env: PP_API.includes('sandbox') ? 'sandbox' : 'live' }));

app.get('/api/wants', (_q, s) => s.json(wants));

app.post('/api/wants', async (q, s) => {
  try {
    const name = String(q.body.name || '').trim().slice(0, 40) || 'Someone';
    const text = String(q.body.text || '').trim().slice(0, 600);
    if (text.length < 4) return s.status(400).json({ error: 'Say what you are looking for.' });
    const p = await parseWant(name, text);
    const w = { id: id('w'), name, said: text, want: p.want, maxPrice: p.maxPrice ?? null, city: p.city || '', careAbout: p.careAbout || [], note: p.note || '', at: Date.now() };
    wants.unshift(w);
    persist();
    s.json(w);
  } catch (e) { s.status(500).json({ error: e.message }); }
});

app.delete('/api/wants/:id', (q, s) => { wants = wants.filter((w) => w.id !== q.params.id); persist(); s.json({ ok: true }); });

app.post('/api/sell', upload.single('photo'), async (q, s) => {
  try {
    if (!q.file) return s.status(400).json({ error: 'Add a photo.' });
    const line = String(q.body.line || '').trim().slice(0, 200);
    const details = String(q.body.details || '').trim().slice(0, 1000);
    const ext = { 'image/png': '.png', 'image/webp': '.webp' }[q.file.mimetype] || '.jpg';
    const photoName = q.file.filename + ext;
    fs.renameSync(q.file.path, path.join(UPLOADS, photoName));
    const t0 = Date.now();
    const item = await readItem(path.join(UPLOADS, photoName), q.file.mimetype, line, details);
    const open = wants.filter((w) => !w.boughtOffer);
    const matches = await matchWants(item, line, details, open);
    const offer = {
      id: id('o'), at: Date.now(), seller: String(q.body.seller || 'A seller').slice(0, 40), sellerPaypal: String(q.body.sellerPaypal || '').trim() || null,
      photo: '/uploads/' + photoName, sellerLine: line, sellerDetails: details, item, soldTo: null, deliveries: [],
    };
    for (const m of matches) {
      const w = wants.find((x) => x.id === m.id);
      const { orderId, payUrl } = await createOrder(offer, w, m);
      offer.deliveries.push({ wantId: w.id, score: m.score, why: m.why, message: m.message, checks: m.checks || [], orderId, payUrl, at: Date.now() });
    }
    offers.unshift(offer);
    persist();
    s.json({ offer: { id: offer.id, item, photo: offer.photo }, ms: Date.now() - t0, matches: offer.deliveries.map((d) => ({ ...d, want: wants.find((w) => w.id === d.wantId) })) });
  } catch (e) { console.error(e); s.status(500).json({ error: e.message }); }
});

app.get('/api/inbox/:wantId', (q, s) => {
  const w = wants.find((x) => x.id === q.params.wantId);
  if (!w) return s.status(404).json({ error: 'not found' });
  s.json({ want: w, offers: offers.filter((o) => o.deliveries.some((d) => d.wantId === w.id)).map((o) => publicOffer(o, w.id)) });
});

app.get('/api/offers/:id', (q, s) => {
  const o = offers.find((x) => x.id === q.params.id);
  if (!o) return s.status(404).json({ error: 'not found' });
  s.json({ id: o.id, item: o.item, photo: o.photo, soldTo: o.soldTo, capture: o.capture || null,
    deliveries: o.deliveries.map((d) => ({ wantId: d.wantId, name: wants.find((w) => w.id === d.wantId)?.name, score: d.score })) });
});

// PayPal sends the buyer back here after approving. First capture wins; everyone else sees "sold".
app.get('/paypal/return', async (q, s) => {
  const { offer: oid, want: wid, token } = q.query;
  const o = offers.find((x) => x.id === oid);
  const d = o?.deliveries.find((x) => x.wantId === wid);
  if (!o || !d || d.orderId !== token) return s.redirect('/?error=unknown-order');
  if (o.soldTo && o.soldTo !== wid) return s.redirect(`/?inbox=${wid}&late=1`);
  try {
    if (!o.soldTo) {
      // A refresh or double click can arrive after PayPal already captured it: read the order instead of failing.
      let cap;
      try { cap = await pp('POST', `/v2/checkout/orders/${token}/capture`); }
      catch (e) {
        cap = await pp('GET', `/v2/checkout/orders/${token}`);
        if (cap.status !== 'COMPLETED') throw e;
      }
      const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
      o.soldTo = wid;
      o.capture = { id: c?.id, status: c?.status || cap.status, amount: c?.amount, payer: cap.payer?.email_address || null, at: Date.now() };
      const w = wants.find((x) => x.id === wid);
      if (w) w.boughtOffer = o.id;
      persist();
    }
    s.redirect(`/?inbox=${wid}&paid=${o.id}`);
  } catch (e) {
    console.error(e);
    s.redirect(`/?inbox=${wid}&error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/reset', (_q, s) => {
  wants = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'wants.json'), 'utf8'));
  offers = [];
  persist();
  s.json({ ok: true });
});

app.listen(PORT, () => console.log(`Sought on ${BASE_URL}  ai=${!!GEMINI_KEY} paypal=${!!(PP_ID && PP_SECRET)}`));
