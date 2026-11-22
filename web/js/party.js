/* ---------- rooftop party: after dark a DJ plays, the fire pit burns and the bar opens ---------- */
let nightT = 0;                                                  // 0 by day, 1 at night (set by applyScene)
const isParty = () => nightT > .5;
const canDance = a => isParty() && a.onRoof && a.spot?.type === 'dance';
const BPM = 118, partyBeat = () => performance.now() / 1000 * BPM / 60;
const PARTY_COLORS = ['#FF4FA3', '#7C6CF2', '#3DCBE0', '#F5B342', '#52C96F'];
let partyBar = -1;
// What the DJ plays: your Spotify song, else your Apple Music song (the server asks the apps on this Mac),
// else plan B, DJ Bot's own office mix, a new made-up track every few minutes.
// Asking those apps makes macOS show a permission prompt, so it's off until you turn it on from the rooftop.
let music = null, musicSupported = false;
let musicOn = (() => { try { return localStorage.getItem('agent-office:music') === 'on'; } catch (_) { return false; } })();
function updateMusicBtn() {
  const b = $('#music-btn'); if (!b) return;
  b.hidden = !(viewMode === 'roof' && MODE === 'live' && live.connected && musicSupported);
  b.setAttribute('aria-pressed', musicOn);
  $('#music-label').textContent = musicOn ? 'My music is on' : 'Play my music';
  b.setAttribute('aria-label', $('#music-label').textContent);
  b.title = musicOn ? 'The DJ plays your Spotify or Apple Music song. Click to stop.' : 'Let the DJ play the song Spotify or Apple Music is playing on this Mac';
}
function setMusicOn(on) {
  musicOn = on; try { localStorage.setItem('agent-office:music', on ? 'on' : 'off'); } catch (_) {}
  if (!on) music = null;
  if (live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: 'music', on }));
  if (on) toast('The DJ will play what Spotify or Apple Music is playing. macOS asks once; nothing leaves your Mac.');
  updateMusicBtn();
}
$('#music-btn').onclick = () => setMusicOn(!musicOn);
const DJ_MIX = ['Merge Conflict (Club Mix)', 'Green Checks', 'Rebase at Midnight', 'Hotfix Hustle', 'Standup Shuffle',
  'Null Pointer Groove', 'Lint Free', 'Ship It Friday', '404 Love', 'Cache Me Outside', 'Works On My Machine', 'Deploy Disco'];
const MUSIC_LOOK = { spotify: ['NOW PLAYING ON SPOTIFY', '#1ED760'], music: ['NOW PLAYING ON APPLE MUSIC', '#FA586A'], mix: ["DJ BOT'S OFFICE MIX", '#8BE9F5'] };
const nowPlaying = () => music || { source: 'mix', title: DJ_MIX[Math.floor(Date.now() / 200_000) % DJ_MIX.length], artist: 'DJ Bot' };
let screenKey = '';
function drawDjScreen(np) {
  const key = `${np.source}|${np.title}|${np.artist}`; if (key === screenKey) return; screenKey = key;
  const { x, t } = PARTY.screen, [label, col] = MUSIC_LOOK[np.source] || MUSIC_LOOK.mix;
  const fit = (text, w) => { if (x.measureText(text).width <= w) return text;
    while (text.length > 1 && x.measureText(text + '…').width > w) text = text.slice(0, -1); return text.trimEnd() + '…'; };
  x.clearRect(0, 0, 512, 160); x.fillStyle = '#0B1216'; rrect(x, 4, 4, 504, 152, 18); x.fill();
  x.textAlign = 'center'; x.shadowColor = col; x.shadowBlur = 12; x.fillStyle = col;
  x.font = '700 22px "Bricolage Grotesque", sans-serif'; x.fillText(`♪  ${label}  ♪`, 256, 40);
  x.fillStyle = '#F4F7F8'; x.font = '700 46px "Bricolage Grotesque", sans-serif'; x.fillText(fit(np.title, 470), 256, 94);
  x.shadowBlur = 0; x.fillStyle = '#AFC0C7'; x.font = '500 28px "Bricolage Grotesque", sans-serif'; x.fillText(fit(np.artist || '', 470), 256, 134);
  t.needsUpdate = true;
}
function updateParty(dt) {
  PARTY.group.visible = isParty(); PARTY.booth.visible = isParty() || !!music;
  if (!roofGroup.visible || !PARTY.booth.visible) return;
  const t = performance.now() / 1000, beat = partyBeat(), pulse = Math.pow(1 - beat % 1, 3), o = Math.max(0, shellT), n = Math.floor(beat);
  PARTY.fade.forEach(([m, op]) => m.opacity = op * o);
  drawDjScreen(nowPlaying());
  if (!isParty()) {
    const dj = PARTY.dj; dj.pivot.position.y = 0; dj.head.rotation.x = 0;
    dj.armL.rotation.x = dj.armR.rotation.x = -1.15;
    return;
  }
  PARTY.decks.forEach(d => d.rotation.y += dt * 3.5);
  const dj = PARTY.dj, bar = Math.floor(beat / 4) % 2;             // the DJ nods, works the decks, and every other bar throws a hand up
  dj.pivot.position.y = pulse * .04; dj.head.rotation.x = .18 * pulse - .05;
  dj.armL.rotation.x = -1.15 + Math.sin(t * 9) * .12;
  dj.armR.rotation.x = bar ? -2.8 + .35 * pulse : -1.15 + Math.sin(t * 7 + 1) * .1;
  PARTY.more.forEach((m, k) => m.g.visible = PARTY.more.slice(k).some(x => x.spots.some(s => s.by)));
  if (n !== partyBar) {                                            // new beat: the dance floor changes colour
    partyBar = n;
    PARTY.tiles.forEach((tile, i) => { const c = PARTY_COLORS[(i * 7 + n * 3) % PARTY_COLORS.length];
      tile.material.color.set(((i * 13 + n * 5) % 3) ? mix(c, '#15191C', .7) : c); });
  }
  const col = PARTY_COLORS[Math.floor(beat / 4) % PARTY_COLORS.length];
  PARTY.beams.forEach(b => { b.yaw.rotation.y = b.s * .25 + Math.sin(t * 1.3 + b.s) * .55; b.m.color.set(col); b.m.opacity = .24 * o * (.55 + .45 * pulse); });
  PARTY.disco.color.set(col); PARTY.disco.intensity = (.7 + .8 * pulse) * o;
  PARTY.flames.forEach((f, i) => { f.scale.set(1 + .08 * Math.sin(t * 11 + i), 1 + .22 * Math.sin(t * (13 + i * 4)) * Math.sin(t * 7.1 + i), 1 + .08 * Math.cos(t * 9 + i)); f.rotation.y += dt * (i % 2 ? 1.5 : -1.1); });
  PARTY.fire.intensity = 2.4 * o * (.85 + .15 * Math.sin(t * 23) * Math.sin(t * 7.3));
  PARTY.sign.opacity = o * (Math.sin(t * 31) * Math.sin(t * 3.7) > .96 ? .45 : 1);   // the odd neon flicker
  const bk = PARTY.barkeep;                                        // the bartender shakes a cocktail and looks around
  bk.armR.rotation.x = -1.6 + .35 * Math.sin(t * 14); bk.armL.rotation.x = -.2; bk.head.rotation.y = .35 * Math.sin(t * .6);
}
