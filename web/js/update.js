/* ---------- a new version of the desktop app: offered in the corner until you close it ---------- */
// The desktop app downloads updates in the background and says which one is waiting (GET /api/update).
// The Node bridge has no such route, so in a browser this stays hidden. Closing it hides that version for good;
// a newer one shows again.
const UPDATE_SKIP_KEY = 'agent-office:update-closed', UPDATE_CHECK_MS = 10 * 60 * 1000;
const RELEASE_PAGE = 'https://github.com/regisBafutwabo/agent-office/releases';
const updateEl = $('#update-toast');
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
  $('#update-notes').href = `${RELEASE_PAGE}/tag/v${encodeURIComponent(v)}`;
  $('#update-go').disabled = false; $('#update-go').textContent = 'Restart to update';
  updateEl.hidden = false;
}
$('#update-go').onclick = async () => {
  const b = $('#update-go'); b.disabled = true; b.textContent = 'Restarting…';
  let ok = false;
  try { ok = (await officeAuth.fetch('/api/update', { method: 'POST' })).status === 202; } catch (_) {}
  if (!ok) { b.disabled = false; b.textContent = 'Restart to update'; toast("Couldn't install the update here. Get it from the release page.", 'Open', () => window.open(RELEASE_PAGE, '_blank', 'noopener')); }
};
$('#update-close').onclick = () => {
  try { localStorage.setItem(UPDATE_SKIP_KEY, updateEl.dataset.version || ''); } catch (_) {}
  updateEl.hidden = true;
};
officeAuth.ready.then(() => { checkForUpdate(); setInterval(checkForUpdate, UPDATE_CHECK_MS); });
