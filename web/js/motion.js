/* ---------- sim clock ---------- */
const timers = [];
const wait = s => new Promise(r => timers.push({ t: simTime + s, r }));
function tickTimers() { for (let i = timers.length - 1; i >= 0; i--) if (timers[i].t <= simTime) { const r = timers[i].r; timers.splice(i, 1); r(); } }

/* ---------- movement ---------- */
function freeSpots(types, f) { return types.flatMap(t => f.SPOTS[t] || []).filter(s => !s.by); }
function walkTo(a, s) {
  if (a.spot === s) return Promise.resolve();
  if (!a.spot && a.dest && a.dest !== s && a.dest !== a.home && a.dest.by === a.id) a.dest.by = null;
  const from = a.spot;
  if (from) {
    if (from !== a.home && from.by === a.id) from.by = null;
    if (from.screen && a.floor === curFloor) from.screen.color.set(sceneT.screenOff);
  }
  if (s.type && s !== a.home) s.by = a.id;
  const start = from ? approach(from) : { x: a.g.position.x, z: a.g.position.z };
  const end = approach(s);
  const pts = from ? [new THREE.Vector2(start.x, start.z)] : [];
  pts.push(...route(start.x, start.z, end.x, end.z));
  if (end.x !== s.x || end.z !== s.z) pts.push(new THREE.Vector2(s.x, s.z));
  a.path = pts; a.spot = null; a.dest = s; a.where = 'Walking'; a.laptop.visible = false; uiDirty = true;
  return new Promise(r => { a.arrive = () => { a.sprint = null; a.spot = s; a.dest = null; a.arrivedAt = performance.now(); a.where = s.type ? (s === a.home && a.kind === 'main' ? 'Own desk' : PLACE[s.type]) : ''; uiDirty = true; detailDirty = true; updateScreen(a); r(); }; });
}
function chooseWorkspot(a) {
  const away = () => { const f = freeSpots(LOUNGE_WORK, a.floor); return f.length ? pick(f) : null; };
  if (a.pref === 'desk') return a.home;
  if (a.pref === 'lounge') return away() || a.home;
  return Math.random() < .5 ? a.home : (away() || a.home);
}
/* ---------- sprinting back: called back from a break, anime style ---------- */
// The sprint lasts until the walk ends, even if a tool call re-aims it on the way: arriving is what clears it.
const SPRINT = 2.5;                                                // times walking speed
const SKID = 1.2;                                                 // the last this-many units are a skid into the seat
const IDLE_TYPES = ['coffee','hoops','arcade','beanbag','pouf','sofa'];
function sprintBack(a, from) {
  if (!a.path.length || !from || !IDLE_TYPES.includes(from.type) || a.onRoof) return;
  say(a, 'heard');                                                 // "!": it heard you
  if (!reduced) a.sprint = { hold: .3, puffIn: 0, skid: false };    // a beat to turn and crouch, then off; reduced motion: it walks
}
const pathLeft = a => { const p = a.g.position; let d = 0, x = p.x, z = p.z; for (const v of a.path) { d += Math.hypot(v.x - x, v.y - z); x = v.x; z = v.y; } return d; };
// Speed smoke: grey puffs left at the feet that swell, drift up and fade. Pooled, and only on the floor being shown.
const DUST_GEO = new THREE.IcosahedronGeometry(.14, 1), DUST_MAX = 80, dust = [], dustPool = [];
function puff(a, back, side, up, life) {
  if (dust.length >= DUST_MAX || a.floor !== curFloor || !a.g.visible || document.hidden) return;
  const m = dustPool.pop() || new THREE.Mesh(DUST_GEO, new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, depthWrite: false }));
  m.material.color.set(sceneT.dark ? '#AEB6BB' : '#D9DCDE'); m.material.emissive.set(sceneT.dark ? '#2A3034' : '#3C3E40');   // lit from within a little, so it reads as smoke, not a pebble
  const ux = Math.sin(a.yaw), uz = Math.cos(a.yaw), sx = rand(-side, side), p = a.g.position, s = rand(.7, 1.1);
  m.position.set(p.x - ux * back + uz * sx, rand(.06, .14), p.z - uz * back - ux * sx); m.scale.setScalar(s); m.material.opacity = .9;
  scene.add(m);
  dust.push({ m, s, floor: a.floor, age: 0, life, v: new THREE.Vector3(-ux * rand(.2, .6) + uz * sx * 2, up * rand(.7, 1.3), -uz * rand(.2, .6) - ux * sx * 2) });
}
const dustBurst = (a, n) => { for (let i = 0; i < n; i++) puff(a, rand(-.1, .25), .35, .55, rand(.6, .9)); };
function updateDust(sdt) {
  for (let i = dust.length - 1; i >= 0; i--) {
    const d = dust[i]; d.age += sdt;
    if (d.age >= d.life) { scene.remove(d.m); dustPool.push(d.m); dust.splice(i, 1); continue; }
    const k = d.age / d.life;
    d.m.position.addScaledVector(d.v, sdt); d.v.multiplyScalar(1 - Math.min(1, sdt * 3));
    d.m.scale.setScalar(d.s * (1 + k * 1.3)); d.m.material.opacity = .9 * (1 - k * k);
    d.m.visible = d.floor === curFloor;
  }
}
const IDLE_WEIGHT = { hoops: 4, arcade: 3 };                       // the games are the fun ones: pick them more often
function chooseIdle(fl) {
  const f = freeSpots(IDLE_TYPES, fl); if (!f.length) return null;
  let r = Math.random() * f.reduce((n, s) => n + (IDLE_WEIGHT[s.type] || 1), 0);
  return f.find(s => (r -= IDLE_WEIGHT[s.type] || 1) < 0) || f[f.length - 1];
}

