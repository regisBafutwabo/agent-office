/* ---------- outcomes: what a command's result looks like, and what a desk remembers ---------- */
// "Finished responding" isn't "it worked", so reactions key off a command passing or failing, never off Stop.
const RUN_LONG_MS = 20000;                      // a passing command that took this long delivers a parcel
const RUN_GEAR_MS = 6000;                       // a command still running after this long gets a turning gear
const CHEER_GAP_MS = 20000;                     // small comebacks cheer at most this often, so a retry loop doesn't become a party
function outcomeOf(e, failsBefore, ranMs) {
  if (e.tool !== 'Bash') return null;
  if (e.failed) return { kind: 'soot' };
  if (failsBefore >= STUCK_AFTER) return { kind: 'unstuck', fails: failsBefore };
  if (failsBefore > 0) return { kind: 'comeback', fails: failsBefore };
  return ranMs >= RUN_LONG_MS ? { kind: 'parcel' } : null;
}
// A command in a few words for a reaction bubble: "cd api && CI=1 uv run pytest -x" → "uv run pytest".
const RUNNERS = /^(npx|bunx|uv|pnpm|yarn|bun|poetry|bundle|cargo|go|make|npm)$/;
function cmdShort(s) {
  const part = String(s || '').split(/&&|\|\||;|\|/).map(p => p.trim()).find(p => p && !/^(cd|export|source|set)\b/.test(p)) || '';
  const w = part.replace(/^(\w+=\S*\s+)+/, '').split(/\s+/).filter(x => x && !x.startsWith('-')).map((x, i) => i ? x : x.split('/').pop());
  const out = w.slice(0, RUNNERS.test(w[0]) ? 3 : 2).join(' ');
  return out.length > 24 ? out.slice(0, 23) + '…' : out;
}
const fmtDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
// A desk's memory holds counts and dated captions only: no prompts, commands or file names.
const MOMENTS_MAX = 40;
const PLANT_DAYS = [1, 3, 7, 14, 30];           // days worked here before the desk plant grows a size
const plantStage = days => PLANT_DAYS.filter(n => days >= n).length;
const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const emptyDesk = () => ({ dayCount: 0, lastDay: '', merges: 0, unstuck: 0, team: false, moments: [] });
// Both return the same object when nothing changed, so a second open page or a replayed event can't count twice.
function remember(desk, kind, at, n) {
  const id = `${kind}:${at}`;
  if (desk.moments.some(m => m.id === id) || (kind === 'team' && desk.team)) return desk;
  return { ...desk, moments: [{ id, kind, at, n }, ...desk.moments].slice(0, MOMENTS_MAX),
    merges: desk.merges + (kind === 'merge'), unstuck: desk.unstuck + (kind === 'unstuck'), team: desk.team || kind === 'team' };
}
function workedOn(desk, at) {
  const day = dayOf(at); if (desk.lastDay >= day) return desk;
  const d = { ...desk, lastDay: day, dayCount: desk.dayCount + 1 };
  return plantStage(d.dayCount) > plantStage(desk.dayCount) ? remember(d, 'grew', at, d.dayCount) : d;
}
const momentText = m => m.kind === 'merge' ? 'Work got merged' : m.kind === 'unstuck' ? `Got unstuck after ${m.n} failed tries`
  : m.kind === 'team' ? 'First subagent team' : m.n === 1 ? 'Moved in: a sprout on the desk' : `The desk plant grew after ${m.n} days here`;
