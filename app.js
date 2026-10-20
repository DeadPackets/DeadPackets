import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import Lenis from 'lenis';
import { FLAG, LAPTOP } from './ui.js';
import { asciiBg } from './ascii.js';
import { makeTerm, AD } from './term.js';

const root = document.documentElement;
const qs = new URLSearchParams(location.search);
const VERIFY = qs.get('verify'); // 'old' | 'new': straight-on orthographic render for qa/verify.py
const LIT = qs.get('lit') === '1';
const OG = qs.get('og') === '1'; // social card: both laptops + title, screenshot by qa/og.mjs
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(max-width: 820px)').matches;
// old lid pose in the stage photo (me-2400.webp): cv2.solvePnP on the fitted lid quad, f = 2800 px
const PHOTO = { w: 1600, h: 1066, f: 2800, quad: [[700, 566], [1119.5, 588.6], [1136.4, 874], [715.1, 876.7]],
  m: [0.966401, -0.040314, -0.253859, 0, -0.039127, 0.953042, -0.300299, 0, 0.254045, 0.300142, 0.919443, 0, 0.941265, -1.475743, -21.636253, 1] }; // real MateBook D16 lid (356.7 x 248 mm): 3.5 px max reprojection error
const LIDW = { old: 3.4, new: 3.1 }; // world units; the old 15.6" lid is wider than the new 14"
console.log('%cEvery sticker here is cut from a photo of my laptop lids. Press ~ for a shell.', 'font:600 13px monospace');

let renderer;
if (VERIFY) verify().catch((e) => { window.__verify = 'error: ' + e.message; });
else if (reduce) goStatic();
else {
  try {
    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('lid'), antialias: true, alpha: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no gl');
    start().catch((e) => { console.error(e); goStatic(); });
  } catch { goStatic(); }
}
function goStatic() { root.classList.remove('gl'); root.classList.add('static'); }

