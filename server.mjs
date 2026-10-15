// Subtítols en directe amb OpenAI.
//
//   captura (navegador) ──PCM16 24 kHz + qui parla──▶ aquest servidor ──▶ OpenAI
//   pantalla (navegador) ◀───────────── text ───────────────┘
//
// La clau d'OpenAI només viu aquí (.env d'aquesta carpeta).
//
// Transcripció: tres modes (Precís / Equilibrat / Ràpid), es tria al panell.
//   El «minimal» de gpt-live-transcribe treu la paraula a ~0 s amb veu sintètica,
//   però amb veu natural (17/09/2026) s'equivocava prou més; i el Precís (whisper), amb un micro
//   d'ordinador en una sala, no treia gairebé res. Per defecte: Equilibrat.
//   Cada sessió desa l'àudio a sessions/*.wav → `npm run compara -- <wav>` per decidir-ho amb dades.
//   - traducció en STREAMING, una crida per llengua i en paral·lel: primera paraula
//     a ~0,5 s (la crida única amb JSON de les tres llengües en trigava 1,4-2).
//   - es tradueix la frase MENTRE es diu, i es refà quan s'acaba.
//
// PONENTS: els models en directe no distingeixen veus. Es fa com a una taula de
// so: cada ponent té el seu micro (canal de la targeta) i el navegador envia
// només el canal del que parla més fort. Així se sap qui parla i un micro no
// repeteix el que capta de l'altre.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createNative, listDevices } from './nadiu.mjs';
import { createPrompter } from './prompter.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR: on viuen .env, guio.json i sessions/. Per defecte, aquesta carpeta (com sempre); l'app
// autònoma hi passa ~/Documents/Subtitols-IMESDE perquè el codi pot ser dins d'un paquet de només lectura.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DIR;
try { process.loadEnvFile(path.join(DATA_DIR, '.env')); } catch { /* sense .env */ }
try { fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true }); } catch {}

const API_KEY = process.env.OPENAI_API_KEY;
const PORT = Number(process.env.PORT || 4321);
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4.1-mini';
const MAX_SENTENCE = Number(process.env.MAX_SENTENCE || 120); // caràcters abans de tallar a la coma
const IDLE_COMMIT_MS = Number(process.env.IDLE_COMMIT_MS || 1100); // silenci que tanca la frase
const REOPEN_MS = Number(process.env.REOPEN_MS || 3000); // fins quan un signe de puntuació tardà s'enganxa a la frase anterior
// Minuts sense que es digui res → s'atura sol. 0 = mai (el per defecte des del 14/10/2026: en un concert
// hi ha peces de música de més de 10 minuts sense parlar, i l'aturada matava la sessió en ple acte).
const IDLE_STOP_MIN = Number(process.env.IDLE_STOP_MIN || 0);

// Modes de transcripció (es trien al panell). Amb veu natural, el «minimal» s'equivoca més.
const MODES = {
  precis:     { label: 'Precís',     model: 'gpt-realtime-whisper' },
  equilibrat: { label: 'Equilibrat', model: 'gpt-live-transcribe', delay: 'low' },
  rapid:      { label: 'Ràpid',      model: 'gpt-live-transcribe', delay: 'minimal' },
};
const PARTIAL_MS = Number(process.env.PARTIAL_MS || 350); // cada quant es retradueix la frase en curs

if (!API_KEY) {
  console.error('\n✖ Falta OPENAI_API_KEY. Crea un fitxer .env en aquesta carpeta amb:\n  OPENAI_API_KEY=sk-...\n');
  process.exit(1);
}

const BOOT_ID = Date.now().toString(36);
const CODE_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).version; } catch { return '?'; } })(); // el panell sap si el servidor s'ha reiniciat
const LANG_NAMES = { ca: 'català', es: 'castellà', en: 'anglès', fr: 'francès', it: 'italià', de: 'alemany', pt: 'portuguès' };

// ─── Estat ──────────────────────────────────────────────────────────────────
const state = {
  listening: true, // «No escolta»: l'àudio s'envia com a silenci (la sessió segueix viva i no salta cap alarma)
  screenClearAt: 0, // «Netejar pantalla»: la pantalla del públic deixa anar tot el text d'abans d'aquest moment
  running: false,
  startedAt: null,
  audioMs: 0,
  config: { mode: 'equilibrat', sourceLang: 'auto', showMap: {}, targets: ['ca', 'es', 'en'], prompt: '', speakers: [], speakerLangs: [] },
  display: null, // configuració de la pantalla que tria l'operador
  errors: [],
  latency: { translate: null },
  usage: { calls: 0, aborted: 0, input: 0, cached: 0, output: 0, estInput: 0 },
};

// Preus d'OpenAI (17/09/2026, developers.openai.com/api/docs/pricing), en dòlars
const PRICE = { transcribeMin: 0.017, input: 0.40 / 1e6, cached: 0.10 / 1e6, output: 1.60 / 1e6 };
function costUSD() {
  const u = state.usage;
  const input = u.input - u.cached + u.estInput;
  return (state.audioMs / 60000) * PRICE.transcribeMin + input * PRICE.input + u.cached * PRICE.cached + u.output * PRICE.output;
}
let blocks = [];       // frases: { id, speaker, src, tr:{}, final, t0, tEnd }
let open = null;       // frase en curs
let nextId = 1;
let upstream = null;
let logFile = null;
let wav = null;          // { fd, bytes } — l'àudio de la sessió, per poder comparar models després
let lastSpeech = 0;      // última vegada que es va transcriure alguna cosa
let noOperatorSince = 0;
let noOperatorWarned = false;
let voicedMs = 0;         // ms d'àudio AMB VEU enviats des de l'últim text rebut
let lastRestart = 0;
let audioOwner = null;    // NOMÉS el panell que ha premut Començar pot enviar àudio (17/09/2026: dues pestanyes
                         // obertes enviaven àudio alhora i el model rebia un so trossejat)
const speakerTimeline = []; // { t, s } — qui parlava a cada moment
const operators = new Set();
const displays = new Set();

