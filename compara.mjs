// Compara els tres modes de transcripció amb el MATEIX àudio (normalment, el
// d'una sessió real: sessions/*.wav). Els tres van en paral·lel i a velocitat real,
// perquè el mode «ràpid» es comporta diferent si li arriba l'àudio de cop.
//
//   npm run compara -- sessions/2026-09-17T....wav [minuts]   (per defecte, els 3 primers)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(DIR, '.env')); } catch {}
const file = process.argv[2];
if (!file) { console.error('Ús: npm run compara -- <fitxer d\'àudio> [minuts]'); process.exit(1); }
const minutes = Number(process.argv[3] || 3);
const lang = process.env.LANG_CODE || null;

const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-t', String(minutes * 60), '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
const seconds = pcm.length / 48000;
const MODES = {
  precis: { model: 'gpt-realtime-whisper' },
  equilibrat: { model: 'gpt-live-transcribe', delay: 'low' },
  rapid: { model: 'gpt-live-transcribe', delay: 'minimal' },
};
console.log(`${path.basename(file)} · ${seconds.toFixed(0)} s · els tres modes alhora, a velocitat real…\n`);

function run(name, m) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    let text = '';
    let sentMs = 0;
    const lags = []; // quant va per darrere el text de l'àudio enviat, a cada paraula
    let t0;
    ws.on('message', (raw) => {
      const e = JSON.parse(raw);
      if (e.type === 'error') console.log(`  ${name}: ERROR ${e.error?.message}`);
      if (e.type === 'conversation.item.input_audio_transcription.delta' && e.delta?.trim()) {
        text += e.delta;
        lags.push(Date.now() - t0 - sentMs);
      }
      if (e.type === 'conversation.item.input_audio_transcription.completed' && m.model !== 'gpt-live-transcribe') text += ' ';
    });
    ws.on('open', async () => {
      const transcription = { model: m.model };
      if (m.delay) transcription.delay = m.delay;
      if (lang) m.delay ? (transcription.languages = [lang]) : (transcription.language = lang);
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, noise_reduction: { type: 'near_field' }, transcription } } } }));
      await new Promise((r) => setTimeout(r, 800));
      t0 = Date.now();
      for (let i = 0; i < pcm.length; i += 4800) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + 4800).toString('base64') }));
        sentMs = ((i + 4800) / 48000) * 1000;
        const wait = t0 + sentMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      for (let i = 0; i < 20; i++) { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') })); await new Promise((r) => setTimeout(r, 100)); }
      setTimeout(() => { ws.close(); resolve({ name, model: `${m.model}${m.delay ? ' · ' + m.delay : ''}`, text: text.replace(/\s+/g, ' ').trim(), lags }); }, 4000);
    });
  });
}

const results = await Promise.all(Object.entries(MODES).map(([n, m]) => run(n, m)));
let out = '';
for (const r of results) {
  out += `━━ ${r.name.toUpperCase()} (${r.model})\n${r.text}\n\n`;
}
console.log(out);
const outFile = file.replace(/\.[^.]+$/, '') + '.comparacio.txt';
fs.writeFileSync(outFile, out);
console.log(`Desat a ${path.relative(process.cwd(), outFile)}`);
process.exit(0);