const deskKey = cwd => 'agent-office:desk:' + cwd;
const demoDesks = new Map();                    // demo projects keep theirs in memory only
function deskOf(a) {
  a = a.parent || a;
  if (!a.live) return demoDesks.get(a.project.key) || emptyDesk();
  try { return { ...emptyDesk(), ...(a.cwd && JSON.parse(localStorage.getItem(deskKey(a.cwd)))) }; } catch (_) { return emptyDesk(); }
}
function changeDesk(a, change) {
  a = a.parent || a; const was = deskOf(a), d = change(was); if (d === was) return;
  if (!a.live) demoDesks.set(a.project.key, d); else if (a.cwd) { try { localStorage.setItem(deskKey(a.cwd), JSON.stringify(d)); } catch (_) {} }
  deskDirty = true; detailDirty = true;
}
addEventListener('storage', e => { if (e.key && e.key.startsWith('agent-office:desk:')) { deskDirty = true; detailDirty = true; } });
const TROPHY = M('#E9B83A', { roughness: .35, metalness: .2 });
function drawDesks() {
  deskDirty = false; if (!curFloor) return;
  curFloor.deskSeats.forEach((s, i) => {
    const g = deskShelves[i], d = s.owner && !s.owner.gone ? deskOf(s.owner) : null, stage = d ? plantStage(d.dayCount) : 0;
    const sig = d ? `${stage}|${d.merges}|${d.unstuck}` : '';
    if (sig === g.userData.sig) return; g.userData.sig = sig;
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); g.clear();
    if (!d) return;
    // Left of the screen, between the keyboard and the monitor. Drawn larger than life so they read from across the floor.
    const z = s.face[1] * .62, cups = Math.min(d.merges, 4);
    const stand = x => { const h = new THREE.Group(); h.position.set(x, .77, z); h.scale.setScalar(1.7); g.add(h); return h; };
    if (stage) {
      const h = stand(-.96); cyl(.05, .038, .07, mats.pot2, 0, .035, 0, h, 12);
      for (let k = 0; k < stage; k++) part(new THREE.IcosahedronGeometry(.034 + stage * .005, 0), k % 2 ? mats.leaf2 : mats.leaf, h, Math.sin(k * 2.4) * .028, .1 + k * .042, Math.cos(k * 2.4) * .028);
    }
    for (let i = 0; i < cups; i++) {                                // a cup per merge; from the fifth on, the first one is the big one
      const h = stand(-.79 + i * .13); if (!i && d.merges > 4) h.scale.setScalar(2.5);
      cyl(.03, .03, .012, TROPHY, 0, .006, 0, h, 12); cyl(.008, .008, .04, TROPHY, 0, .032, 0, h, 6); cyl(.032, .015, .05, TROPHY, 0, .077, 0, h, 12);
    }
    if (d.unstuck) part(new THREE.TorusKnotGeometry(.022, .007, 48, 6), mats.steel, stand(-.79 + cups * .13), 0, .04, 0);   // the knot it untangled
  });
}
// Short-lived bits in the air: confetti, soot, sparks, and a parcel that lands on the desk.
const fx = [];
const FX_GEO = { conf: new THREE.PlaneGeometry(.1, .06), soot: new THREE.SphereGeometry(.05, 8, 6), spark: new THREE.SphereGeometry(.016, 6, 4), parcel: new THREE.BoxGeometry(.26, .2, .22), gear: new THREE.TorusGeometry(.06, .02, 5, 9) };
const FX_MAT = { conf: ['#FFD166', '#EF476F', '#06D6A0', '#4CC9F0', '#F2F5F6'].map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })),
  soot: M('#34393C'), spark: new THREE.MeshBasicMaterial({ color: '#6FD69A' }), parcel: M('#C39A6B') };