// ---------- shared builders ----------
const loader = new THREE.TextureLoader();
const loadTex = (url, srgb = true) => new Promise((ok, no) => loader.load(url, (t) => { if (srgb) t.colorSpace = THREE.SRGBColorSpace; ok(t); }, undefined, no));
const srgbColor = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
const lidDims = (k, lid) => { const W = LIDW[k]; return { W, H: W * lid.h / lid.w, s: W / lid.w }; };
// a completed sticker = its visible texture + a fill layer (fbox) holding only the part other stickers hide; lid px, y down
function contactShadow(bb, parent) { // a soft dark pool under an object, so it sits on something instead of floating
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(0.55, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const sh = new THREE.Mesh(new THREE.PlaneGeometry((bb.max.x - bb.min.x) * 1.35, (bb.max.z - bb.min.z) * 1.5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  sh.rotation.x = -Math.PI / 2; sh.position.set((bb.min.x + bb.max.x) / 2, bb.min.y - 0.002, (bb.min.z + bb.max.z) / 2); sh.renderOrder = -1; parent.add(sh);
}
function fillGeo(e, s, seg = 1) { const [x, y, w, h] = e.fbox; return new THREE.PlaneGeometry(w * s, h * s, seg, seg).translate((x + w / 2 - e.x - e.w / 2) * s, -(y + h / 2 - e.y - e.h / 2) * s, 0); }


const CURL = 'vec2 cp = position.xy; float cs = dot(cp - uC, uD); bool cin = uL > 0.0 && cs < uL; float cu = uL - cs; float cth = min(cu / uR, uTh);', curl = CURL;
const BEND = `{ ${CURL} if (cin) { float r = max(cu - uTh * uR, 0.0); float s2 = uL - uR * sin(cth) - r * cos(uTh); float z = uR * (1.0 - cos(cth)) + r * sin(uTh); transformed.xy += uD * (s2 - cs); transformed.z += z + 0.002 + uLift * smoothstep(0.0, uTh * uR, cu); } }`;
const CURL_U = 'uniform vec2 uC; uniform vec2 uD; uniform float uL; uniform float uR; uniform float uLift; uniform float uTh;';
// the bent sticker projected along the key light onto the lid plane (stk space); softer and fainter the higher it lifts
function shadowMat(tex, u, w, h, half) {
  const su = { uM: { value: new THREE.Matrix4() }, uLd: { value: new THREE.Vector3(0, 0, -1) }, uZ: { value: 0 }, uOp: { value: 0 }, uHalf: { value: half },
    uSz: { value: tex.image.width / w * 0.3 }, uCt: { value: Math.min(w, h) * 0.03 }, uHm: { value: Math.max(w, h) * 1.2 } };
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  mat.userData.su = su;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, su);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${CURL_U} uniform mat4 uM; uniform vec3 uLd; uniform float uZ; varying float vH; varying vec2 vP;`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);\n${BEND}\nvec3 P = (uM * vec4(transformed, 1.0)).xyz; vH = P.z - uZ; P -= uLd * (vH / uLd.z); vP = P.xy; transformed = P;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uHalf; uniform float uSz; uniform float uOp; uniform float uCt; uniform float uHm; varying float vH; varying vec2 vP;')
      .replace('#include <map_fragment>', 'if (abs(vP.x) > uHalf.x || abs(vP.y) > uHalf.y) discard;\nfloat sa = texture2D(map, vMapUv, log2(1.0 + max(vH, 0.0) * uSz)).a;\ndiffuseColor = vec4(0.0, 0.0, 0.0, sa * uOp * smoothstep(0.0, uCt, vH) * (1.0 - smoothstep(0.0, uHm, vH)));');
  };
  return mat;
}

function vinyl(e, tex, foilTex, back, shared) { // shared: uniforms of the sticker a fill layer belongs to
  const holo = e.holo || 0;
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, // two-pass flips gl_FrontFacing
    roughness: 0.42, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.2, alphaTest: 0.02, // alphaTest: no lighting on empty texels
    iridescence: holo * 0.2, iridescenceIOR: 1.5, iridescenceThicknessRange: [150, 520],
  });
  if (foilTex) Object.assign(mat, { metalnessMap: foilTex, roughnessMap: foilTex, metalness: 1, roughness: 1 }); // G = roughness, B = metalness
  const u = shared || { uC: { value: new THREE.Vector2() }, uD: { value: new THREE.Vector2(1, 0) }, uL: { value: 0 }, uR: { value: 0.03 }, uTh: { value: Math.PI }, uLift: { value: 0.05 },
    uBack: { value: back }, uHolo: { value: holo }, uTilt: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + CURL_U)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = vec3(normal);\n{ ${curl} if (cin) objectNormal = vec3(uD * sin(cth), cos(cth)); }`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);\n${BEND}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uBack; uniform float uHolo; uniform float uTilt;')
      .replace('#include <map_fragment>', 'vec4 sdc = texture2D(map, vMapUv);\nif (!gl_FrontFacing) sdc.rgb = texture2D(uBack, vec2(1.0 - vMapUv.x, vMapUv.y)).rgb;\ndiffuseColor *= sdc;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (!gl_FrontFacing) roughnessFactor = 0.14;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (!gl_FrontFacing) metalnessFactor = 1.0;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (!gl_FrontFacing) {
  float bv = 1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0);
  totalEmissiveRadiance += (0.5 + 0.5 * cos(6.28318 * (bv * 1.8 + vMapUv.x * 0.9 + uTilt * 0.6 + vec3(0.0, 0.33, 0.67)))) * (0.16 + 0.22 * bv);
}
if (uHolo > 0.0 && gl_FrontFacing) {
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  float t = ndv * 2.4 + (vMapUv.x * 1.4 + vMapUv.y * 0.8) + uTilt * 2.0;
  vec3 rb = 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  float lum = dot(sdc.rgb, vec3(0.299, 0.587, 0.114));
  float shift = pow(1.0 - ndv, 1.5) * 1.6 + smoothstep(0.05, 0.4, abs(uTilt)); // flat-on: the print's own green; grazing or tilted: the foil shows
  totalEmissiveRadiance += rb * uHolo * min(shift, 1.0) * (0.035 + 0.3 * smoothstep(0.03, 0.22, lum)); // lum is linear: the green print is ~0.17
}`);
  };
  return { mat, u };
}

// ---------- qa: straight-on orthographic render at rectified resolution ----------
async function verify() {
  const all = await (await fetch('stickers.json')).json();
  const data = all[VERIFY], lid = data.lid, { W, H, s } = lidDims(VERIFY, lid);
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  r.setPixelRatio(1); r.setSize(lid.w, lid.h, false); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.01, 10); cam.position.z = 5;
  if (LIT) { // near-flat: uniform white environment, no direct lights
    // uniform white dome with a black flag behind the camera: flat diffuse light, no clearcoat glare (35 deg flag blocks 33% of irradiance)
    const env = new THREE.Scene(); env.add(new THREE.Mesh(new THREE.SphereGeometry(5), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })));
    const flag = new THREE.Mesh(new THREE.CircleGeometry(5 * Math.tan(THREE.MathUtils.degToRad(35)), 48), new THREE.MeshBasicMaterial({ color: 0, side: THREE.DoubleSide }));
    flag.position.z = 4.2; env.add(flag);
    scene.environment = new THREE.PMREMGenerator(r).fromScene(env, 0).texture; scene.environmentIntensity = 1.49 * 1.315; // 1.315: measured photo/render ratio (clearcoat + PMREM losses)
  }
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: srgbColor(lid.base_rgb) })));
  if (lid.logo) { const L = lid.logo, lm = new THREE.Mesh(new THREE.PlaneGeometry(L.w * s, L.h * s), new THREE.MeshBasicMaterial({ map: await loadTex(L.file), transparent: true, depthWrite: false })); lm.position.set((L.x + L.w / 2) * s - W / 2, H / 2 - (L.y + L.h / 2) * s, 0.0005); lm.renderOrder = -10; scene.add(lm); }
  const items = [...data.stickers].sort((a, b) => a.z - b.z);
  const texs = await Promise.all(items.map((e) => loadTex(e.file)));
  const fills = await Promise.all(items.map((e) => (e.fill ? loadTex(e.fill) : null)));
  const foils = await Promise.all(items.map((e) => (e.foil ? loadTex(e.foil, false) : null)));
  items.forEach((e, i) => {
    const t = texs[i]; t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter;
    const mat = LIT ? vinyl(e, t, foils[i], t).mat : new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(e.w * s, e.h * s), mat);
    m.position.set((e.x + e.w / 2) * s - W / 2, H / 2 - (e.y + e.h / 2) * s, 0.001); m.renderOrder = e.z * 2 + 1;
    scene.add(m);
    if (fills[i]) { // the completed sticker: fill layer over its own visible texture, under every higher sticker
      const f = fills[i]; f.generateMipmaps = false; f.minFilter = f.magFilter = THREE.LinearFilter;
      const fm = new THREE.Mesh(fillGeo(e, s), LIT ? vinyl(e, f, null, f).mat : new THREE.MeshBasicMaterial({ map: f, transparent: true, depthWrite: false }));
      fm.renderOrder = e.z * 2 + 2; m.add(fm);
    }
  });
  r.render(scene, cam);
  window.__verify = canvas.toDataURL('image/png');
}

// ---------- the page: one scroll-driven keynote ----------
// Every <section data-scene> is a moment. Native scroll + settle() pick the moment; a spring-smoothed copy of the scroll position drives
// the photo, the camera and both 3D laptops, so motion has weight and settles softly on each moment.
const FOV0 = THREE.MathUtils.degToRad(30); // free camera; the photo phase uses the stage photo's own lens
async function start() {
  const all = await (await fetch('stickers.json')).json();
  await document.fonts.load('600 30px "JetBrains Mono"').catch(() => {});
  const canvas = renderer.domElement, photoBox = document.querySelector('.photo'), photo = photoBox.querySelector('img'), heroFig = document.querySelector('.hero-fig');
  let dpr = Math.min(devicePixelRatio, mobile ? 1.5 : 1.75); renderer.setPixelRatio(dpr); // 1.5-1.75 looks the same as 2 on a moving scene at ~45% fewer pixels
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new THREE.Scene(), pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.95;
  const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(-3, 5, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9cc2ff, 2.6); rim.position.set(5, 3, -7); scene.add(rim); // cool edge light: the keynote outline
  const chromeEnv = pm.fromScene(softboxRoom(), 0.01).texture;
  const FOVP = 2 * Math.atan(PHOTO.h / 2 / PHOTO.f);
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOVP), PHOTO.w / PHOTO.h, 0.5, 400);

  // ---------- laptops ----------
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), models = Object.fromEntries(Object.entries({ old: 'matebook-d16', new: 'macbook-pro-16' }).map(([k, f]) => [k, Promise.all([fetch(`models/${f}.json`).then((r) => r.json()), gltfLoader.loadAsync(`models/${f}.glb`)])])); // glb: models/build.py output, then gltfpack -c -kn -km -kv -ke -vtf (meshopt; -vtf: the key legends are drawn in code, so UVs stay float, ~85% smaller over the wire)
  const printerM = Promise.all([fetch('models/printer.json').then((r) => r.json()), gltfLoader.loadAsync('models/printer.glb'), loadTex('screens/ticket.webp')]);
  const shots = {}; const shotTex = (n) => (shots[n] ||= loadTex(`screens/${n}.webp`).then((t) => { t.anisotropy = maxAniso; renderer.initTexture(t); return t; })); // uploaded on arrival, not on the transition frame that first shows it
  async function buildLaptop(k) {
    const data = all[k], lid = data.lid, [info, gltf] = await models[k], { W, H, D } = info, s = W / lid.w, dark = k === 'new';
    const alu = new THREE.MeshPhysicalMaterial({ color: srgbColor(lid.base_rgb), metalness: 0.7, roughness: dark ? 0.42 : 0.34, clearcoat: 0.2, clearcoatRoughness: 0.3 });
    const root = new THREE.Group(), pivot = new THREE.Group(), lidG = new THREE.Group(), stk = new THREE.Group();
    root.add(pivot); pivot.add(lidG); lidG.position.y = H / 2; scene.add(root);
    stk.scale.y = (H / lid.h) / s; lidG.add(stk); // the lid photo was flattened at another aspect: stretch the sticker layout to the real lid
    const lidMat = alu.clone(); Object.assign(lidMat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
    // Blender model (models/build.py): lid_* parts live in the lid frame, the rest in the hinge frame
    const M = { alu, lid_shell: lidMat, black: new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.55, metalness: 0.3 }),
      key: new THREE.MeshStandardMaterial({ map: keyTex(info, dark), roughness: 0.62 }), glass: new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.12, clearcoat: 1 }),
      trackpad: new THREE.MeshPhysicalMaterial({ color: srgbColor(lid.base_rgb), metalness: 0.45, roughness: 0.28, clearcoat: 0.4 }), port: new THREE.MeshBasicMaterial({ color: 0x030303 }),
      grille: new THREE.MeshStandardMaterial({ color: srgbColor(lid.base_rgb.map((c) => c * 0.62)), metalness: 0.6, roughness: 0.6 }), chamfer: new THREE.MeshPhysicalMaterial({ color: 0xd8dade, metalness: 1, roughness: 0.12 }) };
    let shell = null, base = null;
    for (const node of [...gltf.scene.children]) {
      node.traverse((o) => { if (o.isMesh) o.material = M[o.name === 'lid_shell' ? 'lid_shell' : o.material.name] || alu; if (o.name.startsWith('lid_notch')) o.visible = false; }); // owner's call: no notch on the MacBook
      if (node.name === 'lid_shell') shell = node; if (node.name === 'base') base = node;
      (node.name.startsWith('lid_') ? lidG : root).add(node);
    }
    const bb = new THREE.Box3().setFromObject(base); contactShadow(bb, root);
    // display: two layers so project screenshots can cross-fade, sized to the model's screen
    const dw = info.display.w, dh = info.display.h, displays = [0, 1].map((i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(dw, dh), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0, depthWrite: false }));
      m.position.set(0, info.display.cy, -info.lid_t - 0.0021 - i * 0.0004); m.rotation.y = Math.PI; m.renderOrder = 5 + i; lidG.add(m); return m;
    });
    const items = [...data.stickers].sort((a, b) => a.z - b.z), dirOf = (e) => (mobile || !e.story ? 'stickers/m/' : 'stickers/'); // full res only for the 11 stickers presented large; m/ is already sharper than the lid needs
    const batch = items.flatMap((e) => [loadTex(e.file.replace('stickers/', dirOf(e))), e.foil ? loadTex(e.foil.replace('stickers/', dirOf(e)), false) : null, e.fill ? loadTex(e.fill.replace('stickers/', dirOf(e))) : null]);
    if (lid.logo) { // the laptop's own logo: chrome, under every sticker
      const L = lid.logo, lm = new THREE.Mesh(new THREE.PlaneGeometry(L.w * s, L.h * s), new THREE.MeshPhysicalMaterial({ map: await loadTex(L.file.replace('stickers/', mobile ? 'stickers/m/' : 'stickers/')), transparent: true, depthWrite: false, metalness: 1, roughness: dark ? 0.14 : 0.3, color: dark ? 0xeef0f4 : 0xb4b8be, envMap: chromeEnv, envMapIntensity: 1.6, clearcoat: 0.4 }));
      lm.position.set((L.x + L.w / 2) * s - W / 2, lid.h * s / 2 - (L.y + L.h / 2) * s, 0.0005); lm.renderOrder = (k === 'new' ? 1000 : 0) - 10; stk.add(lm);
    }
    // stickers (requests already in flight, started before the logo)
    const all3 = await Promise.all(batch);
    const texs = items.map((_, i) => all3[i * 3]), foils = items.map((_, i) => all3[i * 3 + 1]), fills = items.map((_, i) => all3[i * 3 + 2]);
    const stickers = items.map((e, i) => {
      const tex = texs[i]; tex.anisotropy = maxAniso;
      const w = e.w * s, h = e.h * s, seg = mobile ? 20 : 32;
      const { mat, u } = vinyl(e, tex, foils[i], backTex(e.id === 'defcon', e.w / e.h));
      if (foils[i]) Object.assign(mat, { envMap: chromeEnv, envMapIntensity: 1.25, clearcoat: 0.35 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, seg, seg), mat);
      let fill = null;
      if (fills[i]) { fills[i].anisotropy = maxAniso; fill = new THREE.Mesh(fillGeo(e, s, Math.max(2, Math.round(seg * Math.max(e.fbox[2] / e.w, e.fbox[3] / e.h)))), vinyl(e, fills[i], null, backTex(false, 1), u).mat); mesh.add(fill); }
      const grp = new THREE.Group(); grp.position.set((e.x + e.w / 2) * s - W / 2, lid.h * s / 2 - (e.y + e.h / 2) * s, e.z * 0.00004 + 0.002); grp.add(mesh); stk.add(grp);
      mesh.renderOrder = (k === 'new' ? 1000 : 0) + e.z * 4 + 2; if (fill) fill.renderOrder = mesh.renderOrder + 1;
      const shadow = new THREE.Mesh(mesh.geometry, shadowMat(tex, u, w, h, new THREE.Vector2(W / 2, lid.h * s / 2))); shadow.frustumCulled = false; shadow.visible = false; shadow.renderOrder = 9002; stk.add(shadow);
      const st = { ...e, lid: k, w, h, grp, mesh, fill, shadow, u, img: tex.image, home: grp.position.clone(), ro: mesh.renderOrder, peel: 0, peelTarget: 0, pres: 0 };
      mesh.userData.s = st; return st;
    });
    return { k, root, pivot, lidG, stk, W, H, D, bb, stickers, displays, body: [base, shell] };
  }
  const [lo, ln] = await Promise.all([buildLaptop('old'), buildLaptop('new')]), lps = { old: lo, new: ln };
  // FaxMeMaybe's thermal printer beside the MacBook in its project moment; the ticket prints once the moment settles
  const [pInfo, pGltf, paperTex] = await printerM, printer = new THREE.Group(), PM = {
    shell: new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: 0.45, clearcoat: 0.25 }), cover: new THREE.MeshPhysicalMaterial({ color: 0x15171b, roughness: 0.3, clearcoat: 0.6 }),
    slot: new THREE.MeshBasicMaterial({ color: 0x000000 }), tear: new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 1, roughness: 0.25 }),
    led: new THREE.MeshBasicMaterial({ color: 0x3dff86, toneMapped: false }), push: new THREE.MeshStandardMaterial({ color: 0xadb0b4, roughness: 0.6 }), button: new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5 }) };
  for (const node of [...pGltf.scene.children]) { node.traverse((o) => { if (o.isMesh) o.material = PM[o.material.name] || PM.shell; }); printer.add(node); }
  contactShadow(new THREE.Box3().setFromObject(printer), printer);
  printer.visible = false; lps.new.root.add(printer); const nbb = lps.new.bb;
  // the ticket: prints upright out of the slot; grab it and it tears off into your hand (a verlet strip hanging from the cursor); let go and it drops, fades, and the next one prints
  const PL = pInfo.slot.w * 1260 / 640, PN = 48, DS = PL / PN, HW = pInfo.slot.w / 2, PG = -94, BX = pInfo.W / 2 + 0.01, BY = pInfo.H + 0.006, BZ = pInfo.D / 2 + 0.01; // 1 unit ~ 104 mm: g ~ 94 units/s^2
  const SLOT = new THREE.Vector3(0, pInfo.slot.y, pInfo.slot.z), pv = new THREE.Vector3();
  // FaxMeMaybe's own ticket layout (screens/ticket.webp), with the changing parts redrawn: priority, task, tags, due date, sender, print time
  const TASKS = [[4, 'URGENT', 'Add your sticker to the collection', ['stickers', 'deadpackets.pw'], 0, 'a visitor'], [3, 'HIGH', 'Email Youssef about that role', ['hiring', 'youssef@ctf.ae'], 1, 'a recruiter'],
    [2, 'MEDIUM', 'Write the next CTF challenge', ['ctf', 'ctf.ae'], 3, 'the CTFae team'], [1, 'LOW', 'Touch grass', ['health', 'outside'], 7, 'your body'], [3, 'HIGH', 'Refill the paper roll', ['hardware', 'faxmemaybe'], 0, 'this printer']];
  let taskI = 0;
  const ticketArt = (t) => {
    const [fl, lvl, title, tags, due, from] = TASKS[taskI++ % TASKS.length], x = t.cv.getContext('2d'), img = paperTex.image, F = (w, px) => `${w} ${px}px Inter, "DM Sans", system-ui, sans-serif`, day = (d) => new Date(Date.now() + d * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    x.drawImage(img, 0, 0, 640, 1260); x.fillStyle = '#fff'; x.fillRect(44, 84, 552, 136); x.fillRect(44, 270, 552, 345); x.fillRect(44, 1128, 552, 48);
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#000';
    for (let k = 0; k < fl; k++) x.drawImage(img, 186, 92, 52, 62, 320 - fl * 36 + k * 72 + 10, 92, 52, 62); // the flame icon, once per priority level
    x.font = F(700, 23); x.letterSpacing = '1px'; x.fillText(lvl, 320, 196); x.letterSpacing = '0px';
    x.font = F(800, 46); const words = title.split(' '), lines = [''];
    for (const w of words) { const tl = (lines.at(-1) + ' ' + w).trim(); if (x.measureText(tl).width > 470 && lines.at(-1)) lines.push(w); else lines[lines.length - 1] = tl; }
    let y = lines.length > 1 ? 316 : 346; for (const ln of lines.slice(0, 2)) { x.fillText(ln, 320, y); y += 60; }
    x.font = F(600, 20); const tw = tags.map((g) => x.measureText(g).width + 36), rw = 28 + 12 + tw.reduce((a, b) => a + b + 12, -12); let tx = 320 - rw / 2;
    x.drawImage(img, 138, 452, 32, 34, tx, 452, 32, 34); tx += 40; x.textAlign = 'left'; x.lineWidth = 2; x.strokeStyle = '#000';
    tags.forEach((g, k) => { x.strokeRect(tx + 1, 447, tw[k] - 2, 46); x.fillText(g, tx + 18, 470); tx += tw[k] + 12; });
    const row = (ix, iy, txt, ty) => { x.font = F(600, 24); const w = 30 + 14 + x.measureText(txt).width, l = 320 - w / 2; x.drawImage(img, ix, iy, 34, 36, l - 2, ty - 18, 34, 36); x.fillText(txt, l + 44, ty); };
    row(190, 523, `Due: ${day(due)}`, 541); row(214, 570, `From: ${from}`, 588);
    x.textAlign = 'center'; x.font = F(500, 19); x.fillText(`${day(0)}, ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} • Powered by FaxMeMaybe`, 320, 1152);
    t.tex.needsUpdate = true;
  };
  const POOLTEX = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 2, 32, 32, 32); g.addColorStop(0, '#fff'); g.addColorStop(0.5, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const under = (q) => { let y = 0; if (Math.abs(q.x) < BX && Math.abs(q.z) < BZ && q.y >= BY - 0.02) y = BY; // what the paper would land on: the printer top, the MacBook deck, or the desk
    const ob = OBS[0], v = cv1.copy(q).applyMatrix4(ob.M), b = ob.b; if (v.x > b.min.x && v.x < b.max.x && v.z > b.min.z && v.z < b.max.z && v.y >= b.max.y - 0.02) y = Math.max(y, cv1.set(v.x, b.max.y, v.z).applyMatrix4(ob.Mi).y); return y; };
  const poolDraw = (t) => { // contact shadow: a soft pool under the paper, darker and tighter the closer it gets
    const n = t.p.length; if (n < 2 || !t.mesh.visible) { t.pool.visible = false; return; }
    let hMin = 1e9, wsum = 0, cx = 0, cz = 0, cy = 0, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < n; i += 4) { const q = t.p[i], y = under(q), hh = Math.max(0, q.y - y), w = Math.exp(-hh * 3); hMin = Math.min(hMin, hh); wsum += w; cx += q.x * w; cz += q.z * w; cy += y * w; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    const k = Math.exp(-hMin * 1.6); t.pool.visible = k > 0.03; if (!t.pool.visible) return;
    t.pool.position.set(cx / wsum, cy / wsum + 0.004, cz / wsum); t.pool.scale.set(x1 - x0 + 2 * HW * 0.8 + hMin * 0.8, 1, z1 - z0 + 0.35 + hMin * 0.8); t.pool.material.opacity = 0.55 * k * t.mat.opacity;
  };
  const strip = () => {
    const pos = new Float32Array((PN + 1) * 6), uv = new Float32Array((PN + 1) * 4), idx = [], geo = new THREE.BufferGeometry();
    for (let q = 0; q < PN; q++) idx.push(q * 2, q * 2 + 1, q * 2 + 2, q * 2 + 1, q * 2 + 3, q * 2 + 2);
    for (let q = 0; q <= PN; q++) uv.set([0, 1 - q / PN, 1, 1 - q / PN], q * 4);
    geo.setIndex(idx); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setDrawRange(0, 0);
    const cv = Object.assign(document.createElement('canvas'), { width: 640, height: 1260 }), tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.78, side: THREE.DoubleSide, transparent: true, envMapIntensity: 0.45 }); // mostly lit by the key light, so a bend or curl reads as light and shade
    mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      float grain = fract(sin(dot(floor(vMapUv * vec2(640.0, 1260.0)), vec2(12.9898, 78.233))) * 43758.5453);
      if (!gl_FrontFacing) diffuseColor.rgb = mix(vec3(0.92, 0.91, 0.88), diffuseColor.rgb, 0.14);
      diffuseColor.rgb *= 0.975 + 0.04 * grain;`).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n      totalEmissiveRadiance += diffuseColor.rgb * 0.06;'); }; // fibre grain, blank back with the print faintly showing through, a little light through the sheet
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.visible = false; printer.add(mesh);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: POOLTEX, color: 0x000000, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2 })); pool.visible = false; printer.add(pool);
    return { mesh, geo, pos, cv, tex, mat, pool, p: [], o: [], mode: 'off', len: 0, wait: 0, a: 1 }; // mode: off, wait, print, idle (printed, upright), held (in your hand), fade
  };
  const tickets = [strip(), strip()]; let tk = 0, pgrab = null, paperLive = false; // tickets[tk] is the one in the slot; the other is in your hand or fading
  const resetTicket = (t, mode = 'off', wait = 0) => { t.p.length = t.o.length = 0; t.q = null; t.s0 = null; t.pool.visible = false; t.len = 0; t.mode = mode; t.wait = wait; t.a = 1; t.mat.opacity = 1; t.mesh.visible = false; t.geo.setDrawRange(0, 0); };
  resetTicket(tickets[0], 'wait');
  let BACK = 1; const K0 = 0.12, KC = 0.45 / PL; // leaves the slot tilted back 7 deg, then curls back steadily (roll memory): ~33 deg at the tip
  const upright = (t, now) => { // printed paper rises out of the slot in a gentle backward arc, swaying a little in the draft
    const n = Math.min(PN, Math.ceil(t.len / DS)) + 1; t.p.length = t.o.length = n;
    for (let i = 0; i < n; i++) { const sd = Math.max(0, t.len - i * DS), k = sd / PL; t.p[i] ??= new THREE.Vector3(); t.o[i] ??= new THREE.Vector3();
      const kc = KC * (1 + 0.06 * Math.sin(now * 0.0013)), th = K0 + kc * sd; t.p[i].set(0.012 * PL * k * k * Math.sin(now * 0.0009), SLOT.y + (Math.sin(th) - Math.sin(K0)) / kc, SLOT.z + BACK * (Math.cos(K0) - Math.cos(th)) / kc); t.o[i].copy(t.p[i]); } // o = p: no velocity, so a grab never flings it
  };
  // held or falling: a paper strip of 12 segments, XPBD with small steps (Macklin 2019): midpoint bending, exact length, quadratic air drag on its face. The 48-segment mesh is a spline through it
  const QN = 12, BEND = 4e-6, DRAG = 1.36, KA = 0.42, XA = new THREE.Vector3(1, 0, 0), tn = new THREE.Vector3(), nn = new THREE.Vector3(), pd = new THREE.Vector3(); // DRAG: 0.5 rho Cd / (55 g/m^2) in scene units; KA: 55 g/m^2 of paper / (55 + ~75 g/m^2 of air it must push face-on); BEND: floppy front to back like a receipt, slow to settle
  const sides = (t, p, out = (t.sd ??= []), start = t.s0 || XA) => { // the sheet's width at each node, carried down from the top (parallel transport): it can turn but never flips
    const n = p.length; for (let i = 0; i < n; i++) { const s0 = (out[i] ??= new THREE.Vector3()), prev = i ? out[i - 1] : start; tn.subVectors(p[Math.min(n - 1, i + 1)], p[Math.max(0, i - 1)]).normalize(); s0.copy(prev).addScaledVector(tn, -prev.dot(tn)).normalize(); } };
  const collide = (q) => { q.y = Math.max(q.y, 0.004); const dx = BX - Math.abs(q.x), dy = BY - q.y, dz = BZ - Math.abs(q.z);
    if (dx > 0 && dy > 0 && dz > 0) { if (dy <= dx && dy <= dz) q.y = BY; else if (dz <= dx) q.z = Math.sign(q.z) * BZ; else q.x = Math.sign(q.x) * BX; } // stays out of the printer body
    for (const ob of OBS) { const v = cv1.copy(q).applyMatrix4(ob.M), b = ob.b; if (!b.containsPoint(v)) continue; // and out of the MacBook's base and lid, each a box in its own frame
      const d = [v.x - b.min.x, b.max.x - v.x, v.y - b.min.y, b.max.y - v.y, v.z - b.min.z, b.max.z - v.z], k = d.indexOf(Math.min(...d)); v.setComponent(k >> 1, k & 1 ? b.max.getComponent(k >> 1) : b.min.getComponent(k >> 1)); q.copy(v.applyMatrix4(ob.Mi)); } };
  const cv1 = new THREE.Vector3(), cv2 = new THREE.Vector3(), cv3 = new THREE.Vector3();
  const OBS = lps.new.body.map((node) => { node.updateWorldMatrix(true, true); const inv = new THREE.Matrix4().copy(node.matrixWorld).invert(), b = new THREE.Box3(), m4 = new THREE.Matrix4();
    node.traverse((m) => { if (m.isMesh) { m.geometry.computeBoundingBox(); b.union(m.geometry.boundingBox.clone().applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld))); } }); return { node, b: b.expandByScalar(0.012), M: new THREE.Matrix4(), Mi: new THREE.Matrix4() }; });
  const collideSheet = (q, sd) => { cv2.set(0, 0, 0); for (const off of [0, HW, -HW]) { cv3.copy(q).addScaledVector(sd, off); const was = cv1.copy(cv3); collide(cv3); cv3.sub(was.copy(q).addScaledVector(sd, off)); if (cv3.lengthSq() > cv2.lengthSq()) cv2.copy(cv3); } q.add(cv2); }; // the sheet is 8 cm wide: its edges collide too
  const along = (p, sAt, out) => { const u = Math.min(sAt / DS, p.length - 1.0001), k = Math.floor(u); return out.lerpVectors(p[k], p[k + 1], u - k); }; // a point on the printed strip by arc length
  const tearOff = (t) => { // the printed strip becomes the physics strip
    const L = (t.p.length - 1) * DS, m = Math.max(3, Math.round(QN * L / PL) + 1); t.ds = L / (m - 1); t.q = []; t.qo = [];
    for (let j = 0; j < m; j++) { t.q.push(along(t.p, j * t.ds, new THREE.Vector3())); t.qo.push(t.q[j].clone()); } t.qv = t.q.map(() => new THREE.Vector3()); t.qs = [];
    t.s0 = XA.clone().addScaledVector(tn.subVectors(t.q[1], t.q[0]).normalize(), -tn.x).normalize(); t.hand = t.q[0].clone(); // the width as printed; the hand starts where the paper is
    t.mode = 'held'; tk = tickets.indexOf(t) ^ 1; resetTicket(tickets[tk]); // the slot is empty until you let go
  };
  const paperStep = (t, h) => {
    const q = t.q, o = t.qo, m = q.length, held = pgrab?.t === t, w = (i) => (held && i < 2 ? 0 : 1), a = BEND / (h * h), ct = t.mode === 'fade' ? 1 - 0.97 ** (h * 120) : 0; // a little extra drag once let go, so it floats down in view
    if (held) { t.hand.lerp(pgrab.to, 1 - Math.exp(-h / 0.035)); t.hd.lerp(cv3.set(0, -1, 0), 1 - Math.exp(-h / 0.25)).normalize(); // torn off, the sheet swings upright under the pinch
      for (let k = 0; k < 2; k++) { o[k].copy(q[k]); q[k].copy(t.hand).addScaledVector(t.hd, k * t.ds); } } // a hand moves smoothly, and its pinch holds the top edge's place, angle and width
    sides(t, q, t.qs); const S = t.qs; // t.s0 stays fixed: the sheet is one flat-bending surface
    for (let i = 0; i < m; i++) { if (!w(i)) continue;
      pv.subVectors(q[i], o[i]).divideScalar(h); tn.subVectors(q[Math.min(m - 1, i + 1)], q[Math.max(0, i - 1)]).normalize(); nn.crossVectors(tn, S[i]).normalize();
      pd.subVectors(pv, t.qv[i]); pv.addScaledVector(nn, -pd.dot(nn) * (1 - KA)); // added mass: moving face-on means moving the air too, so it answers slower
      const vn = pv.dot(nn); pv.addScaledVector(nn, -Math.sign(vn) * Math.min(Math.abs(vn), DRAG * KA * vn * vn * h)).multiplyScalar(1 - ct); pv.y += PG * h; pv.addScaledVector(nn, -nn.y * PG * h * (1 - KA));
      t.qv[i].copy(pv); o[i].copy(q[i]); q[i].addScaledVector(pv, h); }
    for (let it = 0; it < 3; it++) { // 3 passes: within its plane a sheet must stay rigid even when the hand jerks
    for (let i = 1; i < m - 1; i++) { const wa = w(i - 1), wb = w(i), wc = w(i + 1); if (!(wa + wb + wc)) continue; // bending: out of the sheet's plane it bends (compliance BEND); within its plane paper is rigid
      tn.subVectors(q[i + 1], q[i - 1]).normalize(); nn.crossVectors(tn, S[i]).normalize(); pd.addVectors(q[i - 1], q[i + 1]).multiplyScalar(-0.5).add(q[i]);
      const cn = pd.dot(nn); pd.addScaledVector(nn, -cn).divideScalar(wb + 0.25 * wa + 0.25 * wc).addScaledVector(nn, cn / (wb + 0.25 * wa + 0.25 * wc + a));
      q[i].addScaledVector(pd, -wb); q[i - 1].addScaledVector(pd, 0.5 * wa); q[i + 1].addScaledVector(pd, 0.5 * wc); }
    for (let i = 0; i < m - 1; i++) { const wi = w(i), wj = w(i + 1); if (!(wi + wj)) continue; pd.subVectors(q[i + 1], q[i]); const l = pd.length() || 1e-9; pd.multiplyScalar((l - t.ds) / l / (wi + wj)); q[i].addScaledVector(pd, wi); q[i + 1].addScaledVector(pd, -wj); }
    }
    for (let i = 1; i < m; i++) { pd.subVectors(q[i], q[i - 1]).setLength(t.ds).add(q[i - 1]); collideSheet(pd, S[i]); if (!w(i)) continue; pv.subVectors(pd, q[i]); q[i].add(pv); o[i].add(pv); } // exact length, without adding velocity: paper does not stretch
    for (let i = 1; i < m; i++) q[i].addScaledVector(t.s0, -pv.subVectors(q[i], q[0]).dot(t.s0)); // and it bends about its width only: the centreline stays in the plane square to the width, so it cannot wiggle side to side
  };
  const paperDraw = (t) => {
    const n = t.p.length; t.mesh.visible = n > 1; if (n < 2) return;
    if (t.q && (t.mode === 'held' || t.mode === 'fade')) for (let i = 0; i < n; i++) { const u = Math.min(i * DS / t.ds, t.q.length - 1.0001), k = Math.floor(u), f = u - k, Q = t.q, m = Q.length; // Catmull-Rom through the physics nodes
      const p0 = k ? Q[k - 1] : pd.subVectors(Q[0], Q[1]).add(Q[0]), p3 = k + 2 < m ? Q[k + 2] : nn.subVectors(Q[m - 1], Q[m - 2]).add(Q[m - 1]), p1 = Q[k], p2 = Q[k + 1], f2 = f * f, f3 = f2 * f;
      t.p[i].set(0, 0, 0).addScaledVector(p0, -0.5 * f3 + f2 - 0.5 * f).addScaledVector(p1, 1.5 * f3 - 2.5 * f2 + 1).addScaledVector(p2, -1.5 * f3 + 2 * f2 + 0.5 * f).addScaledVector(p3, 0.5 * f3 - 0.5 * f2); }
    sides(t, t.p, t.sd, t.q && (t.mode === 'held' || t.mode === 'fade') ? t.qs[0] : XA); for (let i = 0; i < n; i++) { const q = t.p[i], w = pv.copy(t.sd[i]).multiplyScalar(HW); t.pos.set([q.x - w.x, q.y - w.y, q.z - w.z, q.x + w.x, q.y + w.y, q.z + w.z], i * 6); } // tip first: the ticket's top is printed first; the width turns with the strip
    t.geo.setDrawRange(0, (n - 1) * 6); t.geo.attributes.position.needsUpdate = true; t.geo.computeVertexNormals(); t.geo.computeBoundingSphere(); // the strip moves every frame: a stale sphere makes the grab miss
  };
  const dropTicket = (t) => { t.mode = 'fade'; t.a = 1; resetTicket(tickets[tk], 'wait', 0.35); };
  const paperTick = (dt, now) => {
    const t = tickets[tk]; printer.updateWorldMatrix(true, false); for (const ob of OBS) { ob.node.updateWorldMatrix(true, false); ob.M.copy(ob.node.matrixWorld).invert().multiply(printer.matrixWorld); ob.Mi.copy(ob.M).invert(); }
    BACK = Math.sign(SLOT.z - printer.worldToLocal(cv1.set(0, 0, 0)).z) || 1; // away from the viewer
    if (t.mode === 'wait' && (t.wait -= dt) <= 0) { ticketArt(t); t.mode = 'print'; t.len = 0; }
    if (t.mode === 'print' && (t.len += dt * PL / 3.2) >= PL) { t.len = PL; t.mode = 'idle'; }
    if (t.mode === 'print' || t.mode === 'idle') upright(t, now);
    const steps = 20, h = Math.min(dt, 1 / 30) / steps; // small steps: stiff paper without iterations (12 nodes x 20 steps is cheap)
    for (const q of tickets) {
      if (q.mode === 'held' || q.mode === 'fade') for (let s2 = 0; s2 < steps; s2++) paperStep(q, h);
      if (q.mode === 'fade' && (q.mat.opacity = Math.max(0, q.a -= dt / 0.5)) <= 0) resetTicket(q);
      if (q.p.length) { paperDraw(q); poolDraw(q); }
    }
    return t.mode === 'print';
  };
  const stickers = [...lps.old.stickers, ...lps.new.stickers], byKey = Object.fromEntries(stickers.map((st) => [st.lid + ':' + st.id, st]));
  for (const st of stickers) st.locked = !!all[st.lid].stickers.find((e) => e.id === st.id)?.locked;
  for (const bt of document.querySelectorAll('[data-swarm]')) byKey[bt.dataset.sticker].fam = bt.dataset.swarm.split(',').map((k) => byKey[k]).filter(Boolean); // Swarm: stickers that belong to the story, from either lid

  // the old laptop sits exactly on the photographed one: root = lid pose * (hinge -> lid centre)^-1
  const A_PHOTO = 0.17, photoRoot = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  new THREE.Matrix4().fromArray(PHOTO.m).multiply(new THREE.Matrix4().makeRotationX(A_PHOTO).multiply(new THREE.Matrix4().makeTranslation(0, lps.old.H / 2, 0)).invert()).decompose(photoRoot.p, photoRoot.q, new THREE.Vector3());

  // photo -> 3D without a seam: a card on the lid shows the stage photo projected through the photo's own lens, so at the handoff the 3D lid is the photo's pixels; it dissolves into the real stickers as the laptop lifts out
  const lidShape = (k) => { const lp = lps[k], cw = lp.W / 2, ch = lp.H / 2, cr = all[k].lid.radius_px * lp.W / all[k].lid.w, sh = new THREE.Shape();
    sh.moveTo(-cw + cr, -ch); sh.lineTo(cw - cr, -ch); sh.quadraticCurveTo(cw, -ch, cw, -ch + cr); sh.lineTo(cw, ch - cr); sh.quadraticCurveTo(cw, ch, cw - cr, ch); sh.lineTo(-cw + cr, ch); sh.quadraticCurveTo(-cw, ch, -cw, ch - cr); sh.lineTo(-cw, -ch + cr); sh.quadraticCurveTo(-cw, -ch, -cw + cr, -ch); return new THREE.ShapeGeometry(sh, 6); };
  const od = lps.old;
  const cardU = { uPM: { value: new THREE.Matrix4() }, uF: { value: new THREE.Vector2(PHOTO.f / PHOTO.w, PHOTO.f / PHOTO.h) } }, cardMat = new THREE.MeshBasicMaterial({ map: await loadTex(photo.currentSrc || photo.src), transparent: true, depthWrite: false, toneMapped: false });
  cardMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cardU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 uPM; varying vec3 vPP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPP = (uPM * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uF; varying vec3 vPP;').replace('#include <map_fragment>', 'diffuseColor *= texture2D(map, 0.5 + uF * vPP.xy / -vPP.z);');
  };
  const card = new THREE.Mesh(lidShape('old'), cardMat); card.position.z = 0.004; card.renderOrder = 8990; card.visible = false; od.lidG.add(card);
  od.root.position.copy(photoRoot.p); od.root.quaternion.copy(photoRoot.q); od.pivot.rotation.x = A_PHOTO; od.root.updateMatrixWorld(true); camera.updateMatrixWorld();
  cardU.uPM.value.multiplyMatrices(camera.matrixWorldInverse, card.matrixWorld); // the lid's pose in the photo, frozen: the projection rides along as the laptop moves
  const stageDim = document.createElement('i'); stageDim.className = 'dim'; photoBox.append(stageDim); // the stage lights go down, all but the laptop
  let dimO = 0, cardO = 0;
  const lidDim = Object.fromEntries(['old', 'new'].map((k) => { const m = new THREE.Mesh(lidShape(k), new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0, depthWrite: false })); m.position.z = 0.0045; m.renderOrder = 7990; m.visible = false; lps[k].lidG.add(m); return [k, m]; })); // Swarm: the lid dims under the stickers on show

  // ---------- scenes ----------
  const secs = [...document.querySelectorAll('[data-scene]')];
  const aura = document.createElement('div'), auraEls = {}, auraO = { base: 0, eng: 0, off: 0 }, auraXY = { x: innerWidth / 2, y: innerHeight / 2 }; aura.className = 'aura'; aura.setAttribute('aria-hidden', 'true');
  for (const n of ['base', 'eng', 'off']) aura.append((auraEls[n] = Object.assign(document.createElement('i'), { className: n }))); document.body.prepend(aura);
  const era = Object.fromEntries([['old', 'HUAWEI MateBook D16', '2019 to 2023'], ['new', 'MacBook Pro 16', '2024 to now']].map(([k, nm, yr]) => { const el = Object.assign(document.createElement('p'), { className: 'era', innerHTML: `<b>${nm}</b>${yr}` }); el.setAttribute('aria-hidden', 'true'); document.body.append(el); return [k, el]; })); // which laptop is which, above each one
  const bgDraw = asciiBg(); // ASCII light behind everything; the aura glows over it
  let Wc = 1, Hc = 1, portrait = false, finLid = 0, swapS = 0; // phone finale: 0 shows the HUAWEI, 1 the MacBook
  const kx = () => 2 * Math.tan(FOV0 / 2) * Wc / Hc, ky = () => 2 * Math.tan(FOV0 / 2);
  const fitW = (lp, f) => (lp.W * 1.02) / (f * kx()), fitH = (lp, f) => (lp.H + lp.D * 0.35) / (f * ky());
  const fit = (lp, fw, fh) => Math.max(fitW(lp, fw), fitH(lp, fh));
  const OFF = (side, z) => ({ x: side * 1.5, y: -0.05, z, rx: 0.1, ry: side * 0.9, a: 0.2 });
  let shotList = [];
  const ly = (sec) => { const i = sec.querySelector('.inner'), t = (i.offsetTop - (i.offsetParent === sec ? 0 : sec.offsetTop)) / Hc; return 0.5 - Math.max(0.4, t - 0.15); }; // phone beats: the laptops sit just above the measured copy card, never under it
  function stateOf(sec) {
    const sc = sec.dataset.scene, P = portrait, o = lps.old, n = lps.new;
    const zo = fit(o, P ? 0.84 : 0.5, P ? 0.36 : 0.62), zn = fit(n, P ? 0.84 : 0.5, P ? 0.36 : 0.62);
    const s = { pm: 'free', po: 0, co: 1, pk: 0, old: OFF(-1, zo), new: OFF(1, zn), pres: null, shot: -1, fax: 0, buzz: 0, era: 0 };
    if (sc === 'hero') return { ...s, pm: 'frame', po: 1, co: 0, pk: 1 };
    if (sc === 'q') return { ...s, pm: 'cover', po: 1, co: 0, pk: 1 };
    if (sc === 'reveal') return { ...s, era: 1, old: P ? { x: -0.25, y: 0.1, z: fit(o, 0.4, 0.3), rx: 0.14, ry: 0.36, a: 0.2 } : { x: -0.22, y: -0.12, z: fit(o, 0.36, 0.5), rx: 0.12, ry: 0.4, a: 0.2 }, new: P ? { x: 0.25, y: 0.1, z: fit(n, 0.38, 0.3), rx: 0.14, ry: -0.36, a: 0.2 } : { x: 0.22, y: -0.12, z: fit(n, 0.34, 0.5), rx: 0.12, ry: -0.4, a: 0.2 } }; // a showcase: the two laptops side by side, turned toward each other
    if (sc === 'beat') { const odd = beats.indexOf(sec) % 2, d = odd ? 0.06 : 0; return { ...s, pres: sec.dataset.sticker, odd, // both laptops under the stickers on show: any beat can use stickers from either lid
      old: P ? { x: -0.24, y: ly(sec), z: fit(o, 0.44, 0.26), rx: -0.04, ry: 0.1, a: 0.16 } : { x: 0.04, y: -0.19, z: fit(o, 0.25, 0.4), rx: -0.04, ry: -0.06 - d, a: 0.16 },
      new: P ? { x: 0.24, y: ly(sec), z: fit(n, 0.42, 0.26), rx: -0.04, ry: -0.1, a: 0.16 } : { x: 0.35, y: -0.19, z: fit(n, 0.23, 0.4), rx: -0.04, ry: -0.22 + d, a: 0.16 } }; }
    if (sc === 'built') return { ...s, new: P ? { x: 0, y: 0.14, z: fit(n, 0.86, 0.4), rx: 0.42, ry: 0.15, a: -Math.PI / 2 + 0.035 } : { x: 0, y: -0.03, z: fit(n, 0.6, 0.7), rx: 0.42, ry: 0.42, a: -Math.PI / 2 + 0.035 } }; // closed, seen from the hinge side: the stickers read upright, the edge shows its ports
    if (sc === 'project' && sec.dataset.shot === 'buzzerminds' && !P) return { ...s, buzz: 1, new: { x: 0.03, y: 0.07, z: fit(n, 0.36, 0.56), rx: 0.12, ry: Math.PI - 0.12, a: 0.14 }, shot: shotList.indexOf('buzzerminds') }; // room for the phone
    if (sc === 'project' && sec.dataset.shot === 'faxmemaybe' && !P) return { ...s, fax: 1, new: { x: 0.03, y: 0.07, z: fit(n, 0.36, 0.56), rx: 0.16, ry: Math.PI - 0.16, a: 0.12 }, shot: shotList.indexOf('faxmemaybe') }; // room for the printer
    if (sc === 'project') return { ...s, new: P ? (() => { const t = Math.max(0.3, (sec.querySelector('.inner').offsetTop - sec.offsetTop) / Hc - 0.02), b = 64 / Hc; const fx = sec.dataset.shot === 'faxmemaybe' || sec.dataset.shot === 'buzzerminds'; return { x: fx ? -0.16 : 0, y: 0.5 - (b + (t - b) / 2), z: fit(n, fx ? 0.66 : 0.94, (t - b) * 1.1), rx: 0.1, ry: Math.PI, a: 0.22 }; })() : (document.querySelectorAll('[data-shot]').length && [...document.querySelectorAll('[data-shot]')].indexOf(sec) % 2 ? { x: 0.15, y: 0.05, z: fit(n, 0.45, 0.66), rx: 0.16, ry: Math.PI - 0.16, a: 0.12 } : { x: 0.13, y: 0.03, z: fit(n, 0.47, 0.7), rx: 0.08, ry: Math.PI + 0.05, a: 0.2 }), shot: shotList.indexOf(sec.dataset.shot), fax: sec.dataset.shot === 'faxmemaybe' ? 1 : 0, buzz: sec.dataset.shot === 'buzzerminds' ? 1 : 0 }; // phone: the MacBook fills the space above the copy card
    if (sc === 'cv') return { ...s, co: 0, new: { x: 0.2, y: -0.04, z: zn * 1.3, rx: 0.08, ry: Math.PI + 0.32, a: 0.26 } };
    if (sc === 'finale') {
      if (OG) { const zg = Math.max(fit(o, 0.42, 0.62), fit(n, 0.42, 0.62)); return { ...s, old: { x: -0.22, y: -0.14, z: zg, rx: 0.16, ry: 0.3, a: 0.2 }, new: { x: 0.22, y: -0.14, z: zg, rx: 0.16, ry: -0.3, a: 0.2 } }; }
      // the laptops live in the free band under the measured copy, so they never touch the text at any window size
      if (!P && Hc <= 760) return { ...s, old: { x: 0.055, y: Hc > 500 ? -0.07 : 0.02, z: fit(o, 0.23, 0.78), rx: 0.2, ry: 0.3, a: 0.2 }, new: { x: 0.31, y: Hc > 500 ? -0.07 : 0.02, z: fit(n, 0.23, 0.78), rx: 0.2, ry: -0.3, a: 0.2 } }; // short landscape: copy left, laptops fill the height on the right
      const fi = sec.querySelector('.inner'), bot = Math.min(0.62, (fi.offsetTop - (fi.offsetParent === sec ? 0 : sec.offsetTop) + fi.offsetHeight) / Hc + 0.03), band = 1 - bot - 0.09; // room for the footer line // offsets ignore the copy's scroll-linked translate
      const zf = P ? Math.max(fit(o, 0.84, band * 0.86), fit(n, 0.84, band * 0.86)) : Math.max(fit(o, 0.5, band * 1.05), fit(n, 0.5, band * 1.05)), yd = 0.5 - bot - band / 2;
      return { ...s, old: P ? { x: -0.02, y: 0.5 - bot - band * 0.4, z: zf, rx: 0.16, ry: 0.1, a: 0.2 } : { x: -0.245, y: yd, z: zf, rx: 0.2, ry: 0.34, a: 0.2 },
        new: P ? { x: 0.02, y: 0.5 - bot - band * 0.4, z: zf, rx: 0.16, ry: -0.1, a: 0.2 } : { x: 0.245, y: yd, z: zf, rx: 0.2, ry: -0.34, a: 0.2 } };
    }
    return s;
  }
  shotList = secs.filter((s) => s.dataset.shot).map((s) => s.dataset.shot);
  const shotTexs = shotList.map(() => null), shotK = shotList.map((n) => secs.findIndex((s) => s.dataset.shot === n)); // fetched as their moment comes near, like the videos
  // LLMChessArena: a real finished game from production, stepped move by move (recorded by qa, 15 s loop); plays only while its moment is on screen
  const vids = ['llmchess', 'dosarchive'].map((k) => { // looping screen recordings, fetched only as their moment comes near (SUN.EXE: one tour of the real program, not a live emulator)
    const o = { i: shotList.indexOf(k), k: secs.findIndex((s) => s.dataset.shot === k), v: Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true, preload: 'none', src: `screens/${k}.mp4` }), fresh: false };
    if (o.i >= 0) o.v.addEventListener('loadeddata', () => { const t = new THREE.VideoTexture(o.v); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; shotTexs[o.i] = t; o.fresh = true; }, { once: true });
    return o; });
  // PHM and LLM-AD-Defense: each session plays live from its first keystroke when its moment comes on screen (term.js)
  const terms = [['ad', AD]].map(([nm, sess]) => { const i = shotList.indexOf(nm), tm = makeTerm(sess), tex = new THREE.CanvasTexture(tm.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso; tm.draw(sess.dur - 0.6); if (i >= 0) shotTexs[i] = tex; return { k: secs.findIndex((s) => s.dataset.shot === nm), tm, tex, t0: 0, on: false }; });
  // BuzzerMinds: the MacBook is the room's big screen with a live question, a phone beside it is one player answering; both drawn each frame, an 11 s loop
  const buzzI = shotList.indexOf('buzzerminds'), buzzK = secs.findIndex((s) => s.dataset.shot === 'buzzerminds');
  const bzCv = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 }), phCv = Object.assign(document.createElement('canvas'), { width: 600, height: 1240 });
  const bzTex = new THREE.CanvasTexture(bzCv), phTex = new THREE.CanvasTexture(phCv); for (const t of [bzTex, phTex]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; }
  if (buzzI >= 0) shotTexs[buzzI] = bzTex;
  const PW = 0.72, PH = 1.48, phoneRig = new THREE.Group(), phone = new THREE.Group(); phoneRig.add(phone); phoneRig.visible = false; lps.new.root.add(phoneRig);
  phone.add(new THREE.Mesh(new RoundedBoxGeometry(PW, PH, 0.075, 4, 0.1), new THREE.MeshPhysicalMaterial({ color: 0x232427, metalness: 0.85, roughness: 0.32, clearcoat: 0.5 })));
  const phScr = new THREE.Mesh(new THREE.PlaneGeometry(PW - 0.035, PH - 0.035), new THREE.MeshBasicMaterial({ map: phTex, transparent: true, toneMapped: false })); phScr.position.z = 0.0385; phone.add(phScr);
  contactShadow(new THREE.Box3(new THREE.Vector3(-PW / 2, 0, -0.2), new THREE.Vector3(PW / 2, 1, 0.2)), phoneRig);
  // BuzzerMinds' own design (frontend/src: display-room-view.tsx, player-room-view.tsx, globals.css): #141414, DM Sans + Outfit, A-D red/blue/green/orange
  const BZC = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'], BZA = ['Mercury', 'Venus', 'Mars', 'Jupiter'], AMB = '#f59e0b', SAGE = '#4ade80', ROSE = '#fb7185';
  const BZP = [['Nadia', '#f472b6', 2.6, 1, 2140], ['Omar', '#38bdf8', 3.3, 0, 1880], ['Sara', '#a78bfa', 3.9, 1, 1760], ['Youssef', '#facc15', 4.3, 1, 1250], ['Ali', '#34d399', 5.4, 3, 990], ['Lina', '#fb923c', 6.6, 1, 870]]; // name, colour, lock-in time, pick, score; Youssef is the phone
  const Q = ['Which', 'planet’s', 'day', 'lasts', 'longer', 'than', 'its', 'year?'], T0 = 1.9, T1 = 7.9; // narration, then the timer runs T0..T1, then the reveal
  const sans = (w, px) => `${w} ${px}px "DM Sans", system-ui, sans-serif`, disp = (w, px) => `${w} ${px}px Outfit, system-ui, sans-serif`;
  const pill = (x, X, Y, H, txt, fg, bg, font, padX = 18) => { x.font = font; const w = x.measureText(txt).width + padX * 2; x.fillStyle = bg; x.beginPath(); x.roundRect(X, Y, w, H, 8); x.fill(); x.fillStyle = fg; x.textBaseline = 'middle'; x.fillText(txt, X + padX, Y + H / 2 + 1); return w; };
  const OV = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], OE = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]];
  const WF = (() => { let a = 7; const r = () => (a = (a * 16807) % 2147483647) / 2147483647; return Array.from({ length: 10 }, (_, i) => ({ size: 0.6 + r() * 1.8, x: (r() - 0.5) * 30, y: (r() - 0.5) * 18, r: [r() * 6.28, r() * 6.28, r() * 6.28], v: [(r() - 0.5) * 0.004, (r() - 0.5) * 0.006, (r() - 0.5) * 0.003], dx: (r() - 0.5) * 0.003, dy: (r() - 0.5) * 0.002, op: 0.12 + r() * 0.06, c: ['245,158,11', '74,222,128', '251,113,133'][i % 3] })); })();
  const wrapE = (v, e) => ((((v + e + 2) % (2 * e + 4)) + 2 * e + 4) % (2 * e + 4)) - e - 2;
  function wire(x, W, H, fr) { // BuzzerMinds' wireframe-background.tsx: 10 octahedrons drifting past a camera at z 18, fov 60, over a faint 45 deg line pattern; fr = frames at 60 fps
    x.lineWidth = 1; x.strokeStyle = 'rgba(245,158,11,0.03)'; x.beginPath(); for (let d = -H; d < W; d += 30 * Math.SQRT2) { x.moveTo(d, 0); x.lineTo(d + H, H); } x.stroke();
    const f = H / 2 / Math.tan(Math.PI / 6);
    for (const sh of WF) {
      const X = wrapE(sh.x + sh.dx * fr, 18), Y = wrapE(sh.y + sh.dy * fr, 12), fx = Math.abs(X) > 14 ? Math.max(0, 1 - (Math.abs(X) - 14) / 4) : 1, fy = Math.abs(Y) > 8 ? Math.max(0, 1 - (Math.abs(Y) - 8) / 4) : 1, op = sh.op * fx * fy; if (op <= 0.001) continue;
      const [cx, sx, cy, sy, cz, sz] = sh.r.flatMap((r0, k) => { const a = r0 + sh.v[k] * fr; return [Math.cos(a), Math.sin(a)]; });
      const P = OV.map(([px, py, pz]) => { let X1 = px * sh.size, Y1 = py * sh.size, Z1 = pz * sh.size, t1 = Y1 * cx - Z1 * sx; Z1 = Y1 * sx + Z1 * cx; Y1 = t1; t1 = X1 * cy + Z1 * sy; Z1 = -X1 * sy + Z1 * cy; X1 = t1; t1 = X1 * cz - Y1 * sz; Y1 = X1 * sz + Y1 * cz; X1 = t1;
        const k = f / Math.max(0.1, 18 - Z1); return [W / 2 + (X + X1) * k, H / 2 - (Y + Y1) * k]; });
      x.beginPath(); for (const [a, b] of OE) { x.moveTo(...P[a]); x.lineTo(...P[b]); } x.strokeStyle = `rgba(${sh.c},${op})`; x.stroke();
    }
  }
  function bzDraw(t) {
    const x = bzCv.getContext('2d'), rev = t > T1, left = Math.ceil(Math.max(0, T1 - t) - 1e-6), rv = Math.min(1, (t - T1) / 0.5);
    x.fillStyle = '#141414'; x.fillRect(0, 0, 1280, 800); const fr = performance.now() * 0.06; wire(x, 1280, 800, fr); x.textAlign = 'left';
    if (t < 0.25 || (t > T1 && t < T1 + 0.25)) { const k = t < 0.25 ? t : t - T1, g = x.createRadialGradient(640, 400, 0, 640, 400, 760); g.addColorStop(0, rev ? `rgba(74,222,128,${0.18 * (1 - k / 0.25)})` : `rgba(245,158,11,${0.18 * (1 - k / 0.25)})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 1280, 800); } // phase flash
    x.textBaseline = 'middle'; x.font = disp(800, 22.4); x.fillStyle = AMB; x.fillText('Buzzer', 46, 50); const bw = x.measureText('Buzzer').width; x.fillStyle = SAGE; x.fillText('Minds', 46 + bw, 50);
    pill(x, 46 + bw + x.measureText('Minds').width + 12, 34, 32, 'ROUND 2 OF 5', AMB, 'rgba(245,158,11,0.12)', disp(700, 16));
    x.textAlign = 'right'; x.fillStyle = 'rgba(255,255,255,0.35)'; x.font = sans(600, 11.2); x.fillText('JOIN', 1256, 30); x.font = disp(800, 22.4); x.letterSpacing = '0.2em'; x.fillText('KX7Q', 1256 + 4, 54); x.letterSpacing = '0px'; x.textAlign = 'left';
    // centre column: badges, question, timer or result line, answers
    const tw = pill(x, 0, -99, 0, 'SPACE', '#000', 'rgba(0,0,0,0)', disp(700, 20.8)) + 12 + pill(x, 0, -99, 0, 'MEDIUM', '#000', 'rgba(0,0,0,0)', disp(700, 20.8));
    let bx = 640 - tw / 2, y = rev ? 104 : 118; bx += pill(x, bx, y, 38, 'SPACE', AMB, 'rgba(245,158,11,0.15)', disp(700, 20.8)) + 12; pill(x, bx, y, 38, 'MEDIUM', '#a78bfa', 'rgba(139,92,246,0.15)', disp(700, 20.8));
    y += 58 + 34; x.font = sans(700, 51.2); const words = Q.map((w) => w + ' '), lines = [words.slice(0, 4), words.slice(4)];
    let wi = 0; for (const ln of lines) { let lx = 640 - x.measureText(ln.join('').trim()).width / 2; for (const w of ln) { const at = 0.15 + wi * 0.2, k = Math.min(1, Math.max(0, (t - at) / 0.25)), newest = t >= at && t < at + 0.45;
      x.fillStyle = t < at ? 'rgba(255,255,255,0.05)' : newest && t < T0 ? AMB : '#f5f5f5'; x.filter = t < at ? 'blur(10px)' : 'none'; x.fillText(w, lx + (1 - k) * 20, y); x.filter = 'none'; lx += x.measureText(w).width; wi++; } y += 69; }
    y += 8;
    if (!rev) { if (t > T0) { const k = Math.min(1, (t - T0) / 0.4); x.globalAlpha = k; x.textAlign = 'center'; x.font = disp(900, 64 * (0.8 + 0.2 * k)); x.fillStyle = left <= 3 ? '#ef4444' : AMB; x.fillText(String(left), 640, y + 30); x.textAlign = 'left'; x.globalAlpha = 1; } y += 64 + 20; }
    else { x.globalAlpha = rv; x.textAlign = 'center'; x.font = disp(800, 35.2); x.fillStyle = SAGE; x.fillText('4 out of 6 got it right!', 640, y + 14 - 10 * (1 - rv)); x.textAlign = 'left'; x.globalAlpha = 1; y += 44 + 16; }
    const gw = 1037, gx = 640 - gw / 2, cw2 = (gw - 12) / 2, th = rev ? 62 : 86, gap = rev ? 8 : 12;
    for (let i = 0; i < 4; i++) { const ax = gx + (i % 2) * (cw2 + 12), ay = y + Math.floor(i / 2) * (th + gap + (rev ? 46 : 0)), ok = i === 1, pop = Math.min(1, Math.max(0, (t - T0 - i * 0.1) / 0.3)), s = 0.8 + 0.2 * pop;
      if (pop <= 0) continue; x.save(); x.translate(ax + cw2 / 2, ay + th / 2); x.scale(s, s); x.globalAlpha = pop * (rev && !ok ? 0.5 : 1);
      x.fillStyle = rev ? (ok ? '#22c55e' : 'rgba(239,68,68,0.3)') : BZC[i]; if (rev && ok) { x.shadowColor = 'rgba(34,197,94,0.4)'; x.shadowBlur = 30; }
      x.beginPath(); x.roundRect(-cw2 / 2, -th / 2, cw2, th, 16); x.fill(); x.shadowBlur = 0; if (rev && ok) { x.strokeStyle = '#22c55e'; x.lineWidth = 3; x.stroke(); }
      x.textBaseline = 'middle'; x.font = disp(900, 22.4); x.fillStyle = 'rgba(255,255,255,0.7)'; x.fillText('ABCD'[i], -cw2 / 2 + (rev ? 20 : 32), 1); x.font = sans(700, 28.2); x.fillStyle = '#fff'; x.fillText(BZA[i], -cw2 / 2 + (rev ? 20 : 32) + 16 + 18, 1); x.restore();
      if (rev && t > T1 + 0.4) { let cx = ax; x.globalAlpha = Math.min(1, (t - T1 - 0.4) / 0.3); for (const [nm, , , pk] of BZP) if (pk === i) { x.font = sans(600, 13.6); const tx = ok ? `${nm}  +430` : nm, w = x.measureText(tx).width + 20; x.fillStyle = 'rgba(255,255,255,0.08)'; x.beginPath(); x.roundRect(cx, ay + th + 8, w, 28, 8); x.fill(); x.fillStyle = '#f5f5f5'; x.fillText(nm, cx + 10, ay + th + 23); if (ok) { x.fillStyle = SAGE; x.fillText('+430', cx + 10 + x.measureText(nm + '  ').width, ay + th + 23); } cx += w + 8; } x.globalAlpha = 1; }
    }
    // player pills, bottom
    const pw = BZP.map(([nm, , lk]) => { x.font = sans(600, 18.6); let w = 52 + 14 + 10 + x.measureText(nm).width + 10; x.font = disp(700, 17); w += x.measureText('2570').width; if ((t > lk && !rev) || rev) w += 74; return w; });
    const gp = rev ? 24 : 12, rows = [[]]; let rw = 0; pw.forEach((w, i) => { if (rows.at(-1).length && rw + gp + w > 1188) { rows.push([]); rw = 0; } rw += (rows.at(-1).length ? gp : 0) + w; rows.at(-1).push(i); }); // wraps like the real row; wider gaps once correct pills grow 10%
    const at = []; rows.forEach((r, ri) => { let px = 640 - (r.reduce((a, i) => a + pw[i], 0) + gp * (r.length - 1)) / 2; for (const i of r) { at[i] = [px, 800 - 28 - 54 - (rows.length - 1 - ri) * 66]; px += pw[i] + gp; } });
    BZP.forEach(([nm, col, lk, pk, sc], i) => {
      const on = t > lk && !rev, ok = rev && pk === 1, bad = rev && pk !== 1, sh = bad && t < T1 + 0.5 ? Math.sin((t - T1) * 60) * 6 * (1 - (t - T1) / 0.5) : 0, X = at[i][0] + sh, Y = at[i][1];
      x.save(); if (ok) { const k = Math.min(1, (t - T1) / 0.3); x.translate(X + pw[i] / 2, Y + 27); x.scale(1 + 0.1 * k, 1 + 0.1 * k); x.translate(-X - pw[i] / 2, -Y - 27); }
      x.fillStyle = ok ? 'rgba(74,222,128,0.18)' : on ? 'rgba(255,255,255,0.08)' : 'rgba(30,30,30,0.6)'; if (on || ok) { x.shadowColor = ok ? 'rgba(74,222,128,0.5)' : 'rgba(255,255,255,0.25)'; x.shadowBlur = on ? 12 + 8 * (0.5 + 0.5 * Math.sin(t * Math.PI)) : 16; }
      x.beginPath(); x.roundRect(X, Y, pw[i], 54, 27); x.fill(); x.shadowBlur = 0; x.strokeStyle = ok ? SAGE : on ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.06)'; x.lineWidth = 2; x.stroke();
      let cx = X + 26; x.fillStyle = col; x.beginPath(); x.arc(cx + 7, Y + 27, 7, 0, 7); x.fill(); cx += 24; x.font = sans(600, 18.6); x.fillStyle = '#f5f5f5'; x.textBaseline = 'middle'; x.fillText(nm, cx, Y + 28); cx += x.measureText(nm).width + 10;
      x.font = disp(700, 17); x.fillStyle = AMB; x.fillText(String(sc + (ok && t > T1 + 0.4 ? 430 : 0)), cx, Y + 28); cx += x.measureText('2570').width + 10;
      if (on || rev) { const tg = on ? 'LOCKED' : ok ? 'CORRECT' : 'WRONG'; x.font = sans(700, 10.4); const w = x.measureText(tg).width + 14; x.fillStyle = on ? 'rgba(255,255,255,0.2)' : ok ? 'rgba(74,222,128,0.25)' : 'rgba(251,113,133,0.25)'; x.beginPath(); x.roundRect(cx, Y + 17, w, 20, 6); x.fill(); x.fillStyle = on ? '#fff' : ok ? SAGE : ROSE; x.fillText(tg, cx + 7, Y + 28); }
      x.restore(); });
    // the phone: Youssef's view (CSS px x 1.54 on a 600 x 1240 canvas)
    const p = phCv.getContext('2d'), S = 600 / 390, me = BZP[3], mine = t > me[2], tap = t > me[2] && t < me[2] + 0.2 ? 0.96 : 1, sl = Math.max(0, T1 - t);
    p.clearRect(0, 0, 600, 1240); p.save(); p.beginPath(); p.roundRect(0, 0, 600, 1240, 74); p.clip(); p.fillStyle = '#141414'; p.fillRect(0, 0, 600, 1240); p.scale(S, S); wire(p, 390, 806, fr + 900); p.textBaseline = 'middle';
    p.fillStyle = AMB; p.beginPath(); p.roundRect(16, 52, 22, 22, 5); p.fill(); p.fillStyle = '#141414'; p.beginPath(); for (let k = 0; k < 8; k++) { const r = k % 2 ? 2 : 6.5, a = k * Math.PI / 4; p.lineTo(27 + Math.sin(a) * r, 63 - Math.cos(a) * r); } p.fill();
    p.font = disp(700, 12.5); p.fillStyle = AMB; p.fillText('Buzzer', 46, 64); p.fillStyle = SAGE; p.fillText('Minds', 46 + p.measureText('Buzzer').width, 64);
    if (!rev) {
      const pts = Math.round(430 + 440 * Math.min(1, sl / 6)), lk = Math.round(430 + 440 * Math.min(1, (T1 - me[2]) / 6));
      p.font = sans(700, 20.8); p.fillStyle = mine ? SAGE : AMB; p.fillText(t < T0 ? `Pick your answer! - ~${pts} pts` : mine ? `Locked in: ~${lk} pts` : `Pick now: ~${pts} pts`, 8, 104);
      if (t > T0) { p.textAlign = 'right'; p.font = sans(400, 13.6); p.fillStyle = sl <= 3 ? ROSE : AMB; p.fillText(`${Math.ceil(sl)} s`, 382, 106); p.textAlign = 'left'; p.fillStyle = 'rgba(255,255,255,0.08)'; p.beginPath(); p.roundRect(8, 120, 374, 6, 3); p.fill(); p.fillStyle = sl <= 3 ? ROSE : AMB; p.beginPath(); p.roundRect(8, 120, 374 * sl / 6, 6, 3); p.fill(); }
      const gy = 134, gh = 806 - 60 - 30 - gy, tw2 = (374 - 8) / 2, th2 = (gh - 8) / 2;
      for (let i = 0; i < 4; i++) { const X = 8 + (i % 2) * (tw2 + 8), Y = gy + Math.floor(i / 2) * (th2 + 8), pick = mine && i === 1, other = mine && i !== 1, sc = i === 1 ? tap : 1;
        p.save(); p.translate(X + tw2 / 2, Y + th2 / 2); p.scale(sc, sc); p.globalAlpha = other ? 0.35 : 1; p.fillStyle = pick ? BZC[i] : BZC[i] + (other ? '14' : '33'); p.beginPath(); p.roundRect(-tw2 / 2, -th2 / 2, tw2, th2, 14); p.fill();
        if (!other) { p.strokeStyle = BZC[i]; p.lineWidth = 2; p.stroke(); } p.textAlign = 'center'; p.fillStyle = '#f5f5f5'; p.globalAlpha *= 0.8; p.font = sans(700, 16); p.fillText('ABCD'[i], 0, -14); p.globalAlpha = other ? 0.35 : 1; p.font = sans(700, 18.4); p.fillText(BZA[i], 0, 12); p.restore(); }
      p.textAlign = 'center'; p.font = sans(400, 11.5); p.fillStyle = mine ? SAGE : '#aaaaaa'; p.fillText(mine ? 'Locked in: B' : 'Pick your answer!', 195, gy + gh + 18); p.textAlign = 'left';
      if (t > me[2] && t < me[2] + 0.6) { p.strokeStyle = `rgba(255,255,255,${(me[2] + 0.6 - t) / 0.6})`; p.lineWidth = 4; p.beginPath(); p.arc(8 + tw2 * 1.5 + 8, gy + th2 / 2, 26 + (t - me[2]) * 170, 0, 7); p.stroke(); } // the tap
    } else {
      p.globalAlpha = rv; p.textAlign = 'center'; let ry = 130; p.font = disp(700, 20.8); p.fillStyle = SAGE; p.fillText('Correct!', 195, ry); ry += 32;
      p.font = sans(800, 14.4); p.fillStyle = AMB; p.fillText('\u{1F525} 3 in a row!', 195, ry); ry += 26; p.font = sans(400, 13.6); p.fillStyle = '#aaaaaa'; p.fillText('+430 pts', 195, ry); p.textAlign = 'left'; ry += 26;
      p.fillStyle = 'rgba(74,222,128,0.06)'; p.strokeStyle = 'rgba(74,222,128,0.25)'; p.lineWidth = 1; p.beginPath(); p.roundRect(35, ry, 320, 46, 12); p.fill(); p.stroke(); p.font = sans(700, 12.5); p.fillStyle = SAGE; p.fillText('Correct: B — Venus', 49, ry + 23); ry += 64;
      p.font = sans(400, 14.4); p.fillStyle = '#f5f5f5'; for (const ln of ['Venus spins so slowly that one day there', 'lasts 243 Earth days, longer than its', '225-day trip around the Sun.']) { p.fillText(ln, 35, ry); ry += 22; } p.fillStyle = '#38bdf8'; p.fillText('Source 1', 35, ry + 4); p.globalAlpha = 1;
    }
    p.font = sans(600, 12); const nw = p.measureText('Youssef').width; p.font = sans(400, 11.2); const sw2 = p.measureText(`${me[4] + (rev ? 430 : 0)} pts`).width, bw2 = 14 + 8 + 6 + nw + 8 + sw2 + 14;
    p.fillStyle = 'rgba(30,30,30,0.85)'; p.beginPath(); p.roundRect(195 - bw2 / 2, 806 - 20 - 30, bw2, 30, 15); p.fill(); let qx = 195 - bw2 / 2 + 14; p.fillStyle = me[1]; p.beginPath(); p.arc(qx + 4, 806 - 35, 4, 0, 7); p.fill(); qx += 14;
    p.font = sans(600, 12); p.fillStyle = '#f5f5f5'; p.fillText('Youssef', qx, 806 - 34); qx += nw + 8; p.font = sans(400, 11.2); p.fillStyle = '#aaaaaa'; p.fillText(`${me[4] + (rev ? 430 : 0)} pts`, qx, 806 - 34);
    p.restore(); p.fillStyle = '#000'; p.beginPath(); p.roundRect(222, 30, 156, 44, 22); p.fill(); // the island
    bzTex.needsUpdate = phTex.needsUpdate = true;
  }
  bzDraw(0); Promise.all([document.fonts?.load(disp(800, 40)), document.fonts?.load(sans(700, 40))]).then(() => bzDraw(0));
  let states = [], tops = [];
  const lvhEl = document.createElement('div'); lvhEl.style.cssText = 'position:absolute;top:0;width:0;height:100lvh;visibility:hidden;pointer-events:none'; document.body.append(lvhEl);
  const lvh = () => lvhEl.offsetHeight || innerHeight; // the stage keeps the large viewport: a phone toolbar showing or hiding never re-lays out the scene
  function layout() {
    Wc = innerWidth; Hc = lvh(); portrait = matchMedia('(max-width: 820px), (max-aspect-ratio: 19/20)').matches && Hc > 500; // same test as the CSS phone layout; short landscape uses the desktop poses
    renderer.setSize(Wc, Hc, false);
    const pins = secs.map((s) => (s.classList.contains('step') && s.dataset.scene !== 'hero' ? s.querySelector('.inner') : null));
    pins.forEach((el) => el && (el.classList.remove('pin'), Object.assign(el.style, { position: '', top: '', bottom: '', left: '', width: '' }))); // poses read the copy's place in the flow: measure before pinning
    states = secs.map(stateOf); tops = secs.map((s) => s.getBoundingClientRect().top + scrollY);
    const r = pins.map((el) => el && el.getBoundingClientRect()), sr = secs.map((s) => s.getBoundingClientRect());
    pins.forEach((el, n) => { if (!el) return; const up = r[n].top - sr[n].top, down = sr[n].bottom - r[n].bottom; el.classList.add('pin'); // the copy stays put while you read; a phone card sits on the bottom of the visible screen
      Object.assign(el.style, { position: 'fixed', left: r[n].left + 'px', width: r[n].width + 'px', zIndex: 3 }, root.classList.contains('gl') ? {} : { visibility: 'hidden' }, portrait && down < up ? { top: 'auto', bottom: down + 'px' } : { top: up + 'px', bottom: 'auto' }); }); // hidden until the loop runs: stacked copy before the reveal
    tops = secs.map((s) => s.getBoundingClientRect().top + scrollY); // a section can shrink once its copy leaves the flow
  }

  // photo / camera frames (S: px per photo px, T: offset of the photo's top-left), one mapping shared by the <img> and the camera
  function frameOf(mode) {
    if (mode === 'free') { const S = Hc * Math.tan(FOVP / 2) / Math.tan(FOV0 / 2) / PHOTO.h; return { S, Tx: (Wc - PHOTO.w * S) / 2, Ty: (Hc - PHOTO.h * S) / 2, clip: [0, 0, 0, 0, 0] }; }
    let R = { left: 0, top: 0, width: Wc, height: Hc }, c = [760, portrait ? 560 : 520], k = portrait ? 1.12 : 1.04;
    if (mode === 'frame') { R = heroFig.getBoundingClientRect(); c = [770, R.height < R.width * 0.4 ? 330 : 520]; k = 1; } // a thin strip shows the face, not the hands
    if (mode === 'lid') { const qx = PHOTO.quad.map((p) => p[0]), qy = PHOTO.quad.map((p) => p[1]); c = [(Math.min(...qx) + Math.max(...qx)) / 2, (Math.min(...qy) + Math.max(...qy)) / 2]; k = Math.min(Wc * (portrait ? 0.86 : 0.6) / (Math.max(...qx) - Math.min(...qx)), Hc * 0.6 / (Math.max(...qy) - Math.min(...qy))) / Math.max(Wc / PHOTO.w, Hc / PHOTO.h); }
    const S = Math.max(R.width / PHOTO.w, R.height / PHOTO.h) * k;
    let Tx = R.left + R.width / 2 - c[0] * S, Ty = R.top + R.height / 2 - c[1] * S;
    if (mode !== 'lid') { Tx = Math.min(R.left, Math.max(R.left + R.width - PHOTO.w * S, Tx)); Ty = Math.min(R.top, Math.max(R.top + R.height - PHOTO.h * S, Ty)); }
    const clip = mode === 'frame' ? [R.top, Wc - R.left - R.width, Hc - R.top - R.height, R.left, 22] : [0, 0, 0, 0, 0];
    return { S, Tx, Ty, clip };
  }

  // ---------- scroll: position over the scene list ----------
  let P = 0, Ps = 0, V = 0, focusT = 0;
  const beats = [...document.querySelectorAll('[data-scene="beat"]')];
  addEventListener('focusin', (e) => { focusT = performance.now(); const fs = e.target.closest('[data-scene]'); if (fs) { const k = secs.indexOf(fs); if (fs.classList.contains('step') && tops[k + 1] - tops[k] <= Hc + 2) lenis.scrollTo(tops[k], { immediate: true }); requestAnimationFrame(() => { readScroll(); Ps = P; V = 0; }); } }); // keyboard focus: no fade-in lag
  function readScroll() {
    if (OG) { P = secs.length - 1; return; }
    const y = scrollY; let i = 0; while (i < tops.length - 1 && tops[i + 1] <= y) i++;
    P = i + (i < tops.length - 1 ? Math.min(1, (y - tops[i]) / Math.max(1, tops[i + 1] - tops[i])) : 0);
  }
  addEventListener('scroll', readScroll, { passive: true });
  // Lenis: weighted wheel scrolling; touch stays native
  const fts = []; let lastF = 0;
  const PERF = qs.has('perf') && (window.__perf = { ft: [], q: [], ext: renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2') }); // qa: GPU ms per frame
  const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 1, autoRaf: false }); // free scroll: each moment holds still while you read it, so nothing needs to snap
  // progress strip: the 8 beats as a filmstrip; the current one is lit, a click goes to its moment
  const film = document.createElement('nav'); film.className = 'strip'; film.setAttribute('aria-label', 'Sticker moments');
  film.innerHTML = beats.map((bt) => { const st = byKey[bt.dataset.sticker]; return `<button type="button" aria-label="${st.name}"><img src="${st.file.replace('stickers/', 'stickers/m/')}" alt=""></button>`; }).join('') + '<span class="cnt"></span>';
  document.body.append(film); const stripB = [...film.querySelectorAll('button')], stripC = film.querySelector('.cnt'), stripK = [secs.indexOf(beats[0]), secs.indexOf(beats.at(-1))]; let stripN = -2;
  stripB.forEach((bt, n) => bt.addEventListener('click', () => lenis.scrollTo(tops[secs.indexOf(beats[n])])));
  document.querySelectorAll('.top a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { // nav: glide to the section instead of jumping
    const el = document.querySelector(a.getAttribute('href')); if (!el) return; e.preventDefault(); history.pushState(null, '', a.hash);
    lenis.scrollTo(el, { duration: reduce ? 0 : Math.min(2.2, 0.9 + Math.abs(el.getBoundingClientRect().top) / Hc * 0.08), immediate: reduce, easing: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2), onComplete: () => el.focus({ preventScroll: true }) }); }));
  const snapYs = []; const setSnaps = () => { snapYs.length = 0; tops.forEach((t, k) => {
      const lo = k < tops.length - 1 ? tops[k + 1] - Hc : t, add = (y) => snapYs.push(y);
      add(t); if (lo <= t + 2) return;
      // tall sections (CV, a phone hero): steps of at most 0.85 screen, landing on a block or row top just below the nav
      const marks = [...secs[k].querySelectorAll('h3, .rows > li, .block')].map((el) => el.getBoundingClientRect().top + scrollY - 84);
      for (let y = t; lo - y > Hc * 0.85;) { let c = marks.filter((m) => m > y + Hc * 0.35 && m <= y + Hc * 0.85).pop() ?? y + Hc * 0.85; if (lo - c < Hc * 0.35) c = y + (lo - y) / 2; add(c, 1); y = c; } // no stub step before the next moment
      add(lo, 1); // CV rows: keyboard steps only, the wheel reads freely
    }); snapYs.sort((a, b) => a - b); };
  addEventListener('keydown', (e) => { // PageUp/PageDown/Space step between the same points the wheel snaps to
    const dir = e.key === 'PageDown' || e.key === 'ArrowDown' || (e.key === ' ' && !e.shiftKey) ? 1 : e.key === 'PageUp' || e.key === 'ArrowUp' || (e.key === ' ' && e.shiftKey) ? -1 : 0;
    if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, button, a, [contenteditable]')) return;
    const y = lenis.targetScroll, t = dir > 0 ? snapYs.find((v) => v > y + 2) : snapYs.findLast((v) => v < y - 2);
    if (t !== undefined) { e.preventDefault(); lenis.scrollTo(t); }
  });
  let lq = 0; const ro = new ResizeObserver(() => { lq ||= requestAnimationFrame(() => { lq = 0; layout(); setSnaps(); readScroll(); }); }); // once per frame: re-pinning inside the callback loops
  ro.observe(document.querySelector('main')); for (const s of secs) { const el = s.querySelector('.inner'); if (el) ro.observe(el); } // pinned copy is out of the flow: main no longer grows when fonts or the reveal change it
  const sw = document.querySelector('.swaplid'); sw?.addEventListener('click', () => { finLid = 1 - finLid; sw.textContent = finLid ? 'Show the HUAWEI' : 'Show the MacBook'; }); // tops must follow late layout changes (.gl, fonts, images)
  addEventListener('resize', () => { if (innerWidth === Wc && lvh() === Hc) return; layout(); setSnaps(); readScroll(); }); // a toolbar-only resize changes nothing
  layout(); setSnaps(); readScroll(); Ps = P;

  // ---------- pose helpers ----------
  const q1 = new THREE.Quaternion(), e1 = new THREE.Euler(), v1 = new THREE.Vector3(), m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
  const lerp = (a, b, t) => a + (b - a) * t, clamp01 = (x) => Math.min(1, Math.max(0, x)), sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const mix = (a, b, t) => { const o = {}; for (const k in a) o[k] = typeof a[k] === 'number' ? lerp(a[k], b[k], t) : t < 0.5 ? a[k] : b[k]; return o; };
  function placeLaptop(lp, ps, pk, extra) {
    const vh = ps.z * ky(), vw = ps.z * kx();
    q1.setFromEuler(e1.set(ps.rx + extra.x, ps.ry + extra.y, 0, 'XYZ')); // yaw in place, then pitch toward the viewer
    const anchor = v1.set(0, lp.H * 0.42, -lp.D * 0.18).applyQuaternion(q1);
    lp.root.position.set(ps.x * vw, ps.y * vh, -ps.z).sub(anchor); lp.root.quaternion.copy(q1);
    if (pk > 0) { const P = lp.root.position, Q = photoRoot.p, d = Math.exp(lerp(Math.log(-P.z), Math.log(-Q.z), pk)); P.set(lerp(P.x / -P.z, Q.x / -Q.z, pk) * d, lerp(P.y / -P.z, Q.y / -Q.z, pk) * d, -d); lp.root.quaternion.slerp(photoRoot.q, pk); } // out of the photo along the line of sight, depth in log steps: a straight 3D line passed the lens and left the frame
    lp.pivot.rotation.x = lerp(ps.a, A_PHOTO, pk);
  }
  // a beat's sticker: peels almost to the last corner, comes free as a stiff sheet, flips 180 deg on its way to the viewer, floats beside the laptop; leaving, it goes straight back down flat
  const PRES = { pos: new THREE.Vector3(), q: new THREE.Quaternion(), sc: new THREE.Vector3(), h0: new THREE.Vector3(), uq: new THREE.Quaternion(), fq: new THREE.Quaternion(), ax: new THREE.Vector3(), hb: new THREE.Vector3() };
  const SLOTS = [[-1, 0.9, 0.9], [1, 0.85, 0.84], [1.25, -0.25, 0.94], [0.85, -1, 0.88], [-0.1, -1.1, 0.96], [-1.05, -0.6, 0.86]]; // around the sticker on show, out from its edges; z < 1: always in front of it and the laptops
  function famPose(st, p, o, slot, now) { // Swarm: a neighbour peels up, then hangs in its slot facing the viewer, swaying a little
    const lp = lps[st.lid], c = o.pc, f = ease(sstep(0.1 + 0.06 * slot, 0.72 + 0.04 * slot, p)), sy = lp.stk.scale.y; st.fb = st.lift = f;
    if (!c || f <= 0) { if (st.grp.parent !== lp.stk) lp.stk.add(st.grp); st.grp.position.copy(st.home); st.grp.quaternion.identity(); st.grp.scale.setScalar(1); st.mesh.renderOrder = st.ro; return; }
    if (st.grp.parent !== lp.lidG) lp.lidG.add(st.grp);
    const [sx, sy2, sz] = SLOTS[slot], z = c.z * sz, r = ((st.z + 1.3) * 0.618034) % 1, ks = c.size * (0.34 + 0.16 * r) * Math.min(1 / Math.sqrt(st.w * st.h), 1.5 / Math.max(st.w, st.h)), k = ks * sz, fw = ks * st.w / 2, fh = ks * st.h / 2;
    const yc = (y) => Math.min(Math.max(y, -c.vh / 2 + fh + 96 / Hc * c.vh), c.vh / 2 - fh - 72 / Hc * c.vh); // on screen, clear of the copy, the nav and the strip
    const xc = (x) => Math.min(Math.max(x, c.lx + fw), c.vw * 0.48 - fw), pad = 0.03 * c.size, prev = o.fam.slice(0, slot).map((f) => f.pr).filter(Boolean);
    const hit = ([x, y]) => (Math.abs(x - c.x) < c.hw + fw && Math.abs(y - c.y) < c.hh + fh) || prev.some((r) => Math.abs(x - r[0]) < r[2] + fw + pad && Math.abs(y - r[1]) < r[3] + fh + pad);
    const X0 = xc(c.x + sx * (c.hw + 0.3 * c.size)), X1 = xc(c.x - sx * (c.hw + 0.3 * c.size)), Y0 = yc(c.y + sy2 * (c.hh + 0.28 * c.size)), Y1 = yc(c.y + (sy2 >= 0 ? 1 : -1) * (c.hh + fh + 0.04 * c.size)), d = 2.2 * fh;
    const cand = [X0, X1].flatMap((x) => [Y0, Y1, Y0 + d, Y0 - d, Y0 + 2 * d, Y0 - 2 * d].map((y) => [x, yc(y)]));
    const [X, Y] = cand.find((q) => !hit(q)) || cand[0]; st.pr = [X, Y, fw, fh]; // the screen edge or an earlier neighbour is in the way: try above, below, then the other side
    m1.compose(v1.set(X * sz, (Y + 0.03 * c.size * Math.sin(now * 0.0011 + r * 6)) * sz, -z), q1.setFromEuler(e1.set(0.08 * Math.sin(now * 0.0008 + r * 5), 0.14 * Math.sin(now * 0.0007 + r * 3) + pp.x * 0.25, (r - 0.5) * 0.35)), PRES.sc.setScalar(k));
    m2.copy(lp.lidG.matrixWorld).invert().multiply(m1); m2.decompose(PRES.pos, PRES.q, PRES.sc);
    st.grp.position.lerpVectors(PRES.h0.set(st.home.x, st.home.y * sy, st.home.z), PRES.pos, f); st.grp.position.z += Math.sin(f * Math.PI) * 0.5; // arcs up off the lid
    st.grp.quaternion.identity().slerp(PRES.q, ease(sstep(0.3, 1, f))); st.grp.scale.set(lerp(1, PRES.sc.x, f), lerp(sy, PRES.sc.x, f), lerp(1, PRES.sc.x, f));
    st.mesh.renderOrder = 8000 + st.ro; if (st.fill) st.fill.renderOrder = 8001 + st.ro;
  }
  let focusSt = null, grab = null; // the sticker on show in a beat: the visitor can turn it, click it for its story
  const SHM = new THREE.Matrix4();
  function tint(st, dim) { // a sticker drawn over the lid's dim layer carries that dim itself until it has lifted off: no pop from dark to lit
    const v = st.mesh.renderOrder >= 7990 ? 1 - dim * (1 - (st.lift ?? 1)) : 1; if (st.mesh.material.color.r !== v) { st.mesh.material.color.setScalar(v); st.fill?.material.color.setScalar(v); }
  }
  function shade(st) {
    const on = st.peel > 1e-4 || st.pres > 0 || st.fb > 0; st.shadow.visible = on; st.mesh.material.depthWrite = on; // depth: the fold hides what it covers
    if (!on) return;
    const stk = lps[st.lid].stk, su = st.shadow.material.userData.su; stk.updateWorldMatrix(true, false); st.mesh.updateWorldMatrix(true, false);
    SHM.copy(stk.matrixWorld).invert(); su.uM.value.multiplyMatrices(SHM, st.mesh.matrixWorld); su.uLd.value.copy(key.position).negate().transformDirection(SHM);
    su.uZ.value = st.home.z + 0.0004; su.uOp.value = 0.6 * sstep(0.15, 0.4, -su.uLd.value.z); // no shadow when the key light is behind the lid
  }
  function present(st, a, now, back) {
    const lp = lps[st.lid];
    const bi = beats.findIndex((b) => b.dataset.sticker === st.lid + ':' + st.id), off = bi >= 0 && !!beats[bi].querySelector('.side.off'), cx = Math.max(0, bi) % 2 ? -1 : 1; // alternate the starting corner
    const peelA = back ? 0 : 0.85 * sstep(0.02, off ? 0.4 : 0.48, a), fly = ease(sstep(back ? 0.25 : 0.42, 0.92, a)), rise = back ? fly : ease(sstep(off ? 0.3 : 0.36, 0.62, a)); // offense rips faster; it rises just before the last corner lets go
    const dir = new THREE.Vector2(-0.35 * cx, st.home.y > 0 ? -1 : 1).normalize(), ext = (Math.abs(dir.x) * st.w + Math.abs(dir.y) * st.h) / 2; // from the outer edge toward the lid centre: the folded sticker lands on the lid, not off its edge
    st.lift = Math.max(0, rise); // how far it has left the dimmed lid (tint)
    const lift = back ? 0 : 2.5 * (1 - sstep(0.4, 0.55, a)), flip = back ? 0 : 2.5 - lift + (Math.PI * 2 - 2.5) * ease(sstep(0.45, 0.85, a)); // the curl stiffens into a sheet (flip takes over its angle), then turns on over: shiny back, then face
    st.u.uC.value.copy(dir).multiplyScalar(-ext); st.u.uD.value.copy(dir); st.u.uTh.value = Math.max(lift, 1e-3); st.u.uLift.value = 0.05 * lift / 2.5; st.u.uR.value = Math.min(st.w, st.h) * 0.1;
    st.u.uL.value = st.peel = st.peelTarget = peelA * 2 * ext;
    if (rise <= 0) { if (st.grp.parent !== lp.stk) lp.stk.add(st.grp); if (focusSt === st) focusSt = null; st.grp.position.copy(st.home); st.grp.quaternion.identity(); st.grp.scale.setScalar(1); st.mesh.renderOrder = a > 0 ? 9000 : st.ro; return; }
    // target in camera space: beside the laptop, big, facing the viewer
    const z = lp.root.position.length() * 0.6 + 2, vh = z * ky(), vw = z * kx();
    const odd = bi % 2, size = (portrait ? 0.27 : 0.4) * vh;
    const k = size * Math.min(1 / Math.sqrt(st.w * st.h), 1.5 / Math.max(st.w, st.h)); // by area: wide stickers (DEFCON) get height, not a sliver
    let tx = odd ? 0.02 : 0.08, lx = -0.48 * vw;
    if (!portrait && bi >= 0) { const inn = beats[bi].querySelector('.inner'); tx = Math.max(tx, (inn.offsetLeft + inn.offsetWidth + 32) / Wc - 0.5 + (k * st.w) / vw / 2); lx = ((inn.offsetLeft + inn.offsetWidth + 24) / Wc - 0.5) * vw; } // clear the copy column
    const tgt = portrait ? [0, (odd ? 0.3 : 0.32) * vh] : [tx * vw, (odd ? 0.21 : 0.19) * vh]; // just above its laptop, lifting off it
    st.pc = { x: tgt[0], y: tgt[1], z, size, vw, vh, lx, hw: k * st.w / 2, hh: k * st.h / 2 }; // where it hangs, for its swarm
    // flies in lidG (unscaled): spinning inside the y-stretched stk group skewed it
    const sy = lp.stk.scale.y, h0 = PRES.h0.set(st.home.x, st.home.y * sy, st.home.z);
    if (st.grp.parent !== lp.lidG) lp.lidG.add(st.grp);
    const sway = (st.holo ? 0.45 : 0.32) * Math.sin(now * 0.0009) * fly; // holo stickers swing wider so the foil catches light
    m1.compose(v1.set(tgt[0], tgt[1], -z), q1.setFromEuler(e1.set(0.05 * Math.sin(now * 0.0007), sway, 0)), PRES.sc.setScalar(k));
    m2.copy(lp.lidG.matrixWorld).invert().multiply(m1); m2.decompose(PRES.pos, PRES.q, PRES.sc);
    st.grp.position.lerpVectors(h0, lp.lidG.worldToLocal(camera.getWorldPosition(v1)), back ? 0 : 0.3 * rise).lerp(PRES.pos, fly); // straight at the viewer first, then across to its spot
    const u = st.ur ??= { x: 0, y: 0, vx: 0, vy: 0, t: now }, dt2 = Math.min(0.05, (now - u.t) / 1000), kk = 1 - Math.exp(-dt2 * 5); u.t = now;
    if (grab?.st !== st) { u.x += u.vx * dt2; u.y += u.vy * dt2; u.vx *= 1 - kk; u.vy *= 1 - kk; if (Math.abs(u.vx) + Math.abs(u.vy) < 3) { const T = Math.PI * 2; u.x += (Math.round(u.x / T) * T - u.x) * kk; u.y += (Math.round(u.y / T) * T - u.y) * kk; } } // let go: coast, then settle face-on
    const w = sstep(0.8, 1, a);
    st.grp.quaternion.identity().slerp(PRES.q, fly).multiply(PRES.fq.setFromAxisAngle(PRES.ax.set(-dir.y, dir.x, 0), flip)).multiply(PRES.uq.setFromEuler(e1.set((u.x + pp.y * 0.28) * w, (u.y + pp.x * 0.4) * w, 0)));
    st.grp.scale.set(lerp(1, PRES.sc.x, fly), lerp(sy, PRES.sc.x, fly), lerp(1, PRES.sc.x, fly));
    const hb = PRES.hb.set(dir.x * (st.peel - ext) * st.grp.scale.x, dir.y * (st.peel - ext) * st.grp.scale.y, 0); st.grp.position.add(hb.sub(v1.copy(hb).applyAxisAngle(PRES.ax, flip)).multiplyScalar(1 - sstep(0.5, 0.7, a))); // hinged on the peel line while the curl lets go, then it turns about its centre
    if (a > 0.85) focusSt = st;
    st.mesh.renderOrder = 9000; if (st.fill) st.fill.renderOrder = 9001;
  }

  // ---------- finale: tilt, peel, click for the story ----------
  const tilt = { old: { x: 0, y: 0, tx: 0, ty: 0 }, new: { x: 0, y: 0, tx: 0, ty: 0 } };
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let play = false, drag = null, hov = null;
  const toNdc = (e) => ndc.set((e.clientX / Wc) * 2 - 1, -(e.clientY / Hc) * 2 + 1);
  function alphaAt(st, u, v) {
    if (!st.alpha) { const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d'); x.drawImage(st.img, 0, 0, 96, 96); st.alpha = x.getImageData(0, 0, 96, 96).data; }
    return st.alpha[(Math.min(95, (1 - v) * 96 | 0) * 96 + Math.min(95, u * 96 | 0)) * 4 + 3] / 255;
  }
  function hit(e) {
    toNdc(e); ray.setFromCamera(ndc, camera);
    const hs = ray.intersectObjects(stickers.map((st) => st.mesh), false).sort((a, b) => b.object.renderOrder - a.object.renderOrder);
    for (const h of hs) { const st = h.object.userData.s; if (alphaAt(st, h.uv.x, h.uv.y) >= 0.5) return st.locked ? { lp: st.lid } : { st, h }; } // a locked sticker is part of the lid: grabbing it tilts the laptop
    const body = ray.intersectObjects([...lps.old.body, ...lps.new.body], true)[0];
    return body ? { lp: body.object.parent === lps.old.lidG || lps.old.body.includes(body.object) ? 'old' : 'new' } : null;
  }
  const showCard = (st) => window.openCard?.(st.lid + ':' + st.id);
  const nearSticker = (e) => { for (const r of [8, 16, 24]) for (let i = 0; i < 8; i++) { const h = hit({ clientX: e.clientX + r * Math.cos(i * Math.PI / 4), clientY: e.clientY + r * Math.sin(i * Math.PI / 4) }); if (h?.st) return h.st; } return null; }; // a click in a gap between stickers still means a sticker
  canvas.addEventListener('pointerdown', (e) => {
    if (!play) return; const h = hit(e); hov = null;
    if (!h) return; // empty canvas: the browser scrolls (touch-action: pan-y)
    canvas.setPointerCapture(e.pointerId);
    if (h.st) {
      const st = h.st, lp = new THREE.Vector2((h.h.uv.x - 0.5) * st.w, (h.h.uv.y - 0.5) * st.h);
      drag = { st, start: lp, inward: lp.clone().multiplyScalar(-1).normalize(), plane: h.h.point.clone(), x: e.clientX, y: e.clientY, edge: Math.hypot(lp.x / (st.w / 2), lp.y / (st.h / 2)) > 0.45 };
      drag.pending = e.pointerType === 'touch'; // touch: a quick vertical swipe scrolls; hold first to peel or tilt
      if (drag.edge) { st.u.uR.value = Math.min(st.w, st.h) * 0.07; pull(st, lp, drag.inward, 0); st.mesh.renderOrder = 9000; }
    } else drag = { lp: h.lp, x: e.clientX, y: e.clientY, tx: tilt[h.lp].tx, ty: tilt[h.lp].ty, pending: e.pointerType === 'touch', near: nearSticker(e) };
    drag.t0 = performance.now(); const armed = drag;
    if (drag.pending) setTimeout(() => { if (drag === armed && drag.pending) drag.pending = false; }, 250); // held still: the next touchmove is ours, so the browser never starts a scroll
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!play) return;
    if (!drag) {
      const h = e.pointerType === 'mouse' ? hit(e) : null, edge = h?.st && Math.hypot(h.h.uv.x - 0.5, h.h.uv.y - 0.5) > 0.225 ? h.st : null;
      if (hov && hov !== edge) { hov.peelTarget = 0; hov = null; }
      if (edge && !hov && edge.peel < 1e-3) { const lp = new THREE.Vector2((h.h.uv.x - 0.5) * edge.w, (h.h.uv.y - 0.5) * edge.h); edge.u.uR.value = Math.min(edge.w, edge.h) * 0.07; pull(edge, lp, lp.clone().multiplyScalar(-1).normalize(), Math.hypot(edge.w, edge.h) * 0.11); hov = edge; } // the edge lifts a little in its own layer: raising it popped it over its neighbours
      canvas.style.cursor = h ? (edge || !h.st ? 'grab' : 'pointer') : ''; return;
    }
    if (drag.pending) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) < 8) return; if (Math.abs(dy) > Math.abs(dx) && performance.now() - drag.t0 < 250) { if (drag.st) drag.st.peelTarget = 0; drag = null; return; } drag.pending = false; } // quick vertical swipe: left to the browser's own scroll
    if (drag.lp) { tilt[drag.lp].tx = THREE.MathUtils.clamp(drag.tx + (e.clientX - drag.x) * 0.004, -0.6, 0.6); tilt[drag.lp].ty = THREE.MathUtils.clamp(drag.ty + (e.clientY - drag.y) * 0.003, -0.35, 0.35); return; }
    if (!drag.edge) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) { const k = drag.st.lid; drag = { lp: k, x: e.clientX, y: e.clientY, tx: tilt[k].tx, ty: tilt[k].ty }; } return; } // mid-sticker drag tilts the laptop
    toNdc(e); ray.setFromCamera(ndc, camera);
    const st = drag.st, pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(st.grp.getWorldQuaternion(new THREE.Quaternion())), drag.plane);
    const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(pl, p)) return;
    const local = st.grp.worldToLocal(p), v = new THREE.Vector2(local.x - drag.start.x, local.y - drag.start.y), n = v.length();
    if (n > 1e-4) pull(st, drag.start, v.divideScalar(n), n, drag.inward);
  });
  const release = (e) => {
    if (!drag) return;
    if (drag.st) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) showCard(drag.st); drag.st.peelTarget = 0; }
    else if (drag.near && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) showCard(drag.near);
    drag = null; canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('touchmove', (e) => { if (drag && !drag.pending && e.cancelable) e.preventDefault(); }, { passive: false });
  // fold line = perpendicular bisector of grab point -> pointer: the grabbed corner follows the pointer in any direction.
  // Pulling away from the sticker: the peel front still runs inward and the flap stands up toward the pull instead of lying flat.
  function pull(st, P0, dir, len, inward = dir) {
    const out = dir.dot(inward) < 0, D = out ? dir.clone().addScaledVector(inward, -2 * dir.dot(inward)) : dir.clone();
    const th = 2.5 - (2.5 - 1.15) * THREE.MathUtils.smoothstep(-dir.dot(inward), 0, 0.6); // 2.5 rad: the flap leans back 37 deg like vinyl; pi folded it flat like paper
    const ax = (c, d, half) => (d > 1e-6 ? (c + half) / d : d < -1e-6 ? (half - c) / -d : Infinity);
    const e0 = Math.min(ax(P0.x, D.x, st.w / 2), ax(P0.y, D.y, st.h / 2));
    st.u.uC.value.copy(P0).addScaledVector(D, -e0); st.u.uD.value.copy(D); st.u.uTh.value = th;
    st.peelTarget = Math.min(e0 + (len + th * st.u.uR.value) / 2, e0 + Math.hypot(st.w, st.h) * 1.05);
  }
  window.__peel = (key, f, ang = 0.6) => { // qa hook: peel sticker 'lid:id' by fraction f of its diagonal, pulled at angle ang from a corner
    const st = byKey[key]; if (!st) return false;
    if (f == null) { st.peelTarget = 0; return true; }
    const P0 = new THREE.Vector2(st.w * 0.48, st.h * 0.48), dir = new THREE.Vector2(-Math.cos(ang), -Math.sin(ang));
    st.u.uR.value = Math.min(st.w, st.h) * 0.07; pull(st, P0, dir, f * Math.hypot(st.w, st.h), dir); st.mesh.renderOrder = 9000;
    const c = st.grp.getWorldPosition(new THREE.Vector3()).project(camera), half = Math.hypot(st.w, st.h) / 2, ed = st.grp.localToWorld(new THREE.Vector3(half, 0, 0)).project(camera);
    return { x: (c.x + 1) / 2 * Wc, y: (1 - c.y) / 2 * Hc, rad: Math.abs(ed.x - c.x) / 2 * Wc };
  };
  window.__scene = () => ({ P, Ps, n: secs.length });

  // ---------- loop ----------
  const inners = secs.map((s) => s.querySelector('.inner'));
  let last = performance.now(), running = true, shownShot = [-2, -2], frameN = 0;
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    // adaptive resolution: if the median frame over ~1 s is slower than 55 fps, drop the pixel ratio a step (never below 1)
    if (now > 4000 && !document.hidden) { fts.push(now - lastF); if (fts.length >= 60) { fts.sort((a, b) => a - b); if (fts[30] > 18.2 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); renderer.setSize(Wc, Hc, false); } fts.length = 0; } } lastF = now;
    // critically damped spring toward the scroll position: weight without overshoot
    lenis.raf(now); Ps = P; // Lenis already carries the weight; a second spring only adds lag
    const i = Math.max(0, Math.min(states.length - 1, Math.floor(Ps))), f = clamp01(Ps - i), j = Math.min(states.length - 1, i + 1);
    const a = states[i], b = states[j], tsc = secs[i].dataset.scene, nsc = secs[j].dataset.scene;
    let h = ease(sstep(0.45, 0.97, f)); // hold still for the first 45% of each moment, then move
    if (tsc === 'cv') h = ease(sstep(1 - Hc / Math.max(Hc, tops[j] - tops[i]), 1, f)); // the CV is several screens tall: keep the laptops away until its last screen
    const s = mix(a, b, h); s.old = mix(a.old, b.old, h); s.new = mix(a.new, b.new, h);
    if (tsc === 'cv') s.co = b.co * sstep(0.55, 1, h); // no half-faded laptop behind the CV text
    // photo -> 3D: first the camera flies to the photographed laptop, then the laptop lifts out of the photo
    let fr;
    if (tsc === 'q' && nsc === 'reveal') {
      const z = ease(sstep(0, 0.4, f)), x = ease(sstep(0.44, 0.92, f)), A = frameOf('cover'), B = frameOf('lid'), C = frameOf('free');
      fr = z < 1 || x <= 0 ? lerpFrame(A, B, z) : lerpFrame(B, C, x);
      s.co = sstep(0.36, 0.42, f); s.po = 1 - sstep(0.42, 0.56, f); s.pk = 1 - x; s.old = b.old; // pk carries it from the photo to the reveal pose (mixing in the question's pose sent it off-screen left). The 3D laptop appears under its photo card, then the photo goes
      dimO = sstep(0.08, 0.38, f); cardO = 1 - sstep(0.45, 0.53, f);
    } else { fr = lerpFrame(frameOf(a.pm), frameOf(b.pm), h); dimO = cardO = 0; }
    card.visible = cardO > 0; cardMat.opacity = cardO;
    const photoOn = s.po > 0.001 || dimO > 0.001; photoBox.style.visibility = photoOn ? '' : 'hidden'; // an invisible photo is not restyled or composited every frame
    if (photoOn) { stageDim.style.transform = `translate(${fr.Tx}px, ${fr.Ty}px) scale(${fr.S})`; stageDim.style.opacity = dimO;
      photo.style.transform = `translate(${fr.Tx}px, ${fr.Ty}px) scale(${fr.S})`;
      photoBox.style.clipPath = `inset(${fr.clip[0]}px ${fr.clip[1]}px ${fr.clip[2]}px ${fr.clip[3]}px round ${fr.clip[4]}px)`;
      photoBox.style.opacity = s.po; photoBox.style.filter = s.po < 1 ? `blur(${(1 - s.po) * 8}px)` : ''; }
    canvas.style.opacity = s.co;
    camera.setViewOffset(PHOTO.w * fr.S, PHOTO.h * fr.S, -fr.Tx, -fr.Ty, Wc, Hc);
    // laptops
    play = secs[Math.round(Ps)]?.dataset.scene === 'finale' && Math.abs(Ps - Math.round(Ps)) < 0.2;
    root.classList.toggle('play', play);
    swapS += (finLid - swapS) * (1 - Math.exp(-dt * 7));
    pp.x += (pointer.x - pp.x) * (1 - Math.exp(-dt * 3)); pp.y += (pointer.y - pp.y) * (1 - Math.exp(-dt * 3));
    if (portrait && !OG) { const wf = (nsc === 'finale' ? h : 0) + (tsc === 'finale' ? 1 - h : 0); s.old.x -= swapS * 1.3 * wf; s.new.x += (1 - swapS) * 1.3 * wf; } // one laptop at a time, slid in from the side
    for (const k of ['old', 'new']) {
      const t = tilt[k]; if (!drag || drag.lp !== k) { t.tx *= Math.exp(-dt * 1.2); t.ty *= Math.exp(-dt * 1.2); }
      t.x += (t.tx - t.x) * (1 - Math.exp(-dt * 8)); t.y += (t.ty - t.y) * (1 - Math.exp(-dt * 8));
      placeLaptop(lps[k], s[k], k === 'old' ? s.pk : 0, { x: t.y + pp.y * 0.06 * (1 - s.pk), y: t.x + pp.x * 0.1 * (1 - s.pk) }); // leans toward the cursor; still while it is part of the photo
      lps[k].root.visible = Math.abs(s[k].x) < 1.4;
      lps[k].root.updateMatrixWorld(true);
      const el = era[k], eo = lps[k].root.visible ? sstep(0.75, 1, s.era) * s.co : 0; el.style.opacity = eo.toFixed(3); if (eo > 0.01) { const tp = v1.set(0, lps[k].H / 2 + 0.25, 0).applyMatrix4(lps[k].lidG.matrixWorld).project(camera); el.style.transform = `translate(${((tp.x + 1) / 2 * Wc).toFixed(1)}px, ${((1 - tp.y) / 2 * Hc).toFixed(1)}px) translate(-50%, -100%)`; }
    }
    { // light pool behind the laptop in front; its colour follows the moment's chip (cyan Engineering, pink Offense)
      const k = Math.abs(s.old.x) < Math.abs(s.new.x) ? 'old' : 'new', p = v1.setFromMatrixPosition(lps[k].lidG.matrixWorld).project(camera), side = secs[Math.round(Ps)]?.querySelector('.side');
      const on = Math.abs(s[k].x) < 0.9 ? s.co : 0, want = { eng: side?.classList.contains('eng') ? 1 : 0, off: side?.classList.contains('off') ? 1 : 0 };
      want.base = 1 - want.eng - want.off;
      auraXY.x += ((p.x + 1) / 2 * Wc - auraXY.x) * (1 - Math.exp(-dt * 6)); auraXY.y += ((1 - p.y) / 2 * Hc - auraXY.y) * (1 - Math.exp(-dt * 6));
      aura.style.transform = `translate3d(${auraXY.x}px, ${auraXY.y}px, 0)`;
      for (const n of ['base', 'eng', 'off']) { auraO[n] += (want[n] * on - auraO[n]) * (1 - Math.exp(-dt * 3)); auraEls[n].style.opacity = auraO[n].toFixed(3); }
      const ke = auraO.eng, ko = auraO.off, kb = Math.max(0, 1 - ke - ko); // glyph tint: cool by default, cyan for Engineering, pink for Offense
      bgDraw?.(now, { x: (pp.x + 1) / 2, y: (1 - pp.y) / 2 }, { x: auraXY.x / Wc, y: 1 - auraXY.y / Hc }, auraO.base + ke + ko, [0.16 * kb + 0.1 * ke + 0.55 * ko, 0.38 * kb + 0.48 * ke + 0.16 * ko, 0.5 * kb + 0.58 * ke + 0.38 * ko], OG);
    }
    // printer: slides in beside the MacBook, prints the ticket once the moment settles, resets when you leave
    printer.visible = s.fax > 0.01;
    if (printer.visible) {
      paperLive = s.fax > 0.95; if (s.fax < 0.3 && tickets[tk].mode !== 'wait') { pgrab = null; root.classList.remove('grabbing'); for (const t of tickets) resetTicket(t); resetTicket(tickets[tk], 'wait'); } // leaving resets both tickets
      const printing = paperLive && paperTick(dt, now);
      printer.rotation.y = Math.PI - 0.55;
      printer.position.set(nbb.min.x - pInfo.W * (portrait ? 0.75 : 0.95) - (1 - ease(s.fax)) * 3, nbb.min.y + (printing ? 0.0015 * Math.sin(now * 0.09) : 0), nbb.min.z * 0.45);
      PM.led.color.setRGB(0.24, printing ? 0.55 + 0.45 * Math.sin(now * 0.02) : 1, 0.53);
    }
    phoneRig.visible = s.buzz > 0.01; // the phone slides in beside the MacBook
    if (phoneRig.visible) { phoneRig.rotation.y = Math.PI - 0.22; phoneRig.scale.setScalar(1.3); phoneRig.position.set(nbb.min.x - PW * (portrait ? 0.9 : 1.1) - (1 - ease(s.buzz)) * 3, nbb.min.y, nbb.min.z * 0.35); phone.position.y = PH / 2 + 0.16 + 0.03 * Math.sin(now * 0.0015); phone.rotation.x = -0.1; }
    frameN = (frameN + 1) % 2; // screens redraw at 30 fps
    for (const tr of terms) { const near = tr.k >= 0 && Math.abs(Ps - tr.k) < 0.8; if (near && !tr.on) tr.t0 = now; tr.on = near; if (near && frameN % 2 === 0) { tr.tm.draw((now - tr.t0) / 1000); tr.tex.needsUpdate = true; } }
    if (buzzK >= 0 && Math.abs(Ps - buzzK) < 0.8 && frameN === 0) bzDraw((now / 1000) % 12);
    // screens: cross-fade between the two scenes' screenshots, lit only once the lid is open
    shotList.forEach((n, i) => { if (!shotTexs[i] && !shots[n] && Math.abs(Ps - shotK[i]) < 2.5) shotTex(n).then((t) => { shotTexs[i] ||= t; shownShot[0] = shownShot[1] = -2; }); });
    for (const o of vids) { if (o.fresh) { o.fresh = false; shownShot[0] = shownShot[1] = -2; } if (o.v.preload === 'none' && Math.abs(Ps - o.k) < 2.5) { o.v.preload = 'auto'; o.v.load(); }
      const see = o.k >= 0 && Math.abs(Ps - o.k) < 0.6 && !document.hidden; if (see === o.v.paused) see ? o.v.play().catch(() => {}) : o.v.pause(); }
    const dsp = lps.new.displays, on = sstep(-0.6, 0.1, lps.new.pivot.rotation.x);
    for (const [n, shot] of [[0, a.shot], [1, b.shot]]) {
      if (shownShot[n] !== shot) { shownShot[n] = shot; dsp[n].material.map = shot >= 0 ? shotTexs[shot] : null; dsp[n].material.color.set(dsp[n].material.map ? 0xffffff : 0x000000); dsp[n].material.needsUpdate = true; }
    }
    dsp[0].material.opacity = (a.shot >= 0 ? 1 : 0) * on; dsp[1].material.opacity = (b.shot >= 0 ? h : 0) * on;
    film.classList.toggle('on', Ps > stripK[0] - 0.5 && Ps < stripK[1] + 0.5); const sn = beats.indexOf(secs[Math.round(Ps)]);
    if (sn >= 0 && sn !== stripN) { stripN = sn; stripB.forEach((bt, n) => bt.toggleAttribute('aria-current', n === sn)); stripC.textContent = `${String(sn + 1).padStart(2, '0')} / ${beats.length}`; }
    // beat stickers
    const famA = new Map(); for (const [n, sc] of [[i, a], [j, b]]) { const o = sc.pres && byKey[sc.pres]; if (o?.fam) { const p = 1 - sstep(0.08, 0.8, Math.abs(Ps - n)); o.fam.forEach((f, slot) => { if (p > (famA.get(f)?.p || 0)) famA.set(f, { p, o, slot }); }); } }
    let dm = 0; for (const v of famA.values()) dm = Math.max(dm, v.p); const dimNow = 0.6 * ease(sstep(0.1, 0.6, dm)); for (const k in lidDim) { lidDim[k].visible = dimNow > 0.003; lidDim[k].material.opacity = dimNow; } // both lids dim under the stickers on show
    for (const st of stickers) {
      let pr = 0, back = false; for (const [n, sc] of [[i, a], [j, b]]) if (sc.pres === st.lid + ':' + st.id) { const p = 1 - sstep(0.08, 0.8, Math.abs(Ps - n)); if (p > pr) { pr = p; back = Ps > n; } }
      if (pr > 0 || st.pres > 0) { present(st, pr, now, back); st.pres = pr; if (!pr) { st.peelTarget = 0; st.mesh.renderOrder = st.ro; } shade(st); tint(st, dimNow); continue; }
      const fm = famA.get(st); if (fm) { st.fo = fm.o; st.fs = fm.slot; } if (fm || st.fb) famPose(st, fm ? fm.p : 0, st.fo, st.fs, now);
      if (st.peelTarget !== st.peel) {
        st.peel += (st.peelTarget - st.peel) * (1 - Math.exp(-dt * (st.peelTarget ? (st === hov ? 7 : 18) : 9)));
        if (Math.abs(st.peelTarget - st.peel) < 0.0005) st.peel = st.peelTarget;
        st.u.uL.value = st.peel; if (!st.peel) { st.mesh.renderOrder = st.ro; if (st.fill) st.fill.renderOrder = st.ro + 1; }
      }
      st.u.uTilt.value = tilt[st.lid].x * 3 + tilt[st.lid].y * 2 + pp.x + Math.sin(now * 0.0004) * 0.15; shade(st); tint(st, dimNow);
    }
    // text: each moment's copy holds through its hold, fades out as the scene moves, and the next fades in as the scene arrives
    for (let n = 0; n < inners.length; n++) if (inners[n] && secs[n].dataset.scene !== 'cv') {
      const d = Ps - n, o = d >= 0 ? 1 - sstep(0.5, 0.64, d) : 1 - sstep(0.12, 0.26, -d), el = inners[n]; el.style.opacity = o;
      if (el.style.position === 'fixed') { el.style.visibility = o < 0.01 ? 'hidden' : ''; el.style.pointerEvents = o < 0.5 ? 'none' : ''; } else el.style.transform = `translateY(${d * -24}px)`;
    }
    if (s.co > 0.001) {
      const gl = renderer.getContext(), tq = PERF && PERF.ext && gl.createQuery(); if (tq) gl.beginQuery(PERF.ext.TIME_ELAPSED_EXT, tq);
      renderer.render(scene, camera);
      if (PERF) { if (tq) { gl.endQuery(PERF.ext.TIME_ELAPSED_EXT); PERF.q.push(tq); } while (PERF.q.length && gl.getQueryParameter(PERF.q[0], gl.QUERY_RESULT_AVAILABLE)) { const q = PERF.q.shift(); PERF.ft.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); } PERF.info = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, progs: renderer.info.programs.length, tex: renderer.info.memory.textures }; } // qa ?perf: render + GPU sync time
    }
    if (running) requestAnimationFrame(tick);
  }
  function lerpFrame(A, B, t) { return { S: Math.exp(lerp(Math.log(A.S), Math.log(B.S), t)), Tx: lerp(A.Tx, B.Tx, t), Ty: lerp(A.Ty, B.Ty, t), clip: A.clip.map((v, n) => lerp(v, B.clip[n], t)) }; }
  const pointer = { x: 0, y: 0 }, pp = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => { pointer.x = e.clientX / Wc * 2 - 1; pointer.y = e.clientY / Hc * 2 - 1; }, { passive: true });
  // the sticker on show in a beat: hover tilts it toward the pointer, drag turns it (the shiny back), click opens its story
  const overFocus = (e) => { if (!focusSt || play) return false; toNdc(e); ray.setFromCamera(ndc, camera); const h = ray.intersectObject(focusSt.mesh, false)[0]; return !!h && alphaAt(focusSt, h.uv.x, h.uv.y) >= 0.5; };
  const tip = Object.assign(document.createElement('div'), { className: 'tip' }); tip.setAttribute('aria-hidden', 'true'); document.body.append(tip); // names the sticker under the cursor
  const overShow = (e) => { // the sticker on show or one of its swarm, by opaque pixel
    if (!focusSt || play) return null; toNdc(e); ray.setFromCamera(ndc, camera); const list = [focusSt, ...(focusSt.fam || []).filter((f) => f.fb > 0.9)];
    for (const h of ray.intersectObjects(list.map((s) => s.mesh), false)) { const st = list.find((s) => s.mesh === h.object); if (alphaAt(st, h.uv.x, h.uv.y) >= 0.5) return st; } return null;
  };
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && !grab && !pgrab) { const st = overShow(e); tip.classList.toggle('on', !!st); if (st) { tip.textContent = st.name; tip.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 18}px)`; } }
    if (grab) { const dx = e.clientX - grab.x, dy = e.clientY - grab.y, t = performance.now(), ms = Math.max(8, t - grab.t), u = grab.st.ur; u.y += dx * 0.012; u.x += dy * 0.012; u.vy = dx * 12 / ms; u.vx = dy * 12 / ms; grab.moved += Math.abs(dx) + Math.abs(dy); Object.assign(grab, { x: e.clientX, y: e.clientY, t }); return; }
    if (pgrab) { toNdc(e); ray.setFromCamera(ndc, camera); if (ray.ray.intersectPlane(pPlane, pHit)) pgrab.to.copy(printer.worldToLocal(pHit)).add(pgrab.off).sub(SLOT).clampLength(0, PL * 4).add(SLOT).setY(Math.max(pgrab.to.y, 0.02)); return; } // in your hand: it goes where you go, within reason
    if (e.pointerType === 'mouse') root.classList.toggle('grabbable', overFocus(e) || !!overPaper(e));
  }, { passive: true });
  // the FaxMeMaybe ticket: grab it anywhere and it tears off into your hand
  const pPlane = new THREE.Plane(), pHit = new THREE.Vector3();
  const overPaper = (e) => {
    if (!paperLive || play) return null; toNdc(e); ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(tickets.filter((t) => t.mesh.visible && t.mode !== 'fade').map((t) => t.mesh), false)[0]; if (!h) return null;
    const t = tickets.find((q) => q.mesh === h.object), lp = printer.worldToLocal(h.point.clone()); if (t.mode === 'print') return null; let i = 0; t.p.forEach((q, k) => { if (q.distanceToSquared(lp) < t.p[i].distanceToSquared(lp)) i = k; }); // mid-print, the printer still has hold of it
    return { t, i, to: lp, w: h.point };
  };
  addEventListener('touchstart', (e) => { if (e.touches.length === 1 && overPaper(e.touches[0])) e.preventDefault(); }, { passive: false }); // a touch on the paper drags it instead of scrolling
  addEventListener('pointerdown', (e) => {
    const g = !e.button && !e.target.closest('a, button, input, textarea, select, .card, .top') && overPaper(e);
    if (g) { e.preventDefault(); pgrab = g; if (g.t.mode !== 'held') tearOff(g.t); g.t.hd = g.t.q[1].clone().sub(g.t.q[0]).normalize(); g.off = g.t.q[0].clone().sub(g.to); g.i = 0; g.to.copy(g.t.q[0]); g.t.hand.copy(g.t.q[0]); pPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(pHit).negate(), g.w); root.classList.add('grabbing'); return; } // held by its top edge, so it hangs the right way up; no jump at the cursor
    if (e.button || play || e.target.closest('a, button, input, textarea, select, .card, .top') || !overFocus(e)) return;
    e.preventDefault(); grab = { st: focusSt, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }; if (focusSt.ur) focusSt.ur.vx = focusSt.ur.vy = 0; root.classList.add('grabbing');
  });
  addEventListener('click', (e) => { if (e.target.closest('a, button, input, textarea, select, .card, .top, .strip')) return; const st = overShow(e); if (st && st !== focusSt) showCard(st); }); // a swarm sticker opens its own story
  const letGo = (e) => { if (pgrab) { dropTicket(pgrab.t); pgrab = null; root.classList.remove('grabbing'); } if (!grab) return; if (e.type === 'pointerup' && grab.moved < 6) showCard(grab.st); grab = null; root.classList.remove('grabbing'); };
  addEventListener('pointerup', letGo); addEventListener('pointercancel', letGo);
  document.addEventListener('visibilitychange', () => { const was = running; running = !document.hidden; if (running && !was) { last = performance.now(); requestAnimationFrame(tick); } });
  if (OG) { root.classList.add('og'); document.body.insertAdjacentHTML('beforeend', '<div class="ogt"><h1>Youssef Awad</h1><p>DeadPackets</p></div>'); readScroll(); Ps = P; }
  { const hid = []; scene.traverse((o) => { if (!o.visible) { hid.push(o); o.visible = true; } }); // warm-up while the hero photo shows: compile every shader and upload every texture now, or the reveal stalls on its first draw
    const vd = lps.new.displays[0].material, vm = vd.map, vt = new THREE.VideoTexture(vids[0].v); vt.colorSpace = THREE.SRGBColorSpace; vd.map = vt; // the screen-recording shader too, or the first video screen compiles mid-scroll
    await renderer.compileAsync(scene, camera).catch(() => {}); vd.map = vm; vt.dispose();
    scene.traverse((o) => { for (const m of o.material ? [].concat(o.material) : []) { const pu = renderer.properties.get(m).uniforms || {}; for (const t of [...Object.values(m), ...Object.values(pu).map((v) => v.value)]) if (t?.isTexture && !t.isVideoTexture) renderer.initTexture(t); } }); // shader uniforms hold textures too (the sticker backs)
    for (const o of hid) o.visible = false; }
  root.classList.add('gl');
  requestAnimationFrame(tick);
}

