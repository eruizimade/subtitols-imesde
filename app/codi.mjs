// Codi actualitzable de l'app (servidor + panell + pantalla), baixat de GitHub.
//
// L'app té dues parts:
//   - la CARCASSA (Electron, aquest fitxer, main.mjs, la finestra de la clau): va dins de l'app i no canvia
//     en una actualització. Com que no canvia, macOS no torna a demanar ni el Clauer ni el micròfon.
//   - el CODI (server.mjs, public/, node_modules/ws): ve dins de l'app (versió de sèrie) i les
//     actualitzacions en deixen versions noves a <dades>/codi/<versió>/. S'executa la més nova vàlida.
// La clau, el guió, les tipografies i les sessions viuen a <dades>: cap actualització no les toca.
//
// Seguretat i fiabilitat:
//   - es baixa només de les «releases» del repositori, per HTTPS, i es comprova la suma SHA-256
//   - mai s'actualitza amb els subtítols en marxa
//   - si la versió nova no arrenca, es torna sola a l'anterior; i al menú hi ha «Tornar a la versió anterior»
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = 'eruizimade/subtitols-imesde';

const parse = (v) => String(v || '0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
export function newer(a, b) { // a > b ?
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Un directori de codi és vàlid si hi ha tot el que cal per arrencar
export function validCode(dir) {
  return ['server.mjs', 'package.json', 'public/captura.html', 'public/pantalla.html', 'public/pcm-worklet.js', 'node_modules/ws/package.json']
    .every((f) => fs.existsSync(path.join(dir, f)));
}

export function createCode({ ROOT, DATA_DIR, shellVersion, log }) {
  const CODI = path.join(DATA_DIR, 'codi');
  const STATE = path.join(CODI, 'actual.json');
  const bundled = { version: readJson(path.join(ROOT, 'package.json'))?.version || '0.0.0', dir: ROOT, bundled: true };

  // Quin codi s'executa: l'actualitzat si és vàlid, compatible amb aquesta carcassa i més nou que el de sèrie
  function current() {
    const st = readJson(STATE);
    if (st?.dir && validCode(st.dir)) {
      const pkg = readJson(path.join(st.dir, 'package.json')) || {};
      if (pkg.shellMin && newer(pkg.shellMin, shellVersion)) log(`· el codi ${st.version} demana una app ${pkg.shellMin}: es fa servir el de sèrie`);
      else if (!newer(bundled.version, st.version)) return { version: st.version, dir: st.dir, bundled: false, previous: st.previous || null };
    }
    return { ...bundled, previous: null };
  }

  function setCurrent(next, previous) {
    fs.mkdirSync(CODI, { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ version: next.version, dir: next.dir, previous: previous ? { version: previous.version, dir: previous.dir } : null, at: new Date().toISOString() }, null, 2));
  }

  // Torna a la versió anterior (o a la de sèrie)
  function rollback() {
    const cur = current();
    const prev = cur.previous && validCode(cur.previous.dir) ? cur.previous : null;
    if (prev && !prev.dir.startsWith(CODI)) { try { fs.unlinkSync(STATE); } catch {} } // l'anterior era la de sèrie
    else if (prev) setCurrent(prev, null);
    else { try { fs.unlinkSync(STATE); } catch {} }
    log(`↩ codi tornat a ${prev ? prev.version : `${bundled.version} (de sèrie)`}`);
    return prev || bundled;
  }

  async function latestRelease(fetchFn) {
    const r = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'subtitols-imesde' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub respon ${r.status}`);
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const zip = rel.assets?.find((a) => a.name === `codi-${version}.zip`);
    const sum = rel.assets?.find((a) => a.name === `codi-${version}.zip.sha256`);
    return { version, notes: rel.body || '', zip, sum, page: rel.html_url };
  }

  // Baixa, comprova i deixa a punt la versió (sense activar-la). Retorna { version, dir }.
  async function download(rel, fetchFn) {
    if (!rel.zip || !rel.sum) throw new Error('a la versió li falten els fitxers del codi');
    const get = async (url) => { const r = await fetchFn(url, { headers: { 'User-Agent': 'subtitols-imesde' } }); if (!r.ok) throw new Error(`baixada ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
    const [buf, sumTxt] = await Promise.all([get(rel.zip.browser_download_url), get(rel.sum.browser_download_url)]);
    const want = sumTxt.toString().trim().split(/\s+/)[0].toLowerCase();
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(want) || want !== got) throw new Error('la suma SHA-256 no quadra: el fitxer no és el que es va publicar');
    fs.mkdirSync(CODI, { recursive: true });
    const dest = path.join(CODI, rel.version);
    const tmp = `${dest}.baixant`;
    const zipFile = `${tmp}.zip`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(zipFile, buf);
    try { execFileSync('/usr/bin/ditto', ['-x', '-k', zipFile, tmp]); } finally { fs.rmSync(zipFile, { force: true }); }
    // el zip porta una carpeta arrel «codi»
    const root = fs.existsSync(path.join(tmp, 'codi')) ? path.join(tmp, 'codi') : tmp;
    if (!validCode(root)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('el codi baixat està incomplet'); }
    const pkg = readJson(path.join(root, 'package.json')) || {};
    if (pkg.version !== rel.version) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`el codi diu ${pkg.version} i la versió ${rel.version}`); }
    if (pkg.shellMin && newer(pkg.shellMin, shellVersion)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`aquesta versió necessita l’app ${pkg.shellMin} o més nova: cal reinstal·lar-la sencera (${rel.page})`); }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(root, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`⬇ codi ${rel.version} baixat i comprovat`);
    return { version: rel.version, dir: dest };
  }

  // Esborra versions velles (es queden l'actual i l'anterior)
  function prune() {
    const cur = current();
    const keep = new Set([cur.dir, cur.previous?.dir].filter(Boolean));
    let entries = [];
    try { entries = fs.readdirSync(CODI, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
    for (const d of entries) { const p = path.join(CODI, d.name); if (!keep.has(p)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} } }
  }

  return { bundled, current, setCurrent, rollback, latestRelease, download, prune };
}
