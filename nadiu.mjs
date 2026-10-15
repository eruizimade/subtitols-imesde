// Captura multicanal nativa: engega bin/captura, en llegeix els canals i fa el mateix que el worklet del
// panell (pcm-worklet.js) però sense el límit de 2 canals de Chrome:
//   - passa cada canal a 24 kHz
//   - blocs de 100 ms
//   - amb ponents: envia NOMÉS el canal de qui parla més fort (amb histèresi); sense: barreja els canals amb senyal
//   - trama per a onAudio: [1 byte ponent (255 = cap)] + PCM16 24 kHz
// Es vigila sol: si el programa surt (cable, Dante aturat), es torna a engegar.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';

const OUT_RATE = 24000;
const BLOCK = 2400;            // 100 ms a 24 kHz
const SWITCH_RATIO = 1.8;      // mateixos valors que el worklet
const FLOOR = 0.004;
const HOLD_BLOCKS = 4;
const LIVE_FLOOR = 0.0005;

export function listDevices(bin) {
  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) return resolve({ ok: false, error: 'falta el programa de captura nativa', devices: [] });
    execFile(bin, ['llista'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message, devices: [] });
      try { resolve({ ok: true, devices: JSON.parse(stdout) }); } catch (e) { resolve({ ok: false, error: e.message, devices: [] }); }
    });
  });
}

export function createNative({ bin, onFrame, onStatus, log }) {
  let proc = null, want = null, restartT = null, failures = 0;
  let buf = Buffer.alloc(0);
  let rs = [];                 // estat del remostreig per canal: { pos, last }
  let acc = [];                // mostres a 24 kHz pendents de formar bloc, per canal
  let srcRate = 0, nCh = 0;
  let active = 0, quiet = 0, hold = [];
  let lastStatusAt = 0;
  const status = { active: false, uid: null, name: null, channels: 0, levels: [], speaker: 255, lastAt: 0, error: null };

  function resetDsp(k, rate) {
    nCh = k; srcRate = rate;
    rs = Array.from({ length: k }, () => ({ pos: 0, prev: 0 }));
    acc = Array.from({ length: k }, () => []);
    active = 0; quiet = 0; hold = Array(k).fill(0);
  }

  // Remostreig lineal a 24 kHz (amb mitjana de parelles quan es divideix per 2 o més: talla l'aliàsing de la veu)
  function resample(ch, samples) {
    const st = rs[ch], step = srcRate / OUT_RATE, out = acc[ch];
    const smooth = step >= 1.5;
    let pos = st.pos, prev = st.prev;
    for (let i = 0; i < samples.length; i++) {
      const x = smooth ? (samples[i] + prev) / 2 : samples[i];
      // per cada mostra d'entrada, treiem les de sortida que hi cauen
      while (pos <= 1) { out.push(prev + (x - prev) * pos); pos += step; }
      pos -= 1; prev = x;
    }
    st.pos = pos; st.prev = prev;
  }

  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

  function flushBlocks() {
    const speakers = want?.speakerChannels || [];
    while (acc.every((a) => a.length >= BLOCK)) {
      const blockCh = acc.map((a) => Float32Array.from(a.splice(0, BLOCK)));
      let src, sp = 255, levels;
      if (speakers.length) {
        const sel = speakers.map((c) => blockCh[Math.min(c, nCh - 1)] || new Float32Array(BLOCK));
        levels = sel.map(rms);
        if (active >= sel.length) active = 0;
        let loudest = 0;
        for (let k = 1; k < levels.length; k++) if (levels[k] > levels[loudest]) loudest = k;
        const cur = levels[active] ?? 0;
        if (cur < FLOOR) quiet++; else quiet = 0;
        if (loudest !== active && levels[loudest] > FLOOR && (levels[loudest] > cur * SWITCH_RATIO || quiet >= HOLD_BLOCKS)) { active = loudest; quiet = 0; }
        src = sel[active]; sp = active;
      } else {
        const lv = blockCh.map(rms);
        lv.forEach((l, c) => { if (l > LIVE_FLOOR) hold[c] = 20; else if (hold[c] > 0) hold[c]--; });
        const use = blockCh.map((_, c) => c).filter((c) => hold[c] > 0);
        const chans = use.length ? use : blockCh.map((_, c) => c);
        src = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) { let m = 0; for (const c of chans) m += blockCh[c][i]; src[i] = m / chans.length; }
        levels = [rms(src)];
      }
      const frame = Buffer.alloc(1 + BLOCK * 2);
      frame[0] = sp;
      for (let i = 0; i < BLOCK; i++) { const s = Math.max(-1, Math.min(1, src[i])); frame.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 1 + i * 2); }
      status.levels = levels; status.speaker = sp; status.lastAt = Date.now();
      onFrame(frame);
      // L'estat (nivells, «encara arriba àudio») surt cap al panell 5 cops per segon: si no, el panell
      // només el veia amb el latit de 2 s i es pensava que l'àudio s'havia aturat (alarma falsa)
      if (status.lastAt - lastStatusAt >= 200) { lastStatusAt = status.lastAt; onStatus(); }
    }
  }

  function onData(d) {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 14) {
      if (buf.toString('ascii', 0, 4) !== 'CAP1') { log('· captura nativa: dades desalineades, es descarten'); buf = Buffer.alloc(0); return; }
      const frames = buf.readUInt32LE(4), k = buf.readUInt16LE(8), rate = buf.readUInt32LE(10), len = 14 + frames * k * 4;
      if (buf.length < len) return;
      if (k !== nCh || rate !== srcRate) resetDsp(k, rate);
      const data = new Float32Array(buf.buffer.slice(buf.byteOffset + 14, buf.byteOffset + len));
      for (let c = 0; c < k; c++) {
        const ch = new Float32Array(frames);
        for (let i = 0; i < frames; i++) ch[i] = data[i * k + c];
        resample(c, ch);
      }
      buf = buf.subarray(len);
      failures = 0;
      flushBlocks();
    }
  }

  function launch() {
    clearTimeout(restartT);
    if (!want) return;
    if (!fs.existsSync(bin)) { status.error = 'falta el programa de captura nativa'; onStatus(); return; }
    buf = Buffer.alloc(0);
    const p = spawn(bin, [want.uid], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { const t = String(d).trim(); if (t) log(t); if (/captura: /.test(t) && !/desaparegut|reinicia/.test(t)) { status.error = null; onStatus(); } });
    p.on('error', (e) => { status.error = e.message; onStatus(); });
    p.on('exit', (code) => {
      if (proc !== p) return;
      proc = null;
      if (!want) return;
      failures++;
      const wait = Math.min(500 * 2 ** Math.min(failures, 4), 5000);
      status.error = `la targeta no respon (es reintenta en ${Math.round(wait / 1000)} s)`;
      log(`✖ captura nativa aturada (codi ${code}): es torna a engegar en ${wait} ms`);
      onStatus();
      restartT = setTimeout(launch, wait);
    });
  }

  return {
    status,
    start(uid, name, channels, speakerChannels) {
      const same = want && want.uid === uid && proc;
      want = { uid, speakerChannels: speakerChannels || [] };
      Object.assign(status, { active: true, uid, name: name || uid, channels: channels || 0, error: null });
      if (!same) { this.kill(); launch(); }
      onStatus();
    },
    setSpeakers(speakerChannels) { if (want) want.speakerChannels = speakerChannels || []; },
    kill() { const p = proc; proc = null; try { p?.kill(); } catch {} },
    stop() { want = null; clearTimeout(restartT); this.kill(); Object.assign(status, { active: false, levels: [], error: null }); onStatus(); },
  };
}
