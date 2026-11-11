// The shelf: real things for sale near you, as glossy photo slabs on a turning ring.
// Real 3D (three.js, physical material, studio light). Drag to turn, tap to open.
import * as THREE from '/vendor/three.module.min.js';
import { RoomEnvironment } from '/vendor/RoomEnvironment.js';

const W = 1.0, H = 1.25, DEPTH = 0.05, RAD = 0.09;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

function rounded(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function mountShelf(host, { onOpen, onFront } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch { host.classList.add('no-gl'); return { set() {}, stop() {} }; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.fog = new THREE.Fog(0xffffff, 6.4, 8.6);

  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const ring = new THREE.Group(); scene.add(ring);

  // soft contact shadow under the front of the ring
  const sc = document.createElement('canvas'); sc.width = sc.height = 128;
  const g = sc.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(16,40,110,.30)'); gr.addColorStop(1, 'rgba(16,40,110,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.55), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; scene.add(shadow);

  const body = new THREE.ExtrudeGeometry(rounded(W, H, RAD), { depth: DEPTH, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 4, curveSegments: 10 });
  body.translate(0, 0, -DEPTH / 2);
  const face = new THREE.ShapeGeometry(rounded(W, H, RAD), 10);
  const uv = face.attributes.uv, fp = face.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, fp.getX(i) / W + 0.5, fp.getY(i) / H + 0.5);
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x1a5cf0, roughness: 0.18, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 });
  const loader = new THREE.TextureLoader();

  let items = [], slabs = [];
  let pos = 0, target = 0, vel = 0, dragging = false, lastX = 0, moved = 0, idleT = 0, front = -1;
  let px = 0, py = 0, running = false, raf = 0;

  function set(list) {
    items = list.slice(0, 10);
    slabs.forEach((m) => { ring.remove(m); m.children[0]?.material.map?.dispose(); m.children[0]?.material.dispose(); });
    slabs = [];
    items.forEach((it, i) => {
      const slab = new THREE.Mesh(body, blue);
      const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.55 });
      loader.load(it.photo, (t) => {
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        const a = t.image.width / t.image.height, want = W / H;
        if (a > want) { t.repeat.set(want / a, 1); t.offset.set((1 - want / a) / 2, 0); }
        else { t.repeat.set(1, a / want); t.offset.set(0, (1 - a / want) / 2); }
        mat.map = t; mat.needsUpdate = true; if (!running) draw();
      });
      const f = new THREE.Mesh(face, mat); f.position.z = DEPTH / 2 + 0.016;
      slab.add(f);
      slab.userData.i = i;
      ring.add(slab); slabs.push(slab);
    });
    shadow.position.set(0, 0.002, 0.05);
    pos = target = 0; front = -1;
    resize(); draw();
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    // keep the front slab about the same size on any screen
    const dist = 4.5;
    cam.position.set(0, H * 0.62, dist);
    cam.lookAt(0, H * 0.5, -0.4);
    cam.fov = w < 520 ? 30 : 24;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);

  // drag to turn, tap to open
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; moved = 0; vel = 0; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    px = ((e.clientX - r.left) / r.width - 0.5); py = ((e.clientY - r.top) / r.height - 0.5);
    if (!dragging) return;
    const dx = e.clientX - lastX; lastX = e.clientX; moved += Math.abs(dx);
    const d = (dx / r.width) * 3.2; target -= d; vel = -d; idleT = 0;
  });
  const up = (e) => {
    if (!dragging) return; dragging = false;
    if (moved < 6) return pick(e);
    target = Math.round(target + vel * 6);
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', () => { dragging = false; target = Math.round(target); });
  el.addEventListener('pointerleave', () => { px = py = 0; });

  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  function pick(e) {
    const r = el.getBoundingClientRect();
    v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, cam);
    const hit = ray.intersectObjects(slabs, true)[0];
    if (!hit) return;
    let o = hit.object; while (o.parent && o.userData.i === undefined) o = o.parent;
    const i = o.userData.i;
    if (i === front) onOpen?.(items[i]);
    else { target = Math.round(target) + wrap(i - Math.round(target)); idleT = 0; }
  }

  // shortest signed distance on a loop of n items
  const wrap = (d) => { const n = slabs.length; return ((d % n) + n * 1.5) % n - n / 2; };
  let last = performance.now();
  function tick(now, once) {
    if (!once) raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!dragging && !reduce && slabs.length > 1) { idleT += dt; if (idleT > 3.6) { idleT = 0; target += 1; } }
    pos += (target - pos) * (1 - Math.exp(-dt * (dragging ? 18 : 5)));
    // a curved row: the front one faces you, the neighbours turn in and step back
    slabs.forEach((s) => {
      const o = wrap(s.userData.i - pos), a = Math.min(Math.abs(o), 1), sg = Math.sign(o);
      s.visible = Math.abs(o) < 2.6;
      s.position.set(sg * (a * 1.02 + Math.max(Math.abs(o) - 1, 0) * 0.42), H / 2, -a * 0.75 - Math.max(Math.abs(o) - 1, 0) * 0.5);
      s.rotation.y = -sg * a * 0.62;
    });
    const f = ((Math.round(pos) % slabs.length) + slabs.length) % slabs.length;
    if (f !== front && slabs.length) { front = f; onFront?.(items[f], f); }
    cam.position.x += (px * 0.5 - cam.position.x) * 0.06;
    cam.position.y += (H * 0.62 - py * 0.25 - cam.position.y) * 0.06;
    cam.lookAt(0, H * 0.5, -0.4);
    renderer.render(scene, cam);
  }
  function draw() { tick.call(null, performance.now(), true); }
  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  new IntersectionObserver(([en]) => (en.isIntersecting && !host.closest('[hidden]') ? start() : stop())).observe(host);
  return { set, start, stop, resize };
}
