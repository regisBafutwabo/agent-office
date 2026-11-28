/* ---------- agents ---------- */
const agents = []; const pickables = [];
let seq = 0, simTime = 0, speed = 1, toolCalls = 0, uiDirty = true, selected = null, follow = false, showLabels = true, detailDirty = true;
function createAgent(o) {
  const a = Object.assign({ id: 'a' + (++seq), state:'idle', activity:'Starting up', where:'', log:[], pending:[], path:[], yaw:0, pose:'idle', animT: Math.random() * 10,
    approval:null, appear:1, leaving:false, spot:null, busy:false, floor:curFloor, labelDirty:true, arms:{ l:0, r:0, rz:0 }, tilt:0, pref:'anywhere' }, o);
  a.scale = a.kind === 'sub' ? .78 : .9;
  buildAvatar(a); agents.push(a); uiDirty = true; return a;
}
/* ---------- characters (from the Character Lab) ---------- */
// Screen-face robots: the face shows the agent's status, and every part of the look is customizable.
const BODIES = { round: { label: 'Round', R: .40, h: .78, taper: .72 }, tall: { label: 'Tall', R: .31, h: 1.0, taper: .8 }, compact: { label: 'Compact', R: .46, h: .62, taper: .7 } };
const FACE_STYLES = { classic: 'Classic', pixel: 'Pixel', anime: 'Big eyes', minimal: 'Minimal' };
const ACCESSORIES = { headphones: 'Headphones', beanie: 'Beanie', cap: 'Cap', glasses: 'Glasses', antenna: 'Antenna', scarf: 'Scarf', backpack: 'Backpack', mug: 'Mug' };
const HATS = ['beanie', 'cap'];
const TRIM_COLORS = ['#15212A', '#F4F1EA', '#FFB400', '#2B59C3', '#E4572E', '#98A4AA'];
const ACCENT_COLORS = ['#E4572E', '#2B59C3', '#FFB400', '#15212A', '#F4F1EA', '#6CB26B', '#B16AD9', '#FF7EB6'];
const FACE_COLORS = { thinking: '#C8BFFF', working: '#8BE9F5', waiting: '#FFC867', done: '#98F1B0', idle: '#AEBFC6', error: '#FF9C94' };
const TOOL_ACCESSORY = { cursor: 'headphones', codex: 'cap', gemini: 'antenna', copilot: 'glasses', factory: 'backpack', qwen: 'beanie',
  goose: 'scarf', kiro: 'antenna', windsurf: 'headphones', cline: 'glasses', opencode: 'cap', amp: 'antenna', ollama: 'mug', antigravity: 'glasses' };
const LEG = .3;                                  // hip height when standing
const ANIMALS = { bear: {label:'Bear', fur:'#A57A55', muzzle:'#E5C7A1'}, cat: {label:'Cat', fur:'#DDA66C', muzzle:'#FFE8C8'}, rabbit: {label:'Rabbit', fur:'#C3BBC9', muzzle:'#F7EBEE'}, maltese: {label:'Maltese', fur:'#FFF9EF', muzzle:'#FFFFFF'}, raccoon: {label:'Raccoon', fur:'#9296A2', muzzle:'#E7E5E1'}, duck: {label:'Duck', fur:'#F6DE83', muzzle:'#E9A044'} };
const petSpecies = a => Object.hasOwn(ANIMALS, a.look.species) ? a.look.species : a.parent ? petSpecies(a.parent) : Object.keys(ANIMALS)[seedHash(a.cwd || a.name) % 6];
const JOINT = M('#2A3035', { roughness: .5 });
const seedHash = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

// A look that stays the same for a given project, so agents are recognizable between visits.
function lookFor(seed, color, toolAccessory) {
  const h = seedHash(seed), keys = Object.keys(ACCESSORIES);
  const acc = [toolAccessory || keys[(h >> 9) % keys.length]];
  const extra = keys[(h >> 13) % keys.length];
  if ((h >> 4) % 3 === 0 && !acc.includes(extra) && !(HATS.includes(extra) && acc.some(a => HATS.includes(a)))) acc.push(extra);
  return { body: Object.keys(BODIES)[h % 3], face: Object.keys(FACE_STYLES)[(h >> 3) % 4], color,
    trim: TRIM_COLORS[(h >> 5) % TRIM_COLORS.length], accent: ACCENT_COLORS[(h >> 7) % ACCENT_COLORS.length], accessories: acc, intern: false };
}
function randomLook(color) {
  const keys = Object.keys(ACCESSORIES).sort(() => Math.random() - .5), acc = [];
  for (const k of keys) { if (acc.length >= 1 + Math.floor(Math.random() * 2)) break; if (HATS.includes(k) && acc.some(a => HATS.includes(a))) continue; acc.push(k); }
  return { body: pick(Object.keys(BODIES)), face: pick(Object.keys(FACE_STYLES)), color, trim: pick(TRIM_COLORS), accent: pick(ACCENT_COLORS), accessories: acc, intern: false,
    ...(uiPrefs.crew === 'pets' ? { species: pick(Object.keys(ANIMALS)) } : {}) };
}
// Subagents look like a smaller "intern" version of their parent.
const internLook = (parent, color) => ({ ...parent.look, color, intern: true, accessories: parent.look.accessories.filter(a => a !== 'mug' && a !== 'backpack') });

