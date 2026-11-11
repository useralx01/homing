// Homing: sign in, then Sell / Buy / Browse. Plain hash routes so the phone's back button works.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STAR = '<svg class="star" viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
const PP = '<span>Pay <b class="amt"></b> with</span><b style="font-style:italic;font-weight:800;color:#003087">Pay</b><b style="font-style:italic;font-weight:800;color:#0070e0;margin-left:-8px">Pal</b>';

let me = null, meta = null;
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = 'linear(0, 0.06 2%, 0.24 5%, 0.53 10%, 0.82 17%, 0.98 24%, 1.04 30%, 1.05 36%, 1.03 46%, 1.005 60%, 0.998 75%, 1)';
// haptics with levels: light = frequent taps, medium = moving between screens, success = posted / paid / sold
const HAPTIC = { light: 7, medium: 14, heavy: 26, success: [14, 60, 22, 60, 40], error: [30, 70, 30] };
const haptic = (lvl = 'light') => { try { if (matchMedia('(pointer:coarse)').matches) navigator.vibrate?.(HAPTIC[lvl] ?? lvl); } catch {} };
// money that counts up after the tick has drawn itself
function countUp(el, to, c, delay = 650) {
  if (REDUCE) { el.textContent = money(to, c); return; }
  el.textContent = money(0, c);
  const t0 = performance.now() + delay;
  const step = (now) => { const k = Math.min(1, Math.max(0, (now - t0) / 850)), e = 1 - Math.pow(1 - k, 3); el.textContent = money(k < 1 ? Math.round(to * e) : to, c); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// the mascot, Dot, for empty and waiting moments
const dot = (kind, title, text = '', cls = '') => `<div class="dotempty ${cls}"><img src="/img/dot-${kind}.webp" alt="" width="160" height="160"><b>${title}</b>${text ? `<p>${text}</p>` : ''}</div>`;
function dotSwap(id, kind) { const im = $(id + ' img'); if (!im || im.dataset.k === kind) return; im.dataset.k = kind; im.src = `/img/dot-${kind}.webp`; im.classList.remove('swap'); void im.offsetWidth; im.classList.add('swap'); }
// chips: the selected fill slides between them
function movePill(box, quiet) {
  if (!box) return;
  let p = box.querySelector(':scope > .pill');
  const b = box.querySelector('button[aria-checked="true"]');
  if (!b || !b.offsetWidth) { if (p) { p.style.opacity = '0'; p.dataset.on = ''; } return; }
  if (!p) { p = document.createElement('i'); p.className = 'pill'; box.prepend(p); box.classList.add('has-pill'); }
  const first = !p.dataset.on;
  if (first || quiet) p.style.transition = 'none';
  p.style.width = b.offsetWidth + 'px'; p.style.height = b.offsetHeight + 'px';
  p.style.transform = `translate(${b.offsetLeft}px,${b.offsetTop}px)`; p.style.opacity = '1'; p.dataset.on = '1';
  if (first || quiet) { if (!REDUCE && !quiet) p.animate([{ scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1 }], { duration: 420, easing: SPRING }); requestAnimationFrame(() => requestAnimationFrame(() => (p.style.transition = ''))); }
}
document.addEventListener('click', (e) => { const b = e.target.closest('.chips button'); if (b) { movePill(b.parentElement); haptic('light'); } });
addEventListener('resize', () => $$('.chips').forEach((b) => movePill(b, true)));
try { me = JSON.parse(localStorage.getItem('homing.user') || 'null'); } catch {}

const api = async (url, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (me) headers['x-user'] = me.id;
  if (opts.json) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(url, { ...opts, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
};
const cur = () => meta.countries[me?.country]?.currency || 'EUR';
const money = (v, c = cur()) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c, maximumFractionDigits: Number(v) % 1 ? 2 : 0 }).format(v);
const sym = () => money(0).replace(/[\d.,\s]/g, '');
// every person gets their own shade of blue
const hue = (name = '') => 205 + ([...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) % 30);
const avatar = (el, name, url) => { el.style.setProperty('--h', hue(name)); el.classList.toggle('pic', !!url); if (url) el.innerHTML = `<img src="${esc(url)}" alt="">`; else el.textContent = (name || '?').trim()[0].toUpperCase(); };
const av = (name, cls = '', url = null) => url ? `<span class="av pic ${cls}"><img src="${esc(url)}" alt=""></span>` : `<span class="av ${cls}" style="--h:${hue(name)}">${esc((name || '?').trim()[0].toUpperCase())}</span>`;
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
const ago = (t) => { const d = Math.round((Date.now() - t) / 86400000); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? d + ' days ago' : d < 60 ? Math.round(d / 7) + ' weeks ago' : Math.round(d / 30) + ' months ago'; };
window.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', scrollY > 4), { passive: true });
const names = (list) => list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1);
let toastT;
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); };