const inView = a => a.floor === curFloor && !a.onRoof && onFloor() && a.g.visible && !document.hidden;
function burst(a, kind) {
  if (!inView(a)) return;
  const p = a.g.position, f = !a.path.length && a.spot && a.spot.face || [0, 0];   // over the desk it faces, or over itself mid-walk
  const add = (geo, mat, y, v, life, o, side = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(p.x + f[0] * .6 + Math.abs(f[1]) * side, y, p.z + f[1] * .6 + Math.abs(f[0]) * side); scene.add(m); fx.push(Object.assign({ m, v: new THREE.Vector3(...v), life, age: 0 }, o)); };
  if (kind === 'soot') for (let k = 0; k < 7; k++) add(FX_GEO.soot, FX_MAT.soot, 1.2, [rand(-.12, .12), rand(.25, .5), rand(-.12, .12)], rand(1.1, 1.7), { grow: 1.6 });
  else if (kind === 'parcel') {
    add(FX_GEO.parcel, FX_MAT.parcel, .9, [0, 1.9, 0], 7, { g: 6, rest: .9 }, .62);   // beside the keyboard, where you can see it past the agent
    for (let k = 0; k < 8; k++) add(FX_GEO.spark, FX_MAT.spark, 1, [rand(-.5, .5), rand(.6, 1.3), rand(-.5, .5)], .9, { g: 2.5 });
  } else for (let k = 0, n = kind === 'big' ? 48 : 22; k < n; k++) add(FX_GEO.conf, pick(FX_MAT.conf), 1.6, [rand(-1.3, 1.3), rand(2.2, 3.8), rand(-1.3, 1.3)], rand(1.8, 2.8), { g: 4.5, spin: rand(4, 10), drag: 1.2 });
}
function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i]; p.age += dt;
    if (p.age >= p.life) { scene.remove(p.m); fx.splice(i, 1); continue; }
    if (p.g) p.v.y -= p.g * dt;
    if (p.drag) p.v.multiplyScalar(1 - dt * p.drag);
    p.m.position.addScaledVector(p.v, dt);
    if (p.rest != null && p.m.position.y < p.rest) { p.m.position.y = p.rest; p.v.y = p.v.y < -.6 ? -p.v.y * .35 : 0; }
    if (p.spin) { p.m.rotation.x += p.spin * dt; p.m.rotation.z += p.spin * .7 * dt; }
    const k = p.age / p.life;
    p.m.scale.setScalar((p.grow ? 1 + k * p.grow : 1) * Math.min(1, (1 - k) / .2));   // shrinks away over its last fifth
  }
  const now = Date.now();
  for (const a of agents) {
    const on = !!a.run && now - a.run.at > RUN_GEAR_MS && a.state !== 'waiting';
    if (on && !a.gear) a.gear = part(FX_GEO.gear, mats.brass, a.g, .36, 1.02, .1, false);
    if (a.gear) { a.gear.visible = on; if (on) { a.gear.rotation.z += dt * 3; a.gear.position.y = 1.02 + Math.sin(now / 45) * .006; } }
    if (on && (!a.bubKind || a.bubKind === 'run')) {          // still running: a thought bubble counts the seconds, with a sweat drop after 30 s
      const secs = Math.floor((now - a.run.at) / 1000);
      if (a.bubKind !== 'run' || secs !== a.bubSecs) { a.bubSecs = secs; say(a, 'run', '', `…  ${fmtDur(secs * 1000)}`, secs >= 30 ? secs % 2 : -1); }
    } else if (!on && a.bubKind === 'run') a.bubKind = null;
    updateBubble(a, dt);
  }
}
function react(who, o, at, command, ms) {
  if (!o) return;
  const now = performance.now(), cmd = cmdShort(command), tries = n => `${n} failed ${n > 1 ? 'tries' : 'try'}`;
  if (o.kind === 'soot') { if (now - (who.sootAt || -1e9) > 3000) { who.sootAt = now; burst(who, 'soot'); say(who, 'fail', cmd ? `${cmd} failed` : 'command failed'); } return; }
  if (o.kind === 'parcel') { emit(who, 'Passed', `${cmd || 'Command'} passed after ${fmtDur(ms)}`, at); burst(who, 'parcel'); say(who, 'pass', `${cmd ? cmd + ' · ' : ''}${fmtDur(ms)}`); return; }
  const big = o.kind === 'unstuck';
  if (big) { emit(who, 'Unstuck', `Worked after ${o.fails} failed tries`, at); changeDesk(who, d => remember(d, 'unstuck', at, o.fails)); }
  else { emit(who, 'Passed', `${cmd || 'Command'} passed after ${tries(o.fails)}`, at); if (now - (who.cheeredAt || -1e9) < CHEER_GAP_MS) return; }
  who.cheeredAt = now; who.cheerUntil = now + (big ? 4500 : 2200); burst(who, big ? 'big' : 'small');
  say(who, big ? 'finally' : 'yes', big ? `worked after ${tries(o.fails)}` : cmd ? `${cmd} passed` : '');
}

