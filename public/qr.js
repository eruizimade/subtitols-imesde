// Codi QR per a l'adreça de l'enllaç públic, fet aquí mateix (sense internet ni llibreries de fora).
// Només el que cal: mode byte (UTF-8), correcció d'errors M (~15 %), versions 1–10 (fins a 213 bytes).
//   qrMatrix(text) → files de booleans (true = mòdul fosc), o null si el text és massa llarg
//   qrSvg(text)    → <svg> amb el marge blanc de 4 mòduls, o '' si no hi cap
(() => {
  // Per versió, nivell M: [codis de correcció per bloc, [[blocs, codis de dades per bloc], …]]
  const EC_M = [null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // Aritmètica de GF(256) amb el polinomi del QR (0x11D)
  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
  function rsDivisor(deg) {
    const r = new Array(deg).fill(0); r[deg - 1] = 1;
    let root = 1;
    for (let i = 0; i < deg; i++) {
      for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
      root = mul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
      const f = b ^ r.shift(); r.push(0);
      div.forEach((c, i) => { r[i] ^= mul(c, f); });
    }
    return r;
  }

  const dataCap = (v) => EC_M[v][1].reduce((s, [n, k]) => s + n * k, 0);

  function codewords(bytes, v) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const cap = dataCap(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0; data.length < cap / 8; p ^= 1) data.push(p ? 0x11 : 0xec);
    // blocs, correcció d'errors i entrellaçat
    const [ecLen, groups] = EC_M[v], div = rsDivisor(ecLen), blocks = [];
    let k = 0;
    for (const [n, len] of groups) for (let i = 0; i < n; i++) { const d = data.slice(k, k += len); blocks.push([d, rsRemainder(d, div)]); }
    const out = [];
    const maxD = Math.max(...blocks.map(([d]) => d.length));
    for (let i = 0; i < maxD; i++) for (const [d] of blocks) if (i < d.length) out.push(d[i]);
    for (let i = 0; i < ecLen; i++) for (const [, e] of blocks) out.push(e[i]);
    return out;
  }

  // Bits de format (nivell M = 00) i de versió, amb el seu BCH
  function formatBits(mask) {
    const d = (0b00 << 3) | mask;
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    return ((d << 10) | r) ^ 0x5412;
  }
  function versionBits(v) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    return (v << 12) | r;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function build(cw, v, mask) {
    const n = v * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    // patrons de cerca (amb el separador), temps i alineació
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
    for (let i = 0; i < n; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
    const al = ALIGN[v];
    for (const ay of al) for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al.at(-1)) || (ax === al.at(-1) && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // format (dues còpies) i el mòdul fosc fix
    const f = formatBits(mask), fb = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, fb(i));
    set(8, 7, fb(6)); set(8, 8, fb(7)); set(7, 8, fb(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, fb(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, fb(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, fb(i));
    set(8, n - 8, true);
    if (v >= 7) {
      const vb = versionBits(v);
      for (let i = 0; i < 18; i++) { const dark = ((vb >>> i) & 1) === 1, a = n - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
    }
    // dades en ziga-zaga, de baix a la dreta cap amunt, saltant la columna de temps
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
        if (fn[y][x]) continue;
        if (i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    const mk = MASKS[mask];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && mk(x, y)) m[y][x] = !m[y][x];
    return m;
  }

  // Penalització estàndard (la màscara més baixa és la que es llegeix més fàcil)
  function penalty(m) {
    const n = m.length; let p = 0, dark = 0;
    const line = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        for (let b = 0; b + 11 <= n; b++) {
          const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
          if (s === '10111010000' || s === '00001011101') p += 40;
        }
      }
    };
    line((a, b) => m[a][b]); line((a, b) => m[b][a]);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    return p + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  }

  function qrMatrix(text, forceMask) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let v = 1;
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCap(v) * 8) v++;
    if (v > 10) return null;
    const cw = codewords(bytes, v);
    if (forceMask != null) return build(cw, v, forceMask);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { const m = build(cw, v, mask), p = penalty(m); if (p < bestP) { best = m; bestP = p; } }
    return best;
  }

  function qrSvg(text) {
    const m = qrMatrix(text);
    if (!m) return '';
    const n = m.length, q = 4;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="Codi QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  globalThis.qrMatrix = qrMatrix;
  globalThis.qrSvg = qrSvg;
})();
