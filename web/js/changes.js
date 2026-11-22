/* ---------- changes: what a checkout holds that you haven't reviewed, and the last edit each agent reported ---------- */
// The file list is git's, per checkout, so agents sharing one folder share one list. Which agent touched a file comes from its hooks.
const CHG_POLL_MS = 20000;                      // how stale the open card's file list may get with no news from the agent
const EDIT_FRESH_MS = 60000;                    // an edit reported this recently gets a ring in the review list
const chg = new Map();                          // session → { data, at, busy }
const mainOf = a => a.parent || a;
const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fileName = p => p.slice(p.lastIndexOf('/') + 1);
let codeOn = true;                              // the office server's "Show code" setting; off means no changed lines anywhere
const reviewedOf = root => { try { return JSON.parse(localStorage.getItem('agent-office:reviewed:' + root)) || { sigs: {} }; } catch (_) { return { sigs: {} }; } };
const unreviewed = c => { const seen = reviewedOf(c.root).sigs; return c.files.filter(f => seen[f.path] !== f.sig); };
// Hooks name files relative to the session's folder; git names them relative to the checkout.
const inCheckout = (c, file) => file.startsWith('/') ? (file.startsWith(c.root + '/') ? file.slice(c.root.length + 1) : file) : (c.prefix || '') + file;
// One row of the war room's review board: what a session's checkout holds that you haven't reviewed, files with a reported edit first.
function reviewRow(m, c, seen, now, subs = []) {
  const row = { m, name: m.name, color: m.color, state: m.state, subs: subs.map(s => ({ name: s.name, color: s.color, state: s.state })), run: m.lastRun || null, tone: 'wait', note: 'Reading the checkout…', count: 0, total: 0, add: 0, del: 0, files: [] };
  if (!c) return row;
  if (!c.ok) return { ...row, tone: 'none', note: c.error };
  const by = new Map(); for (const [file, t] of m.touched || []) by.set(inCheckout(c, file), t);
  const files = c.files.filter(f => seen[f.path] !== f.sig).map(f => { const t = by.get(f.path), at = t ? t.at : 0; return { path: f.path, add: f.add, del: f.del, at, fresh: now - at < EDIT_FRESH_MS, color: t?.who?.color || null, by: t?.who?.name || null }; }).sort((a, b) => b.at - a.at);
  const sum = k => c.files.reduce((n, f) => n + (f[k] || 0), 0);
  return { ...row, tone: files.length ? 'todo' : c.files.length ? 'clear' : 'none', note: c.files.length ? '' : 'No changes', count: files.length, total: c.files.length, add: sum('add'), del: sum('del'), files };
}
function noteWork(who, e) {
  const m = mainOf(who), at = e.at || Date.now();
  m.chgStale = true;
  if (e.tool === 'Bash') m.lastRun = { cmd: e.summary, failed: !!e.failed, at };
  if (!EDIT_TOOLS.has(e.tool) || e.failed || !e.summary) return;
  (m.touched || (m.touched = new Map())).set(e.summary, { at, who });
  m.lastEdit = { file: e.summary, at, who, edit: e.edit || null };
  if (selected && mainOf(selected) === m) detailDirty = true;
  changesSoon(m);
}
const DEMO_EDITS = [
  { del: ['  return items;'], add: ['  if (!items.length) return [];', '  return items.sort(byDueDate);'] },
  { del: ['const TIMEOUT = 3000;'], add: ['const TIMEOUT = Number(process.env.TIMEOUT_MS) || 3000;'] },
  { del: [], add: ['export function isOverdue(task, now = Date.now()) {', '  return !task.done && task.due < now;', '}'] },
  { del: ['    throw new Error("failed");'], add: ['    throw new HttpError(404, `No such list: ${id}`);'] },
];
function demoChanges(m) {
  const files = [...(m.touched || [])].map(([file, t]) => { const h = hashStr(file); return { path: file, status: h % 5 ? 'modified' : 'added', add: 3 + h % 40, del: h % 5 ? h % 9 : 0, sig: String(t.at) }; });
  return { ok: true, root: 'demo:' + m.project.key, branch: 'feat/' + m.project.key, base: 'main', prefix: '', files, shared: [], at: Date.now() };
}
const changesOf = m => !m.live ? demoChanges(m) : (chg.get(m.sessionId) || {}).data || null;
async function loadChanges(m, force) {
  if (!m.live || !m.sessionId || !m.cwd) return;
  const st = chg.get(m.sessionId) || {}; chg.set(m.sessionId, st);
  if (st.busy || (!force && Date.now() - (st.at || 0) < CHG_POLL_MS)) return;
  st.busy = true; if (reviewing === m) renderReview();
  try { st.data = await (await officeAuth.fetch('/api/changes?session=' + encodeURIComponent(m.sessionId))).json(); } catch (_) { st.data = { ok: false, error: 'The office server did not answer' }; }
  st.busy = false; st.at = Date.now(); m.chgStale = false;
  if (selected && mainOf(selected) === m) detailDirty = true;
  if (reviewing === m) renderReview();
}
let chgTimer = 0;
function changesSoon(m) {                        // an edit or a command just finished: read the checkout again, once things settle
  if (reviewing === m && !m.live) renderReview();
  if (!m.live || !(reviewing === m || (selected && mainOf(selected) === m))) return;
  clearTimeout(chgTimer); chgTimer = setTimeout(() => loadChanges(m, true), 1200);
}
const boardMains = () => floorAgents(curFloor).filter(a => a.kind === 'main' && !a.gone);
setInterval(() => {                              // the open card or review, and any agent on this floor's board that has worked since its last reading
  if (document.hidden) return;
  const m = reviewing || (selected && mainOf(selected)); if (m) loadChanges(m);
  for (const b of boardMains()) if (b !== m && b.chgStale !== false) loadChanges(b);
}, 5000);
let boardReadAt = 0;
function refreshBoard(all) {                     // you may have committed, stashed or edited by hand while no agent was reporting
  if (Date.now() - boardReadAt < 2000) return; boardReadAt = Date.now();
  const ms = new Set(boardMains()); if (all) { if (selected) ms.add(mainOf(selected)); if (reviewing) ms.add(reviewing); }
  for (const m of ms) loadChanges(m, true);
}
addEventListener('focus', () => refreshBoard(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBoard(true); });
const codeLines = (del, add) => del.map(l => `<span class="ln del">${esc(l) || ' '}</span>`).join('') + add.map(l => `<span class="ln add">${esc(l) || ' '}</span>`).join('');
function renderGlance(a) {
  const m = mainOf(a), el = $('#d-chg'), c = changesOf(m), le = m.lastEdit, has = c && c.ok && c.files.length > 0;
  if (m.live && !c) loadChanges(m);
  el.hidden = !le && !has; if (el.hidden) return;
  el.style.setProperty('--c', le ? le.who.color : m.color);
  const todo = has ? unreviewed(c) : [], seenAt = has && reviewedOf(c.root).at;
  $('#chg-n').textContent = has ? todo.length : '';
  $('#chg-what').textContent = has ? (todo.length ? `file${todo.length === 1 ? '' : 's'} to review` : 'files to review: all caught up') : !c ? 'Reading the checkout…' : c.ok ? 'Nothing changed in this checkout' : c.error;
  $('#chg-since').textContent = !has ? '' : (seenAt ? `Since your review at ${hm(seenAt)}` : c.base ? `Since ${c.base}` : 'Not committed yet') + ` · ${c.files.length} changed in all`;
  $('#chg-open').hidden = !has;
  $('#chg-edit').hidden = !le;
  if (le) {
    const ed = codeOn && le.edit, by = le.who !== a ? ` · ${le.who.name}` : '';
    $('#chg-edit-head').innerHTML = `Latest reported edit · ${hm(le.at)}${esc(by)} · <b title="${esc(le.file)}">${esc(fileName(le.file))}</b>`;
    const code = $('#chg-edit-code'); code.hidden = !ed || !(ed.del.length + ed.add.length);
    code.innerHTML = code.hidden ? '' : codeLines(ed.del, ed.add) + (ed.more ? `<span class="ln hunk">${ed.more} more line${ed.more === 1 ? '' : 's'}</span>` : '');
  }
  const warn = $('#chg-warn'), n = has ? c.shared.length : 0; warn.hidden = !n;
  if (n) warn.textContent = `⚠ ${n} other agent${n === 1 ? ' shares' : 's share'} this checkout, so the list may include their work.`;
}
// The review window: the checkout's files on the left, one file's changes on the right. Nothing in the right pane moves while you read.
const review = $('#review');
let reviewing = null, rvDiff = null;             // rvDiff: { path, sig, text, truncated, error }
function openReview(a) { reviewing = mainOf(a); rvDiff = null; renderReview(); if (!review.open) review.showModal(); loadChanges(reviewing, true); }
review.addEventListener('close', () => { reviewing = null; rvDiff = null; });
$('#rv-close').onclick = () => review.close();
$('#chg-open').onclick = () => selected && openReview(selected);
function renderReview() {
  const m = reviewing; if (!m) return;
  const c = changesOf(m), ok = c && c.ok;
  $('#rv-title').textContent = `Changes in ${m.project.key}`;
  $('#rv-sub').textContent = !c ? 'Reading the checkout…' : !ok ? c.error : `${c.branch || 'detached'} · ${c.base ? `since ${c.base}` : 'not committed yet'} · read at ${hm(c.at)}`;
  const warn = $('#rv-warn'), n = ok ? c.shared.length : 0; warn.hidden = !n;
  if (n) warn.textContent = `⚠ ${n} other agent${n === 1 ? ' shares' : 's share'} this checkout. Git can't tell whose change is whose; the dots show which agent reported an edit to a file.`;
  const seen = ok ? reviewedOf(c.root).sigs : {}, now = Date.now(), by = new Map();
  if (ok) for (const [file, t] of m.touched || []) by.set(inCheckout(c, file), t);
  const top = ok ? Math.max(1, ...c.files.map(f => (f.add || 0) + (f.del || 0))) : 1;
  $('#rv-files').innerHTML = !ok ? '' : c.files.map(f => { const t = by.get(f.path), fresh = t && now - t.at < EDIT_FRESH_MS;
    const note = f.status === 'modified' ? '' : f.status[0].toUpperCase() + f.status.slice(1);
    const who = t ? `<i class="dot${fresh ? ' now' : ''}" style="--c:${t.who.color}"></i>${esc(t.who.name)} · ${fresh ? 'edit just reported' : `edit reported ${hm(t.at)}`}` : '';
    return `<li><button class="${seen[f.path] === f.sig ? 'seen' : ''}${rvDiff && rvDiff.path === f.path ? ' sel' : ''}" data-path="${esc(f.path)}"><span class="path" title="${esc(f.path)}">&lrm;${esc(f.path)}</span>`
      + `<span class="num">${f.add == null ? 'binary' : `<b>+${f.add}</b> <i>−${f.del}</i>`}</span>${note || who ? `<small>${[note, who].filter(Boolean).join(' · ')}</small>` : ''}</button></li>`; }).join('')
    || '<li><p style="margin:10px;color:var(--muted)">Nothing has changed in this checkout.</p></li>';
  const pane = $('#rv-diff'), cur = rvDiff && ok && c.files.find(f => f.path === rvDiff.path);
  if (!rvDiff) pane.innerHTML = `<p>${codeOn ? 'Select a file to see its changes. They stay still while you read.' : 'Code is hidden. Turn on “Show code” in Customize to read changes here.'}</p>`;
  else if (rvDiff.loading) pane.innerHTML = '<p>Reading…</p>';
  else if (rvDiff.error) pane.innerHTML = `<p>${esc(rvDiff.error)}</p>`;
  else pane.innerHTML = (cur && cur.sig !== rvDiff.sig ? '<div class="stale">This file changed since you opened it.<button class="btn sm" id="rv-reload">Show the new version</button></div>' : '')
    + `<div class="code">${rvDiff.text.split('\n').filter(l => !/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)).map(l => `<span class="ln ${l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(/^[+ -]/.test(l) ? l.slice(1) : l) || ' '}</span>`).join('')}</div>`
    + (rvDiff.truncated ? '<p>This diff is long. The rest is in your editor.</p>' : '');
  const run = m.lastRun, runEl = $('#rv-run');
  runEl.innerHTML = run ? `<span class="${run.failed ? 'bad' : 'ok'}">${run.failed ? '✗ Last command failed' : '✓ Last command passed'}</span> · ${hm(run.at)} · one command, not a verdict on the checkout<b title="${esc(run.cmd)}">${esc(run.cmd)}</b>` : '';
  const chat = $('#rv-chat'); chat.hidden = !(m.live && hostName(m)); if (!chat.hidden) chat.textContent = openLabel(m);
  $('#rv-mark').disabled = !ok || !unreviewed(c).length;
  const rf = $('#rv-refresh'); rf.hidden = !m.live; rf.disabled = !!(chg.get(m.sessionId) || {}).busy;
}
async function showDiff(path) {
  const m = reviewing, c = m && changesOf(m), f = c && c.ok && c.files.find(x => x.path === path); if (!f || !codeOn) return;
  rvDiff = { path, sig: f.sig, loading: true }; renderReview();
  let d;
  if (!m.live) { const e = DEMO_EDITS[hashStr(path) % DEMO_EDITS.length]; d = { ok: true, text: `@@ -${10 + hashStr(path) % 80},6 +${10 + hashStr(path) % 80},7 @@\n   // demo: invented lines\n${e.del.map(l => '-' + l).join('\n')}${e.del.length ? '\n' : ''}${e.add.map(l => '+' + l).join('\n')}` }; }
  else try { d = await (await officeAuth.fetch(`/api/changes/diff?session=${encodeURIComponent(m.sessionId)}&path=${encodeURIComponent(path)}`)).json(); } catch (_) { d = { ok: false, error: 'The office server did not answer' }; }
  if (reviewing !== m || !rvDiff || rvDiff.path !== path) return;
  rvDiff = d.ok ? { path, sig: f.sig, text: d.text, truncated: d.truncated } : { path, sig: f.sig, error: d.error };
  renderReview(); $('#rv-diff').scrollTop = 0;
}
$('#rv-files').addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) showDiff(b.dataset.path); });
$('#rv-diff').addEventListener('click', e => { if (e.target.id === 'rv-reload' && rvDiff) showDiff(rvDiff.path); });
$('#rv-chat').onclick = () => reviewing && openHost(reviewing);
$('#rv-refresh').onclick = () => reviewing && loadChanges(reviewing, true);
$('#rv-mark').onclick = () => {                 // these versions are seen; a later edit to any of them brings it back
  const c = reviewing && changesOf(reviewing); if (!c || !c.ok) return;
  try { localStorage.setItem('agent-office:reviewed:' + c.root, JSON.stringify({ at: Date.now(), sigs: Object.fromEntries(c.files.map(f => [f.path, f.sig])) })); } catch (_) {}
  renderReview(); detailDirty = true; toast(`Marked ${c.files.length} file${c.files.length === 1 ? '' : 's'} as reviewed`);
};
function setCodeOn(v) { codeOn = v; $('#opt-code').checked = v; detailDirty = true; if (!v) { rvDiff = null; for (const a of agents) if (a.lastEdit) a.lastEdit.edit = null; } if (reviewing) renderReview(); }
$('#opt-code').onchange = e => { uiPrefs.code = e.target.checked; saveUi(); setCodeOn(e.target.checked); if (live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: 'code', show: e.target.checked })); };

