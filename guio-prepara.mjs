// Preparació d'un GUIÓ: text → frases → traducció de referència (o encaix amb les traduccions oficials).
// Ho fan servir el servidor («Preparar guió» del panell) i guio.mjs (Terminal).

export const LANG_NAMES = { ca: 'català', es: 'castellà', en: 'anglès', fr: 'francès', it: 'italià', de: 'alemany', pt: 'portuguès' };

// Les línies que un PDF parteix a mitja frase es tornen a ajuntar (una línia que comença en minúscula
// continua l'anterior)
export const unwrapText = (t) => String(t || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  .reduce((acc, l) => { if (acc.length && /^\p{Ll}/u.test(l)) acc[acc.length - 1] += ' ' + l; else acc.push(l); return acc; }, []).join('\n');

// Frases. Cada línia és un tros (un salt de línia sempre talla). Fora: acotacions entre [ ] i ( ),
// números de línia («1.», «2)») i etiquetes de qui parla («PRESENTADORA:», «Joan Puig:»).
const ABBR = /(?:\b(?:Sr|Sra|Srs|Dr|Dra|núm|Núm|pàg|etc|aprox|tel|av|c|St|Sta|Mr|Mrs|Ms|Prof|vol|op|Op|n|No)\.|\b\d+\.)$/;
export function splitSegments(text, { unwrap = true } = {}) {
  let t = String(text || '').replace(/\r/g, '');
  if (unwrap) t = unwrapText(t);
  const segments = [];
  for (const line of t.split(/\n+/)) {
    const p = line.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
      .replace(/^\s*\d+\s*[.)]\s+/, '')
      .replace(/^\s*[\p{Lu}][\p{L} .'’-]{0,40}:\s+/u, (m) => (/\d/.test(m) ? m : ''))
      .replace(/\s+/g, ' ').trim();
    if (!p || !/\p{L}/u.test(p)) continue;
    // Un punt només acaba frase si darrere hi ha un espai o el final (així «9.30» i «1.500» no es parteixen)
    const parts = p.match(/.+?[.!?…]+["»”)]*(?=\s|$)|.+$/g) || [p];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc} ${part.trim()}` : part.trim();
      if (ABBR.test(acc) || acc.length < 4) continue; // «Sr.», «9.» no acaben la frase
      segments.push({ src: acc, tr: {} });
      acc = '';
    }
    if (acc && /\p{L}/u.test(acc)) segments.push({ src: acc, tr: {} });
  }
  return segments;
}

// Traducció de totes les frases a una llengua: amb la traducció OFICIAL (n'encaixa els trossos literals)
// o traduint-les (amb tot el guió de context). Retorna un array amb una traducció per frase.
export async function translateSegments(segments, lang, { key, model = 'gpt-4.1', official = null, onLog = () => {}, fetchFn = fetch } = {}) {
  const out = [];
  const off = official ? unwrapText(official) : null;
  const STEP = off ? 20 : 40;
  for (let i = 0; i < segments.length; i += STEP) {
    const batch = segments.slice(i, i + STEP);
    let t;
    for (let intent = 0; intent < 3 && !t; intent++) {
      try {
        const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(120000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: off ? 0 : 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: off ?
                `Tens el text d'un guió (frases numerades en ordre) i la seva TRADUCCIÓ OFICIAL al ${LANG_NAMES[lang] || lang}. ` +
                'Per a cada frase, copia LITERALMENT el tros de la traducció oficial que hi correspon (mateixes paraules, sense retocar-les ni traduir de nou). ' +
                'Si la traducció oficial ajunta o parteix frases de manera diferent, reparteix-ho perquè cada frase tingui el seu tros, sense repetir ni perdre text. ' +
                'Si una frase no té cap correspondència a la traducció oficial, tradueix-la tu i comença-la amb «⚠ ». ' +
                'Respon amb JSON {"t": [{"n": número de la frase, "t": el seu tros}, …]} amb UNA entrada per a CADA número que et dono, sense ajuntar-ne cap.' +
                `\nTRADUCCIÓ OFICIAL:\n${off.slice(0, 60000)}` :
                `Tradueixes al ${LANG_NAMES[lang] || lang} el guió d'un acte al Palau de la Música Catalana, que es projectarà com a subtítols. ` +
                'Traducció natural i fidel, registre formal d\'acte públic. Els noms propis (persones, Orfeó Català, Palau de la Música Catalana, obres) no es tradueixen. ' +
                'Respon amb JSON {"t": [traducció de cada frase, en el mateix ordre i el mateix nombre]}.' +
                `\nGuió sencer, de context:\n${segments.map((s) => s.src).join(' ').slice(0, 12000)}` },
              { role: 'user', content: JSON.stringify(off ? batch.map((s, k) => `${i + k + 1}. ${s.src}`) : batch.map((s) => s.src)) },
            ],
          }),
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        let got = JSON.parse((await res.json()).choices[0].message.content).t;
        if (off && Array.isArray(got)) {
          const byN = new Map(got.map((x) => [Number(x?.n), String(x?.t ?? '')]));
          const missing = batch.filter((_, k) => !byN.get(i + k + 1)).length;
          if (missing > Math.max(2, batch.length / 4)) throw new Error(`n'ha deixat ${missing} sense tros`);
          got = batch.map((_, k) => byN.get(i + k + 1) || '⚠ (sense correspondència: revisa-ho)');
        }
        if (!Array.isArray(got) || got.length !== batch.length) throw new Error(`ha tornat ${got?.length} frases de ${batch.length}`);
        t = got;
      } catch (e) { onLog(`${lang}, lot ${i / STEP + 1}: ${e.message}${intent < 2 ? ' — es torna a provar' : ''}`); }
    }
    if (!t) throw new Error(`${LANG_NAMES[lang] || lang}: no s'ha pogut traduir el lot ${i / STEP + 1}`);
    out.push(...t.map((x) => String(x).replace(/^\d+\.\s+/, '').trim()));
  }
  return out;
}

// Tot el procés. texts: els documents en l'ordre de l'acte. official: { en: text, es: text } (opcional).
export async function prepareScript({ texts, src = 'ca', targets = ['es', 'en'], official = {}, key, model = 'gpt-4.1', from = '', onProgress = () => {}, onLog = () => {}, fetchFn = fetch }) {
  const segments = splitSegments(texts.join('\n\n'));
  if (!segments.length) throw new Error('No he trobat cap frase als documents');
  const langs = targets.filter((l) => l !== src);
  onProgress({ stage: 'frases', segments: segments.length, done: 0, total: langs.length });
  for (const s of segments) s.tr[src] = s.src;
  let done = 0;
  for (const lang of langs) {
    onProgress({ stage: official[lang] ? `encaixant la traducció oficial (${LANG_NAMES[lang] || lang})` : `traduint al ${LANG_NAMES[lang] || lang}`, segments: segments.length, done, total: langs.length });
    const t = await translateSegments(segments, lang, { key, model, official: official[lang] || null, onLog, fetchFn });
    t.forEach((x, i) => (segments[i].tr[lang] = x));
    done++;
  }
  const warnings = segments.filter((s) => Object.values(s.tr).some((x) => String(x).startsWith('⚠'))).length;
  onProgress({ stage: 'fet', segments: segments.length, done, total: langs.length, warnings });
  return { source: src, targets: [src, ...langs], model, made: new Date().toISOString(), from, official: Object.keys(official).filter((k) => official[k]), segments, warnings };
}
