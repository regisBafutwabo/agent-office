function onLiveEvent(e, replay) {
  if (!replay) logEvents([e]);
  if (e.replacesSessionId) {
    const duplicate = live.byId.get(e.replacesSessionId);
    if (duplicate) {
      for (const a of [...(duplicate.subs?.values() || []), duplicate]) {
        a.gone = a.leaving = true;
        for (const spot of [...Object.values(a.floor.SPOTS).flat(), ...ROOF_SPOTS]) {
          if (spot.by === a.id) spot.by = null;
          if (spot.owner === a) { spot.owner = null; spot.chairMat?.color.set(sceneT.chair); }
        }
        removeAgent(a);
      }
      live.byId.delete(e.replacesSessionId); buildCustomize();
    }
  }
  const s = e.session;
  if (e.type === 'SessionEnd') { const a = live.byId.get(e.sessionId); if (a) { emit(a, 'SessionEnd', e.reason || 'Session ended', e.at); leaveOffice(a); } return; }
  const a = liveMain(s, replay); comeBack(a, s.status || 'idle', s.activity || 'Session resumed');
  if (e.type === 'SubagentStop' && e.agentId && !a.subs.has(e.agentId)) return;   // never saw it work: nothing to show
  if (s.entrypoint && s.entrypoint !== 'unknown') a.entrypoint = s.entrypoint;
  if (s.app) a.hostApp = s.app;
  if (s.term) a.hostTerm = s.term;
  if (s.chat) a.hostChat = s.chat;
  if (s.t3Thread) a.hostT3Thread = s.t3Thread;
  retitle(a, s.title);
  if (s.messages) { a.messages = s.messages; if (a === selected) detailDirty = true; }
  setContext(a, s.context, replay);
  if ('merged' in s) a.merged = !!s.merged;
  a.permissionMode = s.permissionMode; a.reported = [s.status, s.activity];
  const who = e.agentId ? liveSub(a, e.agentId, e.agentType, replay, e.agentTask) : a;
  const label = `${e.tool || ''}${e.summary ? ' ' + e.summary : ''}`;
  const agentResult = e.type.startsWith('PostToolUse') && (e.tool === 'Task' || e.tool === 'Agent');
  if (who === a && a.review && !agentResult) a.reviewDone = true;                       // the main agent moved on: let the subagent go
  if (who !== a && e.type !== 'SubagentStop' && !a.exiting) comeBack(who, 'thinking', 'Back to work');
  if (who !== a && who.awaitingReview && e.type !== 'SubagentStop') who.awaitingReview = false;   // resumed: back to work
  switch (e.type) {
    case 'SessionStart': emit(a, 'SessionStart', `${whereFrom(a)} · ${a.cwd}`, e.at); break;
    case 'SessionFound':                                     // already running when the office opened, read from its log
      if (e.message) emit(a, 'SessionFound', `${e.message} · ${whereFrom(a)} · ${a.cwd}`, e.at);
      applyStatus(a, s.status, s.activity); break;
    case 'UserPromptSubmit':
      emit(a, 'UserPromptSubmit', `"${e.prompt || ''}"`, e.at); seeAgent(a); unstick(a); a.run = null;
      if (!replay) changeDesk(a, d => workedOn(d, e.at));
      { const idleAt = !replay && !a.busy && (a.spot || a.dest);   // on a break when you called: it sprints back
        a.ws = chooseWorkspot(a); a.streak = 0;
        applyStatus(a, 'thinking', e.prompt || 'New prompt');
        place(a, s.permissionMode === 'plan' ? (spotOfType(a, ['meeting']) || a.ws) : a.ws, true);
        if (idleAt) sprintBack(a, idleAt); }
      break;
    case 'PreToolUse':
      emit(who, 'PreToolUse', label, e.at); toolCalls++; who.asked = null;
      if (who === a && (e.tool === 'Task' || e.tool === 'Agent')) { applyStatus(a, 'working', `Waiting on ${e.summary.split(':')[0] || 'a'} subagent`); break; }
      applyStatus(who, 'working', label);
      place(who, who === a ? spotForTool(a, e.tool, s) : (READ_TOOLS.has(e.tool) && Math.random() < .6 ? spotOfType(who, ['library']) : null) || who.ws);
      if (e.tool === 'Bash') who.run = { at: e.at };
      if (EDIT_TOOLS.has(e.tool)) noteEdit(who, e.summary, replay, e.at);
      break;
    case 'PostToolUse': case 'PostToolUseFailure':
      if (e.failed) emit(who, 'PostToolUseFailure', label, e.at);
      noteWork(who, e);
      { const before = noteResult(who, e, replay), ran = e.tool === 'Bash' && who.run; if (ran) who.run = null;
        if (!replay) { const ms = ran ? e.at - ran.at : 0; react(who, outcomeOf(e, before, ms), e.at, e.summary, ms); } }
      // The call it asked about has run, so you answered. Another call finishing meanwhile says nothing about the one it asked for.
      { const answered = who.state === 'waiting' && (!who.asked || who.asked === label); if (answered) who.asked = null;
        if (who.state !== 'waiting' || answered) applyStatus(who, 'thinking', e.failed ? `${e.tool} failed, rethinking` : who.review && !who.reviewDone ? reviewLabel(who.review) : 'Thinking'); }
      if (e.merged) { emit(who, 'Merged', label, e.at); if (!replay) { celebrate(who); chime('merged', a); changeDesk(a, d => remember(d, 'merge', e.at)); } }
      break;
    case 'PermissionRequest': case 'Notification': {
      const perm = e.type === 'PermissionRequest' || e.notificationType === 'permission_prompt';
      if (e.type === 'Notification') emit(a, 'Notification', e.message || e.notificationType || 'Notification', e.at);
      else { emit(who, 'PermissionRequest', label, e.at); who.asked = label; }
      // The prompt names no agent. When a subagent has just asked, it's that subagent's: the main agent isn't the one blocked.
      if (e.type === 'Notification' && perm && [...a.subs.values()].some(x => x.state === 'waiting')) break;
      if (perm) {
        applyStatus(who, 'waiting', e.type === 'PermissionRequest' ? `Needs permission: ${label}` : (e.message || 'Needs your permission'));
        if (!replay) { toast({ title: 'Needs your permission', detail: `${a.name} · in the ${whereFrom(a).toLowerCase()}` }, 'Find', () => select(who, true), who, 'waiting'); chime('needs', a); nudgeTitle(`✋ ${a.name} needs you`); }
      } else if (e.notificationType === 'idle_prompt') applyStatus(a, 'idle', 'Waiting for your input');
      break; }
    case 'Stop': emit(a, 'Stop', 'Finished responding', e.at); unstick(a); a.run = null; applyStatus(a, 'done', a.merged ? 'Finished · merged' : 'Finished');
      if (!replay) { chime('done', a); nudgeTitle(`✓ ${a.name} is done`); if (a.floor !== curFloor || viewMode !== 'floor') { unseenOf(a.floor).add(a.id); uiDirty = true; } }
      if (!replay) toast({ title: `Finished · ${a.project.key}`, detail: a.name }, openOrFind(a), null, a, 'done');
      break;
    case 'SubagentStart': emit(who, 'SubagentStart', `${e.agentType || 'Subagent'} started`, e.at); if (!replay) changeDesk(a, d => remember(d, 'team', e.at)); break;
    case 'SubagentStop': emit(who, 'SubagentStop', e.message || 'Returned its result', e.at); who.run = null;
      if (replay) { removeAgent(who); a.subs.delete(e.agentId); } else if (!who.awaitingReview && !who.exiting) queueReview(a, who); break;
    case 'PermissionResolved': emit(who, 'PermissionResolved', e.message, e.at); applyStatus(who, 'thinking', e.message);
      if (!replay) toast(`${e.message.startsWith('Allowed') ? 'Allowed' : 'Denied'}: ${who.name} ${e.message.startsWith('Allowed') ? 'can go ahead' : 'will find another way'}`); break;
    case 'PreCompact': emit(a, 'PreCompact', 'Compacting the conversation', e.at); applyStatus(a, 'working', 'Compacting context'); place(a, spotOfType(a, ['coffee']) || a.ws, true); break;
  }
  setModeLine();
}

