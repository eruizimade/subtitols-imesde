// Prepara el GUIÓ d'un acte: el parteix en frases i en fa la traducció de referència.
//
//   node guio.mjs <guio.txt> [--de=ca] [--a=ca,es,en] [--model=gpt-4.1]
//   node guio.mjs <guio.txt> --de=ca --a=en,es --oficial-en=carta_en.txt --oficial-es=carta_es.txt
//       → amb TRADUCCIONS OFICIALS: no tradueix, copia de cada una el tros que correspon a cada frase
//         (el que no hi troba, el tradueix i el marca amb ⚠ per revisar-lo)
//
// Escriu:
//   guio.json         el que llegeix el servidor (frases + traduccions)
//   guio-revisio.txt  el mateix, en pla, per revisar-ho i corregir-ho a mà
//
// Si ja tens traduccions oficials, corregeix guio-revisio.txt i torna-la a carregar amb:
//   node guio.mjs --de-revisio guio-revisio.txt
//
// El servidor el carrega en començar cada sessió (i si canvia el fitxer). Durant l'acte, cada
// frase que es tradueix busca el tros del guió que s'hi assembla i en dona la traducció al model
// com a referència: si el ponent llegeix el guió, surt la traducció bona; si se n'aparta, es
// tradueix el que diu de debò.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareScript } from './guio-prepara.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(DIR, '.env')); } catch {}
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const file = args.find((a) => !a.startsWith('--')) || opt['de-revisio'];
if (!file) { console.error('Ús: node guio.mjs <guio.txt> [--de=ca] [--a=ca,es,en]'); process.exit(1); }

const OUT = path.join(DIR, 'guio.json');
const REV = path.join(DIR, 'guio-revisio.txt');

// ─── Tornar a carregar una revisió feta a mà ───
if (opt['de-revisio']) {
  const segs = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
    const t = line.match(/^\s+([A-Z]{2,3}):\s*(.*)$/);
    if (m) { cur = { src: m[2].trim(), tr: {} }; segs.push(cur); }
    else if (t && cur) cur.tr[t[1].toLowerCase()] = t[2].trim();
    else if (cur && line.trim() && /^\s{4,}/.test(line)) { const ks = Object.keys(cur.tr); if (ks.length) cur.tr[ks.at(-1)] += ' ' + line.trim(); } // traducció partida en dues línies
  }
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  if (prev.source) for (const sg of segs) sg.tr[prev.source] ??= sg.src;
  fs.writeFileSync(OUT, JSON.stringify({ ...prev, segments: segs, revised: new Date().toISOString() }, null, 2));
  console.log(`✓ ${segs.length} frases carregades de la revisió a guio.json`);
  process.exit(0);
}

const SRC = opt.de || 'ca';
const TARGETS = String(opt.a || 'ca,es,en').split(',').filter(Boolean);
const MODEL = opt.model || 'gpt-4.1';
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('Falta OPENAI_API_KEY al .env'); process.exit(1); }

// Mateix procés que «Preparar guió» del panell (guio-prepara.mjs)
const raw = fs.readFileSync(file);
let text = raw.toString('utf8');
if (text.includes('\uFFFD')) text = raw.toString('latin1'); // un .txt desat des de Word en «Western»
const official = {};
for (const l of TARGETS) if (opt[`oficial-${l}`]) official[l] = fs.readFileSync(opt[`oficial-${l}`], 'utf8');
const g = await prepareScript({ texts: [text], src: SRC, targets: TARGETS, official, key: KEY, model: MODEL, from: path.basename(file),
  onProgress: (p) => p.stage !== 'fet' && console.log(`  ${p.stage}… (${p.segments} frases)`), onLog: (m) => console.error('  ' + m) });
fs.writeFileSync(OUT, JSON.stringify(g, null, 2));
fs.writeFileSync(REV, g.segments.map((s, i) => `[${i + 1}] ${s.src}\n` + g.targets.filter((l) => l !== SRC).map((l) => `    ${l.toUpperCase()}: ${s.tr[l]}`).join('\n')).join('\n\n') + '\n');
console.log(`\n✓ guio.json i guio-revisio.txt (${g.segments.length} frases${g.warnings ? `, ${g.warnings} per revisar (⚠)` : ''}). Si hi corregeixes res:\n  node guio.mjs --de-revisio guio-revisio.txt`);
