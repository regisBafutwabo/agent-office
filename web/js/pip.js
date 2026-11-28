/* ---------- float the office: a small window on top of other apps, like a video's picture-in-picture ---------- */
// The Mac app has its own mini office, a small window that stays on top (POST /api/mini). The Node bridge has no
// windows, so in a browser the 3D view plays as a video in the browser's picture-in-picture window instead.
// Chrome, Edge and Safari can do that; Firefox can't, so there the button stays hidden.
const pipBtn = $('#pip-btn');
let nativeMini = false, pipVideo = null, pipTimer = 0, pipLast = 0;
const browserPip = () => !!document.pictureInPictureEnabled && typeof canvas.captureStream === 'function';

async function setupFloat() {
  if (MINI) return;
  if (MODE === 'live') try { nativeMini = (await officeAuth.fetch('/api/mini')).ok; } catch (_) {}
  pipBtn.hidden = !nativeMini && !browserPip();
}

// A hidden tab gets no animation frames, so the floating video would freeze while you work in another window.
// Timers still run there (slower), so they move the office on and draw it for the video.
function pipTick() {
  if (!document.hidden) { pipLast = 0; return; }
  const now = performance.now();
  let dt = pipLast ? Math.min(2, (now - pipLast) / 1000) : .05; pipLast = now;
  if (!window.agentOffice.held) for (; dt > 0; dt -= .05) step(Math.min(.05, dt));
  renderer.render(scene, camera);
}

function stopPip() {
  clearInterval(pipTimer); pipTimer = 0; pipLast = 0;
  if (pipVideo) { pipVideo.srcObject?.getTracks().forEach(t => t.stop()); pipVideo.remove(); pipVideo = null; }
  pipBtn.setAttribute('aria-pressed', 'false');
}

async function floatOffice() {
  if (nativeMini) {
    let ok = false;
    try { ok = (await officeAuth.fetch('/api/mini', { method: 'POST' })).status === 202; } catch (_) {}
    if (!ok) toast("Couldn't open the mini office. Click the Agent Office icon near the clock and choose Mini Office.");
    return;
  }
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
  try {
    pipVideo = document.createElement('video');
    Object.assign(pipVideo, { muted: true, playsInline: true, className: 'pip-source', srcObject: canvas.captureStream(30) });
    pipVideo.setAttribute('aria-hidden', 'true');
    document.body.appendChild(pipVideo);   // Safari only floats a video that is in the page
    pipVideo.addEventListener('leavepictureinpicture', stopPip);
    await pipVideo.play();
    await pipVideo.requestPictureInPicture();
    pipBtn.setAttribute('aria-pressed', 'true');
    pipTimer = setInterval(pipTick, 100);
  } catch (_) {
    stopPip();
    toast("This browser couldn't float the office. Try Chrome or Safari, or the Agent Office app for Mac.");
  }
}

pipBtn.onclick = floatOffice;
officeAuth.ready.then(setupFloat);
