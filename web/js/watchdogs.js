/* ---------- watchdogs: two agents on one file, an agent going in circles, a filling memory ---------- */
const CLASH_MS = 5 * 60 * 1000;                 // two agents edited the same file within this long: they may undo each other's work
const STUCK_AFTER = 3;                          // the same call failed this many times without once working: going in circles
const CTX_WARN = .8;                            // memory this full: warn once that Claude Code will compact it soon
const edits = new Map();                        // file → Map(agent → when it last edited it)
const clashes = [];                             // { a, b, file, at, mesh }
const LOST = '#E5534B';
const clashMat = new THREE.MeshBasicMaterial({ color: LOST, transparent: true, opacity: .8, depthWrite: false });
const clashGeo = new THREE.CylinderGeometry(.03, .03, 1, 6).rotateX(Math.PI / 2);   // along z, so lookAt points it
const fileKey = (a, file) => file.startsWith('/') ? file : `${(a.parent || a).cwd || ''}/${file}`;
const clashesOf = a => clashes.filter(c => c.a === a || c.b === a);
const gone = a => a.gone || a.leaving || a.exiting;
function noteEdit(who, file, replay, now = Date.now()) {
  if (!file) return;
  const key = fileKey(who, file), m = edits.get(key) || new Map();
  edits.set(key, m);
  for (const [o, t] of m) if (gone(o) || now - t > CLASH_MS) m.delete(o);
  m.set(who, Math.max(m.get(who) || 0, now));
  for (const o of m.keys()) if (o !== who) addClash(who, o, file, now, replay);
}
function addClash(a, b, file, now, replay, since = now) {
  if (Date.now() - now > CLASH_MS) return;
  const c = clashes.find(c => c.file === file && (c.a === a && c.b === b || c.a === b && c.b === a));
  if (c) { c.at = Math.max(c.at, now); c.since = Math.min(c.since, since); saveClashes(); return; }
  const mesh = new THREE.Mesh(clashGeo, clashMat); mesh.visible = false; scene.add(mesh);
  clashes.push({ a, b, file, at: now, since, mesh }); uiDirty = true; detailDirty = true; saveClashes();
  for (const x of [a, b]) emit(x, 'SameFile', `${file} · also edited by ${(x === a ? b : a).name}`);
  if (replay) return;
  toast(`${a.name} and ${b.name} are both editing ${file}. They may overwrite each other.`, 'Show me', () => select(a, true), a, 'waiting');
  chime('needs', a.parent || a); nudgeTitle(`⚠ ${a.name} and ${b.name} share a file`);
}
// A red bar between the two agents while they share a file; it goes once the overlap is CLASH_MS old or one leaves.
function updateClashes() {
  const now = Date.now();
  for (let i = clashes.length - 1; i >= 0; i--) {
    const c = clashes[i];
    if (gone(c.a) || gone(c.b) || now - c.at > CLASH_MS) { scene.remove(c.mesh); clashes.splice(i, 1); uiDirty = true; detailDirty = true; continue; }
    const pa = c.a.g.position, pb = c.b.g.position, show = c.a.g.visible && c.b.g.visible && !c.a.onRoof && !c.b.onRoof;
    c.mesh.visible = show; if (!show) continue;
    const len = Math.hypot(pb.x - pa.x, pb.z - pa.z); c.mesh.visible = len > .3;
    c.mesh.position.set((pa.x + pb.x) / 2, 1.75, (pa.z + pb.z) / 2); c.mesh.lookAt(pb.x, 1.75, pb.z); c.mesh.scale.set(1, 1, len);
  }
  clashMat.opacity = .55 + .3 * Math.sin(performance.now() / 260);
}
// The same tool call failing again and again (a test that keeps failing, a build that won't pass) means the agent may be stuck.
// Counts reset when that call works, on a new prompt, and when the agent finishes. Returns how often it had failed before this result.
function noteResult(who, e, replay) {
  const key = `${e.tool || ''}${e.summary ? ' ' + e.summary : ''}`, fails = who.fails || (who.fails = new Map()), before = fails.get(key) || 0;
  if (!e.failed) { fails.delete(key); if (who.stuck && who.stuck.key === key) setStuck(who, null); return before; }
  fails.set(key, before + 1);
  if (before + 1 >= STUCK_AFTER) setStuck(who, { key, n: before + 1, label: e.tool === 'Bash' && e.summary || key }, replay);
  return before;
}
function setStuck(a, v, replay) {
  const was = a.stuck; a.stuck = v; a.pose = poseFor(a); a.labelDirty = true; uiDirty = true; detailDirty = true;
  if (!v || replay || (was && was.key === v.key)) return;
  emit(a, 'GoingInCircles', `${v.label} failed ${v.n} times`);
  toast(`${a.name} may be going in circles: ${v.label} failed ${v.n} times in a row`, 'Show me', () => select(a, true), a, 'waiting');
  chime('needs', a.parent || a); nudgeTitle(`↻ ${a.name} is going in circles`);
}
function unstick(a) { if (a.fails) a.fails.clear(); if (a.stuck) setStuck(a, null); }
const ctxShare = c => c && c.max ? clamp(c.used / c.max, 0, 1) : 0;
const ctxColor = c => { const k = ctxShare(c); return k >= CTX_WARN ? LOST : k >= .5 ? STATUS.waiting.hex : STATUS.done.hex; };
const kTok = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
function setContext(a, c, replay) {
  if (!c || (a.context && a.context.used === c.used && a.context.max === c.max)) return;
  const before = ctxShare(a.context); a.context = c; a.labelDirty = true; if (a === selected) detailDirty = true;
  const k = ctxShare(c);
  if (k < .5) a.ctxWarned = false;
  if (k >= CTX_WARN && before < CTX_WARN && !a.ctxWarned && !replay) {
    a.ctxWarned = true;
    toast(`${a.name}'s memory is ${Math.round(k * 100)}% full. Claude Code will compact it soon and details get summarized.`, 'Show me', () => select(a, true), a, 'waiting');
  }
}

