/* ---------- a new version of the desktop app: offered in the corner until you close it ---------- */
// The desktop app downloads updates in the background and says which one is waiting (GET /api/update).
// The Node bridge has no such route, so in a browser this stays hidden. Closing it hides that version for good;
// a newer one shows again.
const UPDATE_SKIP_KEY = 'agent-office:update-closed', UPDATE_CHECK_MS = 10 * 60 * 1000;
const RELEASE_PAGE = 'https://github.com/regisBafutwabo/agent-office/releases';
const updateEl = $('#update-toast'), whatsNew = $('#whats-new');
let updateInfo = null;
const closedVersion = () => { try { return localStorage.getItem(UPDATE_SKIP_KEY); } catch (_) { return null; } };

async function checkForUpdate() {
  if (MODE !== 'live') return;
  let info = null;
  try { const r = await officeAuth.fetch('/api/update'); if (r.ok) info = await r.json(); } catch (_) {}
  const v = info && typeof info.version === 'string' ? info.version : null;
  if (!v || v === closedVersion()) { updateEl.hidden = true; return; }
  if (!updateEl.hidden && updateEl.dataset.version === v) return;
  updateEl.dataset.version = v;
  $('#update-text').innerHTML = `<b>Agent Office ${esc(v)} is ready</b><span>You have ${esc(info.current || 'an older version')}. Restart to update; it takes a few seconds.</span>`;
  updateInfo = { version: v, notes: typeof info.notes === 'string' ? info.notes : '' };
  for (const b of [$('#update-go'), $('#wn-go')]) { b.disabled = false; b.textContent = 'Restart to update'; }
  updateEl.hidden = false;
}
// The release's notes, written for people rather than developers: "- " lines are a list, **words** are bold.
// Releases before 0.5.10 only carried a link, so those get a short line and the link instead.
function notesHtml(text, version) {
  const page = `${RELEASE_PAGE}/tag/v${encodeURIComponent(version)}`;
  if (!text.trim() || /^See https?:\/\/\S+$/.test(text.trim())) return `<p>Version ${esc(version)} has fixes and improvements. <a href="${page}" target="_blank" rel="noopener">Read about it</a>.</p>`;
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', list = false;
  for (const line of text.split('\n')) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(item[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    const words = line.replace(/^#+\s*/, '').trim();
    if (words) html += `<p>${inline(words)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
$('#update-notes').onclick = () => {
  if (!updateInfo) return;
  $('#wn-title').textContent = `What's new in ${updateInfo.version}`;
  $('#wn-body').innerHTML = notesHtml(updateInfo.notes, updateInfo.version);
  whatsNew.showModal();
};
$('#wn-later').onclick = () => whatsNew.close();
async function restartToUpdate() {
  const buttons = [$('#update-go'), $('#wn-go')];
  for (const b of buttons) { b.disabled = true; b.textContent = 'Restarting…'; }
  let ok = false;
  try { ok = (await officeAuth.fetch('/api/update', { method: 'POST' })).status === 202; } catch (_) {}
  if (ok) return;
  for (const b of buttons) { b.disabled = false; b.textContent = 'Restart to update'; }
  whatsNew.close();
  toast("Couldn't install the update here. Get it from the release page.", 'Open', () => window.open(RELEASE_PAGE, '_blank', 'noopener'));
}
$('#update-go').onclick = $('#wn-go').onclick = restartToUpdate;
$('#update-close').onclick = () => {
  try { localStorage.setItem(UPDATE_SKIP_KEY, updateEl.dataset.version || ''); } catch (_) {}
  updateEl.hidden = true;
};
officeAuth.ready.then(() => { checkForUpdate(); setInterval(checkForUpdate, UPDATE_CHECK_MS); });
