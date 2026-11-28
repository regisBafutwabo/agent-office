#!/usr/bin/env node
// Records the README trailer (dist/trailer.mp4, 720p) from the demo office, in headless Chromium.
// With --social it records the launch cut instead (dist/trailer-social.mp4): square 1080 px for phone feeds,
// about 20 s, opening on a permission request, with the repo link on the end card.
// With --pitch it records the status-board cut (dist/trailer-pitch.mp4): square 1080 px, about 28 s, for people who
// run several agents at once. It shows who needs you, the early warnings and Connect agents, and skips the fun.
// With --fun it records the fun cut (dist/trailer-fun.mp4): square 1080 px, about 38 s, for people bored of watching
// an agent work in a terminal. It shows office life (the lift, the library, reactions, interns, breaks, the sprint
// back to the desk, the rooftop party) and has no end card: the post carries the link.
//
//   npm i --no-save playwright-core && npx playwright install chromium-headless-shell
//   node scripts/record-trailer.mjs [--social | --pitch | --fun]     # needs ffmpeg on PATH (or FFMPEG=…)
//   TRAILER_EVERY=15 node scripts/record-trailer.mjs --fun           # a quick draft: keeps one frame in 15
//
// The video stays out of git: drag it into a GitHub comment and put the user-attachments link in the README.
//
// It starts its own office server on a spare port with a throwaway data folder, opens ?demo, and steps the
// office's clock one frame at a time, so the result doesn't depend on how fast this machine renders.
// The director below runs inside the page's own scope and scripts each scene; captions are page overlays.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const FPS = 30, FFMPEG = process.env.FFMPEG || 'ffmpeg';
const OUT = join(ROOT, 'dist'), CUT = ['fun', 'pitch', 'social'].find(c => process.argv.includes('--' + c)) || 'readme', SQUARE = CUT !== 'readme';
const EVERY = Math.max(1, Math.round(+process.env.TRAILER_EVERY) || 1);   // drafts: the office still runs every frame, so the scenes play out the same
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.error('Needs playwright-core: npm i --no-save playwright-core && npx playwright install chromium-headless-shell'); process.exit(1); }

/* Runs inside the office page (through eval in its closure), so it can use the page's own functions and state.
   Everything waits on the office's simulated clock (wait), which the recorder advances frame by frame. */
