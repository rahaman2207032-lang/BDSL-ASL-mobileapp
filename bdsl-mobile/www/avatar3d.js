// ======================= avatar3d.js : realistic 3D signer (VRM model) =======================
// Loads a 3D character (www/models/avatar.vrm, made with VRoid / any VRM 0.x or 1.0 model) and moves its
// arms, hands, fingers, shoulders and head from the same sign data the 2D avatar uses.
// It replaces drawAvatar() once the model has loaded; until then (or if WebGL / the file is missing)
// the 2D avatar from avatar.js keeps working, so nothing breaks.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "models/avatar.vrm";
const S = 32767 / 4;                        // .bsl int16 -> shoulder-width units
const Z_POSE = 0.45, Z_HAND = 1.0;          // MediaPipe depth is exaggerated for the body, fine for hands

let renderer, scene, camera, root, ready = false, lost = false, gaveUp = false, quality = 1, bones = {}, rest = {}, blink = [], camInfo = null;

// ---------- load ----------
async function init() {
  const cv = document.createElement("canvas");
  renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  // Android can take the GPU away (app in background, low memory). Keep the 3D signer and wait for it back.
  cv.addEventListener("webglcontextlost", e => { e.preventDefault(); lost = true; console.warn("[avatar3d] GPU context lost - waiting"); });
  cv.addEventListener("webglcontextrestored", () => { lost = false; redrawAll(); console.log("[avatar3d] GPU context restored"); });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f6f88, 1.25));
  const key = new THREE.DirectionalLight(0xfff4ea, 1.35); key.position.set(0.8, 1.5, 2.0); scene.add(key);
  camera = new THREE.PerspectiveCamera(20, 1, 0.1, 20);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);
  const json = gltf.parser.json, ext = json.extensions || {};
  root = gltf.scene; scene.add(root);

  // humanoid bones (VRM 0.x: extensions.VRM, VRM 1.0: extensions.VRMC_vrm)
  const nodeOf = async i => gltf.parser.getDependency("node", i);
  if (ext.VRM) {
    for (const hb of ext.VRM.humanoid.humanBones) bones[hb.bone] = await nodeOf(hb.node);
    root.rotation.y = Math.PI;                                     // VRM 0.x faces -Z; turn it to the camera
  } else if (ext.VRMC_vrm) {
    for (const [name, b] of Object.entries(ext.VRMC_vrm.humanoid.humanBones)) bones[name] = await nodeOf(b.node);
  } else throw new Error("not a VRM file");

  // materials: VRoid exports unlit (MToon fallback). Give them soft toon shading so the body has volume.
  const grad = new THREE.DataTexture(new Uint8Array([168, 168, 168, 255, 236, 236, 236, 255, 255, 255, 255, 255]), 3, 1);
  grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
  root.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const conv = m => {
      const t = new THREE.MeshToonMaterial({ map: m.map, color: m.color, gradientMap: grad, transparent: m.transparent,
        alphaTest: m.alphaTest, side: m.side, depthWrite: m.depthWrite, opacity: m.opacity });
      t.name = m.name; return t;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });

  // blink morph target (VRM 0.x blendShapeGroups / VRM 1.0 expressions)
  const meshPrims = idx => { const out = []; root.traverse(o => { const a = gltf.parser.associations.get(o); if (o.isMesh && a && a.meshes === idx) out.push(o); }); return out; };
  const binds = ext.VRM ? ((ext.VRM.blendShapeMaster.blendShapeGroups.find(g => g.presetName === "blink") || {}).binds || [])
                        : (((ext.VRMC_vrm.expressions || {}).preset || {}).blink || {}).morphTargetBinds || [];
  for (const b of binds) {
    const mesh = b.mesh !== undefined ? b.mesh : json.nodes[b.node].mesh, w = (b.weight > 1 ? b.weight / 100 : b.weight);
    meshPrims(mesh).forEach(o => blink.push([o, b.index, w]));
  }

  // rest pose: world direction from each bone to its child, and world rotations
  root.updateMatrixWorld(true);
  const wp = o => o.getWorldPosition(new THREE.Vector3()), wq = o => o.getWorldQuaternion(new THREE.Quaternion());
  for (const [name, o] of Object.entries(bones)) {
    const child = childBone(name) || o.children.find(c => c.isBone || c.type === "Bone" || c.children !== undefined);
    const dir = child ? wp(child).sub(wp(o)) : null;
    rest[name] = { q: wq(o), dir: dir && dir.lengthSq() > 1e-10 ? dir.normalize() : null, local: o.quaternion.clone() };
  }
  for (const side of ["left", "right"]) {                       // palm "across" direction at rest (index -> little)
    const a = bones[side + "IndexProximal"], b = bones[side + "LittleProximal"];
    if (a && b) rest[side + "Hand"].side = wp(b).sub(wp(a)).normalize();
  }

  // camera framing: waist-up, room above the head for raised hands
  const head = wp(bones.head), hips = wp(bones.hips), sh = wp(bones.leftUpperArm).distanceTo(wp(bones.rightUpperArm));
  camInfo = { cx: head.x, top: head.y + sh * 1.05, bot: hips.y - sh * 0.05, width: sh * 3.3, z: head.z };

  // warm-up: compile shaders + upload textures now, so the first real frames are not slow
  renderer.setSize(256, 320, false); renderer.compile(scene, camera);
  camera.position.set(camInfo.cx, (camInfo.top + camInfo.bot) / 2, camInfo.z + 3); camera.lookAt(camInfo.cx, (camInfo.top + camInfo.bot) / 2, camInfo.z);
  renderer.render(scene, camera);

  if (gaveUp) return;                                 // already settled on 2D - don't swap now
  ready = true;
  window.drawAvatar = draw3DSafe;
  redrawAll();
  console.log("[avatar3d] 3D signer ready");
}

