const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(v || 0));
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const avatar = (el, name) => { el.textContent = (name || '?')[0].toUpperCase(); el.style.setProperty('--c', `hsl(${hue(name)} 38% 38%)`); };
const ppLogo = '<svg viewBox="0 0 101 32" aria-hidden="true"><path fill="#003087" d="M12.2 4.7H4.4c-.5 0-1 .4-1.1.9L.2 25.6c0 .4.3.7.7.7h3.7c.5 0 1-.4 1.1-.9l.8-5.4c.1-.5.5-.9 1.1-.9h2.5c5.1 0 8.1-2.5 8.9-7.4.3-2.2 0-3.9-1-5.1-1.1-1.3-3.1-2-5.8-2zm.9 7.3c-.4 2.8-2.6 2.8-4.6 2.8H7.3l.8-5.2c0-.3.3-.5.7-.5h.5c1.4 0 2.7 0 3.4.8.4.5.5 1.2.4 2.1z"/><path fill="#009cde" d="M35.2 11.9h-3.7c-.3 0-.6.2-.7.5l-.2 1-.3-.4c-.8-1.2-2.6-1.6-4.4-1.6-4.1 0-7.6 3.1-8.3 7.5-.4 2.2.1 4.3 1.4 5.7 1.1 1.3 2.8 1.9 4.7 1.9 3.3 0 5.2-2.2 5.2-2.2l-.2 1c0 .4.3.7.7.7h3.4c.5 0 1-.4 1.1-.9l2-12.7c0-.3-.3-.5-.7-.5zm-5.2 7.2c-.4 2.1-2 3.6-4.2 3.6-1.1 0-1.9-.3-2.5-1-.6-.7-.8-1.6-.6-2.7.3-2.1 2.1-3.6 4.2-3.6 1 0 1.9.4 2.4 1 .6.7.8 1.7.7 2.7z"/><text x="40" y="23" font-family="Inter,Arial" font-weight="700" font-size="17" fill="#003087">PayPal</text></svg>';

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

// ---------- views ----------
function show(view) {
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view || (view === 'inbox' && b.dataset.view === 'people')));
  if (view === 'people') loadPeople();
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-view]');
  if (!t) return;
  e.preventDefault();
  history.pushState(null, '', t.dataset.view === 'sell' ? '/' : '/?view=' + t.dataset.view);
  show(t.dataset.view);
});
window.addEventListener('popstate', route);

function route() {
  const q = new URLSearchParams(location.search);
  if (q.get('inbox')) return openInbox(q.get('inbox'), q);
  show(q.get('view') || 'sell');
}

// ---------- health ----------
api('/api/health').then((h) => {
  $('#env').textContent = h.env === 'sandbox' ? 'PayPal sandbox · test money' : '';
  if (!h.ai || !h.paypal) $('#sellErr').textContent = `Setup missing: ${!h.ai ? 'Gemini key' : ''}${!h.ai && !h.paypal ? ' and ' : ''}${!h.paypal ? 'PayPal keys' : ''} in .env`;
}).catch(() => {});

// ---------- sell ----------
const drop = $('#drop'), photo = $('#photo'), go = $('#go');
const ready = () => (go.disabled = !(photo.files[0] && $('#line').value.trim()));
function setPhoto(f) {
  if (!f) return;
  const dt = new DataTransfer(); dt.items.add(f); photo.files = dt.files;
  $('#preview').src = URL.createObjectURL(f);
  drop.classList.add('has');
  ready();
}
photo.addEventListener('change', () => setPhoto(photo.files[0]));
$('#line').addEventListener('input', ready);
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setPhoto(e.dataTransfer.files[0]));