// ─── Difusió (agrupada: els deltes arriben paraula a paraula) ───────────────
let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    const base = {
      type: 'state',
      running: state.running,
      operators: operators.size,
      hasOwner: !!audioOwner,
      startedAt: state.startedAt,
      listening: state.listening,
      screenClearAt: state.screenClearAt,
      audioSeconds: Math.round(state.audioMs / 1000),
      config: state.config,
      display: state.display,
      latency: state.latency,
      usage: state.usage,
      costUSD: Math.round(costUSD() * 1000) / 1000,
      // Només els errors dels últims 3 minuts: un error passatger de fa dues hores no ha de quedar
      // a la vista tota la nit (s'acaba aprenent a no mirar-ho)
      errors: state.errors.filter((e) => Date.now() - e.t < 180000).slice(-4).map((e) => e.text),
      blocks: blocks.slice(-10).map((b) => ({ id: b.id, speaker: b.speaker, src: b.src, tr: b.tr, final: b.final, t0: b.t0, tEnd: b.tEnd, spoken: spokenLang(b) })),
      now: Date.now(),
      upstream: upstream?.readyState === WebSocket.OPEN ? 'open' : upstream?.readyState === WebSocket.CONNECTING ? 'connecting' : upstream ? 'down' : 'none',
      lastText: lastSpeech,
      fatal: state.fatal || null,
      bootId: BOOT_ID,
      fonts: fontList,
      native: native ? { active: native.status.active, name: native.status.name, uid: native.status.uid, channels: native.status.channels, levels: native.status.levels.map((v) => Math.round(v * 1e4) / 1e4), speaker: native.status.speaker, lastAt: native.status.lastAt, error: native.status.error } : null,
      guio: guio ? { from: guio.from || 'guio.json', n: guio.segments.length, made: guio.made || guio.revised || null, rev: guio.rev } : null,
      prompter: { ...prompter.position(), auto: prompterAuto },
    };
    const shared = JSON.stringify(base);
    for (const c of [...operators, ...displays]) {
      if (c.readyState !== WebSocket.OPEN || c.bufferedAmount > 2e6) continue; // un client penjat no acumula memòria
      // Cada panell sap si és ELL qui envia l'àudio (amb dos panells oberts, l'altre no ha de dir «en directe»)
      c.send(operators.has(c) ? JSON.stringify({ ...base, you: c === audioOwner }) : shared);
    }
  }, 30);
}

function pushError(where, err) {
  const text = `${new Date().toLocaleTimeString('ca-ES')} · ${where}: ${typeof err === 'string' ? err : err?.message || JSON.stringify(err)}`;
  console.error('✖', text);
  state.errors.push({ t: Date.now(), text });
  if (state.errors.length > 50) state.errors.splice(0, state.errors.length - 50);
  broadcast();
}

// El registre no pot fer caure mai el servidor (disc ple, carpeta esborrada…)
const log = (entry) => {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); }
  catch (e) { console.error('✖ registre:', e.message); }
};
const smooth = (prev, v) => (prev == null ? v : Math.round(prev * 0.7 + v * 0.3));

