// "Open in …": bring the app, window or terminal tab where an agent runs to the front (macOS only).
// Mirrors desktop/src-tauri/src/focus.rs: a fixed list of apps, a validated tty, and no shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APPS = {
  'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm', 'dev.warp.Warp-Stable': 'Warp', 'com.mitchellh.ghostty': 'Ghostty',
  'net.kovidgoyal.kitty': 'kitty', 'com.github.wez.wezterm': 'WezTerm', 'org.alacritty': 'Alacritty',
  'com.todesktop.230313mzl4w4u92': 'Cursor', 'com.microsoft.VSCode': 'VS Code', 'com.exafunction.windsurf': 'Windsurf', 'dev.zed.Zed': 'Zed',
  'com.anthropic.claudefordesktop': 'Claude', 'com.openai.codex': 'Codex', 'com.openai.chat': 'ChatGPT',
};
const EDITORS = new Set(['com.todesktop.230313mzl4w4u92', 'com.microsoft.VSCode', 'com.exafunction.windsurf', 'dev.zed.Zed']);
const FROM_TERM = { Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', WarpTerminal: 'dev.warp.Warp-Stable', ghostty: 'com.mitchellh.ghostty', WezTerm: 'com.github.wez.wezterm' };

export const validTty = t => /^ttys?\d{1,4}$/.test(t || '');
// Chat ids: the Claude desktop app's session (CLAUDE_CODE_HOST_SESSION_ID) and a Codex thread (its hook session id).
export const validChat = c => /^local_[A-Za-z0-9-]{1,64}$/.test(c || '');
const CODEX_THREAD = /^codex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The link that opens this exact chat in its desktop app, or null when the agent runs somewhere else (a terminal, an editor). */
export function chatLink({ agent, id, chat, app, term }) {
  if (validChat(chat)) return { bundle: 'com.anthropic.claudefordesktop', url: `claude://code/continue?session=${chat}&source=agent_office` };
  const m = CODEX_THREAD.exec(id || '');
  if (agent === 'codex' && m && !term && (!app || app === 'com.openai.codex')) return { bundle: 'com.openai.codex', url: `codex://threads/${m[1]}` };
  return null;
}
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));

const TERMINAL_SCRIPT = dev => `tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${dev}" then
        set selected tab of w to t
        set index of w to 1
        return "found"
      end if
    end repeat
  end repeat
  return "missing"
end tell`;
const ITERM_SCRIPT = dev => `tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${dev}" then
          select w
          tell t to select
          tell s to select
          return "found"
        end if
      end repeat
    end repeat
  end repeat
  return "missing"
end tell`;

/** Resolves to a short message ("Opened the Terminal tab"); rejects with the reason it couldn't. */
export async function focus({ agent, id, chat, app, term, tty, cwd }) {
  if (process.platform !== 'darwin') throw new Error('Opening apps from the office only works on macOS for now.');
  const link = chatLink({ agent, id, chat, app, term });
  if (link) { await run('open', [link.url]); return `Opened the chat in ${APPS[link.bundle]}`; }
  const bundle = APPS[app] ? app : FROM_TERM[term];
  if (!bundle) throw new Error("This agent's app isn't known yet. Start a new session and try again.");
  const name = APPS[bundle], dev = validTty(tty) ? `/dev/${tty}` : null;
  if (dev && bundle === 'com.apple.Terminal') return (await run('osascript', ['-e', TERMINAL_SCRIPT(dev)])) === 'found' ? 'Opened the Terminal tab' : 'Opened Terminal (that tab is closed)';
  if (dev && bundle === 'com.googlecode.iterm2') return (await run('osascript', ['-e', ITERM_SCRIPT(dev)])) === 'found' ? 'Opened the iTerm tab' : 'Opened iTerm (that tab is closed)';
  if (EDITORS.has(bundle) && cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) { await run('open', ['-b', bundle, cwd]); return `Opened the project in ${name}`; }
  await run('open', ['-b', bundle]);
  return `Opened ${name}`;
}

// Real app icons for the office, straight from macOS, so nobody's artwork ships with the repo.
const ICON_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  if (!url || url.isNil()) return 'missing';
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(url.path);
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(argv[1], true);
  return 'ok';
}`;
export const validBundle = id => /^[A-Za-z0-9][A-Za-z0-9.-]{2,119}$/.test(id || '') && id.includes('.');
const icons = new Map();
/** Resolves to a 128px PNG Buffer of an installed app's icon, or null if it isn't installed. */
export function appIcon(bundle) {
  if (process.platform !== 'darwin' || !validBundle(bundle)) return Promise.resolve(null);
  if (!icons.has(bundle)) icons.set(bundle, (async () => {
    const dir = path.join(os.tmpdir(), 'agent-office-icons'); fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, `${bundle}-full.png`), small = path.join(dir, `${bundle}.png`);
    try {
      if ((await run('osascript', ['-l', 'JavaScript', '-e', ICON_SCRIPT, bundle, full])) !== 'ok') return null;
      await run('sips', ['-Z', '128', full, '--out', small]);
      return fs.readFileSync(small);
    } catch { return null; }
  })());
  return icons.get(bundle);
}