/* ---------- behaviour ---------- */
function makePlan(p) {
  const f1 = pick(p.files), f2 = pick(p.files.filter(f => f !== f1));
  const s = [{ t:'think', label:'Planning the change' }, { t:'tool', tool:'Read', arg:f1 }, { t:'tool', tool:'Grep', arg:`"${pick(p.greps)}"` }];
  if (Math.random() < .45) s.push({ t:'spawn', type: pick(['Explore','Explore','Plan']), task: pick(p.subTasks) });
  s.push({ t:'think', label:'Choosing an approach' }, { t:'tool', tool:'Edit', arg:f1 });
  if (Math.random() < .55) s.push({ t:'tool', tool:'Edit', arg:f2 });
  s.push({ t:'tool', tool:'Bash', arg: pick(p.cmds) });
  if (Math.random() < .42) s.push({ t:'tool', tool:'Bash', arg: pick(p.risky), perm:true });
  s.push({ t:'think', label:'Writing a summary' });
  return s;
}
function askPermission(a, tool, cmd) {
  return new Promise(res => { a.approval = { tool, cmd, deadline: simTime + 30, resolve: v => { a.approval = null; uiDirty = true; detailDirty = true; res(v); } }; uiDirty = true; detailDirty = true; });
}
async function doTool(a, ws, tool, arg) {
  const label = `${tool} ${arg}`;
  emit(a, 'PreToolUse', label); toolCalls++;
  const toLibrary = (tool === 'Read' || tool === 'Grep' || tool === 'Glob') && Math.random() < (a.kind === 'sub' ? .6 : .25);
  if (toLibrary && a.spot && a.spot.type === 'library') { /* already there */ }
  else if (toLibrary) { const s = freeSpots(['library'], a.floor); if (s.length) { setState(a, 'working', `→ Library: ${tool}`); await walkTo(a, pick(s)); } }
  else if (a.spot !== ws) { setState(a, 'working', 'Back to work'); await walkTo(a, ws); }
  a.pose = a.spot && a.spot.type === 'library' ? 'read' : 'type';
  setState(a, 'working', label);
  const bash = tool === 'Bash', long = bash && /test|build|e2e/.test(arg);
  let fails = 0;
  if (bash) a.run = { at: Date.now() };
  if (bash && Math.random() < .18) for (const n = Math.random() < .3 ? 3 : 1; fails < n; fails++) {
    await wait(rand(2, 3.5)); emit(a, 'PostToolUseFailure', label); noteWork(a, { tool, summary: arg, failed: true }); react(a, { kind: 'soot' }, Date.now(), arg);
    a.pose = 'think'; setState(a, 'thinking', `${tool} failed, rethinking`); await wait(rand(1.5, 2.5)); a.pose = 'type'; setState(a, 'working', label);
  }
  await wait(long ? rand(8, 12) : rand(2.2, 4));
  if (bash) { a.run = null; const ms = long ? rand(25000, 95000) : 0; react(a, outcomeOf({ tool }, fails, ms), Date.now(), arg, ms); }
  emit(a, 'PostToolUse', label);
  noteWork(a, { tool, summary: arg, edit: tool === 'Edit' || tool === 'Write' ? { ...pick(DEMO_EDITS), more: 0 } : null });
}
async function mainLoop(a) {
  emit(a, 'SessionStart', '~/Documents/' + a.project.key);
  await wait(rand(1, 5));
  for (;;) {
    if (a.onRoof) await leaveRoof(a);
    const fromUser = a.pending.length > 0;
    const prompt = fromUser ? a.pending.shift() : pick(a.project.prompts);
    const ws = chooseWorkspot(a);
    a.busy = true;
    if (a.spot !== ws) { setState(a, 'working', `Heading to the ${ws === a.home ? 'desk' : PLACE[ws.type].toLowerCase()}`); await walkTo(a, ws); }
    a.pose = 'think'; emit(a, 'UserPromptSubmit', `"${prompt}"${fromUser ? ' · from you' : ''}`); chatPush(a, 'user', prompt);
    setState(a, 'thinking', prompt); await wait(rand(2, 3.5));
    for (const st of makePlan(a.project)) {
      if (st.t === 'think') {
        if (a.spot !== ws) { setState(a, 'working', 'Back to work'); await walkTo(a, ws); }
        a.pose = 'think'; setState(a, 'thinking', st.label); await wait(rand(1.6, 3)); continue;
      }
      if (st.t === 'spawn') {
        emit(a, 'PreToolUse', `Task · ${st.type}: ${st.task}`); toolCalls++;
        if (a.spot !== ws) await walkTo(a, ws);
        a.pose = 'think'; setState(a, 'working', `Waiting on ${st.type} subagent`);
        const ok = await runSub(a, st.type, st.task);
        emit(a, 'PostToolUse', ok ? `Task · ${st.type} returned` : 'Task · no free seat, skipped'); continue;
      }
      if (st.perm) {
        a.pose = 'raise'; setState(a, 'waiting', `Wants to run ${st.tool}`); emit(a, 'Notification', `Permission needed · ${st.tool} ${st.arg}`);
        toast(`${a.name} on floor ${floorNum(a.floor)} wants to run ${st.arg}`, 'Review', () => select(a, true));
        const v = await askPermission(a, st.tool, st.arg);
        if (v === 'deny') { emit(a, 'PreToolUse', `denied · ${st.tool} ${st.arg}`); a.pose = 'think'; setState(a, 'thinking', 'Finding another way'); await wait(2.2); continue; }
        if (v === 'auto') emit(a, 'PreToolUse', `auto-approved (demo) · ${st.tool} ${st.arg}`);
      }
      await doTool(a, ws, st.tool, st.arg);
    }
    a.busy = false; a.pose = 'idle'; emit(a, 'Stop', `Finished: ${prompt}`); setState(a, 'done', `Finished: ${prompt}`); chatPush(a, 'assistant', `Finished "${prompt}". The checks pass.`);
    await wait(3);
    if (a.pending.length) continue;
    if (Math.random() < .45 && await goRoof(a)) { await Promise.race([wait(rand(14, 26)), new Promise(r => a.wake = r)]); a.wake = null; continue; }
    const idle = chooseIdle(a.floor);
    if (idle) { setState(a, 'done', `Heading to the ${PLACE[idle.type].toLowerCase()}`); await walkTo(a, idle);
      a.pose = poseFor(a); setState(a, 'idle', IDLE_ACTIVITY[idle.type]); }
    else setState(a, 'idle', 'Waiting for the next prompt');
    await Promise.race([wait(rand(8, 14)), new Promise(r => a.wake = r)]); a.wake = null;
  }
}
async function runSub(parent, type, task) {
  let home = null;
  const fl = parent.floor;
  if (type === 'Plan') home = freeSpots(['meeting'], fl)[0] || null;
  if (!home) { const near = fl.deskSeats.filter(s => !s.by).sort((p, q) => Math.hypot(p.x - parent.home.x, p.z - parent.home.z) - Math.hypot(q.x - parent.home.x, q.z - parent.home.z)); home = near[0] || freeSpots(['hightable','stool'], fl)[0] || null; }
  if (!home) return false;
  home.by = 'reserved';
  const a = createAgent({ name: type, kind:'sub', subType: type, color: mix(parent.color, '#ffffff', .35), home, parent, project: parent.project, floor: fl });
  home.by = a.id; a.spot = DOOR; a.g.position.set(DOOR.x, 0, DOOR.z); a.yaw = a.yawT = -Math.PI / 2; a.appear = 0; a.busy = true;
  emit(a, 'SubagentStart', task); setState(a, 'working', 'Walking in');
  await walkTo(a, home); a.pose = 'think'; setState(a, 'thinking', task); await wait(rand(1.5, 2.5));
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const tool = pick(['Read','Grep','Glob','Read']);
    const arg = tool === 'Read' ? pick(parent.project.files) : tool === 'Grep' ? `"${pick(parent.project.greps)}"` : pick(['**/*.ts','src/**/*.tsx','**/*.py','tests/**']);
    await doTool(a, home, tool, arg);
  }
  if (a.spot !== home) { setState(a, 'working', 'Back to the seat'); await walkTo(a, home); }
  a.pose = 'type'; setState(a, 'thinking', 'Writing up findings'); await wait(rand(1.5, 2.5));
  a.busy = false; a.pose = 'idle'; setState(a, 'done', `Done · ${parent.name} is coming over`); emit(a, 'SubagentStop', `Returned findings to ${parent.name}`);
  setState(parent, 'thinking', `Reviewing “${task}”`);
  await walkTo(parent, besideSpot(home)); parent.pose = 'think'; parent.where = `Beside ${a.name}`;
  setState(a, 'done', `${parent.name} is reviewing the work`); await wait(rand(3, 5));
  setState(a, 'done', `Let go by ${parent.name}`);
  (async () => {
    await wait(1.2);
    a.gone = true; home.by = null; if (home.screen && a.floor === curFloor) home.screen.color.set(sceneT.screenOff);
    await walkTo(a, DOOR); a.leaving = true; await wait(.7);
    removeAgent(a);
  })();
  return true;
}
function removeAgent(a) {
  seeAgent(a);
  scene.remove(a.g); const i = agents.indexOf(a); if (i >= 0) agents.splice(i, 1);
  const pi = pickables.indexOf(a.hit); if (pi >= 0) pickables.splice(pi, 1);
  if (selected === a) select(null);
  uiDirty = true;
}

