// La CARTA (prompter): el guió sencer a la pantalla, que baixa a mesura que es llegeix.
//
// Segueix la veu paraula a paraula: el guió es desplega en una llista de paraules i un punter avança
// quan el que es transcriu coincideix amb les paraules que venen just després. La transcripció no és
// perfecta (noms, xifres, paraules que es mengen), així que:
//   - només s'avança cap ENDAVANT i dins d'una finestra curta (el lector no salta 40 paraules d'un cop)
//   - les paraules molt freqüents («que», «per», «els») no confirmen res: casen a qualsevol lloc
//   - si es perd (el lector se salta un paràgraf o l'operador s'ha equivocat), es torna a trobar quan
//     tres paraules seguides que no són freqüents apareixen en ordre en un altre lloc del guió
// L'operador sempre mana: «anar a la frase N» hi posa el punter i el seguiment continua des d'allà.

const STOP = new Set(('que per els les una uns unes amb del dels als son són mes més pero però com quan aixo això aquest aquesta ' +
  'tot tots totes hi han hem heu fins sense sobre entre molt molts nostra nostre vostra vostre seva seu seus ' +
  'the and that this with for are was were have has our your their from but not los las con por para del una unos ' +
  'como pero mas más este esta todo todos sin sobre muy nuestra nuestro').split(/\s+/));
export const normWord = (w) => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
const usable = (w) => w.length >= 3;
const strong = (w) => usable(w) && !STOP.has(w);

export function createPrompter() {
  let words = [];     // [{ w, seg }] — paraules del guió que serveixen per seguir
  let segStart = [];  // primera paraula de cada frase
  let segLen = [];
  let p = -1;         // última paraula del guió confirmada
  let heard = [];     // últimes paraules sentides (normalitzades), per tornar-se a trobar
  let buf = '';       // tros de paraula encara a mitges (els deltes arriben trossejats)
  let manualSeg = -1; // frase triada a mà sense cap paraula confirmada encara

  function load(segments) {
    words = []; segStart = []; segLen = [];
    (segments || []).forEach((s, i) => {
      segStart.push(words.length);
      for (const raw of String(s.src || '').split(/\s+/)) { const w = normWord(raw); if (usable(w)) words.push({ w, seg: i }); }
      segLen.push(words.length - segStart[i]);
    });
    reset();
  }
  function reset() { p = -1; heard = []; buf = ''; manualSeg = -1; }

  // Posició visible: frase i fracció llegida d'aquesta frase (0..1)
  function position() {
    if (p < 0) return { i: manualSeg, f: 0 };
    const seg = words[p].seg;
    // Una frase triada a mà que va DESPRÉS del punter mana (encara no s'hi ha confirmat cap paraula)
    if (manualSeg > seg) return { i: manualSeg, f: 0 };
    const len = segLen[seg] || 1;
    const f = Math.min(1, (p - segStart[seg] + 1) / len);
    return { i: seg, f };
  }

  // L'operador hi posa el punter: la frase i comença ara
  function goTo(i) {
    if (!segStart.length) return position();
    i = Math.max(0, Math.min(segStart.length - 1, i | 0));
    p = segStart[i] - 1;
    manualSeg = i;
    heard = [];
    return position();
  }
  function step(d) {
    const cur = position().i;
    return goTo(cur < 0 ? 0 : cur + d);
  }

  // Les n últimes paraules «fortes» sentides apareixen en ordre dins d'una finestra curta del guió?
  function findSequence(seq, from, to) {
    let best = -1;
    for (let j = Math.max(0, from); j <= Math.min(words.length - 1, to); j++) {
      if (words[j].w !== seq[seq.length - 1]) continue;
      let k = seq.length - 2, x = j - 1;
      while (k >= 0 && x >= 0 && j - x <= seq.length * 3) { if (words[x].w === seq[k]) k--; x--; }
      if (k < 0) { best = j; break; } // la primera ocurrència és la bona (el guió es llegeix endavant)
    }
    return best;
  }

  function hear(w) {
    if (!usable(w) || !words.length) return false;
    heard.push(w); if (heard.length > 12) heard.shift();
    // 1. La paraula que toca (o una de les següents: el lector o la transcripció se n'han menjat alguna)
    const lim = Math.min(words.length - 1, p + (p < 0 ? 0 : 6));
    for (let j = p + 1; j <= lim; j++) {
      if (words[j].w !== w) continue;
      // Una paraula freqüent només val si és la immediata (si no, casaria a qualsevol lloc)
      if (!strong(w) && j > p + 1) break;
      p = j; return true;
    }
    // 2. Perduts (o encara no hem començat): tres paraules fortes seguides en ordre, més endavant
    //    o en qualsevol lloc si fa estona que no casa res
    const seq = heard.filter(strong).slice(-3);
    if (seq.length < 3) return false;
    const ahead = findSequence(seq, p + 1, p + 60);
    if (ahead >= 0) { p = ahead; manualSeg = -1; return true; }
    const anywhere = findSequence(seq, 0, words.length - 1);
    // Enrere només amb quatre paraules (un lector que repeteix una frase), mai amb tres que hi poden ser per casualitat
    if (anywhere >= 0 && (anywhere > p || findSequence(heard.filter(strong).slice(-4), anywhere - 12, anywhere) === anywhere)) {
      p = anywhere; manualSeg = -1; return true;
    }
    return false;
  }

  // Text transcrit tal com arriba (deltes). Retorna true si la posició ha canviat.
  function feed(delta) {
    buf += delta;
    const parts = buf.split(/\s+/);
    buf = parts.pop(); // l'últim tros pot ser mitja paraula
    let moved = false;
    for (const raw of parts) if (hear(normWord(raw))) moved = true;
    return moved;
  }
  // Fi de frase: la paraula a mitges ja és sencera
  function flush() { const w = buf; buf = ''; return w ? hear(normWord(w)) : false; }

  return { load, reset, feed, flush, goTo, step, position, get size() { return segStart.length; } };
}
