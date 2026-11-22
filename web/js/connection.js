function connectLive() {
  document.body.classList.add('live'); setSpeed(1); setModeLine();
  let ws;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws', officeAuth.protocols()); }
  catch (_) { startDemo(); return; }
  const fallback = setTimeout(() => { if (!live.everConnected) { try { ws.close(); } catch (_) {} explainLocked(); startDemo(); } }, 2500);
  live.ws = ws;
  ws.onopen = () => { live.connected = live.everConnected = true; clearTimeout(fallback); setModeLine(); sendPresence(); loadSetup();
    if (musicOn) ws.send(JSON.stringify({ type: 'music', on: true }));
    if (uiPrefs.code === false) ws.send(JSON.stringify({ type: 'code', show: false })); };
  ws.onmessage = m => { let msg; try { msg = JSON.parse(m.data); } catch (_) { return; }
    if (msg.type === 'snapshot') onSnapshot(msg); else if (msg.type === 'event') onLiveEvent(msg.event, false);
    else if (msg.type === 'focus-result') toast(msg.message);
    else if (msg.type === 'code') setCodeOn(!!msg.show);
    else if (msg.type === 'music') music = musicOn && msg.music || null;
    else if (msg.type === 'setup') loadSetup();
    else if (msg.type === 'approval') onApproval(msg.approval, true); else if (msg.type === 'approval-resolved') onApprovalResolved(msg); else if (msg.type === 'hooks-outdated') onOutdatedHooks(msg.hooks); };
  ws.onclose = () => {
    clearTimeout(fallback);
    if (!live.everConnected) { explainLocked(); startDemo(); return; }
    live.connected = false; setModeLine(); updateMusicBtn(); setTimeout(connectLive, 2000);
  };
}

// A server that answers but refuses this browser's key: say how to open the office with it.
function explainLocked() {
  if (live.lockedSaid) return; live.lockedSaid = true;
  officeAuth.fetch('/api/auth').then(r => { if (r.status === 401) toast('This office needs its key. Open it from the Agent Office menu (Open in browser), or with the link the office server printed. Showing the demo meanwhile.'); }).catch(() => {});
}