/* ---------- per-frame agent update ---------- */
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const ELBOW_REST = -.15;                                           // arms hang with a slight bend
const COFFEE_MS = 2 * 60 * 1000;                                   // how long a coffee from the bar lasts
const sipTip = new THREE.Quaternion(), X_AXIS = new THREE.Vector3(1, 0, 0);
function animationPose(a, moving) {
  if (moving) return 'walk';
  if (a.cheerUntil > performance.now() && a.state !== 'waiting') return 'cheer';
  return a.pose === 'dance' && !canDance(a) ? 'idle' : a.pose;
}
function updateAgent(a, dt, sdt) {
  const g = a.g;
  // Thinking in a swivel chair: arms on the armrests, looking up, turning the chair slowly from side to side.
  const swivel = !a.path.length && !!a.spot && !!a.spot.chair && a.pose === 'think' && !(a.cheerUntil > performance.now());
  g.visible = a.onRoof ? roofGroup.visible : a.floor === curFloor;
  if (a.path.length) {
    const tgt = a.path[0], dx = tgt.x - g.position.x, dz = tgt.y - g.position.z, d = Math.hypot(dx, dz);
    let step = 2.5 * sdt;
    if (a.sprint && a.sprint.hold > 0) { a.sprint.hold -= sdt; step = 0; }   // still turns toward the desk
    else if (a.sprint) {                                           // a skid slows at a steady rate, so speed goes with √(distance left)
      const S = a.sprint, left = pathLeft(a), skid = left < SKID;
      if (skid && !S.skid) dustBurst(a, 6);
      S.skid = skid; step *= SPRINT * (skid ? Math.max(.25, Math.sqrt(left / SKID)) : 1);
      if ((S.puffIn -= sdt) <= 0) { S.puffIn = skid ? .035 : .055; puff(a, .25, .12, skid ? .25 : .4, rand(.45, .7)); }
    }
    if (d <= step) { g.position.x = tgt.x; g.position.z = tgt.y; a.path.shift(); if (!a.path.length && a.arrive) { if (a.sprint) dustBurst(a, 5); const f = a.arrive; a.arrive = null; f(); } }
    else { g.position.x += dx / d * step; g.position.z += dz / d * step; a.yawT = Math.atan2(dx, dz); }
  } else if (a.spot && a.spot.face) a.yawT = yawOf(a.spot.face) + (swivel ? Math.sin(a.animT * .8) * .45 : 0);
  a.yaw = lerpAngle(a.yaw, a.yawT ?? a.yaw, 1 - Math.exp(-sdt * (swivel ? 3 : 10))); g.rotation.y = a.yaw;
  // The chair turns with whoever sits in it. Chairs are shared by every floor, so only the floor on show may move them.
  if (!a.path.length && a.spot && a.spot.chair && a.floor === curFloor) a.spot.chair.rotation.y = a.yaw;
  const targetAppear = a.leaving ? 0 : 1; a.appear += (targetAppear - a.appear) * (1 - Math.exp(-sdt * 6));
  g.scale.setScalar(a.scale * Math.max(.001, a.appear));
  a.animT += sdt; const t = a.animT; const moving = a.path.length > 0;
  let bob = 0, l = 0, r = 0, rz = 0, lz = 0, ls = 1, rs = 1, le = ELBOW_REST, re = ELBOW_REST, tilt = 0, lean = 0;
  const pose = animationPose(a, moving), carrying = moving && !a.onRoof;
  const onLaptop = !moving && a.busy && !!a.spot && !!a.spot.laptop;
  switch (pose) {
    case 'walk':
      if (a.sprint && a.sprint.hold > 0) { l = -.7; r = .7; le = re = -1.4; bob = -.08; lean = .25; }   // crouched to go
      else if (a.sprint && a.sprint.skid) { l = r = .8; le = re = -.3; tilt = -.15; bob = -.05; lean = -.3; }   // skidding: leaning back, arms flung behind
      else if (a.sprint) { bob = Math.abs(Math.sin(t * 15)) * .1; l = Math.sin(t * 15) * 1.15; r = carrying ? -l * .3 : -l; le = re = -1.4; tilt = -.12; lean = .38; }   // head down, elbows bent, arms pumping
      else { bob = Math.abs(Math.sin(t * 9)) * .06; l = Math.sin(t * 9) * .6; r = carrying ? -l * .3 : -l; }   // the laptop arm swings less
      break;
    case 'type': l = -1.15 + Math.sin(t * 17) * .13; r = -1.15 + Math.sin(t * 17 + 1.7) * .13; tilt = .12; break;
    case 'think': tilt = Math.sin(t * 1.4) * .12 - .05; r = -2.1; l = -.15; bob = Math.sin(t * 2) * .015; break;
    case 'read': l = r = -.95; tilt = .28; bob = Math.sin(t * 1.5) * .01; break;
    case 'raise': r = -2.95; rz = Math.sin(t * 8) * .35; bob = Math.abs(Math.sin(t * 4)) * .05; tilt = -.1; break;
    case 'shoot': { const u = a.shootU || 0;                  // synced with the machine's shot cycle
      if (u < .12) l = r = -.9 - 1.2 * (u / .12);
      else if (u < .38) { const k = (u - .12) / .26; l = r = -2.1 - .7 * k; bob = .02 * k; }
      else if (u < .45) { const k = (u - .38) / .07; l = r = -2.8 - .3 * k; bob = .09 * (1 - k); tilt = -.25; }
      else { const k = (u - .45) / .55; l = r = -3.1 + 2.2 * k; tilt = -.25 * (1 - k); }
      break; }
    case 'cheer': { const b = performance.now() / 1000 * Math.PI * 3;   // just merged: both arms up, hopping
      bob = Math.abs(Math.sin(b)) * .16; l = r = -2.9 + Math.sin(b) * .18; rz = Math.sin(b) * .2; tilt = -.15; break; }
    case 'dance': { const b = partyBeat() * Math.PI;             // on the beat with the DJ: bounce, arms up
      bob = Math.abs(Math.sin(b)) * .09; l = -2.5 + Math.sin(b) * .5; r = -2.5 - Math.sin(b) * .5; rz = Math.sin(b / 2) * .4; tilt = Math.sin(b) * .08; break; }
    case 'arcade': l = -1.05 + Math.abs(Math.sin(t * 13)) * .14; r = -1.0; rz = Math.sin(t * 7) * .22; tilt = .1 + Math.sin(t * 1.3) * .04;   // stick in one hand, buttons with the other
      bob = Math.sin(t * 2.4) * .012; break;
    case 'play': r = -1.2 + Math.sin(t * 5.5) * .7; rz = Math.sin(t * 5.5) * .5; l = -.3; bob = Math.abs(Math.sin(t * 5.5)) * .04; break;
    default: bob = Math.sin(t * 2) * .015; l = r = -.06;
  }
  if (onLaptop && a.lapSpot !== a.spot) { a.lapSpot = a.spot; a.lap = laptopAt(a, a.spot); a.laptop.position.y = a.lap.y; a.laptop.position.z = a.lap.z; }
  if (pose === 'type' && !moving && a.spot && a.spot.keys && !onLaptop && a.keysSpot !== a.spot) { a.keysSpot = a.spot; a.keys = keysAt(a, a.spot); }
  const typeOn = pose !== 'type' || moving ? null : onLaptop ? a.lap.type : a.spot && a.spot.keys ? a.keys : null;
  if (typeOn) {                                            // hands on the keys, not the air in front of them
    const T = typeOn, j = Math.sin(t * 17) * .07, k2 = Math.sin(t * 17 + 1.7) * .07;
    l = T.x + j; r = T.x + k2; lz = T.z + .12; rz = -T.z - .12; ls = rs = T.s; le = re = T.e;
    if (!onLaptop) lean = LEAN;                             // at a desk: lean in over the keyboard
  }
  // Coffee: picked up at the coffee bar and held for a while after, sipped while idling or thinking; put down to type or read.
  const now = performance.now();
  if (!moving && a.spot && a.spot.type === 'coffee' && !a.onRoof) a.coffeeUntil = now + COFFEE_MS;
  const hasCoffee = !!a.coffee && !a.onRoof && now < (a.coffeeUntil || 0);
  const holdsCup = hasCoffee && !['type', 'read', 'raise', 'shoot', 'cheer', 'dance', 'arcade', 'play'].includes(pose);
  // Hands busy: set the cup down on the table (or the seat) and pick it up again after.
  let cupDown = false;
  if (hasCoffee && !holdsCup && !moving && a.spot) {
    if (a.cupSpot !== a.spot) { a.cupSpot = a.spot; const at = cupDownAt(a, a.spot); a.cupDownAt = at;
      if (at) a.cupDown.position.set(at.x - CUP.x, at.y + .05 + a.spot.y + .29, at.z - CUP.z); }   // the cup's bottom sits .05 below its group; the body sits at the seat
    cupDown = !!a.cupDownAt;
  }
  if (holdsCup) { l = moving ? -.5 + Math.sin(t * 9) * .08 : -.45; le = -1.1; }   // forearm up, the cup in front
  if (swivel) {
    if (a.restSpot !== a.spot) { a.restSpot = a.spot; a.rest = armrestAt(a, a.spot); }
    const R = a.rest;
    if (!holdsCup) { l = R.x; lz = R.z + .12; ls = R.s; le = R.e; }   // a held coffee stays in the left hand
    r = R.x; rz = -R.z - .12; rs = R.s; re = R.e;
    tilt = -.24 + Math.sin(t * .5) * .05; bob = 0;   // looking up at nothing in particular
  }
  const sipLeft = holdsCup || a.hasMug;   // sip from the hand that holds something
  let headYaw = 0, sipW = 0;
  if (!moving && ['idle', 'think', 'type', 'read'].includes(pose)) {
    a.fidgetIn = (a.fidgetIn ?? rand(3, 10)) - sdt;
    if (a.fidgetIn <= 0) {
      a.fidget = pick(holdsCup ? ['sip', 'sip', 'look'] : pose === 'type' || pose === 'read' ? ['look', 'sip', 'look'] : ['look', 'stretch', 'sip', 'look']);
      a.fidgetT = 0; a.fidgetIn = holdsCup ? rand(2.5, 6) : rand(6, 16);
    }
  }
  if (a.fidget) {
    const dur = { look: 2.6, stretch: 1.9, sip: 1.7 }[a.fidget];
    a.fidgetT += sdt;
    if (moving || a.fidgetT >= dur || pose === 'raise') a.fidget = null;
    else {
      const w = Math.sin(Math.PI * a.fidgetT / dur);          // eases in and out
      if (a.fidget === 'look') headYaw = Math.sin(a.fidgetT * 2.4) * .75 * w;
      if (a.fidget === 'stretch') { l = r = l + (-3.0 - l) * w; bob += .05 * w; tilt += (-.25 - tilt) * w; }
      if (a.fidget === 'sip') {
        if (holdsCup) { const S = a.reach.sip; l += (S.x - l) * w; lz += (S.z + .12 - lz) * w; ls += (S.s - ls) * w; le += (S.e - le) * w; tilt += (-.08 - tilt) * w; }   // the lid to the lower face
        else { if (sipLeft) l += (-2.0 - l) * w; else r += (-2.0 - r) * w; tilt += (-.18 - tilt) * w; }
        sipW = w;
      }
    }
  }
  // legs swing when walking and point forward when sitting; the body rests on the seat
  const seated = !moving && !!a.spot && a.spot.y > 0;
  let legL = 0, legR = 0;
  if (moving && a.sprint && (a.sprint.skid || a.sprint.hold > 0)) { legL = -.75 * (a.sprint.skid ? 1 : .5); legR = .35; }   // front foot planted ahead
  else if (moving) { legL = Math.sin(t * (a.sprint ? 15 : 9)) * (a.sprint ? .95 : .55); legR = -legL; }
  else if (seated) legL = legR = -1.45;
  else if (pose === 'shoot') { const u = a.shootU || 0; if (u > .36 && u < .46) legL = legR = -.35; }
  a.pelvisY += ((seated ? a.spot.y + .29 : LEG) - a.pelvisY) * (1 - Math.exp(-dt * 10));
  const k = 1 - Math.exp(-dt * 12);
  const A = a.arms; A.lz ??= 0; A.ls ??= 1; A.rs ??= 1; A.le ??= ELBOW_REST; A.re ??= ELBOW_REST;
  A.l += (l - A.l) * k; A.r += (r - A.r) * k; A.rz += (rz - A.rz) * k; A.lz += (lz - A.lz) * k; A.ls += (ls - A.ls) * k; A.rs += (rs - A.rs) * k;
  A.le += (le - A.le) * k; A.re += (re - A.re) * k;
  a.armL.rotation.x = A.l; a.armR.rotation.x = A.r; a.armR.rotation.z = .12 + A.rz; a.armL.rotation.z = -.12 + A.lz;
  for (const [sh, st, bend] of [[a.armL, A.ls, A.le], [a.armR, A.rs, A.re]]) {
    const u = sh.userData; u.elbow.rotation.x = bend;
    // a reach past the arm's length telescopes both halves a little
    u.upper.scale.y = u.fore.scale.y = st; u.upper.position.y = -UPPER * st / 2; u.elbow.position.y = -UPPER * st; u.fore.position.y = -FORE * st / 2; u.hand.position.y = -FORE * st;
  }
  a.legs.l += (legL - a.legs.l) * k; a.legs.r += (legR - a.legs.r) * k; a.hips[0].rotation.x = a.legs.l; a.hips[1].rotation.x = a.legs.r;
  a.tilt += (tilt - a.tilt) * k; a.head.rotation.x = a.tilt; a.head.rotation.y += (headYaw - a.head.rotation.y) * k;
  a.pivot.position.y = a.pelvisY + bob;
  a.lean = (a.lean || 0) + (lean - (a.lean || 0)) * k; a.pivot.rotation.x = a.lean;
  a.carry.visible = carrying;
  if (a.cupDown) a.cupDown.visible = cupDown;
  if (a.coffee) { a.coffee.visible = holdsCup;
    if (holdsCup) a.coffee.quaternion.copy(a.armL.quaternion).multiply(a.armL.userData.elbow.quaternion).invert().multiply(sipTip.setFromAxisAngle(X_AXIS, -.7 * sipW)); }   // upright, tipped toward the face to sip
  a.laptop.visible = !moving && a.busy && !!a.spot && !!a.spot.laptop && pose !== 'raise' && pose !== 'read';
  a.ring.material.color.set(STATUS[a.state].hex);
  const waiting = a.state === 'waiting', lost = !waiting && !!a.stuck && a.busy;
  a.beacon.visible = waiting || lost;
  a.beacon.material.color.set(waiting ? STATUS.waiting.hex : LOST);
  if (lost) { a.beacon.rotation.y += dt * 2.5; a.beacon.position.y = a.beaconY + Math.sin(performance.now() / 300) * .05; }
  if (waiting) { const p = performance.now(); a.beacon.rotation.y += dt * 2.5; a.beacon.scale.setScalar(1 + Math.sin(p / 180) * .18); a.beacon.position.y = a.beaconY + Math.sin(p / 300) * .05;
    const flash = Math.sin(p / 200) > 0 ? STATUS.waiting.hex : sceneT.screenOff; a.lapScreen.color.set(flash);
    if (a.spot && a.spot.screen && !a.gone && a.floor === curFloor) a.spot.screen.color.set(flash); }
  a.lightMat.color.set(waiting && Math.sin(performance.now() / 140) < 0 ? '#5A4420' : STATUS[a.state].hex);
  if (a.antennaMat) a.antennaMat.color.set(STATUS[a.state].hex);
  a.blinkIn -= dt; if (a.blinkIn <= 0) { a.blink = .13; a.blinkIn = rand(2.2, 5); } a.blink = Math.max(0, a.blink - dt);
  a.faceT += dt; if (g.visible && a.faceT > 1 / 12) { a.faceT = 0; drawFace(a); }   // 12 fps is plenty for a face and light on phones/VR
  a.selRing.visible = a === selected;
  if (a === selected) a.selRing.material.color.set(sceneT.dark ? '#FFFFFF' : '#15212A');
  a.label.visible = showLabels && (a.onRoof || viewMode !== 'roof');   // on the roof, hide tags of people working below the deck
  if (a.approval && !a.approval.live && simTime > a.approval.deadline) a.approval.resolve('auto');
  if (a.char && g.visible) poseCharacter(a);
}

