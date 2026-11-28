const stage = document.getElementById('stage');
if (typeof THREE === 'undefined') { stage.innerHTML = '<p class="fail">The 3D engine did not load. Check your connection and reload.</p>'; throw new Error('three.js did not load'); }

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mix(a, b, t) {
  const p = h => [1,3,5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => matchMedia('(max-width:760px)').matches;
function part(geo, mat, parent, x = 0, y = 0, z = 0, shadow = true) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = shadow; parent.add(m); return m; }
function roundedBox(w, h, d, r, bevel = .04) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 8 });
  g.center(); return g;
}

/* ---------- data ---------- */
const STATUS = {
  thinking: { label: 'Thinking', hex: '#7C6CF2' },
  working:  { label: 'Working',  hex: '#1FB0C6' },
  waiting:  { label: 'Needs you', hex: '#F2A22C' },
  done:     { label: 'Done',     hex: '#3FB65E' },
  idle:     { label: 'Idle',     hex: '#8A979C' },
};
const PALETTE = ['#3FA7D6','#F25F5C','#59CD90','#FAC05E','#A78BFA','#EE6C9F','#2EC4B6','#F79D65'];
// Spoken names for the swatches in Customize, so a screen reader says "coral", not a hex code.
const COLOR_NAMES = { '#3FA7D6': 'sky blue', '#F25F5C': 'coral', '#59CD90': 'mint', '#FAC05E': 'marigold', '#A78BFA': 'lavender', '#EE6C9F': 'pink', '#2EC4B6': 'teal', '#F79D65': 'peach',
  '#15212A': 'ink', '#F4F1EA': 'cream', '#FFB400': 'amber', '#2B59C3': 'cobalt', '#E4572E': 'vermilion', '#98A4AA': 'slate', '#6CB26B': 'leaf green', '#B16AD9': 'violet', '#FF7EB6': 'bubblegum' };
