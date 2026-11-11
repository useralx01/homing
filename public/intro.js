// Opening: a calm logo sting. The mark rises and draws itself, then "Homing" slides out from behind it.
// Sounds are soft and made here with Web Audio: an airy rise, a warm settle chord, a swish for the name.
(() => {
  const el = document.getElementById('intro');
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = false;
  try { seen = sessionStorage.getItem('homing.intro') === '1'; sessionStorage.setItem('homing.intro', '1'); } catch {}
  if (reduce || seen) { el.remove(); return; }

  // ---------- sound ----------
  let ac, bus;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    bus = ac.createGain(); bus.gain.value = 0.6;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
    bus.connect(lp); lp.connect(ac.destination);
  } catch {}
  function air(t, d, f0, f1, peak) { // filtered noise that sweeps: a soft whoosh
    const n = ac.createBufferSource(), b = ac.createBuffer(1, Math.ceil(ac.sampleRate * d), ac.sampleRate), x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    n.buffer = b; const f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(f); f.connect(g); g.connect(bus); n.start(t); n.stop(t + d);
  }
  function tone(t, f, peak, d) { // a warm sine with a slow start and a long tail
    const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2; o2.detune.value = 4;
    const g2 = ac.createGain(); g2.gain.value = 0.18;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(bus); o.start(t); o2.start(t); o.stop(t + d + 0.05); o2.stop(t + d + 0.05);
  }
  function score() {
    if (!ac) return;
    const t = ac.currentTime + 0.03;
    air(t + 0.02, 0.85, 300, 2600, 0.22);                         // the mark rises
    [440, 554.37, 659.25].forEach((f, i) => tone(t + 0.86 + i * 0.03, f, 0.11, 1.6)); // it settles: a soft A major
    air(t + 1.06, 0.62, 2400, 700, 0.12);                          // the name slides out
    tone(t + 1.72, 1318.5, 0.05, 0.9);                             // a small shine at the end
  }
  let played = false;
  if (ac && ac.state === 'running') { played = true; score(); }
  else ac?.resume?.().then(() => { if (ac.state === 'running' && !played) { played = true; score(); } }).catch(() => {});

  // ---------- leave ----------
  let gone = false;
  const leave = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => el.remove(), 560); };
  // the mark starts in the middle; the row slides over by half the name as the name comes out
  const word = el.querySelector('.in-word');
  const fit = () => el.style.setProperty('--half', (word.offsetWidth + parseFloat(getComputedStyle(el.querySelector('.in-row')).columnGap || 14)) / 2 + 'px');
  fit(); document.fonts?.ready.then(fit);
  let lt;
  const start = () => { el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); clearTimeout(lt); lt = setTimeout(leave, 2600); };
  // phones block sound until a tap: the first tap starts again with sound, a later tap skips
  el.addEventListener('pointerdown', () => {
    if (played || !ac) return leave();
    ac.resume().then(() => { played = true; start(); score(); }).catch(leave);
  });
  start();
})();
