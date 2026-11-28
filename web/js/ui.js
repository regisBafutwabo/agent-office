/* ---------- input ---------- */
const ptrs = new Map(); let moved = 0, panMode = false, pinch = null;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function screenAt(cx, cy) {
  if (view !== '3d' || !onFloor() || flight || renderer.xr.isPresenting) return null;
  const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera); const h = ray.intersectObjects([term.mesh, board.mesh], false)[0];
  return h ? { on: h.object === term.mesh ? term : board, y: (1 - h.uv.y) * (h.object === term.mesh ? term : board).c.height } : null;
}
function agentAt(cx, cy) {
  const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera); const h = ray.intersectObjects(pickables, false);
  for (const x of h) { const a = agents.find(y => y.id === x.object.userData.agentId); if (a && (a.onRoof ? roofGroup.visible : a.floor === curFloor)) return a; }
  return null;
}
const hint = $('#hint'); let hintGone = false;
const hideHint = () => { if (!hintGone) { hintGone = true; hint.classList.add('gone'); } };
canvas.addEventListener('pointerdown', e => {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {} ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) { moved = 0; panMode = e.button === 2 || e.shiftKey || view === 'plan'; }
  if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 }; }
  hideHint();
});
let hoverT = 0;
canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId);
  if (!p) { const now = performance.now(); if (e.pointerType === 'mouse' && now - hoverT > 80) { hoverT = now; canvas.style.cursor = agentAt(e.clientX, e.clientY) || screenAt(e.clientX, e.clientY) ? 'pointer' : 'grab'; } return; }
  // the pointerup can be lost when focus moves to another window or monitor mid-drag
  if (e.pointerType === 'mouse' && e.buttons === 0) { dropPtrs(); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  if (ptrs.size === 1) {
    if (panMode) pan(dx, dy); else { goal.theta -= dx * .006; goal.phi = clamp(goal.phi - dy * .005, .3, cityKey !== 'generic' ? 1.54 : 1.38); }
  } else if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    goal.radius = clamp(goal.radius * pinch.d / Math.max(d, 1), 7, 150); pan(mx - pinch.mx, my - pinch.my);
    pinch = { d, mx, my }; moved += 10;
  }
});
function endPtr(e) {
  if (ptrs.size === 1 && moved < 6 && e.type === 'pointerup') { const s = screenAt(e.clientX, e.clientY), a = viewMode === 'screen' ? null : agentAt(e.clientX, e.clientY);
    if (viewMode === 'screen') {                                    // up close: a row opens that agent's changes, anywhere off the screens goes back
      const row = s && s.on === zoom.on && (s.on.rows || []).find(r => s.y >= r.y0 && s.y < r.y1);
      if (!s) unzoom(); else if (s.on !== zoom.on) zoomTo(s.on); else if (row) openReview(row.m);
    } else if (a) select(a, true); else if (s) zoomTo(s.on);
    else { const f = floorAt(e.clientX, e.clientY); if (f && (f !== curFloor || viewMode === 'building')) flyToFloor(f.i); else select(null); } }
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
}
function dropPtrs() { ptrs.clear(); pinch = null; }
canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
addEventListener('blur', dropPtrs); document.addEventListener('visibilitychange', dropPtrs);
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => { e.preventDefault(); goal.radius = clamp(goal.radius * (1 + e.deltaY * .0012), 7, 150); hideHint(); }, { passive:false });
const keys = new Set();
addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select,dialog')) return;
  if (e.key === 'Escape') {
    if (appEl.classList.contains('wall')) setWall(false);
    if (viewMode === 'screen') unzoom(); else select(null);
  }
  if (e.key === '[') setLiftOpen(liftEl.classList.contains('collapsed'));
  if (e.key === ']') setPanelOpen(!panelOpen());
  if (e.key === '\\') { const show = liftEl.classList.contains('collapsed') && !panelOpen(); setLiftOpen(show); setPanelOpen(show); }
  if (e.target.closest('.panel,.detail,.lift,.toasts,[role=tablist]')) return;   // let focused lists scroll and tabs take arrows
  if (e.key === 'PageUp') { goToFloor(Math.min(floors.length - 1, curFloor.i + 1)); e.preventDefault(); }
  if (e.key === 'PageDown') { goToFloor(Math.max(0, curFloor.i - 1)); e.preventDefault(); }
  const k = e.key.toLowerCase(); if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)) { keys.add(k); e.preventDefault(); hideHint(); }
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
function keyPan(dt) {
  if (!keys.size) return; const v = 420 * dt; let dx = 0, dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx += v; if (keys.has('d') || keys.has('arrowright')) dx -= v;
  if (keys.has('w') || keys.has('arrowup')) dy += v; if (keys.has('s') || keys.has('arrowdown')) dy -= v;
  pan(dx, dy);
}