const CHILD = { leftUpperArm: "leftLowerArm", leftLowerArm: "leftHand", leftHand: "leftMiddleProximal",
  rightUpperArm: "rightLowerArm", rightLowerArm: "rightHand", rightHand: "rightMiddleProximal", neck: "head", spine: "chest", chest: "neck" };
for (const s of ["left", "right"]) for (const f of ["Thumb", "Index", "Middle", "Ring", "Little"]) {
  CHILD[s + f + "Proximal"] = s + f + "Intermediate"; CHILD[s + f + "Intermediate"] = s + f + "Distal";
}
function childBone(name) { return CHILD[name] && bones[CHILD[name]]; }

// ---------- pose math ----------
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();
function basis(f, s, m) {                                        // orthonormal frame from a forward + side vector
  const F = f.clone().normalize(), Sd = s.clone().sub(F.clone().multiplyScalar(s.dot(F))).normalize(), U = new THREE.Vector3().crossVectors(F, Sd);
  return m.makeBasis(F, Sd, U);
}
// rotate bone `name` so its rest direction points along `dir` (world); optional `side` fixes the twist
function aim(name, dir, side, restSide) {
  const o = bones[name], r = rest[name]; if (!o || !r || !r.dir || !dir || dir.lengthSq() < 1e-8) return;
  let delta;
  if (side && restSide && Math.abs(side.clone().normalize().dot(dir.clone().normalize())) < 0.95) {
    basis(dir, side, _m1); basis(r.dir, restSide, _m0);
    delta = new THREE.Quaternion().setFromRotationMatrix(_m1.multiply(_m0.transpose()));
  } else delta = new THREE.Quaternion().setFromUnitVectors(r.dir, dir.clone().normalize());
  const target = delta.multiply(r.q);                            // wanted world rotation
  o.parent.getWorldQuaternion(_pq);
  o.quaternion.copy(_pq.invert().multiply(target));
  o.updateMatrixWorld(true);
}

// an arm bone may point sideways, up, down or forward - but never backwards into / behind the body
function frontOf(d) {
  const len = d.length(); if (len < 1e-6) return d;
  if (d.z < -0.12 * len) { d.z = -0.12 * len; d.setLength(len); }
  return d;
}