// ─── Guió de l'acte (opcional) ─────────────────────────────────────────────
// guio.json (el fa `node guio.mjs guio.txt`): frases del guió amb la seva traducció de referència.
// Per a cada frase que es tradueix, es busca el tros del guió que s'hi assembla i se'n passa la
// traducció al model. No hi ha cap risc si no s'hi assembla res: la traducció va com sempre.
const GUIO_FILE = process.env.GUIO ? path.resolve(process.env.GUIO) : path.join(DATA_DIR, 'guio.json');
let guio = null;   // { segments: [{ src, tr, words:Set }] }
// La CARTA (prompter, prompter.mjs): on som del guió, seguint la veu o a mà
const prompter = createPrompter();
let prompterAuto = true; // seguir la veu (si no, només avança a mà)
let guioPos = -1;  // on érem del guió (per preferir el que ve a continuació)
const contentWords = (t) => new Set(t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
function loadGuio() {
  try {
    if (!fs.existsSync(GUIO_FILE)) { guio = null; prompter.load([]); broadcast(); return; }
    const g = JSON.parse(fs.readFileSync(GUIO_FILE, 'utf8'));
    guio = { ...g, segments: (g.segments || []).map((x) => ({ ...x, words: contentWords(x.src) })) };
    guio.rev = `${g.made || g.revised || ''}·${fs.statSync(GUIO_FILE).mtimeMs}`;
    guioPos = -1;
    prompter.load(guio.segments);
    console.log(`  ✓ Guió carregat: ${guio.segments.length} frases (${g.from || 'guio.json'})`);
  } catch (e) { guio = null; prompter.load([]); pushError('guió', `no s'ha pogut llegir guio.json (${e.message})`); }
  broadcast();
}
loadGuio();
try { fs.watchFile(GUIO_FILE, { interval: 2000 }, () => loadGuio()); } catch {}

// Noms propis del guió (paraules en majúscula que no comencen frase): ajuden la transcripció a escriure'ls bé
function guioNames() {
  if (!guio?.segments.length) return '';
  const names = new Set();
  for (const seg of guio.segments) {
    const words = seg.src.split(/\s+/).slice(1).join(' ');
    for (const m of words.matchAll(/\p{Lu}[\p{L}'’·-]+(?:\s+(?:de |del |d’|d'|i |la |el )?\p{Lu}[\p{L}'’·-]+)*/gu)) names.add(m[0]);
  }
  return [...names].join(', ').slice(0, 700);
}

// El tros del guió que s'assembla més a un text (i el següent, perquè una frase pot quedar entre dos)
function guioMatch(text) {
  if (!guio?.segments.length) return null;
  const w = contentWords(text);
  if (w.size < 2) return null;
  let best = -1, bestScore = 0;
  guio.segments.forEach((seg, i) => {
    let hit = 0;
    for (const x of w) if (seg.words.has(x)) hit++;
    let score = hit / w.size;
    if (guioPos >= 0 && i >= guioPos && i <= guioPos + 3) score += 0.1; // el que ve a continuació és el més probable
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (bestScore < 0.5) return null;
  return { i: best, segs: guio.segments.slice(Math.max(0, best - 1), best + 2) };
}

// ─── Traducció en streaming ─────────────────────────────────────────────────
// La xarxa falla de tant en tant («fetch failed»): es reintenta dues vegades abans de rendir-se
async function streamTranslate(text, lang, onText, signal, final = false, srcLang = null) {
  for (let intent = 0; ; intent++) {
    try { return await streamTranslateOnce(text, lang, onText, signal, final, srcLang); }
    catch (e) {
      // Un 4xx és definitiu (clau, model, petició mal feta) TRET del 429 (límit de ritme) i el 408:
      // amb un acte de molta parla, un 429 deixava la frase traduïda a mitges per sempre
      const st = /traducció (\d{3})/.exec(e.message)?.[1];
      const fatal = st && st[0] === '4' && st !== '429' && st !== '408';
      // Una frase ACABADA s'insisteix ~15 s (un tall de xarxa del 15/10/2026 va durar 17 s i les traduccions
      // morien al tercer intent, en 0,75 s); una de parcial no cal: ja arribarà la final.
      const maxIntents = final ? 6 : 2;
      if (e.name === 'AbortError' || intent >= maxIntents || fatal) throw e;
      await new Promise((r) => setTimeout(r, st === '429' ? 1000 * (intent + 1) : final ? Math.min(500 * 2 ** intent, 5000) : 250 * (intent + 1)));
    }
  }
}

async function streamTranslateOnce(text, lang, onText, signal, final = false, srcLang = null) {
  const context = blocks.filter((b) => b.final && b.src && b.src.trim() !== text.trim()).slice(-3).map((b) => b.src).join(' ');
  const m = guioMatch(text);
  if (m && final) guioPos = m.i;
  const ref = m ? m.segs.filter((s) => s.tr?.[lang]).map((s) => `«${s.src}» → «${s.tr[lang]}»`).join('\n') : '';
  const promptChars = 600 + text.length + context.length + ref.length + (state.config.prompt || '').length; // ~600 = instruccions
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    // Una traducció penjada (xarxa del recinte) no pot quedar-se la llengua 5 minuts: als 10 s es talla
    // i es reintenta (el TimeoutError no és un AbortError, o sigui que entra al reintent)
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            `Fas subtítols en directe d'un acte al Palau de la Música Catalana. Tradueix el text al ${LANG_NAMES[lang] || lang}. ` +
            `Si ja és en ${LANG_NAMES[lang] || lang}, torna'l igual, només net de tics i repeticions. ` +
            'Els noms propis catalans (Orfeó Català, Palau de la Música Catalana, noms de persones) no es tradueixen. ' +
            'El text pot estar a mitja frase: no el completis ni hi afegeixis res. Respon NOMÉS amb la traducció, sense cometes.' +
            (srcLang ? `\nQui parla s'expressa habitualment en ${LANG_NAMES[srcLang]} (si aquest tros és en una altra llengua, tradueix-lo igualment).` : '') +
            (state.config.prompt ? `\nInformació de l'acte: ${state.config.prompt}` : '') +
            (context ? `\nEl que s'acaba de dir (context, no ho tradueixis): ${context}` : '') +
            (ref ? `\nAquest fragment és, probablement, part del GUIÓ escrit de l'acte. Aquí tens el tros del guió i la seva traducció aprovada:\n${ref}\n` +
              'Fes servir la traducció aprovada per a les parts que el ponent diu igual que al guió (mateixes paraules i noms). ' +
              'Si diu una altra cosa, o només una part, tradueix EXACTAMENT el que diu, no el guió: no hi afegeixis res que no hagi dit.' : ''),
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`traducció ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  let usageDone = false;
  // Una traducció avortada no retorna l'ús però OpenAI la cobra: s'estima (≈3,5 caràcters per token)
  signal?.addEventListener('abort', () => { if (!usageDone) { state.usage.aborted++; state.usage.estInput += Math.ceil(promptChars / 3.5); } }, { once: true });
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data: {')) continue;
      const j = JSON.parse(l.slice(6));
      if (j.usage) {
        state.usage.calls++;
        state.usage.input += j.usage.prompt_tokens || 0;
        state.usage.cached += j.usage.prompt_tokens_details?.cached_tokens || 0;
        state.usage.output += j.usage.completion_tokens || 0;
        usageDone = true;
      }
      const d = j.choices?.[0]?.delta?.content;
      if (d) { out += d; onText(out, false); }
    }
  }
  onText(out, true);
  return out;
}

// Què es pot ensenyar d'una traducció nova sense fer ballar el que la gent ja llegeix:
//  - si només ALLARGA el que hi ha, sí (és el cas normal: la frase creix)
//  - si en canvia el principi, NOMÉS quan ja ha acabat i o bé toca poques paraules del
//    final, o bé aporta prou text nou per compensar-ho. La traducció final sempre guanya.
const wordsOf = (t) => t.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
function acceptTranslation(cur, out, { done, final }) {
  if (done && final) return true;
  const cw = wordsOf(cur);
  const ow = wordsOf(out);
  if (!cw.length) return true;
  let common = 0;
  while (common < cw.length && common < ow.length && cw[common] === ow[common]) common++;
  if (common === cw.length && ow.length > cw.length) return true;          // només afegeix
  if (!done) return false;                                                  // a mig escriure: esperem
  return cw.length - common <= 2 || ow.length >= cw.length + 5;
}

function translateBlock(block) {
  block.jobs ??= {};
  block.seq ??= {};
  const text = block.src.trim();
  const final = block.final;
  const jobs = [];
  // Idioma del que s'ha dit: el fixat a «Es parla en» quan va començar la frase o, si no, el del ponent.
  // A l'idioma que ja és el de l'original no es tradueix: surt tal qual.
  const srcL = block.srcLang && block.srcLang !== 'auto' ? block.srcLang : block.lang || null;
  // Tots els idiomes que poden sortir a la pantalla: els «Subtítols en» i els de la taula per idioma parlat
  const langs = [...new Set([...state.config.targets, ...Object.values(state.config.showMap || {}).flat()])];
  for (const lang of langs) {
    if (srcL === lang || !/\p{L}/u.test(text)) { block.tr[lang] = text; continue; }
    const running = block.jobs[lang];
    if (running && !final) continue; // parcial: si encara corre l'anterior, no n'engeguem una altra
    running?.abort();
    const ctrl = new AbortController();
    block.jobs[lang] = ctrl;
    const seq = (block.seq[lang] = (block.seq[lang] || 0) + 1);
    const t = Date.now();
    let first = true;
    jobs.push(
      streamTranslate(text, lang, (out, done) => {
        if (seq !== block.seq[lang]) return;
        if (first && out) { first = false; state.latency.translate = smooth(state.latency.translate, Date.now() - t); }
        if (acceptTranslation(block.tr[lang] || '', out, { done, final })) { block.tr[lang] = out.trim(); broadcast(); }
      }, ctrl.signal, final, srcL)
        .catch((e) => { if (e.name !== 'AbortError') pushError(`traducció ${lang}`, e); })
        .finally(() => { if (block.jobs[lang] === ctrl) block.jobs[lang] = null; }),
    );
  }
  broadcast();
  return Promise.all(jobs);
}

// Quin idioma s'ha parlat en una frase: el fixat (Parla / ponent) o, en automàtic, el de la traducció que
// ha sortit gairebé igual que l'original (traduir anglès a anglès el deixa tal qual)
const wordSet = (t) => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
function spokenLang(b) {
  const fixed = b.srcLang && b.srcLang !== 'auto' ? b.srcLang : b.lang;
  if (fixed) return fixed;
  const src = wordSet(b.src);
  if (src.size < 3) return null;
  let best = null, score = 0;
  for (const [lang, t] of Object.entries(b.tr || {})) {
    const w = wordSet(t); let h = 0; for (const x of src) if (w.has(x)) h++;
    const sc = h / Math.max(src.size, w.size);
    if (sc > score) { score = sc; best = lang; }
  }
  return score >= 0.6 ? best : null;
}

// ─── Frases ─────────────────────────────────────────────────────────────────
function speakerAt(t) {
  for (let i = speakerTimeline.length - 1; i >= 0; i--) if (speakerTimeline[i].t <= t) return speakerTimeline[i].s;
  return speakerTimeline[0]?.s ?? null;
}
const speakerName = (i) => (i == null || i === 255 ? null : state.config.speakers[i] || null);
// Idioma del ponent (si se n'ha triat un): indicació per a la traducció, no un interruptor
const speakerLang = (i) => { const l = i == null || i === 255 ? null : state.config.speakerLangs?.[i]; return l && l !== 'auto' && LANG_NAMES[l] ? l : null; };

function finalize(block) {
  if (!block || block.final) return;
  clearTimeout(block.idle);
  clearTimeout(block.trTimer);
  block.src = block.src.trim();
  block.final = true;
  block.tEnd = Date.now();
  if (open === block) open = null;
  if (prompterAuto) prompter.flush();
  if (!block.src) { blocks = blocks.filter((b) => b !== block); broadcast(); return; }
  translateBlock(block).then(() => log({ kind: 'frase', speaker: block.speaker, src: block.src, ...block.tr }));
}

function newBlock(speakerIdx) {
  const b = { id: nextId++, speakerIdx, speaker: speakerName(speakerIdx), lang: speakerLang(speakerIdx), srcLang: state.config.sourceLang, src: '', tr: {}, final: false, t0: Date.now(), tEnd: Date.now() };
  blocks.push(b);
  if (blocks.length > 60) blocks = blocks.slice(-40);
  open = b;
  return b;
}

function onTranscriptDelta(delta) {
  const now = Date.now();
  if (delta.trim()) { lastSpeech = now; voicedMs = 0; stallLimit = STALL_MS; }
  const sp = speakerAt(now - 300);
  if (open && open.speakerIdx !== sp && open.src.trim() && /^\s/.test(delta)) finalize(open);
  // Una pausa tanca la frase. NO la reobrim quan torna a parlar: amb veu natural
  // (sense punts) la frase creixia sense fi, es retraduïa sencera a cada pausa i la
  // pantalla s'embussava (17/09/2026). La pantalla ja pinta les frases seguides.
  const prev = blocks[blocks.length - 1];
  // Un signe de puntuació que arriba tard és de la frase anterior, parli qui parli ara
  if (!open && prev && now - prev.tEnd < REOPEN_MS) {
    const p = delta.match(/^\s*([.,;:!?…]+)/);
    if (p) {
      if (!/[.!?…]$/.test(prev.src)) {
        prev.src += p[1];
        for (const l of Object.keys(prev.tr)) if (prev.tr[l] && !/[.!?…]$/.test(prev.tr[l])) prev.tr[l] += p[1];
      }
      delta = delta.slice(p[0].length);
      if (!delta.trim()) { broadcast(); return; }
    }
  }
  if (prompterAuto && state.listening) prompter.feed(delta);
  let b = open || newBlock(sp);
  b.src += delta;
  b.tEnd = now;

  // Talla per frases: el punt, i si s'allarga massa, la coma
  let m;
  while ((m = b.src.match(/^(\s*.*?[.!?…]["»”)]?)\s+(?=\S)/s))) {
    const rest = b.src.slice(m[0].length);
    b.src = m[1];
    finalize(b);
    b = newBlock(sp);
    b.src = rest;
  }
  if (b.src.length > MAX_SENTENCE) {
    const s = b.src;
    const cut = Math.max(s.lastIndexOf(', ', MAX_SENTENCE), s.lastIndexOf('; ', MAX_SENTENCE));
    const at = cut > 40 ? cut + 1 : s.lastIndexOf(' ', MAX_SENTENCE);
    if (at > 40) { const rest = s.slice(at); b.src = s.slice(0, at); finalize(b); b = newBlock(sp); b.src = rest; }
  }

  clearTimeout(b.idle);
  b.idle = setTimeout(() => finalize(b), IDLE_COMMIT_MS);
  if (!b.trTimer && b.src.trim().split(/\s+/).length >= 2) {
    b.trTimer = setTimeout(() => { b.trTimer = null; if (!b.final) translateBlock(b); }, PARTIAL_MS);
  }
  broadcast();
}

// ─── Sessió de transcripció ─────────────────────────────────────────────────
let pendingAudio = [];
// Mesurat el 14/10/2026 amb el mateix àudio: amb commit a les pauses, 4 encallades en 12 min de veu; sense, 7
const COMMIT_PAUSE_MS = Number(process.env.COMMIT_PAUSE_MS ?? 600);
const recentAudio = []; // els últims ~8 s enviats: si la sessió s'encalla, es tornen a enviar a la nova
let quietMs = 0, uncommitted = false;   // àudio rebut mentre la sessió es connecta (missatges ja preparats)
let sttFailures = 0;     // connexions fallides seguides → espera creixent
function openStt() {
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Authorization: `Bearer ${API_KEY}` },
    // Sense això, una connexió que es penja a mig establir (xarxa del recinte) es quedava
    // «connectant» per sempre: ni es tancava ni la reconnectava cap vigilant
    handshakeTimeout: 8000,
  });
  ws.on('open', () => {
    const mode = MODES[state.config.mode] || MODES.equilibrat;
    const transcription = { model: process.env.TRANSCRIBE_MODEL || mode.model };
    const live = transcription.model === 'gpt-live-transcribe';
    if (live) transcription.delay = process.env.TRANSCRIBE_DELAY || mode.delay;
    // Llengües que es parlaran: la fixada a «Es parla en» o, si tots els ponents en tenen una, la llista
    const spk = (state.config.speakers || []).map((_, i) => speakerLang(i));
    const langs = state.config.sourceLang !== 'auto' ? [state.config.sourceLang]
      : spk.length && spk.every(Boolean) ? [...new Set(spk)] : null;
    if (langs) {
      if (live) transcription.languages = langs;
      else if (langs.length === 1) transcription.language = langs[0];
    }
    const names = guioNames();
    const sttPrompt = [state.config.prompt, names && `Noms: ${names}`].filter(Boolean).join('\n');
    if (live && sttPrompt) transcription.prompt = sttPrompt.slice(0, 1200);
    ws.openedAt = Date.now();
    // Si OpenAI no confirma la configuració, la sessió va amb els valors per defecte (sense transcripció)
    ws.confirmTimer = setTimeout(() => pushError('transcripció', 'OpenAI no ha confirmat la configuració de la sessió'), 6000);
    ws.lastUpdate = {
      type: 'session.update',
      session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, noise_reduction: { type: 'near_field' }, transcription } } },
    };
    ws.send(JSON.stringify(ws.lastUpdate));
    // L'àudio acumulat mentre no hi havia sessió ja no és «veu sense text» d'aquesta sessió: si no, el
    // vigilant d'encallades la mataria un segon després d'obrir-se (després de cada tall de xarxa)
    voicedMs = 0;
    lastRestart = Date.now();
    // L'àudio que ha arribat mentre es connectava (fins a 10 s) entra ara: abans es llençava,
    // i cada reconnexió (n'hi ha com a mínim una per hora: la sessió d'OpenAI té durada màxima) es menjava paraules
    for (const m of pendingAudio) ws.send(m);
    pendingAudio = [];
    sttFailures = 0;
    broadcast();
    console.log(`● transcripció connectada (${transcription.model}${transcription.delay ? ' · ' + transcription.delay : ''})`);
  });
  ws.on('message', (raw) => {
    if (ws !== upstream && ws !== retiring) return; // una sessió ja substituïda no pot barrejar text amb la nova
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    if (ev.type === 'conversation.item.input_audio_transcription.delta') onTranscriptDelta(ev.delta || '');
    // «completed» arriba després de cada commit (cada pausa de 0,6 s). NO tanca la frase: podria tancar la
    // següent, que ja ha començat, i a més faria frases massa curtes. La frase la tanca la pausa d'1,1 s.
    else if (ev.type === 'conversation.item.input_audio_transcription.completed') { /* res */ }
    else if (ev.type === 'session.updated') { clearTimeout(ws.confirmTimer); ws.confirmed = true; state.fatal = null; }
    else if (ev.type === 'error' && ev.error?.code === 'input_audio_buffer_commit_empty') { /* inofensiu */ }
    else if (ev.type === 'error' && !ws.confirmed && ws.lastUpdate?.session.audio.input.transcription.prompt && !ws.noPrompt) {
      // OpenAI ha refusat la configuració (p. ex. un context massa llarg): es torna a provar SENSE context,
      // millor subtítols sense noms ben escrits que cap subtítol
      ws.noPrompt = true;
      delete ws.lastUpdate.session.audio.input.transcription.prompt;
      ws.send(JSON.stringify(ws.lastUpdate));
      pushError('transcripció', `OpenAI ha refusat el context; es continua sense (${ev.error?.message || ev.error?.code || ''})`);
    }
    else if (ev.type === 'conversation.item.input_audio_transcription.failed') pushError('transcripció', ev.error || 'ha fallat un tros');
    else if (ev.type === 'error') pushError('transcripció', ev.error || ev);
  });
  // Un error d'una sessió que ja hem tancat a posta (stop, renovació) no és cap avaria
  ws.on('error', (e) => (ws === upstream ? pushError('connexió', e) : console.error('· sessió vella:', e.message)));
  ws.on('close', (code, reason) => {
    clearTimeout(ws.confirmTimer);
    if (upstream !== ws) return;
    if (open) finalize(open); // la frase a mitges no s'ha de quedar penjada esperant una sessió nova
    console.log(`○ transcripció tancada (${code} ${reason})`);
    if (/invalid_api_key|insufficient_quota|model_not_found|permission/.test(String(reason))) {
      state.fatal = /invalid_api_key/.test(String(reason)) ? 'La clau d’OpenAI no és vàlida (revisa el .env)'
        : /insufficient_quota/.test(String(reason)) ? 'El compte d’OpenAI no té saldo'
        : `OpenAI ha refusat la sessió (${reason})`;
      return pushError('OpenAI', `no es reconnecta (${reason})`);
    }
    // Reintent amb espera creixent (0,5 → 1 → 2 → 4 → 5 s): sense xarxa no s'ha d'inundar el registre,
    // però tampoc no s'ha de rendir mai
    const wait = Math.min(500 * 2 ** sttFailures++, 5000);
    if (state.running) setTimeout(() => { if (state.running && upstream === ws) { upstream = openStt(); broadcast(); } }, wait);
    broadcast();
  });
  return ws;
}

// ─── Captura multicanal nativa (bin/captura): sense el límit de 2 canals de Chrome ───
// Quan és activa, l'àudio el «posseeix» el servidor (NATIVE_OWNER), no cap panell: si el panell es tanca
// o es penja, l'àudio continua entrant.
const CAPTURA_BIN = process.env.SUBTITOLS_CAPTURA || path.join(DIR, 'bin', 'captura');
const NATIVE_OWNER = { native: true };
const native = createNative({ bin: CAPTURA_BIN, onFrame: (f) => onAudio(f, NATIVE_OWNER), onStatus: () => broadcast(), log: (t) => console.log(t) });
function applyInput() {
  const inp = state.config.input;
  if (state.running && inp?.native) {
    native.start(inp.native, inp.name, inp.channels, state.config.speakerChannels);
    audioOwner = NATIVE_OWNER;
  } else {
    if (native.status.active) native.stop();
    if (audioOwner === NATIVE_OWNER) audioOwner = null;
  }
}

function start(cfg) {
  stop();
  Object.assign(state.config, sanitizeConfig(cfg));
  state.running = true;
  state.listening = true;
  state.startedAt = Date.now();
  state.audioMs = 0;
  state.usage = { calls: 0, aborted: 0, input: 0, cached: 0, output: 0, estInput: 0 };
  state.errors = [];
  state.fatal = null;
  blocks = [];
  open = null;
  speakerTimeline.length = 0;
  pendingAudio = [];
  sttFailures = 0;
  stallLimit = STALL_MS;
  // Res de la sessió anterior (un assaig) no pot entrar a la nova
  voicedMs = 0; quietMs = 0; uncommitted = false; recentAudio.length = 0; lastRestart = Date.now(); guioPos = -1;
  clearTimeout(configRotateT); pendingCfgRotate = 0;
  logFile = path.join(DATA_DIR, 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  log({ kind: 'inici', ...state.config, TRANSLATE_MODEL });
  wav = openWav(logFile.replace(/\.jsonl$/, '.wav'));
  lastSpeech = Date.now();
  upstream = openStt();
  applyInput();
  console.log(`▶ inici · ${state.config.targets.join('/')} · registre: sessions/${path.basename(logFile)}`);
  broadcast();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  applyInput();
  const ws = upstream;
  upstream = null;
  try { ws?.close(); } catch {}
  if (open) finalize(open);
  closeWav();
  log({ kind: 'fi', audioSeconds: Math.round(state.audioMs / 1000), usage: state.usage, costUSD: costUSD() });
  console.log(`■ aturat · ${Math.round(state.audioMs / 1000)} s d'àudio`);
  broadcast();
}

function sanitizeConfig(c = {}) {
  const out = {};
  if (typeof c.sourceLang === 'string') out.sourceLang = c.sourceLang;
  if (c.showMap && typeof c.showMap === 'object') {
    out.showMap = {};
    for (const [sp, arr] of Object.entries(c.showMap)) if (LANG_NAMES[sp] && Array.isArray(arr)) out.showMap[sp] = [...new Set(arr.filter((l) => LANG_NAMES[l]))].slice(0, 4);
  }
  if (typeof c.mode === 'string' && MODES[c.mode]) out.mode = c.mode;
  if (Array.isArray(c.targets)) out.targets = c.targets.filter((t) => typeof t === 'string').slice(0, 6);
  if (typeof c.prompt === 'string') out.prompt = c.prompt.slice(0, 1500);
  if (Array.isArray(c.speakers)) out.speakers = c.speakers.map((s) => String(s || '').slice(0, 60));
  if (Array.isArray(c.speakerChannels)) out.speakerChannels = c.speakerChannels.map((n) => Math.max(0, Math.min(63, Number(n) | 0))).slice(0, 16);
  if ('input' in c) out.input = c.input && typeof c.input.native === 'string' && c.input.native.length < 300
    ? { native: c.input.native, name: String(c.input.name || '').slice(0, 120), channels: Number(c.input.channels) | 0 } : null;
  if (Array.isArray(c.speakerLangs)) out.speakerLangs = c.speakerLangs.map((l) => (typeof l === 'string' && (l === 'auto' || LANG_NAMES[l]) ? l : 'auto')).slice(0, 16);
  return out;
}

// Trama d'àudio: [1 byte: índex del ponent, 255 = sense] + PCM16
function onAudio(buf, from) {
  // Si ningú no té l'àudio (el panell s'ha reconnectat després d'un tall de xarxa o d'adormir-se),
  // el primer panell que n'envia se'l queda. Abans el servidor el llençava en silenci, el panell
  // seguia dient «en directe» i als 2 minuts la sessió s'aturava sola.
  if (state.running && !audioOwner && operators.has(from) && !native.status.active) { audioOwner = from; noOperatorSince = 0; broadcast(); }
  if (!state.running || buf.length < 3 || from !== audioOwner) return;
  const sp = buf[0];
  // Sense escoltar: silenci del mateix llarg (la sessió, els rellotges i les pauses segueixen igual)
  const pcm = state.listening ? buf.subarray(1) : Buffer.alloc(buf.length - 1);
  const now = Date.now();
  const last = speakerTimeline[speakerTimeline.length - 1];
  if (!last || last.s !== sp) speakerTimeline.push({ t: now, s: sp });
  while (speakerTimeline.length > 2 && now - speakerTimeline[1].t > 10000) speakerTimeline.shift();
  state.audioMs += (pcm.length / 2 / 24000) * 1000;
  // Hi ha veu en aquest tros? (RMS per sobre de ~-34 dBFS)
  let sum = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i += 4) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  const voiced = Math.sqrt(sum / Math.max(1, n / 4)) > 650;
  if (voiced) { voicedMs += (n / 24000) * 1000; quietMs = 0; uncommitted = true; }
  else quietMs += (n / 24000) * 1000;
  if (wav) {
    // Desar l'àudio és un extra: si el disc falla, es deixa de desar però els subtítols segueixen
    try { fs.writeSync(wav.fd, pcm); wav.bytes += pcm.length; }
    catch (e) { pushError('enregistrament', e); closeWav(); }
  }
  const msg = JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  recentAudio.push({ t: now, msg }); if (recentAudio.length > 80) recentAudio.shift();
  if (upstream?.readyState === WebSocket.OPEN) upstream.send(msg);
  else { pendingAudio.push(msg); if (pendingAudio.length > 300) pendingAudio.shift(); } // fins a 30 s mentre es reconnecta
  // Sense detecció de torns al servidor (aquests models no en tenen), la documentació demana tancar
  // cada tros amb un «commit»: s'envia a cada pausa (COMMIT_PAUSE_MS de silenci després de veu)
  if (COMMIT_PAUSE_MS > 0 && uncommitted && quietMs >= COMMIT_PAUSE_MS && upstream?.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    uncommitted = false;
  }
}

function openWav(file) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.alloc(44));
  return { fd, bytes: 0, file };
}
function closeWav() {
  if (!wav) return;
  try {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + wav.bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(wav.bytes, 40);
  fs.writeSync(wav.fd, h, 0, 44, 0);
  fs.closeSync(wav.fd);
  } catch (e) { console.error('✖ wav:', e.message); }
  wav = null;
}

// Vigilant: una sessió oblidada no pot quedar enviant àudio (i costant diners) tota la nit
setInterval(() => {
  if (!state.running) return;
  const now = Date.now();
  if (IDLE_STOP_MIN > 0 && now - lastSpeech > IDLE_STOP_MIN * 60000) {
    pushError('Aturat sol', `fa ${IDLE_STOP_MIN} minuts que no es diu res`);
    stop();
  } else if (!audioOwner) {
    // Sense panell no s'envia àudio a OpenAI (no costa res), o sigui que no hi ha pressa per aturar:
    // 30 minuts de marge perquè un panell que ha petat o s'ha adormit es pugui tornar a obrir
    // sense perdre la sessió. (Abans eren 2 minuts i un tall de Wi-Fi acabava aturant l'acte.)
    // Un tall d'un segon (el panell es reconnecta sol) no és cap avaria: només s'avisa si dura >10 s
    if (!noOperatorSince) { noOperatorSince = now; noOperatorWarned = false; }
    if (!noOperatorWarned && now - noOperatorSince > 10000) { noOperatorWarned = true; pushError('Panell', "no arriba àudio de cap panell de captura"); }
    if (now - noOperatorSince > 30 * 60000) { pushError('Aturat sol', "fa 30 minuts que no hi ha cap panell de captura"); stop(); }
  } else noOperatorSince = 0;
}, 5000);

// Vigilant d'encallades: la sessió en directe d'OpenAI de vegades deixa de retornar text
// amb la connexió oberta (17/09/2026: 65 s en blanc amb una veu perfectament transcrivible).
// Si arriben uns segons de VEU i cap paraula, es refà la sessió.
// ⚠ La MÚSICA també passa el llindar de «veu»: durant una peça llarga això refeia la sessió
// 4 cops per minut. Per això l'espera es dobla a cada reinici que no porta text (6 → 12 → 24 … → 120 s)
// i torna a 6 s així que es transcriu alguna cosa.
const STALL_MS = Number(process.env.STALL_MS || 6000);
let stallLimit = STALL_MS;
setInterval(() => {
  if (!state.running || !upstream || upstream.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (voicedMs < stallLimit || now - lastRestart < 15000) return;
  stallLimit = Math.min(stallLimit * 2, 120000);
  console.log(`↻ transcripció encallada (${Math.round(voicedMs / 1000)} s de veu sense text): es reconnecta`);
  log({ kind: 'reconnexio', voicedMs });
  // El que s'ha dit mentre estava encallada no s'ha transcrit: es torna a enviar a la sessió nova
  // (arriba uns segons tard, però arriba). Com a molt el que ha durat l'encallada, i 8 s.
  const since = Math.max(lastSpeech, now - 8000) - 500;
  const replay = recentAudio.filter((x) => x.t >= since).map((x) => x.msg);
  lastRestart = now;
  voicedMs = 0;
  if (open) finalize(open);
  const old = upstream;
  upstream = openStt();
  pendingAudio = replay.concat(pendingAudio).slice(-300);
  uncommitted = true;
  try { old.close(); } catch {}
}, 1000);

// Renovació de la sessió: OpenAI talla cada sessió als 60 minuts. En lloc d'esperar el tall (que pot
// caure a mitja frase), es renova a partir dels 50 minuts aprofitant una pausa, i als 57 sí o sí.
// L'àudio de mentre es connecta la nova es guarda i hi entra en obrir-se (pendingAudio).
const ROTATE_MIN = Number(process.env.ROTATE_MIN || 50);
function rotateStt(why) {
  if (!state.running) return;
  console.log(`↻ renovació de la sessió de transcripció (${why})`);
  log({ kind: 'renovacio', why });
  const old = upstream;
  upstream = openStt();
  lastRestart = Date.now();
  voicedMs = 0;
  // La sessió vella encara pot tenir a punt el text dels últims segons: se l'escolta 2,5 s més abans de tancar-la
  retiring = old;
  setTimeout(() => { try { old?.close(); } catch {} if (retiring === old) retiring = null; }, 2500);
  broadcast();
}
let retiring = null;
setInterval(() => {
  if (!state.running || upstream?.readyState !== WebSocket.OPEN || !upstream.openedAt) return;
  const age = Date.now() - upstream.openedAt;
  const pause = !open && Date.now() - lastSpeech > 1500 && quietMs > 1000;
  if (pendingCfgRotate && (pause || Date.now() - pendingCfgRotate > 20000)) { pendingCfgRotate = 0; return rotateStt('configuració'); }
  if (age > (ROTATE_MIN + 7) * 60000) rotateStt('límit');
  else if (age > ROTATE_MIN * 60000 && pause) rotateStt('pausa');
}, 500);

// Panells que ja no responen (Wi-Fi penjada sense tancar): fora, perquè no es quedin l'àudio
setInterval(() => {
  for (const c of operators) {
    if (c.isAlive === false) { try { c.terminate(); } catch {} continue; }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}, 5000);

// Latit: l'estat surt com a mínim cada 2 s, perquè panell i pantalla detectin una connexió morta
setInterval(broadcast, 2000);

// ─── HTTP + WebSockets locals ───────────────────────────────────────────────
function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

// ─── Tipografies pròpies (es pugen des del panell i les fa servir la pantalla) ──
// Viuen a la carpeta de dades (no al codi: sobreviuen a les actualitzacions). Pujar-ne o esborrar-ne
// només des d'aquest mateix ordinador; servir-les, a qualsevol pantalla de la xarxa.
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const FONT_TYPES = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const FONT_NAME = /^[\p{L}\p{N} ._()-]{1,80}\.(ttf|otf|woff2?)$/iu;
let fontList = [];
function refreshFonts() {
  try { fontList = fs.readdirSync(FONTS_DIR).filter((f) => FONT_NAME.test(f)).sort(); } catch { fontList = []; }
}
refreshFonts();
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// Que sigui de debò una tipografia (capçalera del fitxer), no qualsevol cosa amb l'extensió canviada
function looksLikeFont(buf) {
  const sig = buf.subarray(0, 4).toString('latin1');
  return sig === 'wOFF' || sig === 'wOF2' || sig === 'OTTO' || sig === 'true' || buf.readUInt32BE(0) === 0x00010000;
}
function handleFonts(req, res, url) {
  const name = decodeURIComponent(url.pathname.slice('/fonts/'.length));
  if (req.method === 'GET') {
    if (!FONT_NAME.test(name) || !fontList.includes(name)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': FONT_TYPES[name.split('.').pop().toLowerCase()], 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(path.join(FONTS_DIR, name)).pipe(res);
  }
  if (!isLocal(req)) { res.writeHead(403); return res.end('només des d’aquest ordinador'); }
  if (req.method === 'DELETE') {
    if (!FONT_NAME.test(name)) { res.writeHead(400); return res.end('nom'); }
    try { fs.unlinkSync(path.join(FONTS_DIR, name)); } catch {}
    refreshFonts(); broadcast();
    res.writeHead(200); return res.end('ok');
  }
  if (req.method === 'POST') {
    if (!FONT_NAME.test(name)) { res.writeHead(400); return res.end('Nom de fitxer no vàlid (ha de ser .ttf, .otf, .woff o .woff2)'); }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 20e6) { res.writeHead(413); res.end('massa gran (màx. 20 MB)'); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (res.writableEnded) return;
      const buf = Buffer.concat(chunks);
      if (buf.length < 12 || !looksLikeFont(buf)) { res.writeHead(400); return res.end('Aquest fitxer no és una tipografia'); }
      try { fs.mkdirSync(FONTS_DIR, { recursive: true }); fs.writeFileSync(path.join(FONTS_DIR, name), buf); }
      catch (e) { res.writeHead(500); return res.end(e.message); }
      refreshFonts(); broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name }));
    });
    return;
  }
  res.writeHead(405); res.end();
}

const FILES = { '/': 'captura.html', '/captura': 'captura.html', '/pantalla': 'pantalla.html', '/pcm-worklet.js': 'pcm-worklet.js' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ running: state.running, version: CODE_VERSION, lan: lanUrls(), modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])), models: { TRANSLATE_MODEL } }));
  }
  if (url.pathname.startsWith('/fonts/')) return handleFonts(req, res, url);
  // El guió sencer per a la carta (no viatja a cada estat: només quan canvia, per «rev»)
  if (url.pathname === '/guio') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(guio ? { rev: guio.rev, from: guio.from || 'guio.json', source: guio.source || null, segments: guio.segments.map((x) => ({ src: x.src, tr: x.tr || {} })) } : null));
  }
  if (url.pathname === '/native/devices') {
    return listDevices(CAPTURA_BIN).then((r) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(r)); });
  }
  const brand = url.pathname.match(/^\/brand\/([\w-]+\.png)$/);
  const file = brand ? `brand/${brand[1]}` : FILES[url.pathname];
  if (!file || !fs.existsSync(path.join(DIR, 'public', file))) { res.writeHead(404); return res.end('no'); }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(DIR, 'public', file)).pipe(res);
});

