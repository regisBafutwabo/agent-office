/* ---------- first visit and the replayable office tour ---------- */
let guideStep = -1, guideOpener = null, tourAfterCity = false;
const GUIDE_STEPS = [
  { title: 'Every project gets a floor', body: 'Your coding sessions share an office. Use the floor buttons to visit a project; drag the scene to look around and scroll to zoom.', target: '#lift' },
  { title: 'Meet your teammates', body: 'Click an agent in the office or the Agents list to see its activity. Thinking and Working mean it’s busy; Done means it has finished. No agents yet? Try the demo to meet a sample team.', target: '#panel' },
  { title: 'Connect your coding tools', body: 'Connect each tool once, then start a new coding session and send a prompt. Its agent will arrive in your office. Connection status appears below.', target: '#connect-list' },
  { title: 'Know when you’re needed', body: 'A yellow marker and a knock mean an agent needs you. Select it to see the request. Use Open chat to continue in your coding app; Allow and Deny appear when a permission request is available.', target: '#detail' },
];
function setCrew(crew) {
  if (!['pets', 'robots'].includes(crew)) return;
  uiPrefs.crew = crew; saveUi();
  // Rebuild avatars in place: switching crews keeps sessions, seats and activity intact.
  for (const a of agents) { buildRig(a); a.labelDirty = true; }
  faceCache.clear(); uiDirty = detailDirty = true;
  buildCustomize(); syncCrewButtons(); agents.forEach(sendFaces);
}
function syncCrewButtons() {
  document.querySelectorAll('[data-crew]').forEach(b => b.setAttribute('aria-pressed', b.dataset.crew === (uiPrefs.crew || 'robots')));
}
document.querySelectorAll('[data-crew]').forEach(b => { b.onclick = () => setCrew(b.dataset.crew); });
function openWelcome() {
  guideOpener = document.activeElement;
  syncCrewButtons(); $('#welcome').showModal();
  $('#welcome [aria-pressed="true"]').focus();
}
function leaveWelcome(tour) {
  if (!uiPrefs.crew) setCrew('robots');
  $('#welcome').close();
  if (!tour) { uiPrefs.guideDone = true; delete uiPrefs.guideStep; saveUi(); }
  if (!Object.hasOwn(CITIES, uiPrefs.city)) {
    tourAfterCity = tour; $('#city-picker').showModal(); $('#city-choices [aria-pressed="true"]')?.focus();
  } else if (tour) startGuide(0);
  else restoreGuideFocus();
}
$('#welcome-next').onclick = () => leaveWelcome(true);
$('#welcome-skip').onclick = () => leaveWelcome(false);
$('#welcome').addEventListener('cancel', e => { e.preventDefault(); leaveWelcome(false); });
$('#city-picker').addEventListener('close', () => { if (tourAfterCity) { tourAfterCity = false; startGuide(0); } });
$('#replay-guide').onclick = () => { finishGuide(false); openWelcome(); };
function startGuide(step = 0) {
  guideStep = Math.max(0, Math.min(GUIDE_STEPS.length - 1, step));
  uiPrefs.guideDone = false; uiPrefs.guideStep = guideStep; saveUi();
  $('#office-guide').hidden = false; renderGuide();
}
function clearGuideTarget() { document.querySelectorAll('.guide-target').forEach(el => el.classList.remove('guide-target')); }
function renderGuide() {
  clearGuideTarget(); const step = GUIDE_STEPS[guideStep];
  $('#guide-step').textContent = `Office tour · ${guideStep + 1} of ${GUIDE_STEPS.length}`;
  $('#guide-title').textContent = step.title; $('#guide-body').textContent = step.body;
  $('#guide-back').hidden = guideStep === 0; $('#guide-next').textContent = guideStep === 3 ? 'Start using my office' : 'Next';
  $('#office-guide').dataset.detail = guideStep === 3 && !!selected;
  if (guideStep === 0) setLiftOpen(true);
  const tab = $('#panel .tabs [data-tab="' + (guideStep === 2 ? 'custom' : 'agents') + '"]');
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  setPanelOpen(!isMobile() || ![0, 3].includes(guideStep));
  if (guideStep === 1) select(null);
  if (guideStep === 2) { select(null); $('#connect-list').scrollIntoView({ block: 'nearest' }); }
  if (guideStep === 3 && !selected) { const a = agents.find(a => a.kind === 'main'); if (a) select(a, true); }
  const target = $(step.target); if (target && !target.hidden) target.classList.add('guide-target');
  const action = $('#guide-action'); action.hidden = ![1, 3].includes(guideStep);
  action.textContent = agents.some(a => a.kind === 'main') ? (guideStep === 1 ? 'View an agent' : 'View activity') : 'Try demo';
  renderGuideTools(); $('#guide-title').focus();
}
function renderGuideTools() {
  const el = $('#guide-tools'); if (guideStep !== 2) { el.replaceChildren(); return; }
  const activeTool = el.contains(document.activeElement) ? document.activeElement.dataset.connect : null;
  if (MODE === 'demo') el.innerHTML = '<p class="note">You’re exploring sample agents. Connect your own tools in your live office.</p><a class="btn" href="?tour">Go to live office</a>';
  else if (setup.tools?.length) el.innerHTML = setup.tools.map(t => `<div class="connect-row"><span>${esc(t.name)}</span>${t.status === 'connected' ? '<span class="pill s-done">Connected</span>' : t.status === 'not-installed' ? '<span class="state">Not installed</span>' : `<button class="btn" data-connect="${t.id}"${setup.busy ? ' disabled' : ''}>${setup.busy === t.id ? 'Connecting…' : t.status === 'needs-repair' ? 'Reconnect' : 'Connect'}</button>`}</div>`).join('');
  else el.innerHTML = '<p class="note">The Mac app has one-click connection buttons. If you run the browser office from source, follow the setup guide to connect your tools.</p><a class="btn" href="https://github.com/regisBafutwabo/agent-office/blob/main/INSTALL.md#from-source" target="_blank" rel="noopener">Open setup guide ↗</a>';
  if (activeTool) el.querySelector(`[data-connect="${activeTool}"]`)?.focus();
}
$('#guide-action').onclick = () => {
  const a = selected || agents.find(a => a.kind === 'main');
  if (!a) { location.href = '?demo&tour'; return; }
  select(a, true); if (guideStep === 3) showDetailTab('activity');
};
function finishGuide(complete = true) {
  guideStep = -1; clearGuideTarget(); $('#office-guide').hidden = true;
  if (complete) { uiPrefs.guideDone = true; delete uiPrefs.guideStep; saveUi(); restoreGuideFocus(); }
}
function restoreGuideFocus() { (guideOpener && guideOpener !== document.body && guideOpener.isConnected ? guideOpener : $('#view-3d')).focus(); }
$('#guide-next').onclick = () => guideStep === 3 ? finishGuide() : startGuide(guideStep + 1);
$('#guide-back').onclick = () => startGuide(guideStep - 1);
$('#guide-skip').onclick = () => finishGuide();
$('#office-guide').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); finishGuide(); } });
