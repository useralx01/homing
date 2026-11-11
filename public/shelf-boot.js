// Connects the 3D shelf to the page: window.shelf(id, listings)
import { mountShelf } from '/shelf.js?v=44';

const shelves = {};
const money = (n, c = 'EUR') => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

// how bright a photo is (0..1), so a very dark one never stands in the front slot
const lum = (src) => new Promise((res) => {
  const im = new Image(); const t = setTimeout(() => res(1), 1500);
  im.onload = () => { clearTimeout(t); try { const c = document.createElement('canvas'); c.width = c.height = 12; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 12, 12); const d = g.getImageData(0, 0, 12, 12).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; res(s / (d.length / 4) / 255); } catch { res(1); } };
  im.onerror = () => { clearTimeout(t); res(1); }; im.src = src;
});
async function brightFirst(list) {
  const l = list.slice(0, 10), v = await Promise.all(l.map((it) => lum(it.photo)));
  const i = v.findIndex((x) => x >= 0.3);
  if (i > 0) { const [it] = l.splice(i, 1); l.unshift(it); }
  return l;
}
window.shelf = async (id, list) => {
  const host = document.getElementById(id);
  if (!host || !list?.length) { if (host) host.hidden = true; return; }
  host.hidden = false;
  const tag = document.getElementById(id + 'Tag');
  const signin = id === 'shelfIn';
  if (!shelves[id]) {
    shelves[id] = mountShelf(host, {
      onOpen: (it) => { if (!signin) location.hash = 'item/' + it.id; },
      onFront: (it) => {
        tag.href = signin ? '#' : '#item/' + it.id;
        tag.classList.remove('in'); void tag.offsetWidth;
        tag.querySelector('b').textContent = it.title;
        tag.querySelector('span').textContent = money(it.price, it.currency);
        tag.classList.add('in');
      },
    });
    if (signin) tag.onclick = (e) => e.preventDefault();
  }
  shelves[id].set(await brightFirst(list));
};