/* ---------- camera ---------- */
const cam = { theta:.36, phi:.9, radius:28, target:new THREE.Vector3(0, 0, -.3) };
const goal = { theta:.36, phi:.9, radius:28, target:new THREE.Vector3(0, 0, -.3) };
let view = '3d';
const panel = $('#panel');
const viewAspect = () => { const w = stage.clientWidth, h = stage.clientHeight || 1; return isMobile() ? w / (h * .56) : (w - (appEl.classList.contains('panel-off') ? 0 : panel.offsetWidth) - 32) / h; };
const defaultRadius = () => { const a = viewAspect(); return a < .8 ? 44 : a < 1.3 ? 35 : 29; };
const planRadius = () => { const a = viewAspect(); return a < .8 ? 52 : a < 1.3 ? 40 : 32; };
function setView(v) {
  camera.fov = 40; camera.updateProjectionMatrix();
  viewMode = 'floor'; renderLift();
  view = v; $('#view-3d').setAttribute('aria-pressed', v === '3d'); $('#view-plan').setAttribute('aria-pressed', v === 'plan');
  if (v === 'plan') { goal.phi = .02; goal.theta = 0; goal.radius = planRadius(); goal.target.set(0, 0, 0); }
  else { goal.phi = .9; goal.theta = .36; goal.radius = defaultRadius(); goal.target.set(0, 0, -.3); }
}
/* Reading a war room screen: the camera flies to face it square-on. Agents and chairs sit between the two, so once
   it has arrived the camera stops drawing anything nearer than the screen. */
