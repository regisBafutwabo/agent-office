/* ---------- coming back: what happened while you were away, and file clashes that outlast a reload ---------- */
// Both live in this browser only. The bridge keeps its last `recentMax` events, so a recap can only go back that far.
const SEEN_KEY = 'agent-office:seen', CLASHES_KEY = 'agent-office:clashes';
const AWAY_MS = 2 * 60 * 1000;                  // away at least this long: say what happened meanwhile
const RECAP_KEEP = 400;
const recapEl = $('#recap'), recapList = $('#recap-list');
const recapLog = [];                            // the bridge's events, oldest first
let recentMax = 200;                            // how many events the bridge keeps (each snapshot says)
// Event times come from the bridge's clock; a phone or another computer may disagree with it.
let clockSkew = 0;
const serverNow = () => Date.now() - clockSkew;
const storedNumber = k => { try { return Number(localStorage.getItem(k)) || 0; } catch (_) { return 0; } };
// Last time someone was looking at a connected office, on the bridge's clock. 0: never, or already recapped.
let seenAt = storedNumber(SEEN_KEY), awaySince = seenAt;

function keepSeen() { seenAt = serverNow(); try { localStorage.setItem(SEEN_KEY, String(seenAt)); } catch (_) {} }
const watching = () => MODE === 'live' && live.connected && live.gotSnapshot && document.visibilityState === 'visible';
setInterval(() => { if (watching()) keepSeen(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (MODE !== 'live' || !live.gotSnapshot) return;
  if (document.visibilityState === 'hidden') { if (live.connected) keepSeen(); return; }
  seenAt = Math.max(seenAt, storedNumber(SEEN_KEY));   // another tab may have shown it all already
  if (serverNow() - seenAt <= AWAY_MS) { if (live.connected) keepSeen(); return; }
  awaySince = seenAt;
  if (live.connected) recapOnSnapshot();               // otherwise the reconnect's snapshot brings what was missed
});
// The connection dropped while you watched: what happens until it's back counts as missed.
function onDisconnect() { if (MODE === 'live' && live.gotSnapshot && !awaySince) awaySince = seenAt; }

const eventId = e => `${e.at}|${e.sessionId}|${e.agentId || ''}|${e.type}|${e.tool || ''}|${e.summary || ''}`;
function logEvents(list) {
  const have = new Set(recapLog.map(eventId));
  for (const e of list) if (!have.has(eventId(e))) { have.add(eventId(e)); recapLog.push(e); }
  recapLog.sort((x, y) => x.at - y.at);
  if (recapLog.length > RECAP_KEEP) recapLog.splice(0, recapLog.length - RECAP_KEEP);
}
// A snapshot replaces what the page knows, so it also says how much history the bridge kept and on which clock.
function onSnapshotHistory(msg) {
  if (Number.isFinite(msg.now)) clockSkew = Date.now() - msg.now;
  if (Number.isFinite(msg.recentMax)) recentMax = msg.recentMax;
  logEvents(msg.recent || []);
}

// One line per session that did something worth knowing since `since`, plus every clash that started since then.
// A session that ended meanwhile is gone from the office, so its line comes from the events alone.
function recapLines(since) {
  const by = new Map();
  for (const e of recapLog) {
    if (!(e.at > since)) continue;
    const r = by.get(e.sessionId) || by.set(e.sessionId, { failed: 0, subs: 0, done: false, merged: false, ended: false, session: null }).get(e.sessionId);
    if (e.session) r.session = e.session;
    if (e.type === 'Stop') r.done = true;
    else if (e.type === 'UserPromptSubmit') r.done = false;
    if (e.type === 'SessionEnd') r.ended = true;
    if (e.merged) r.merged = true;
    if (e.failed) r.failed++;
    if (e.type === 'SubagentStop') r.subs++;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const lines = [];
  for (const c of clashes) if (c.since > since) lines.push({ a: c.a, rank: 0, text: `edited ${c.file} while ${c.b.name} did too` });
  for (const [id, r] of by) {
    const a = live.byId.get(id), here = a && !a.gone;
    if (!here && !r.ended) continue;
    const parts = [r.done && 'finished', r.merged && 'merged work', r.failed && plural(r.failed, 'failed command'), r.subs && plural(r.subs, 'subagent') + ' reported back', r.ended && 'closed the session'].filter(Boolean);
    if (!parts.length) continue;
    const s = r.session || {};
    lines.push({ a: here ? a : null, name: here ? a.name : s.title || s.project || 'A session', rank: r.done || r.ended ? 1 : 2, text: parts.join(' · ') });
  }
  return lines.sort((x, y) => x.rank - y.rank);
}

function showRecap(since) {
  const lines = recapLines(since);
  if (!lines.length) return;
  const cut = recapLog.length && recapLog[0].at > since && recapLog.length >= recentMax;
  $('#recap-title').textContent = `While you were away · last here ${ago(since + clockSkew)} ago`;
  $('#recap-note').textContent = `Only the bridge's last ${recentMax} events are kept, so earlier activity isn't shown.`;
  $('#recap-note').hidden = !cut;
  recapList.innerHTML = lines.map(({ a, name, rank, text }) => {
    const what = `<span class="need-who"><b>${esc(a ? a.name : name)}</b><span class="need-what${rank === 0 ? ' warn' : ''}" title="${esc(text)}">${rank === 0 ? '⚠ ' : ''}${esc(text)}</span></span>`;
    return a ? `<button class="need recap-row" data-id="${a.id}"><span class="av" style="--c:${a.color}">${faceImg(a)}</span>${what}</button>`
      : `<div class="need recap-row ended"><span class="av" aria-hidden="true">✓</span>${what}</div>`;
  }).join('');
  recapEl.hidden = false; fitTops();
}
function hideRecap() { recapEl.hidden = true; fitTops(); }
$('#recap-close').onclick = hideRecap;
recapList.addEventListener('click', e => {
  const b = e.target.closest('[data-id]'), a = b && agents.find(x => x.id === b.dataset.id); if (!a) return;
  if (appEl.classList.contains('wall')) setWall(false);
  select(a, true);
});

// After every snapshot: a first one after being away, or a reconnect after missing events, recaps once.
function recapOnSnapshot() {
  if (awaySince && serverNow() - awaySince > AWAY_MS) showRecap(awaySince);
  awaySince = 0;
  if (document.visibilityState === 'visible') keepSeen();
}

// Clashes by session (and subagent), so a reopened office can draw them again until they are CLASH_MS old.
const agentKey = a => a.kind === 'sub' ? `${a.parent.sessionId}/${a.agentId}` : a.sessionId;
function saveClashes() {
  const now = serverNow(), keep = clashes.filter(c => c.a.live && c.b.live && now - c.at <= CLASH_MS)
    .map(c => ({ a: agentKey(c.a), b: agentKey(c.b), file: c.file, at: c.at, since: c.since }));
  try { localStorage.setItem(CLASHES_KEY, JSON.stringify(keep)); } catch (_) {}
}
function restoreClashes() {
  let saved = []; try { saved = JSON.parse(localStorage.getItem(CLASHES_KEY)) || []; } catch (_) {}
  const find = k => { const [s, sub] = String(k).split('/'), a = live.byId.get(s); return a && (sub ? a.subs.get(sub) : a); };
  for (const c of saved) {
    const a = find(c.a), b = find(c.b);
    if (a && b && !gone(a) && !gone(b) && serverNow() - c.at <= CLASH_MS) addClash(a, b, c.file, c.at, true, c.since);
  }
}