function draw3D(ctx, pose, f, w, h, opt = {}) {
  const D = pose.data, NP = pose.points, b0 = f * NP * 3, ay = window.bdslBodyAspect ? window.bdslBodyAspect(pose) : 1;
  // generated English signs carry real depth: use it in full (camera recordings keep the damped body depth)
  const metric = !!(window.bdslIsMetric && window.bdslIsMetric(pose)), ZB = metric ? 1.0 : Z_POSE;
  const mir = opt.mirror ? -1 : 1;
  // data (x right, y down, z away) -> world (x right, y up, z towards the camera)
  const V = (i, zs) => new THREE.Vector3(mir * D[b0 + i * 3] / S, -D[b0 + i * 3 + 1] / S * ay, -D[b0 + i * 3 + 2] / S * zs);
  const sub = (a, b) => a.clone().sub(b);
  const L = { sh: 1, el: 3, wr: 5, hand: 9 }, R = { sh: 2, el: 4, wr: 6, hand: 30 };
  // with mirroring, the person's left arm drives the avatar's right arm
  const sides = opt.mirror ? [["left", R], ["right", L]] : [["left", L], ["right", R]];

  // reset to rest
  for (const [n, o] of Object.entries(bones)) o.quaternion.copy(rest[n].local);
  root.updateMatrixWorld(true);

  // upper body lean / turn from the shoulder line, head turn from the nose
  const ls = V(1, ZB), rs = V(2, ZB), across = sub(ls, rs); if (opt.mirror) across.negate();
  const roll = Math.max(-0.25, Math.min(0.25, Math.atan2(across.y, Math.abs(across.x))));
  const yaw = Math.max(-0.35, Math.min(0.35, Math.atan2(-across.z, Math.abs(across.x)) * 0.6));
  const chest = bones.upperChest || bones.chest || bones.spine;
  if (chest) { chest.quaternion.multiply(_q.setFromEuler(new THREE.Euler(0, yaw, roll * (opt.mirror ? -1 : 1) * 0.8))); chest.updateMatrixWorld(true); }
  const nose = V(0, ZB), mid = ls.clone().add(rs).multiplyScalar(0.5), sw = Math.max(0.3, across.length());
  const hy = Math.max(-0.45, Math.min(0.45, (nose.x - mid.x) / sw * 1.2));
  const hp = Math.max(-0.3, Math.min(0.3, ((nose.y - mid.y) / sw - 0.6) * -0.8));
  if (bones.head) { bones.head.quaternion.multiply(_q.setFromEuler(new THREE.Euler(hp, hy, 0))); bones.head.updateMatrixWorld(true); }

  for (const [side, P] of sides) {
    const S_ = V(P.sh, ZB), E = V(P.el, ZB), W = V(P.wr, ZB);
    const H = i => V(P.hand + i, Z_HAND);
    const h0 = H(0), h5 = H(5), h9 = H(9), h17 = H(17);
    const handOk = h9.distanceTo(h0) > 0.03;
    const handFwd = handOk ? sub(h9, h0) : sub(W, E), handSide = handOk ? sub(h17, h5) : null;
    const rh = rest[side + "Hand"];
    aim(side + "UpperArm", frontOf(sub(E, S_)));
    aim(side + "LowerArm", frontOf(sub(W, E)), handSide, rh && rh.side);   // forearm carries the palm twist
    aim(side + "Hand", handFwd, handSide, rh && rh.side);
    if (!handOk) continue;
    const F = { Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Little: [17, 18, 19, 20] };
    for (const [fn, c] of Object.entries(F)) {
      const pts = c.map(H);
      aim(side + fn + "Proximal", sub(pts[1], pts[0]));
      aim(side + fn + "Intermediate", sub(pts[2], pts[1]));
      aim(side + fn + "Distal", sub(pts[3], pts[2]));
    }
  }

  // blink every few seconds so the signer looks alive
  const t = performance.now() / 1000, ph = t % 3.7, bl = ph < 0.14 ? Math.sin(ph / 0.14 * Math.PI) : 0;
  for (const [o, i, wgt] of blink) if (o.morphTargetInfluences) o.morphTargetInfluences[i] = bl * wgt;

  // render at the player's size and copy into its 2D canvas
  const rw = Math.max(1, Math.round(w * quality)), rh = Math.max(1, Math.round(h * quality));
  if (renderer.domElement.width !== rw || renderer.domElement.height !== rh) renderer.setSize(rw, rh, false);
  const aspect = w / h, c = camInfo, fov = THREE.MathUtils.degToRad(camera.fov);
  const needH = Math.max(c.top - c.bot, c.width / aspect), dist = needH / 2 / Math.tan(fov / 2);
  camera.aspect = aspect; camera.position.set(c.cx, (c.top + c.bot) / 2, c.z + dist); camera.lookAt(c.cx, (c.top + c.bot) / 2, c.z);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(renderer.domElement, 0, 0, w, h);
}

