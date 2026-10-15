// Prova automàtica sense micro: arrenca el servidor, li envia un àudio a
// velocitat real (com si fos en directe) i escriu quan surt cada cosa.
//
//   npm run prova                      → proves/presentacio-ca.wav
//   npm run prova -- fitxer.mp3
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(DIR, 'proves', 'presentacio-ca.wav');
const PORT = 4398;

const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
console.log(`${path.basename(file)} · ${(pcm.length / 48000).toFixed(1)} s\n`);

const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.on('data', (d) => { if (process.env.DEBUG) process.stdout.write('  │ ' + d); });
await new Promise((r) => setTimeout(r, 1200));

const ws = new WebSocket(`ws://localhost:${PORT}/ws/captura`);
let t0 = 0;
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const seen = new Map();
let latency = null;
ws.on('message', (m) => {
  const s = JSON.parse(m);
  latency = s.latency?.translate ?? latency;
  for (const b of s.blocks || []) {
    const st = seen.get(b.id) || {};
    if (b.src.trim() && !st.first) { st.first = true; console.log(`[${sec()} s] primera paraula de la frase ${b.id}`); }
    if (b.final && !st.final) { st.final = true; console.log(`[${sec()} s] ORIG  ${b.src}`); }
    for (const l of ['ca', 'es', 'en']) {
      if (b.final && b.tr?.[l] && !st[l] && !Object.values(s.blocks).find((x) => x.id === b.id && x.tr[l] !== b.tr[l])) {
        // només quan la traducció de la frase tancada ja no canvia
      }
      if (b.tr?.[l] && !st['p' + l]) { st['p' + l] = true; console.log(`[${sec()} s]   ${l.toUpperCase()} comença: ${b.tr[l]}`); }
    }
    st.last = b;
    seen.set(b.id, st);
  }
});
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'start', config: { sourceLang: 'auto', targets: ['ca', 'es', 'en'], prompt: 'Presentació d’un concert al Palau de la Música Catalana.', speakers: [] } }));
await new Promise((r) => setTimeout(r, 1200));

t0 = Date.now();
const frame = (chunk) => Buffer.concat([Buffer.from([255]), chunk]);
for (let i = 0; i < pcm.length; i += 4800) { ws.send(frame(pcm.subarray(i, i + 4800))); await new Promise((r) => setTimeout(r, 100)); }
for (let i = 0; i < 30; i++) { ws.send(frame(Buffer.alloc(4800))); await new Promise((r) => setTimeout(r, 100)); }
await new Promise((r) => setTimeout(r, 2500));
ws.send(JSON.stringify({ type: 'stop' }));
await new Promise((r) => setTimeout(r, 2500));

console.log('\nResultat final:');
for (const st of seen.values()) {
  const b = st.last;
  console.log(`  ${b.src}\n    ES: ${b.tr.es}\n    EN: ${b.tr.en}\n    CA: ${b.tr.ca}`);
}
console.log(`\nTraducció: primera paraula a ~${latency} ms de demanar-la`);
server.kill();
process.exit(0);
