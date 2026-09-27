// "Open in …": bring the app, window or terminal tab where an agent runs to the front (macOS only).
// Mirrors desktop/src-tauri/src/focus.rs: a fixed list of apps, a validated tty, and no shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

export const APPS = {
  'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm', 'dev.warp.Warp-Stable': 'Warp', 'com.mitchellh.ghostty': 'Ghostty',
  'net.kovidgoyal.kitty': 'kitty', 'com.github.wez.wezterm': 'WezTerm', 'org.alacritty': 'Alacritty',
  'com.todesktop.230313mzl4w4u92': 'Cursor', 'com.microsoft.VSCode': 'VS Code', 'com.exafunction.windsurf': 'Windsurf', 'dev.zed.Zed': 'Zed',
  'com.anthropic.claudefordesktop': 'Claude', 'com.openai.codex': 'Codex', 'com.openai.chat': 'ChatGPT',
};
const EDITORS = new Set(['com.todesktop.230313mzl4w4u92', 'com.microsoft.VSCode', 'com.exafunction.windsurf', 'dev.zed.Zed']);
const FROM_TERM = { Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', WarpTerminal: 'dev.warp.Warp-Stable', ghostty: 'com.mitchellh.ghostty', WezTerm: 'com.github.wez.wezterm' };

export const validTty = t => /^ttys?\d{1,4}$/.test(t || '');
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
export async function focus({ app, term, tty, cwd }) {
  if (process.platform !== 'darwin') throw new Error('Opening apps from the office only works on macOS for now.');
  const bundle = APPS[app] ? app : FROM_TERM[term];
  if (!bundle) throw new Error("This agent's app isn't known yet. Start a new session and try again.");
  const name = APPS[bundle], dev = validTty(tty) ? `/dev/${tty}` : null;
  if (dev && bundle === 'com.apple.Terminal') return (await run('osascript', ['-e', TERMINAL_SCRIPT(dev)])) === 'found' ? 'Opened the Terminal tab' : 'Opened Terminal (that tab is closed)';
  if (dev && bundle === 'com.googlecode.iterm2') return (await run('osascript', ['-e', ITERM_SCRIPT(dev)])) === 'found' ? 'Opened the iTerm tab' : 'Opened iTerm (that tab is closed)';
  if (EDITORS.has(bundle) && cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) { await run('open', ['-b', bundle, cwd]); return `Opened the project in ${name}`; }
  await run('open', ['-b', bundle]);
  return `Opened ${name}`;
}
