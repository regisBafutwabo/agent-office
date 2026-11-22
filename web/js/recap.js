/* ---------- coming back: what happened while you were away, and file clashes that outlast a reload ---------- */
// Both live in this browser only. The bridge keeps its last 80 events, so a recap can only go back that far.
const SEEN_KEY = 'agent-office:seen', CLASHES_KEY = 'agent-office:clashes';
const AWAY_MS = 2 * 60 * 1000;                  // away at least this long: say what happened meanwhile
const RECAP_KEEP = 200;
const recapEl = $('#recap'), recapList = $('#recap-list');
const recapLog = [];                            // the bridge's events, oldest first
const storedNumber = k => { try { return Number(localStorage.getItem(k)) || 0; } catch (_) { return 0; } };
let seenAt = storedNumber(SEEN_KEY), awaySince = seenAt;

function keepSeen() { seenAt = Date.now(); try { localStorage.setItem(SEEN_KEY, String(seenAt)); } catch (_) {} }
setInterval(() => { if (MODE === 'live' && live.gotSnapshot && document.visibilityState === 'visible') keepSeen(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (MODE !== 'live' || !live.gotSnapshot) return;
  if (document.visibilityState === 'hidden') { keepSeen(); return; }
  if (Date.now() - seenAt > AWAY_MS) showRecap(seenAt);
  keepSeen();
});

function logEvents(list, fresh) {
  if (fresh) recapLog.length = 0;
  recapLog.push(...list);
  if (recapLog.length > RECAP_KEEP) recapLog.splice(0, recapLog.length - RECAP_KEEP);
}

// One line per agent that did something worth knowing since `since`, plus every clash that started since then.
function recapLines(since) {
  const by = new Map();
  for (const e of recapLog) {
    if (!(e.at > since)) continue;
    const a = live.byId.get(e.sessionId); if (!a || a.gone) continue;
    const r = by.get(a) || by.set(a, { failed: 0, subs: 0, done: false, merged: false }).get(a);
    if (e.type === 'Stop') r.done = true;
    else if (e.type === 'UserPromptSubmit') r.done = false;
    if (e.merged) r.merged = true;
    if (e.failed) r.failed++;
    if (e.type === 'SubagentStop') r.subs++;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const lines = [];
  for (const c of clashes) if (c.since > since) lines.push({ a: c.a, rank: 0, text: `edited ${c.file} while ${c.b.name} did too` });
  for (const [a, r] of by) {
    const parts = [r.done && 'finished', r.merged && 'merged work', r.failed && plural(r.failed, 'failed command'), r.subs && plural(r.subs, 'subagent') + ' reported back'].filter(Boolean);
    if (parts.length) lines.push({ a, rank: r.done ? 1 : 2, text: parts.join(' · ') });
  }
  return lines.sort((x, y) => x.rank - y.rank);
}

function showRecap(since) {
  const lines = recapLines(since);
  if (!lines.length) return;
  const cut = recapLog.length && recapLog[0].at > since && recapLog.length >= 80;
  $('#recap-title').textContent = `While you were away · last here ${ago(since)} ago`;
  $('#recap-note').hidden = !cut;
  recapList.innerHTML = lines.map(({ a, rank, text }) => `<button class="need recap-row" data-id="${a.id}"><span class="av" style="--c:${a.color}">${faceImg(a)}</span>
    <span class="need-who"><b>${esc(a.name)}</b><span class="need-what${rank === 0 ? ' warn' : ''}" title="${esc(text)}">${rank === 0 ? '⚠ ' : ''}${esc(text)}</span></span></button>`).join('');
  recapEl.hidden = false; fitTops();
}
function hideRecap() { recapEl.hidden = true; fitTops(); }
$('#recap-close').onclick = hideRecap;
recapList.addEventListener('click', e => {
  const b = e.target.closest('[data-id]'), a = b && agents.find(x => x.id === b.dataset.id); if (!a) return;
  if (appEl.classList.contains('wall')) setWall(false);
  select(a, true);
});

// Called once the first snapshot has rebuilt the office.
function recapOnOpen() {
  if (awaySince && Date.now() - awaySince > AWAY_MS) showRecap(awaySince);
  awaySince = 0; keepSeen();
}

// Clashes by session (and subagent), so a reopened office can draw them again until they are CLASH_MS old.
const agentKey = a => a.kind === 'sub' ? `${a.parent.sessionId}/${a.agentId}` : a.sessionId;
function saveClashes() {
  const now = Date.now(), keep = clashes.filter(c => c.a.live && c.b.live && now - c.at <= CLASH_MS)
    .map(c => ({ a: agentKey(c.a), b: agentKey(c.b), file: c.file, at: c.at, since: c.since }));
  try { localStorage.setItem(CLASHES_KEY, JSON.stringify(keep)); } catch (_) {}
}
function restoreClashes() {
  let saved = []; try { saved = JSON.parse(localStorage.getItem(CLASHES_KEY)) || []; } catch (_) {}
  const find = k => { const [s, sub] = String(k).split('/'), a = live.byId.get(s); return a && (sub ? a.subs.get(sub) : a); };
  for (const c of saved) {
    const a = find(c.a), b = find(c.b);
    if (a && b && !gone(a) && !gone(b) && Date.now() - c.at <= CLASH_MS) addClash(a, b, c.file, c.at, true, c.since);
  }
}