$('#sellForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (go.disabled) return;
  $('#sellErr').textContent = '';
  go.disabled = true; go.classList.add('busy'); go.textContent = 'Looking at your photo…';
  const res = $('#result'), stage = $('#stage');
  res.hidden = false;
  $('#itemImg').src = $('#preview').src;
  $('#itemTitle').textContent = $('#line').value;
  $('#itemPrice').textContent = '';
  $('#matches').innerHTML = '';
  $('#wires').innerHTML = '';
  $('#status').textContent = 'Reading the photo and checking who is looking for this…';
  stage.classList.add('scanning');
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const out = await api('/api/sell', { method: 'POST', body: new FormData(e.target) });
    stage.classList.remove('scanning');
    $('#itemTitle').textContent = out.offer.item.title;
    $('#itemPrice').textContent = money(out.offer.item.price);
    renderMatches(out);
  } catch (err) {
    stage.classList.remove('scanning');
    $('#status').textContent = '';
    $('#sellErr').textContent = err.message;
  } finally {
    go.classList.remove('busy'); go.textContent = 'Find the people looking'; ready();
  }
});

function renderMatches(out) {
  const list = $('#matches');
  if (!out.matches.length) {
    list.innerHTML = '<li class="empty-note">Nobody is looking for this right now. It stays ready, and anyone who starts looking for it gets it.</li>';
    $('#status').textContent = '';
    return;
  }
  out.matches.forEach((m, i) => {
    const li = $('#tplMatch').content.firstElementChild.cloneNode(true);
    avatar($('.av', li), m.want.name);
    $('.m-name', li).textContent = `${m.want.name} · ${m.want.city || ''}`.replace(/ · $/, '');
    $('.m-why', li).textContent = m.why;
    $('.m-msg', li).textContent = m.message;
    $('.m-score', li).textContent = m.score + '% fit';
    li.style.animationDelay = 250 + i * 220 + 'ms';
    li.addEventListener('click', () => { history.pushState(null, '', '/?inbox=' + m.want.id); openInbox(m.want.id); });
    li.style.cursor = 'pointer';
    list.append(li);
  });
  requestAnimationFrame(() => drawWires(out.matches.length));
  const secs = (out.ms / 1000).toFixed(1);
  $('#status').innerHTML = `Sent to <b>${out.matches.length} ${out.matches.length === 1 ? 'person' : 'people'}</b> in ${secs}s, ${out.matches.length === 1 ? 'with' : 'each with'} a PayPal button. First to pay gets it.`;
  pollSold(out.offer.id);
}

function drawWires(n) {
  const svg = $('#wires'), stage = $('#stage');
  if (getComputedStyle(svg).display === 'none') return;
  const sb = stage.getBoundingClientRect(), ib = $('.item img').getBoundingClientRect();
  const x0 = ib.right - sb.left, y0 = ib.top - sb.top + ib.height / 2;
  svg.setAttribute('viewBox', `0 0 ${sb.width} ${sb.height}`);
  svg.innerHTML = '';
  $$('.match .av').forEach((av, i) => {
    const b = av.getBoundingClientRect();
    const x1 = b.left - sb.left - 10, y1 = b.top - sb.top + b.height / 2;
    const dx = (x1 - x0) * 0.5;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M${x0},${y0} C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`);
    svg.append(p);
    const len = p.getTotalLength();
    p.style.setProperty('--len', len);
    p.style.animationDelay = 150 + i * 220 + 'ms';
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x1); c.setAttribute('cy', y1); c.setAttribute('r', 3);
    c.style.animationDelay = 900 + i * 220 + 'ms';
    svg.append(c);
  });
}
window.addEventListener('resize', () => { if (!$('#result').hidden && $$('.match').length) drawWires(); });

let soldTimer;
function pollSold(offerId) {
  clearInterval(soldTimer);
  soldTimer = setInterval(async () => {
    try {
      const o = await api('/api/offers/' + offerId);
      if (o.soldTo) {
        clearInterval(soldTimer);
        const who = o.deliveries.find((d) => d.wantId === o.soldTo)?.name || 'Someone';
        $('#status').innerHTML = `<b>Sold to ${who}</b> · ${money(o.capture?.amount?.value || o.item.price)} paid with PayPal. Everyone else was told it's gone.`;
      }
    } catch {}
  }, 3000);
}

