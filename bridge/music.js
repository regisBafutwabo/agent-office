// Now playing, for the rooftop DJ: the song on this Mac's Spotify, else Apple Music (macOS only).
// Mirrors desktop/src-tauri/src/music.rs. It only asks an app that's already running, so it never opens one,
// and nothing leaves the machine. macOS asks once before the office may read Spotify or Music, so it only
// starts once a viewer turns on "Play my music" at the rooftop.
import { execFile } from 'node:child_process';

export const NOW_PLAYING_SCRIPT = `function run() {
  for (const [id, source] of [['com.spotify.client', 'spotify'], ['com.apple.Music', 'music']]) {
    try {
      const app = Application(id);
      if (!app.running()) continue;
      if (app.playerState() !== 'playing') continue;
      const t = app.currentTrack();
      return JSON.stringify({ source, title: t.name(), artist: t.artist(), album: t.album() });
    } catch (e) {}
  }
  return '';
}`;
const POLL_MS = 5_000;
const SOURCES = new Set(['spotify', 'music']);
const clip = v => typeof v === 'string' ? v.trim().slice(0, 120) : '';

/** The script's output as { source, title, artist, album }, or null when nothing is playing. */
export function parseNowPlaying(out) {
  let v; try { v = JSON.parse(out); } catch { return null; }
  if (!v || !SOURCES.has(v.source) || !clip(v.title)) return null;
  return { source: v.source, title: clip(v.title), artist: clip(v.artist), album: clip(v.album) };
}

const nowPlaying = () => new Promise(resolve =>
  execFile('osascript', ['-l', 'JavaScript', '-e', NOW_PLAYING_SCRIPT], { timeout: 4_000 }, (err, stdout) => resolve(err ? null : parseNowPlaying(stdout.trim()))));

/** Checks every few seconds while `watched()` is true, and calls `onChange(music)` when the song changes or stops.
 *  When nobody wants it any more, the song goes back to null. */
export function watchMusic(onChange, watched) {
  if (process.platform !== 'darwin') return;
  let last = 'null', busy = false;
  setInterval(async () => {
    if (busy) return;
    if (!watched()) { if (last !== 'null') { last = 'null'; onChange(null); } return; }
    busy = true;
    const music = await nowPlaying();
    busy = false;
    if (JSON.stringify(music) !== last) { last = JSON.stringify(music); onChange(music); }
  }, POLL_MS).unref();
}