/* ---------- UI ---------- */
document.querySelectorAll('[role=tablist]').forEach(tl => tl.addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...tl.querySelectorAll('[role=tab]')].filter(t => !t.hidden), i = tabs.indexOf(document.activeElement); if (i < 0) return;
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[n].focus(); tabs[n].click(); e.preventDefault();
}));
document.querySelectorAll('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => {
  const was = b.getAttribute('aria-selected') === 'true';
  if (isMobile() && was) { panel.classList.toggle('collapsed'); layout(); return; }
  panel.classList.remove('collapsed');
  document.querySelectorAll('.tabs [role=tab]').forEach(x => x.setAttribute('aria-selected', x === b));
  ['agents','feed','custom'].forEach(k => $('#tab-' + k).hidden = k !== b.dataset.tab);
  layout();
}));
$('#view-3d').onclick = () => setView('3d'); $('#view-plan').onclick = () => setView('plan');
function setSpeed(v) { speed = v; document.querySelectorAll('[data-speed]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.speed === v)); }
document.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => setSpeed(+b.dataset.speed));

const rosterEl = $('#roster');
// pointerdown so a click still lands when the list re-renders mid-press; click covers keyboard
const rosterPick = e => { const op = e.target.closest('[data-open]');
  if (op) { if (e.type === 'click') openHost(agents.find(a => a.id === op.dataset.open)); return; }   // the ↗ on a row: jump to the chat, don't select
  const fr = e.target.closest('.floor-row'); if (fr) { if (e.type === 'click') flyToFloor(+fr.dataset.floor); return; }
  const b = e.target.closest('.agent-row'); if (b) select(agents.find(a => a.id === b.dataset.id), true); };
const liftPick = e => { const b = e.target.closest('.lift-btn'); if (!b) return; if (b.dataset.floor === 'building') goBuilding(); else if (b.dataset.floor === 'roof') goRoofView(); else flyToFloor(+b.dataset.floor); };
$('#lift-list').addEventListener('click', liftPick);
rosterEl.addEventListener('pointerdown', rosterPick); rosterEl.addEventListener('click', rosterPick);
const OPEN_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 3h7v7M13 3 5.5 10.5M11 13H3V5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// The status pill already says "Thinking" or "Working"; an activity that only repeats it adds nothing.
const activityText = a => a.activity === STATUS[a.state].label ? '' : a.activity;
function row(a) {
  const sub = a.kind === 'sub';
  const cl = clashesOf(a)[0], flag = a.stuck && a.busy ? '↻ Going in circles · ' : cl ? `⚠ Same file as ${(cl.a === a ? cl.b : cl.a).name} · ` : '';
  const act = flag + (a.where ? a.where + (activityText(a) ? ' · ' : '') : '') + activityText(a) + (a.pending.length ? ` · ${a.pending.length} queued` : '');
  // The group header already names the project; a subagent's type is only worth showing when it isn't its name.
  // Where a live session runs leads the second line, so a long name never pushes it out of sight.
  const meta = sub && a.subType && a.subType !== a.name ? esc(a.subType) : '';
  const from = !sub && a.live ? `<span class="entry">${esc(whereFrom(a))}</span> · ` : '';
  const open = !sub && a.live && hostName(a) ? esc(openLabel(a)) : '';
  return `<div class="row-wrap"><button class="agent-row${sub ? ' sub' : ''}${a === selected ? ' sel' : ''}" data-id="${a.id}">
    <span class="av" style="--c:${a.color}">${faceImg(a)}${a.live ? appBadge(a, 'av-app') : ''}</span>
    <span class="who"><span class="nm"><span class="nm-t" title="${esc(a.name)}">${esc(a.name)}</span>${meta ? ` <span class="proj">${meta}</span>` : ''}</span><span class="act">${from}${esc(act)}</span></span>
    <span class="row-end"><span class="pill s-${a.state}">${STATUS[a.state].label}</span>${open ? '<span class="row-slot"></span>' : ''}</span></button>${open ? `<button class="row-open" data-open="${a.id}" title="${open}" aria-label="${open}">${OPEN_ICON}</button>` : ''}</div>`;
}
// Which tool an agent runs in, for "By tool": the Claude app, the terminal, T3 Code, Codex, Cursor…
function toolGroup(a) {
  const s = a.parent || a;
  if (viaT3(s)) return 'T3 Code';
  if (AGENT_NAMES[s.agentName]) return AGENT_NAMES[s.agentName];
  return { desktop: 'Claude app', terminal: 'Claude Code · terminal', sdk: 'Claude Code · SDK' }[s.entrypoint] || 'Claude Code';
}
const groupBy = () => uiPrefs.group === 'tool' ? 'tool' : 'project';
function setGroupBy(g) { uiPrefs.group = g; saveUi(); document.querySelectorAll('#roster-group button').forEach(b => b.setAttribute('aria-pressed', b.dataset.group === g)); rosterEl._html = null; uiDirty = true; }
$('#roster-group').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setGroupBy(b.dataset.group); });
const familyRows = m => row(m) + agents.filter(s => s.parent === m).map(row).join('');
function rosterHtml(mains) {
  if (groupBy() === 'tool') {
    const groups = new Map();
    for (const m of mains) { const g = toolGroup(m); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
    return [...groups].sort((x, y) => x[0].localeCompare(y[0])).map(([g, ms]) =>
      `<div class="group-row"><b>${esc(g)}</b><span class="fl-meta">${ms.length} agent${ms.length === 1 ? '' : 's'}</span></div>` + ms.map(familyRows).join('')).join('');
  }
  return floors.slice().reverse().map(f => {
    const ms = mains.filter(m => m.floor === f); if (!ms.length) return '';
    return `<button class="floor-row${f === curFloor ? ' on' : ''}" data-floor="${f.i}"><b>${esc(f.name)}</b>${floorNews(f)}<span class="fl-meta">Floor ${floorNum(f)}</span></button>`
      + ms.map(familyRows).join('');
  }).join('');
}

/* "Needs you": every agent waiting on you, from any tool, oldest first, answerable right here where the tool allows. */
const needsEl = $('#needs'), needsList = $('#needs-list');
const ago = ms => { const s = Math.max(0, (Date.now() - ms) / 1000 | 0); return s < 60 ? `${s}s` : s < 3600 ? `${s / 60 | 0}m` : `${s / 3600 | 0}h`; };
function renderNeeds() {
  const list = agents.filter(a => a.state === 'waiting' && !a.gone).sort((x, y) => (x.waitingSince || 0) - (y.waitingSince || 0));
  const html = list.map(a => {
    const s = a.parent || a, from = s.live ? whereFrom(s) : 'Demo', floor = (s.floor && s.floor.name) || '';
    const acts = a.approval ? `<button class="btn sm primary" data-act="allow" data-id="${a.id}">Allow</button><button class="btn sm" data-act="deny" data-id="${a.id}">Deny</button>`
      : s.live && hostName(a) ? `<button class="btn sm primary" data-act="open" data-id="${a.id}">${esc(openLabel(a))}</button>` : '';
    return `<div class="need"><span class="av" style="--c:${a.color}">${faceImg(a)}${s.live ? appBadge(a, 'av-app') : ''}</span>
      <span class="need-who"><b>${esc(a.name)}</b><span>${esc(from)}${floor ? ' · ' + esc(floor) : ''}</span><span class="need-what" title="${esc(a.activity || '')}">${esc(a.activity || 'Waiting for you')}</span></span>
      <span class="need-age" title="Waiting this long">${a.waitingSince ? ago(a.waitingSince) : ''}</span>
      <span class="need-acts">${acts}<button class="btn sm ghost" data-act="show" data-id="${a.id}">Show</button></span></div>`;
  }).join('');
  needsEl.hidden = !list.length;
  $('#needs-title').textContent = list.length === 1 ? '1 agent needs you' : `${list.length} agents need you`;
  if (html !== needsList._html) { needsList.innerHTML = html; needsList._html = html; }
  fitTops();
}
function fitTops() {
  const shown = !needsEl.hidden || !$('#recap').hidden;
  appEl.classList.toggle('has-needs', shown);
  document.documentElement.style.setProperty('--needs-h', shown ? $('#tops').offsetHeight + 'px' : '0px');
}
needsList.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return; const a = agents.find(x => x.id === b.dataset.id); if (!a) return;
  if (b.dataset.act === 'allow' || b.dataset.act === 'deny') decide(a, b.dataset.act);
  else if (b.dataset.act === 'open') openHost(a);
  else { if (appEl.classList.contains('wall')) setWall(false); select(a, true); }
});
setInterval(() => { if (!needsEl.hidden) { needsList._html = null; renderNeeds(); } }, 15000);   // keep the wait times fresh