let configRotateT = null;
let pendingCfgRotate = 0;
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const isOperator = new URL(req.url, 'http://x').pathname === '/ws/captura';
  (isOperator ? operators : displays).add(ws);
  broadcast();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => console.error('✖ client local:', e.message)); // sense això, una trama dolenta feia caure el servidor
  ws.on('message', (data, isBinary) => {
    if (!isOperator) return;
    if (isBinary) return onAudio(Buffer.from(data), ws);
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start') { audioOwner = ws; start(msg.config); }
    else if (msg.type === 'claim') { if (state.running && !native.status.active) { audioOwner = ws; noOperatorSince = 0; broadcast(); } }
    else if (msg.type === 'stop') stop();
    else if (msg.type === 'clear') { blocks = []; open = null; state.screenClearAt = Date.now(); broadcast(); }
    else if (msg.type === 'clearScreen') { state.screenClearAt = Date.now(); broadcast(); }
    else if (msg.type === 'listen') { state.listening = !!msg.on; log({ kind: 'escolta', on: state.listening }); broadcast(); }
    else if (msg.type === 'config') {
      const before = JSON.stringify([state.config.mode, state.config.sourceLang, state.config.prompt, state.config.speakerLangs]);
      const srcBefore = state.config.sourceLang;
      const wasInput = JSON.stringify(state.config.input || null);
      Object.assign(state.config, sanitizeConfig(msg.config));
      native.setSpeakers(state.config.speakerChannels);
      if (state.running && JSON.stringify(state.config.input || null) !== wasInput) applyInput(); // canvi d'entrada en directe
      // El context, l'idioma i el mode s'envien a OpenAI en obrir la sessió: si canvien en directe, es renova
      if (state.running && before !== JSON.stringify([state.config.mode, state.config.sourceLang, state.config.prompt, state.config.speakerLangs])) {
        pendingCfgRotate ||= Date.now(); // a la pròxima pausa (o en 20 s), no a mitja frase
        // Canvi d'idioma parlat: qui comença a parlar en un altre idioma no pot esperar 20 s (a la pausa o en 3 s)
        if (state.config.sourceLang !== srcBefore) pendingCfgRotate = Math.min(pendingCfgRotate, Date.now() - 17000);
      }
      broadcast();
    }
    else if (msg.type === 'display') { state.display = msg.display; broadcast(); }
    else if (msg.type === 'prompter') {
      if (msg.op === 'goto' && Number.isFinite(msg.i)) prompter.goTo(msg.i);
      else if (msg.op === 'step') prompter.step(msg.d < 0 ? -1 : 1);
      else if (msg.op === 'auto') prompterAuto = !!msg.on;
      log({ kind: 'carta', op: msg.op, ...prompter.position(), auto: prompterAuto });
      broadcast();
    }
  });
  ws.on('close', () => { operators.delete(ws); displays.delete(ws); if (ws === audioOwner) audioOwner = null; });
});

