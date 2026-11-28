/* ---------- first visit and the replayable office tour ---------- */
let guideStep = -1, guideOpener = null, tourAfterCity = false, guideLayout = null;
// `fallback` is outlined when `target` is hidden: an office with no tools or no agents yet still shows where to look.
// `empty` replaces `body` when there are no agents, so the step never describes things that aren't on screen.
const GUIDE_STEPS = [
  { title: 'Every project gets a floor', body: 'Each coding agent is a character in this office, and each project has its own floor. Pick a floor here. Drag to look around; scroll or pinch to zoom.', target: '#lift' },
  { title: 'Meet your teammates', body: 'Click an agent to see what it is doing. Thinking and Working mean it’s busy, Done means it has finished, and Needs you means it is waiting for you. No agents yet? Try the demo to meet a sample team.', target: '#panel' },
  { title: 'Connect your coding tools', body: 'Connect each tool once. Then start a new chat in that tool and send a message. Its agent walks into your office.', target: '#connect-list', fallback: '#panel' },
  { title: 'Know when you’re needed', body: 'An amber marker and a soft knock mean an agent is waiting for you. Click it to see what it needs, then answer here or open it in your coding app. You can replay this tour from Customize.',
    empty: 'When an agent is waiting for you, it gets an amber marker and knocks. Click it to see what it needs. No agents yet? Try the demo to see one. You can replay this tour from Customize.',
    target: '#detail', fallback: '#panel' },
];
const GUIDE_LAST = GUIDE_STEPS.length - 1;
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
  // The tour opens panels and switches tabs, and those choices are saved; remember the person's own layout to put it back.
  if (guideStep < 0) guideLayout = { lift: uiPrefs.lift !== false, panel: uiPrefs.panel !== false, tab: $('#panel .tabs [aria-selected="true"]')?.dataset.tab };
  guideStep = Math.max(0, Math.min(GUIDE_STEPS.length - 1, step));
  uiPrefs.guideDone = false; uiPrefs.guideStep = guideStep; saveUi();
  $('#office-guide').hidden = false; appEl.classList.add('touring'); renderGuide();
}
function clearGuideTarget() { document.querySelectorAll('.guide-target').forEach(el => el.classList.remove('guide-target')); }
function renderGuide() {
  clearGuideTarget(); const step = GUIDE_STEPS[guideStep], hasAgents = agents.some(a => a.kind === 'main');
  $('#guide-step').textContent = `Office tour · ${guideStep + 1} of ${GUIDE_STEPS.length}`;
  $('#guide-title').textContent = step.title; $('#guide-body').textContent = !hasAgents && step.empty || step.body;
  $('#guide-back').hidden = guideStep === 0; $('#guide-next').textContent = guideStep === GUIDE_LAST ? 'Start using my office' : 'Next';
  $('#office-guide').dataset.detail = guideStep === GUIDE_LAST && !!selected;
  if (guideStep === 0) setLiftOpen(true);
  const tab = $('#panel .tabs [data-tab="' + (guideStep === 2 ? 'custom' : 'agents') + '"]');
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  setPanelOpen(!isMobile() || ![0, GUIDE_LAST].includes(guideStep));
  if (guideStep === 1) select(null);
  if (guideStep === 2) { select(null); $('#connect-list').scrollIntoView({ block: 'nearest' }); }
  if (guideStep === GUIDE_LAST && !selected) { const a = agents.find(a => a.kind === 'main'); if (a) select(a, true); }
  const shown = sel => { const el = sel && $(sel); return el && !el.hidden ? el : null; };
  shown(step.target) ? shown(step.target).classList.add('guide-target') : shown(step.fallback)?.classList.add('guide-target');
  const action = $('#guide-action'); action.hidden = ![1, GUIDE_LAST].includes(guideStep);
  action.textContent = hasAgents ? (guideStep === 1 ? 'View an agent' : 'View activity') : 'Try demo';
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
  select(a, true); if (guideStep === GUIDE_LAST) showDetailTab('activity');
};
function finishGuide(complete = true) {
  if (guideStep < 0) return;
  guideStep = -1; clearGuideTarget(); $('#office-guide').hidden = true; appEl.classList.remove('touring');
  if (guideLayout) {
    const { lift, panel, tab } = guideLayout; guideLayout = null;
    setLiftOpen(lift);
    const b = tab && $('#panel .tabs [data-tab="' + tab + '"]'); if (b && b.getAttribute('aria-selected') !== 'true') b.click();
    setPanelOpen(panel);
  }
  if (complete) { uiPrefs.guideDone = true; delete uiPrefs.guideStep; saveUi(); restoreGuideFocus(); }
}
function restoreGuideFocus() { (guideOpener && guideOpener !== document.body && guideOpener.isConnected ? guideOpener : $('#view-3d')).focus(); }
$('#guide-next').onclick = () => guideStep === GUIDE_LAST ? finishGuide() : startGuide(guideStep + 1);
$('#guide-back').onclick = () => startGuide(guideStep - 1);
$('#guide-skip').onclick = () => finishGuide();
// Escape ends the tour from anywhere on the page: step 2 sends focus to an agent, away from the card.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || guideStep < 0 || e.target.closest('input,textarea,select,dialog')) return;
  finishGuide();
});
// A reload mid-tour starts the guide before the live office has its agents; redraw the step once they arrive.
function guideOnAgents() { if (guideStep >= 0) renderGuide(); }