const PROJECTS = [
  { key:'listly', agent:'Ada', color:'#3FA7D6',
    prompts:['Add drag-and-drop reordering to the list view','Fix due-date timezone bug','Write tests for the recurring task scheduler','Add dark mode to the settings page'],
    files:['src/components/TaskList.tsx','src/lib/recurrence.ts','src/api/tasks.ts','src/store/settings.ts','tests/recurrence.test.ts'],
    greps:['reorderTasks(','parseRecurrence','useSettings','dueDate'],
    cmds:['npm test -- recurrence','npm run lint','npm run typecheck'],
    risky:['git push origin feat/dark-mode','npx prisma migrate deploy'],
    subTasks:['Find every place due dates are computed','Map the drag-and-drop event flow'] },
  { key:'recipe-box', agent:'Kit', color:'#F25F5C',
    prompts:['Speed up the recipe search endpoint','Add a grocery list export button','Fix the flaky save-recipe e2e test','Rate-limit the public recipe API'],
    files:['server/routes/recipes.ts','server/db/queries.ts','web/app/search/page.tsx','e2e/save-recipe.spec.ts','server/middleware/rateLimit.ts'],
    greps:['searchRecipes(','SELECT * FROM recipes','useGroceryList','waitForSelector'],
    cmds:['pnpm test recipes','pnpm e2e save-recipe','pnpm build'],
    risky:['rm -rf .next && pnpm build','git push --force-with-lease'],
    subTasks:['Profile the slowest search queries','Find flaky waits in the e2e specs'] },
  { key:'cloudcast', agent:'Nova', color:'#59CD90',
    prompts:['Wire live radar into the hourly forecast','Add a severe-weather push alert','Make the map view work on mobile','Add a 10-day forecast toggle'],
    files:['bridge/server.ts','bridge/alerts/push.sh','web/scene/Radar.ts','web/ui/Forecast.tsx','stations.json'],
    greps:['RadarFrame','push.send(','setForecastRange','alerts.enabled'],
    cmds:['npm test','npx tsc --noEmit','npm run build'],
    risky:['chmod +x bridge/alerts/*.sh','npm publish --dry-run'],
    subTasks:['List every push-alert trigger','Check radar refresh rate on slow connections'] },
  { key:'inkwell', agent:'Reno', color:'#FAC05E',
    prompts:["Summarize this week's starred notes",'Refactor the tag-suggestion prompt','Add a Markdown export button','Dedupe notes by title similarity'],
    files:['scoring/prompt.md','tagging/suggest.py','export/markdown.py','pipeline/dedupe.py','tests/test_suggest.py'],
    greps:['def suggest_tags','title_similarity','to_markdown(','threshold'],
    cmds:['pytest tests/test_suggest.py','ruff check .','python -m pipeline.run --dry'],
    risky:['python -m pipeline.run --send-digest','git push origin main'],
    subTasks:['Sample 50 notes and flag outliers','Find where tags are cached'] },
];
const SCENES = {
  loft: { label:'Daylight', dark:false, bg:'#E3E5E2', skyTop:'#6FA6D6', skyMid:'#DDE9F0', skyLow:'#B9C4CA', haze:'#D6E1E7', cityDark:0, cityLit:0, floor:'#C9AE8A', wall:'#F2F1EE', oak:'#B98B5E', white:'#F6F6F3', black:'#23272A',
    fabric:'#8E9C94', fabric2:'#C9744F', leather:'#9A5B34', felt1:'#6F8F7A', felt2:'#C98B6B', rug:'#E4DCCF', rug2:'#3E5C6B',
    cabinet:'#2F3A40', tile:'#E7E3DC', chair:'#3A4146', lamps:.2, sky:'#E8EEF3', ground:'#857D70', hemi:.58, sun:.62, sunColor:'#FFF3E4',
    screenOff:'#1E262B', glass:'#CFE6EE', grid:'#8B8173' },
  golden: { label:'Golden hour', dark:false, bg:'#E8C9AE', skyTop:'#3E5F9A', skyMid:'#F4B489', skyLow:'#7D6A6A', haze:'#E3B597', cityDark:.3, cityLit:.45,
    floor:'#D9C4A6', wall:'#F2EEE8', oak:'#B98B5E', white:'#F6F4F0', black:'#23272A',
    fabric:'#8E9C94', fabric2:'#C9744F', leather:'#9A5B34', felt1:'#6F8F7A', felt2:'#C98B6B', rug:'#E8DCCB', rug2:'#3E5C6B',
    cabinet:'#2F3A40', tile:'#E7E1D8', chair:'#3A4146', lamps:.6, sky:'#F2D6BE', ground:'#6E5C54', hemi:.5, sun:.66, sunColor:'#FFB77A',
    screenOff:'#1E262B', glass:'#F2D4BE', grid:'#8B8173' },
  night: { label:'Night shift', dark:true, bg:'#0B1014', skyTop:'#050A18', skyMid:'#1C2748', skyLow:'#0A0F1E', haze:'#131B33', cityDark:.84, cityLit:1, floor:'#54473A', wall:'#2C353C', oak:'#4A3A2C', white:'#3A4146', black:'#0F1215',
    fabric:'#34403C', fabric2:'#6E3B28', leather:'#5A3620', felt1:'#2F4A3A', felt2:'#5E3F30', rug:'#2A2F33', rug2:'#1D3440',
    cabinet:'#1C2226', tile:'#353B40', chair:'#2A3135', lamps:1.7, sky:'#8499BC', ground:'#1A1F24', hemi:.78, sun:.3, sunColor:'#8FA8D8',
    screenOff:'#12181C', glass:'#6F9FB8', grid:'#4A4038' },
  greenhouse: { label:'Greenhouse', dark:false, bg:'#DDE5D5', skyTop:'#8FBCD6', skyMid:'#EAF0E4', skyLow:'#C3CBBC', haze:'#DCE4D6', cityDark:0, cityLit:0, floor:'#CDB592', wall:'#EEF0E6', oak:'#8A6443', white:'#F3F1EA', black:'#2B2F2A',
    fabric:'#7E9A74', fabric2:'#D2A15B', leather:'#8C5A34', felt1:'#5E7F5A', felt2:'#B7C79F', rug:'#E8E1CC', rug2:'#5E7F5A',
    cabinet:'#4E6048', tile:'#E4E8DA', chair:'#48573F', lamps:.18, sky:'#F2F2E6', ground:'#7E7C66', hemi:.6, sun:.6, sunColor:'#FFEFD2',
    screenOff:'#252B22', glass:'#D5ECD9', grid:'#8C7A5E' },
};
const PLACE = { desk:'Desk', sofa:'Lounge sofa', armchair:'Lounge chair', pouf:'Pouf', stool:'Café counter', hightable:'Hot desk',
  booth:'Focus booth', meeting:'War room', library:'Library', coffee:'Coffee bar', hoops:'Basketball machine', beanbag:'Beanbag', arcade:'Arcade' };
const LOUNGE_WORK = ['sofa','armchair','hightable','stool','booth'];
Object.assign(PLACE, { roofsofa:'Sofa', roofchair:'Lounge chair', barstool:'Bar', firepit:'Fire pit', lounger:'Sun lounger', rail:'View', dance:'Dance floor' });
const IDLE_ACTIVITY = { coffee:'Making a flat white', hoops:'Shooting hoops', arcade:'Playing an arcade game', beanbag:'Lounging on a beanbag', pouf:'Chatting in the lounge', sofa:'Relaxing on the sofa',
  stool:'Having a coffee at the counter' };