function mainSeat(floor) { return floor.deskSeats.find(d => !d.owner && !d.by) || freeSpots(['hightable', 'stool'], floor)[0] || floor.deskSeats[0]; }
function subSeat(a, type) {
  const fl = a.floor, home = type === 'Plan' ? freeSpots(['meeting'], fl)[0] : null;
  return home || fl.deskSeats.filter(d => !d.by).sort((p, q) => Math.hypot(p.x - a.home.x, p.z - a.home.z) - Math.hypot(q.x - a.home.x, q.z - a.home.z))[0]
              || freeSpots(['hightable', 'stool', 'sofa'], fl)[0] || pick(fl.SPOTS.stool);
}
function liveMain(s, instant) {
  let a = live.byId.get(s.id); if (a && !(a.gone && a.leaving)) return a;   // already out the door: a fresh agent comes in
  const floor = ensureFloor(s.cwd || s.project, s.project, true), isNew = floor !== curFloor && !floorAgents(floor).length;
  const home = mainSeat(floor);
  const saved = loadAgentPrefs(s.cwd);
  const same = agents.filter(x => x.kind === 'main' && x.project.key === s.project).length;
  const fallback = s.project + (same ? ` ${same + 1}` : '');
  const custom = customName(saved, s.project), name = custom || chatName(s.title) || fallback;
  const color = saved.color || PALETTE[hashStr(s.cwd || s.id) % PALETTE.length];
  a = createAgent({ name, kind: 'main', color, home, project: { key: s.project, agent: fallback }, cwd: s.cwd, sessionId: s.id, title: s.title || null, customName: !!custom,
                    entrypoint: s.entrypoint, agentName: s.agent, hostApp: s.app, hostTerm: s.term, hostChat: s.chat, hostT3Thread: s.t3Thread, pref: saved.pref || 'anywhere', look: saved.look ? { ...saved.look, intern: false } : undefined, live: true, subs: new Map(), streak: 0, floor });
  if (isNew && !instant) toast(`${s.project} moved into floor ${floorNum(floor)}`, 'Go there', () => flyToFloor(floor.i));
  home.by = a.id; if (home.type === 'desk') { home.owner = a; deskDirty = true; if (floor === curFloor) home.chairMat.color.set(color); }
  a.ws = home;
  if (instant) { a.spot = home; a.where = 'Own desk'; a.g.position.set(home.x, 0, home.z); a.yaw = a.yawT = yawOf(home.face); a.arrivedAt = 0; }
  else { a.spot = DOOR; a.g.position.set(DOOR.x, 0, DOOR.z); a.yaw = a.yawT = -Math.PI / 2; a.appear = 0; walkTo(a, home).then(() => { a.pose = poseFor(a); }); }
  live.byId.set(s.id, a);
  applyStatus(a, s.status || 'idle', s.activity || 'Session started');
  sendFaces(a);
  buildCustomize(); renderJSON(); setModeLine();
  return a;
}
function liveSub(a, id, type, instant, task) {
  let sub = a.subs.get(id); if (sub && !(sub.gone && sub.leaving)) return sub;
  const fl = a.floor, home = subSeat(a, type);
  sub = createAgent({ name: task || type || 'Subagent', kind: 'sub', agentId: id, subType: type || 'subagent', color: mix(a.color, '#ffffff', .35), home, parent: a, project: a.project, live: true, streak: 0, floor: fl });
  home.by = sub.id; sub.ws = home;
  if (instant) { sub.spot = home; sub.where = PLACE[home.type]; sub.g.position.set(home.x, 0, home.z); sub.yaw = sub.yawT = yawOf(home.face); }
  else { sub.spot = DOOR; sub.g.position.set(DOOR.x, 0, DOOR.z); sub.yaw = sub.yawT = -Math.PI / 2; sub.appear = 0; walkTo(sub, home).then(() => { sub.pose = poseFor(sub); }); }
  a.subs.set(id, sub);
  applyStatus(sub, 'thinking', 'Starting');
  return sub;
}
async function leaveOffice(a, note) {
  if (a.leaving || a.exiting) return; a.exiting = true;
  const t = a.leaveT = (a.leaveT || 0) + 1, off = () => a.leaveT !== t;   // comeBack() bumps leaveT: stop at the next await
  if (a.onRoof) { await Promise.race([leaveRoof(a), wait(20)]); if (off()) return; }
  if (a.subs) for (const sub of a.subs.values()) leaveOffice(sub);
  applyStatus(a, 'done', note || (a.kind === 'sub' ? `Reported back to ${a.parent.name}` : 'Signing off'));
  await wait(1.2); if (off()) return;
  a.gone = true; deskDirty = true;
  if (a.home) { if (a.home.by === a.id) a.home.by = null; if (a.home.owner === a) { a.home.owner = null; if (a.floor === curFloor) a.home.chairMat.color.set(sceneT.chair); } if (a.home.screen && a.floor === curFloor) a.home.screen.color.set(sceneT.screenOff); }
  a.nextSpot = null; await Promise.race([walkTo(a, DOOR), wait(30)]); if (off()) return;   // capped: another walk may take over
  a.leaving = true; await wait(.7);
  removeAgent(a);
  if (a.kind === 'main') { if (live.byId.get(a.sessionId) === a) live.byId.delete(a.sessionId); buildCustomize(); renderJSON(); }
  else if (a.parent) for (const [k, v] of a.parent.subs) if (v === a) a.parent.subs.delete(k);
  setModeLine();
}
// Activity after a leave began (a session that ended and resumed, a subagent let go that got more work): come back to a seat.
// Once at the door (gone and leaving) it finishes leaving, and liveMain/liveSub bring in a fresh agent instead.
function comeBack(a, state, activity) {
  if (!a.exiting || a.gone && a.leaving) return;
  a.leaveT++; a.exiting = a.gone = a.awaitingReview = false; deskDirty = true;
  const h = a.home;
  if (h.by && h.by !== a.id || h.type === 'desk' && h.owner && h.owner !== a) { const n = a.kind === 'main' ? mainSeat(a.floor) : subSeat(a.parent, a.subType); if (a.ws === h) a.ws = n; a.home = n; }
  a.home.by = a.id; if (a.kind === 'main' && a.home.type === 'desk') { a.home.owner = a; if (a.floor === curFloor) a.home.chairMat.color.set(a.color); }
  applyStatus(a, state, activity);
  if (a.dest === DOOR || a.spot === DOOR) place(a, workSpot(a), true);
}

