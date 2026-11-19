// Fa de imesde.app en aquest ordinador, per provar l'enllaç públic sense tocar res de fora.
// Mateixa API que demana docs/enllac-public.md, i una pàgina mínima per veure què rebria qui el mira.
//
//   node proves/relleu.mjs [port=4396]            → escriu la clau d'emissió i l'adreça
//   ENLLAC_URL=http://localhost:4396 … node server.mjs
//
//   curl localhost:4396/cau      el relleu respon 503 a tot (per veure què diu el panell)
//   curl localhost:4396/torna    torna a anar
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.argv[2] || 4396);
const SECRET = 'secret-nomes-de-proves';
const CLAU = process.env.RELLEU_CLAU || 'prova-' + crypto.createHash('sha256').update(SECRET).digest('hex').slice(0, 32);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const tokenOf = (clau) => {
  const h = crypto.createHmac('sha256', SECRET).update('subtitols-v1:' + clau).digest();
  let bits = '', out = '';
  for (const b of h.subarray(0, 5)) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < 40; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
};
const feeds = new Map();   // token → { state, at, boot, seq, clients:Set<res> }
const feed = (t) => { if (!feeds.has(t)) feeds.set(t, { state: null, at: 0, boot: null, seq: 0, clients: new Set() }); return feeds.get(t); };
let down = false;

const PAGE = (token) => `<!doctype html><html lang="ca"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Subtítols en directe</title>
<style>html,body{margin:0;height:100%;background:#2b2b2b;color:#f4f3ef;font:500 clamp(22px,5.2vw,44px)/1.3 "Helvetica Neue",Arial,sans-serif}
main{min-height:100%;display:flex;flex-direction:column;justify-content:flex-end;padding:6vw;box-sizing:border-box;gap:.5em}
p{margin:0}.old{opacity:.5}.sp{font-size:.42em;letter-spacing:.2em;text-transform:uppercase;color:#bce12a}
#idle{font-size:.6em;opacity:.6}</style>
<main id="m"><p id="idle">Ara no hi ha subtítols en directe.</p></main>
<script>
const m = document.getElementById('m'); let last = null, at = 0;
function paint() {
  const s = last, live = s && s.running && !s.hidden && Date.now() - at < 25000;
  const blocks = live ? s.blocks.filter((b) => b.t0 >= (s.clearAt || 0)).slice(-4) : [];
  m.innerHTML = blocks.length ? blocks.map((b, i) => '<p class="' + (i < blocks.length - 1 ? 'old' : '') + '">' + (b.speaker ? '<span class="sp">' + esc(b.speaker) + '</span><br>' : '') + esc(b.text) + '</p>').join('')
    : '<p id="idle">' + (live ? '…' : 'Ara no hi ha subtítols en directe.') + '</p>';
}
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function connect() { const es = new EventSource('/api/subtitols/feed/${token}'); es.onmessage = (e) => { last = JSON.parse(e.data); at = Date.now(); paint(); }; es.onerror = () => { es.close(); setTimeout(connect, 1500); }; }
connect(); setInterval(paint, 2000);
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(o ? JSON.stringify(o) : undefined); };
  if (url.pathname === '/cau') { down = true; return json(200, { down }); }
  if (url.pathname === '/torna') { down = false; return json(200, { down }); }
  if (down) return json(503, { error: 'relleu caigut (prova)' });

  const page = /^\/subtitols([a-z2-7]{8})$/.exec(url.pathname);
  if (page) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE(page[1])); }

  const sse = /^\/api\/subtitols\/feed\/([a-z2-7]{8})$/.exec(url.pathname);
  if (sse && req.method === 'GET') {
    const f = feed(sse[1]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    if (f.state) res.write(`data: ${JSON.stringify(f.state)}\n\n`);
    f.clients.add(res);
    req.on('close', () => f.clients.delete(res));
    return;
  }

  if (url.pathname === '/api/subtitols/feed') {
    const clau = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (clau !== CLAU) return json(401, { error: 'clau no vàlida' });
    const token = tokenOf(clau);
    if (req.method === 'GET') return json(200, { token, url: `http://localhost:${PORT}/subtitols${token}` });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        let st; try { st = JSON.parse(body); } catch { return json(400, { error: 'JSON' }); }
        if (st?.v !== 1 || !Array.isArray(st.blocks)) return json(400, { error: 'format' });
        const f = feed(token);
        if (f.boot === st.boot && st.seq <= f.seq) return json(200, { viewers: f.clients.size }); // desordenat: es descarta
        Object.assign(f, { state: st, at: Date.now(), boot: st.boot, seq: st.seq });
        for (const c of f.clients) c.write(`data: ${body}\n\n`);
        console.log(`  ← seq ${st.seq} · ${st.running ? 'en marxa' : 'aturat'}${st.hidden ? ' · amagat' : ''} · ${st.lang} · ${st.blocks.length} frases · «${(st.blocks.at(-1)?.text || '').slice(-60)}»`);
        json(200, { viewers: f.clients.size });
      });
      return;
    }
  }
  json(404, { error: 'no' });
}).listen(PORT, () => console.log(`Relleu de proves (fa de imesde.app) a http://localhost:${PORT}\n  clau d'emissió: ${CLAU}\n  adreça pública: http://localhost:${PORT}/subtitols${tokenOf(CLAU)}`));