// Takeaway cup inside the coffee group: held by its side (x, inward of the left hand), a little forward (z); lid height.
const CUP = { x: .09, z: .1, lid: .16 };
// How big the body really is: the agent's size times its rig's (interns' rigs are smaller).
const bodyScale = a => a.scale * a.rig.scale.y;
const UPPER = .2, FORE = .2;   // shoulder to elbow, elbow to hand
// Puts the left hand on a target (shoulder at (-sx, sy, 0) in the body's frame): the shoulder's rotation.x and .z, and
// the elbow's bend e (negative folds the forearm forward). The right arm mirrors it (z flips, e stays). Only a target
// beyond the arm's reach (round bellies are deep) stretches it, by s, up to `most`.
function armReach(sx, sy, tx, ty, tz, most = 1.3) {
  const Tx = tx + sx, Ty = ty - sy, D = Math.hypot(Tx, Ty, tz);
  const s = clamp(D / (UPPER + FORE) / .98, 1, most), U = UPPER * s, F = FORE * s, d = Math.min(D, (U + F) * .98), k = d / D;
  const e = -(Math.PI - Math.acos(clamp((U * U + F * F - d * d) / (2 * U * F), -1, 1)));
  const hy = -U - F * Math.cos(e), hz = -F * Math.sin(e);                    // the hand in the arm's own frame
  const z = Math.asin(clamp(Tx * k / -hy, -1, 1)), Y = hy * Math.cos(z);   // swing out or in, then up or forward
  return { x: Math.atan2(tz * k, Ty * k) - Math.atan2(hz, Y), z, e, s };
}
// Hands on a desk's keyboard (body frame). The keyboard sits right at the belly, so the agent leans in (LEAN) to reach it:
// the target is worked out in the leaning body's frame.
const LEAN = .2;
// Hands resting on the swivel chair's armrests (body frame), for leaning back to think.
function armrestAt(a, sp) {
  const b = bodyScale(a);
  return armReach(a.shoulder.sx, a.shoulder.sy, -ARMREST.x / b, ARMREST.y / b - (sp.y + .29) + .06, ARMREST.z / b, 1.2);
}
function keysAt(a, sp) {
  const K = sp.keys, y = K.y / bodyScale(a) - (sp.y + .29) + .06, z = K.d / bodyScale(a) - .03, c = Math.cos(LEAN), s = Math.sin(LEAN);
  return armReach(a.shoulder.sx, a.shoulder.sy, -.12, y * c + z * s, z * c - y * s, 1.4);
}
// Where a coffee is set down (body frame): on the seat's table to the left, or on the seat's own rest.
function cupDownAt(a, sp) {
  const T = sp.table;
  if (T) return { x: -.45, y: T.y / bodyScale(a) - (sp.y + .29), z: T.d / bodyScale(a) + .12 };
  const R = sp.rest;
  return R ? { x: R.x / bodyScale(a), y: R.y / bodyScale(a) - (sp.y + .29), z: 0 } : null;   // nowhere to put it: it stays out of sight
}
// Where the laptop sits (body frame) and where the hands reach to type: on the seat's table if it has one, else on the lap.
// Its keys can overhang the table's edge a little, but never sink into the belly.
function laptopAt(a, sp) {
  const T = sp && sp.table, L = a.lap0;
  const y = T ? T.y / bodyScale(a) - (sp.y + .29) + .011 : L.y, z = T ? Math.max(L.z, T.d / bodyScale(a) + .045) : L.z;
  return { y, z, type: armReach(a.shoulder.sx, a.shoulder.sy, -.2, y + .07, z - .1) };
}
function bodyRadius(S, t) {                      // rounded bottom, gentle taper, rounded shoulders
  const bottom = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(t / .22, 1), 2)));
  const top = 1 - (1 - S.taper) * Math.pow(Math.max(0, (t - .35) / .65), 1.6);
  const cap = t > .88 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - .88) / .12, 2))) : 1;
  return S.R * bottom * top * cap;
}

// The parts that belong to the agent and survive a change of look: ring, selection ring, name tag, click target.
function buildAvatar(a) {
  const g = new THREE.Group(); a.g = g;
  a.ring = new THREE.Mesh(new THREE.RingGeometry(.4, .5, 40), new THREE.MeshBasicMaterial({ color: '#888', transparent: true, opacity: .9, depthWrite: false }));
  a.ring.rotation.x = -Math.PI / 2; a.ring.position.y = .025; g.add(a.ring);
  a.selRing = new THREE.Mesh(new THREE.RingGeometry(.6, .66, 48), new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: .95, depthWrite: false }));
  a.selRing.rotation.x = -Math.PI / 2; a.selRing.position.y = .026; a.selRing.visible = false; g.add(a.selRing);
  a.L = canvasTex(512, 128);
  a.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: a.L.t, depthTest: false, transparent: true }));
  a.label.scale.set(2.8, .7, 1); a.label.renderOrder = 10; a.label.visible = showLabels; g.add(a.label);
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(.55, .55, 2.1, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  hit.position.y = 1; hit.userData.agentId = a.id; g.add(hit); pickables.push(hit); a.hit = hit;
  const fc = document.createElement('canvas'); fc.width = 256; fc.height = 200; a.faceCtx = fc.getContext('2d');
  a.faceTex = new THREE.CanvasTexture(fc); a.faceTex.anisotropy = 4; a.faceT = 1;
  a.blink = 0; a.blinkIn = rand(1.5, 4); a.pelvisY = LEG; a.legs = { l: 0, r: 0 };
  if (!a.look) a.look = a.kind === 'sub' && a.parent ? internLook(a.parent, a.color) : lookFor(a.name + (a.cwd || ''), a.color, TOOL_ACCESSORY[a.agentName]);
  buildRig(a);
  g.scale.setScalar(a.scale); scene.add(g);
}