// ---------- routing ----------
const show = (name) => {
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  $('#top').hidden = name === 'signin';
  $('#back').classList.toggle('off', name === 'home');
  $('#top').classList.toggle('at-home', name === 'home');
  $('#sheet').hidden = true; document.body.classList.remove('locked');
  $('#side').hidden = name === 'signin';
  const sec = { posted: 'sell', found: 'buy', item: 'browse', user: 'board', ship: 'me', paid: 'me' }[name] || name;
  $$('#side a').forEach((a) => { const on = a.dataset.nav === sec; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
  requestAnimationFrame(() => $$(`[data-screen="${name}"] .chips`).forEach((b) => movePill(b, true)));
};
let depth = 0, skipVT = false;
// forward slides in from the right, back slides back
const RANK = { home: 0, '': 0, sell: 1, buy: 1, browse: 1, board: 1, me: 1, posted: 2, found: 2, item: 2, user: 2, paid: 3, ship: 3, signed: 0 };
const rank = (h) => RANK[(h || '').slice(1).split('/')[0]] ?? 1;
const navStack = [location.hash];
window.addEventListener('hashchange', () => {
  const h = location.hash, prev = navStack.at(-1);
  let dir = 'fwd';
  if (navStack.length > 1 && navStack.at(-2) === h) { navStack.pop(); dir = 'back'; }
  else { navStack.push(h); if (rank(h) < rank(prev)) dir = 'back'; }
  document.documentElement.dataset.dir = dir;
  depth++; haptic('medium'); go();
});
document.documentElement.classList.toggle('vt', !!document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches);
const go = () => {
  if (skipVT) { skipVT = false; return route(); }
  if (!document.documentElement.classList.contains('vt')) return route();
  const t = document.startViewTransition(() => route());
  t.ready.catch(() => {}); t.finished.catch(() => {}); t.updateCallbackDone.catch(() => {});
};
document.addEventListener('pointerdown', (e) => {
  const c = e.target.closest('.gcard'); if (!c) return;
  $$('.gcard img').forEach((i) => (i.style.viewTransitionName = ''));
  const img = $('img', c); if (img) img.style.viewTransitionName = 'photo';
}, true);
$('#back').onclick = () => (depth > 0 ? history.back() : (location.hash = 'home'));

async function route() {
  if (location.hash.startsWith('#signed/')) {
    // back from PayPal: the server made or found the account
    me = null;
    try { me = await api('/api/whoami', { headers: { 'x-user': location.hash.split('/')[1] } }); localStorage.setItem('homing.user', JSON.stringify(me)); setupForUser(); toast(`Signed in with PayPal as ${me.fullName || me.name}.`); }
    catch { me = null; }
    history.replaceState(null, '', '/#home');
  }
  if (!me) return show('signin');
  const [name, arg] = location.hash.slice(1).split('/');
  stopWaiting();
  refreshBadge();
  switch (name) {
    case 'sell':
      sellPreview();
      api(`/api/pulse?country=${me.country}`).then((p) => ($('#pvLook').textContent = `${p.looking} people are looking in ${meta.countries[me.country].name}`)).catch(() => {});
      return show('sell');
    case 'posted': return pending ? show('posted') : (location.hash = 'sell');
    case 'buy': return openBuy();
    case 'found': return lastFound ? show('found') : (location.hash = 'buy');
    case 'browse': return openBrowse();
    case 'item': return openItem(arg);
    case 'paid': return openPaid(arg);
    case 'me': return openMe();
    case 'board': return openBoard();
    case 'user': return openUser(arg);
    case 'ship': return openShip(arg);
    default: return openHome();
  }
}

// ---------- sign in ----------
$('#demoBtn').onclick = async () => {
  try {
    me = await api('/api/signin/demo', { method: 'POST', json: {} });
    localStorage.setItem('homing.user', JSON.stringify(me));
    setupForUser(); location.hash = 'home'; route();
  } catch (err) { $('#signinErr').textContent = err.message; }
};
$('#signout').onclick = () => { localStorage.removeItem('homing.user'); me = null; location.hash = ''; show('signin'); };

function setupForUser() {
  avatar($('#meAv'), me.name, me.avatar);
  avatar($('#wAv'), me.name, me.avatar);
  $('#wName').textContent = me.name;
  const cn = meta.countries[me.country].name;
  $('#wCountry').textContent = cn + ' only';
  $('#bCountry').textContent = cn + ' only';
  $('#sideCountry').textContent = cn + ' only';
  $$('.cur').forEach((c) => { c.textContent = sym(); c.nextElementSibling.style.paddingLeft = 18 + sym().length * 11 + 'px'; });
}

// ---------- home ----------
function openHome() {
  $('#hello').textContent = `Hi ${me.name}.`;
  api(`/api/pulse?country=${me.country}`).then((p) => { $('#pulseTxt').innerHTML = `<b>${p.forSale}</b> for sale · <b>${p.looking}</b> people looking in ${esc(meta.countries[me.country].name)}`; $('#pulse').hidden = false; }).catch(() => {});
  show('home');
  api(`/api/listings?country=${me.country}`).then((l) => {
    window.shelf?.('shelfHome', l);
    $('#jiRows').innerHTML = l.slice(0, 5).map((x) => `<li><a href="#item/${esc(x.id)}"><img src="${esc(x.photo)}" alt=""></a><a class="t" href="#item/${esc(x.id)}"><b>${esc(x.title)}</b><small>${esc(x.category || '')} · ${ago(x.at)}</small></a><span class="act"><b class="jp">${money(x.price, x.currency)}</b></span></li>`).join('');
  }).catch(() => {});
}
async function refreshBadge() {
  if (!me) return;
  try {
    const d = await api('/api/me');
    const n = todo(d);
    $('#homeCount').hidden = !n; $('#homeCount').textContent = n;
    $('#sideCount').hidden = !n; $('#sideCount').textContent = n;
    $('#meDot').hidden = !n;
  } catch {}
}
// things waiting for me: items found for my wants, and finished deals I haven't reviewed
const todo = (d) => d.looking.reduce((a, w) => a + w.found.length, 0)
  + d.bought.filter((l) => !l.reviews?.buyer).length
  + d.mine.filter((l) => l.status === 'sold' && !l.reviews?.seller).length;

// ---------- chips ----------
function chips(box, { all = false, onPick } = {}) {
  box.innerHTML = '';
  const opts = (all ? [''] : []).concat(meta.categories);
  for (const c of opts) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.v = c;
    b.textContent = c || 'All';
    b.setAttribute('aria-checked', String(all && !c));
    b.onclick = () => { $$('button', box).forEach((x) => x.setAttribute('aria-checked', String(x === b))); onPick?.(c); };
    box.append(b);
  }
}
const picked = (box) => $('button[aria-checked="true"]', box)?.dataset.v || '';

// ---------- sell ----------
const sellForm = $('#sellForm');
let shotFile = null, shotUrl = '';
$('#photo').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  shotFile = f;
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shotUrl = URL.createObjectURL(f);
  $('#shotImg').src = shotUrl;
  $('#shot').classList.add('has');
  checkSell(); sellPreview();
};
function checkSell() {
  const miss = [];
  if (!shotFile) miss.push('a photo');
  if ($('#sTitle').value.trim().length < 3) miss.push('what it is');
  if (!picked($('#sCats'))) miss.push('a category');
  if (!(Number($('#sPrice').value) >= 1)) miss.push('a price');
  const d = $('#sDesc').value.trim().length;
  if (d < 30) miss.push('the description');
  $('#sDescHint').textContent = d < 30 ? `${30 - d} more characters. Condition, flaws, what comes with it.` : 'Good. Buyers will read this before they pay.';
  $('#sDescHint').classList.toggle('ok', d >= 30);
  $('#post').disabled = miss.length > 0;
  $('#sellNeed').textContent = miss.length ? 'Still needs ' + names(miss) + '.' : '';
}
sellForm.addEventListener('input', checkSell);
function sellPreview() {
  const t = $('#sTitle').value.trim(), pr = Number($('#sPrice').value);
  $('#pvT').textContent = t || 'What is it'; $('#pvP').textContent = pr >= 1 ? money(pr) : sym() + '–';
  const has = !!shotUrl && $('#shot').classList.contains('has');
  $('#pvImg').hidden = !has; if (has && $('#pvImg').src !== shotUrl) $('#pvImg').src = shotUrl;
  $('#pvPh').hidden = has;
}
sellForm.addEventListener('input', sellPreview);
sellForm.addEventListener('click', () => requestAnimationFrame(sellPreview));