// ---------- seek ----------
$('#seekForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('button', e.target);
  $('#seekErr').textContent = '';
  btn.disabled = true; btn.textContent = 'Understanding what you need…';
  try {
    const w = await api('/api/wants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    e.target.reset();
    history.pushState(null, '', '/?inbox=' + w.id);
    openInbox(w.id);
  } catch (err) { $('#seekErr').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Start looking'; }
});

// ---------- people ----------
async function loadPeople() {
  const ws = await api('/api/wants');
  const ul = $('#people');
  ul.innerHTML = '';
  for (const w of ws) {
    const li = document.createElement('li');
    li.innerHTML = `<a href="/?inbox=${w.id}"><span class="av"></span><span><div class="p-want"></div><div class="p-meta"></div></span><span class="p-badge"></span></a>`;
    avatar($('.av', li), w.name);
    $('.p-want', li).textContent = w.want;
    $('.p-meta', li).textContent = [w.name, w.city, w.maxPrice ? 'up to ' + money(w.maxPrice) : ''].filter(Boolean).join(' · ');
    $('.p-badge', li).innerHTML = w.boughtOffer ? '<b>Bought</b>' : 'Looking';
    $('a', li).addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', '/?inbox=' + w.id); openInbox(w.id); });
    ul.append(li);
  }
}

// ---------- inbox ----------
async function openInbox(wantId, q = new URLSearchParams(location.search)) {
  show('inbox');
  const { want, offers } = await api('/api/inbox/' + wantId);
  $('#inboxName').textContent = want.name + "'s inbox";
  $('#inboxWant').textContent = `Looking for ${want.want}${want.maxPrice ? ', up to ' + money(want.maxPrice) : ''}${want.city ? ' · ' + want.city : ''}`;
  $('#inboxCares').innerHTML = '';
  (want.careAbout || []).forEach((c) => { const li = document.createElement('li'); li.textContent = c; $('#inboxCares').append(li); });

  const banner = $('#banner');
  banner.hidden = true; banner.className = 'banner';
  if (q.get('paid')) { banner.hidden = false; banner.classList.add('ok'); banner.textContent = 'Paid with PayPal. The seller has been told, and it’s yours.'; }
  else if (q.get('late')) { banner.hidden = false; banner.classList.add('bad'); banner.textContent = 'Someone paid a moment earlier, so this one is gone. You were not charged.'; }
  else if (q.get('error')) { banner.hidden = false; banner.classList.add('bad'); banner.textContent = q.get('error'); }

  const ol = $('#offers');
  ol.innerHTML = '';
  if (!offers.length) ol.innerHTML = '<li class="empty-note">Nothing yet. When someone sells what you’re looking for, it lands here.</li>';
  for (const o of offers) {
    const li = $('#tplOffer').content.firstElementChild.cloneNode(true);
    $('.o-img', li).src = o.photo;
    $('.o-title', li).textContent = o.item.title;
    $('.o-price', li).textContent = money(o.item.price);
    $('.o-msg', li).textContent = o.message;
    for (const c of o.checks || []) {
      const s = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '?';
      const it = document.createElement('li'); it.className = c.status;
      it.innerHTML = `<span class="s"></span><span><span class="n"></span><small></small></span>`;
      $('.s', it).textContent = s; $('.n', it).textContent = c.need; $('small', it).textContent = c.note || '';
      $('.o-checks', li).append(it);
    }
    const facts = $('.o-facts', li);
    const add = (t, cls) => { const it = document.createElement('li'); it.textContent = t; if (cls) it.className = cls; facts.append(it); };
    add('Condition: ' + o.item.condition);
    (o.item.facts || []).forEach((f) => add(f));
    (o.item.flaws || []).forEach((f) => add('Flaw: ' + f, 'flaw'));
    if (o.item.handover && o.item.handover !== 'unknown') add('Handover: ' + o.item.handover);
    if (o.sellerDetails) add('Seller: “' + o.sellerDetails + '”');
    const act = $('.o-act', li);
    if (o.status === 'open' && o.payUrl) act.innerHTML = `<a class="pp" href="${o.payUrl}">Pay ${money(o.item.price)} with ${ppLogo}</a><span class="tag">${o.score}% fit</span>`;
    else if (o.status === 'yours') act.innerHTML = '<span class="tag won">Bought · paid with PayPal</span>';
    else act.innerHTML = '<span class="tag">Sold to someone else</span>';
    ol.append(li);
  }
}

route();