function director(cut) {
  const pitch = cut === 'pitch', fun = cut === 'fun', social = cut !== 'readme';   // social: the square layout the phone cuts share
  renderer.setAnimationLoop(null);                 // the recorder draws each frame itself
  const ticks = [];
  const css = document.createElement('style');
  css.textContent = `
    #hint,#panel-show{display:none!important}
    .tr-cap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:50;pointer-events:none;white-space:nowrap;
      font:700 40px/1.1 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.01em;color:#fff;
      background:rgba(12,18,22,.80);padding:14px 30px 16px;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0}
    .tr-cap b{color:#FAC05E;font-weight:700}
    .tr-cursor{position:fixed;left:0;top:0;z-index:60;pointer-events:none;width:30px;height:30px;opacity:0;transform-origin:4px 3px}
    .tr-end{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;opacity:0;pointer-events:none;
      background:radial-gradient(ellipse at 50% 40%,rgba(28,39,72,.86),rgba(5,10,24,.95));color:#fff;font-family:"Bricolage Grotesque",system-ui,sans-serif}
    .tr-end h2{margin:0;font:700 72px/1 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.02em;display:flex;align-items:center;gap:22px}
    .tr-end p{margin:0;font:500 28px/1.3 "IBM Plex Sans",system-ui,sans-serif;color:#DDE7EB}
    .tr-end .tools{font-size:21px;color:#9FB2BC}
    .tr-end .url{font:600 26px/1.2 "IBM Plex Mono",ui-monospace,monospace;color:#FAC05E}
    ${social ? `.topbar,#mode-line{display:none!important}
    .tops{top:12px!important;left:12px!important;right:12px!important;max-width:none!important;zoom:1.45}
    .toasts{top:auto!important;bottom:118px!important;right:12px!important;zoom:1.45}
    .tr-cap{font-size:42px;bottom:36px;white-space:normal;text-align:center;width:max-content;max-width:94%}
    .tr-end h2{font-size:64px}` : ''}
    ${pitch ? `.tr-end h2{font-size:44px;gap:16px} .tr-end h2 svg{width:54px;height:54px}
    .tr-end .line{font:700 68px/1.08 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.02em;color:#fff;text-align:center;max-width:90%;margin:6px 0 10px}
    .tr-end .line b{color:#FAC05E;font-weight:700}
    .detail{left:12px!important;top:12px!important;bottom:auto!important;max-height:none!important;zoom:1.45}
    .detail .d-tabs,.detail #d-chat,.detail #d-log,.detail #d-mem,.detail #d-chg,.detail #d-note,.detail #d-close,.lift,.city-credit{display:none!important}
    .panel{top:12px!important;right:12px!important;bottom:auto!important;height:330px;zoom:1.6}` : ''}
    ${fun ? `.toasts,.lift{display:none!important} .tr-cap{font-size:44px}` : ''}`;
  document.head.appendChild(css);
  const cap = document.createElement('div'); cap.className = 'tr-cap'; document.body.appendChild(cap);
  const cursor = document.createElement('div'); cursor.className = 'tr-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-6.6 1.1L16 21l-3 1.4-3.6-6.9L4 20z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const end = document.createElement('div'); end.className = 'tr-end';
  end.innerHTML = `<h2><svg width="78" height="78" viewBox="0 0 30 30"><rect x="1" y="1" width="28" height="28" rx="8" fill="#F2F5F6"/><rect x="7" y="7" width="6.5" height="6.5" rx="1.8" fill="#3FA7D6"/><rect x="16.5" y="7" width="6.5" height="6.5" rx="1.8" fill="#F25F5C"/><rect x="7" y="16.5" width="6.5" height="6.5" rx="1.8" fill="#59CD90"/><rect x="16.5" y="16.5" width="6.5" height="6.5" rx="1.8" fill="#FAC05E"/></svg>Agent Office</h2>
    ${pitch ? '<p class="line">Never miss a <b>blocked agent</b> again</p>' : '<p>A 3D office where your coding agents work</p><p class="tools">Claude Code · Codex · Cursor · Gemini CLI · and more</p>'}
    ${social ? '<p>Free · open source · runs on your Mac</p><p class="url">github.com/regisBafutwabo/agent-office</p>' : ''}`;
  document.body.appendChild(end);

  // Fades: a caption swaps text while hidden; the end card fades in.
  let capWant = '', capShown = '', capO = 0, endO = 0, endWant = 0;
  ticks.push(dt => {
    const target = capWant && capWant === capShown ? 1 : 0;
    capO += Math.sign(target - capO) * Math.min(Math.abs(target - capO), dt / .3);
    if (capO === 0 && capWant !== capShown) { capShown = capWant; cap.innerHTML = capShown; }
    cap.style.opacity = capO; cap.style.transform = `translateX(-50%) translateY(${(1 - capO) * 14}px)`;
    endO += Math.sign(endWant - endO) * Math.min(Math.abs(endWant - endO), dt / .6); end.style.opacity = endO;
  });
  const caption = t => { capWant = t; };

  // Camera moves: ease goal from where it is now to a pose over `s` seconds (updateCam then follows it).
  const ease = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  function camTo(pose, s) {
    const from = { theta: goal.theta, phi: goal.phi, radius: goal.radius, target: goal.target.clone() };
    let t = 0;
    const f = dt => { if (f.dead) return ticks.splice(ticks.indexOf(f), 1); t = Math.min(1, t + dt / s); const k = ease(t);
      goal.theta = from.theta + (pose.theta - from.theta) * k; goal.phi = from.phi + (pose.phi - from.phi) * k; goal.radius = from.radius + (pose.radius - from.radius) * k;
      goal.target.lerpVectors(from.target, pose.target, k); if (t >= 1) ticks.splice(ticks.indexOf(f), 1); };
    ticks.push(f); tweens.push(f);
  }
  const tweens = [], stopTweens = () => tweens.splice(0).forEach(f => { f.dead = true; });
  let orbit = 0; ticks.push(dt => { goal.theta += orbit * dt; });
  const V = (x, z, y = 0) => new THREE.Vector3(x, y, z);

  // Cursor: glide to an element, press, and run `then`.
  function clickEl(el, s, then) {
    const r0 = cursor._p || { x: innerWidth * .62, y: innerHeight * .7 };
    let t = 0;
    const f = dt => { t += dt; const r = el.getBoundingClientRect(), x1 = r.left + r.width * .5, y1 = r.top + r.height * .6, k = ease(Math.min(1, t / s));
      const x = r0.x + (x1 - r0.x) * k, y = r0.y + (y1 - r0.y) * k; cursor._p = { x, y };
      const press = t > s + .15 && t < s + .35 ? .82 : 1;
      cursor.style.opacity = Math.min(1, t / .25); cursor.style.transform = `translate(${x - 4}px,${y - 3}px) scale(${press})`;
      if (t > s + .3 && then) { const g = then; then = null; g(); }
      if (t > s + 1.1) { cursor.style.opacity = Math.max(0, 1 - (t - s - 1.1) / .3); if (t > s + 1.4) ticks.splice(ticks.indexOf(f), 1); } };
    ticks.push(f);
  }

  const F = floors[0], [ada, max] = ['Ada', 'Max'].map(n => agents.find(a => a.name === n));
  const atDesk = (a, label) => { a.busy = true; a.pose = 'type'; setState(a, 'working', label); };
  // Give an agent a desk and put it there. near() is the free desk closest to Ada's.
  const near = () => F.deskSeats.filter(s => !s.by && !s.owner).sort((p, q) => Math.hypot(p.x - ada.home.x, p.z - ada.home.z) - Math.hypot(q.x - ada.home.x, q.z - ada.home.z))[0];
  const sit = (a, home) => { if (a.home) { a.home.by = null; a.home.owner = null; } home.by = a.id; home.owner = a; a.home = a.spot = home; a.where = 'Own desk';
    a.g.position.set(home.x, 0, home.z); a.yaw = a.yawT = yawOf(home.face); a.appear = 1; deskDirty = true; };
  // One floor for the whole video: the demo's agents from other floors move in beside Ada and Max (seats: where, else near Ada).
  const moveIn = (names, seats = []) => { const crew = names.map((n, i) => { const old = agents.find(a => a.name === n), home = seats[i] || near();
      const a = createAgent({ name: n, kind: 'main', color: old.color, home, project: ada.project, floor: F, look: old.look }); sit(a, home); return a; });
    agents.filter(a => a.kind === 'main' && a.floor !== F).forEach(a => { a.home.by = a.home.owner = null; removeAgent(a); }); return crew; };
  // A pose that looks at some agents, with them moved down and right on screen (in metres), clear of the overlays.
  const frame = (list, theta, phi, radius, down = 0, right = 0) => { const t = V(0, 0); list.forEach(a => { t.x += a.home.x / list.length; t.z += a.home.z / list.length; });
    t.x -= Math.sin(theta) * down + Math.cos(theta) * right; t.z -= Math.cos(theta) * down - Math.sin(theta) * right; return { theta, phi, radius, target: t }; };
  const jump = pose => { stopTweens(); Object.assign(goal, { theta: pose.theta, phi: pose.phi, radius: pose.radius }); goal.target.copy(pose.target);
    Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target); };
  // The rooftop after dark: put agents on the terrace, on the dance floor while it has room (it only opens at night).
  const toRoof = list => { const night0 = nightT; nightT = 1;
    for (const a of list) { a.busy = false; setState(a, 'idle', 'Chilling on the roof'); roofGroup.add(a.g); a.onRoof = true; a.spot = ROOF_LIFT; a.appear = 1;
      const s = roofFree().filter(s => s.type === 'dance')[0] || pickRoof(); a.g.position.set(s.x + .01, ROOF_Y, s.z + .01); a.spot = null; s.by = a.id; a.spot = s; a.pose = poseFor(a); }
    nightT = night0; };

  window.__frame = async (dt, draw = true) => {
    __vclock.t += dt * 1000;
    for (const f of ticks.slice()) f(dt);
    step(dt);
    for (let k = 0; k < 10; k++) await null;
    if (draw) renderer.render(scene, camera);
  };
  window.__ready = () => !!(document.fonts && document.fonts.status === 'loaded');
  window.__rec = true;                             // false while setting a scene up: frames still run, none are kept

  window.__director = pitch ? pitchCut : fun ? funCut : social ? socialCut : async () => {
    // Set the stage: everyone at work, a few edits for the review board, Max still in the lift.
    setPanelOpen(false); setLiftOpen(false);
    agents.forEach(a => atDesk(a, 'Working'));
    const edits = [['Ada', ['src/lists/ListView.tsx', 'src/lists/useLists.ts', 'src/api/share.ts']], ['Max', ['src/auth/session.ts', 'tests/auth.test.ts']]];
    edits.forEach(([n, files], i) => { const a = agents.find(x => x.name === n); files.forEach((f, k) => noteWork(a, { tool: 'Edit', summary: f, edit: { ...DEMO_EDITS[(i + k) % DEMO_EDITS.length], more: 0 }, at: Date.now() - (k + 1) * 9000 })); });
    { const near = F.deskSeats.filter(x => !x.by).sort((p, q) => Math.hypot(p.x - ada.home.x, p.z - ada.home.z) - Math.hypot(q.x - ada.home.x, q.z - ada.home.z))[0];
      max.home.by = null; max.home.owner = null; near.by = max.id; near.owner = max; max.home = near; deskDirty = true; }
    max.g.position.set(DOOR.x, 0, DOOR.z); max.spot = DOOR; max.appear = 0; max.yaw = max.yawT = -Math.PI / 2; setState(max, 'working', 'Walking in');
    changeDesk(ada, d => { d = { ...d, dayCount: 16 }; for (let k = 3; k > 0; k--) d = remember(d, 'merge', Date.now() - k * 3 * 864e5); return d; });
    goBuilding(); Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    goal.radius *= .92; orbit = .07;

    // 1. The building, then into a floor where agents arrive.
    caption('Every coding agent gets a desk');
    await wait(2.0);
    orbit = 0; flyToFloor(0);
    await wait(1.6);
    walkTo(max, max.home).then(() => atDesk(max, 'Edit src/auth/session.ts'));
    { const home = F.deskSeats.filter(s => !s.by).sort((p, q) => Math.hypot(p.x - ada.home.x, p.z - ada.home.z) - Math.hypot(q.x - ada.home.x, q.z - ada.home.z))[0];
      const sub = createAgent({ name: 'Explore', kind: 'sub', subType: 'Explore', color: mix(ada.color, '#ffffff', .35), home, parent: ada, project: ada.project, floor: F });
      home.by = sub.id; sub.spot = DOOR; sub.g.position.set(DOOR.x + .6, 0, DOOR.z + .5); sub.yaw = sub.yawT = -Math.PI / 2; sub.appear = 0; sub.busy = true;
      emit(sub, 'SubagentStart', 'Map how sharing works'); setState(sub, 'working', 'Walking in');
      wait(.5).then(() => walkTo(sub, home)).then(() => { sub.pose = 'read'; setState(sub, 'working', 'Read src/api/share.ts'); }); }
    await wait(4.2);

    // 2. Reactions: a long test run passes, a build fails, then finally passes.
    const mid = V(ada.home.x * .45 + max.home.x * .55, ada.home.z * .45 + max.home.z * .55);
    mid.y = 2.5; camTo({ theta: .25, phi: .9, radius: 11, target: mid }, 1.2);
    caption('They react to every command');
    ada.run = { at: Date.now() - 31000 }; setState(ada, 'working', 'Bash npm test');
    await wait(1.4);
    react(max, { kind: 'soot' }, Date.now(), 'npm run build'); max.pose = 'think'; setState(max, 'thinking', 'npm run build failed, rethinking');
    await wait(1.4);
    ada.run = null; react(ada, { kind: 'parcel' }, Date.now(), 'npm test', 42000); setState(ada, 'working', 'npm test passed');
    await wait(1.6);
    max.pose = 'type'; react(max, { kind: 'unstuck', fails: 3 }, Date.now(), 'npm run build'); setState(max, 'working', 'npm run build passed');
    await wait(2.6);

    // 3. A permission request: Max raises a hand, the "Needs you" strip asks, the cursor allows it.
    caption('They raise a hand when they <b>need you</b>');
    camTo({ theta: .3, phi: .95, radius: 12, target: V(max.home.x, max.home.z) }, 1.0);
    max.pose = 'raise'; setState(max, 'waiting', 'Wants to run git push origin feat/auth');
    emit(max, 'Notification', 'Permission needed · Bash git push origin feat/auth');
    askPermission(max, 'Bash', 'git push origin feat/auth').then(() => { max.pose = 'type'; setState(max, 'working', 'Bash git push origin feat/auth'); });
    await wait(1.9);
    await new Promise(res => { const b = document.querySelector('#needs-list [data-act="allow"]'); if (!b) return res(); clickEl(b, 1.0, () => { decide(max, 'allow'); res(); }); });
    await wait(1.0);

    // 4. The war room's review board, then one agent's changes.
    caption('Review what changed, file by file');
    zoomTo(term);
    await wait(3.2);
    unzoom();
    await wait(.2);

    // 5. Desk memories: plant, cups and the knot Max just untangled.
    caption('Desks remember the wins');
    showLabels = false; agents.forEach(a => { if (a.label) a.label.visible = false; });
    const shelf = new THREE.Box3().setFromObject(deskShelves[F.deskSeats.indexOf(ada.home)]).getCenter(new THREE.Vector3());
    const desk = { theta: Math.atan2(-ada.home.face[0], -ada.home.face[1]) + .55, phi: 1.0, radius: 2.8, target: shelf };
    Object.assign(goal, { theta: desk.theta + .25, phi: desk.phi, radius: desk.radius + .5 }); goal.target.copy(desk.target);
    Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    camTo(desk, 3.0);
    await wait(3.0);

    // 6. Dusk falls, the roof party starts.
    caption('After dark, the rooftop party starts');
    showLabels = true;
    toRoof(agents.filter(a => a.kind === 'main' && a !== max));
    let hour = 18.3; clockHours = () => hour; applyScene('auto');
    stopTweens(); goRoofView(); goal.radius *= .8; goal.theta = .2; updateCam(0); Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    const dusk = dt => { hour = Math.min(20.2, hour + dt * .9); applyScene('auto'); if (hour >= 20.2) ticks.splice(ticks.indexOf(dusk), 1); };
    ticks.push(dusk);
    await wait(4.2);

    // End card.
    caption(''); endWant = 1;
    await wait(3.0);
    window.__done = true;
  };

  // The launch cut: what it's for first (a permission, a clash, test runs, diffs), the fun last, then where to get it.
  async function socialCut() {
    setPanelOpen(false); setLiftOpen(false);
    agents.forEach(a => atDesk(a, 'Working'));
    ['src/lists/ListView.tsx', 'src/api/share.ts'].forEach((f, k) => noteWork(ada, { tool: 'Edit', summary: f, edit: { ...DEMO_EDITS[k], more: 0 }, at: Date.now() - (k + 1) * 9000 }));
    noteWork(max, { tool: 'Edit', summary: 'tests/auth.test.ts', edit: { ...DEMO_EDITS[2 % DEMO_EDITS.length], more: 0 }, at: Date.now() - 20000 });
    { const near = F.deskSeats.filter(x => !x.by).sort((p, q) => Math.hypot(p.x - ada.home.x, p.z - ada.home.z) - Math.hypot(q.x - ada.home.x, q.z - ada.home.z))[0];
      max.home.by = null; max.home.owner = null; near.by = max.id; near.owner = max; max.home = near; deskDirty = true;
      max.spot = near; max.g.position.set(near.x, 0, near.z); max.appear = 1; atDesk(max, 'Edit src/auth/session.ts'); }
    // Set up off camera: fly to the floor, then frame Max before the first kept frame.
    window.__rec = false;
    goToFloor(0);
    await wait(.5);
    const onMax = { theta: .3, phi: .9, radius: 5.5, target: V(max.home.x, max.home.z) };
    onMax.target.y = 1.4; stopTweens();
    Object.assign(goal, { theta: onMax.theta, phi: onMax.phi, radius: onMax.radius }); goal.target.copy(onMax.target);
    Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    max.pose = 'raise'; setState(max, 'waiting', 'Wants to run git push origin feat/auth');
    emit(max, 'Notification', 'Permission needed · Bash git push origin feat/auth');
    askPermission(max, 'Bash', 'git push origin feat/auth').then(() => { max.pose = 'type'; setState(max, 'working', 'Bash git push origin feat/auth'); });
    await wait(.4);
    window.__rec = true;

    // 1. A hand goes up; it's allowed from the strip at the top.
    caption(`${agents.filter(a => a.kind === 'main').length} agents running. One <b>needs you</b>.`);
    await wait(2.4);
    await new Promise(res => { const b = document.querySelector('#needs-list [data-act="allow"]'); if (!b) return res(); clickEl(b, .9, () => { decide(max, 'allow'); res(); }); });
    caption('Approve it <b>from the office</b>');
    await wait(1.6);

    // 2. Two agents edit the same file: a red bar joins them.
    // Side on to the line between them, so the bar spans the frame.
    const mid = V(ada.home.x * .5 + max.home.x * .5, ada.home.z * .5 + max.home.z * .5); mid.y = 1.6;
    const across = Math.atan2(max.home.x - ada.home.x, max.home.z - ada.home.z) + Math.PI / 2;
    camTo({ theta: across, phi: .85, radius: 9, target: mid }, 1.0);
    caption('Two agents, <b>one file</b>? You’ll know.');
    noteEdit(ada, 'src/auth/session.ts');
    await wait(.7);
    noteEdit(max, 'src/auth/session.ts');
    await wait(3.0);

    // 3. Test runs at a glance: a fail, a long pass, then a pass after three fails.
    caption('Every test run, at a glance');
    react(max, { kind: 'soot' }, Date.now(), 'npm run build'); max.pose = 'think'; setState(max, 'thinking', 'npm run build failed, rethinking');
    await wait(1.1);
    react(ada, { kind: 'parcel' }, Date.now(), 'npm test', 42000); setState(ada, 'working', 'npm test passed');
    await wait(1.1);
    max.pose = 'type'; react(max, { kind: 'unstuck', fails: 3 }, Date.now(), 'npm run build'); setState(max, 'working', 'npm run build passed');
    await wait(2.0);

    // 4. The war room's review board.
    caption('Every diff, <b>before it lands</b>');
    openReview(ada);
    await wait(.8);
    { const f = document.querySelector('#rv-files button, #rv-files li'); if (f) f.click(); }
    await wait(2.6);
    review.close();

    // 5. Dusk on the roof, briefly.
    caption('And after dark, a rooftop party');
    toRoof(agents.filter(a => a.kind === 'main' && a !== max));
    let hour = 19.4; clockHours = () => hour; applyScene('auto');
    stopTweens(); goRoofView(); goal.radius *= .75; goal.theta = .2; updateCam(0); Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    const dusk = dt => { hour = Math.min(20.4, hour + dt * .6); applyScene('auto'); if (hour >= 20.4) ticks.splice(ticks.indexOf(dusk), 1); };
    ticks.push(dusk);
    await wait(2.6);

    caption(''); endWant = 1;
    await wait(3.4);
    window.__done = true;
  }

  // The pitch cut: the office as a status board. Who needs you, an answer from the office, the early warnings,
  // then how little it takes to set up. No party: every scene is something you'd otherwise have missed.
  async function pitchCut() {
    // Toasts close on a real timer, and a frame takes far longer to record than to play: run timers on the office's clock.
    { const due = []; let ids = 1e6; const clear = window.clearTimeout.bind(window);
      window.setTimeout = (fn, ms = 0, ...a) => { due.push({ id: ++ids, at: __vclock.t + ms, run: () => fn(...a) }); return ids; };
      window.clearTimeout = id => { const i = due.findIndex(d => d.id === id); if (i < 0) clear(id); else due.splice(i, 1); };
      ticks.push(() => { for (const d of due.filter(d => d.at <= __vclock.t)) { due.splice(due.indexOf(d), 1); d.run(); } }); }
    setPanelOpen(false); setLiftOpen(false);
    // Four agents on one floor, each from another tool, as a real office shows them: the demo's own crew, moved in together.
    sit(max, near());
    const [kit, nova] = moveIn(['Kit', 'Nova']);
    const crew = [ada, max, kit, nova];
    [{}, { agentName: 'codex' }, { agentName: 'cursor' }, { entrypoint: 't3-code' }].forEach((tool, i) => Object.assign(crew[i], { live: true, cwd: '~/code/' + ada.project.key, subs: new Map() }, tool));
    [[ada, 'Edit src/api/tasks.ts'], [max, 'Edit src/store/settings.ts'], [kit, 'Bash npm run lint'], [nova, 'Read src/auth/session.ts']].forEach(([a, label]) => atDesk(a, label));
    setContext(ada, { used: 148000, max: 200000 }, true); setContext(nova, { used: 64000, max: 200000 }, true);
    // Set up off camera: fly to the floor, load the tool badges, then frame the whole crew.
    window.__rec = false;
    goToFloor(0); crew.forEach(a => appBadge(a));
    await wait(1.2);
    jump(frame(crew, .3, .8, 12.5, 1.9));
    caption(`Running ${crew.length} agents?<br><b>One is waiting on you.</b>`);
    await wait(.7);
    window.__rec = true;

    // 1. Four agents at work. One stops: its hand goes up and the "needs you" strip names it.
    camTo(frame(crew, .42, .86, 11, 1.9), 4.2);
    await wait(1.3);
    ada.pose = 'raise'; setState(ada, 'waiting', 'Wants to run git push origin feat/due-dates');
    emit(ada, 'Notification', 'Permission needed · Bash git push origin feat/due-dates');
    askPermission(ada, 'Bash', 'git push origin feat/due-dates').then(() => { ada.pose = 'type'; setState(ada, 'working', 'Bash git push origin feat/due-dates'); });
    await wait(2.7);

    // 2. Answered from the strip: no hunting for the right window.
    caption('See who needs you.<br><b>Approve it here.</b>');
    camTo(frame(crew, .48, .88, 9.6, 1.9), 4.0);
    await wait(1.4);
    await new Promise(res => { const b = document.querySelector('#needs-list [data-act="allow"]'); if (!b) return res(); clickEl(b, 1.0, () => { decide(ada, 'allow'); res(); }); });
    await wait(1.5);

    // 3. Early warnings. First, two agents on one file: a red bar joins them and a toast names both.
    caption('Two agents on <b>one file</b>? You’ll know.');
    // From high up, looking along the bar: it shows between their name tags.
    camTo(frame([kit, nova], .3, .62, 8.2, .6), 1.0);
    await wait(.6);
    setState(kit, 'working', 'Edit src/auth/session.ts'); noteEdit(kit, 'src/auth/session.ts');
    await wait(.6);
    setState(nova, 'working', 'Edit src/auth/session.ts'); noteEdit(nova, 'src/auth/session.ts');
    await wait(3.2);

    // Then an agent whose test keeps failing while its memory fills: its card says both.
    $('#toasts').replaceChildren();
    caption('Going in circles? Memory almost full? <b>You’ll know.</b>');
    camTo(frame([ada], .42, .9, 7.2, .75, 1.25), 1.0);
    [max, nova].forEach(a => { a.label.position.y = 99; });   // from here their name tags would cover Ada: lift them out of frame
    for (let k = 0; k < 3; k++) { await wait(.55); ada.pose = 'think'; setState(ada, 'thinking', 'npm test failed, trying again');
      noteResult(ada, { tool: 'Bash', summary: 'npm test', failed: true }); }
    await wait(.5);
    select(ada);
    await wait(1.0);
    setContext(ada, { used: 172000, max: 200000 });
    await wait(3.0);
    [max, nova].forEach(a => { a.label.position.y = a.topY + .5; });

    // 4. Plug and play: Connect agents in Customize, as the Mac app shows it, and one click connects a tool.
    select(null); $('#toasts').replaceChildren();
    caption('Install. Connect. Keep using <b>Claude Code, Codex, Cursor, T3 Code</b>.');
    camTo(frame(crew, .55, .8, 13), 1.4);
    const tools = [['claude-code', 'Claude Code', 'connected'], ['codex', 'Codex', 'connected'], ['cursor', 'Cursor', 'not-connected'], ['antigravity', 'Antigravity', 'not-connected']].map(([id, name, status]) => ({ id, name, status }));
    // The demo has no Connect list of its own, and redraws it empty with the agent list: let it draw this one.
    const draw = renderSetup, list = () => { const was = MODE; MODE = 'live'; draw(); MODE = was; };
    setup.tools = tools; renderSetup = list;
    list(); setPanelOpen(true); $('#panel .tabs [data-tab="custom"]').click();
    $('#connect-title').scrollIntoView({ block: 'start' });
    await wait(.9);
    for (const id of ['cursor', 'antigravity']) {
      await new Promise(res => clickEl(document.querySelector(`[data-connect="${id}"]`), .8, () => { tools.find(t => t.id === id).status = 'connected'; list(); res(); }));
      await wait(.5);
    }
    await wait(2.4);

    caption(''); endWant = 1;
    await wait(4.0);
    window.__done = true;
  }

  // The fun cut: an office is more fun to watch than a terminal. Office life from the lift to the rooftop party, with
  // one short "needs you" beat, and no end card: it ends on the party with the last caption.
  async function funCut() {
    setPanelOpen(false); setLiftOpen(false);
    // Six agents on one floor. Reno's desk faces away from the camera, so his skid into the chair shows.
    // at(): a pose that looks at a point, with it moved `down` the screen (in metres) to leave room for bubbles above.
    const seat = i => F.deskSeats[i];
    const at = (x, z, theta, phi, radius, down = 0) => ({ theta, phi, radius, target: V(x - Math.sin(theta) * down, z - Math.cos(theta) * down) });
    sit(ada, seat(0)); sit(max, seat(1));
    const [kit, nova, iris, reno] = moveIn(['Kit', 'Nova', 'Iris', 'Reno'], [seat(2), seat(9), seat(3), seat(14)]);
    const crew = [ada, max, kit, nova, iris, reno];
    [[ada, 'Edit src/lists/ListView.tsx'], [kit, 'Read src/api/share.ts'], [nova, 'Edit src/api/share.ts'], [iris, 'Bash npm run lint'], [reno, 'Edit src/lists/useLists.ts']].forEach(([a, label]) => atDesk(a, label));
    // A jump cut: a walk goes on from `left` metres before its end, so a long trip across the floor takes two short shots.
    const skipTo = (a, left) => { let over = pathLeft(a) - left; const p = a.g.position;
      while (over > 0 && a.path.length) { const v = a.path[0], d = Math.hypot(v.x - p.x, v.y - p.z);
        if (d > over) { p.x += (v.x - p.x) * over / d; p.z += (v.y - p.z) * over / d; break; }
        p.x = v.x; p.z = v.y; over -= d; if (a.path.length > 1) a.path.shift(); else break; } };
    // Done with its task: off to a break spot, as the demo's own agents go.
    const toBreak = (a, s) => { a.busy = false; a.pose = 'idle'; a.cafe = s.type === 'stool' ? s : null; setState(a, 'done', `Heading to the ${PLACE[s.type].toLowerCase()}`);
      return walkTo(a, s).then(() => { a.pose = poseFor(a); setState(a, 'idle', IDLE_ACTIVITY[s.type]); }); };
    const free = type => F.SPOTS[type].filter(s => !s.by);
    window.__rec = false;
    goToFloor(0);
    await wait(1.0);
    jump(at(9.6, -1.6, -.75, 1.0, 12));
    caption('Bored of watching your agents<br>in a terminal?');
    await wait(.5);
    window.__rec = true;

    // 1. The hook. Max rides up in the lift and walks to his desk, where the others are at work.
    max.g.position.set(DOOR.x, 0, DOOR.z); max.spot = DOOR; max.appear = 0; max.yaw = max.yawT = -Math.PI / 2; max.busy = true; setState(max, 'working', 'Walking in');
    emit(max, 'SessionStart', '~/Documents/' + max.project.key);
    walkTo(max, max.home).then(() => atDesk(max, 'Edit src/auth/session.ts'));
    camTo(at(8.4, -1.8, -.7, 1.0, 11), 2.6);
    await wait(2.6);
    skipTo(max, 4);
    jump(frame([ada, max, kit], .3, .9, 13, 2)); camTo(frame([ada, max, kit], .34, .9, 12, 2), 2.4);
    caption('Watch them work instead.');
    await wait(2.4);

    // 2. Working life. Kit has files to read and walks to the library.
    caption('Lots to read? Off to the <b>library</b>.');
    setState(kit, 'working', '→ Library: Read');
    walkTo(kit, free('library').sort((p, q) => Math.abs(p.x - kit.home.x) - Math.abs(q.x - kit.home.x))[0]).then(() => { kit.pose = 'read'; setState(kit, 'working', 'Read src/api/share.ts'); });
    camTo(at(-6.4, -6.6, .3, .95, 9, 1.5), 1.2);
    await wait(2.6);

    // A long test run: a thought cloud counts the seconds. It fails (soot), then at last it passes (confetti).
    caption('Long test run? They sweat it out.');
    camTo(frame([ada, max], .25, .95, 9, 2.6, 1.5), 1.0);
    ada.run = { at: Date.now() - 27400 }; setState(ada, 'working', 'Bash npm test');
    await wait(2.3);
    caption('Tests fail…');
    ada.run = null; react(ada, { kind: 'soot' }, Date.now(), 'npm test'); ada.pose = 'think'; setState(ada, 'thinking', 'npm test failed, rethinking');
    await wait(1.8);
    caption('…then pass. <b>Finally!</b>');
    ada.pose = 'type'; react(ada, { kind: 'unstuck', fails: 3 }, Date.now(), 'npm test'); setState(ada, 'working', 'npm test passed');
    await wait(2.5);

    // 3. Subagents: two interns walk in and sit beside Nova. When one is done, Nova walks over to review its work.
    // Meanwhile the agents that finished head off on a break.
    caption('Subagents show up as <b>interns</b>');
    const subs = [[seat(8), 'Map how sharing works', 3.6], [seat(10), 'Find the flaky test', 5.6]].map(([home, task, left]) => {
      const sub = createAgent({ name: 'Explore', kind: 'sub', subType: 'Explore', color: mix(nova.color, '#ffffff', .35), home, parent: nova, project: nova.project, floor: F });
      home.by = sub.id; sub.spot = DOOR; sub.g.position.set(DOOR.x, 0, DOOR.z); sub.yaw = sub.yawT = -Math.PI / 2; sub.busy = true;
      emit(sub, 'SubagentStart', task); setState(sub, 'working', 'Walking in');
      walkTo(sub, home).then(() => { sub.pose = 'type'; setState(sub, 'working', 'Grep "shareList"'); }); skipTo(sub, left); return sub; });
    nova.pose = 'think'; setState(nova, 'working', 'Waiting on Explore subagent');
    jump(at(-9.2, 1.15, .3, .95, 11, 2.4)); camTo(at(-9.8, 1.15, .26, .95, 10, 2.4), 5);
    const stools = free('stool').sort((p, q) => p.x - q.x);
    toBreak(iris, stools[0]); toBreak(max, stools[1]); toBreak(kit, stools[2]); toBreak(reno, free('coffee')[0]);
    await wait(2.5);
    caption('Done? The boss comes over to <b>review</b>.');
    const [intern] = subs;
    intern.busy = false; intern.pose = 'idle'; setState(intern, 'done', `Done · ${nova.name} is coming over`); emit(intern, 'SubagentStop', `Returned findings to ${nova.name}`);
    setState(nova, 'thinking', 'Reviewing “Map how sharing works”');
    walkTo(nova, besideSpot(intern.home)).then(() => { nova.pose = 'think'; nova.where = `Beside ${intern.name}`; setState(intern, 'done', `${nova.name} is reviewing the work`); });
    toBreak(ada, free('hoops')[0]);
    await wait(2.7);

    // 4. Breaks: coffee and a chat at the café counter, then the basketball machine and the arcade.
    caption('Done for now? <b>Coffee and gossip.</b>');
    skipTo(iris, 0); skipTo(max, .5); skipTo(kit, 3); skipTo(reno, 0);
    setState(intern, 'done', `Let go by ${nova.name}`); intern.gone = true; intern.home.by = null;
    walkTo(intern, DOOR).then(() => { intern.leaving = true; return wait(.7); }).then(() => removeAgent(intern));
    toBreak(nova, free('arcade')[0]);
    showLabels = false;                                        // from here to the desk again: the tags would cover the chat and the run
    jump(at(9.9, -5.2, -.5, 1.0, 9.4, 2)); camTo(at(9.9, -5.2, -.4, 1.0, 8.8, 2), 2.5);
    await wait(2.5);
    caption('Or hoops. Or the arcade.');
    skipTo(ada, 0); skipTo(nova, 0);
    jump(at(-5.6, 7.3, 1.6, .9, 11.5)); camTo(at(-5.9, 7.3, 1.55, .9, 10.8), 2.1);
    await wait(2.1);

    // 5. Called back from a break: a new prompt comes in, and Reno sprints from the coffee bar to his desk and skids
    // into the chair. The camera stays on him. It starts on the side that the café's neon sign doesn't cover, moves
    // round so the focus booths don't hide him, then swings back to see the lean from the side and the skid.
    caption('Call one back…');
    let TH = -.5; const chase = dt => { goal.theta = TH; const p = reno.g.position, k = 1 - Math.exp(-dt * 10);
      goal.target.x += (p.x - Math.sin(TH) * 1.6 - goal.target.x) * k; goal.target.z += (p.z - Math.cos(TH) * 1.6 - goal.target.z) * k; };
    jump(at(reno.g.position.x, reno.g.position.z, TH, .95, 9, 1.6)); ticks.push(chase);
    await wait(1.0);
    { const idleAt = reno.spot;                                // the same steps as a real prompt (UserPromptSubmit in events.js)
      emit(reno, 'UserPromptSubmit', '"Fix the flaky login test" · from you');
      applyStatus(reno, 'thinking', 'Fix the flaky login test'); place(reno, reno.home, true); sprintBack(reno, idleAt); }
    { let t = 0; const swing = dt => { t += dt; TH = -.5 - .5 * ease(clamp((t - .3) / .9, 0, 1)) + 1.5 * ease(clamp((t - 1.9) / 1, 0, 1)); if (t > 2.9) ticks.splice(ticks.indexOf(swing), 1); }; ticks.push(swing); }
    await wait(.8);
    caption('…it <b>sprints</b> to its desk');
    for (let k = 0; k < 60 && reno.spot !== reno.home; k++) await wait(.1);
    atDesk(reno, 'Read tests/login.test.ts');
    await wait(.9);
    ticks.splice(ticks.indexOf(chase), 1); showLabels = true;

    // 6. The one status beat: a hand goes up and the "needs you" strip names him. Seen from the other side, for his face.
    caption('Need you? <b>A hand goes up.</b>');
    subs[1].label.position.y = 99;                             // from behind the desks its name tag would fill the foreground
    jump(at(reno.home.x, reno.home.z, 2.75, .95, 8.5, 2)); camTo(at(reno.home.x, reno.home.z, 2.85, .95, 7.8, 2), 2.5);
    reno.pose = 'raise'; setState(reno, 'waiting', 'Wants to run git push origin fix/login');
    emit(reno, 'Notification', 'Permission needed · Bash git push origin fix/login');
    askPermission(reno, 'Bash', 'git push origin fix/login').then(() => { reno.pose = 'type'; setState(reno, 'working', 'Bash git push origin fix/login'); });
    await wait(2.5);

    // 7. Night on the rooftop: the DJ plays, the crew dances and the city is lit. The video ends here.
    decide(reno, 'allow');
    caption('After dark: the <b>rooftop party</b>');
    showLabels = false;                                        // six name tags would cover the dance floor
    crew.forEach(a => { a.path = []; a.arrive = null; a.sprint = null; a.cafe = null; a.bubKind = null; if (a.spot && a.spot.by === a.id && a.spot !== a.home) a.spot.by = null; });
    toRoof(crew);
    let hour = 19.5; clockHours = () => hour; applyScene('auto');
    const dusk = dt => { hour = Math.min(20.3, hour + dt * .5); applyScene('auto'); if (hour >= 20.3) ticks.splice(ticks.indexOf(dusk), 1); };
    ticks.push(dusk);
    stopTweens(); goRoofView(); Object.assign(goal, { theta: .55, phi: 1.2, radius: 14 }); goal.target.set(-1.3, 0, -1.6); updateCam(0);
    Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    orbit = .04;
    await wait(2.4);
    caption('Your agents, <b>finally fun to watch.</b>');
    await wait(3.2);
    window.__done = true;
  }
}

const port = await new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const data = mkdtempSync(join(tmpdir(), 'agent-office-trailer-')), frames = join(data, 'frames'); mkdirSync(frames);
const server = spawn(process.execPath, [join(ROOT, 'bridge/server.js')], { env: { ...process.env, AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_DATA: data }, stdio: 'ignore' });
let browser;
try {
  await new Promise(r => setTimeout(r, 1500));
  // Headless only, with software WebGL: no window ever opens.
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ bypassCSP: true, viewport: SQUARE ? { width: 800, height: 800 } : { width: 1200, height: 675 }, deviceScaleFactor: SQUARE ? 1.35 : 1.6 });
  page.on('pageerror', e => console.error('page error:', e.message));
  // Let the director reach into the page's scope, and keep the demo agents still until it moves them.
  // boot.js is the last script, so an eval there sees every script's top-level names.
  await page.route(u => u.pathname === '/js/boot.js', async route => {
    const r = await route.fetch(), src = await r.text();
    const hook = 'window.agentOffice = { agents, SPOTS, DOOR, camera };', loops = "agents.filter(a => a.kind === 'main').forEach(mainLoop);";
    if (!src.includes(hook) || !src.includes(loops)) throw new Error('web/js/boot.js changed: update the trailer hooks');
    route.fulfill({ response: r, body: src.replace(hook, '$& window.__ao = s => eval(s);').replace(loops, '') });
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-office:ui', JSON.stringify({ guideDone: true, crew: 'robots', city: 'gangnam', theme: 'loft', lift: false, panel: false }));
    let seed = 7; Math.random = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    // A clock the recorder advances: animations keyed to performance.now() or Date.now() keep pace with the frames.
    const real = performance.now.bind(performance), d0 = Date.now() - real();
    window.__vclock = { on: false, base: 0, t: 0 };
    performance.now = () => __vclock.on ? __vclock.base + __vclock.t : real();
    Date.now = () => Math.round(d0 + performance.now());
  });
  await page.goto(`http://127.0.0.1:${port}/?demo`);
  await page.waitForFunction(() => window.__ao && window.agentOffice.agents.length >= 6, null, { timeout: 60000 });
  await page.waitForTimeout(4000);                                  // city tiles and fonts
  await page.evaluate(src => { __vclock.base = performance.now(); __vclock.on = true; window.__ao(src); }, `(${director})(${JSON.stringify(CUT)})`);
  await page.evaluate(() => { window.__director().catch(e => { console.error(e); window.__done = true; }); });
  let n = 0;
  for (let k = 0; k < FPS * 90 && !(await page.evaluate(() => window.__done)); k++) {
    await page.evaluate(([dt, draw]) => window.__frame(dt, draw), [1 / FPS, k % EVERY === 0]);
    if (!(await page.evaluate(() => window.__rec)) || k % EVERY) continue;
    await page.screenshot({ path: join(frames, `f${String(n).padStart(5, '0')}.png`) });
    if (n % 60 === 0) process.stdout.write(`\rframe ${n}`);
    n++;
  }
  console.log(`\r${n} frames, ${(n * EVERY / FPS).toFixed(1)} s`);
} finally {
  await browser?.close(); server.kill();
}

mkdirSync(OUT, { recursive: true });
const ff = (...a) => execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const seq = ['-framerate', String(FPS / EVERY), '-i', join(frames, 'f%05d.png')];
// README: 720p, since it shows under 900 px wide and the city's lit windows make 1080p twice the size.
// Social: 1080 square, which X and Reddit show full width on a phone.
const name = CUT === 'readme' ? 'trailer.mp4' : `trailer-${CUT}.mp4`;
ff(...seq, '-vf', SQUARE ? 'scale=1080:1080:flags=lanczos' : 'scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', SQUARE ? '21' : '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, name));
console.log(name, (statSync(join(OUT, name)).size / 1048576).toFixed(1), 'MB');
rmSync(data, { recursive: true, force: true });