let pending = null, waitT = null, pollT = null;
function stopWaiting() {
  if (location.hash.startsWith('#posted')) return;
  clearInterval(waitT); clearInterval(pollT); waitT = pollT = null;
}
// Post: squeeze, the arrow turns into a spinner, then a check, then blue fills the screen into the waiting screen
async function morphPost(btn) {
  if (REDUCE) return null;
  btn.classList.add('m1'); await wait(340);
  btn.classList.add('m2'); await wait(700);
  btn.classList.add('m3'); haptic('light'); await wait(420);
  const r = btn.getBoundingClientRect(), f = document.createElement('div');
  f.className = 'fill'; f.style.setProperty('--x', r.left + r.width / 2 + 'px'); f.style.setProperty('--y', r.top + r.height / 2 + 'px');
  document.body.append(f); void f.offsetWidth; f.classList.add('grow'); await wait(460);
  return f;
}
let posting = false;
sellForm.onsubmit = async (e) => {
  e.preventDefault();
  if ($('#post').disabled || posting) return;
  posting = true;
  $('#sellErr').textContent = '';
  const fd = new FormData();
  fd.append('photo', shotFile);
  fd.append('title', $('#sTitle').value.trim());
  fd.append('category', picked($('#sCats')));
  fd.append('price', $('#sPrice').value);
  fd.append('description', $('#sDesc').value.trim());
  pending = { title: $('#sTitle').value.trim(), price: Number($('#sPrice').value) };
  $('#pImg').src = shotUrl; $('#pTitle').textContent = pending.title; $('#pPrice').textContent = money(pending.price);
  const live = $('#pLive');
  live.className = 'live'; $('.ring', live).className = 'ring spin';
  $('#pHead').textContent = 'Checking your photo'; $('#pSub').textContent = 'Making sure it shows what you wrote.';
  $('#pOutcome').hidden = true; $('#pOutcome').innerHTML = '';
  dotSwap('#pDot', 'search');
  const req = api('/api/sell', { method: 'POST', body: fd }); req.catch(() => {});
  const fill = await morphPost($('#post'));
  if (fill) skipVT = true;
  location.hash = 'posted';
  if (fill) { setTimeout(() => fill.classList.add('out'), 80); setTimeout(() => fill.remove(), 700); }
  posting = false;
  const step = setTimeout(() => { $('#pHead').textContent = 'Finding buyers'; $('#pSub').textContent = `Everyone in ${meta.countries[me.country].name} looking for this.`; }, 1700);
  try {
    const out = await req;
    clearTimeout(step);
    haptic('success');
    pending.id = out.listing.id;
    resetSell();
    if (out.sentTo.length) waitForBuyer(out);
    else noBuyer(out.listing.id, 'Nobody is looking for this right now.');
  } catch (err) {
    clearTimeout(step);
    pending = null; posting = false;
    $('#post').classList.remove('m1', 'm2', 'm3');
    location.hash = 'sell';
    haptic('error');
    $('#sellErr').textContent = err.message;
  }
};
function resetSell() {
  sellForm.reset(); shotFile = null;
  $('#shot').classList.remove('has'); $('#shotImg').removeAttribute('src');
  $$('#sCats button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  $('#post').classList.remove('m1', 'm2', 'm3'); movePill($('#sCats'));
  checkSell();
}
const WAIT_S = 45;
function waitForBuyer(out) {
  const live = $('#pLive'), who = out.sentTo.map((s) => s.name);
  $('.ring', live).className = 'ring';
  dotSwap('#pDot', 'wait');
  $('#pHead').textContent = `Sent to ${names(who)}`;
  let left = WAIT_S;
  const tick = () => {
    $('#pSub').textContent = `${who.length === 1 ? 'They are' : 'They are all'} looking for this. Waiting for a buyer, ${left}s`;
    $('#pArc').style.strokeDashoffset = String(132 * (left / WAIT_S));
  };
  $('#pArc').style.transition = 'none'; $('#pArc').style.strokeDashoffset = '132';
  requestAnimationFrame(() => { $('#pArc').style.transition = ''; tick(); });
  clearInterval(waitT); clearInterval(pollT);
  waitT = setInterval(() => { left--; tick(); if (left <= 0) { clearInterval(waitT); clearInterval(pollT); noBuyer(out.listing.id, `${names(who)} didn't buy yet.`); } }, 1000);
  pollT = setInterval(async () => {
    try {
      const l = await api(`/api/listings/${out.listing.id}?userId=${me.id}`);
      if (l.status === 'sold') { clearInterval(waitT); clearInterval(pollT); sold(l); }
    } catch {}
  }, 2000);
}
function sold(l) {
  const live = $('#pLive');
  live.className = 'live done';
  $('#pArc').style.strokeDashoffset = '0';
  $('.ring', live).innerHTML = '<svg class="tick" viewBox="0 0 52 52" style="width:48px;height:48px;margin:0;transform:none"><circle cx="26" cy="26" r="24"/><path d="M15 27l7.5 7.5L37.5 19"/></svg>';
  $('#pHead').textContent = `Sold to ${l.buyer.name}`;
  $('#pSub').innerHTML = '<b class="cnt"></b> paid with PayPal.';
  countUp($('#pSub .cnt'), l.price, l.currency, 500);
  dotSwap('#pDot', 'happy'); haptic('success');
  const o = $('#pOutcome');
  o.hidden = false;
  o.innerHTML = `<a class="primary" href="#ship/${l.id}" style="margin-top:4px">Ship it</a><div class="rate"></div>`;
  seenSold.add(l.id); saveSeen();
  rateForm($('.rate', o), l, 'seller', l.buyer.name);
}
function noBuyer(lid, why) {
  const live = $('#pLive');
  live.className = 'live miss'; $('.ring', live).className = 'ring';
  $('#pHead').textContent = 'No buyer yet';
  dotSwap('#pDot', 'sleep');
  $('#pSub').textContent = why;
  const o = $('#pOutcome');
  o.hidden = false;
  o.innerHTML = `<p class="sub">Leave it up and anyone in ${esc(meta.countries[me.country].name)} can find it, or take it down.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`;
  $('[data-a="leave"]', o).onclick = () => { pending = null; toast('It stays up. People can find it in Browse.'); location.hash = 'home'; };
  $('[data-a="delete"]', o).onclick = async () => { await api(`/api/listings/${lid}`, { method: 'DELETE' }).catch(() => {}); pending = null; toast('Deleted.'); location.hash = 'home'; };
}

// ---------- buy ----------
const buyForm = $('#buyForm');
function openBuy() { show('buy'); buyPreview(); }
function checkBuy() {
  const max = Number($('#wMax').value), min = Number($('#wMin').value) || 0;
  $('#find').disabled = !($('#wWhat').value.trim().length >= 3 && picked($('#wCats')) && max >= 1 && max >= min);
}
buyForm.addEventListener('input', checkBuy);
const catCache = {};
let bpT;
function buyPreview() {
  clearTimeout(bpT);
  bpT = setTimeout(async () => {
    const cat = picked($('#wCats')), grid = $('#bpGrid'), none = $('#bpNone');
    if (!cat) { grid.innerHTML = ''; none.innerHTML = dot('hello', 'Pick a category', 'You will see what is already for sale, right here.', 'sm'); $('#bpHead').textContent = 'Already for sale'; return; }
    catCache[cat] ||= api(`/api/listings?country=${me.country}&category=${encodeURIComponent(cat)}`).catch(() => []);
    let items = await catCache[cat];
    const min = Number($('#wMin').value) || 0, max = Number($('#wMax').value) || Infinity;
    items = items.filter((l) => l.price >= min && l.price <= max);
    const words = $('#wWhat').value.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 3);
    const hit = items.filter((l) => words.some((w) => l.title.toLowerCase().includes(w)));
    if (hit.length) items = hit;
    $('#bpHead').textContent = items.length ? `Already for sale · ${items.length}` : 'Already for sale';
    fillGrid(grid, items.slice(0, 6));
    none.innerHTML = items.length ? '' : dot('search', 'Nothing like it yet', 'Post your card and it comes to you the moment someone sells one.', 'sm');
  }, 220);
}
buyForm.addEventListener('input', buyPreview);
let lastFound = null;
buyForm.onsubmit = async (e) => {
  e.preventDefault();
  if ($('#find').disabled) return;
  $('#buyErr').textContent = '';
  const body = { what: $('#wWhat').value.trim(), category: picked($('#wCats')), minPrice: $('#wMin').value || 0, maxPrice: $('#wMax').value };
  lastFound = {};
  $('#fLive').hidden = false; $('#fOut').hidden = true; $('#fDot').hidden = false;
  $('#fSub').textContent = `Through everything for sale in ${meta.countries[me.country].name}.`;
  location.hash = 'found';
  try {
    const out = await api('/api/wants', { method: 'POST', json: body });
    lastFound = out;
    await wait(400);
    buyForm.reset(); $$('#wCats button').forEach((b) => b.setAttribute('aria-checked', 'false')); checkBuy();
    showFound(out);
  } catch (err) {
    lastFound = null;
    location.hash = 'buy';
    $('#buyErr').textContent = err.message;
  }
};
function showFound(out) {
  $('#fLive').hidden = true; $('#fDot').hidden = true;
  const o = $('#fOut'); o.hidden = false;
  const n = out.found.length, w = out.want;
  const range = `${money(w.minPrice)} to ${money(w.maxPrice)}`;
  o.innerHTML = n
    ? `<h2>Found ${n === 1 ? 'one' : n} for you</h2><p class="sub" style="margin-top:6px">${esc(w.what)}, ${range}. Tap to buy.</p><ul class="grid" id="fGrid"></ul>
       <p class="fine" style="margin-top:22px">Not it? Leave your card up and new ones come to you.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`
    : `${dot('search', 'No matches yet', `${esc(w.what)}, ${range}`)}
       <p class="sub" style="margin-top:14px;text-align:center">Leave your card up and you'll see it in My stuff the moment someone posts one. Or delete it.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`;
  if (n) fillGrid($('#fGrid', o), out.found.map((f) => f.listing));
  $('[data-a="leave"]', o).onclick = () => { toast('Your card stays up. New matches show in My stuff.'); location.hash = 'home'; };
  $('[data-a="delete"]', o).onclick = async () => { await api(`/api/wants/${w.id}`, { method: 'DELETE' }).catch(() => {}); toast('Deleted.'); location.hash = 'home'; };
}

