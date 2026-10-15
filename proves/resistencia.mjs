// Prova de resistència: fa de panell de captura (envia un .wav en bucle, a temps real)
// i de pantalla (vigila que arribin frases). Escriu un resum cada minut.
//
//   node proves/resistencia.mjs <minuts> [fitxer.wav ...] [--silenci-cada=N --silenci-min=M] [--talla-panell-cada=N]
//
// - --silenci-cada / --silenci-min: cada N minuts, M minuts sense veu (simula música/descans)
// - --talla-panell-cada: cada N minuts tanca el socket del panell i el torna a obrir
//   (simula un tall de Wi-Fi), per comprovar que l'àudio torna sol
import fs from 'node:fs';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const pos = args.filter((a) => !a.startsWith('--'));
const MINUTS = Number(pos[0] || 5);
const FILES = pos.slice(1).length ? pos.slice(1) : ['proves/presentacio-ca.wav'];
const HOST = opt.host || 'localhost:4321';
const SIL_EVERY = Number(opt['silenci-cada'] || 0) * 60000;
const SIL_LEN = Number(opt['silenci-min'] || 0) * 60000;
const CUT_EVERY = Number(opt['talla-panell-cada'] || 0) * 60000;

function readPcm(file) {
  const b = fs.readFileSync(file);
  const i = b.indexOf('data');
  const rate = b.readUInt32LE(24);
  const ch = b.readUInt16LE(22);
  if (rate !== 24000 || ch !== 1) throw new Error(`${file}: cal mono 24 kHz (és ${ch} canals, ${rate} Hz)`);
  return b.subarray(i + 8);
}
// --ponents=Nom:llengua:fitxer.wav,Nom2:llengua:fitxer2.wav → parlen per torns, cadascú pel seu canal (byte de ponent)
const PONENTS = opt.ponents ? opt.ponents.split(',').map((x) => { const [name, lang, file] = x.split(':'); return { name, lang, pcm: readPcm(file) }; }) : null;
const pcm = PONENTS ? Buffer.alloc(0) : Buffer.concat(FILES.map(readPcm));
// línia de temps per torns: [ponent 0][1,5 s de silenci][ponent 1][1,5 s]...
const SEGS = PONENTS ? PONENTS.flatMap((p, i) => [{ sp: i, pcm: p.pcm }, { sp: i, pcm: Buffer.alloc(72000) }]) : null;
let segI = 0, segPos = 0;
const FRAME = 4800; // 100 ms
console.log(PONENTS ? `ponents: ${PONENTS.map((p) => p.name + '/' + p.lang).join(', ')}` : `àudio: ${(pcm.length / 48000).toFixed(0)} s en bucle · prova de ${MINUTS} min`);

const t0 = Date.now();
const stats = { frasesNoves: 0, maxBuit: 0, errors: new Set(), running: null, ultimaFrase: Date.now(), maxId: 0, aturades: 0 };
let pos0 = 0;
let cap;

function obrePanell(first) {
  cap = new WebSocket(`ws://${HOST}/ws/captura`);
  cap.on('open', () => {
    if (first) cap.send(JSON.stringify({ type: 'start', config: { mode: 'equilibrat', targets: String(opt.targets || 'ca,es,en').split(','), sourceLang: opt.lang || 'auto', prompt: opt.prompt || '', speakers: PONENTS ? PONENTS.map((p) => p.name) : [], speakerLangs: PONENTS ? PONENTS.map((p) => p.lang) : [] } }));
  });
  cap.on('close', () => { if (!fi) setTimeout(() => obrePanell(false), 1000); });
  cap.on('error', () => {});
}
let fi = false;
obrePanell(true);

setInterval(() => {
  if (cap.readyState !== 1) return;
  const el = Date.now() - t0;
  const silenci = SIL_EVERY && el % SIL_EVERY > SIL_EVERY - SIL_LEN;
  let chunk, spByte = 255;
  if (SEGS) {
    const seg = SEGS[segI];
    chunk = Buffer.alloc(FRAME); seg.pcm.copy(chunk, 0, segPos, Math.min(segPos + FRAME, seg.pcm.length));
    spByte = seg.sp; segPos += FRAME;
    if (segPos >= seg.pcm.length) { segPos = 0; segI = (segI + 1) % SEGS.length; }
  } else if (silenci) chunk = Buffer.alloc(FRAME);
  else {
    if (pos0 + FRAME > pcm.length) pos0 = 0;
    chunk = pcm.subarray(pos0, pos0 + FRAME);
    pos0 += FRAME;
  }
  cap.send(Buffer.concat([Buffer.from([spByte]), chunk]));
}, 100);

if (CUT_EVERY) setInterval(() => { console.log('✂ tallo el panell'); cap.terminate(); }, CUT_EVERY);

const pant = new WebSocket(`ws://${HOST}/ws/pantalla`);
pant.on('message', (raw) => {
  const s = JSON.parse(raw.toString());
  if (stats.running === true && s.running === false) stats.aturades++;
  stats.running = s.running;
  stats.audio = s.audioSeconds; stats.owner = s.hasOwner; stats.upstream = s.upstream;
  for (const e of s.errors || []) stats.errors.add(e);
  for (const b of s.blocks || []) if (b.final && b.id > stats.maxId) {
    stats.maxId = b.id;
    stats.frasesNoves++;
    stats.maxBuit = Math.max(stats.maxBuit, Date.now() - stats.ultimaFrase);
    stats.ultimaFrase = Date.now();
    stats.ultimText = `${b.speaker ? '[' + b.speaker + '] ' : ''}${b.src} → EN: ${b.tr?.en || ''} | ES: ${b.tr?.es || ''}`.slice(0, 220);
    if (opt.ponents) console.log('    ·', stats.ultimText);
    stats.cost = s.costUSD;
  }
});

const minut = setInterval(() => {
  const m = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`[${m} min] running=${stats.running} frases=${stats.frasesNoves} buitMax=${(stats.maxBuit / 1000).toFixed(0)}s fa=${((Date.now() - stats.ultimaFrase) / 1000).toFixed(0)}s aturades=${stats.aturades} audio=${stats.audio}s owner=${stats.owner} openai=${stats.upstream} cost=$${stats.cost} errors=${stats.errors.size}`);
  if (stats.ultimText) console.log(`    «${stats.ultimText}»`);
  for (const e of stats.errors) console.log('    ✖', e);
  stats.errors.clear();
  stats.maxBuit = 0;
}, Number(opt['resum-s'] || 60) * 1000);

setTimeout(() => {
  fi = true;
  clearInterval(minut);
  if (cap.readyState === 1) cap.send(JSON.stringify({ type: 'stop' }));
  setTimeout(() => process.exit(0), 1500);
}, MINUTS * 60000);