// The body itself, rebuilt whenever the look changes.
function buildRig(a) {
  const L = a.look = { ...a.look, color: a.color, accessories: [...(a.look.accessories || [])] };
  if (a.char) { a.g.remove(a.char.root); a.char = null; }
  if (a.rig) {
    a.g.remove(a.rig); const owned = new Set(), shared = new Set([JOINT, ...Object.values(mats)]);
    a.rig.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !shared.has(o.material)) owned.add(o.material); });
    owned.forEach(m => m.dispose());
  }
  const S = BODIES[L.body] || BODIES.round, rig = a.rig = new THREE.Group(); a.g.add(rig);
  const animal = uiPrefs.crew === 'pets' ? ANIMALS[petSpecies(a)] : null;
  if (animal) L.species = petSpecies(a);
  const fur = animal ? M(animal.fur, { roughness: .95 }) : null;
  a.animalEyes = null; a.ears = []; a.tail = null; a.animalMouth = null;
  if (L.intern) rig.scale.setScalar(.9);
  const mBody = M(L.color, { roughness: .5 }), mTrim = M(L.trim, { roughness: .45 }), mAcc = M(L.accent, { roughness: .75 });
  const pelvis = a.pivot = new THREE.Group(); pelvis.position.y = a.pelvisY; rig.add(pelvis);
  const pts = []; for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(new THREE.Vector2(Math.max(bodyRadius(S, t), .001), t * S.h)); }
  part(new THREE.LatheGeometry(pts, 32), mBody, pelvis);
  // status light on the chest
  const zc = bodyRadius(S, .55);
  const badge = part(new THREE.CylinderGeometry(.085, .085, .03, 20), mTrim, pelvis, 0, S.h * .55, zc - .005); badge.rotation.x = Math.PI / 2;
  a.lightMat = new THREE.MeshBasicMaterial({ color: STATUS[a.state].hex });
  const light = part(new THREE.CylinderGeometry(.05, .05, .034, 16), a.lightMat, pelvis, 0, S.h * .55, zc + .002, false); light.rotation.x = Math.PI / 2;
  // legs
  a.hips = [-1, 1].map(s => { const hip = new THREE.Group(); hip.position.set(s * S.R * .42, .06, 0); pelvis.add(hip);
    part(new THREE.CylinderGeometry(.075, .068, LEG - .06, 12), fur || JOINT, hip, 0, -(LEG - .06) / 2);
    const foot = part(new THREE.SphereGeometry(animal ? .12 : .095, 14, 10), fur || mTrim, hip, 0, -LEG + .07, .04); foot.scale.set(1, .6, 1.45); return hip; });
  // arms (office code drives armL/armR)
  const sx = bodyRadius(S, .72) + .045;
  [a.armL, a.armR] = [-1, 1].map(s => { const sh = new THREE.Group(); sh.position.set(s * sx, S.h * .72, 0); sh.rotation.z = s * .12; pelvis.add(sh);
    part(new THREE.SphereGeometry(.07, 12, 10), mBody, sh);
    // upper arm, elbow, forearm, hand: office code turns the shoulder (sh) and bends the elbow
    const upper = part(new THREE.CylinderGeometry(.055, .05, UPPER, 10), mBody, sh, 0, -UPPER / 2);
    const elbow = new THREE.Group(); elbow.position.y = -UPPER; sh.add(elbow); part(new THREE.SphereGeometry(.052, 10, 8), mBody, elbow);
    const fore = part(new THREE.CylinderGeometry(.05, .045, FORE, 10), mBody, elbow, 0, -FORE / 2);
    const hand = new THREE.Group(); hand.position.y = -FORE; elbow.add(hand); part(new THREE.SphereGeometry(animal ? .09 : .072, 12, 10), fur || mTrim, hand);
    Object.assign(sh.userData, { hand, elbow, upper, fore }); return sh; });
  // neck and screen head
  part(new THREE.CylinderGeometry(.075, .085, .09, 14), JOINT, pelvis, 0, S.h + .02);
  const head = a.head = new THREE.Group(); head.position.y = S.h + .07 + .27; pelvis.add(head);
  if (animal) buildAnimal(a, animal, fur);
  else {
    part(roundedBox(.56, .44, .3, .13, .05), mBody, head);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(.54, .42), new THREE.MeshBasicMaterial({ map: a.faceTex })); screen.position.z = .204; head.add(screen);
  }
  const A = L.accessories;
  if (!animal && !A.includes('headphones')) [-1, 1].forEach(s => { const b = part(new THREE.CylinderGeometry(.05, .05, .05, 14), mTrim, head, s * .34, 0, 0); b.rotation.z = Math.PI / 2; });
  a.antennaMat = null;
  if (A.includes('headphones')) { part(new THREE.TorusGeometry(.37, .03, 8, 24, Math.PI), JOINT, head, 0, .02, 0);
    [-1, 1].forEach(s => { const cup = part(new THREE.CylinderGeometry(.11, .11, .1, 18), mAcc, head, s * .37, .02, 0); cup.rotation.z = Math.PI / 2; }); }
  if (A.includes('beanie')) { const d = part(new THREE.SphereGeometry(.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mAcc, head, 0, .2, 0); d.scale.set(1, .8, 1.02);
    part(new THREE.CylinderGeometry(.37, .375, .1, 20), mAcc, head, 0, .22, 0); part(new THREE.SphereGeometry(.075, 10, 8), mTrim, head, 0, .5, 0); }
  if (A.includes('cap')) { const d = part(new THREE.SphereGeometry(.35, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mAcc, head, 0, .24, 0); d.scale.set(1, .6, 1.02);
    const brim = part(new THREE.CylinderGeometry(.24, .24, .03, 20), mAcc, head, 0, .25, .3); brim.scale.set(1.25, 1, 1.4); }
  if (A.includes('glasses')) { const z = animal ? .325 : .232; [-1, 1].forEach(s => part(new THREE.TorusGeometry(.085, .016, 8, 18), JOINT, head, s * .125, .03, z)); part(new THREE.BoxGeometry(.07, .016, .016), JOINT, head, 0, .05, z); }
  if (A.includes('antenna') && !A.some(h => HATS.includes(h))) { part(new THREE.CylinderGeometry(.014, .014, .26, 8), JOINT, head, .14, .4, 0);
    a.antennaMat = new THREE.MeshBasicMaterial({ color: STATUS[a.state].hex }); part(new THREE.SphereGeometry(.05, 12, 8), a.antennaMat, head, .14, .55, 0, false); }
  if (A.includes('scarf')) { const sc = part(new THREE.TorusGeometry(.16, .06, 8, 20), mAcc, pelvis, 0, S.h + .01, 0); sc.rotation.x = Math.PI / 2;
    const tail = part(new THREE.BoxGeometry(.1, .26, .05), mAcc, pelvis, .1, S.h - .13, bodyRadius(S, .86) + .06); tail.rotation.z = .15; }
  if (A.includes('backpack')) part(roundedBox(.34, .34, .1, .08, .03), mAcc, pelvis, 0, S.h * .55, -(bodyRadius(S, .55) + .06));
  if (A.includes('mug')) { const hand = a.armL.userData.hand; part(new THREE.CylinderGeometry(.05, .045, .11, 14), mats.mug, hand, 0, 0, .08); part(new THREE.TorusGeometry(.03, .01, 6, 10), mats.mug, hand, .055, 0, .08); }
  // a takeaway coffee in the left hand, from the coffee bar until it's finished (updateAgent shows it and keeps it upright)
  a.hasMug = A.includes('mug'); a.coffee = null;
  if (!a.hasMug) {
    const c = a.coffee = new THREE.Group(); a.armL.userData.hand.add(c);
    part(new THREE.CylinderGeometry(.08, .064, .2, 16), mats.mug, c, CUP.x, .05, CUP.z);
    part(new THREE.CylinderGeometry(.082, .072, .08, 16), mats.cupSleeve, c, CUP.x, .035, CUP.z);
    part(new THREE.CylinderGeometry(.086, .086, .025, 16), mats.cupLid, c, CUP.x, CUP.lid, CUP.z);
    c.visible = false;
    a.cupDown = c.clone(); pelvis.parent.add(a.cupDown); a.cupSpot = null;   // the same cup, set down (beside the body, so it doesn't lean with it)
  }
  if (L.intern) { const ly = part(new THREE.TorusGeometry(.13, .012, 6, 20), mAcc, pelvis, 0, S.h - .02, .02); ly.rotation.x = Math.PI / 2 - .35;
    part(new THREE.BoxGeometry(.1, .13, .012), mats.mug, pelvis, 0, S.h * .62, bodyRadius(S, .62) + .02);
    part(new THREE.BoxGeometry(.1, .03, .014), mAcc, pelvis, 0, S.h * .62 + .045, bodyRadius(S, .62) + .021); }
  // laptop for working away from the desk, held in front
  a.laptop = new THREE.Group(); a.laptop.position.set(0, S.h * .5, bodyRadius(S, .5) + .135); a.laptop.scale.set(1.4, 1.2, 1); pelvis.add(a.laptop);   // its near edge just clear of the belly
  a.laptop.rotation.y = Math.PI;                      // hinge on the far side, screen facing the agent
  box(.36, .018, .25, mats.steel, 0, 0, 0, a.laptop);
  const lid = new THREE.Group(); lid.position.set(0, .01, -.12); lid.rotation.x = -.3; a.laptop.add(lid);
  box(.36, .23, .012, mats.steel, 0, .115, 0, lid);
  a.lapScreen = new THREE.MeshBasicMaterial({ color: '#1E262B' });
  const ls = new THREE.Mesh(new THREE.PlaneGeometry(.32, .19), a.lapScreen); ls.position.set(0, .115, .007); lid.add(ls);
  a.laptop.visible = false;
  // Where the left arm goes to sip (lid at the lower face) and to type (hand on the near keys); the right arm mirrors it.
  const sy = S.h * .72, faceY = S.h + .34;   // sx: the shoulders, from the arms above
  a.reach = { sip: armReach(sx, sy, -.06 - CUP.x, faceY - .12 - CUP.lid, .3 - CUP.z) };
  a.shoulder = { sx, sy }; a.lap0 = { y: S.h * .5, z: bodyRadius(S, .5) + .135 }; a.lapSpot = null;
  a.lap = laptopAt(a, null);
  // closed laptop carried in the right hand while walking around the office (never on the roof)
  a.carry = new THREE.Group(); a.carry.position.set(.03, -.14, 0); a.carry.scale.setScalar(1.4); a.armR.userData.hand.add(a.carry);
  box(.03, .25, .36, mats.steel, 0, 0, 0, a.carry);
  a.carry.visible = false;
  // the "needs you" marker floats above the head
  const headTop = animal ? (petSpecies(a) === 'rabbit' ? 1.04 : .72) : .54;
  a.beaconY = S.h + .07 + headTop + .3 + (A.includes('antenna') || A.includes('beanie') ? .2 : 0);
  a.beacon = new THREE.Mesh(new THREE.OctahedronGeometry(.13), new THREE.MeshBasicMaterial({ color: STATUS.waiting.hex })); a.beacon.position.y = a.beaconY; a.beacon.visible = false; pelvis.add(a.beacon);
  a.topY = (LEG + S.h + .07 + headTop + (A.includes('beanie') || A.includes('antenna') ? .2 : .04)) * (L.intern ? .9 : 1);
  a.label.position.y = a.topY + .5;
  a.faceT = 1; updateScreen(a);
  if (packChar) attachCharacter(a);
}

function buildAnimal(a, animal, fur) {
    const species = petSpecies(a), pale = M(animal.muzzle, { roughness: .95 }), pink = M('#DCA7A1', { roughness: .95 }), ink = M('#25202A', { roughness: .65 });
    const oval = (parent, material, x,y,z, sx,sy,sz) => { const o = part(new THREE.SphereGeometry(1,16,12), material,parent,x,y,z); o.scale.set(sx,sy,sz); return o; };
    const trimmed = species === 'maltese';
    oval(a.head,fur,0,.015,0,trimmed ? .32 : .37,trimmed ? .30 : .33,.28);
    // A low, swept fringe softens Lumi's crown without adding bulk around the eyes.
    if (trimmed) {
      [-1, 0, 1].forEach(i => {
        const tuft = oval(a.head,fur,i*.065,.285-Math.abs(i)*.012,.025,.06,.055,.13);
        tuft.rotation.z = -.25 + i*.12;
      });
    }
    [-1,1].forEach(side => {
      const ear = new THREE.Group(); a.head.add(ear); a.ears.push(ear);
      ear.position.set(side*.29, species==='maltese' ? .07 : .24, -.035);
      if(species==='rabbit') { oval(ear,fur,side*.035,.25,0,.095,.32,.075); oval(ear,pink,side*.035,.25,.063,.052,.23,.018); }
      else if(species==='maltese') { oval(ear,fur,side*.055,-.12,.005,.115,.22,.09); oval(ear,pale,side*.06,-.15,.045,.09,.18,.055); }
      else if(species==='cat'||species==='raccoon') { const outer=part(new THREE.ConeGeometry(.14,.27,3),fur,ear,0,.075,0); outer.rotation.y=Math.PI; const inner=part(new THREE.ConeGeometry(.075,.16,3),pink,ear,0,.08,.066); inner.rotation.y=Math.PI; }
      else if(species==='bear') { oval(ear,fur,0,.035,0,.14,.14,.075); oval(ear,pink,0,.035,.063,.085,.085,.018); }
      else { oval(a.head,fur,side*.06,.32,-.02,.06,.13,.06); }
    });
    if(species==='raccoon') [-1,1].forEach(side => { const mask=oval(a.head,ink,side*.14,.04,.245,.15,.105,.055); mask.rotation.z=side*.2; });
    a.animalEyes = [-1,1].map(side => {
      const eye = new THREE.Group(); a.head.add(eye); eye.position.set(side*.135,.055,.263);
      oval(eye,M('#FFFDF8'),0,0,0,.07,.088,.035); oval(eye,ink,side*-.005,0,.032,.045,.064,.023); oval(eye,M('#FFFFFF'),-.013,.026,.052,.014,.019,.01);
      return eye;
    });
    if(species==='duck') { oval(a.head,pale,0,-.1,.3,.19,.062,.15); }
    else { [-1,1].forEach(side=>oval(a.head,pale,side*(trimmed ? .045 : .065),-.09,.255,trimmed ? .078 : .108,trimmed ? .06 : .083,trimmed ? .06 : .075)); oval(a.head,ink,0,-.065,trimmed ? .32 : .334,.045,.032,.026); }
    // A small curved mouth changes with the state, independently of the robot screen faces.
    const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(-.045,0,0),new THREE.Vector3(0,-.035,0),new THREE.Vector3(.045,0,0));
    a.animalMouth=part(new THREE.TubeGeometry(curve,12,.009,6,false),ink,a.head,0,-.165,species==='duck'?.38:.306);
    if(species==='cat') [-1,1].forEach(side=> { for(let i=0;i<2;i++){const w=part(new THREE.BoxGeometry(.14,.006,.006),ink,a.head,side*.24,-.09-i*.04,.265);w.rotation.z=side*(i?.15:-.15);} });
    a.tail=new THREE.Group(); a.tail.position.set(0,.18,-.18); a.pivot.add(a.tail);
    if(species==='cat'||species==='raccoon') {
      for(let i=0;i<7;i++) oval(a.tail,species==='raccoon'&&i%2?ink:fur,.08+i*.055,i*.075,-.12-i*.055,species==='raccoon'?.1:.05,.075,.075);
    } else if(species==='maltese') { for(let i=0;i<6;i++) {const angle=i*.45;oval(a.tail,fur,.12+Math.sin(angle)*.12,.04+i*.04,-.15-Math.cos(angle)*.12,.095,.08,.08);} }
    else oval(a.tail,fur,0,.03,-.15,.13,.12,.12);

}