// Hooks from before the office had keys are refused, so their sessions can't appear; say what to update, once per kind.
function onOutdatedHooks(hooks) {
  if (!Array.isArray(hooks)) return;
  const said = live.hookNotes || (live.hookNotes = new Set());
  for (const h of hooks) {
    const agent = String(h && h.agent || 'unknown'), k = agent + '|' + (h && h.reason);
    if (said.has(k)) continue; said.add(k);
    if (h.reason === 'wrong-key') { toast(`${agent} hooks sent a key this office doesn’t know, so their sessions can’t appear. If you set AGENT_OFFICE_DATA, set it for your agents too.`); continue; }
    if (agent === 'claude-code') {
      const fix = 'claude plugin marketplace update agent-office && claude plugin update agent-office@agent-office';
      toast('Claude Code is reporting with an old Agent Office plugin, so its sessions can’t appear. Update the plugin, then start a new session.', 'Copy command', () => navigator.clipboard?.writeText(fix).then(() => toast('Copied. Run it in a terminal.'), () => toast(fix)));
    } else toast(`${agent} hooks predate the office’s key, so their sessions can’t appear. Reconnect ${agent} from Connect agents, or git pull if they run this repo’s adapters/hook.sh.`);
  }
}
function onSnapshot(msg) {
  onSnapshotHistory(msg);
  if (!live.gotSnapshot) { live.gotSnapshot = true; rosterEl._html = null; uiDirty = true; setTimeout(setModeLine); }
  onOutdatedHooks(msg.outdatedHooks);
  setCodeOn(msg.showCode !== false);
  musicSupported = !!msg.musicSupported; music = musicOn && msg.music || null; updateMusicBtn();
  const ids = new Set(msg.sessions.map(s => s.id));
  for (const [id, a] of live.byId) if (!ids.has(id)) leaveOffice(a);
  feedEl.innerHTML = '';
  agents.forEach(a => { if (a.approval && a.approval.live) a.approval = null; });
  for (const s of msg.sessions) {
    const a = liveMain(s, true); comeBack(a, s.status, s.activity);
    if (s.app) a.hostApp = s.app; if (s.term) a.hostTerm = s.term; if (s.chat) a.hostChat = s.chat; if (s.t3Thread) a.hostT3Thread = s.t3Thread;
    retitle(a, s.title);
    a.merged = !!s.merged;
    if (s.messages) a.messages = s.messages;
    setContext(a, s.context, true);
    applyStatus(a, s.status, s.activity); a.reported = [s.status, s.activity];
    for (const sub of s.subagents || []) { const x = liveSub(a, sub.id, sub.type, true, sub.task); if (!a.exiting) comeBack(x, sub.status, sub.activity); applyStatus(x, sub.status, sub.activity); }
    // Finished while the page was disconnected (the Mac slept, the app restarted): its SubagentStop never reached us.
    const still = new Set((s.subagents || []).map(x => x.id));
    for (const [id, sub] of a.subs) if (!still.has(id) && !sub.awaitingReview) leaveOffice(sub, `Reported back to ${a.name}`);
  }
  for (const e of msg.recent || []) {                       // refill the feed without replaying movement
    const a = live.byId.get(e.sessionId); if (!a) continue;
    const who = e.agentId && a.subs.get(e.agentId) || a;
    const detail = e.prompt ? `"${e.prompt}"` : e.message || `${e.tool || ''}${e.summary ? ' ' + e.summary : ''}` || e.type;
    emit(who, e.type, detail, e.at);
    if (e.type === 'PostToolUse') noteWork(who, e);              // so a reopened office still knows each agent's last edit
    // and which files two agents share; a subagent that has left can't be told from its parent, so its edits are skipped
    if (e.type === 'PreToolUse' && EDIT_TOOLS.has(e.tool) && (!e.agentId || a.subs.has(e.agentId))) noteEdit(who, e.summary, true, e.at);
  }
  restoreClashes();
  for (const ap of msg.approvals || []) onApproval(ap, false);   // requests still waiting for an answer
  setModeLine();
  recapOnSnapshot();
}

