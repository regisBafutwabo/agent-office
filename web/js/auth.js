// The office's key. It arrives once in the address, #k=… (the app's window, or the link the bridge prints) or a
// one-time #code=… (the app's "Open in browser"), is kept in this browser only, and leaves the address at once.
const officeAuth = (() => {
  const KEY = 'agent-office:key', hash = new URLSearchParams(location.hash.slice(1)), given = hash.get('k'), code = hash.get('code');
  let key = ''; try { key = localStorage.getItem(KEY) || ''; } catch (_) {}
  const keep = k => { key = k; try { localStorage.setItem(KEY, k); } catch (_) {} };
  if (given || code) history.replaceState(null, '', location.pathname + location.search);
  // A link pasted into an office tab that is already open changes only the fragment; start over to use it.
  addEventListener('hashchange', () => { if (/(^|&)(k|code)=/.test(location.hash.slice(1))) location.reload(); });
  if (given) keep(given);
  const ready = !code ? Promise.resolve() : fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    .then(r => r.ok ? r.json() : null).then(d => { if (d && typeof d.token === 'string') keep(d.token); }).catch(() => {});
  return {
    ready,
    fetch: (url, o = {}) => ready.then(() => fetch(url, { ...o, headers: key ? { ...o.headers, Authorization: 'Bearer ' + key } : o.headers })),
    protocols: () => key ? ['agent-office', 'agent-office.token.' + key] : ['agent-office'],
  };
})();
// Report page errors and the frame rate to the local server so they show up in its log (no-op on claude.ai).
(() => {
  const report = data => { try { if (/^https?:$/.test(location.protocol) && !location.host.endsWith('claude.ai')) officeAuth.fetch('/api/log', { method: 'POST', body: JSON.stringify(data), keepalive: true }).catch(() => {}); } catch (_) {} };
  addEventListener('error', e => report({ kind: 'error', message: e.message, at: `${e.filename}:${e.lineno}:${e.colno}` }));
  addEventListener('unhandledrejection', e => report({ kind: 'rejection', message: String(e.reason && e.reason.stack || e.reason) }));
  addEventListener('load', () => { let frames = 0; const t0 = performance.now(); const count = () => { frames++; if (performance.now() - t0 < 3000) requestAnimationFrame(count); else report({ kind: 'fps', fps: Math.round(frames / 3), webgl: !!document.createElement('canvas').getContext('webgl'), ua: navigator.userAgent }); }; requestAnimationFrame(count); });
})();