/* ---------- war room screens: the floor's review board and its latest reported edit ---------- */
const BOARD_ROWS = 5, EDIT_ROWS = 8;
const TONE = { todo: '#F2A22C', clear: '#52C96F', none: '#7D8F98', wait: '#7D8F98' };
const MONO = '"IBM Plex Mono", monospace', SANS = '"IBM Plex Sans", sans-serif';
// Long paths lose their start, not the file name.
function fitTail(x, s, max) { if (x.measureText(s).width <= max) return s; while (s.length > 1 && x.measureText('…' + s).width > max) s = s.slice(1); return '…' + s; }
function drawReviewBoard(rows, zoomed) {
  const x = term.x, W = 2048, H = 768, HEAD = 84, more = rows.length - BOARD_ROWS; rows = rows.slice(0, BOARD_ROWS);
  x.textAlign = 'left'; x.fillStyle = '#0A1115'; x.fillRect(0, 0, W, H); x.fillStyle = '#131E24'; x.fillRect(0, 0, W, HEAD);
  x.fillStyle = '#DDE7EB'; x.font = `600 34px ${SANS}`; x.fillText('R E V I E W   B O A R D', 40, 54);
  x.fillStyle = '#7D8F98'; x.font = `500 28px ${SANS}`; x.fillText(fitText(x, curFloor.name, 560), 480, 54);
  x.textAlign = 'right'; x.fillText((more > 0 ? `${more} more not shown · ` : '') + (zoomed ? 'Click a row to open its changes · Esc to go back' : 'Click to read'), W - 40, 54); x.textAlign = 'left';
  term.rows = [];
  if (!rows.length) { x.font = `500 38px ${SANS}`; x.textAlign = 'center'; x.fillText('No agents on this floor', W / 2, H / 2 + 40); x.textAlign = 'left'; }
  const rowH = Math.min(342, (H - HEAD) / Math.max(1, rows.length));
  rows.forEach((r, i) => {
    const y = HEAD + i * rowH; term.rows.push({ y0: y, y1: y + rowH, m: r.m });
    if (i) { x.fillStyle = '#1D2A31'; x.fillRect(40, y, W - 80, 2); }
    x.fillStyle = r.color; x.beginPath(); x.arc(58, y + 46, 16, 0, 7); x.fill();
    x.fillStyle = '#F2F5F6'; x.font = '700 40px "Bricolage Grotesque", sans-serif'; const name = fitText(x, r.name, 640); x.fillText(name, 90, y + 60);
    const nx = 90 + x.measureText(name).width + 24; x.fillStyle = STATUS[r.state].hex; x.font = `600 28px ${SANS}`; x.fillText(STATUS[r.state].label, nx, y + 58);
    x.font = `700 40px ${SANS}`; const right = r.tone === 'todo' ? `${r.count} to review` : r.tone === 'clear' ? 'All reviewed ✓' : fitText(x, r.note, 700), lim = W - 72 - x.measureText(right).width;
    x.font = `600 28px ${SANS}`; let sx = nx + x.measureText(STATUS[r.state].label).width + 36;
    for (let k = 0; k < r.subs.length; k++) { const s = r.subs[k], nm = fitText(x, s.name, 280), st = STATUS[s.state], w = 26 + x.measureText(nm).width + 12 + x.measureText(st.label).width, rest = r.subs.length - k;
      if (sx + w > lim - (rest > 1 ? 70 : 0)) { x.fillStyle = '#7D8F98'; x.fillText(`+${rest}`, sx, y + 58); break; }   // never run into the review count
      x.fillStyle = s.color; x.beginPath(); x.arc(sx + 8, y + 48, 8, 0, 7); x.fill();
      x.fillStyle = '#DDE7EB'; x.fillText(nm, sx + 26, y + 58); x.fillStyle = st.hex; x.fillText(st.label, sx + 26 + x.measureText(nm).width + 12, y + 58); sx += w + 32; }
    x.textAlign = 'right'; x.fillStyle = TONE[r.tone]; x.font = `700 40px ${SANS}`; x.fillText(right, W - 40, y + 60);
    x.fillStyle = '#7D8F98'; x.font = `500 26px ${SANS}`; if (r.total) x.fillText(`+${r.add} −${r.del} · ${r.total} changed`, W - 40, y + 104);
    x.textAlign = 'left'; x.font = `500 26px ${MONO}`;
    if (r.run) { x.fillStyle = r.run.failed ? '#FF7B72' : '#6FD69A'; x.fillText(fitText(x, `${r.run.failed ? '✗' : '✓'} ${r.run.cmd}`, 1280) + ` · ${hm(r.run.at)}`, 90, y + 104); }
    const lines = Math.floor((rowH - 124) / 38), slots = lines * 2, over = r.files.length > slots ? r.files.length - slots + 1 : 0;
    r.files.slice(0, over ? slots - 1 : slots).forEach((f, k) => { const fx = 90 + (k % 2) * 964, fy = y + 150 + Math.floor(k / 2) * 38;
      if (f.fresh) { x.fillStyle = f.color || r.color; x.beginPath(); x.arc(fx - 20, fy - 9, 7, 0, 7); x.fill(); }
      x.fillStyle = '#DDE7EB'; x.fillText(fitTail(x, f.path, 700), fx, fy);
      x.textAlign = 'right'; x.fillStyle = '#7D8F98'; x.fillText(f.add == null ? 'binary' : `+${f.add} −${f.del}`, fx + 900, fy); x.textAlign = 'left'; });
    if (over && slots) { x.fillStyle = '#7D8F98'; x.fillText(`and ${over} more`, 90 + ((slots - 1) % 2) * 964, y + 150 + Math.floor((slots - 1) / 2) * 38); }
  });
  term.t.needsUpdate = true;
}
function drawLatestEdit(le) {
  const x = board.x, W = 1536, H = 560;
  x.textAlign = 'left'; x.fillStyle = '#F7F8F6'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#5B6A72'; x.font = `600 30px ${SANS}`; x.fillText('L A T E S T   E D I T', 44, 62);
  x.fillStyle = '#C9D1D4'; x.fillRect(44, 84, W - 88, 3);
  if (!le) { x.fillStyle = '#6A7A82'; x.font = `500 34px ${SANS}`; x.fillText('No edits reported on this floor yet', 44, 150); board.t.needsUpdate = true; return; }
  x.textAlign = 'right'; x.fillText(hm(le.at), W - 44, 62); x.textAlign = 'left';
  x.fillStyle = le.who.color; x.beginPath(); x.arc(60, 134, 14, 0, 7); x.fill();
  x.fillStyle = '#15212A'; x.font = `600 34px ${SANS}`; const who = fitText(x, le.who.name, 420); x.fillText(who, 88, 146);
  const fx = 88 + x.measureText(who).width + 24; x.font = `500 32px ${MONO}`; x.fillText(fitTail(x, le.file, W - 44 - fx), fx, 146);
  x.fillStyle = '#101A20'; rrect(x, 36, 178, W - 72, 346, 16); x.fill();
  const ed = codeOn && le.edit, all = ed ? [...ed.del.map(l => ['-', l]), ...ed.add.map(l => ['+', l])] : [];
  const cut = all.length > EDIT_ROWS || (ed && ed.more) ? EDIT_ROWS - 1 : EDIT_ROWS;
  x.font = `500 28px ${MONO}`;
  all.slice(0, cut).forEach(([sign, l], k) => { const y = 196 + k * 39;
    x.fillStyle = sign === '+' ? 'rgba(82,201,111,.16)' : 'rgba(255,123,114,.16)'; x.fillRect(36, y, W - 72, 39);
    x.fillStyle = sign === '+' ? '#8FE3AE' : '#FF9B93'; x.fillText(fitText(x, `${sign} ${l}`, W - 120), 60, y + 28); });
  const rest = all.length - Math.min(all.length, cut) + (ed ? ed.more : 0);
  x.fillStyle = '#7D8F98';
  if (!all.length) x.fillText(codeOn ? 'No changed lines were reported for this edit' : 'Code is hidden. Turn on “Show code” in Customize.', 60, 230);
  else if (rest) x.fillText(`${rest} more line${rest === 1 ? '' : 's'}`, 60, 196 + cut * 39 + 28);
  board.t.needsUpdate = true;
}
// Redrawn only when what they show has changed.
let screenSig = '';
function drawScreens(force) {
  const mains = boardMains(), now = Date.now(), zoomed = viewMode === 'screen';
  const rows = mains.map(m => { const c = changesOf(m); if (m.live && !c) loadChanges(m); return reviewRow(m, c, c && c.ok ? reviewedOf(c.root).sigs : {}, now, agents.filter(a => a.parent === m && !a.gone)); });
  const le = mains.map(m => m.lastEdit).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
  const sig = JSON.stringify([curFloor.name, zoomed, codeOn, rows.map(r => ({ ...r, m: r.m.id })), le && [le.at, le.file, le.who.id, le.edit]]);
  if (!force && sig === screenSig) return; screenSig = sig;
  drawReviewBoard(rows, zoomed); drawLatestEdit(le);
}