function keyTex(info, dark) { // key legends, drawn in the top-down UV box that models/build.py gives the key mesh
  const [x0, y0, x1, y1] = info.keys.box, cw = 2048, ch = Math.round(cw * (y1 - y0) / (x1 - x0)), c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d'), sx = cw / (x1 - x0), sy = ch / (y1 - y0); g.fillStyle = dark ? '#111113' : '#2b2c31'; g.fillRect(0, 0, cw, ch);
  g.fillStyle = dark ? '#d6d6da' : '#e8e8ec'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const kk of info.keys.list) { if (!kk.l) continue; const px = kk.w * sx, big = kk.l.length === 1; g.font = `500 ${Math.round(px * (big ? 0.36 : 0.2))}px -apple-system, "Helvetica Neue", Arial, sans-serif`; g.fillText(kk.l, (kk.x - x0) * sx, (kk.y - y0) * sy); }
  const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// chrome hand environment: a flat mirror reflects almost one direction (back at the viewer), so that direction gets a hot studio wall
// with dark strips and a falloff; pointer tilt sweeps the strip edges across the hand
function softboxRoom() {
  const sc = new THREE.Scene(), c = document.createElement('canvas'); c.width = 512; c.height = 256; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#fff'); g.addColorStop(0.55, '#e9eef6'); g.addColorStop(1, '#aeb6c4'); x.fillStyle = g; x.fillRect(0, 0, 512, 256);
  x.fillStyle = '#14161c'; for (const [px, w] of [[120, 14], [300, 8], [380, 18]]) x.fillRect(px, 0, w, 256);
  x.fillRect(0, 168, 512, 6);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  sc.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ color: 0x0b0c10, side: THREE.BackSide })));
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(3.2, 3.2, 3.2), side: THREE.DoubleSide }));
  wall.position.set(1.2, 0.6, 5); wall.lookAt(0, 0, 0); sc.add(wall);
  return sc;
}