/* ---------- manga bubbles: each reaction says in words what just happened ---------- */
// One sprite per agent, made on first use, above its name tag. A reaction replaces the "still running" thought bubble.
const BUB = {
  pass:    { text: 'PASSED!',   ink: '#FFB400', shape: 'burst',  life: 3,   sparkle: true },
  fail:    { text: 'FAIL…',     ink: '#E5534B', shape: 'jag',    life: 2.6, vein: true },
  yes:     { text: 'YES!',      ink: '#06D6A0', shape: 'oval',   life: 2.4, speed: true },
  finally: { text: 'FINALLY!!', ink: '#EF476F', shape: 'burst2', life: 4.5 },
  run:     { ink: '#4CC9F0', shape: 'cloud', life: Infinity },
  heard:   { text: '!',         ink: '#E5534B', shape: 'bang',   life: 1.1, size: 170 },   // called back from a break
};
const BUB_FONT = n => `${n}px Bangers, Impact, "Arial Black", sans-serif`;
function starPath(x, cx, cy, rx, ry, n, inner, jitter = 0) {
  x.beginPath();
  for (let i = 0; i < n * 2; i++) { const a = Math.PI * i / n - Math.PI / 2, k = i % 2 ? inner * (1 - jitter * ((i * 37) % 7) / 7) : 1; x.lineTo(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k); }
  x.closePath();
}
function sparkle(x, cx, cy, r) { x.beginPath(); x.moveTo(cx, cy - r); x.quadraticCurveTo(cx, cy, cx + r, cy); x.quadraticCurveTo(cx, cy, cx, cy + r); x.quadraticCurveTo(cx, cy, cx - r, cy); x.quadraticCurveTo(cx, cy, cx, cy - r); x.fillStyle = '#FFD166'; x.fill(); x.lineWidth = 3; x.strokeStyle = '#111'; x.stroke(); }
function drawBubble(a, kind, tag, text, drop = -1) {
  const B = BUB[kind], x = a.B.x, ink = '#111';
  x.clearRect(0, 0, 512, 256); x.lineJoin = 'round'; x.lineCap = 'round';
  if (B.speed) { x.strokeStyle = sceneT.dark ? 'rgba(240,244,246,.55)' : 'rgba(20,26,30,.45)'; for (let i = 0; i < 30; i++) { const t = Math.PI * 2 * i / 30; x.lineWidth = i % 2 ? 2 : 4; x.beginPath(); x.moveTo(256 + Math.cos(t) * 180, 92 + Math.sin(t) * 76); x.lineTo(256 + Math.cos(t) * 260, 92 + Math.sin(t) * 110); x.stroke(); } }
  x.lineWidth = 6; x.strokeStyle = ink;
  if (B.shape === 'burst') { starPath(x, 256, 92, 232, 84, 14, .78); x.fillStyle = '#FFF7D6'; x.fill(); x.stroke(); }
  else if (B.shape === 'jag') { starPath(x, 256, 92, 220, 80, 20, .84, .6); x.fillStyle = '#FFFFFF'; x.fill(); x.stroke(); }
  else if (B.shape === 'burst2') { starPath(x, 256, 92, 246, 90, 20, .72); x.fillStyle = '#EF476F'; x.fill(); x.stroke(); starPath(x, 256, 92, 206, 72, 20, .8); x.fillStyle = '#FFF7D6'; x.fill(); }
  else if (B.shape === 'bang') { starPath(x, 256, 104, 118, 100, 12, .72); x.fillStyle = '#FFD166'; x.fill(); x.stroke(); }
  else if (B.shape === 'oval') {
    x.beginPath(); x.ellipse(256, 88, 168, 70, 0, 0, 7); x.fillStyle = '#FFFFFF'; x.fill(); x.stroke();
    x.beginPath(); x.moveTo(222, 150); x.lineTo(200, 190); x.lineTo(262, 154); x.fill(); x.stroke(); x.beginPath(); x.ellipse(256, 88, 165, 67, 0, 0, 7); x.fill();
  } else {                                                    // a thought cloud: outline every puff first, then fill them all, so only the outer edge shows
    const puffs = [[170, 96, 58], [240, 70, 64], [320, 80, 60], [370, 106, 48], [290, 122, 52], [210, 124, 50], [126, 166, 14], [100, 192, 9]];
    x.lineWidth = 12; puffs.forEach(([cx, cy, r]) => { x.beginPath(); x.arc(cx, cy, r, 0, 7); x.stroke(); });
    x.fillStyle = '#FFFFFF'; puffs.forEach(([cx, cy, r]) => { x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill(); });
  }
  const words = text || B.text, size = B.size || (kind === 'run' ? 62 : 84);
  x.font = BUB_FONT(size); x.textAlign = 'center'; x.textBaseline = 'middle';
  const w = fitText(x, words, B.shape === 'oval' ? 300 : 360), ty = kind === 'run' ? 96 : kind === 'heard' ? 112 : 94;
  x.lineWidth = 12; x.strokeStyle = ink; x.strokeText(w, 256, ty); x.fillStyle = B.ink; x.fillText(w, 256, ty);
  if (B.sparkle) { sparkle(x, 30, 40, 18); sparkle(x, 486, 30, 15); sparkle(x, 494, 150, 12); }
  if (B.vein) { x.strokeStyle = '#E5534B'; x.lineWidth = 8; for (const [dx, dy, ex, ey, cx2, cy2] of [[-22, -6, -8, -22, -12, -6], [6, -22, 22, -8, 6, -6], [22, 6, 8, 22, 12, 6], [-6, 22, -22, 8, -6, 6]]) { x.beginPath(); x.moveTo(450 + dx, 176 + dy); x.quadraticCurveTo(450 + cx2, 176 + cy2, 450 + ex, 176 + ey); x.stroke(); } }
  if (drop >= 0) { const dy = 150 + drop * 14; x.beginPath(); x.moveTo(430, dy); x.quadraticCurveTo(446, dy + 22, 430, dy + 30); x.quadraticCurveTo(414, dy + 22, 430, dy); x.fillStyle = '#7CC7FF'; x.fill(); x.lineWidth = 3; x.strokeStyle = ink; x.stroke(); }
  if (tag) {
    x.font = '700 34px "IBM Plex Sans", sans-serif'; const t = fitText(x, tag, 440), tw = x.measureText(t).width + 40;
    x.fillStyle = '#111'; rrect(x, 256 - tw / 2, 196, tw, 54, 27); x.fill(); x.fillStyle = '#FFFFFF'; x.fillText(t, 256, 224);
  }
  a.B.t.needsUpdate = true;
}
function say(a, kind, tag, text, drop) {
  if (!inView(a)) return;
  if (!a.bub || a.bub.parent !== a.g) {
    a.B = a.B || canvasTex(512, 256);
    a.bub = new THREE.Sprite(new THREE.SpriteMaterial({ map: a.B.t, depthTest: false, transparent: true })); a.bub.renderOrder = 11; a.g.add(a.bub);
  }
  if (a.bubKind !== kind) a.bubAge = 0;
  a.bubKind = kind; drawBubble(a, kind, tag, text, drop);
}
function updateBubble(a, dt) {
  if (!a.bub) return;
  const B = a.bubKind && BUB[a.bubKind];
  if (B && (a.bubAge += dt) >= B.life) a.bubKind = null;
  a.bub.visible = !!a.bubKind && inView(a);
  if (!a.bub.visible) return;
  const t = Math.min(1, a.bubAge / .22), pop = 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;   // ease-out-back: a little overshoot
  a.bub.scale.set(2.9 * pop, 1.45 * pop, 1);
  a.bub.position.y = a.topY + 1.6 + Math.min(a.bubAge, B.life) * (B.life < Infinity ? .05 : 0);
  a.bub.material.opacity = B.life < Infinity ? Math.min(1, (B.life - a.bubAge) / .5) : 1;
  a.bub.material.rotation = a.bubKind === 'fail' ? Math.sin(a.bubAge * 14) * .05 : a.bubKind === 'heard' ? Math.sin(a.bubAge * 30) * .1 * Math.max(0, 1 - a.bubAge * 2) : 0;
}