function drawAnimalFace(a) {
  const st = a.faceErrorUntil > a.animT ? 'error' : a.state;
  const open = a.blink > 0 ? .08 : st === 'idle' ? .65 : st === 'done' ? .55 : st === 'waiting' ? 1.15 : 1;
  a.animalEyes.forEach(eye => { eye.scale.y = open; eye.rotation.z = st === 'error' ? (eye.position.x > 0 ? -.15 : .15) : 0; });
  a.animalMouth.rotation.z = st === 'error' ? Math.PI : 0;
  a.ears.forEach((ear, i) => { ear.rotation.z = (i ? 1 : -1) * (st === 'waiting' ? -.1 : st === 'idle' ? .12 : .03); });
  a.tail.rotation.y = Math.sin(a.animT * (st === 'done' ? 7 : 2)) * (st === 'done' ? .35 : .08);
}

function hexA(hex, alpha) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`; }
function drawFace(a) {
  if (a.animalEyes) { drawAnimalFace(a); return; }
  const x = a.faceCtx, W = 256, H = 200, L = a.look, t = a.animT;
  const st = a.faceErrorUntil > t ? 'error' : a.state, col = FACE_COLORS[st], glow = st === 'error' ? '#E5534B' : STATUS[st].hex;
  x.fillStyle = '#0C1216'; x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(W / 2, H / 2, 30, W / 2, H / 2, 170); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, hexA(glow, st === 'waiting' ? .28 + .14 * Math.sin(t * 6) : .2));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,.035)'; for (let y = 0; y < H; y += 4) x.fillRect(0, y, W, 1);
  x.strokeStyle = L.trim; x.lineWidth = 8; rrect(x, 4, 4, W - 8, H - 8, 26); x.stroke();
  let look = { x: 0, y: 0 }, open = 1;
  const happy = st === 'done', lost = !!a.stuck && a.busy && st !== 'waiting' && st !== 'error';
  if (st === 'thinking') look = { x: 12, y: -16 };
  if (st === 'working') { open = .55; look = { x: Math.sin(t * 1.6) * 12, y: 4 }; }
  if (st === 'waiting') open = 1.25;
  if (st === 'idle') { open = .32 + .06 * Math.sin(t * .8); look.y = 6; }
  if (st === 'error') { open = .85; look = { x: -4, y: 2 }; }
  if (lost) { look = { x: -12, y: -8 }; open = .9; }
  if (a.blink > 0 && !happy) open = .08;
  x.fillStyle = col; x.strokeStyle = col; x.lineCap = 'round'; x.lineJoin = 'round';
  [[96, 92], [160, 92]].forEach(([ex, ey], i) => {
    const cx = ex + look.x, cy = ey + look.y;
    if (happy) { x.lineWidth = L.face === 'minimal' ? 7 : 10; x.beginPath(); x.arc(cx, cy + 8, 18, Math.PI * 1.1, Math.PI * 1.9); x.stroke(); return; }
    if (L.face === 'pixel') { const rows = Math.max(1, Math.round(6 * open)), px = 8; for (let r = 0; r < rows; r++) for (let q = 0; q < 4; q++) x.fillRect(cx - 16 + q * px, cy - rows * px / 2 + r * px, px - 2, px - 2); }
    else if (L.face === 'anime') {
      const ry = Math.max(3, 26 * open);
      x.beginPath(); x.ellipse(cx, cy, 22, ry, 0, 0, Math.PI * 2); x.fill();
      if (ry > 8) { x.fillStyle = '#0C1216'; x.beginPath(); x.ellipse(cx + look.x * .15, cy + 3, 11, Math.min(14, ry * .55), 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(cx - 7, cy - 8, 5, 0, 7); x.fill(); x.beginPath(); x.arc(cx + 6, cy + 6, 2.5, 0, 7); x.fill(); x.fillStyle = col; }
    }
    else if (L.face === 'minimal') { if (open < .5) { x.lineWidth = 7; x.beginPath(); x.moveTo(cx - 13, cy); x.lineTo(cx + 13, cy); x.stroke(); } else { x.beginPath(); x.arc(cx, cy, 9 * Math.min(1.3, open), 0, 7); x.fill(); } }
    else { const h = Math.max(5, 46 * open); rrect(x, cx - 15, cy - h / 2, 30, h, Math.min(15, h / 2)); x.fill(); }
    if (st === 'error' && L.face !== 'minimal') { x.lineWidth = 6; x.beginPath(); const s = i ? -1 : 1; x.moveTo(cx - 16, cy - 30 - s * 5); x.lineTo(cx + 16, cy - 30 + s * 5); x.stroke(); }
  });
  x.lineWidth = 6;
  const mx = 128 + look.x * .4, my = 142;
  if (happy) { x.beginPath(); x.arc(mx, my - 12, 18, Math.PI * .15, Math.PI * .85); x.stroke(); }
  else if (st === 'error') { x.beginPath(); x.arc(mx, my + 10, 16, Math.PI * 1.2, Math.PI * 1.8); x.stroke(); }
  else if (st === 'waiting') { x.beginPath(); x.ellipse(mx, my, 8, 10, 0, 0, 7); x.stroke(); }
  else if (st === 'thinking') { x.beginPath(); x.moveTo(mx - 6, my); x.lineTo(mx + 10, my - 3); x.stroke(); }
  else if (st === 'idle') { x.beginPath(); x.moveTo(mx - 8, my); x.lineTo(mx + 8, my); x.stroke(); }
  if (lost) { x.fillStyle = LOST; x.globalAlpha = .75 + .25 * Math.sin(t * 5); x.font = '700 60px "Bricolage Grotesque", sans-serif'; x.textAlign = 'center'; x.fillText('?', 214, 86); x.textAlign = 'left'; x.globalAlpha = 1; x.fillStyle = col; }
  else if (st === 'thinking') { for (let k = 0; k < 3; k++) { x.globalAlpha = (Math.floor(t * 3) % 3) === k ? 1 : .35; x.beginPath(); x.arc(196 + k * 16, 42, 6, 0, 7); x.fill(); } x.globalAlpha = 1; }
  if (st === 'waiting') { x.globalAlpha = .7 + .3 * Math.sin(t * 8); x.font = '700 64px "Bricolage Grotesque", sans-serif'; x.textAlign = 'center'; x.fillText('!', 214, 88); x.textAlign = 'left'; x.globalAlpha = 1; }
  if (st === 'idle') { x.font = '700 22px "IBM Plex Sans", sans-serif'; ['z', 'Z'].forEach((z, k) => { const u = (t * .35 + k * .5) % 1; x.globalAlpha = Math.sin(u * Math.PI); x.fillText(z, 190 + k * 16 + u * 10, 70 - u * 40); }); x.globalAlpha = 1; }
  if (st === 'error') { x.fillStyle = '#8FD3FF'; x.beginPath(); const sy = 40 + ((t * 30) % 30); x.moveTo(206, sy); x.quadraticCurveTo(216, sy + 16, 206, sy + 20); x.quadraticCurveTo(196, sy + 16, 206, sy); x.fill(); }
  if (st === 'working') { x.fillStyle = hexA(col, .55); for (let k = 0; k < 3; k++) { const w = 20 + ((k * 37 + Math.floor(t * 4) * 13) % 40); x.fillRect(40, 160 + k * 9, w, 4); } }
  a.faceTex.needsUpdate = true;
}

// A small picture of an agent's head, for toasts, the agent list and the Mac banners.
// Drawn once per look and mood with its own tiny renderer, then cached.
let faceRig = null;
const faceCache = new Map();
function faceShot(a, mood = 'done') {
  if (!a || !a.head || a.gone) return '';
  const id = `${a.id}|${mood}`, key = `${uiPrefs.crew}|${a.color}|${JSON.stringify(a.look)}`, hit = faceCache.get(id);
  if (hit && hit.key === key) return hit.url;
  try {
    if (!faceRig) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setPixelRatio(2); r.setSize(96, 96, false);
      const sc = new THREE.Scene(), key = new THREE.DirectionalLight(0xffffff, .75); key.position.set(1.5, 2, 3);
      sc.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1), key);
      faceRig = { r, sc, cam: new THREE.PerspectiveCamera(28, 1, .1, 20) };
    }
    const { r, sc, cam } = faceRig, was = [a.state, a.blink, a.faceErrorUntil];
    a.state = mood; a.blink = 0; a.faceErrorUntil = -1; drawFace(a);
    [a.state, a.blink, a.faceErrorUntil] = was;
    const head = a.head.clone(); head.position.set(0, 0, 0); head.rotation.set(0, -.35, 0); sc.add(head);
    const box = new THREE.Box3().setFromObject(head), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    cam.position.set(c.x, c.y + size.y * .1, c.z + Math.max(size.x, size.y) * .52 / Math.tan(THREE.MathUtils.degToRad(14))); cam.lookAt(c);
    r.render(sc, cam); sc.remove(head);
    const url = r.domElement.toDataURL('image/png');
    drawFace(a);   // back to its real face
    faceCache.set(id, { key, url });
    return url;
  } catch (_) { return ''; }
}
const faceImg = a => { const url = faceShot(a); return url ? `<img class="av-face" src="${url}" alt="">` : esc(a.name[0] || '?'); };
// The desktop app shows these faces on its "done" and "needs you" banners. The browser-only office ignores them.
const sentFaces = new Map();
function sendFaces(a) {
  if (!a.live || a.kind !== 'main' || !a.sessionId) return;
  for (const mood of ['done', 'waiting']) {
    const url = faceShot(a, mood), k = `${a.sessionId}|${mood}`;
    if (!url || sentFaces.get(k) === url) continue;
    sentFaces.set(k, url);
    fetch(url).then(r => r.blob()).then(png => officeAuth.fetch(`/api/face/${encodeURIComponent(a.sessionId)}/${mood}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).catch(() => {});
  }
}

