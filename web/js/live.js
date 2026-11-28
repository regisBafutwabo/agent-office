/* ---------- live mode: real Claude Code sessions from the bridge ---------- */
const params = new URLSearchParams(location.search);
const FAST = params.has('fast');                                   // shorter idle timers, handy when testing
const ENTRY = { desktop:'Desktop app', terminal:'Terminal', sdk:'SDK', 't3-code':'T3 Code', unknown:'Claude Code' };
const AGENT_NAMES = { codex:'Codex', cursor:'Cursor', gemini:'Gemini CLI', copilot:'Copilot', factory:'Droid', qwen:'Qwen Code',
  goose:'Goose', kiro:'Kiro', windsurf:'Windsurf', cline:'Cline', opencode:'OpenCode', amp:'Amp', ollama:'Ollama' };
// Apps the desktop app can bring forward (matches focus.rs / focus.js).
const HOST_APPS = { 'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm', 'dev.warp.Warp-Stable': 'Warp', 'com.mitchellh.ghostty': 'Ghostty',
  'net.kovidgoyal.kitty': 'kitty', 'com.github.wez.wezterm': 'WezTerm', 'org.alacritty': 'Alacritty', 'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.microsoft.VSCode': 'VS Code', 'com.exafunction.windsurf': 'Windsurf', 'dev.zed.Zed': 'Zed', 'com.anthropic.claudefordesktop': 'Claude',
  'com.openai.codex': 'Codex', 'com.openai.chat': 'ChatGPT', 'com.t3tools.t3code': 'T3 Code' };
const HOST_TERMS = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', WarpTerminal: 'Warp', ghostty: 'Ghostty', WezTerm: 'WezTerm' };
// Claude desktop sessions and Codex app threads open on the exact chat (chatLink in focus.rs / focus.js); the rest open their app or tab.
// T3 Code runs Claude, Codex and Cursor for you: its agents open T3 Code (no link to one thread yet), not those tools' apps.
const viaT3 = a => (a.parent || a).entrypoint === 't3-code';
const opensChat = a => { const s = a.parent || a; return viaT3(a) ? !!s.hostT3Thread : (!!s.hostChat || (s.agentName === 'codex' && !s.hostTerm && (!s.hostApp || s.hostApp === 'com.openai.codex'))); };
const hostName = a => { const s = a.parent || a; return viaT3(a) ? 'T3 Code' : HOST_APPS[s.hostApp] || HOST_TERMS[s.hostTerm] || (opensChat(a) ? (s.hostChat ? 'Claude' : 'Codex') : null); };
const openLabel = a => opensChat(a) ? `Open chat in ${hostName(a)}` : `Open in ${hostName(a)}`;
// A toast's buttons for one agent: open its chat (or app) when the office can, and Find, which flies to it.
const openOrFind = a => { const find = () => select(a, true);
  return hostName(a) ? [[opensChat(a) ? 'Open chat' : `Open in ${hostName(a)}`, () => openHost(a), true], ['Find', find]] : [['Find', find, true]]; };
function openHost(a) {
  const src = a.parent || a;
  if (!live.ws || live.ws.readyState !== 1) { toast('The office server isn’t connected'); return; }
  live.ws.send(JSON.stringify({ type: 'focus', sessionId: src.sessionId }));
}
const whereFrom = a => viaT3(a) ? `${AGENT_NAMES[a.agentName] || 'Claude Code'} in T3 Code` : AGENT_NAMES[a.agentName] || ENTRY[a.entrypoint] || 'Claude Code';   // "Terminal", "Desktop app", or the tool's name
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const MIN_STAY_MS = FAST ? 4000 : 20000;                           // don't bounce around on every tool call
const IDLE_BREAK_MS = FAST ? 8000 : 45000;                         // finished for a while: take a break
const IDLE_ROAM_MS = FAST ? [10000, 16000] : [50000, 90000];       // then drift between break spots every so often
const THINK_WANDER_MS = FAST ? 8000 : 30000;                       // a long think: maybe go grab a coffee
const REVIEW_MIN_S = 3, REVIEW_MAX_S = FAST ? 10 : 30;              // a main agent stands beside a finished subagent at least / at most this long
const REVIEW_GIVEUP_MS = FAST ? 60000 : 180000;                    // a finished subagent nobody came to see by now leaves anyway
const IDLE_ROOF_MS = FAST ? 20000 : 300000;                        // idle this long without a merge: head up to the terrace and chill
let MODE = params.has('demo') ? 'demo' : 'live';
const live = { byId: new Map(), connected: false, everConnected: false, demoStarted: false, tickT: 0 };