/* ---------- sounds: one soft tone per agent, a little different for each kind of news ---------- */
// Synthesized with Web Audio, so there are no sound files. Browsers only allow audio after you click or type once.
// One plain, low sine tone that fades out (like cheiron-frontend's done sound), so it stays easy on headphones.
const soundOn = () => uiPrefs.sound !== false;
const STEPS = [-3, -2, 0, 2, 3];
// An agent's pitch follows its project and color, so the same agent sounds the same every day: a few notes around 309 Hz.
const pitchOf = a => 309 * 2 ** (STEPS[hashStr(`${a.cwd || a.project.key}|${a.color}`) % STEPS.length] / 12);
let actx = null;
function audio() {
  if (!actx) { const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null; actx = new Ctx(); }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, () => { if (soundOn()) audio(); }, { passive: true }));
function tone(t, freq, vol, len) {
  const o = actx.createOscillator(), v = actx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(vol, t + .015);   // a short fade-in, so it never clicks
  v.gain.exponentialRampToValueAtTime(.001, t + len);
  o.connect(v); v.connect(actx.destination); o.start(t); o.stop(t + len + .02);
}
const lastChime = new Map();
function chime(kind, a, preview) {
  if (!preview && !soundOn()) return;
  const k = `${a.id}:${kind}`, now = performance.now();
  if (!preview && now - (lastChime.get(k) || -1e9) < 4000) return;   // PermissionRequest and Notification both report one prompt
  lastChime.set(k, now);
  if (!audio() || actx.state !== 'running' && !preview) return;
  const f = pitchOf(a), t = actx.currentTime + .03;
  if (kind === 'done') tone(t, f, .2, 1.15);                                                  // one tone
  else if (kind === 'needs') { tone(t, f, .15, .45); tone(t + .2, f * 4 / 3, .17, 1); }      // two, rising: "hey?"
  else if (kind === 'merged') [1, 5 / 4, 3 / 2].forEach((m, i) => tone(t + i * .14, f * m, i === 2 ? .18 : .13, i === 2 ? 1.2 : .5));
}
// While the tab is in the background, its title says who's done or waiting, until you look again.
const baseTitle = document.title, unseen = [];
function nudgeTitle(text) { if (!document.hidden) return; unseen.unshift(text); document.title = `${unseen.length > 1 ? `(${unseen.length}) ` : ''}${text} · ${baseTitle}`; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { unseen.length = 0; document.title = baseTitle; } });
$('#opt-sound').checked = soundOn();
$('#opt-sound').onchange = e => { uiPrefs.sound = e.target.checked; saveUi(); if (e.target.checked) { const a = agents.find(x => x.kind === 'main'); if (a) chime('done', a, true); } };

