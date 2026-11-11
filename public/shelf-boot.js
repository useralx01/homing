// Connects the 3D shelf to the page: window.shelf(id, listings)
import { mountShelf } from '/shelf.js?v=43';

const shelves = {};
const money = (n, c = 'EUR') => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

window.shelf = (id, list) => {
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
  shelves[id].set(list);
};