function liveTick(dt) {
  for (const a of agents) {
    if (!a.live || a.leaving || a.exiting) continue;
    if (a.nextSpot && !a.path.length && performance.now() - (a.arrivedAt || 0) >= MIN_STAY_MS) place(a, a.nextSpot, true);
  }
  live.tickT += dt; if (live.tickT < 1) return; live.tickT = 0;
  const now = performance.now();
  for (const a of agents.slice()) if (a.awaitingReview && now - a.reviewSince > REVIEW_GIVEUP_MS) { a.awaitingReview = false; leaveOffice(a, `Reported back to ${a.parent.name}`); }
  for (const a of agents) {
    if (!a.live || a.kind !== 'main' || a.exiting || a.comingDown || a.path.length || a.review) continue;
    // finished: take a break, then drift between break spots (lounge, coffee, ping-pong, rooftop)
    if (a.onRoof && a.spot && a.spot.night && !isParty()) { roam(a); continue; }
    if (a.idleSince) {
      if (!a.nextRoam) a.nextRoam = a.idleSince + IDLE_BREAK_MS;
      if (now >= a.nextRoam) { a.nextRoam = now + rand(IDLE_ROAM_MS[0], IDLE_ROAM_MS[1]); roam(a); }
      continue;
    }
    // thinking for a long time at the desk: sometimes stretch the legs with a coffee
    if (a.state === 'thinking' && a.thinkingSince && !a.wandered && !a.onRoof && now - a.thinkingSince > THINK_WANDER_MS) {
      a.wandered = true;
      const sp = Math.random() < .5 ? spotOfType(a, ['coffee']) : null;
      if (sp) { place(a, sp, true); a.wanderSpot = sp; setState(a, 'thinking', 'Thinking it over with a coffee'); }
    }
  }
}
function roam(a) {
  if (a.onRoof) {                                           // already upstairs: maybe move to another spot on the terrace
    const closed = a.spot && a.spot.night && !isParty();    // the dance floor closed at dawn
    const s = (closed || Math.random() < .6) && pickRoof();
    if (s) { s.by = a.id; roofWalkTo(a, s).then(() => { a.pose = poseFor(a); setState(a, 'idle', ROOF_ACTIVITY[s.type]); }); }
    return;
  }
  // idle for a long while with nothing merged (still waiting on review), or it's party time: go up to the terrace; otherwise sometimes
  if (a.chat && Math.random() < .7) return;                 // mid-conversation at the café counter: stay a while longer
  const waitingOnMerge = !a.merged && performance.now() - a.idleSince > IDLE_ROOF_MS;
  if ((isParty() || waitingOnMerge || Math.random() < .3) && roofFree().length) { goRoof(a); return; }
  const sp = chooseIdle(a.floor, a);
  if (sp && sp !== a.spot) { a.cafe = sp.type === 'stool' ? sp : null; place(a, sp, true); setState(a, 'idle', IDLE_ACTIVITY[sp.type]); }
}