// A finished subagent stays at its seat until its main agent has come over and looked at the work, like a senior dev
// reading over a junior's shoulder. The main agent lets it go once it moves on (its next tool call, reply or stop).
function queueReview(a, sub) {
  sub.awaitingReview = true; sub.reviewSince = performance.now(); applyStatus(sub, 'done', `Done · waiting for ${a.name}`);
  (a.reviewQ ||= []).push(sub);
  if (!a.review) reviewSubs(a);
}
const reviewLabel = sub => `Reviewing “${sub.name}”`;
async function reviewSubs(a) {
  a.reviewDone = false;
  while (a.reviewQ.length && !a.exiting) {
    const sub = a.reviewQ.shift(); if (!sub.awaitingReview || sub.exiting) continue;
    a.review = sub;
    // Every step is capped: if a walk never arrives (another walk took over), the review still ends.
    for (const t = simTime; a.comingDown && simTime - t < 20;) await wait(.3);
    if (a.onRoof) { a.comingDown = true; await Promise.race([leaveRoof(a), wait(20)]); a.comingDown = false; }
    if (!a.reviewDone && a.state !== 'waiting') applyStatus(a, 'thinking', reviewLabel(sub));
    applyStatus(sub, 'done', `Done · ${a.name} is coming over`);
    await Promise.race([walkTo(a, besideSpot(sub.dest || sub.spot || sub.home)), wait(30)]);
    a.where = `Beside ${sub.name}`; a.pose = poseFor(a);
    if (sub.awaitingReview) applyStatus(sub, 'done', `${a.name} is reviewing the work`);
    const t0 = simTime;
    await wait(REVIEW_MIN_S);
    while (!a.exiting && sub.awaitingReview && !a.reviewDone && !a.reviewQ.length && simTime - t0 < REVIEW_MAX_S) await wait(.25);
    if (sub.awaitingReview) { sub.awaitingReview = false; leaveOffice(sub, `Let go by ${a.name}`); }
  }
  a.review = null;
  if (a.exiting) return;
  // It had already finished (a background subagent reported back later), or nothing new came in: not stuck "Reviewing".
  if (a.reported && (a.reported[0] === 'done' || a.reported[0] === 'idle' || a.activity?.startsWith('Reviewing “'))) applyStatus(a, ...a.reported);
  const next = a.afterReview || workSpot(a); a.afterReview = null;
  place(a, next, true);
}
