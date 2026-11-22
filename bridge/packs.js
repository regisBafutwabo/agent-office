// Model packs: folders of glTF models that replace the office's built-in furniture (and later its characters).
// Each pack is <packs>/<id>/pack.json plus the .glb/.gltf files it names, served to the page under /packs/<id>/.
// Packs come from anywhere, so only model and texture files are served, never documents or scripts, and never
// anything a symlink points to outside the packs folder.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './auth.js';

export const packsDir = home => process.env.AGENT_OFFICE_PACKS || path.join(dataDir(home), 'packs');
export const PACK_TYPES = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };
export const MAX_PACK_FILE = 64 * 1024 * 1024;
// A pack file can't run as a page even if someone opens its URL directly.
export const PACK_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-cache' };

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

// /packs/<id>/<file> → { file, type } for a model or texture really inside the packs folder, else null.
export function packFile(urlPath, dir = packsDir()) {
  let rel; try { rel = decodeURIComponent(urlPath.replace(/^\/packs\/+/, '')); } catch { return null; }
  if (rel.includes('\0') || !rel.includes('/')) return null;
  const root = path.resolve(dir), file = path.resolve(root, rel), type = PACK_TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root), real = fs.realpathSync(file), st = fs.statSync(real);
    if (!real.startsWith(realRoot + path.sep) || !st.isFile() || st.size > MAX_PACK_FILE) return null;
    return { file: real, type };
  } catch { return null; }
}
