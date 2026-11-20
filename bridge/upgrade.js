// Hooks from before the office had keys can't report to it. The office says so when one is refused (server.js);
// this finds the usual cause ahead of time: a Claude Code plugin older than the first one that sends the hook key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIRST_KEYED_PLUGIN = '0.5.0';
const parts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
export function older(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

// The installed agent-office plugin's version when it predates the hook key, otherwise null.
export function outdatedPlugin(home = os.homedir()) {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), 'utf8'));
    const versions = (installed?.plugins?.['agent-office@agent-office'] || []).map(p => p?.version).filter(v => typeof v === 'string');
    const old = versions.find(v => older(v, FIRST_KEYED_PLUGIN));
    return old || null;
  } catch { return null; }
}