/* Wall mode: nothing but the building, the "needs you" strip and a big status light per agent, full screen. */
const WALL_ORDER = { waiting: 0, working: 1, thinking: 2, done: 3, idle: 4 };
function renderWall() {
  if (!appEl.classList.contains('wall')) return;
  const mains = agents.filter(a => a.kind === 'main' && !a.gone).sort((x, y) => WALL_ORDER[x.state] - WALL_ORDER[y.state]);
  const html = mains.map(a => { const subs = agents.filter(s => s.parent === a).length;
    return `<div class="wall-tile glass s-${a.state}" style="--c:${STATUS[a.state].hex}"><span class="light" aria-hidden="true"></span><span class="wt"><b>${esc(a.name)}</b><span>${STATUS[a.state].label} · ${esc(a.live ? toolGroup(a) : 'Demo')}${subs ? ` · ${subs} subagent${subs === 1 ? '' : 's'}` : ''}</span></span></div>`; }).join('')
    || '<div class="wall-tile glass"><span class="wt"><b>No agents yet</b><span>They show up here as soon as one starts</span></span></div>';
  const bar = $('#wall-bar'); if (html !== bar._html) { bar.innerHTML = html; bar._html = html; }
}
function setWall(on) {
  appEl.classList.toggle('wall', on); $('#wall-btn').setAttribute('aria-pressed', on); $('#wall-exit').hidden = !on;
  if (on) { select(null); goBuilding(); renderWall(); if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); }
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  layout();
}
$('#wall-btn').onclick = () => setWall(!appEl.classList.contains('wall'));
$('#wall-exit').onclick = () => setWall(false);
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && appEl.classList.contains('wall')) setWall(false); });

