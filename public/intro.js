// Opening, in real 3D: a soft white rubber tile drops in and bounces, the glossy blue logo grows out of it
// stroke by stroke, the tile wobbles to face you and "Homing" comes up under it. ~2.7 s, once per session.
// Sounds are made here with Web Audio: a rubbery bloop when the tile lands, small clicks while the logo grows.
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
  wall.position.z = -0.55; wall.receiveShadow = true; scene.add(wall);

  // the tile: a thick rounded square with a big soft bevel, matte white rubber
  const S = 1.7, R = 0.46, D = 0.22, BV = 0.13;
  const sh = new THREE.Shape(), h = S / 2 - BV;
  sh.moveTo(-h + R, -h); sh.lineTo(h - R, -h); sh.quadraticCurveTo(h, -h, h, -h + R); sh.lineTo(h, h - R);
  sh.quadraticCurveTo(h, h, h - R, h); sh.lineTo(-h + R, h); sh.quadraticCurveTo(-h, h, -h, h - R); sh.lineTo(-h, -h + R);
  sh.quadraticCurveTo(-h, -h, -h + R, -h);
  const tg = new THREE.ExtrudeGeometry(sh, { depth: D, bevelEnabled: true, bevelThickness: BV, bevelSize: BV, bevelSegments: 12, curveSegments: 28 });
  tg.translate(0, 0, -D / 2);
  const rubber = new THREE.MeshPhysicalMaterial({ color: 0xf6f7f9, roughness: 0.62, clearcoat: 0.25, clearcoatRoughness: 0.5, sheen: 0.6, sheenRoughness: 0.8, sheenColor: 0xdfe6f3, envMapIntensity: 0.9 });
  const tile = new THREE.Mesh(tg, rubber); tile.castShadow = true; tile.receiveShadow = true;
  const rig = new THREE.Group(), body = new THREE.Group();
  body.add(tile); rig.add(body); scene.add(rig);

  // the logo, from the same paths as the 2D mark (48 x 48 box), as glossy blue tubes on the tile's face
  const FRONT = D / 2 + BV, s = 1.12 / 40, cx = 24, cy = 25;
  const P = (x, y, z = 0) => new THREE.Vector3((x - cx) * s, (cy - y) * s, FRONT + z);
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x0a4fc4, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.1 });
  const logo = new THREE.Group(); body.add(logo);
  class Ring extends THREE.Curve { getPoint(t, o = new THREE.Vector3()) { const a = (150 / 180) * Math.PI + t * Math.PI * 2; return o.copy(P(36 + 8 * Math.cos(a), 14 + 8 * Math.sin(a))); } }
  const strokes = [
    { c: new THREE.CubicBezierCurve3(P(8, 40), P(10, 22), P(21, 15), P(29.2, 17.8)), w: 3.4, from: 0.62, to: 1.0 },
    { c: new THREE.QuadraticBezierCurve3(P(25.9, 9), P(29, 15.5), P(33.5, 24.5)), w: 2.7, from: 1.0, to: 1.1 },
    { c: new THREE.QuadraticBezierCurve3(P(34.5, 10.8), P(29.6, 14.5), P(24.6, 26.1)), w: 2.7, from: 1.1, to: 1.2 },
    { c: new Ring(), w: 3.4, from: 1.18, to: 1.52, closed: true },
  ];
  const RAD = 12, SEG = 72;
  for (const k of strokes) {
    const r = (k.w / 2) * s * 1.55, lift = r * 0.45;
    const g = new THREE.TubeGeometry(k.c, SEG, r, RAD, !!k.closed); g.translate(0, 0, lift);
    k.mesh = new THREE.Mesh(g, blue); k.mesh.castShadow = true;
    const cap = new THREE.SphereGeometry(r, 20, 14);
    k.a = new THREE.Mesh(cap, blue); k.b = new THREE.Mesh(cap, blue); k.a.castShadow = k.b.castShadow = true;
    k.lift = lift; logo.add(k.mesh, k.a, k.b);
  }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(3.7 * s * 1.3, 32, 20), blue);
  dot.position.copy(P(8, 40, 3.7 * s * 0.5)); dot.castShadow = true; logo.add(dot);

  // ---------- timing helpers ----------
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const spring = (t, f, d) => (t <= 0 ? 0 : 1 - Math.exp(-d * t) * Math.cos(f * t));
  const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const LAND = 0.37;
  let px = 160;

  function fit() {
    const w = innerWidth, hgt = innerHeight;
    renderer.setSize(w, hgt, false); cam.aspect = w / hgt;
    px = Math.min(w * 0.42, hgt * 0.24, 200); // the tile's size on screen
    const dist = (S * hgt) / (px * 2 * Math.tan((cam.fov * Math.PI) / 360));
    cam.userData.dist = dist; cam.updateProjectionMatrix();
  }

  function draw(t) {
    // drop in from below with a spring, land at ~0.37 s, settle
    const up = spring(t, 4.25, 3.6);
    const v = (spring(t + 0.01, 4.25, 3.6) - up) / 0.01; // speed, for squash and stretch
    const endUp = ease((t - 1.55) / 0.6) * 0.32;          // lifts a little to make room for the name
    rig.position.y = -3.2 * (1 - up) + endUp;
    const st = Math.max(-0.16, Math.min(0.2, v * 0.05));
    // after landing the rubber jiggles (squash then a few soft wobbles)
    const jig = t > LAND ? Math.exp(-(t - LAND) * 6.5) * Math.sin((t - LAND) * 30) * 0.09 : 0;
    const sy = 1 + st - jig, sx = 1 / Math.sqrt(Math.max(0.6, sy));
    body.scale.set(sx, sy, 1 + jig * 0.5);
    // turned towards the light while flying, wobbles round to face you at the end
    const face = spring(t - 1.25, 9, 5.5);
    rig.rotation.x = (0.95 * (1 - up) + 0.3) * (1 - face);
    rig.rotation.y = (-0.42 + 0.18 * up) * (1 - face);
    rig.rotation.z = jig * 0.6 + 0.05 * (1 - up);
    // logo: the dot pops, then each stroke grows out of the face
    const dp = spring(t - 0.48, 16, 7);
    dot.scale.setScalar(Math.max(0.0001, dp));
    for (const k of strokes) {
      const p = clamp((t - k.from) / (k.to - k.from));
      const seg = Math.round(p * SEG);
      k.mesh.visible = seg > 0; k.mesh.geometry.setDrawRange(0, seg * RAD * 6);
      const grow = spring(t - k.from, 18, 8); // tubes swell from the surface as they grow
      k.a.visible = k.b.visible = p > 0 && !(k.closed && p >= 1);
      k.a.position.copy(k.c.getPoint(0)).setZ(FRONT + k.lift); k.b.position.copy(k.c.getPoint(Math.max(0.0001, p))).setZ(FRONT + k.lift);
      k.a.scale.setScalar(Math.max(0.0001, grow)); k.b.scale.setScalar(Math.max(0.0001, grow));
    }
    // camera drifts slowly, like a hand-held product shot
    const d = cam.userData.dist;
    const drift = 1 - ease(t / 2.4);
    cam.position.set(0.5 * drift, -0.2 * drift + 0.0, d * (1 + 0.12 * drift));
    cam.lookAt(0, 0.06 * drift, 0);
    renderer.render(scene, cam);
    // the name comes up under the tile with a soft overshoot
    const n = spring(t - 1.62, 11, 6.5);
    name.style.top = innerHeight / 2 + px * 0.6 + "px";
    name.style.opacity = clamp((t - 1.62) / 0.18);
    name.style.transform = `translateY(${(1 - n) * 26}px) scale(${0.94 + 0.06 * n})`;
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
    whoosh(t + 0.02, 0.36, 260, 1400, 0.07);
    thump(t + LAND, 0.32); bloop(t + LAND, 190, 820, 0.26, 0.15);  // lands: soft rubber bloop
    bloop(t + 0.5, 520, 1250, 0.12, 0.1);                           // the dot pops out
    for (let k = 0, x = 0.64; x < 1.52; x += 0.075, k++) tick(t + x, k % 2 ? 0.16 : 0.22, k % 2 ? 4200 : 5300); // the logo grows
    bloop(t + 1.52, 660, 1500, 0.1, 0.09);                          // the ring closes
    tick(t + 1.64, 0.24, 3600); bloop(t + 1.66, 300, 600, 0.08, 0.12); // the name lands
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