// Tell the bridge whether this office is on screen: it only holds permission requests while someone is watching.
function sendPresence() { if (live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: 'presence', visible: document.visibilityState === 'visible' })); }
document.addEventListener('visibilitychange', sendPresence);
function approvalOwner(ap) { const a = live.byId.get(ap.sessionId); return a && (ap.agentId ? a.subs.get(ap.agentId) : a); }
function onApproval(ap, fresh) {
  const who = approvalOwner(ap); if (!who) return;
  who.approval = { live: true, id: ap.id, tool: ap.tool || 'a tool', cmd: ap.summary ? `${ap.tool} ${ap.summary}` : ap.tool, expiresAt: ap.expiresAt };
  applyStatus(who, 'waiting', `Needs permission: ${who.approval.cmd}`);
  detailDirty = true; uiDirty = true;
  if (fresh) toast({ title: `Wants to run ${who.approval.cmd}`, detail: `${who.name} · floor ${floorNum(who.floor)}` },
    [['Allow', () => decide(who, 'allow'), true], ['Deny', () => decide(who, 'deny')], ['Find', () => select(who, true)]], null, who, 'waiting', ap.id);
}
function onApprovalResolved(msg) {
  for (const a of agents) if (a.approval && a.approval.live && a.approval.id === msg.id) { a.approval = null; detailDirty = true; uiDirty = true;
    if (msg.decision === 'defer') setState(a, 'waiting', 'Waiting for an answer in Claude Code'); }
  document.querySelectorAll('.toast[data-approval]').forEach(t => { if (t.dataset.approval === String(msg.id)) t.remove(); });
}
/* Connect agents: the desktop app can install the Claude Code plugin and add Codex / Cursor hooks in one click
   (GET /api/setup, POST /api/setup/<tool>). The Node bridge doesn't offer this, so the buttons stay hidden there. */
