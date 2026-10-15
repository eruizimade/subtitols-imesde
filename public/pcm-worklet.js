// Àudio del navegador → PCM16 mono a 24 kHz, en blocs de 100 ms.
//
// Sense ponents: barreja tots els canals.
// Amb ponents (cada un al seu canal): envia NOMÉS el canal de qui parla més fort,
// amb una mica d'histèresi perquè no salti a cada respiració. Així se sap qui
// parla i el que un micro capta de l'altre no es transcriu dues vegades.
const BLOCK = 2400;
const SWITCH_RATIO = 1.8;   // ~5 dB més fort per prendre-li la paraula a qui parla
const FLOOR = 0.004;        // per sota d'això és silenci
const HOLD_BLOCKS = 4;      // 400 ms de silenci abans de deixar anar el torn

class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];      // canals dels ponents (índexs d'entrada)
    this.buf = [];           // un Float32Array per canal
    this.mix = new Float32Array(BLOCK);
    this.raw = [];           // tots els canals d'entrada (per a la barreja sense ponents)
    this.n = 0;
    this.active = 0;         // posició dins this.channels de qui té la paraula
    this.quiet = 0;
    this.port.onmessage = (e) => {
      if (Array.isArray(e.data?.channels)) {
        this.channels = e.data.channels;
        this.buf = this.channels.map(() => new Float32Array(BLOCK));
        this.active = 0;
        this.n = 0; // si no, el bloc a mitges sortiria amb zeros al davant (un clic)
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const frames = input[0].length;
    if (this.raw.length !== input.length) { this.raw = input.map(() => new Float32Array(BLOCK)); this.n = 0; }
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < input.length; c++) this.raw[c][this.n] = input[c][i];
      for (let k = 0; k < this.channels.length; k++) {
        const ch = input[Math.min(this.channels[k], input.length - 1)];
        this.buf[k][this.n] = ch[i];
      }
      if (++this.n === BLOCK) { this.flush(); this.n = 0; }
    }
    return true;
  }

  flush() {
    const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
    let src = this.mix;
    let speaker = 255;
    let levels;
    if (this.channels.length) {
      levels = this.buf.map(rms);
      let loudest = 0;
      for (let k = 1; k < levels.length; k++) if (levels[k] > levels[loudest]) loudest = k;
      const cur = levels[this.active] ?? 0;
      if (cur < FLOOR) this.quiet++; else this.quiet = 0;
      if (loudest !== this.active && levels[loudest] > FLOOR &&
          (levels[loudest] > cur * SWITCH_RATIO || this.quiet >= HOLD_BLOCKS)) {
        this.active = loudest;
        this.quiet = 0;
      }
      src = this.buf[this.active];
      speaker = this.active;
    } else {
      // Barreja dels canals que porten senyal. Abans era la mitjana de TOTS: amb una targeta de
      // 8 canals i un sol micro connectat, la veu arribava 18 dB més fluixa (i amb 2, 6 dB).
      // Un canal es considera «amb senyal» 2 s després de l'últim cop que en va tenir: si entrés i
      // sortís a cada bloc, el nivell faria salts de 6 dB i clics
      const lv = this.raw.map(rms);
      this.hold = this.hold?.length === lv.length ? this.hold : lv.map(() => 0);
      lv.forEach((l, c) => { if (l > 0.0005) this.hold[c] = 20; else if (this.hold[c] > 0) this.hold[c]--; });
      const live = this.hold.map((h, c) => (h > 0 ? c : -1)).filter((c) => c >= 0);
      const use = live.length ? live : this.raw.map((_, c) => c);
      for (let i = 0; i < BLOCK; i++) { let m = 0; for (const c of use) m += this.raw[c][i]; this.mix[i] = m / use.length; }
      levels = [rms(this.mix)];
    }
    const out = new Uint8Array(1 + BLOCK * 2);
    out[0] = speaker;
    const dv = new DataView(out.buffer);
    for (let i = 0; i < BLOCK; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      dv.setInt16(1 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    this.port.postMessage({ frame: out.buffer, levels, speaker }, [out.buffer]);
  }
}
registerProcessor('pcm-sender', PcmSender);