function redrawAll() { for (const p of window.__players || []) { p._f = -1; try { p.draw(); } catch (e) {} } }

// Once the 3D signer is shown it STAYS 3D (no more jumping back to the 2D figure).
// If this phone is slow, it renders at a lower resolution instead (100% -> 75% -> 60%).
const times = [];
function draw3DSafe(ctx, pose, f, w, h, opt) {
  if (lost) return;                                   // GPU busy/lost: keep the last picture on screen
  const t0 = performance.now();
  try { draw3D(ctx, pose, f, w, h, opt); } catch (e) { console.warn("[avatar3d] frame skipped:", e.message || e); return; }
  times.push(performance.now() - t0); if (times.length > 30) times.shift();
  if (times.length === 30) {
    const avg = times.reduce((a, b) => a + b, 0) / 30;
    if (avg > 45 && quality > 0.6) { quality = quality > 0.8 ? 0.75 : 0.6; times.length = 0; console.log("[avatar3d] slow phone - render scale", quality); }
  }
}

// While the model is loading show a calm placeholder (not the 2D figure), so the avatar never "swaps".
function drawLoading(ctx, pose, f, w, h, opt = {}) {
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.05, cx = w / 2, cy = h / 2, a = (performance.now() / 700) % (Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.3); ctx.lineCap = "round";
  ctx.strokeStyle = opt.dark ? "rgba(255,255,255,.18)" : "rgba(60,60,120,.15)";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = opt.dark ? "#a5b4fc" : "#5b4bd6";
  ctx.beginPath(); ctx.arc(cx, cy, r, a, a + 1.6); ctx.stroke();
  ctx.fillStyle = opt.dark ? "rgba(255,255,255,.65)" : "rgba(40,40,80,.6)";
  ctx.font = `${Math.round(Math.max(12, r * 0.7))}px system-ui, sans-serif`; ctx.textAlign = "center";
  ctx.fillText("Loading signer…", cx, cy + r * 2.3);
}

function useTwoD(why) {
  console.warn("[avatar3d] using the 2D avatar:", why);
  if (!ready) { gaveUp = true; window.drawAvatar = window.drawAvatar2D; redrawAll(); }
}

let off = false; try { off = localStorage.getItem("bdsl_avatar") === "2d"; } catch (e) {}
const gl = (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch (e) { return false; } })();
if (off) console.log("[avatar3d] 2D avatar chosen (bdsl_avatar=2d)");
else if (!gl) useTwoD("WebGL2 not available");
else {
  window.drawAvatar = drawLoading; redrawAll();
  const spin = setInterval(() => { if (window.drawAvatar !== drawLoading) return clearInterval(spin); redrawAll(); }, 120);
  const giveUp = setTimeout(() => useTwoD("model took more than 25 s to load"), 25000);
  init().then(() => clearTimeout(giveUp)).catch(e => { clearTimeout(giveUp); useTwoD(e.message || e); });
}