function renderUI() {
  const mains = agents.filter(a => a.kind === 'main');
  const html = rosterHtml(mains);
  if (html !== rosterEl._html) { rosterEl.innerHTML = html; rosterEl._html = html; renderSetup(); }
  const subs = agents.length - mains.length, waiting = agents.filter(a => a.state === 'waiting').length;
  const lounging = agents.filter(a => a.busy && a.spot && a.spot.laptop).length;
  $('#stats').innerHTML = `<span><b>${mains.length}</b> sessions</span><span><b>${subs}</b> subagent${subs === 1 ? '' : 's'}</span><span><b>${lounging}</b> on laptops</span><span class="${waiting ? 'warn' : ''}"><b>${waiting}</b> need${waiting === 1 ? 's' : ''} you</span>`;
  const wc = $('#wait-count'); wc.hidden = !waiting; wc.textContent = waiting;
  const pw = $('#panel-wait'); pw.hidden = !waiting; pw.textContent = waiting;
  floors.forEach(f => drawSign(f)); renderLift(); renderNeeds(); renderWall();
  uiDirty = false;
}

/* detail card */
const detail = $('#detail');
// Open the card at once, so picking an agent answers right away while the camera is still on its way.
function showCard(a) {
  selected = a; uiDirty = true; detailDirty = true; renderDetail(); detail.hidden = false;
  $('#d-prompt').placeholder = a.kind === 'sub' ? '' : `Give ${a.name} a task`;
  fitCardOnPhone();
}
function select(a, focus) {
  seeAgent(a);
  if (!a && flight && flight.then && flight.then.card) flight.then = null;   // closed mid-flight: don't reopen it on landing
  const arrive = () => select(a, true); arrive.card = true;
  if (flight && a && focus) { showCard(a); flight.then = arrive; return; }   // mid-flight: head for this agent after landing
  if (a && a.onRoof) { if (viewMode !== 'roof') { goRoofView(); if (focus && !reduced && view === '3d') { showCard(a); land(arrive); return; } } }
  else if (a && a.floor && (a.floor !== curFloor || (focus && viewMode !== 'floor'))) {
    if (focus) { showCard(a); flyToFloor(a.floor.i, arrive, a); return; }   // the camera flies to the agent with the card already open
    goToFloor(a.floor.i);
  }
  if (a && !a.onRoof && focus && viewMode !== 'floor') { viewMode = 'floor'; renderLift(); }
  selected = a || null; uiDirty = true; detailDirty = true;
  if (selected) renderDetail();                                     // fill the card before showing it, so it never flashes the previous agent
  detail.hidden = !selected;
  fitCardOnPhone();
  if (selected) {
    $('#d-prompt').placeholder = selected.kind === 'sub' ? '' : `Give ${selected.name} a task`;
    if (focus) { const p = worldPos(selected); goal.target.x = p.x; goal.target.z = p.z; if (view === '3d') goal.radius = Math.min(goal.radius, 15); }
  } else if (follow) setFollow(false);
  if (guideStep === 1 || guideStep === 3) {
    $('#office-guide').dataset.detail = !!selected;
    if (isMobile() && selected) setPanelOpen(false);
  }
}
function renderDetail() {
  const a = selected; if (!a) return; detailDirty = false;
  const av = $('#d-av'); av.style.setProperty('--c', a.color); av.innerHTML = faceImg(a) + (a.live ? appBadge(a, 'av-app') : '');
  $('#d-name').textContent = a.name;
  $('#d-sub').textContent = `Floor ${floorNum(a.floor)} · ` + (a.kind === 'sub' ? `${a.subType} subagent of ${a.parent.name}` : a.live ? `${a.cwd} · ${whereFrom(a)}` : `~/Documents/${a.project.key}`) + (a.where ? ` · ${a.where}` : '');
  $('#d-sub').title = $('#d-sub').textContent; $('#d-name').title = a.name;   // the card cuts long paths and names short
  const pill = $('#d-pill'); pill.className = 'pill s-' + a.state; pill.textContent = STATUS[a.state].label;
  $('#d-activity').textContent = activityText(a) + (a.pending.length ? ` (${a.pending.length} task${a.pending.length > 1 ? 's' : ''} queued)` : '');
  $('#d-activity').hidden = !$('#d-activity').textContent;
  const perm = $('#d-perm'); perm.hidden = !a.approval; $('#d-activity').hidden = !!a.approval;
  const alerts = clashesOf(a).map(c => `<div>⚠ <b>${esc((c.a === a ? c.b : c.a).name)}</b> is also editing <code>${esc(c.file)}</code>. One may overwrite the other's work.</div>`);
  if (a.stuck && a.busy) alerts.unshift(`<div>↻ <b>Going in circles:</b> <code>${esc(a.stuck.label)}</code> failed ${a.stuck.n} times without once working. It may need a hint from you.</div>`);
  const al = $('#d-alert'); al.hidden = !alerts.length; al.innerHTML = alerts.join('');
  const ctx = a.kind === 'main' && a.context, cx = $('#d-ctx'); cx.hidden = !ctx;
  if (ctx) { const k = ctxShare(ctx); cx.style.setProperty('--c', ctxColor(ctx)); $('#d-ctx-bar').style.width = `${Math.round(k * 100)}%`;
    $('#d-ctx-text').textContent = `${kTok(ctx.used)} of ${kTok(ctx.max)} · ${Math.round(k * 100)}%`; }
  renderGlance(a);
  const mem = $('#d-mem'), desk = a.kind === 'main' ? deskOf(a) : emptyDesk(); mem.hidden = !desk.dayCount && !desk.moments.length;
  if (!mem.hidden) {
    $('#d-mem-sum').textContent = `Desk memories · ${desk.dayCount} day${desk.dayCount === 1 ? '' : 's'} here · ${desk.merges} merge${desk.merges === 1 ? '' : 's'}`;
    $('#d-mem-list').innerHTML = desk.moments.map(m => `<li><time>${new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><span>${esc(momentText(m))}</span></li>`).join('');
  }
  if (a.approval) { $('#d-perm-tool').textContent = a.approval.tool; $('#d-perm-cmd').textContent = a.approval.cmd || a.approval.tool; }
  $('#d-defer').hidden = !(a.approval && a.approval.live);
  renderChat(a);
  $('#d-log').innerHTML = a.log.map(e => `<li><time>${stamp(e)}</time>${hookTag(e.hook, e.hook === 'Notification')}<span class="what" title="${esc(e.detail)}">${esc(e.detail)}</span></li>`).join('');
  const main = a.kind === 'main';
  $('#d-form').hidden = !main || !!a.live; $('#d-spawn').hidden = !main || !!a.live;
  const host = a.live ? hostName(a) : null, openBtn = $('#d-open');
  openBtn.hidden = !host; if (host) openBtn.textContent = openLabel(a);
  // While a held request shows Allow/Deny, the note would only contradict it.
  const note = $('#d-note'); note.hidden = !a.live || !!(a.approval && a.approval.live);
  if (!note.hidden) { const w = a.state === 'waiting'; note.classList.toggle('warn', w);
    const src = a.parent || a, app = viaT3(a) ? 'T3 Code' : AGENT_NAMES[src.agentName] || `Claude Code (${(ENTRY[src.entrypoint] || 'Claude Code').toLowerCase()})`;
    note.textContent = w ? `Answer this in ${app}.` : `Watching this session live. Reply to it in ${app}.`; }
}
// The card shows the agent's chat; its hook events sit one tab over, under Activity.
let detailTab = 'chat';
function showDetailTab(tab) {
  detailTab = tab;
  for (const b of document.querySelectorAll('.d-tabs button')) { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.setAttribute('aria-pressed', on); }
  $('#d-chat').hidden = tab !== 'chat'; $('#d-log').hidden = tab !== 'activity';
  if (tab === 'chat') { const c = $('#d-chat'); c.scrollTop = c.scrollHeight; }
}
document.querySelectorAll('.d-tabs button').forEach(b => b.onclick = () => { showDetailTab(b.dataset.tab); uiPrefs.detailTab = b.dataset.tab; saveUi(); });
function renderChat(a) {
  const el = $('#d-chat'), m = a.messages || [], sig = a.id + ':' + m.length + ':' + (m.length ? m[m.length - 1].text.length : 0);
  if (el.dataset.sig === sig) return;                       // unchanged: keep the reader's scroll position
  el.dataset.sig = sig;
  el.innerHTML = m.length ? m.map(x => `<li class="${x.role === 'user' ? 'user' : 'assistant'}">${esc(x.text)}</li>`).join('')
    : `<li class="empty">${a.kind === 'sub' ? `Subagents work out of sight and report back to ${esc(a.parent.name)}. See Activity for what they did.` : 'The chat shows up here after the next message.'}</li>`;
  el.scrollTop = el.scrollHeight;
}
// Demo agents keep a short chat of their own so the card looks the same as a live one.
function chatPush(a, role, text) { (a.messages || (a.messages = [])).push({ role, text }); if (a.messages.length > 12) a.messages.shift(); if (a === selected) detailDirty = true; }
$('#d-close').onclick = () => select(null);
// Demo approvals resolve locally; live ones go back to the bridge, which answers Claude Code's permission hook.
function decide(a, decision) {
  const ap = a && a.approval; if (!ap) return;
  if (ap.live) { if (live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: 'decide', id: ap.id, decision })); }
  else ap.resolve(decision === 'defer' ? 'allow' : decision);
}
$('#d-allow').onclick = () => decide(selected, 'allow');
$('#d-deny').onclick = () => decide(selected, 'deny');
$('#d-defer').onclick = () => decide(selected, 'defer');
$('#d-form').addEventListener('submit', e => {
  e.preventDefault(); const inp = $('#d-prompt'), text = inp.value.trim(); if (!text || !selected || selected.kind !== 'main') return;
  selected.pending.push(text); inp.value = ''; if (selected.wake) selected.wake();
  toast(`Queued for ${selected.name}: “${text}”`); uiDirty = true; detailDirty = true;
});
// Following only steers the camera across the floor in view, so it first goes to where the agent is: its floor or the roof.
const placeOf = a => a.onRoof ? 'roof' : a.floor;
const agentInView = a => a.onRoof ? viewMode === 'roof' : a.floor === curFloor && viewMode === 'floor';
let followPlace = null;
function setFollow(v) {
  follow = v; $('#d-follow').setAttribute('aria-pressed', v); $('#opt-follow').checked = v;
  followPlace = v && selected ? placeOf(selected) : null;
  if (v && selected && !flight && !agentInView(selected)) select(selected, true);
}
// While following, go along when the agent takes the lift to the roof or back down.
function followToNewPlace() {
  if (!follow || !selected || flight) return;
  const place = placeOf(selected); if (place === followPlace) return;
  followPlace = place;
  if (!agentInView(selected)) select(selected, true);
}
$('#d-follow').onclick = () => setFollow(!follow);
$('#d-open').onclick = () => selected && openHost(selected);
$('#d-spawn').onclick = async () => {
  const a = selected; if (!a || a.kind !== 'main') return;
  emit(a, 'PreToolUse', 'Task · general-purpose (started by you)'); toolCalls++;
  const ok = await runSub(a, 'General', `Help ${a.name}: ${a.activity}`);
  if (!ok) toast('Every seat is taken right now');
};