const setup = { tools: null, busy: null };
async function loadSetup() {
  if (setup.missing) return;
  try { const r = await officeAuth.fetch('/api/setup'); if (r.status === 404) setup.missing = true; setup.tools = r.ok ? (await r.json()).tools : null; } catch (_) { setup.tools = null; }
  renderSetup();
}
async function connectTool(id) {
  if (setup.busy) return; setup.busy = id; renderSetup();
  try { const r = await officeAuth.fetch('/api/setup/' + encodeURIComponent(id), { method: 'POST' }); toast((await r.json()).message); }
  catch (_) { toast('Couldn’t reach the office server'); }
  setup.busy = null; loadSetup();
}
function renderSetup() {
  const tools = MODE === 'live' && setup.tools || [], todo = tools.filter(t => t.status === 'not-connected');
  const btn = (t, primary) => `<button class="btn${primary ? ' primary' : ''}" data-connect="${t.id}"${setup.busy ? ' disabled' : ''}>${setup.busy === t.id ? 'Connecting…' : 'Connect ' + esc(t.name)}</button>`;
  const list = $('#connect-list'); list.hidden = $('#connect-title').hidden = !tools.length;
  list.innerHTML = tools.map(t => `<div class="connect-row"><span>${esc(t.name)}</span>${t.status === 'connected' ? '<span class="pill s-done">Connected</span>'
    : t.status === 'not-installed' ? '<span class="state">Not installed</span>' : btn(t, true)}</div>`).join('');
  // With no agents yet, the Agents tab says what to do next.
  const card = $('#setup-card'), empty = MODE === 'live' && !agents.some(a => a.kind === 'main');
  card.hidden = !empty;
  if (empty && !live.gotSnapshot) card.innerHTML = `<b>Connecting…</b><span>Looking for your Claude Code sessions.</span>`;
  else if (empty) card.innerHTML = todo.length
    ? `<b>Connect your coding agents</b><span>Agent Office adds a small hook that reports what each session is doing. Nothing leaves your Mac.</span><div class="btns">${todo.map((t, i) => btn(t, i === 0)).join('')}</div>`
    : `<b>No agents yet</b><span>Start a new ${tools.some(t => t.id === 'claude-code' && t.status === 'connected') ? 'Claude Code ' : ''}session and send a prompt. Its agent rides up in the lift.</span>`;
  renderGuideTools();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-connect]'); if (b) connectTool(b.dataset.connect); });
addEventListener('focus', () => { if (live.connected) loadSetup(); });