// Comprovació en engegar: millor saber ARA que la clau no va que no pas en començar l'acte
async function checkKey() {
  try {
    const r = await fetch('https://api.openai.com/v1/models/' + TRANSLATE_MODEL, { headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { console.log('  ✓ Clau d’OpenAI vàlida\n'); state.fatal = null; }
    else {
      const t = (await r.text()).slice(0, 160);
      // Només una clau refusada és definitiva; un 429/5xx en arrencar és passatger
      if (r.status === 401 || r.status === 403) state.fatal = 'La clau d’OpenAI no és vàlida (revisa el .env)';
      console.error(`\n  ✖✖ OpenAI respon ${r.status}: ${t}\n`);
    }
  } catch (e) { console.error(`\n  ✖ No es pot arribar a OpenAI (${e.message}): hi ha internet? Es torna a provar en 30 s\n`); setTimeout(checkKey, 30000); }
  broadcast();
}
server.listen(PORT, () => {
  checkKey();
  console.log(`\nSubtítols en directe\n  Captura:  http://localhost:${PORT}/captura\n  Pantalla: http://localhost:${PORT}/pantalla`);
  for (const u of lanUrls()) console.log(`  Xarxa:    ${u}/pantalla`);
  console.log(`\n  Transcripció: segons el mode triat al panell · Traducció: ${TRANSLATE_MODEL}\n`);
});
// Xarxa de seguretat: un error inesperat es mostra al panell però NO atura el servidor en ple acte
process.on('uncaughtException', (e) => { try { pushError('error intern', e); } catch { console.error(e); } });
process.on('unhandledRejection', (e) => { try { pushError('error intern', e); } catch { console.error(e); } });
wss.on('error', (e) => console.error('✖ wss:', e.message));
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n✖ El port ${PORT} ja és en ús: ja hi ha un servidor obert (mira els altres Terminals).\n` : e);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(0); });
