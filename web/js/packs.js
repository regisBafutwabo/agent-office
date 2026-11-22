/* ---------- model packs: glTF furniture from ~/Library/Application Support/Agent Office/packs ---------- */
// pack.json: { name, license, slots: { sofa: { model: 'sofa.glb', rotate: 90, fit: 'stretch-x' }, ... } }. A model is
// fitted into the space of the piece it replaces, so seats, desks and walkways stay where agents expect them.
// fit: 'contain' (default, keeps proportions), 'stretch-x' (fills the length, e.g. long sofas) or 'stretch'.
let packList = [], packToken = 0;
const packModels = new Map();                                       // url → loading glTF scene
function vendorScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error(src)); document.head.appendChild(s); });
}
async function gltf(url) {
  if (!THREE.GLTFLoader) await vendorScript('/vendor/GLTFLoader.js');
  if (!packModels.has(url)) packModels.set(url, new THREE.GLTFLoader().loadAsync(url).then(m => { m.scene.traverse(o => o.isMesh && [].concat(o.material).forEach(r128Look)); return m.scene; }));
  return packModels.get(url);
}
// three r128 can't show velvet (KHR_materials_sheen) and the office has no environment map for metals to reflect,
// so both would render near-black: velvet takes its sheen color, metals keep a little shine instead.
function r128Look(m) {
  const sheen = m.userData.gltfExtensions && m.userData.gltfExtensions.KHR_materials_sheen;
  if (sheen && sheen.sheenColorFactor) { const c = new THREE.Color().fromArray(sheen.sheenColorFactor); m.color.setRGB(Math.max(m.color.r, c.r), Math.max(m.color.g, c.g), Math.max(m.color.b, c.b)); }
  if (m.metalness > .5) m.metalness = .35;
}
// The built-in parts' extent in the slot's own frame (before its position, turn and scale).
function partsBox(parts) {
  const b = new THREE.Box3(), t = new THREE.Box3();
  for (const o of parts) { if (!o.geometry) continue; o.updateMatrix(); if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.union(t.copy(o.geometry.boundingBox).applyMatrix4(o.matrix)); }
  return b;
}
function fitModel(src, room, opt) {
  const model = src.clone(true); model.rotation.y = (opt.rotate || 0) * Math.PI / 180;
  const lights = [];                                                // a model's own lights would be copied into every seat
  model.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; else if (o.isLight) lights.push(o); });
  lights.forEach(l => l.parent.remove(l));
  const holder = new THREE.Group(); holder.add(model); holder.updateMatrixWorld(true);
  const m = new THREE.Box3().setFromObject(model), ms = m.getSize(new THREE.Vector3()), mc = m.getCenter(new THREE.Vector3());
  const rs = room.getSize(new THREE.Vector3()), rc = room.getCenter(new THREE.Vector3());
  const k = new THREE.Vector3(rs.x / ms.x, rs.y / ms.y, rs.z / ms.z);
  if (opt.fit === 'stretch-x') { const u = Math.min(k.y, k.z); k.set(k.x, u, u); }
  else if (opt.fit !== 'stretch') { const u = Math.min(k.x, k.y, k.z); k.set(u, u, u); }
  holder.scale.copy(k).multiplyScalar(opt.scale || 1);
  holder.position.set(rc.x - mc.x * holder.scale.x, room.min.y - m.min.y * holder.scale.y, rc.z - mc.z * holder.scale.z);
  return holder;
}
async function applyPack(id) {
  const token = ++packToken, pack = packList.find(p => p.id === id);
  const models = {};
  if (pack) await Promise.all(Object.entries(pack.slots).map(async ([name, opt]) => {
    if (!opt || !opt.model || !packSlot(name)) return;
    try { models[name] = await gltf(`/packs/${encodeURIComponent(pack.id)}/${opt.model.split('/').map(encodeURIComponent).join('/')}`); }
    catch (err) { console.warn(`[packs] ${pack.id}: ${name} (${opt.model}) did not load`, err); }
  }));
  if (token !== packToken) return;                                   // another pack was picked meanwhile
  for (const s of SLOTS) {
    if (s.model) { s.g.remove(s.model); s.model = null; }
    const src = models[s.name];
    if (src) { s.room ??= partsBox(s.parts); s.model = fitModel(src, s.room, pack.slots[s.name]); s.g.add(s.model); }
    s.parts.forEach(p => p.visible = !src);
  }
  const char = models.character ? { src: models.character, opt: pack.slots.character } : null;
  if (char && !THREE.SkeletonUtils) await vendorScript('/vendor/SkeletonUtils.js');
  if (token !== packToken) return;
  if ((char && char.src) !== (packChar && packChar.src)) { packChar = char; agents.forEach(buildRig); uiDirty = true; }
  const missing = pack ? Object.keys(pack.slots).filter(n => packSlot(n) && !models[n]).length : 0;
  if (missing) toast(`${pack.name}: ${missing} model${missing > 1 ? 's' : ''} could not be used`);
}
const packSlot = name => name === 'character' || SLOTS.some(s => s.name === name);

