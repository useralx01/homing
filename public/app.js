// Homing: sign in, then Sell / Buy / Browse. Plain hash routes so the phone's back button works.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STAR = '<svg class="star" viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
const PP = '<span>Pay <b class="amt"></b> with</span><b style="font-style:italic;font-weight:800;color:#003087">Pay</b><b style="font-style:italic;font-weight:800;color:#0070e0;margin-left:-8px">Pal</b>';

let me = null, meta = null;
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
const avatar = (el, name) => { el.textContent = (name || '?').trim()[0].toUpperCase(); el.style.setProperty('--h', hue(name)); };
const av = (name, cls = '') => `<span class="av ${cls}" style="--h:${hue(name)}">${esc((name || '?').trim()[0].toUpperCase())}</span>`;
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
  window.scrollTo(0, 0);
};
let depth = 0;
window.addEventListener('hashchange', () => { depth++; route(); });
$('#back').onclick = () => (depth > 0 ? history.back() : (location.hash = 'home'));

async function route() {
  if (!me) return show('signin');
  const [name, arg] = location.hash.slice(1).split('/');
  stopWaiting();
  refreshBadge();
  switch (name) {
    case 'sell': return show('sell');
    case 'posted': return pending ? show('posted') : (location.hash = 'sell');
    case 'buy': return openBuy();
    case 'found': return lastFound ? show('found') : (location.hash = 'buy');
    case 'browse': return openBrowse();
    case 'item': return openItem(arg);
    case 'paid': return openPaid(arg);
    case 'me': return openMe();
    case 'board': return openBoard();
    case 'user': return openUser(arg);
    default: return openHome();
  }
}

// ---------- sign in ----------
$('#signinForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#signinErr').textContent = '';
  try {
    me = await api('/api/signin', { method: 'POST', json: Object.fromEntries(new FormData(e.target)) });
    localStorage.setItem('homing.user', JSON.stringify(me));
    setupForUser();
    location.hash = 'home'; route();
  } catch (err) { $('#signinErr').textContent = err.message; }
};
$('#signout').onclick = () => { localStorage.removeItem('homing.user'); me = null; location.hash = ''; show('signin'); };

function setupForUser() {
  avatar($('#meAv'), me.name);
  avatar($('#wAv'), me.name);
  $('#wName').textContent = me.name;
  const cn = meta.countries[me.country].name;
  $('#wCountry').textContent = cn + ' only';
  $('#bCountry').textContent = cn + ' only';
  $$('.cur').forEach((c) => { c.textContent = sym(); c.nextElementSibling.style.paddingLeft = 18 + sym().length * 11 + 'px'; });
}