function drawLabel(a) {
  const x = a.L.x; x.clearRect(0, 0, 512, 128);
  x.fillStyle = sceneT.dark ? 'rgba(18,26,30,.9)' : 'rgba(255,255,255,.94)'; rrect(x, 6, 10, 500, 108, 30); x.fill();
  x.strokeStyle = sceneT.dark ? '#253238' : '#DCE3E6'; x.lineWidth = 3; x.stroke();
  x.fillStyle = STATUS[a.state].hex; x.beginPath(); x.arc(46, 64, 15, 0, 7); x.fill();
  const cup = a.kind === 'main' && a.context, tw = cup ? 352 : 410;
  x.fillStyle = sceneT.dark ? '#E2EAED' : '#15212A'; x.font = '700 38px "Bricolage Grotesque", sans-serif';
  x.fillText(fitText(x, a.name, tw), 76, 58);
  x.fillStyle = sceneT.dark ? '#8C9DA5' : '#5B6A72'; x.font = '400 27px "IBM Plex Sans", sans-serif';
  x.fillText(fitText(x, a.activity, tw), 76, 96);
  // Memory as a coffee cup: full when the chat is fresh, draining as the context window fills.
  if (cup) { const left = 1 - ctxShare(a.context), X = 440, Y = 30, Wc = 40, Hc = 66, ink = sceneT.dark ? '#8C9DA5' : '#5B6A72';
    x.save(); rrect(x, X, Y, Wc, Hc, 8); x.clip(); x.fillStyle = ctxColor(a.context); x.fillRect(X, Y + Hc * (1 - left), Wc, Hc * left); x.restore();
    x.strokeStyle = ink; x.lineWidth = 4; rrect(x, X, Y, Wc, Hc, 8); x.stroke();
    x.beginPath(); x.arc(X + Wc + 2, Y + Hc * .45, 12, -Math.PI / 2, Math.PI / 2); x.stroke(); }
  a.L.t.needsUpdate = true; a.labelDirty = false;
}
const stateColor = a => a.state === 'idle' ? sceneT.screenOff : STATUS[a.state].hex;
function setAgentLook(a, patch) {
  a.look = { ...a.look, ...patch }; buildRig(a);
  agents.filter(s => s.parent === a).forEach(s => { s.look = internLook(a, s.color); buildRig(s); });
  a.labelDirty = true; saveAgentPrefs(a); sendFaces(a);
}
function setState(a, state, activity) {
  if (/failed|Denied/.test(activity || '')) a.faceErrorUntil = a.animT + 4;   // a worried face for a few seconds
  if (state === 'waiting' && a.state !== 'waiting') a.waitingSince = Date.now(); else if (state !== 'waiting') a.waitingSince = 0;
  a.state = state; a.activity = activity; a.labelDirty = true; uiDirty = true; detailDirty = true; updateScreen(a); }