/* toasts */
// Agent names are chat titles cut to fit a name tag; hovering a toast shows the whole title.
const fullName = a => a.name.endsWith('…') && a.title ? String(a.title).replace(/\s+/g, ' ').trim() : a.name;
// msg is a string, or { title, detail, tip, ms }: a bold one-line title, a muted one-line detail (cut with … when long),
// the hover text for the detail (by default the detail with the agent's full name), and how long it stays up.
function toast(msg, action, fn, who, mood, approvalId) {
  const actions = Array.isArray(action) ? action : action ? [[action, fn, true]] : [];
  const el = document.createElement('div'); el.className = 'toast glass';
  const face = who && faceShot(who, mood);
  const badge = face && (who.parent || who).live ? appBadge(who, 'av-app') : '';
  const m = typeof msg === 'object' && msg ? msg : { title: String(msg) };
  const tip = m.tip || (m.detail && who && who.name !== fullName(who) ? m.detail.split(who.name).join(fullName(who)) : m.detail);
  const text = m.detail ? `<span class="toast-text"><b class="toast-title" title="${esc(m.title)}">${esc(m.title)}</b><span class="toast-detail" title="${esc(tip)}">${esc(m.detail)}</span></span>`
    : `<span title="${esc(m.title)}">${esc(m.title)}</span>`;
  el.innerHTML = `${face ? `<span class="toast-av"><img class="toast-face" style="--c:${who.color}" src="${face}" alt="">${badge}</span>` : ''}${text}`;
  for (const [label, run, primary] of actions) { const b = document.createElement('button'); b.className = primary ? 'btn primary' : 'btn'; b.textContent = label; b.onclick = () => { run(); el.remove(); }; el.appendChild(b); }
  if (actions.length) el.dataset.keep = '1';
  if (who || actions.length) {                                      // agent news and toasts that wait 45 s: let you dismiss them now
    const x = document.createElement('button'); x.className = 'toast-x'; x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
    x.onclick = () => el.remove(); el.appendChild(x);
  }
  if (approvalId) { el.dataset.approval = approvalId; el.setAttribute('role', 'alert'); }
  // Over three, drop the oldest plain toast first, then the oldest one with buttons; a held permission request stays.
  const wrap = $('#toasts'); wrap.prepend(el);
  while (wrap.children.length > 3) { const kids = [...wrap.children].reverse(), old = kids.find(t => !t.dataset.keep) || kids.find(t => !t.dataset.approval); if (!old) break; old.remove(); }
  setTimeout(() => el.remove(), m.ms || (el.dataset.keep ? 45000 : 6000));   // toasts with buttons stay up as long as a request is held
}

