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

const DIR = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(DIR, '.env')); } catch {}
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const file = args.find((a) => !a.startsWith('--')) || opt['de-revisio'];
if (!file) { console.error('Ús: node guio.mjs <guio.txt> [--de=ca] [--a=ca,es,en]'); process.exit(1); }

const NAMES = { ca: 'català', es: 'castellà', en: 'anglès', fr: 'francès', it: 'italià', de: 'alemany', pt: 'portuguès' };
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

// Frases. Cada línia és un tros (un salt de línia sempre talla). Fora: acotacions entre [ ] i ( ),
// números de línia («1.», «2)») i etiquetes de qui parla («PRESENTADORA:», «Joan Puig:»).
const raw = fs.readFileSync(file);
let text = raw.toString('utf8');
if (text.includes('\uFFFD')) text = raw.toString('latin1'); // un .txt desat des de Word en «Western»
text = text.replace(/\r/g, '');
if (opt.unwrap) text = text.split('\n').map((l) => l.trim()).filter(Boolean)
  .reduce((acc, l) => { if (acc.length && /^\p{Ll}/u.test(l)) acc[acc.length - 1] += ' ' + l; else acc.push(l); return acc; }, []).join('\n');
const ABBR = /(?:\b(?:Sr|Sra|Srs|Dr|Dra|núm|Núm|pàg|etc|aprox|tel|av|c|St|Sta|Mr|Mrs|Ms|Prof|vol|op|Op|n|No)\.|\b\d+\.)$/;
const segments = [];
for (const line of text.split(/\n+/)) {
  let p = line.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*\d+\s*[.)]\s+/, '')
    .replace(/^\s*[\p{Lu}][\p{L} .'’-]{0,40}:\s+/u, (m) => (/\d/.test(m) ? m : ''))
    .replace(/\s+/g, ' ').trim();
  if (!p || !/\p{L}/u.test(p)) continue;
  // Un punt només acaba frase si darrere hi ha un espai o el final (així «9.30» i «1.500» no es parteixen)
  const parts = p.match(/.+?[.!?…]+["»”)]*(?=\s|$)|.+$/g) || [p];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc} ${part.trim()}` : part.trim();
    // una abreviatura o un número («Sr.», «9.», «1.500») no acaba la frase
    if (ABBR.test(acc) || acc.length < 4) continue;
    segments.push({ src: acc, tr: {} });
    acc = '';
  }
  if (acc && /\p{L}/u.test(acc)) segments.push({ src: acc, tr: {} });
}
if (!segments.length) { console.error('No he trobat cap frase al fitxer.'); process.exit(1); }
console.log(`${segments.length} frases · de ${SRC} a ${TARGETS.join('/')} · model ${MODEL}`);

// Text del document que es llegeix: les línies que el PDF ha partit a mitja frase es tornen a ajuntar
const unwrap = (t) => t.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  .reduce((acc, l) => { if (acc.length && /^\p{Ll}/u.test(l)) acc[acc.length - 1] += ' ' + l; else acc.push(l); return acc; }, []).join('\n');

async function translate(lang) {
  const out = [];
  const STEP = opt[`oficial-${lang}`] ? 20 : 40;
  const official = opt[`oficial-${lang}`] ? unwrap(fs.readFileSync(opt[`oficial-${lang}`], 'utf8')) : null;
  // En lots de 40, amb tot el guió de context perquè la traducció sigui coherent
  for (let i = 0; i < segments.length; i += STEP) {
    const batch = segments.slice(i, i + STEP);
    let t;
    for (let intent = 0; intent < 3 && !t; intent++) {
    try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: official ? 0 : 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: official ?
            `Tens el text d'un guió (frases numerades en ordre) i la seva TRADUCCIÓ OFICIAL al ${NAMES[lang] || lang}. ` +
            'Per a cada frase, copia LITERALMENT el tros de la traducció oficial que hi correspon (mateixes paraules, sense retocar-les ni traduir de nou). ' +
            'Si la traducció oficial ajunta o parteix frases de manera diferent, reparteix-ho perquè cada frase tingui el seu tros, sense repetir ni perdre text. ' +
            'Si una frase no té cap correspondència a la traducció oficial, tradueix-la tu i comença-la amb «⚠ ». ' +
            'Respon amb JSON {"t": [{"n": número de la frase, "t": el seu tros}, …]} amb UNA entrada per a CADA número que et dono, sense ajuntar-ne cap.' +
            `\nTRADUCCIÓ OFICIAL:\n${official.slice(0, 30000)}` :
            `Tradueixes al ${NAMES[lang] || lang} el guió d'un acte al Palau de la Música Catalana, que es projectarà com a subtítols. ` +
            'Traducció natural i fidel, registre formal d\'acte públic. Els noms propis (persones, Orfeó Català, Palau de la Música Catalana, obres) no es tradueixen. ' +
            'Respon amb JSON {"t": [traducció de cada frase, en el mateix ordre i el mateix nombre]}.' +
            `\nGuió sencer, de context:\n${segments.map((s) => s.src).join(' ').slice(0, 12000)}` },
          { role: 'user', content: JSON.stringify(official ? batch.map((s, k) => `${i + k + 1}. ${s.src}`) : batch.map((s) => s.src)) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    let got = JSON.parse((await res.json()).choices[0].message.content).t;
    if (official && Array.isArray(got)) {
      // per número: si n'ajunta dues, la que falta es marca per revisar-la (millor que perdre-ho tot)
      const byN = new Map(got.map((x) => [Number(x?.n), String(x?.t ?? '')]));
      const missing = batch.filter((_, k) => !byN.get(i + k + 1)).length;
      if (missing > Math.max(2, batch.length / 4)) throw new Error(`n'ha deixat ${missing} sense tros`);
      got = batch.map((_, k) => byN.get(i + k + 1) || '⚠ (sense correspondència: revisa-ho)');
    }
    if (!Array.isArray(got) || got.length !== batch.length) throw new Error(`ha tornat ${got?.length} frases de ${batch.length}`);
    t = got;
    } catch (e) { console.error(`  ${lang}, lot ${i / STEP + 1}: ${e.message}${intent < 2 ? ' — es torna a provar' : ''}`); }
    }
    if (!t) throw new Error(`${lang}: no s'ha pogut traduir el lot ${i / STEP + 1}`);
    out.push(...t.map((x) => String(x).replace(/^\d+\.\s+/, '')));
  }
  return out;
}

for (const lang of TARGETS) {
  if (lang === SRC) { segments.forEach((s) => (s.tr[lang] = s.src)); continue; }
  const t = await translate(lang);
  t.forEach((x, i) => (segments[i].tr[lang] = String(x).trim()));
  console.log(`  ✓ ${NAMES[lang] || lang}`);
}

fs.writeFileSync(OUT, JSON.stringify({ source: SRC, targets: TARGETS, model: MODEL, made: new Date().toISOString(), from: path.basename(file), segments }, null, 2));
fs.writeFileSync(REV, segments.map((s, i) => `[${i + 1}] ${s.src}\n` + TARGETS.filter((l) => l !== SRC).map((l) => `    ${l.toUpperCase()}: ${s.tr[l]}`).join('\n')).join('\n\n') + '\n');
console.log(`\n✓ guio.json i guio-revisio.txt (${segments.length} frases). Revisa-ho i, si hi corregeixes res:\n  node guio.mjs --de-revisio guio-revisio.txt`);
