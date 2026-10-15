// Escolta com una pantalla més i en fa un resum cada N segons (no envia res).
//   node proves/vigila.mjs <minuts> [cada-segons=30]
import { WebSocket } from 'ws';
const [min = 5, every = 30] = process.argv.slice(2).map(Number);
const t0 = Date.now();
let s = null, maxId = 0, frases = 0, last = Date.now(), maxGap = 0, boots = new Set(), lastTxt = '';
const errors = new Set();
function connect() {
  const ws = new WebSocket('ws://localhost:4321/ws/pantalla');
  ws.on('message', (raw) => {
    s = JSON.parse(raw.toString());
    if (s.bootId) boots.add(s.bootId);
    for (const e of s.errors || []) errors.add(e);
    for (const b of s.blocks || []) if (b.final && b.id > maxId) {
      maxId = b.id; frases++; maxGap = Math.max(maxGap, Date.now() - last); last = Date.now();
      lastTxt = `${b.src} → EN: ${b.tr?.en || ''}`.slice(0, 140);
    }
  });
  ws.on('close', () => { console.log(`  · connexió tancada (${((Date.now() - t0) / 1000).toFixed(0)} s): es reconnecta`); maxId = 0; setTimeout(connect, 1000); });
  ws.on('error', () => {});
}
connect();
setInterval(() => {
  console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min] running=${s?.running} frases=${frases} buitMax=${(maxGap / 1000).toFixed(0)}s fa=${((Date.now() - last) / 1000).toFixed(0)}s owner=${s?.hasOwner} openai=${s?.upstream} servidors=${boots.size} cost=$${s?.costUSD}`);
  if (lastTxt) console.log(`    «${lastTxt}»`);
  for (const e of errors) console.log('    ✖', e);
  errors.clear(); maxGap = 0;
}, every * 1000);
setTimeout(() => process.exit(0), min * 60000);