// ---------- canvas textures ----------
const backs = {};
function backTex(flag, asp) { // the sticky side: mirror-silver release liner with a faint repeat print (the shader makes it metal + holo)
  const W = 512, h0 = Math.max(64, Math.round(512 / asp)), H = flag ? h0 : Math.round(64 * 2 ** (Math.round(Math.log2(h0 / 64) * 8) / 8)), key = flag + ':' + H; if (backs[key]) return backs[key]; // shared per 1/8 octave of height (print stretch <= 4.6%): 79 textures were ~80 MB of GPU memory, uploaded at once on the reveal
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#cfd5dd'); g.addColorStop(0.5, '#f4f6f9'); g.addColorStop(1, '#c3cad3'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.save(); x.rotate(-0.35); x.fillStyle = 'rgba(40,48,60,0.07)'; x.font = '600 18px "JetBrains Mono", monospace';
  for (let yy = -H; yy < H * 2; yy += 30) for (let xx = -W; xx < W * 2; xx += 180) x.fillText('DEADPACKETS', xx + (yy / 30 % 2) * 90, yy);
  x.restore();
  if (flag) {
    x.fillStyle = '#2a2b30'; x.font = `600 ${Math.round(H * 0.3)}px "JetBrains Mono", monospace`; x.textBaseline = 'middle';
    for (const [al, px] of [['left', W * 0.05], ['right', W * 0.95]]) { x.textAlign = al; x.fillText(FLAG.slice(0, 10), px, H * 0.32); x.fillText(FLAG.slice(10), px, H * 0.68); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return (backs[key] = t);
}