// ---------- browse ----------
function fillGrid(ul, items) {
  ul.innerHTML = '';
  items.forEach((l, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<a class="gcard" href="#item/${esc(l.id)}" style="animation-delay:${Math.min(i, 8) * 40}ms"><img alt="" loading="lazy" src="${esc(l.photo)}"><span class="glass"><b>${esc(l.title)}</b><span>${money(l.price, l.currency)}</span></span></a>`;
    ul.append(li);
  });
}
let browseCat = '', browseQ = '', browseItems = [];
function browseFilter() {
  const min = Number($('#fMin').value) || 0, max = Number($('#fMax').value) || Infinity;
  const words = browseQ.toLowerCase().split(/\s+/).filter(Boolean);
  const items = browseItems.filter((l) => l.price >= min && l.price <= max && words.every((w) => (l.title + ' ' + (l.category || '')).toLowerCase().includes(w)));
  fillGrid($('#grid'), items);
  $('#bCount').textContent = items.length ? items.length + ' for sale' : '';
  $('#bQ').hidden = !browseQ;
  $('#bQ').innerHTML = browseQ ? `Results for “${esc(browseQ)}” <button type="button" class="textbtn" id="bQx">Clear</button>` : '';
  $('#bQx')?.addEventListener('click', () => { browseQ = ''; $('#tq').value = ''; browseFilter(); });
  const e = $('#bEmpty');
  e.hidden = items.length > 0;
  e.innerHTML = dot('sleep', 'Nothing for sale yet', browseQ ? `Nothing matches “${esc(browseQ)}” in ${esc(meta.countries[me.country].name)} right now.` : `${browseCat ? 'Nothing in this category' : 'Nothing'} in ${esc(meta.countries[me.country].name)} right now. Homing only shows things in your country.`);
}
['#fMin', '#fMax'].forEach((id) => $(id).addEventListener('input', browseFilter));
// top bar search: "/" to jump in, Enter shows matches in Browse, Esc clears
$('#tsearch').addEventListener('submit', (e) => { e.preventDefault(); browseQ = $('#tq').value.trim(); if (location.hash === '#browse') openBrowse(); else location.hash = 'browse'; });
$('#tq').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#tq').value = ''; $('#tq').blur(); } });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !e.target.closest('input,textarea') && !$('#top').hidden) { e.preventDefault(); $('#tq').focus(); } });
async function openBrowse() {
  show('browse');
  if (!$('#grid').children.length || $('#grid').dataset.cat !== browseCat) $('#grid').innerHTML = '<li><span class="gcard sk"></span></li>'.repeat(6);
  $('#grid').dataset.cat = browseCat;
  browseItems = await api(`/api/listings?country=${me.country}&category=${encodeURIComponent(browseCat)}`).catch(() => []);
  browseFilter();
}

// ---------- item ----------
// on a phone the title moves into the top bar once it scrolls away, so you never lose what you look at
const ttlSeen = new IntersectionObserver(([e]) => document.body.classList.toggle('ttl-on', !e.isIntersecting && e.boundingClientRect.top < 60), { rootMargin: '-58px 0px 0px 0px' });
ttlSeen.observe($('#iTitle'));
async function openItem(lid) {
  let l;
  try { l = await api(`/api/listings/${lid}?userId=${me.id}`); }
  catch (err) { toast(err.message); location.hash = 'browse'; return; }
  $('#iImg').src = l.photo || ''; $('#iImg').style.viewTransitionName = 'photo';
  $('#iTitle').textContent = l.title; $('#topTtl').textContent = l.title;
  $('#iCat').textContent = l.category || '';
  $('#iPrice').textContent = money(l.price, l.currency);
  const st = $('#iState');
  st.hidden = l.status === 'open'; st.textContent = 'Sold';
  const s = l.seller;
  $('#iSeller').href = '#user/' + s.id;
  $('#iSeller').innerHTML = `<span class="av"></span><span class="who"><b>${esc(s.name)}</b><small>${s.stars ? STAR + ' ' + s.stars + ' · ' : ''}${s.sold} sold${s.reviews ? ' · ' + s.reviews + ' reviews' : ''}</small></span>${CHEV}`;
  avatar($('.av', $('#iSeller')), s.name, s.avatar);
  $('#iDesc').textContent = l.description;
  $('#iSeen').innerHTML = l.facts.length ? '<em>AI saw in the photo:</em>' + l.facts.map((f) => `<span>${esc(f)}</span>`).join('') : '';
  $('#iCountry').textContent = `Only for buyers in ${meta.countries[l.country].name}`;
  const box = $('#iBuy');
  box.innerHTML = '';
  $('#iBar').hidden = true;
  if (l.status === 'sold') {
    if (l.boughtByMe) { box.innerHTML = '<div class="track"></div><div class="rate"></div>'; trackView($('.track', box), l.track, l.id, 'buyer'); rateForm($('.rate', box), l, 'buyer', s.name); }
    else if (l.mine) { box.innerHTML = `<p class="note">Sold to ${esc(l.buyer.name)}.</p><div class="track"></div><div class="rate"></div>`; trackView($('.track', box), l.track, l.id, 'seller'); rateForm($('.rate', box), l, 'seller', l.buyer.name); }
    else box.innerHTML = '<p class="note">Someone was faster. This is sold.</p>';
  } else if (l.mine) {
    box.innerHTML = '<p class="note">This is yours. It is up for sale.</p><button class="secondary danger">Delete</button>';
    $('button', box).onclick = async () => { await api(`/api/listings/${l.id}`, { method: 'DELETE' }); toast('Deleted.'); location.hash = 'me'; };
  } else {
    $('#iBar').hidden = false; $('#iBarP').textContent = money(l.price, l.currency);
    $('#iBarBtn').onclick = () => openSheet();
    const sb = $('#sheetBody');
    sb.innerHTML = `<div class="sh-item"><img src="${esc(l.photo)}" alt=""><div><b>${esc(l.title)}</b><span>${money(l.price, l.currency)} · from ${esc(s.name)}</span></div></div><label class="check"><input type="checkbox" id="readIt"><span><b>I read the description</b><small>Buying is instant. What it says is what you get.</small></span></label>
      <button class="pp" id="payPP" disabled>${PP}</button>${meta.sandbox ? '<button class="card-pay" id="payCard" disabled>Sandbox: pay with PayPal test card</button>' : ''}<p class="err" id="payErr"></p>`;
    $('.amt', sb).textContent = money(l.price, l.currency);
    $('#readIt').onchange = (e) => { $('#payPP').disabled = !e.target.checked; if ($('#payCard')) $('#payCard').disabled = !e.target.checked; };
    const pay = async (method) => {
      $('#payErr').textContent = '';
      $('#payPP').disabled = true; if ($('#payCard')) $('#payCard').disabled = true;
      try {
        const out = await api(`/api/listings/${l.id}/pay`, { method: 'POST', json: { readDescription: $('#readIt').checked, method } });
        if (out.payUrl) location.href = out.payUrl;
        else location.hash = 'paid/' + l.id;
      } catch (err) { $('#payErr').textContent = err.message; $('#payPP').disabled = false; if ($('#payCard')) $('#payCard').disabled = false; }
    };
    $('#payPP').onclick = () => pay('paypal');
    if ($('#payCard')) $('#payCard').onclick = () => pay('card');
  }
  show('item');
}

// ---------- paid + reviews ----------
async function openPaid(lid) {
  const l = await api(`/api/listings/${lid}?userId=${me.id}`).catch(() => null);
  if (!l || !l.boughtByMe) { location.hash = 'home'; return; }
  $('#paidSub').textContent = `Paid with PayPal to ${l.seller.name}.`;
  countUp($('#paidAmt'), l.price, l.currency);
  haptic('success');
  $('#paidImg').src = l.photo; $('#paidTitle').textContent = l.title; $('#paidPrice').textContent = 'From ' + l.seller.name;
  rateForm($('#paidRate'), l, 'buyer', l.seller.name);
  show('paid');
}
// side = which side I am on this deal; I rate the other person.
function rateForm(box, l, side, other) {
  const done = l.reviews?.[side];
  if (done) { box.innerHTML = `<b>You gave ${esc(other)} ${done.stars} ${done.stars === 1 ? 'star' : 'stars'}.</b>${done.text ? `<p class="sub">“${esc(done.text)}”</p>` : ''}`; return; }
  box.innerHTML = `<b>How was ${esc(other)}?</b><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} stars">${STAR.replace('class="star"', '')}</button>`).join('')}</div>
    <textarea maxlength="600" rows="3" placeholder="Say how it went. Was it like the photo? Fast? Friendly?"></textarea><button class="primary" disabled>Send review</button><p class="fine">Only the buyer and the seller of a deal can review it. No fake reviews.</p>`;
  let stars = 0;
  $$('.stars button', box).forEach((b) => (b.onclick = () => { stars = +b.dataset.n; $$('.stars button', box).forEach((x) => x.classList.toggle('on', +x.dataset.n <= stars)); $('.primary', box).disabled = false; }));
  $('.primary', box).onclick = async () => {
    try {
      const nl = await api(`/api/listings/${l.id}/review`, { method: 'POST', json: { stars, text: $('textarea', box).value } });
      rateForm(box, nl, side, other);
      toast('Thanks. It counts on the leaderboard.');
      refreshBadge();
    } catch (err) { toast(err.message); }
  };
}

// ---------- my stuff ----------
const SEARCH = '<span class="ph"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></span>';
async function openMe() {
  const d = await api('/api/me').catch(() => null);
  if (!d) return;
  avatar($('#mAv'), d.user.name, d.user.avatar);
  if (d.user.avatar !== me.avatar) { me.avatar = d.user.avatar; localStorage.setItem('homing.user', JSON.stringify(me)); setupForUser(); }
  $('#mName').textContent = d.user.name;
  $('#mStats').innerHTML = `${esc(meta.countries[d.user.country].name)} · ${d.user.sold} sold · ${d.user.bought} bought${d.user.stars ? ` · ${STAR} ${d.user.stars}` : ''}`;
  $('#mSell').innerHTML = d.mine.length ? d.mine.map((l) => `<li><a href="#item/${l.id}"><img src="${esc(l.photo)}" alt=""></a><a class="t" href="#item/${l.id}"><b>${esc(l.title)}</b><small>${money(l.price, l.currency)}${l.status === 'sold' ? ' · sold to ' + esc(l.buyer.name) : ''}</small></a>
    <span class="act">${l.status === 'sold' ? (l.track && l.track.status !== 'paid' ? `<a class="tag ${l.track.delivered ? 'ok' : 'blue'}" href="#ship/${l.id}">${esc(l.track.say)}</a>` : `<a class="tag blue" href="#ship/${l.id}">Ship it</a>`) : `<span class="tag">For sale</span><button class="danger" data-del="${l.id}">Delete</button>`}</span></li>`).join('')
    : '<li class="none"><img class="dotmini" src="/img/dot-sleep.webp" alt="">Nothing yet. <a href="#sell"><u>Sell something</u></a></li>';
  $('#mLook').innerHTML = d.looking.length ? d.looking.map((w) => `<li>${SEARCH}<span class="t"><b>${esc(w.what)}</b><small>${money(w.minPrice)} to ${money(w.maxPrice)} · ${esc(w.category)}</small>${w.found.length ? `<span class="found">${w.found.map((f) => `<a href="#item/${f.listing.id}"><img src="${esc(f.listing.photo)}" alt="${esc(f.listing.title)}"></a>`).join('')}</span>` : ''}</span>
    <span class="act">${w.found.length ? `<span class="tag blue">${w.found.length} found</span>` : '<span class="tag">Looking</span>'}<button class="danger" data-delw="${w.id}">Delete</button></span></li>`).join('')
    : '<li class="none"><img class="dotmini" src="/img/dot-search.webp" alt="">Nothing yet. <a href="#buy"><u>Say what you want</u></a></li>';
  $('#mBought').innerHTML = d.bought.length ? d.bought.map((l) => `<li><a href="#item/${l.id}"><img src="${esc(l.photo)}" alt=""></a><a class="t" href="#item/${l.id}"><b>${esc(l.title)}</b><small>${money(l.price, l.currency)} · from ${esc(l.seller.name)}${l.track ? ` · ${esc(l.track.say)}` : ''}</small></a>
    <span class="act">${l.reviews?.buyer ? '<span class="tag ok">Done</span>' : `<a class="tag blue" href="#item/${l.id}">Rate ${esc(l.seller.name)}</a>`}</span></li>`).join('')
    : '<li class="none"><img class="dotmini" src="/img/dot-hello.webp" alt="">Nothing yet.</li>';
  $$('[data-del]').forEach((b) => (b.onclick = async () => { await api(`/api/listings/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted.'); openMe(); }));
  $$('[data-delw]').forEach((b) => (b.onclick = async () => { await api(`/api/wants/${b.dataset.delw}`, { method: 'DELETE' }); toast('Deleted.'); openMe(); }));
  show('me');
}

// ---------- leaderboard ----------
let boardBy = 'sellers';
$$('.seg button').forEach((b) => (b.onclick = () => { boardBy = b.dataset.by; $$('.seg button').forEach((x) => x.classList.toggle('on', x === b)); $('#seg').classList.toggle('right', boardBy === 'buyers'); openBoard(); }));
async function openBoard() {
  show('board');
  let rows = await api(`/api/leaderboard?country=${me.country}&by=${boardBy}`).catch(() => []);
  const key = boardBy === 'sellers' ? 'sold' : 'bought';
  const top = rows.length >= 3 ? rows.slice(0, 3) : [];
  $('#podium').innerHTML = top.length ? [1, 0, 2].map((i) => { const u = top[i]; return `<a class="pod p${i + 1}" href="#user/${u.id}">${av(u.name, i ? 'lg' : 'xl', u.avatar)}<span class="medal">${i + 1}</span><b>${esc(u.name)}</b><small>${u[key]} ${key}</small><span class="ps">${u.stars ? STAR + u.stars.toFixed(1) : ''}</span></a>`; }).join('') : '';
  $('#rBody').innerHTML = rows.map((u, i) => `<tr class="${u.id === me.id ? 'you' : ''}"><td class="n">${i + 1}</td><td><a href="#user/${u.id}">${av(u.name, '', u.avatar)}<b>${esc(u.name)}</b></a></td><td>${u.sold}</td><td>${u.bought}</td><td class="s">${u.stars ? STAR + u.stars.toFixed(1) : '<small>No reviews</small>'}</td><td><a href="#user/${u.id}" aria-label="Open ${esc(u.name)}">${CHEV}</a></td></tr>`).join('')
    || `<tr><td colspan="6">${dot('hello', 'No deals yet', 'The first deal in your country puts you on top.', 'sm')}</td></tr>`;
  rows = rows.slice(top.length);
  $('#rank').innerHTML = rows.length ? rows.map((u, i) => `<li class="${u.id === me.id ? 'you' : ''}" style="animation-delay:${i * 35}ms"><a href="#user/${u.id}"><span class="n">${i + 1 + top.length}</span>${av(u.name, '', u.avatar)}
    <span class="t"><b>${esc(u.name)}</b><small>${u.sold} sold · ${u.bought} bought</small></span>
    <span class="s">${u.stars ? STAR + u.stars.toFixed(1) : '<small>No reviews</small>'}</span>${CHEV}</a></li>`).join('')
    : `<li style="display:block;border:0">${dot('hello', 'No deals yet', 'The first deal in your country puts you on top.')}</li>`;
}

// ---------- start ----------
(async () => {
  meta = await api('/api/meta');
  if (!me) api('/api/listings?country=DE').then((l) => window.shelf?.('shelfIn', l)).catch(() => {});
  chips($('#sCats'), { onPick: checkSell });
  chips($('#wCats'), { onPick: () => { checkBuy(); buyPreview(); } });
  chips($('#bCats'), { all: true, onPick: (c) => { browseCat = c; openBrowse(); } });
  // back from PayPal
  const q = new URLSearchParams(location.search);
  if (q.has('paid') || q.has('item')) {
    const h = q.has('paid') ? 'paid/' + q.get('paid') : 'item/' + q.get('item');
    if (q.get('late')) setTimeout(() => toast('Someone was faster. You were not charged.'), 300);
    if (q.get('error')) setTimeout(() => toast(q.get('error')), 300);
    history.replaceState(null, '', '/#' + h);
  } else if (q.has('error')) { const m = q.get('error'); setTimeout(() => { $('#signinErr').textContent = m; toast(m); }, 300); history.replaceState(null, '', '/' + location.hash); }
  if (me && !meta.countries[me.country]) me = null;
  if (me) {
    try { me = await api('/api/whoami'); localStorage.setItem('homing.user', JSON.stringify(me)); }
    catch { me = null; }
  }
  if (me) setupForUser();
  route();
})();

// ---------- a person ----------
async function openUser(uid) {
  let u;
  try { u = await api('/api/users/' + uid); } catch { location.hash = 'board'; return; }
  avatar($('#uAv'), u.name, u.avatar);
  $('#uName').textContent = u.name + (u.id === me.id ? ' (you)' : '');
  $('#uMeta').textContent = `${meta.countries[u.country].name} · on Homing since ${new Date(u.since).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
  $('#uSold').textContent = u.sold; $('#uBought').textContent = u.bought;
  $('#uStars').innerHTML = u.stars ? STAR + u.stars.toFixed(1) : '–';
  $('#uStarsL').textContent = u.reviews ? `${u.reviews} ${u.reviews === 1 ? 'review' : 'reviews'}` : 'No reviews yet';
  $('#uSale').hidden = !u.forSale.length;
  fillGrid($('#uGrid'), u.forSale);
  const stars = (n) => [1, 2, 3, 4, 5].map((k) => STAR.replace('class="star"', k <= n ? '' : 'class="off"')).join('');
  $('#uRevs').innerHTML = u.feed.length ? u.feed.map((r) => `<li><div class="r-top">${av(r.from, '', r.fromAvatar)}<b>${esc(r.from)}</b><span class="r-stars">${stars(r.stars)}</span><time>${ago(r.at)}</time></div>
    ${r.text ? `<p>${esc(r.text)}</p>` : ''}<span class="deal">${r.role === 'bought' ? esc(r.from) + ' bought' : esc(u.name) + ' bought'} ${esc(r.item)} · ${money(r.price, r.currency)} via PayPal</span>${r.reply ? `<div class="reply"><b>${esc(u.name)} answered</b><p>${esc(r.reply.text)}</p></div>` : u.id === me.id ? `<button class="answer" type="button" data-l="${esc(r.listingId)}">Answer</button>` : ''}</li>`).join('')
    : `<li style="border:0">${dot('sleep', 'No reviews yet', 'Reviews only come from real, paid deals.', 'sm')}</li>`;
  $$('.answer', $('#uRevs')).forEach((b) => (b.onclick = () => {
    const f = document.createElement('div'); f.className = 'reply-form';
    f.innerHTML = '<textarea maxlength="600" rows="2" placeholder="Your answer"></textarea><button class="primary" type="button">Send answer</button>';
    b.replaceWith(f); $('textarea', f).focus();
    $('.primary', f).onclick = async () => {
      try { await api(`/api/listings/${b.dataset.l}/review/reply`, { method: 'POST', json: { text: $('textarea', f).value } }); toast('Answer posted.'); openUser(uid); }
      catch (err) { toast(err.message); }
    };
  }));
  show('user');
}

// ---------- buy sheet ----------
// "Buy now" grows into the sheet (a shared view transition), and shrinks back into the button
const canMorph = () => !!document.startViewTransition && !REDUCE;
function openSheet() {
  haptic('medium');
  const sh = $('#sheet'), panel = $('.sheet-panel', sh), btn = $('#iBarBtn');
  if (!canMorph()) { sh.hidden = false; document.body.classList.add('locked'); requestAnimationFrame(() => sh.classList.add('open')); return; }
  btn.style.viewTransitionName = 'buy'; document.documentElement.dataset.dir = 'sheet';
  const t = document.startViewTransition(() => { btn.style.viewTransitionName = ''; panel.style.viewTransitionName = 'buy'; sh.classList.add('instant'); sh.hidden = false; sh.classList.add('open'); document.body.classList.add('locked'); });
  t.ready.catch(() => {}); t.finished.catch(() => {}).finally(() => { panel.style.viewTransitionName = ''; sh.classList.remove('instant'); });
}
function closeSheet() {
  const sh = $('#sheet'), panel = $('.sheet-panel', sh), btn = $('#iBarBtn');
  if (!canMorph() || !btn.offsetParent) { sh.classList.remove('open'); document.body.classList.remove('locked'); setTimeout(() => (sh.hidden = true), 280); return; }
  panel.style.viewTransitionName = 'buy'; document.documentElement.dataset.dir = 'sheet';
  const t = document.startViewTransition(() => { panel.style.viewTransitionName = ''; btn.style.viewTransitionName = 'buy'; sh.classList.add('instant'); sh.classList.remove('open'); sh.hidden = true; document.body.classList.remove('locked'); });
  t.ready.catch(() => {}); t.finished.catch(() => {}).finally(() => { btn.style.viewTransitionName = ''; sh.classList.remove('instant'); });
}
$('#sheetBg').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// ---------- sold: the seller hears it right away ----------
let seenSold = new Set(), seenKey = '';
const saveSeen = () => { try { localStorage.setItem(seenKey, JSON.stringify([...seenSold])); } catch {} };
let soldFirst = true;
async function watchSales() {
  if (!me) return;
  if (seenKey !== 'homing.seen.' + me.id) { seenKey = 'homing.seen.' + me.id; soldFirst = true; try { seenSold = new Set(JSON.parse(localStorage.getItem(seenKey) || 'null') || []); } catch { seenSold = new Set(); } }
  const d = await api('/api/me').catch(() => null); if (!d) return;
  const sold = d.mine.filter((l) => l.status === 'sold');
  // the first look only remembers what is already sold; after that every new sale rings
  if (soldFirst && !localStorage.getItem(seenKey)) { sold.forEach((l) => seenSold.add(l.id)); saveSeen(); }
  soldFirst = false;
  const fresh = sold.find((l) => !seenSold.has(l.id));
  if (!fresh) return;
  seenSold.add(fresh.id); saveSeen();
  if (location.hash === '#posted') return; // the posted screen already shows it
  const a = $('#alert');
  a.href = '#ship/' + fresh.id; $('#alImg').src = fresh.photo;
  $('#alHead').textContent = `Sold! ${fresh.title}`;
  $('#alSub').textContent = `${fresh.buyer.name} paid ${money(fresh.price, fresh.currency)} with PayPal`;
  a.hidden = false; requestAnimationFrame(() => a.classList.add('in'));
  haptic('success');
  clearTimeout(a._t); a._t = setTimeout(hideAlert, 12000);
  if ('Notification' in window && Notification.permission === 'granted') try { new Notification('Sold! ' + fresh.title, { body: `${fresh.buyer.name} paid with PayPal. Ship it.`, icon: fresh.photo }); } catch {}
}
function hideAlert() { const a = $('#alert'); a.classList.remove('in'); setTimeout(() => (a.hidden = true), 350); }
$('#alert').addEventListener('click', hideAlert);
setInterval(watchSales, 6000); setTimeout(watchSales, 1500);

// ---------- ship it ----------
const CARRIER_LIST = [['DHL', 'DHL'], ['DEUTSCHE_DE', 'Deutsche Post'], ['HERMES', 'Hermes'], ['DPD', 'DPD'], ['GLS', 'GLS'], ['UPS', 'UPS']];
async function openShip(lid) {
  let d;
  try { d = await api(`/api/listings/${lid}/ship`); } catch (e) { toast(e.message); location.hash = 'me'; return; }
  seenSold.add(lid); saveSeen();
  const sh = d.ship || {};
  $('#shKick').textContent = `Paid ${ago(d.paidAt)} · ${money(d.item.price, d.item.currency)} is in your PayPal`;
  $('#shImg').src = d.item.photo; $('#shTitle').textContent = d.item.title; $('#shPaid').textContent = `to ${d.buyer.name}`;
  $('#shQr').innerHTML = d.qr; $('#shCode').textContent = sh.code || ''; $('#shLabel').href = d.labelUrl;
  const lines = [sh.name, sh.line1, sh.line2, [sh.zip, sh.city].filter(Boolean).join(' '), meta.countries[sh.country]?.name].filter((x) => x && String(x).trim());
  $('#shTo').innerHTML = `<address>${lines.map(esc).join('<br>')}</address><button class="copy" type="button">Copy</button><small>From the buyer's PayPal</small>`;
  $('.copy', $('#shTo')).onclick = async (e) => { try { await navigator.clipboard.writeText(lines.join('\n')); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; } };
  const n = sh.notes;
  $('#shNotes').innerHTML = n ? `<p class="box">${esc(n.box)}</p><ol>${n.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="sub">Writing packing notes…</p>';
  if (!n) setTimeout(() => location.hash === '#ship/' + lid && api(`/api/listings/${lid}/ship`).then((x) => x.ship?.notes && openShipNotes(x.ship.notes)).catch(() => {}), 3000);
  trackView($('#shTrack'), d.track, lid, 'seller');
  loadPosts();
  show('ship');
}
function openShipNotes(n) { $('#shNotes').innerHTML = `<p class="box">${esc(n.box)}</p><ol>${n.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`; }
function drawTrack(lid, t) {
  const box = $('#shTrack');
  if (t) { box.innerHTML = `<div class="tracked">${TICK_S}<span><b>${esc(t.carrierName)} · ${esc(t.number)}</b><small>${t.inPayPal ? 'Added to the payment in PayPal. The buyer sees it there.' : 'Saved. The buyer sees it in Homing.'}</small></span></div>`; return; }
  box.innerHTML = `<div class="chips" id="shCar" role="radiogroup">${CARRIER_LIST.map(([v, n]) => `<button type="button" role="radio" aria-checked="false" data-v="${v}">${n}</button>`).join('')}</div>
    <div class="trackrow"><input id="shNum" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="send" placeholder="Tracking number"><button class="primary" id="shSend" type="button" disabled>Add</button></div>
    <p class="err" id="shErr"></p>`;
  const ok = () => ($('#shSend').disabled = !(picked($('#shCar')) && $('#shNum').value.trim().length >= 6));
  $$('#shCar button').forEach((b) => (b.onclick = () => { $$('#shCar button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); ok(); }));
  $('#shNum').oninput = ok;
  $('#shNum').onkeydown = (e) => { if (e.key === 'Enter' && !$('#shSend').disabled) $('#shSend').click(); };
  $('#shSend').onclick = async () => {
    $('#shSend').disabled = true; $('#shSend').textContent = '…';
    try { drawTrack(lid, await api(`/api/listings/${lid}/track`, { method: 'POST', json: { carrier: picked($('#shCar')), number: $('#shNum').value } })); haptic('success'); }
    catch (e) { $('#shErr').textContent = e.message; $('#shSend').textContent = 'Add'; ok(); }
  };
}
const TICK_S = '<svg class="tk" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>';
async function loadPosts(at) {
  const ul = $('#shPosts');
  ul.innerHTML = '<li class="sk"></li><li class="sk"></li>';
  try {
    const r = await api('/api/post-offices' + (at ? `?lat=${at.lat}&lon=${at.lon}` : ''));
    ul.innerHTML = r.near.length ? r.near.map((p) => `<li><a href="https://www.openstreetmap.org/directions?to=${p.lat}%2C${p.lon}" target="_blank" rel="noopener"><span class="km">${p.km < 1 ? Math.round(p.km * 1000) + ' m' : p.km + ' km'}</span><span class="t"><b>${esc(p.name)}</b><small>${esc([p.street, p.city].filter(Boolean).join(', '))}${p.hours ? ' · ' + esc(p.hours) : ''}</small></span>${CHEV}</a></li>`).join('')
      : '<li class="none">No post office found nearby.</li>';
    ul.insertAdjacentHTML('beforeend', `<li class="note">Near ${r.from === 'you' ? 'where you are now' : 'your PayPal address'}${!at && navigator.geolocation && isSecureContext ? ' · <button class="textbtn" id="shHere" type="button">Use where I am</button>' : ''} · map data © OpenStreetMap</li>`);
    $('#shHere')?.addEventListener('click', () => navigator.geolocation.getCurrentPosition((g) => loadPosts({ lat: g.coords.latitude, lon: g.coords.longitude }), () => toast('Location is off.')));
  } catch (e) { ul.innerHTML = `<li class="none">${esc(e.message)} <button class="textbtn" id="shRetry" type="button">Try again</button></li>`; $('#shRetry').onclick = () => loadPosts(at); }
}

// ---------- feel: touch, typing, selecting ----------
// every press gets a light tick (chips tick on click); screen changes get a medium one in the router
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && e.target.closest('button:not(.chips button)')) haptic('light'); }, { passive: true });
document.addEventListener('touchstart', () => {}, { passive: true }); // lets :active (the press squash) work on iOS
// Enter jumps to the next field; the field you type in is never under the keyboard
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.key !== 'Enter' || !t.matches('input:not([type=checkbox]):not(#shNum)')) return;
  const form = t.closest('form'); if (!form) return;
  const f = [...form.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]),textarea')].filter((x) => !x.disabled && x.offsetParent);
  const nx = f[f.indexOf(t) + 1];
  if (nx) { e.preventDefault(); nx.focus(); }
});
document.addEventListener('focusin', (e) => { if (e.target.matches('input,textarea') && matchMedia('(pointer:coarse)').matches) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 280); });

// ---------- profile picture ----------
$('#mAvIn')?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  if (!f) return;
  const fd = new FormData(); fd.append('photo', f);
  try {
    const u = await api('/api/me/avatar', { method: 'POST', body: fd });
    me.avatar = u.avatar; localStorage.setItem('homing.user', JSON.stringify(me));
    setupForUser(); avatar($('#mAv'), me.name, me.avatar); haptic?.('success'); toast('New photo saved.');
  } catch (err) { toast(err.message); }
});

// ---------- parcel tracking: updates by itself, nobody types a number ----------
const dayWord = (t) => { const d = new Date(t), n = new Date(); const k = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((k(d) - k(n)) / 86400000); return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }); };
const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
let trackTimer = 0;
function trackView(box, t, lid, side) {
  clearTimeout(trackTimer);
  if (!box) return;
  if (!t) { box.innerHTML = ''; return; }
  const idx = t.steps.reduce((a, x, i) => (x.at ? i : a), 0);
  const pct = (idx / (t.steps.length - 1)) * 100;
  const when = t.delivered ? `Delivered ${dayWord(t.eta)} at ${hm(t.eta)}` : `Arrives ${dayWord(t.eta)}`;
  box.innerHTML = `<div class="trk-top"><b>${esc(t.say)}</b><span>${esc(when)}</span></div>
    <div class="trk-line" style="--p:${pct}%"><i></i>${t.steps.map((x, i) => `<span class="st${x.at ? ' on' : ''}${i === idx ? ' now' : ''}"><em></em><small>${esc(x.label)}</small></span>`).join('')}</div>
    <ul class="trk-ev">${t.events.map((e) => `<li><time>${esc(dayWord(e.at))}, ${hm(e.at)}</time><b>${esc(e.label)}</b>${e.where ? `<small>${esc(e.where)}</small>` : ''}</li>`).join('')}</ul>
    <p class="trk-meta">${esc(t.carrier)} ${esc(t.number)}${t.inPayPal ? ' · also in your PayPal' : ''}${t.sandbox ? ' · <span class="sbx">Sandbox test parcel</span>' : ''}${side === 'seller' && t.status === 'paid' ? '<br>Open the label to print it. Tracking starts by itself.' : ''}</p>`;
  // keep it live while this page is open
  if (!t.delivered) {
    const here = location.hash;
    trackTimer = setTimeout(async () => {
      if (location.hash !== here || !box.isConnected) return;
      try { const l = await api(`/api/listings/${lid}?userId=${me.id}`); if (l.track && l.track.status !== t.status) haptic('light'); trackView(box, l.track, lid, side); } catch {}
    }, 15000);
  }
}
