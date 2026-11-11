// Opening, in real 3D: the glossy blue logo rises turning, grows stroke by stroke, lands with a rubbery squash,
// then slides left as "Homing" comes out from behind it. ~2.7 s, once per session.
// Sounds are made here with Web Audio: a rubbery bloop when the logo lands, small clicks while the logo grows.
// Everything is a function of time t, so it can also be rendered frame by frame (window.__introSeek).
import * as THREE from '/vendor/three.module.min.js';
import { RoomEnvironment } from '/vendor/RoomEnvironment.js';

const el = document.getElementById('intro');
let skip = !el || matchMedia('(prefers-reduced-motion: reduce)').matches;
try { if (sessionStorage.getItem('homing.intro') === '1') skip = true; sessionStorage.setItem('homing.intro', '1'); } catch {}
if (el && skip) el.remove();
else if (el) run();

function run() {
  // ---------- 3D ----------
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { el.remove(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0xffffff, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
  el.prepend(renderer.domElement);
  const name = el.querySelector('.in-name');

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-2.2, 3.4, 4.5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 18; sun.shadow.blurSamples = 20; sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 14 });
  scene.add(sun, new THREE.AmbientLight(0xffffff, 0.35));
  // the wall behind it only catches the soft shadow
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.08 }));
  wall.position.z = -0.45; wall.receiveShadow = true; scene.add(wall);

  // the logo alone, from the same paths as the 2D mark (48 x 48 box), as thick glossy blue tubes
  const s = 1.12 / 40, cx = 24, cy = 25, LW = 1.12;
  const P = (x, y, z = 0) => new THREE.Vector3((x - cx) * s, (cy - y) * s, z);
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x0a4fc4, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.1 });
  const rig = new THREE.Group(), body = new THREE.Group(), logo = new THREE.Group();
  body.add(logo); rig.add(body); scene.add(rig);
  class Ring extends THREE.Curve { getPoint(t, o = new THREE.Vector3()) { const a = (150 / 180) * Math.PI + t * Math.PI * 2; return o.copy(P(36 + 8 * Math.cos(a), 14 + 8 * Math.sin(a))); } }
  const strokes = [
    { c: new THREE.CubicBezierCurve3(P(8, 40), P(10, 22), P(21, 15), P(29.2, 17.8)), w: 3.4, from: 0.12, to: 0.5 },
    { c: new THREE.QuadraticBezierCurve3(P(25.9, 9), P(29, 15.5), P(33.5, 24.5)), w: 2.7, from: 0.5, to: 0.59 },
    { c: new THREE.QuadraticBezierCurve3(P(34.5, 10.8), P(29.6, 14.5), P(24.6, 26.1)), w: 2.7, from: 0.59, to: 0.68 },
    { c: new Ring(), w: 3.4, from: 0.66, to: 0.98, closed: true },
  ];
  const RAD = 14, SEG = 80;
  for (const k of strokes) {
    const r = (k.w / 2) * s * 1.6;
    k.mesh = new THREE.Mesh(new THREE.TubeGeometry(k.c, SEG, r, RAD, !!k.closed), blue); k.mesh.castShadow = true;
    const cap = new THREE.SphereGeometry(r, 20, 14);
    k.a = new THREE.Mesh(cap, blue); k.b = new THREE.Mesh(cap, blue); k.a.castShadow = k.b.castShadow = true;
    logo.add(k.mesh, k.a, k.b);
  }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(3.7 * s * 1.3, 32, 20), blue);
  dot.position.copy(P(8, 40)); dot.castShadow = true; logo.add(dot);

  // ---------- timing helpers ----------
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const spring = (t, f, d) => (t <= 0 ? 0 : 1 - Math.exp(-d * t) * Math.cos(f * t));
  const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const LAND = 0.34, SLIDE = 1.05, SLIDE_D = 0.7;
  let L = 90, ppu = 80;
  const word = name.firstElementChild;

  function fit() {
    const w = innerWidth, hgt = innerHeight;
    renderer.setSize(w, hgt, false); cam.aspect = w / hgt;
    L = Math.min(w * 0.2, hgt * 0.14, 104);   // the logo's width on screen
    ppu = L / LW;
    const dist = hgt / (ppu * 2 * Math.tan((cam.fov * Math.PI) / 360));
    cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
    name.style.fontSize = Math.round(L * 0.62) + 'px';
  }

  function draw(t) {
    // rises from below while turning (seen in 3D from the side), lands with a rubbery squash, faces you
    const up = spring(t, 4.6, 4);
    const v = (spring(t + 0.01, 4.6, 4) - up) / 0.01;
    const st = Math.max(-0.14, Math.min(0.2, v * 0.045));
    const jig = t > LAND ? Math.exp(-(t - LAND) * 6) * Math.sin((t - LAND) * 28) * 0.1 : 0;
    const sy = 1 + st - jig, sx = 1 / Math.sqrt(Math.max(0.6, sy));
    body.scale.set(sx, sy, 1);
    const face = spring(t - 0.15, 5.5, 4.2);
    rig.rotation.set(0.5 * (1 - face), 1.1 * (1 - face), -1.0 * (1 - up) + jig * 0.5);
    // then it slides left and the name comes out from behind it
    const sl = ease((t - SLIDE) / SLIDE_D);
    const nameW = word.offsetWidth, gap = L * 0.3;
    const shift = ((gap + nameW) / 2) * sl;
    rig.position.set(-shift / ppu, -2.4 * (1 - up), 0);
    // logo: the dot pops, then each stroke grows
    dot.scale.setScalar(Math.max(0.0001, spring(t - 0.06, 16, 7)));
    for (const k of strokes) {
      const p = clamp((t - k.from) / (k.to - k.from));
      const seg = Math.round(p * SEG);
      k.mesh.visible = seg > 0; k.mesh.geometry.setDrawRange(0, seg * RAD * 6);
      const grow = Math.max(0.0001, spring(t - k.from, 18, 8));
      k.a.visible = k.b.visible = p > 0 && !(k.closed && p >= 1);
      k.a.position.copy(k.c.getPoint(0)); k.b.position.copy(k.c.getPoint(Math.max(0.0001, p)));
      k.a.scale.setScalar(grow); k.b.scale.setScalar(grow);
    }
    renderer.render(scene, cam);
    // the name: a clip box that starts at the logo's right edge, the word slides out of it
    name.style.left = innerWidth / 2 - shift + L * 0.56 + gap * 0.45 + 'px';
    name.style.top = innerHeight / 2 + 'px';
    word.style.transform = `translateX(${-(nameW + gap) * (1 - sl)}px)`;
  }

  // ---------- sound ----------
  let ac, bus;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    bus = ac.createGain(); bus.gain.value = 1.1; bus.connect(ac.destination);
  } catch {}
  const noise = (d) => { const b = ac.createBuffer(1, Math.ceil(ac.sampleRate * d), ac.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1; const n = ac.createBufferSource(); n.buffer = b; return n; };
  function whoosh(t, d, f0, f1, peak) { // air while the tile flies up
    const n = noise(d), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + d * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(f); f.connect(g); g.connect(bus); n.start(t); n.stop(t + d);
  }
  function bloop(t, f0, f1, peak, d = 0.16) { // a rubbery pop: a sine that bends up fast
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + d * 0.55);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.02);
  }
  function thump(t, peak) { // the soft body of the landing
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.14);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.22);
  }
  function tick(t, peak, f = 4600) { // a tiny plastic click, like a dial turning
    const n = noise(0.03), bp = ac.createBiquadFilter(), g = ac.createGain(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.0015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    n.connect(bp); bp.connect(g); g.connect(bus); n.start(t); n.stop(t + 0.03);
    const o = ac.createOscillator(), og = ac.createGain(); o.type = 'triangle'; o.frequency.value = f * 0.52;
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.002); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    o.connect(og); og.connect(bus); o.start(t); o.stop(t + 0.03);
  }
  function score() {
    if (!ac) return;
    const t = ac.currentTime + 0.02;
    whoosh(t + 0.0, 0.32, 260, 1500, 0.07);                        // it flies up
    bloop(t + 0.06, 420, 1100, 0.14, 0.1);                          // the dot pops out
    thump(t + LAND, 0.28); bloop(t + LAND, 190, 820, 0.24, 0.15);  // lands: soft rubber bloop
    for (let k = 0, x = 0.14; x < 0.98; x += 0.07, k++) tick(t + x, k % 2 ? 0.16 : 0.22, k % 2 ? 4200 : 5300); // the logo grows
    bloop(t + 0.98, 660, 1500, 0.11, 0.09);                         // the ring closes
    whoosh(t + SLIDE, SLIDE_D * 0.9, 2400, 600, 0.06);              // the name slides out
    tick(t + SLIDE + SLIDE_D - 0.04, 0.22, 3600); bloop(t + SLIDE + SLIDE_D - 0.02, 300, 620, 0.08, 0.12); // and stops
  }

  // ---------- play ----------
  let t0 = performance.now(), gone = false, played = false, raf = 0, timer;
  const leave = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => { cancelAnimationFrame(raf); el.remove(); renderer.dispose(); }, 560); };
  const loop = () => { if (window.__introHold) return; draw((performance.now() - t0) / 1000); raf = requestAnimationFrame(loop); };
  const start = () => { t0 = performance.now(); clearTimeout(timer); timer = setTimeout(leave, 2700); cancelAnimationFrame(raf); loop(); };
  window.__introSeek = (t) => { window.__introHold = true; cancelAnimationFrame(raf); draw(t); };
  fit(); addEventListener('resize', fit);
  if (ac && ac.state === 'running') { played = true; score(); }
  else ac?.resume?.().then(() => { if (ac.state === 'running' && !played) { played = true; score(); } }).catch(() => {});
  // phones block sound until a tap: the first tap starts again with sound, a later tap skips
  el.addEventListener('pointerdown', () => {
    if (played || !ac) return leave();
    ac.resume().then(() => { played = true; start(); score(); }).catch(leave);
  });
  start();
}
