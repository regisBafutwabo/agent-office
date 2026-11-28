import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// The panels use the design tokens at the top of web/office.css (see AGENTS.md). Older rules still have raw values,
// so this test doesn't ask for zero: it fails when a raw value is used more often than design-tokens-baseline.json
// allows. Replacing old raw values with tokens is always welcome; then run
//   UPDATE_TOKEN_BASELINE=1 node --test scripts/design-tokens.test.mjs
// to lower the baseline so they can't come back.
const CSS = new URL('../web/office.css', import.meta.url), BASELINE = new URL('./design-tokens-baseline.json', import.meta.url);

// Every declaration in a rule, with its selector. Custom properties are where tokens are defined, so they're skipped.
export function declarations(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [], parts = css.split(/([{}])/), stack = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (t === '{') { stack.push((parts[i - 1] || '').trim()); continue; }
    if (t === '}') { stack.pop(); continue; }
    if (parts[i + 1] !== '}' || !stack.length) continue;               // only text that closes a block holds declarations
    const selector = stack[stack.length - 1];
    for (const d of t.split(';')) {
      const m = d.match(/^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/i);
      if (m && !m[1].startsWith('--')) out.push({ selector, prop: m[1].toLowerCase(), value: m[2] });
    }
  }
  return out;
}

const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;
const PX = /-?\d*\.?\d+px/g;
// 6px and 10px are the deliberate in-between paddings of buttons and chips; 1px and 2px are hairline nudges.
const SPACING_OK = new Set(['1px', '2px', '6px', '10px', '-1px', '-2px']);

// Raw values by kind → value → where they're used.
export function rawValues(css) {
  const found = { color: {}, fontSize: {}, spacing: {}, radius: {} };
  const add = (kind, value, d) => (found[kind][value] ||= []).push(`${d.selector} { ${d.prop}: ${d.value} }`);
  for (const d of declarations(css)) {
    for (const c of d.value.match(COLOR) || []) add('color', c.toLowerCase().replace(/\s+/g, ''), d);
    if (d.prop === 'font-size') for (const v of d.value.match(PX) || []) add('fontSize', v, d);
    if (d.prop === 'font') { const m = d.value.match(/(?:^|\s)(\d*\.?\d+px)(?=\/|\s)/); if (m) add('fontSize', m[1], d); }
    if (/^(padding|margin)(-|$)|^(row-|column-)?gap$/.test(d.prop)) for (const v of d.value.match(PX) || []) if (!SPACING_OK.has(v)) add('spacing', v, d);
    if (/radius$/.test(d.prop)) for (const v of d.value.match(PX) || []) add('radius', v, d);
  }
  return found;
}

const counts = found => Object.fromEntries(Object.entries(found).map(([k, vals]) =>
  [k, Object.fromEntries(Object.entries(vals).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([v, where]) => [v, where.length]))]));

test('web/office.css gets no new raw colors, font sizes, spacing or radii', () => {
  const found = rawValues(readFileSync(CSS, 'utf8'));
  if (process.env.UPDATE_TOKEN_BASELINE) writeFileSync(BASELINE, JSON.stringify(counts(found), null, 2) + '\n');
  const allowed = JSON.parse(readFileSync(BASELINE, 'utf8')), over = [];
  for (const [kind, vals] of Object.entries(found)) for (const [v, where] of Object.entries(vals)) {
    const max = allowed[kind]?.[v] || 0;
    if (where.length > max) over.push(`${kind} ${v}: used ${where.length} times, ${max} allowed. Uses:\n    ${where.join('\n    ')}`);
  }
  assert.deepEqual(over, [], `Use a design token (top of web/office.css, see AGENTS.md) instead of a raw value:\n  ${over.join('\n  ')}`);
});

test('the token checker reads rules, nested rules and shorthands', () => {
  const css = `:root{--x:#fff;--sp-1:4px}
    .a{color:#123456;padding:0 12px;margin:var(--sp-2) 6px}
    @media (max-width:760px){ .b:hover{font:600 13px/1 var(--font-b);border-radius:9px;gap:var(--sp-1)} }
    .c{font:400 var(--fs-body)/16px var(--font-b);background:rgba(0, 0, 0, .5)}`;
  assert.deepEqual(counts(rawValues(css)), {
    color: { '#123456': 1, 'rgba(0,0,0,.5)': 1 }, fontSize: { '13px': 1 }, spacing: { '12px': 1 }, radius: { '9px': 1 },
  });
});
