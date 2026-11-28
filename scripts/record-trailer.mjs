#!/usr/bin/env node
// Records the README trailer (dist/trailer.mp4, 720p) from the demo office, in headless Chromium.
// With --social it records the launch cut instead (dist/trailer-social.mp4): square 1080 px for phone feeds,
// about 20 s, opening on a permission request, with the repo link on the end card.
//
//   npm i --no-save playwright-core && npx playwright install chromium-headless-shell
//   node scripts/record-trailer.mjs [--social]     # needs ffmpeg on PATH (or FFMPEG=…)
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
const OUT = join(ROOT, 'dist'), SOCIAL = process.argv.includes('--social');
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.error('Needs playwright-core: npm i --no-save playwright-core && npx playwright install chromium-headless-shell'); process.exit(1); }

/* Runs inside the office page (through eval in its closure), so it can use the page's own functions and state.
   Everything waits on the office's simulated clock (wait), which the recorder advances frame by frame. */
function director(social) {
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
    .tr-end h2{font-size:64px}` : ''}`;
  document.head.appendChild(css);
  const cap = document.createElement('div'); cap.className = 'tr-cap'; document.body.appendChild(cap);
  const cursor = document.createElement('div'); cursor.className = 'tr-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-6.6 1.1L16 21l-3 1.4-3.6-6.9L4 20z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const end = document.createElement('div'); end.className = 'tr-end';
  end.innerHTML = `<h2><svg width="78" height="78" viewBox="0 0 30 30"><rect x="1" y="1" width="28" height="28" rx="8" fill="#F2F5F6"/><rect x="7" y="7" width="6.5" height="6.5" rx="1.8" fill="#3FA7D6"/><rect x="16.5" y="7" width="6.5" height="6.5" rx="1.8" fill="#F25F5C"/><rect x="7" y="16.5" width="6.5" height="6.5" rx="1.8" fill="#59CD90"/><rect x="16.5" y="16.5" width="6.5" height="6.5" rx="1.8" fill="#FAC05E"/></svg>Agent Office</h2>
    <p>A 3D office where your coding agents work</p><p class="tools">Claude Code · Codex · Cursor · Gemini CLI · and more</p>
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

  window.__frame = async dt => {
    __vclock.t += dt * 1000;
    for (const f of ticks.slice()) f(dt);
    step(dt);
    for (let k = 0; k < 10; k++) await null;
    renderer.render(scene, camera);
  };
  window.__ready = () => !!(document.fonts && document.fonts.status === 'loaded');
  window.__rec = true;                             // false while setting a scene up: frames still run, none are kept

  window.__director = social ? socialCut : async () => {
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
    const roofers = agents.filter(a => a.kind === 'main' && a !== max), night0 = nightT; nightT = 1;
    for (const a of roofers) { a.busy = false; setState(a, 'idle', 'Chilling on the roof'); roofGroup.add(a.g); a.onRoof = true; a.spot = ROOF_LIFT; a.appear = 1;
      const s = roofFree().filter(s => s.type === 'dance')[0] || pickRoof(); a.g.position.set(s.x + .01, ROOF_Y, s.z + .01); a.spot = null; s.by = a.id; a.spot = s; a.pose = poseFor(a); }
    nightT = night0;
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
    const roofers = agents.filter(a => a.kind === 'main' && a !== max), night0 = nightT; nightT = 1;
    for (const a of roofers) { a.busy = false; setState(a, 'idle', 'Chilling on the roof'); roofGroup.add(a.g); a.onRoof = true; a.spot = ROOF_LIFT; a.appear = 1;
      const s = roofFree().filter(s => s.type === 'dance')[0] || pickRoof(); a.g.position.set(s.x + .01, ROOF_Y, s.z + .01); a.spot = null; s.by = a.id; a.spot = s; a.pose = poseFor(a); }
    nightT = night0;
    let hour = 19.4; clockHours = () => hour; applyScene('auto');
    stopTweens(); goRoofView(); goal.radius *= .75; goal.theta = .2; updateCam(0); Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target);
    const dusk = dt => { hour = Math.min(20.4, hour + dt * .6); applyScene('auto'); if (hour >= 20.4) ticks.splice(ticks.indexOf(dusk), 1); };
    ticks.push(dusk);
    await wait(2.6);

    caption(''); endWant = 1;
    await wait(3.4);
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
  const page = await browser.newPage({ bypassCSP: true, viewport: SOCIAL ? { width: 800, height: 800 } : { width: 1200, height: 675 }, deviceScaleFactor: SOCIAL ? 1.35 : 1.6 });
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
  await page.evaluate(src => { __vclock.base = performance.now(); __vclock.on = true; window.__ao(src); }, `(${director})(${SOCIAL})`);
  await page.evaluate(() => { window.__director().catch(e => { console.error(e); window.__done = true; }); });
  let n = 0;
  for (let k = 0; k < FPS * 90 && !(await page.evaluate(() => window.__done)); k++) {
    await page.evaluate(dt => window.__frame(dt), 1 / FPS);
    if (!(await page.evaluate(() => window.__rec))) continue;
    await page.screenshot({ path: join(frames, `f${String(n).padStart(5, '0')}.png`) });
    if (n % 60 === 0) process.stdout.write(`\rframe ${n}`);
    n++;
  }
  console.log(`\r${n} frames, ${(n / FPS).toFixed(1)} s`);
} finally {
  await browser?.close(); server.kill();
}

mkdirSync(OUT, { recursive: true });
const ff = (...a) => execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const seq = ['-framerate', String(FPS), '-i', join(frames, 'f%05d.png')];
// README: 720p, since it shows under 900 px wide and the city's lit windows make 1080p twice the size.
// Social: 1080 square, which X and Reddit show full width on a phone.
const name = SOCIAL ? 'trailer-social.mp4' : 'trailer.mp4';
ff(...seq, '-vf', SOCIAL ? 'scale=1080:1080:flags=lanczos' : 'scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', SOCIAL ? '21' : '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, name));
console.log(name, (statSync(join(OUT, name)).size / 1048576).toFixed(1), 'MB');
rmSync(data, { recursive: true, force: true });