// Characters: a pack's rigged humanoid stands in for the robots. The robot rig is still built and posed every frame
// (hidden), and the model's bones copy it: each arm and leg bone turns to point the way the robot's limb points, the
// spine takes the robot's lean and the head its turn. Rigs in a T-pose or an A-pose, in any units, work the same way,
// because only directions are copied. Held things (coffee, laptop) follow the model's hands.
// pack.json: "character": { model, height (default 1.55), tint: ['MaterialName'] (takes the agent's color), bones: { upperArmL: 'name', ... } }
const BONE_KINDS = [                                                  // checked in order, on lowercased names without prefixes
  ['foreArm', /(forearm|lowerarm)/], ['upperArm', /^(left|right)?(upperarm|arm)(left|right|l|r)?$/],
  ['upLeg', /(upleg|upperleg|thigh)/], ['leg', /^(left|right)?(leg|lowerleg|calf|shin)(left|right|l|r)?$/],
  ['hand', /^(left|right)?(hand|palm|wrist)(left|right|l|r)?$/], ['head', /^head$/], ['spine', /^(spine|abdomen|torso|chest)/] ];
function findBones(root, overrides = {}) {
  const found = {}, rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert(), v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isBone) return;
    const n = o.name.toLowerCase().replace(/^.*:/, '').replace(/[^a-z]/g, '').replace(/^(mixamorig|armature|bip)/, ''), kind = (BONE_KINDS.find(([, re]) => re.test(n)) || [])[0];
    if (!kind) return;
    if (kind === 'head' || kind === 'spine') { found[kind] ??= o; return; }   // the first spine bone, nearest the hips
    const side = v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(rootInv).x < 0 ? 'L' : 'R';   // -x: the robot's armL/hips[0] side
    found[kind + side] ??= o;
  });
  for (const [k, name] of Object.entries(overrides)) { const b = root.getObjectByName(name); if (b) found[k] = b; }
  return found;
}
const childBone = b => b.children.find(c => c.isBone);
// The model's extent as drawn: a skinned mesh's geometry can be in other units than its bones (Mixamo exports), so
// a sample of its vertices goes through the skeleton, as the renderer does.
function skinnedBox(root) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 2000));
    if (o.isSkinnedMesh) o.skeleton.update();
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.boneTransform(i, v);
      box.expandByPoint(v.applyMatrix4(o.matrixWorld));
    }
  });
  return box;
}
function attachCharacter(a) {
  const opt = packChar.opt, root = THREE.SkeletonUtils.clone(packChar.src);
  const bones = findBones((root.updateMatrixWorld(true), root), opt.bones);
  if (!bones.upperArmL || !bones.upperArmR || !bones.upLegL || !bones.upLegR) { console.warn('[packs] character: no arms or legs found in its bones'); return; }
  const box = skinnedBox(root), H = (opt.height || 1.55) * a.rig.scale.y, k = H / (box.max.y - box.min.y || 1);
  root.scale.multiplyScalar(k); root.position.y = -box.min.y * k;
  const tint = new Set([].concat(opt.tint || []));
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true; o.frustumCulled = false;   // skinned meshes move away from their bind-pose bounds
    const own = m => tint.has(m.name) ? Object.assign(m.clone(), { color: new THREE.Color(a.color) }) : m;
    if (tint.size) o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
  });
  const wrap = new THREE.Group(); wrap.add(root); a.g.add(wrap); wrap.updateMatrixWorld(true);
  const rest = new Map(); root.traverse(o => o.isBone && rest.set(o, o.quaternion.clone()));
  const hipY = new THREE.Vector3().setFromMatrixPosition(bones.upLegL.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(a.g.matrixWorld).invert()).y;
  // the robot's own parts disappear; what it holds stays, and is moved to the model's hands each frame
  const keep = new Set(); [a.coffee, a.cupDown, a.laptop, a.carry, a.beacon].forEach(p => p && p.traverse(o => keep.add(o)));
  a.rig.traverse(o => { if (o.isMesh && !keep.has(o)) o.visible = false; });
  a.char = { root: wrap, bones, rest, hipY };
  a.beaconY = H - LEG + .3; a.beacon.position.y = a.beaconY; a.topY = H + .04; a.label.position.y = a.topY + .5;
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), DOWN = new THREE.Vector3(0, -1, 0);
// Turns a bone (in world space) so it points along `dir`: toward its child bone, or along its own +Y when it has none.
function aimBone(b, dir) {
  if (!b) return;
  b.updateWorldMatrix(true, false);
  const c = childBone(b), from = _v1.setFromMatrixPosition(b.matrixWorld);
  const along = c ? _v2.copy(c.position).applyMatrix4(b.matrixWorld).sub(from) : _v2.set(0, 1, 0).transformDirection(b.matrixWorld);
  if (along.lengthSq() < 1e-12) return;
  _q1.setFromUnitVectors(along.normalize(), _v3.copy(dir).normalize());
  turnBone(b, _q1);
}
// Applies a world-space rotation to a bone, on top of its current pose.
function turnBone(b, worldQ) {
  b.updateWorldMatrix(true, false);
  b.getWorldQuaternion(_q2).premultiply(worldQ);
  b.quaternion.copy(b.parent.getWorldQuaternion(_qp).invert().multiply(_q2));
}
const _qp = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qh = new THREE.Quaternion();
const worldDir = (from, to) => _v3.setFromMatrixPosition(to.matrixWorld).sub(_v1.setFromMatrixPosition(from.matrixWorld)).clone();
function poseCharacter(a) {
  const C = a.char, B = C.bones;
  C.rest.forEach((q, b) => b.quaternion.copy(q));
  // how far into sitting the robot is, from its legs swinging forward (to -1.45)
  const sit = clamp(-(a.legs.l + a.legs.r) / 2 / 1.45, 0, 1);
  C.root.position.y = (a.pivot.position.y - a.pelvisY) + sit * (a.pelvisY - C.hipY);   // bob, and the hips down onto the seat
  [a.armL, a.armR].forEach(sh => { const h = sh.userData.hand.position; h.x = h.z = 0; });   // undo last frame's move to the model's hand
  a.g.updateMatrixWorld(true);
  // lean (typing at a desk) on the spine, the head's tilt and turn on the head
  if (B.spine) { a.rig.getWorldQuaternion(_qw); turnBone(B.spine, _qh.copy(_qw).multiply(a.pivot.quaternion).multiply(_qw.invert())); }
  if (B.head) { a.pivot.getWorldQuaternion(_qw); turnBone(B.head, _qh.copy(_qw).multiply(a.head.quaternion).multiply(_qw.invert())); }
  // arms: the robot's shoulder → elbow and elbow → hand directions
  [[a.armL, 'L'], [a.armR, 'R']].forEach(([sh, s]) => {
    const u = sh.userData;
    aimBone(B['upperArm' + s], worldDir(sh, u.elbow));
    aimBone(B['foreArm' + s], worldDir(u.elbow, u.hand));
  });
  // legs: straight along the robot's leg; sitting, the shins drop toward the floor
  a.hips.forEach((hip, i) => {
    const s = i ? 'R' : 'L', thigh = _v1.set(0, -1, 0).transformDirection(hip.matrixWorld).clone();
    aimBone(B['upLeg' + s], thigh);
    aimBone(B['leg' + s], thigh.lerp(DOWN, sit));
  });
  // what the robot holds goes where the model's hands are
  [[a.armL, 'L'], [a.armR, 'R']].forEach(([sh, s]) => {
    const tip = B['hand' + s] || B['foreArm' + s]; if (!tip) return;
    tip.updateWorldMatrix(true, false);
    const hand = sh.userData.hand; hand.position.copy(hand.parent.worldToLocal(_v1.setFromMatrixPosition(tip.matrixWorld)));
  });
}
function renderPacks() {
  const sel = $('#pack-select'), cur = uiPrefs.pack || '';
  sel.innerHTML = `<option value="">Built-in</option>` + packList.map(p => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}${p.license ? ` (${esc(p.license)})` : ''}</option>`).join('');
  $('#pack-empty').hidden = packList.length > 0;
}
async function loadPacks() {
  try { const r = await officeAuth.fetch('/api/packs'); if (!r.ok) throw 0; packList = await r.json(); } catch (_) { $('#pack-setting').hidden = true; return; }
  renderPacks();
  if (uiPrefs.pack && packList.some(p => p.id === uiPrefs.pack)) applyPack(uiPrefs.pack);
}
$('#pack-select').onchange = e => { uiPrefs.pack = e.target.value; saveUi(); applyPack(uiPrefs.pack); };