const hashStr = str => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const prefKey = cwd => 'agent-office:agent:' + cwd;
function loadAgentPrefs(cwd) { try { return JSON.parse(localStorage.getItem(prefKey(cwd))) || {}; } catch (_) { return {}; } }
function saveAgentPrefs(a) { if (!a.live || !a.cwd) return; try { localStorage.setItem(prefKey(a.cwd), JSON.stringify({ name: a.customName ? a.name : undefined, customName: !!a.customName, color: a.color, pref: a.pref, look: a.look })); } catch (_) {} }
// Agents are named after their chat's title, shortened to fit a name tag. A name you type in Customize wins.
const NAME_MAX = 28;
const chatName = t => { t = String(t || '').replace(/\s+/g, ' ').trim(); return !t ? '' : t.length > NAME_MAX ? t.slice(0, NAME_MAX - 1).trimEnd() + '…' : t; };
// Older saves stored the automatic "project 2" name too; only a name that was typed counts.
const autoName = (n, project) => n === project || (n.startsWith(project + ' ') && /^\d+$/.test(n.slice(project.length + 1)));
const customName = (saved, project) => (saved.customName || (saved.customName === undefined && saved.name && !autoName(saved.name, project))) && saved.name || '';
// Work got merged: the agent jumps for joy for a few seconds and the office hears about it.
function celebrate(a) {
  a.cheerUntil = performance.now() + 5000;
  toast({ title: 'Merged', detail: a.name }, 'Find', () => select(a, true), a, 'done');
}
function retitle(a, title) {
  if (!title || title === a.title) return;
  a.title = title;
  if (a.customName) return;
  a.name = chatName(title); a.labelDirty = true; uiDirty = true; detailDirty = true; buildCustomize();
}

function setModeLine() {
  const el = $('#mode-line'), mains = agents.filter(a => a.kind === 'main').length;
  if (MODE === 'demo') el.textContent = live.demoStarted && !params.has('demo') ? 'Demo · start the bridge to see your sessions' : 'Demo · simulated agents';
  else if (!live.connected) el.textContent = live.everConnected ? 'Bridge offline · reconnecting…' : 'Connecting to the bridge…';
  else { const fl = new Set(agents.filter(a => a.kind === 'main').map(a => a.floor)).size; el.textContent = `Live · ${mains} session${mains === 1 ? '' : 's'} on ${fl} floor${fl === 1 ? '' : 's'}`; }
  const sw = $('#mode-switch'); sw.textContent = MODE === 'demo' ? 'Switch to live' : 'Switch to demo'; sw.href = MODE === 'demo' ? location.pathname : '?demo';
  const empty = $('#empty');
  empty.hidden = !(MODE === 'live' && (live.connected ? mains === 0 && live.gotSnapshot : live.everConnected));   // first handshake: no error yet
  if (!empty.hidden) {
    $('#empty-title').textContent = live.connected ? 'No agent sessions yet' : 'Can’t reach the bridge';
    $('#empty-body').textContent = live.connected ? 'Start a session in Claude Code, Codex, Cursor or another connected tool. Its agent will ride up in the lift and take a desk.'
                                                  : 'Start it with npm start in the agent-office folder. This page reconnects on its own.';
    $('#empty-steps').hidden = !live.connected;
  }
}

