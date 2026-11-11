// Opening: the logo forms itself like living blue gummy jelly, in real 3D (own ray-marched shader, plain WebGL).
// A drop falls and splats into the dot, pours out along the stem as a gooey stream, puffs up into the ring,
// the cross snaps across, everything jiggles like jelly and sets. Then it slides left and "Homing" comes out
// from behind it. Sounds are made here with Web Audio. Everything is a function of time t (window.__introSeek).
const el = document.getElementById('intro');
let skip = !el || matchMedia('(prefers-reduced-motion: reduce)').matches;
try { if (sessionStorage.getItem('homing.intro') === '1') skip = true; sessionStorage.setItem('homing.intro', '1'); } catch {}
if (el && skip) el.remove();
else if (el) run();

function run() {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl', { antialias: false, premultipliedAlpha: true, alpha: true });
  if (!gl) { el.remove(); return; }
  el.prepend(cv);
  const name = el.querySelector('.in-name'), word = name.firstElementChild;

  // ---------- shader ----------
  const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FS = `precision highp float;
uniform vec2 uRes; uniform float uPpu, uK, uAmp, uT;
uniform vec4 uStem[12]; uniform vec4 uX1[5]; uniform vec4 uX2[5];
uniform vec4 uRing, uDot, uBound; uniform vec3 uDotS, uScale; uniform mat3 uRot; uniform vec2 uShift;
uniform sampler2D uTx; uniform vec4 uTxt; uniform vec2 uTxtOn; uniform float uTxS;
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float cap(vec3 p,vec4 a,vec4 b){vec3 pa=p-a.xyz,ba=b.xyz-a.xyz;float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.,1.);return length(pa-ba*h)-mix(a.w,b.w,h);}
// the name: a distance-field texture of "Homing", puffed up into rounded 3D jelly letters
float txt(vec3 q){
  vec2 uv=(q.xy-uTxt.xy)/uTxt.zw, cl=clamp(uv,0.,1.);
  float d2=(texture2D(uTx,vec2(cl.x,1.-cl.y)).r-.5)*uTxS+length((uv-cl)*uTxt.zw);
  vec2 w=vec2(d2+.095,abs(q.z)-.05);
  float d3=min(max(w.x,w.y),0.)+length(max(w,0.))-.095;
  return max(d3,uTxtOn.x-q.x);   // hidden until it comes out from behind the logo
}
float map(vec3 p){
  vec3 q=uRot*(p-vec3(uShift,0.)); q/=uScale;
  vec3 e=q-uDot.xyz; vec3 rs=uDot.w*uDotS;
  float d=(length(e/rs)-1.)*min(rs.x,rs.y);
  float ds=1e3, dx=1e3, dy=1e3;   // each stroke is one smooth tube (hard union of its pieces), strokes melt together
  for(int i=0;i<11;i++){ if(uStem[i+1].w>0.) ds=min(ds,cap(q,uStem[i],uStem[i+1])); }
  for(int i=0;i<4;i++){ if(uX1[i+1].w>0.) dx=min(dx,cap(q,uX1[i],uX1[i+1])); if(uX2[i+1].w>0.) dy=min(dy,cap(q,uX2[i],uX2[i+1])); }
  d=smin(d,ds,uK); d=smin(d,dx,uK*.6); d=smin(d,dy,uK*.6);
  if(uRing.w>0.){ vec3 r=q-vec3(uRing.xy,0.); vec2 tq=vec2(length(r.xy)-uRing.z,r.z); d=smin(d,length(tq)-uRing.w,uK); }
  if(uTxtOn.y>0.) d=min(d,txt(q));
  d+=uAmp*sin(7.*q.x+9.*uT)*sin(6.*q.y-11.*uT)*sin(5.*q.z+7.*uT+q.x*3.);
  return d*min(uScale.x,min(uScale.y,uScale.z))*.85;
}
vec3 nor(vec3 p){vec2 k=vec2(1.,-1.)*.0015;return normalize(k.xyy*map(p+k.xyy)+k.yyx*map(p+k.yyx)+k.yxy*map(p+k.yxy)+k.xxx*map(p+k.xxx));}
// gummy: see-through blue jelly. Thin parts glow light blue, thick parts go deep blue, light shines through it.
float thick(vec3 p,vec3 dir){ float t=.012; for(int i=0;i<22;i++){ float d=map(p+dir*t); if(d>0.)break; t+=max(-d,.012); } return t; }
vec3 shade(vec3 p,vec3 rd){
  vec3 n=nor(p), v=-rd, l=normalize(vec3(-.45,.75,.65));
  float th=thick(p-n*.004,rd);
  float tl=thick(p-n*.004,l);
  float tr=exp(-th*8.5);
  vec3 deep=vec3(.01,.09,.45), mid=vec3(.03,.33,.88), lite=vec3(.32,.6,1.);
  vec3 col=mix(deep,mid,smoothstep(.0,.35,tr));
  col=mix(col,lite,tr*tr*.6);
  col+=vec3(.2,.45,1.)*exp(-tl*7.)*.30;
  float dif=max(dot(n,l),0.);
  col*=.82+.25*dif;
  vec3 r=reflect(rd,n);
  col+=vec3(.85,.93,1.)*.16*smoothstep(.1,1.,r.y);
  col+=pow(max(dot(reflect(-l,n),v),0.),140.)*1.1;
  col+=pow(max(dot(reflect(-normalize(vec3(.6,.2,.8)),n),v),0.),60.)*.35;
  col+=pow(1.-max(dot(n,v),0.),2.5)*vec3(.45,.68,1.)*.35;
  return min(col,vec3(1.));
}
void main(){
  vec2 f=gl_FragCoord.xy; vec3 ro=vec3(0.,0.,7.);
  vec3 rd=normalize(vec3((f-uRes*.5)/uPpu,0.)-ro);
  vec3 oc=ro-vec3(uBound.xy,0.); float b=dot(oc,rd), c=dot(oc,oc)-uBound.z*uBound.z, h=b*b-c;
  float edge=0.; vec3 col=vec3(0.);
  if(h>0.){
    float sh=sqrt(h), t=max(0.,-b-sh), t1=-b+sh, md=1e3, mt=t; bool hit=false;
    for(int i=0;i<90;i++){ float d=map(ro+rd*t); if(d<md){md=d;mt=t;} if(d<.0008){hit=true;break;} t+=d; if(t>t1)break; }
    if(hit){ edge=1.; col=shade(ro+rd*t,rd); }
    else { edge=clamp(1.-md*uPpu*.9,0.,1.); if(edge>0.) col=shade(ro+rd*mt,rd); }
  }
  float sa=0.;
  if(edge<1.){
    float tp=(-.55-ro.z)/rd.z; vec3 pp=ro+rd*tp;
    if(length(pp.xy-uBound.xy)<uBound.z+1.2){
      vec3 ls=normalize(vec3(-.22,.5,1.)); float res=1., tt=.05;
      for(int i=0;i<36;i++){ float d=map(pp+ls*tt); res=min(res,7.*d/tt); tt+=clamp(d,.03,.35); if(res<.002||tt>5.)break; }
      sa=.20*(1.-clamp(res,0.,1.));
    }
  }
  vec3 tint=vec3(.42,.62,1.);
  gl_FragColor=vec4(col*edge+tint*sa*(1.-edge), edge+sa*(1.-edge));
}`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  let prog;
  try {
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { console.warn('intro', e); el.remove(); return; }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  const U = {}; for (const n of ['uRes', 'uPpu', 'uK', 'uAmp', 'uT', 'uStem', 'uX1', 'uX2', 'uRing', 'uDot', 'uBound', 'uDotS', 'uScale', 'uRot', 'uShift', 'uTx', 'uTxt', 'uTxtOn', 'uTxS']) U[n] = gl.getUniformLocation(prog, n);

  // ---------- the name as a signed distance field (built once the font is ready) ----------
  const FONT = 200, PAD = 44, RANGE = 40;
  let tx = null;   // { w, h, asc, desc, ink } in texels
  function edt(f, w, h) { // exact squared distance transform (Felzenszwalb), in place
    const n = Math.max(w, h), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n), out = new Float64Array(n);
    const pass = (get, set, len) => {
      for (let i = 0; i < len; i++) g[i] = get(i);
      let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < len; q++) {
        let s2; do { const r = v[k]; s2 = (g[q] + q * q - (g[r] + r * r)) / (2 * q - 2 * r); } while (s2 <= z[k] && --k >= 0);
        k++; v[k] = q; z[k] = s2; z[k + 1] = Infinity;
      }
      k = 0; for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const r = v[k]; out[q] = (q - r) * (q - r) + g[r]; }
      for (let i = 0; i < len; i++) set(i, out[i]);
    };
    for (let x = 0; x < w; x++) pass((i) => f[i * w + x], (i, val) => (f[i * w + x] = val), h);
    for (let y = 0; y < h; y++) pass((i) => f[y * w + i], (i, val) => (f[y * w + i] = val), w);
  }
  function buildText() {
    const c = document.createElement('canvas'), x = c.getContext('2d');
    const font = `760 ${FONT}px "Inter Tight", Inter, sans-serif`;
    x.font = font; try { x.letterSpacing = -0.045 * FONT + 'px'; } catch {}
    const m = x.measureText('Homing'), asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const ink = Math.ceil(m.actualBoundingBoxRight + m.actualBoundingBoxLeft);
    const w = ink + PAD * 2, h = asc + desc + PAD * 2;
    c.width = w; c.height = h; x.font = font; try { x.letterSpacing = -0.045 * FONT + 'px'; } catch {}
    x.fillStyle = '#fff'; x.fillText('Homing', PAD + m.actualBoundingBoxLeft, PAD + asc);
    const a = x.getImageData(0, 0, w, h).data, N = w * h, fo = new Float64Array(N), fi = new Float64Array(N);
    for (let i = 0; i < N; i++) { const on = a[i * 4 + 3] > 127; fo[i] = on ? 0 : 1e20; fi[i] = on ? 1e20 : 0; }
    edt(fo, w, h); edt(fi, w, h);
    const px = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const d = Math.sqrt(fo[i]) - Math.sqrt(fi[i]); px[i] = Math.max(0, Math.min(255, Math.round((0.5 + d / (2 * RANGE)) * 255))); }
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, px);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(U.uTx, 0);
    tx = { w, h, asc, desc, ink };
    name.style.display = 'none';
  }
  (document.fonts?.load ? document.fonts.load(`760 ${FONT}px "Inter Tight"`) : Promise.resolve()).catch(() => {}).then(() => { try { buildText(); } catch (e) { console.warn('intro text', e); } });

  // ---------- the logo's shape (same paths as the 2D mark, 48 x 48 box -> world units) ----------
  const W = (x, y) => [(x - 24) / 20, (25 - y) / 20];
  const cubic = (a, b, c, d, u) => { const v = 1 - u; return [0, 1].map((i) => v * v * v * a[i] + 3 * v * v * u * b[i] + 3 * v * u * u * c[i] + u * u * u * d[i]); };
  const quad = (a, b, c, u) => { const v = 1 - u; return [0, 1].map((i) => v * v * a[i] + 2 * v * u * b[i] + u * u * c[i]); };
  const S0 = W(8, 40), S1 = W(10, 22), S2 = W(21, 15), S3 = W(29.2, 17.8);
  const XA = [W(25.9, 9), W(29, 15.5), W(33.5, 24.5)], XB = [W(34.5, 10.8), W(29.6, 14.5), W(24.6, 26.1)];
  const RC = W(36, 14), RR = 0.4, RS = 0.112, RX = 0.09, RD = 0.21, LW = 2.12;

  // ---------- timing ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const spring = (t, f, d) => (t <= 0 ? 0 : 1 - Math.exp(-d * t) * Math.cos(f * t));
  const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const out3 = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const LAND = 0.3, POUR = 0.34, POUR_D = 0.56, PUFF = 0.86, XS = [1.08, 1.17], SLIDE = 1.62, SLIDE_D = 0.62, END = 3.0;

  let L = 100, ppu = 50, dpr = 1;
  function fit() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, cv.width, cv.height);
    L = Math.min(innerWidth * 0.24, innerHeight * 0.16, 120);
    ppu = L / LW;
    name.style.fontSize = Math.round(L * 0.56) + 'px';
  }
  const stem = new Float32Array(48), x1 = new Float32Array(20), x2 = new Float32Array(20);

  function draw(t) {
    // 1) the drop falls, stretched, and splats into the dot
    const fall = clamp(t / LAND), fy = 1 - fall * fall;
    const land = t > LAND ? Math.exp(-(t - LAND) * 7) * Math.sin((t - LAND) * 26) : 0;
    let dsx = 1, dsy = 1;
    if (t < LAND) { dsy = 1 + 0.45 * fall; dsx = 1 / Math.sqrt(dsy); } else { dsy = 1 - 0.38 * land; dsx = 1 + 0.3 * land; }
    // 2) a stream pours out of it along the stem; the drop gives its body to the stream
    const h = out3((t - POUR) / POUR_D);
    const dotR = RD * (1.9 - 0.9 * clamp(h * 1.15));
    const dotY = S0[1] + fy * 3.0 + dotR * (dsy - 1) * 0.6;
    gl.uniform4f(U.uDot, S0[0], dotY, 0, dotR); gl.uniform3f(U.uDotS, dsx, dsy, (dsx + dsy) / 2);
    const firm = ease((t - POUR - POUR_D + 0.1) / 0.45); // the stream evens out into a clean tube
    let headSet = false;
    for (let i = 0; i < 12; i++) {
      const u = i / 11; let p, r;
      if (h <= 0) { p = S0; r = i === 0 ? RS : 0; }
      else if (u <= h) { p = cubic(S0, S1, S2, S3, u); const w = clamp((h - u) / 0.35); r = RS * (0.62 + 0.38 * w + 0.2 * Math.sin(w * Math.PI) * (1 - h * 0.6)); r += (RS - r) * firm; }
      else if (!headSet) { headSet = true; p = cubic(S0, S1, S2, S3, h); r = RS * (1 + 0.95 * (1 - h)); r += (RS - r) * firm; }
      else { p = cubic(S0, S1, S2, S3, h); r = 0; }
      stem.set([p[0], p[1], 0, r], i * 4);
    }
    gl.uniform4fv(U.uStem, stem);
    // 3) the head puffs up into the ring
    const g = spring(t - PUFF, 10, 5.5), gc = clamp(g);
    if (t > PUFF) {
      const c = [S3[0] + (RC[0] - S3[0]) * gc, S3[1] + (RC[1] - S3[1]) * gc];
      gl.uniform4f(U.uRing, c[0], c[1], RR * Math.max(0, g), RS * (1.9 - 0.9 * gc));
    } else gl.uniform4f(U.uRing, 0, 0, 0, 0);
    // 4) the cross snaps out from its middle
    [[XA, x1, XS[0]], [XB, x2, XS[1]]].forEach(([Q, arr, t0]) => {
      const k = spring(t - t0, 14, 6.5);
      for (let i = 0; i < 5; i++) {
        const u = 0.5 + (i / 4 - 0.5) * Math.max(0, k);
        const p = quad(Q[0], Q[1], Q[2], u);
        arr.set([p[0], p[1], 0, t > t0 ? RX * (0.5 + 0.5 * clamp(k)) : 0], i * 4);
      }
    });
    gl.uniform4fv(U.uX1, x1); gl.uniform4fv(U.uX2, x2);
    // gooey early, crisper as it sets; jelly wobble that calms down
    const set = clamp((t - 0.9) / 0.9);
    gl.uniform1f(U.uK, 0.2 - 0.14 * set);
    const amp = t < LAND ? 0.008 : 0.03 * Math.exp(-(t - LAND) * 1.6) + (t > PUFF ? 0.012 * Math.exp(-(t - PUFF) * 4) : 0);
    gl.uniform1f(U.uAmp, amp); gl.uniform1f(U.uT, t);
    // whole-body jelly: squash on the splat and on the puff, then a soft breath
    const jig = 0.07 * (t > PUFF ? Math.exp(-(t - PUFF) * 5) * Math.sin((t - PUFF) * 22) : 0) + 0.04 * land;
    const breath = 0.012 * Math.sin(t * 5) * set;
    gl.uniform3f(U.uScale, 1 + jig + breath, 1 - jig + breath, 1);
    // turned a little in 3D while forming, faces you as it sets
    const face = ease((t - 0.7) / 0.9);
    const ax = -0.42 * (1 - face), ay = 0.55 * (1 - face) + 0.05 * Math.sin(t * 2.2) * (1 - face);
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    // R = Ry * Rx (row-major); passed as column-major = R transposed = inverse rotation
    gl.uniformMatrix3fv(U.uRot, false, new Float32Array([cy, sy * sx, sy * cx, 0, cx, -sx, -sy, cy * sx, cy * cx]));
    // 5) slides left while the gummy name comes out from behind it (a little jelly overshoot as it stops)
    const sl = ease((t - SLIDE) / SLIDE_D), st = spring(t - SLIDE, 8, 7);
    let shiftW, nameW = 0, gap = L * 0.16, shiftPx = 0;
    if (tx) {
      const wpt = (L * 0.56 / ppu) / FONT, G = 0.36, tw = tx.ink * wpt, left0 = 1.12 + G;
      const rowC = (-1.01 + left0 + tw) / 2;
      shiftW = -rowC * sl;
      const left = left0 - (1 - st) * (tw + G + 0.3);
      const base = -tx.asc * wpt * 0.5;
      gl.uniform4f(U.uTxt, left - PAD * wpt, base - (tx.desc + PAD) * wpt, tx.w * wpt, tx.h * wpt);
      gl.uniform2f(U.uTxtOn, 0.98, t > SLIDE ? 1 : 0); gl.uniform1f(U.uTxS, 2 * RANGE * wpt);
      const bx = shiftW + (-1.01 + Math.max(1.12, left + tw)) / 2;
      gl.uniform4f(U.uBound, bx, 0, (Math.max(1.12, left + tw) + 1.01) / 2 + 0.55, 0);
    } else {
      nameW = word.offsetWidth; shiftPx = ((gap + nameW) / 2) * sl; shiftW = -shiftPx / ppu;
      gl.uniform2f(U.uTxtOn, 0, 0);
      gl.uniform4f(U.uBound, shiftW, t < LAND + 0.1 ? 1.2 : 0, t < LAND + 0.1 ? 3.4 : 1.75, 0);
    }
    if (t < LAND + 0.1) gl.uniform4f(U.uBound, shiftW, 1.2, 3.4, 0);
    gl.uniform2f(U.uShift, shiftW, 0);
    gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform1f(U.uPpu, ppu * dpr);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!tx) name.style.left = innerWidth / 2 - shiftPx + 1.12 * ppu + gap * 0.5 + 'px';
    if (!tx) name.style.top = innerHeight / 2 + 'px';
    if (!tx) word.style.transform = `translateX(${-(nameW + gap) * (1 - sl)}px)`;
  }

  // ---------- sound ----------
  let ac, bus;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    bus = ac.createGain(); bus.gain.value = 1.1; bus.connect(ac.destination);
  } catch {}
  const noise = (d) => { const b = ac.createBuffer(1, Math.ceil(ac.sampleRate * d), ac.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1; const n = ac.createBufferSource(); n.buffer = b; return n; };
  const env = (g, t, peak, a, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); };
  function whoosh(t, d, f0, f1, peak) {
    const n = noise(d), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + d);
    env(g, t, peak, d * 0.8, d); n.connect(f); f.connect(g); g.connect(bus); n.start(t); n.stop(t + d);
  }
  function bloop(t, f0, f1, peak, d = 0.16) {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + d * 0.55);
    env(g, t, peak, 0.008, d); o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.02);
  }
  function thump(t, peak) {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.14);
    env(g, t, peak, 0.006, 0.22); o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.24);
  }
  function stretch(t, d) { // a soft rubbery squeak while the stream pulls out
    const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), lp = ac.createBiquadFilter(), g = ac.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(620, t + d);
    lfo.frequency.value = 17; lg.gain.value = 18; lfo.connect(lg); lg.connect(o.frequency);
    lp.type = 'lowpass'; lp.frequency.value = 1800; env(g, t, 0.05, d * 0.3, d);
    o.connect(lp); lp.connect(g); g.connect(bus); o.start(t); lfo.start(t); o.stop(t + d + 0.02); lfo.stop(t + d + 0.02);
  }
  function tick(t, peak, f = 4600) {
    const n = noise(0.03), bp = ac.createBiquadFilter(), g = ac.createGain(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
    env(g, t, peak, 0.0015, 0.025); n.connect(bp); bp.connect(g); g.connect(bus); n.start(t); n.stop(t + 0.03);
  }
  function score() {
    if (!ac) return;
    const t = ac.currentTime + 0.02;
    bloop(t, 1300, 520, 0.05, 0.28);                                   // the drop falls
    thump(t + LAND, 0.3); bloop(t + LAND, 170, 760, 0.26, 0.16);       // splat
    stretch(t + POUR, POUR_D);                                         // the stream pulls out
    [0.42, 0.55, 0.68, 0.79].forEach((x, i) => bloop(t + x, 420 + i * 90, 900 + i * 120, 0.06, 0.07)); // little blubs
    bloop(t + PUFF + 0.02, 260, 1250, 0.2, 0.18);                      // puffs into the ring
    XS.forEach((x, i) => { tick(t + x + 0.02, 0.2, i ? 4300 : 5200); bloop(t + x + 0.02, 700 + i * 160, 1500, 0.08, 0.08); }); // the cross snaps
    whoosh(t + SLIDE, SLIDE_D * 0.9, 2400, 600, 0.06);                 // the name slides out
    tick(t + SLIDE + SLIDE_D - 0.04, 0.22, 3600); bloop(t + SLIDE + SLIDE_D - 0.02, 300, 620, 0.08, 0.12);
  }

  // ---------- play ----------
  let t0 = performance.now(), gone = false, played = false, raf = 0, timer;
  const leave = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => { cancelAnimationFrame(raf); el.remove(); gl.getExtension('WEBGL_lose_context')?.loseContext(); }, 560); };
  const loop = () => { if (window.__introHold) return; draw((performance.now() - t0) / 1000); raf = requestAnimationFrame(loop); };
  const start = () => { t0 = performance.now(); clearTimeout(timer); timer = setTimeout(leave, END * 1000); cancelAnimationFrame(raf); loop(); };
  window.__introSeek = (t) => { window.__introHold = true; cancelAnimationFrame(raf); draw(t); };
  fit(); addEventListener('resize', fit);
  if (ac && ac.state === 'running') { played = true; score(); }
  else ac?.resume?.().then(() => { if (ac.state === 'running' && !played) { played = true; score(); } }).catch(() => {});
  el.addEventListener('pointerdown', () => {
    if (played || !ac) return leave();
    ac.resume().then(() => { played = true; start(); score(); }).catch(leave);
  });
  start();
}
