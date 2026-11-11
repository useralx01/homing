// Opening, cartoon style. A white ball drops onto a blue screen and bounces, blows up into a badge,
// the logo is drawn on it, "Homing" jumps in, then a circle closes onto the header logo and shows the app.
// Every sound is made here with Web Audio: falling whistle, thump, boing, bloop, marker squeaks,
// a xylophone run for the letters and a swoosh + ding at the end.
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
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    bus = ac.createGain(); bus.gain.value = 0.7; bus.connect(comp); comp.connect(ac.destination);
  } catch {}
  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); };
  const osc = (type, t, d) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.05); return [o, g]; };
  function whistle(t, d, f0, f1, vib = 7) { // slide whistle with a wobble
    const [o, g] = osc('sine', t, d); const v = ac.createOscillator(), vg = ac.createGain();
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + d);
    v.frequency.value = vib; vg.gain.value = Math.min(f0, f1) * 0.03; v.connect(vg); vg.connect(o.frequency); v.start(t); v.stop(t + d + 0.05);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.04); g.gain.setValueAtTime(0.28, t + d - 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  }
  function thump(t, k = 1) { // a soft landing: low sine that drops fast
    const [o, g] = osc('sine', t, 0.3); o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.18); env(g, t, 0.005, 0.9 * k, 0.28);
  }
  function boing(t, f = 150, d = 0.55, k = 1) { // a spring: pitch wobbles and settles
    const [o, g] = osc('triangle', t, d); const w = ac.createOscillator(), wg = ac.createGain();
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.06); o.frequency.exponentialRampToValueAtTime(f * 1.35, t + d);
    w.frequency.setValueAtTime(18, t); w.frequency.linearRampToValueAtTime(8, t + d); wg.gain.setValueAtTime(f * 0.5, t); wg.gain.exponentialRampToValueAtTime(2, t + d);
    w.connect(wg); wg.connect(o.frequency); w.start(t); w.stop(t + d + 0.05); env(g, t, 0.01, 0.5 * k, d);
  }
  function bloop(t) { // the badge blows up
    const [o, g] = osc('sine', t, 0.3); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.16); env(g, t, 0.01, 0.55, 0.3);
  }
  function squeak(t, d, f0, f1) { // a marker on the badge
    const [o, g] = osc('square', t, d); const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6; f.frequency.value = 2400;
    o.disconnect(); o.connect(f); f.connect(g); o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f1, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.015); g.gain.setValueAtTime(0.16, t + d - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  }
  function xylo(t, f, k = 1) { // a wooden bar: base + bright partial, quick decay
    const [o, g] = osc('sine', t, 0.5); o.frequency.value = f; env(g, t, 0.004, 0.42 * k, 0.45);
    const [o2, g2] = osc('sine', t, 0.15); o2.frequency.value = f * 3.98; env(g2, t, 0.002, 0.12 * k, 0.12);
  }
  function swoosh(t, d) { // filtered noise sweeping down
    const n = ac.createBufferSource(), b = ac.createBuffer(1, ac.sampleRate * d, ac.sampleRate), x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    n.buffer = b; const f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(300, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + d * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(f); f.connect(g); g.connect(bus); n.start(t); n.stop(t + d);
  }
  const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5]; // C D E G A C
  function score() {
    if (!ac) return;
    const t = ac.currentTime + 0.03;
    whistle(t + 0.05, 0.36, 1500, 420, 9);          // the ball falls
    thump(t + 0.42); boing(t + 0.42, 140, 0.4, 0.8); // lands, squashes
    thump(t + 0.8, 0.5); boing(t + 0.8, 190, 0.25, 0.4);
    bloop(t + 0.96);                                 // blows up into the badge
    xylo(t + 1.22, 1046.5, 0.6);                     // the dot
    squeak(t + 1.28, 0.3, 700, 1250);                // the stem
    squeak(t + 1.6, 0.1, 1400, 1100); squeak(t + 1.73, 0.1, 1500, 1200); // the x
    whistle(t + 1.86, 0.26, 700, 1400, 12);          // round the circle
    boing(t + 1.98, 230, 0.4, 0.6);                  // badge wiggle
    NOTES.forEach((f, i) => xylo(t + 2.12 + i * 0.072 + 0.36, f)); // letters land
    NOTES.slice().reverse().forEach((f, i) => xylo(t + 2.86 + i * 0.055 + 0.15, f * 2, 0.35)); // the wave
    swoosh(t + 3.28, 0.6);                           // circle closes
    [1046.5, 1318.5, 1568].forEach((f) => xylo(t + 3.82, f, 0.55)); // ding
  }
  let played = false;
  if (ac && ac.state === 'running') { played = true; score(); }
  else ac?.resume?.().then(() => { if (ac.state === 'running' && !played) { played = true; score(); } }).catch(() => {});

  // ---------- leave: a circle closes onto the logo in the header (or the badge) ----------
  let gone = false;
  const leave = () => {
    if (gone) return; gone = true;
    const h = document.querySelector('.top:not([hidden]) .brand img');
    const r = (h && h.getBoundingClientRect().width ? h : el.querySelector('.in-badge')).getBoundingClientRect();
    el.style.setProperty('--ix', r.left + r.width / 2 + 'px'); el.style.setProperty('--iy', r.top + r.height / 2 + 'px');
    el.classList.add('out');
    setTimeout(() => el.remove(), 700);
  };
  let lt;
  const start = () => { el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); clearTimeout(lt); lt = setTimeout(leave, 3300); };
  // phones block sound until a tap: the first tap starts again from the top with sound, a later tap skips
  el.addEventListener('pointerdown', () => {
    if (played || !ac) return leave();
    ac.resume().then(() => { played = true; start(); score(); }).catch(leave);
  });
  start();
})();