function updateScreen(a) {
  if (a.gone) return; const c = stateColor(a);
  a.lapScreen.color.set(c);
  if (a.spot && a.spot.screen && !a.path.length && a.floor === curFloor) a.spot.screen.color.set(c);
}
function setAgentColor(a, hex) {
  a.color = hex; buildRig(a);
  if (a.home && a.home.owner === a && a.floor === curFloor) a.home.chairMat.color.set(hex);
  agents.filter(s => s.parent === a).forEach(s => { s.look = internLook(a, mix(hex, '#ffffff', .35)); setAgentColor(s, mix(hex, '#ffffff', .35)); });
  a.labelDirty = true; uiDirty = true; detailDirty = true; sendFaces(a);
}

/* ---------- events ---------- */
const BASE = 9 * 3600 + 41 * 60;
const clock = t => { const s = Math.floor(BASE + t); return [s / 3600 | 0, (s / 60 | 0) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const feedEl = $('#feed');
const wallClock = ms => new Date(ms).toLocaleTimeString([], { hour12: false });
const stamp = e => e.at ? wallClock(e.at) : clock(e.t);
// Hook names are for developers; the feed says what happened in plain words (the hook name stays on hover).
const HOOK_WORDS = { SessionStart: 'Joined', SessionFound: 'Joined', SessionEnd: 'Left', UserPromptSubmit: 'Got a prompt', PreToolUse: 'Started',
  PostToolUse: 'Finished', PostToolUseFailure: 'Failed', PermissionRequest: 'Asked to run', PermissionResolved: 'Answered', Notification: 'Needs you',
  Stop: 'Done', SubagentStart: 'Subagent in', SubagentStop: 'Subagent out', PreCompact: 'Compacting', GoingInCircles: 'Going in circles',
  SameFile: 'Same file', Merged: 'Merged', Unstuck: 'Unstuck', Passed: 'Passed' };
const hookTag = (hook, warn) => `<code class="hook${warn ? ' warn' : ''}" title="${esc(hook)}">${esc(HOOK_WORDS[hook] || hook)}</code>`;
function emit(a, hook, detail, at) {
  const e = { t: simTime, at, hook, detail, a };
  a.log.unshift(e); a.log.length = Math.min(a.log.length, 6);
  const li = document.createElement('li');
  const warn = hook === 'Notification' || /denied/.test(detail);
  li.innerHTML = `<time>${stamp(e)}</time><div class="top">${hookTag(hook, warn)}<span class="by" style="--c:${a.color}" title="${esc(a.name)}">${esc(a.name)}</span></div><div class="what" title="${esc(detail)}">${esc(detail)}</div>`;
  feedEl.prepend(li); while (feedEl.children.length > 80) feedEl.lastChild.remove();
  if (a === selected) detailDirty = true;
}