let zoom = null;                                 // { on, back, theta } while viewMode === 'screen'
// Up close, a screen is framed in the gap the panels leave.
function screenFrame(w, h) {
  if (isMobile()) return { ox: vo.tx, oy: vo.ty, gw: w, gh: h * .5 };
  const L = liftEl.classList.contains('collapsed') ? 16 : liftEl.getBoundingClientRect().right - stage.getBoundingClientRect().left + 16;
  const R = w - (appEl.classList.contains('panel-off') ? 0 : panel.offsetWidth + 16) - 16, T = 72, B = h - 24;
  return { ox: w / 2 - (L + R) / 2, oy: h / 2 - (T + B) / 2, gw: Math.max(200, R - L), gh: B - T };
}
function zoomTo(s) {
  const p = s.mesh.getWorldPosition(new THREE.Vector3()), g = s.mesh.geometry.parameters, t = Math.tan(camera.fov * Math.PI / 360);
  zoom = { on: s, theta: Math.round(cam.theta / (Math.PI * 2)) * Math.PI * 2, back: viewMode === 'screen' ? zoom.back : { theta: goal.theta, phi: goal.phi, radius: goal.radius, target: goal.target.clone() } };
  viewMode = 'screen'; goal.theta = zoom.theta; goal.phi = Math.PI / 2; goal.target.copy(p);
  const h = stage.clientHeight || 1, fr = screenFrame(stage.clientWidth, h);
  goal.radius = Math.max(g.height * h / (2 * t * fr.gh * .94), g.width * h / (2 * t * fr.gw * .96));
  screensDirty = true; renderLift(); refreshBoard();
}
function unzoom() {
  if (viewMode !== 'screen') return;
  viewMode = 'floor'; goal.theta = zoom.back.theta; goal.phi = zoom.back.phi; goal.radius = zoom.back.radius; goal.target.copy(zoom.back.target);
  screensDirty = true; renderLift();
}
function applyCam() {
  const facing = viewMode === 'screen' && Math.abs(cam.theta - zoom.theta) < .04 && Math.abs(cam.phi - Math.PI / 2) < .04 && cam.target.distanceTo(goal.target) < .3;
  const near = facing ? Math.max(.1, cam.radius - .3) : .1;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  const sp = Math.sin(cam.phi);
  camera.position.set(cam.target.x + cam.radius * sp * Math.sin(cam.theta), cam.target.y + cam.radius * Math.cos(cam.phi), cam.target.z + cam.radius * sp * Math.cos(cam.theta));
  camera.lookAt(cam.target);
}
function updateCam(dt) {
  if (flight && !flight.landing) { applyCam(); return; }            // the flight drives the camera itself
  if (viewMode === 'building') goal.target.y = yOff + (floors.length - 1) * FLOOR_H / 2 + 1.7;
  else if (viewMode === 'roof') goal.target.y = yOff + (floors.length - 1) * FLOOR_H + ROOF_Y;
  else if (viewMode !== 'screen') goal.target.y = 0;
  if (follow && selected && !flight && viewMode !== 'screen') { const p = worldPos(selected); goal.target.x += (p.x - goal.target.x) * (1 - Math.exp(-dt * 4)); goal.target.z += (p.z - goal.target.z) * (1 - Math.exp(-dt * 4)); }
  const k = reduced ? 1 : 1 - Math.exp(-dt * 8);
  cam.theta += (goal.theta - cam.theta) * k; cam.phi += (goal.phi - cam.phi) * k; cam.radius += (goal.radius - cam.radius) * k;
  cam.target.lerp(goal.target, k); applyCam();
}
function pan(dx, dy) {
  const s = goal.radius * .0017, th = cam.theta;
  const rx = Math.cos(th), rz = -Math.sin(th), fx = -Math.sin(th), fz = -Math.cos(th);
  goal.target.x = clamp(goal.target.x - dx * s * rx + dy * s * fx, -14, 14);
  goal.target.z = clamp(goal.target.z - dx * s * rz + dy * s * fz, -9, 9);
  if (follow) setFollow(false);
}