function poseFor(a) {
  if (a.state === 'waiting') return 'raise';
  if (a.stuck && a.busy) return 'raise';                 // going in circles: hand up so you look
  if (a.state === 'thinking') return 'think';
  if (a.state === 'working') return a.spot && a.spot.type === 'library' ? 'read' : 'type';
  if (a.spot && a.spot.type === 'hoops') return 'shoot';
  if (a.spot && a.spot.type === 'arcade') return 'arcade';
  if (canDance(a)) return 'dance';
  return 'idle';
}
function applyStatus(a, state, activity) {
  if (state === 'thinking' && a.state !== 'thinking') a.thinkingSince = performance.now();
  if (state !== 'thinking') { a.thinkingSince = 0; a.wandered = false; }
  setState(a, state, activity);
  a.busy = state === 'thinking' || state === 'working' || state === 'waiting';
  a.pose = poseFor(a);
  // Busy again while on a break (ping-pong, beanbag, rooftop…): head back to a work spot.
  if (a.busy && a.live && a.kind === 'main' && onBreak(a)) place(a, workSpot(a), true);
  if (state === 'done' || state === 'idle') a.idleSince = a.idleSince || performance.now(); else { a.idleSince = 0; a.nextRoam = 0; }
}
// Go to a spot, but stay put for a minimum time unless it's urgent.
const BREAK_SPOTS = new Set(['hoops', 'arcade', 'beanbag', 'pouf', 'coffee']);
function onBreak(a) {
  if (a.onRoof) return true;
  const s = a.dest || a.spot;
  return !!s && (BREAK_SPOTS.has(s.type) || s === a.cafe) && s !== a.wanderSpot;
}
function place(a, spot, force) {
  if (a.spot && a.spot === a.wanderSpot) { force = true; a.wanderSpot = null; }
  if (!spot || a.leaving) return;
  if (a.review) { a.afterReview = spot; a.nextSpot = null; return; }   // busy reviewing a subagent: go there afterwards
  if (a.onRoof) { a.nextSpot = spot; if (!a.comingDown) { a.comingDown = true; leaveRoof(a).then(() => { a.comingDown = false; const n = a.nextSpot; a.nextSpot = null; if (n) place(a, n, true); }); } return; }
  if (a.spot === spot || a.dest === spot) { a.nextSpot = null; return; }
  if (!force && !a.path.length && performance.now() - (a.arrivedAt || 0) < MIN_STAY_MS) { a.nextSpot = spot; return; }
  a.nextSpot = null; walkTo(a, spot).then(() => { a.pose = poseFor(a); });
}
// Stay in the current zone of that type if already there, otherwise take a free spot.
function spotOfType(a, types) {
  if (a.spot && types.includes(a.spot.type)) return a.spot;
  if (a.dest && types.includes(a.dest.type)) return a.dest;
  const f = freeSpots(types, a.floor); return f.length ? pick(f) : null;
}
function workSpot(a) {
  if (!a.ws || (a.ws !== a.home && a.ws.by && a.ws.by !== a.id)) a.ws = chooseWorkspot(a);
  return a.ws;
}
// Placement rules: where an agent should be for what it is doing right now.
function spotForTool(a, tool, session) {
  if (session && session.permissionMode === 'plan') return spotOfType(a, ['meeting']) || workSpot(a);
  if (READ_TOOLS.has(tool)) { a.streak = (a.streak || 0) + 1; if (a.streak >= 3) return spotOfType(a, ['library']) || workSpot(a); return a.spot && a.spot.type === 'library' ? a.spot : workSpot(a); }
  a.streak = 0;
  if (WEB_TOOLS.has(tool)) return spotOfType(a, ['sofa', 'armchair']) || workSpot(a);
  return workSpot(a);
}