const PREFS = { anywhere:'Anywhere', desk:'Own desk', lounge:'Lounge first' };

/* ---------- renderer / scene ---------- */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 900);
const rig = new THREE.Group(); rig.add(camera); scene.add(rig);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, .7);
sun.position.set(10, 20, 12); sun.castShadow = true;
const sm = isMobile() ? 1024 : 2048; sun.shadow.mapSize.set(sm, sm);
Object.assign(sun.shadow.camera, { left:-19, right:19, top:15, bottom:-15, near:1, far:70 });
sun.shadow.bias = -0.0006; scene.add(sun);

const M = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .85, metalness: 0 }, o));
const mats = {
  floor: M('#fff', { roughness:.75 }), wall: M('#eee'), oak: M('#b98b5e', { roughness:.7 }), white: M('#f6f6f3', { roughness:.5 }),
  black: M('#23272a', { roughness:.45, metalness:.3 }), fabric: M('#8e9c94', { roughness:1 }), fabric2: M('#c9744f', { roughness:1 }),
  leather: M('#9a5b34', { roughness:.55 }), felt1: M('#6f8f7a', { roughness:1 }), felt2: M('#c98b6b', { roughness:1 }),
  rug: M('#e4dccf', { roughness:1 }), rug2: M('#3e5c6b', { roughness:1 }), cabinet: M('#2f3a40', { roughness:.6 }), tile: M('#e7e3dc', { roughness:.4 }),
  chair: M('#3a4146', { roughness:.8 }), steel: M('#B9C0C4', { roughness:.3, metalness:.6 }), brass: M('#C9A45C', { roughness:.35, metalness:.7 }),
  bezel: M('#15191C', { roughness:.35 }), visor: M('#1a2126', { roughness:.25, metalness:.2 }), puck: M('#39444b', { roughness:.5 }),
  pot: M('#D8D2C8', { roughness:.6 }), pot2: M('#B5694A', { roughness:.8 }), leaf: M('#4E8A4E'), leaf2: M('#6FAA62'), leaf3: M('#2F6B45'),
  mug: M('#F4F4F2'), cupSleeve: M('#A0714A', { roughness:.9 }), cupLid: M('#2B3034', { roughness:.5 }), marble: M('#F1EFEA', { roughness:.25 }), pingpong: M('#1F5E8C', { roughness:.6 }), line: M('#FFFFFF'),
  glass: new THREE.MeshStandardMaterial({ color:'#CFE6EE', transparent:true, opacity:.2, roughness:.05, metalness:.1, depthWrite:false }),
  window: new THREE.MeshBasicMaterial({ color:'#DDEFF7', transparent:true, opacity:.1, depthWrite:false }),
  slab: M('#B9BAB4', { roughness:.9 }), beanA: M('#C9744F', { roughness:1 }), beanB: M('#6F8F7A', { roughness:1 }),
  eye: new THREE.MeshBasicMaterial({ color:'#E4FAFF' }), bulb: new THREE.MeshBasicMaterial({ color:'#FFE2A8' }),
  bookA: M('#C44536'), bookB: M('#3A6EA5'), bookC: M('#E0A100'), bookD: M('#5B8E7D'), bookE: M('#8E5572'), bookF: M('#2F4858'), bookG: M('#D9CBB5'),
};
const BOOKS = [mats.bookA, mats.bookB, mats.bookC, mats.bookD, mats.bookE, mats.bookF, mats.bookG, mats.bookG];
function box(w, h, d, mat, x, y, z, parent = scene, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
}
function cyl(rt, rb, h, mat, x, y, z, parent = scene, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function grp(x, z, rotY = 0, parent = scene) { const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; parent.add(g); return g; }
// A piece of furniture a model pack can replace (see "model packs"): its built-in parts stay, hidden, for switching back.
const SLOTS = [];
let packChar = null;                                                // the pack's character model, when it has one: { src, opt }
function slot(name, g) { SLOTS.push({ name, g, parts: [...g.children], model: null }); return g; }
const yawOf = f => Math.atan2(f[0], f[1]);
function canvasTex(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return { c, x: c.getContext('2d'), t }; }
function rrect(x, X, Y, W, H, R) { x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
function fitText(x, s, max) { if (x.measureText(s).width <= max) return s; while (s.length > 1 && x.measureText(s + '…').width > max) s = s.slice(0, -1); return s + '…'; }
