// Opening: the logo draws itself stroke by stroke, then "Homing" bounces in letter by letter,
// cartoon style, with a slide whistle, pops and a boing. All sounds are made here with Web Audio.
(() => {
  const el = document.getElementById('intro');
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = false;
  try { seen = sessionStorage.getItem('homing.intro') === '1'; sessionStorage.setItem('homing.intro', '1'); } catch {}
  if (reduce || seen) { el.remove(); return; }

  // ---------- sound ----------
  let ac;
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  const out = () => { const g = ac.createGain(); g.gain.value = 0.55; g.connect(ac.destination); return g; };
  function whistle(t, d, f0, f1) { // slide whistle: a sine gliding up with a little wobble
    const o = ac.createOscillator(), g = ac.createGain(), v = ac.createOscillator(), vg = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + d);
    v.frequency.value = 9; vg.gain.value = f0 * 0.025; v.connect(vg); vg.connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.04); g.gain.setValueAtTime(0.32, t + d - 0.05); g.gain.linearRampToValueAtTime(0, t + d);
    o.connect(g); g.connect(out()); o.start(t); v.start(t); o.stop(t + d + 0.02); v.stop(t + d + 0.02);
  }
  function pop(t, f) { // a round little pop, pitch drops fast
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(f * 1.9, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(out()); o.start(t); o.stop(t + 0.18);
  }
  function boing(t) { // a spring: low tone whose pitch wobbles and settles
    const o = ac.createOscillator(), g = ac.createGain(), w = ac.createOscillator(), wg = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.08); o.frequency.exponentialRampToValueAtTime(190, t + 0.7);
    w.frequency.setValueAtTime(16, t); w.frequency.linearRampToValueAtTime(7, t + 0.7);
    wg.gain.setValueAtTime(70, t); wg.gain.exponentialRampToValueAtTime(2, t + 0.75);
    w.connect(wg); wg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g); g.connect(out()); o.start(t); w.start(t); o.stop(t + 0.82); w.stop(t + 0.82);
  }
  function score() {
    if (!ac) return;
    const t = ac.currentTime + 0.02;
    whistle(t + 0.05, 0.42, 330, 620);        // the stem rises
    pop(t + 0.56, 520); pop(t + 0.7, 620);    // the two strokes of the x
    whistle(t + 0.82, 0.34, 600, 1180);       // round the circle
    pop(t + 1.2, 300);                        // the logo lands
    [0, 1, 2, 3, 4, 5].forEach((i) => pop(t + 1.5 + i * 0.085, [392, 440, 523, 587, 659, 784][i]));
    boing(t + 2.08);
  }
  // Phones only allow sound after a tap: play now if we may, else on the first tap during the intro.
  let played = false;
  const tryPlay = () => { if (played || !ac) return; ac.resume?.().then(() => { if (ac.state === 'running' && !played) { played = true; score(); } }).catch(() => {}); };
  if (ac && ac.state === 'running') { played = true; score(); } else tryPlay();
  // ---------- leave ----------
  let gone = false;
  const leave = () => {
    if (gone) return; gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 560);
  };
  // the row starts with the logo centred, then slides over as the word arrives
  const word = el.querySelector('.in-word');
  el.style.setProperty('--ww', (word.offsetWidth + 12) / 2 + 'px');
  let lt;
  const start = () => { el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); clearTimeout(lt); lt = setTimeout(leave, 3700); };
  // first tap without sound: start again from the top with sound; any later tap skips
  el.addEventListener('pointerdown', () => {
    if (played || !ac) return leave();
    ac.resume().then(() => { played = true; start(); score(); }).catch(leave);
  });
  start();
})();