/* customize */
function buildCityChoices() {
  $('#gangnam-skyline').hidden = cityKey !== 'gangnam';
  $('#sf-skyline').hidden = $('#sf-bridge').hidden = cityKey !== 'sf';
  for (const selector of ['#cities', '#city-choices']) {
    if (!$(selector).children.length) $(selector).innerHTML = Object.entries(CITIES).map(([id, label]) => `<button class="theme-card city-card" data-city="${id}">${label}</button>`).join('');
    $(selector).querySelectorAll('[data-city]').forEach(b => { b.setAttribute('aria-pressed', b.dataset.city === cityKey); b.removeAttribute('aria-busy'); b.onclick = () => setCity(b.dataset.city); });
  }
}
$('#city-picker').addEventListener('cancel', e => e.preventDefault());
$('#gangnam-skyline').onclick = () => {
  setFollow(false); goRoofView(); camera.fov = 55; camera.updateProjectionMatrix(); goal.phi = 1.43; goal.theta = -1.04; goal.radius = 65;
};
$('#sf-bridge').onclick = () => {
  setFollow(false); goRoofView(); camera.fov = 55; camera.updateProjectionMatrix(); goal.phi = 1.50; goal.theta = 1.05; goal.radius = 65; goal.target.x = -10; goal.target.z = 17;
};
$('#sf-skyline').onclick = () => {
  setFollow(false); goRoofView(); camera.fov = 55; camera.updateProjectionMatrix(); goal.phi = 1.54; goal.theta = -.14; goal.radius = 55;
};
const TYPED_NAME_MAX = 18, TYPED_NAME_FULL = `Names can be up to ${TYPED_NAME_MAX} characters.`;
function buildCustomize() {
  const autoCard = `<button class="theme-card" data-key="auto" aria-pressed="${sceneKey === 'auto'}" title="Follows your clock: daylight from 8 to 17, golden hour at dawn and dusk, night from 20"><span class="sw">${['loft', 'golden', 'night'].map(k => `<i style="background:${SCENES[k].skyTop}"></i>`).join('')}</span>Auto (your time)</button>`;
  $('#themes').innerHTML = autoCard + Object.entries(SCENES).map(([k, T]) => `<button class="theme-card" data-key="${k}" aria-pressed="${k === sceneKey}"><span class="sw"><i style="background:${T.floor}"></i><i style="background:${T.fabric}"></i><i style="background:${T.fabric2}"></i><i style="background:${T.felt1}"></i></span>${T.label}</button>`).join('');
  $('#themes').querySelectorAll('.theme-card').forEach(b => b.onclick = () => { applyScene(b.dataset.key); uiPrefs.theme = b.dataset.key; saveUi(); });
  buildCityChoices();
  const mains = agents.filter(a => a.kind === 'main'), box$ = $('#cust-agents');
  const open = new Set([...box$.querySelectorAll('details[open]')].map(d => d.dataset.id));
  const seg = (a, key, options) => `<div class="mini-seg">${Object.entries(options).map(([k, v]) => `<button type="button" data-look="${key}" data-v="${k}" aria-pressed="${a.look[key] === k}">${typeof v === 'string' ? v : v.label}</button>`).join('')}</div>`;
  const sw = (a, key, label, colors, cur) => `<div class="swatches" role="group" aria-label="${label}">${colors.map(c => { const n = COLOR_NAMES[c.toUpperCase()] || c; return `<button type="button" style="--c:${c}" data-look="${key}" data-v="${c}" aria-label="${n}" title="${n}" aria-pressed="${c === cur}"></button>`; }).join('')}</div>`;
  $('#cust-empty').hidden = mains.length > 0;
  box$.innerHTML = mains.map(a => `<details class="cust-agent" data-id="${a.id}"${open.has(a.id) ? ' open' : ''}>
      <summary><span class="av" style="--c:${a.color}">${faceImg(a)}${a.live ? appBadge(a, 'av-app') : ''}</span><span class="cust-name"><b>${esc(a.name)}</b><span class="proj">~/${esc(a.project.key)} · floor ${floorNum(a.floor)}</span></span></summary>
      <div class="cust-body">
        <label class="field">Name <input type="text" id="name-${a.id}" data-field="name" value="${esc(a.name)}" maxlength="${TYPED_NAME_MAX}" aria-describedby="name-hint-${a.id}"></label>
        <p class="field-hint" id="name-hint-${a.id}" aria-live="polite"></p>
        <label class="field">Works at <select id="pref-${a.id}" data-field="pref">${Object.entries(PREFS).map(([k, v]) => `<option value="${k}"${k === a.pref ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <p class="field-hint">Takes effect from its next task.</p>
        <span class="lbl">Body</span>${seg(a, 'body', BODIES)}
        ${uiPrefs.crew === 'pets' ? `<span class="lbl">Animal</span>${seg(a, 'species', ANIMALS)}` : `<span class="lbl">Face</span>${seg(a, 'face', FACE_STYLES)}`}
        <span class="lbl">Color</span>${sw(a, 'color', 'Color', PALETTE, a.color)}
        <span class="lbl">Trim</span>${sw(a, 'trim', 'Trim', TRIM_COLORS, a.look.trim)}
        <span class="lbl">Accessory color</span>${sw(a, 'accent', 'Accessory color', ACCENT_COLORS, a.look.accent)}
        <span class="lbl">Accessories</span><div class="acc-chips">${Object.entries(ACCESSORIES).map(([k, v]) => `<button type="button" data-look="accessories" data-v="${k}" aria-pressed="${a.look.accessories.includes(k)}">${v}</button>`).join('')}</div>
        <div class="cust-actions"><button type="button" class="btn sm" data-act="random">Randomize look</button><button type="button" class="btn sm" data-act="tune">Play done tune</button></div>
      </div></details>`).join('');
}
// One set of listeners for the creator; the list re-renders as agents come and go.
$('#cust-agents').addEventListener('click', e => {
  const el = e.target.closest('[data-look],[data-act]'); if (!el) return;
  const a = agents.find(x => x.id === el.closest('details').dataset.id); if (!a) return;
  const key = el.dataset.look, v = el.dataset.v;
  if (el.dataset.act === 'tune') { chime('done', a, true); return; }
  if (el.dataset.act === 'random') { const look = randomLook(a.color); setAgentLook(a, look); }
  else if (key === 'color') { setAgentColor(a, v); saveAgentPrefs(a); }
  else if (key === 'accessories') {
    const A = [...a.look.accessories];
    if (A.includes(v)) A.splice(A.indexOf(v), 1); else { if (HATS.includes(v)) HATS.forEach(h => A.includes(h) && A.splice(A.indexOf(h), 1)); A.push(v); }
    setAgentLook(a, { accessories: A });
  } else setAgentLook(a, { [key]: v });
  buildCustomize(); uiDirty = true;
});
$('#cust-agents').addEventListener('input', e => {
  if (e.target.dataset.field !== 'name') return;
  const a = agents.find(x => x.id === e.target.closest('details').dataset.id); if (!a) return;
  a.customName = !!e.target.value.trim();
  a.name = e.target.value.trim() || chatName(a.title) || a.project.agent; a.labelDirty = true; uiDirty = true; detailDirty = true;
  const d = e.target.closest('details'); d.querySelector('.av').innerHTML = faceImg(a) + (a.live ? appBadge(a, 'av-app') : ''); d.querySelector('.cust-name b').textContent = a.name;
  d.querySelector('.field-hint[aria-live]').textContent = e.target.value.length >= TYPED_NAME_MAX ? TYPED_NAME_FULL : '';
  saveAgentPrefs(a);
});
$('#cust-agents').addEventListener('change', e => {
  if (e.target.dataset.field !== 'pref') return;
  const a = agents.find(x => x.id === e.target.closest('details').dataset.id); if (!a) return;
  a.pref = e.target.value; saveAgentPrefs(a); toast(`${a.name} will work at: ${PREFS[a.pref].toLowerCase()} from its next task`);
});
function setShowLabels(v) { showLabels = v; $('#opt-labels').checked = v; }
function setGridVisible(v) { grid.visible = v; $('#opt-grid').checked = v; }
$('#opt-labels').onchange = e => { setShowLabels(e.target.checked); uiPrefs.labels = e.target.checked; saveUi(); };
$('#opt-grid').onchange = e => { setGridVisible(e.target.checked); uiPrefs.grid = e.target.checked; saveUi(); };
$('#opt-follow').onchange = e => { setFollow(e.target.checked); };
