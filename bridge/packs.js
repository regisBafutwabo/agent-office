// Model packs: folders of glTF models that replace the office's built-in furniture (and later its characters).
// Each pack is <packs>/<id>/pack.json plus the .glb/.gltf files it names, served to the page under /packs/<id>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORT = { darwin: 'Library/Application Support/Agent Office', win32: 'AppData/Roaming/Agent Office', linux: '.config/agent-office' };
export const packsDir = (home = os.homedir()) => process.env.AGENT_OFFICE_PACKS || path.join(home, SUPPORT[process.platform] || SUPPORT.linux, 'packs');

// Every folder with a readable pack.json; a broken pack is skipped, never fatal.
export function listPacks(dir = packsDir()) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const packs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'pack.json'), 'utf8'));
      if (!meta || typeof meta.slots !== 'object') continue;
      packs.push({ id: e.name, name: String(meta.name || e.name), license: meta.license ? String(meta.license) : undefined, slots: meta.slots });
    } catch {}
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

// /packs/<id>/<file> → the file on disk, or null when it would leave the packs folder.
export function packFile(urlPath, dir = packsDir()) {
  let rel; try { rel = decodeURIComponent(urlPath.replace(/^\/packs\/+/, '')); } catch { return null; }
  const file = path.resolve(dir, rel), root = path.resolve(dir);
  return file.startsWith(root + path.sep) && rel.includes('/') ? file : null;
}