// ---------- home ----------
function openHome() {
  $('#hello').textContent = `Hi ${me.name}.`;
  api(`/api/pulse?country=${me.country}`).then((p) => { $('#pulseTxt').innerHTML = `<b>${p.forSale}</b> for sale · <b>${p.looking}</b> people looking in ${esc(meta.countries[me.country].name)}`; $('#pulse').hidden = false; }).catch(() => {});
  show('home');
}
async function refreshBadge() {
  if (!me) return;
  try {
    const d = await api('/api/me');
    const n = todo(d);
    $('#homeCount').hidden = !n; $('#homeCount').textContent = n;
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
  checkSell();
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

let pending = null, waitT = null, pollT = null;
function stopWaiting() {
  if (location.hash.startsWith('#posted')) return;
  clearInterval(waitT); clearInterval(pollT); waitT = pollT = null;
}
sellForm.onsubmit = async (e) => {
  e.preventDefault();
  if ($('#post').disabled) return;
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
  location.hash = 'posted';
  const step = setTimeout(() => { $('#pHead').textContent = 'Finding buyers'; $('#pSub').textContent = `Everyone in ${meta.countries[me.country].name} looking for this.`; }, 1700);
  try {
    const out = await api('/api/sell', { method: 'POST', body: fd });
    clearTimeout(step);
    pending.id = out.listing.id;
    resetSell();
    if (out.sentTo.length) waitForBuyer(out);
    else noBuyer(out.listing.id, 'Nobody is looking for this right now.');
  } catch (err) {
    clearTimeout(step);
    pending = null;
    location.hash = 'sell';
    $('#sellErr').textContent = err.message;
  }
};
function resetSell() {
  sellForm.reset(); shotFile = null;
  $('#shot').classList.remove('has'); $('#shotImg').removeAttribute('src');
  $$('#sCats button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  checkSell();
}
const WAIT_S = 45;
function waitForBuyer(out) {
  const live = $('#pLive'), who = out.sentTo.map((s) => s.name);
  $('.ring', live).className = 'ring';
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
  $('#pSub').textContent = `${money(l.price, l.currency)} paid with PayPal.`;
  const o = $('#pOutcome');
  o.hidden = false;
  o.innerHTML = '<div class="rate"></div><a class="secondary" href="#home" style="margin-top:18px">Done</a>';
  rateForm($('.rate', o), l, 'seller', l.buyer.name);
}
function noBuyer(lid, why) {
  const live = $('#pLive');
  live.className = 'live miss'; $('.ring', live).className = 'ring';
  $('#pHead').textContent = 'No buyer yet';
  $('#pSub').textContent = why;
  const o = $('#pOutcome');
  o.hidden = false;
  o.innerHTML = `<p class="sub">Leave it up and anyone in ${esc(meta.countries[me.country].name)} can find it, or take it down.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`;
  $('[data-a="leave"]', o).onclick = () => { pending = null; toast('It stays up. People can find it in Browse.'); location.hash = 'home'; };
  $('[data-a="delete"]', o).onclick = async () => { await api(`/api/listings/${lid}`, { method: 'DELETE' }).catch(() => {}); pending = null; toast('Deleted.'); location.hash = 'home'; };
}

// ---------- buy ----------
const buyForm = $('#buyForm');
function openBuy() { show('buy'); }
function checkBuy() {
  const max = Number($('#wMax').value), min = Number($('#wMin').value) || 0;
  $('#find').disabled = !($('#wWhat').value.trim().length >= 3 && picked($('#wCats')) && max >= 1 && max >= min);
}
buyForm.addEventListener('input', checkBuy);
let lastFound = null;
buyForm.onsubmit = async (e) => {
  e.preventDefault();
  if ($('#find').disabled) return;
  $('#buyErr').textContent = '';
  const body = { what: $('#wWhat').value.trim(), category: picked($('#wCats')), minPrice: $('#wMin').value || 0, maxPrice: $('#wMax').value };
  lastFound = {};
  $('#fLive').hidden = false; $('#fOut').hidden = true;
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
  $('#fLive').hidden = true;
  const o = $('#fOut'); o.hidden = false;
  const n = out.found.length, w = out.want;
  const range = `${money(w.minPrice)} to ${money(w.maxPrice)}`;
  o.innerHTML = n
    ? `<h2>Found ${n === 1 ? 'one' : n} for you</h2><p class="sub" style="margin-top:6px">${esc(w.what)}, ${range}. Tap to buy.</p><ul class="grid" id="fGrid"></ul>
       <p class="fine" style="margin-top:22px">Not it? Leave your card up and new ones come to you.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`
    : `<div class="live miss" style="margin-top:0"><div class="ring"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21"/><circle class="arc" cx="24" cy="24" r="21"/></svg></div><div><b>Nothing yet</b><span>${esc(w.what)}, ${range}</span></div></div>
       <p class="sub" style="margin-top:18px">Leave your card up and you'll see it in My stuff the moment someone posts one. Or delete it.</p><div class="pair"><button class="secondary" data-a="leave">Leave it</button><button class="secondary danger" data-a="delete">Delete</button></div>`;
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
let browseCat = '';
async function openBrowse() {
  show('browse');
  if (!$('#grid').children.length || $('#grid').dataset.cat !== browseCat) $('#grid').innerHTML = '<li><span class="gcard sk"></span></li>'.repeat(6);
  $('#grid').dataset.cat = browseCat;
  const items = await api(`/api/listings?country=${me.country}&category=${encodeURIComponent(browseCat)}`).catch(() => []);
  fillGrid($('#grid'), items);
  $('#bCount').textContent = items.length ? items.length + ' for sale' : '';
  const e = $('#bEmpty');
  e.hidden = items.length > 0;
  e.innerHTML = `<b>Nothing here yet</b>${browseCat ? 'Nothing in this category' : 'Nothing for sale'} in ${esc(meta.countries[me.country].name)} right now. Homing only shows things in your country.`;
}

// ---------- item ----------
async function openItem(lid) {
  let l;
  try { l = await api(`/api/listings/${lid}?userId=${me.id}`); }
  catch (err) { toast(err.message); location.hash = 'browse'; return; }
  $('#iImg').src = l.photo || '';
  $('#iTitle').textContent = l.title;
  $('#iPrice').textContent = money(l.price, l.currency);
  const st = $('#iState');
  st.hidden = l.status === 'open'; st.textContent = 'Sold';
  const s = l.seller;
  $('#iSeller').href = '#user/' + s.id;
  $('#iSeller').innerHTML = `<span class="av"></span><span class="who"><b>${esc(s.name)}</b><small>${s.stars ? STAR + ' ' + s.stars + ' · ' : ''}${s.sold} sold${s.reviews ? ' · ' + s.reviews + ' reviews' : ''}</small></span>${CHEV}`;
  avatar($('.av', $('#iSeller')), s.name);
  $('#iDesc').textContent = l.description;
  $('#iSeen').innerHTML = l.facts.length ? '<em>AI saw in the photo:</em>' + l.facts.map((f) => `<span>${esc(f)}</span>`).join('') : '';
  $('#iCountry').textContent = `Only for buyers in ${meta.countries[l.country].name}. Ships or hands over inside the country.`;
  const box = $('#iBuy');
  box.innerHTML = '';
  $('#iBar').hidden = true;
  if (l.status === 'sold') {
    if (l.boughtByMe) { box.innerHTML = '<p class="note">You bought this.</p><div class="rate"></div>'; rateForm($('.rate', box), l, 'buyer', s.name); }
    else if (l.mine) { box.innerHTML = `<p class="note">Sold to ${esc(l.buyer.name)}.</p><div class="rate"></div>`; rateForm($('.rate', box), l, 'seller', l.buyer.name); }
    else box.innerHTML = '<p class="note">Someone was faster. This is sold.</p>';
  } else if (l.mine) {
    box.innerHTML = '<p class="note">This is yours. It is up for sale.</p><button class="secondary danger">Delete</button>';
    $('button', box).onclick = async () => { await api(`/api/listings/${l.id}`, { method: 'DELETE' }); toast('Deleted.'); location.hash = 'me'; };
  } else {
    $('#iBar').hidden = false; $('#iBarT').textContent = l.title; $('#iBarP').textContent = money(l.price, l.currency);
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
  $('#paidSub').textContent = `${money(l.price, l.currency)} paid with PayPal to ${l.seller.name}.`;
  $('#paidImg').src = l.photo; $('#paidTitle').textContent = l.title; $('#paidPrice').textContent = 'From ' + l.seller.name;
  rateForm($('#paidRate'), l, 'buyer', l.seller.name);
  show('paid');
}
// side = which side I am on this deal; I rate the other person.
function rateForm(box, l, side, other) {
  const done = l.reviews?.[side];
  if (done) { box.innerHTML = `<b>You gave ${esc(other)} ${done.stars} ${done.stars === 1 ? 'star' : 'stars'}.</b>${done.text ? `<p class="sub">“${esc(done.text)}”</p>` : ''}`; return; }
  box.innerHTML = `<b>How was ${esc(other)}?</b><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} stars">${STAR.replace('class="star"', '')}</button>`).join('')}</div>
    <input maxlength="200" placeholder="A few words (optional)"><button class="primary" disabled>Send review</button><p class="fine">Only the buyer and the seller of a deal can review it. No fake reviews.</p>`;
  let stars = 0;
  $$('.stars button', box).forEach((b) => (b.onclick = () => { stars = +b.dataset.n; $$('.stars button', box).forEach((x) => x.classList.toggle('on', +x.dataset.n <= stars)); $('.primary', box).disabled = false; }));
  $('.primary', box).onclick = async () => {
    try {
      const nl = await api(`/api/listings/${l.id}/review`, { method: 'POST', json: { stars, text: $('input', box).value } });
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
  avatar($('#mAv'), d.user.name);
  $('#mName').textContent = d.user.name;
  $('#mStats').innerHTML = `${esc(meta.countries[d.user.country].name)} · ${d.user.sold} sold · ${d.user.bought} bought${d.user.stars ? ` · ${STAR} ${d.user.stars}` : ''}`;
  $('#mSell').innerHTML = d.mine.length ? d.mine.map((l) => `<li><a href="#item/${l.id}"><img src="${esc(l.photo)}" alt=""></a><a class="t" href="#item/${l.id}"><b>${esc(l.title)}</b><small>${money(l.price, l.currency)}${l.status === 'sold' ? ' · sold to ' + esc(l.buyer.name) : ''}</small></a>
    <span class="act">${l.status === 'sold' ? (l.reviews?.seller ? '<span class="tag ok">Done</span>' : `<a class="tag blue" href="#item/${l.id}">Rate ${esc(l.buyer.name)}</a>`) : `<span class="tag">For sale</span><button class="danger" data-del="${l.id}">Delete</button>`}</span></li>`).join('')
    : '<li class="none">Nothing yet. <a href="#sell"><u>Sell something</u></a></li>';
  $('#mLook').innerHTML = d.looking.length ? d.looking.map((w) => `<li>${SEARCH}<span class="t"><b>${esc(w.what)}</b><small>${money(w.minPrice)} to ${money(w.maxPrice)} · ${esc(w.category)}</small>${w.found.length ? `<span class="found">${w.found.map((f) => `<a href="#item/${f.listing.id}"><img src="${esc(f.listing.photo)}" alt="${esc(f.listing.title)}"></a>`).join('')}</span>` : ''}</span>
    <span class="act">${w.found.length ? `<span class="tag blue">${w.found.length} found</span>` : '<span class="tag">Looking</span>'}<button class="danger" data-delw="${w.id}">Delete</button></span></li>`).join('')
    : '<li class="none">Nothing yet. <a href="#buy"><u>Say what you want</u></a></li>';
  $('#mBought').innerHTML = d.bought.length ? d.bought.map((l) => `<li><a href="#item/${l.id}"><img src="${esc(l.photo)}" alt=""></a><a class="t" href="#item/${l.id}"><b>${esc(l.title)}</b><small>${money(l.price, l.currency)} · from ${esc(l.seller.name)}</small></a>
    <span class="act">${l.reviews?.buyer ? '<span class="tag ok">Done</span>' : `<a class="tag blue" href="#item/${l.id}">Rate ${esc(l.seller.name)}</a>`}</span></li>`).join('')
    : '<li class="none">Nothing yet.</li>';
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
  $('#podium').innerHTML = top.length ? [1, 0, 2].map((i) => { const u = top[i]; return `<a class="pod p${i + 1}" href="#user/${u.id}">${av(u.name, i ? 'lg' : 'xl')}<span class="medal">${i + 1}</span><b>${esc(u.name)}</b><small>${u[key]} ${key}</small><span class="ps">${u.stars ? STAR + u.stars.toFixed(1) : ''}</span></a>`; }).join('') : '';
  rows = rows.slice(top.length);
  $('#rank').innerHTML = rows.length ? rows.map((u, i) => `<li class="${u.id === me.id ? 'you' : ''}" style="animation-delay:${i * 35}ms"><a href="#user/${u.id}"><span class="n">${i + 1 + top.length}</span>${av(u.name)}
    <span class="t"><b>${esc(u.name)}</b><small>${u.sold} sold · ${u.bought} bought</small></span>
    <span class="s">${u.stars ? STAR + u.stars.toFixed(1) : '<small>No reviews</small>'}</span>${CHEV}</a></li>`).join('')
    : '<li style="display:block;color:var(--faint)">No deals in your country yet.</li>';
}

// ---------- start ----------
(async () => {
  meta = await api('/api/meta');
  $('#countrySel').innerHTML = '<option value="" disabled selected>Choose</option>' + Object.entries(meta.countries).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  chips($('#sCats'), { onPick: checkSell });
  chips($('#wCats'), { onPick: checkBuy });
  chips($('#bCats'), { all: true, onPick: (c) => { browseCat = c; openBrowse(); } });
  // back from PayPal
  const q = new URLSearchParams(location.search);
  if (q.has('paid') || q.has('item')) {
    const h = q.has('paid') ? 'paid/' + q.get('paid') : 'item/' + q.get('item');
    if (q.get('late')) setTimeout(() => toast('Someone was faster. You were not charged.'), 300);
    if (q.get('error')) setTimeout(() => toast(q.get('error')), 300);
    history.replaceState(null, '', '/#' + h);
  }
  if (me && !meta.countries[me.country]) me = null;
  if (me) {
    try { me = await api('/api/signin', { method: 'POST', json: { name: me.name, country: me.country } }); localStorage.setItem('homing.user', JSON.stringify(me)); }
    catch { me = null; }
  }
  if (me) setupForUser();
  route();
})();

// ---------- a person ----------
async function openUser(uid) {
  let u;
  try { u = await api('/api/users/' + uid); } catch { location.hash = 'board'; return; }
  avatar($('#uAv'), u.name);
  $('#uName').textContent = u.name + (u.id === me.id ? ' (you)' : '');
  $('#uMeta').textContent = `${meta.countries[u.country].name} · on Homing since ${new Date(u.since).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
  $('#uSold').textContent = u.sold; $('#uBought').textContent = u.bought;
  $('#uStars').innerHTML = u.stars ? STAR + u.stars.toFixed(1) : '–';
  $('#uStarsL').textContent = u.reviews ? `${u.reviews} ${u.reviews === 1 ? 'review' : 'reviews'}` : 'No reviews yet';
  $('#uSale').hidden = !u.forSale.length;
  fillGrid($('#uGrid'), u.forSale);
  const stars = (n) => [1, 2, 3, 4, 5].map((k) => STAR.replace('class="star"', k <= n ? '' : 'class="off"')).join('');
  $('#uRevs').innerHTML = u.feed.length ? u.feed.map((r) => `<li><div class="r-top">${av(r.from)}<b>${esc(r.from)}</b><span class="r-stars">${stars(r.stars)}</span><time>${ago(r.at)}</time></div>
    ${r.text ? `<p>${esc(r.text)}</p>` : ''}<span class="deal">${r.role === 'bought' ? esc(r.from) + ' bought' : esc(u.name) + ' bought'} ${esc(r.item)} · ${money(r.price, r.currency)} via PayPal</span></li>`).join('')
    : '<li style="color:var(--faint)">No reviews yet.</li>';
  show('user');
}

// ---------- buy sheet ----------
function openSheet() { $('#sheet').hidden = false; document.body.classList.add('locked'); requestAnimationFrame(() => $('#sheet').classList.add('open')); }
function closeSheet() { $('#sheet').classList.remove('open'); document.body.classList.remove('locked'); setTimeout(() => ($('#sheet').hidden = true), 280); }
$('#sheetBg').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
