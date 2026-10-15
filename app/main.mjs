// Subtítols IMESDE · app autònoma (Electron)
//
// No reescriu res: engega el MATEIX server.mjs (provat en hores de proves) en un procés a part i hi
// obre el panell i la pantalla. El que hi afegeix és fiabilitat:
//   - el servidor es vigila i, si cau, es torna a engegar sol (el panell es reconnecta i continua)
//   - el Mac no s'adorm mentre l'app és oberta
//   - la pantalla del públic s'obre sola a la pantalla externa, a pantalla completa, i hi torna si es
//     desendolla i es torna a endollar l'HDMI
//   - una finestra penjada es recarrega sola (el panell, a més, reprèn l'enviament d'àudio)
//   - no es pot tancar a mitja sessió sense confirmar-ho
// Les dades (clau, guió, sessions) viuen a ~/Library/Application Support/Subtitols-IMESDE (menú → «Obrir la carpeta de dades»).
import { app, BrowserWindow, Menu, dialog, ipcMain, net as enet, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCode, newer } from './codi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4321);
const BASE = `http://localhost:${PORT}`;
// A ~/Library/Application Support i NO a Documents: a Documents macOS demana permís a cada app (i a cada
// versió nova de l'app) i, mentre ningú no contesta, l'app es queda aturada (14/10/2026: 4 minuts).
const DATA_DIR = process.env.DATA_DIR || path.join(app.getPath('appData'), 'Subtitols-IMESDE');
const ENV_FILE = path.join(DATA_DIR, '.env');          // només per migrar: la clau ja no hi viu
const KEY_FILE = path.join(DATA_DIR, 'clau.xifrada');   // la clau, xifrada amb el Clauer de macOS (safeStorage)
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const NAME = 'Subtítols IMESDE';

app.setName(NAME);

// Proves: àudio d'un fitxer com si fos el micròfon, i control remot per CDP. Mai en un ús normal.
if (process.env.SUBTITOLS_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.SUBTITOLS_FAKE_AUDIO);
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox,AudioServiceOutOfProcess');
}
if (process.env.SUBTITOLS_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.SUBTITOLS_DEBUG_PORT);
// Que Chrome no alenteixi res en segon pla: el panell ha de seguir enviant àudio encara que no es vegi
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) app.quit();

fs.mkdirSync(DATA_DIR, { recursive: true });
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
};

const code = createCode({ ROOT, DATA_DIR, shellVersion: app.getVersion(), log });
let restarting = false;
let panel = null;
let screenWin = null;
let server = null;
let quitting = false;
const restarts = [];

// ─── Servidor ────────────────────────────────────────────────────────────────
const portFree = () => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
  s.listen(PORT);
});

// ─── Clau d'OpenAI: xifrada al Clauer, mai en un fitxer de text ─────────────
// La clau es desa amb safeStorage (a macOS, xifrada amb una clau que guarda el Clauer) i es passa al
// servidor per l'entorn del procés: no toca el disc en clar. Ningú que copiï la carpeta de dades no la pot llegir.
let apiKey = null;
function readKey() {
  try { return fs.existsSync(KEY_FILE) ? safeStorage.decryptString(fs.readFileSync(KEY_FILE)) : null; }
  catch (e) { log('✖ no es pot desxifrar la clau:', e.message); return null; }
}
function writeKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('el xifratge del sistema no està disponible');
  fs.writeFileSync(KEY_FILE, safeStorage.encryptString(key), { mode: 0o600 });
  apiKey = key;
}
// Si encara hi ha un .env amb la clau (versions d'abans), es passa al Clauer i la línia s'esborra del fitxer
function migrateEnv() {
  let txt;
  try { txt = fs.readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  const m = txt.match(/^\s*OPENAI_API_KEY\s*=\s*(\S+)\s*$/m);
  if (!m) return;
  try {
    if (!readKey()) writeKey(m[1].replace(/^["']|["']$/g, ''));
    const rest = txt.replace(/^\s*OPENAI_API_KEY\s*=.*$\n?/m, '').trim();
    if (rest) fs.writeFileSync(ENV_FILE, rest + '\n'); else fs.unlinkSync(ENV_FILE);
    log('✓ clau passada del .env al Clauer; el .env ja no la conté');
  } catch (e) { log('✖ no s\'ha pogut migrar la clau del .env:', e.message); }
}
async function checkKeyOnline(key) {
  try {
    // net.fetch (la xarxa de Chrome): el fetch de Node del procés principal es penjava amb OpenAI
    const r = await Promise.race([
      enet.fetch('https://api.openai.com/v1/models/gpt-4.1-mini', { headers: { Authorization: `Bearer ${key}` } }),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 10000)),
    ]);
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, msg: 'OpenAI diu que aquesta clau no és vàlida.' };
    return { ok: false, offline: true, msg: `OpenAI respon ${r.status}: no s’ha pogut comprovar.` };
  } catch (e) { log('· comprovació de la clau:', e.name, e.message, e.cause?.code || ''); return { ok: false, offline: true, msg: 'No es pot arribar a OpenAI (hi ha internet?).' }; }
}
// Finestra per enganxar-la. Es resol amb true (desada) o false (cancel·lada).
function askKey(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560, height: 430, resizable: false, minimizable: false, title: 'Clau d’OpenAI', parent: parent || undefined, modal: !!parent,
      backgroundColor: '#f4f3ef', webPreferences: { preload: path.join(ROOT, 'app', 'clau-preload.cjs'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (v) => { if (done) return; done = true; ipcMain.removeHandler('clau:desa'); ipcMain.removeAllListeners('clau:cancel'); if (!win.isDestroyed()) win.close(); resolve(v); };
    ipcMain.handle('clau:desa', async (_e, key, force) => {
      key = String(key || '').trim();
      const r = force ? { ok: true } : await checkKeyOnline(key);
      if (!r.ok) return r;
      try { writeKey(key); } catch (e) { return { ok: false, msg: 'No s’ha pogut desar: ' + e.message }; }
      log('✓ clau nova desada al Clauer');
      setTimeout(() => finish(true), 600);
      return { ok: true, msg: 'Desada. Ja la pots oblidar: no es tornarà a ensenyar.' };
    });
    ipcMain.once('clau:cancel', () => finish(false));
    win.on('closed', () => finish(false));
    win.loadFile(path.join(ROOT, 'app', 'clau.html'));
  });
}

function startServer() {
  if (!apiKey) { log('· sense clau: el servidor no s’engega'); return null; }
  const cur = code.current();
  const child = utilityProcess.fork(path.join(ROOT, 'app', 'server-entry.cjs'), [], {
    env: { ...process.env, DATA_DIR, PORT: String(PORT), OPENAI_API_KEY: apiKey || '', SUBTITOLS_CODE_DIR: cur.dir },
    stdio: 'pipe',
    serviceName: 'Subtítols servidor',
  });
  child.stdout?.on('data', (d) => log('[servidor]', String(d).trimEnd()));
  child.stderr?.on('data', (d) => log('[servidor!]', String(d).trimEnd()));
  child.on('exit', (exitCode) => {
    if (server !== child) return;
    server = null;
    if (quitting) return;
    if (restarting) { restarting = false; server = startServer(); return; } // reinici volgut (actualització, clau nova)
    log(`✖ el servidor s'ha aturat (codi ${exitCode}): es torna a engegar`);
    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > 60000) restarts.shift();
    // Un codi actualitzat que no s'aguanta engegat: es torna sol a l'anterior
    if (restarts.length >= 3 && !code.current().bundled) {
      const back = code.rollback();
      restarts.length = 0;
      dialog.showMessageBox({ type: 'warning', title: NAME, message: 'La versió nova no arrencava: s’ha tornat a l’anterior', detail: `Ara funciona la ${back.version}.` });
    }
    if (restarts.length > 5) {
      dialog.showMessageBox({ type: 'error', title: NAME, message: 'El servidor no s’aguanta engegat', detail: `S’ha aturat ${restarts.length} vegades en un minut. Mira ${LOG_FILE}.\nEs continua intentant cada 10 s.` });
      setTimeout(() => { if (!quitting && !server) server = startServer(); }, 10000);
    } else setTimeout(() => { if (!quitting && !server) server = startServer(); }, 1000);
  });
  log(`▶ servidor engegat (codi ${cur.version}${cur.bundled ? ', de sèrie' : ''})`);
  return child;
}

async function waitServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/info`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function isRunning() {
  try { return !!(await (await fetch(`${BASE}/info`, { signal: AbortSignal.timeout(1500) })).json()).running; } catch { return false; }
}

// ─── Finestres ───────────────────────────────────────────────────────────────
const webPreferences = { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false };

// Una finestra penjada o que peta es recupera sola
function selfHeal(win, reload) {
  let hangT = null;
  win.webContents.on('render-process-gone', (_e, d) => { log(`✖ finestra ${win.getTitle()} caiguda (${d.reason}): es recarrega`); setTimeout(() => !win.isDestroyed() && reload(), 500); });
  win.on('unresponsive', () => { clearTimeout(hangT); hangT = setTimeout(() => { if (!win.isDestroyed()) { log('✖ finestra penjada: es reinicia'); win.webContents.forcefullyCrashRenderer(); } }, 8000); });
  win.on('responsive', () => clearTimeout(hangT));
  win.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) { log(`✖ no carrega (${desc}): es torna a provar`); setTimeout(() => !win.isDestroyed() && reload(), 2000); } });
}

function createPanel() {
  panel = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 600, title: NAME, backgroundColor: '#f4f3ef', webPreferences });
  const load = (resume) => panel.loadURL(`${BASE}/captura${resume ? '?reprendre=1' : ''}`);
  load(false);
  selfHeal(panel, () => load(true));
  // «Obrir pantalla ↗» del panell → la pantalla gestionada per l'app, no una finestra solta
  panel.webContents.setWindowOpenHandler(({ url }) => { if (url.includes('/pantalla')) openScreen(); else shell.openExternal(url); return { action: 'deny' }; });
  panel.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    confirmQuit();
  });
  panel.on('closed', () => { panel = null; });
}

function externalDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}

function placeScreen() {
  if (!screenWin || screenWin.isDestroyed()) return;
  const ext = externalDisplay();
  if (ext) {
    if (screenWin.isFullScreen()) screenWin.setFullScreen(false);
    screenWin.setBounds(ext.bounds);
    setTimeout(() => { if (!screenWin?.isDestroyed()) screenWin.setFullScreen(true); }, 300);
    log(`▣ pantalla a la sortida externa (${ext.size.width}×${ext.size.height})`);
  } else {
    if (screenWin.isFullScreen()) screenWin.setFullScreen(false);
    const b = screen.getPrimaryDisplay().workArea;
    screenWin.setBounds({ x: b.x + 60, y: b.y + 60, width: 1280, height: 720 });
    log('▣ sense pantalla externa: la pantalla en una finestra');
  }
}

function openScreen() {
  if (screenWin && !screenWin.isDestroyed()) { placeScreen(); screenWin.show(); return; }
  screenWin = new BrowserWindow({ width: 1280, height: 720, title: `${NAME} · pantalla`, backgroundColor: '#000', autoHideMenuBar: true, webPreferences });
  const load = () => screenWin.loadURL(`${BASE}/pantalla`);
  load();
  selfHeal(screenWin, load);
  screenWin.on('closed', () => { screenWin = null; });
  placeScreen();
}


async function confirmQuit() {
  const running = await isRunning();
  if (running) {
    const r = await dialog.showMessageBox(panel || undefined, {
      type: 'warning', title: NAME, buttons: ['Continuar', 'Tancar igualment'], defaultId: 0, cancelId: 0,
      message: 'Els subtítols estan EN MARXA', detail: 'Si tanques l’app, s’aturen.',
    });
    if (r.response !== 1) return;
  }
  quitting = true;
  try { server?.kill(); } catch {}
  app.quit();
}

// ─── Menú ────────────────────────────────────────────────────────────────────
async function loadScript() {
  const r = await dialog.showOpenDialog(panel, { title: 'Carregar guió (guio.json)', filters: [{ name: 'Guió preparat', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    const g = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(g.segments) || !g.segments.length) throw new Error('no és un guió preparat amb guio.mjs');
    fs.copyFileSync(r.filePaths[0], path.join(DATA_DIR, 'guio.json'));
    dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Guió carregat: ${g.segments.length} frases`, detail: `${g.from || path.basename(r.filePaths[0])}. El servidor el llegeix sol en uns segons.` });
  } catch (e) { dialog.showMessageBox(panel, { type: 'error', title: NAME, message: 'No s’ha pogut carregar el guió', detail: e.message }); }
}

async function removeScript() {
  const f = path.join(DATA_DIR, 'guio.json');
  if (!fs.existsSync(f)) return dialog.showMessageBox(panel, { type: 'info', title: NAME, message: 'No hi ha cap guió carregat' });
  const dest = path.join(DATA_DIR, `guio-retirat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  fs.renameSync(f, dest);
  dialog.showMessageBox(panel, { type: 'info', title: NAME, message: 'Guió retirat', detail: `S’ha desat com a ${path.basename(dest)}.` });
}

// ─── Actualitzacions ─────────────────────────────────────────────────────────
function restartServer() {
  if (!server) { startServerIfIdle(); return; }
  restarting = true;
  try { server.kill(); } catch { restarting = false; }
}

async function serverVersionIs(v, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const j = await (await fetch(`${BASE}/info`, { signal: AbortSignal.timeout(1000) })).json(); if (j.version === v) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function reloadWindows() {
  if (panel && !panel.isDestroyed()) panel.loadURL(`${BASE}/captura?reprendre=1`);
  if (screenWin && !screenWin.isDestroyed()) screenWin.loadURL(`${BASE}/pantalla`);
}

let checking = false;
async function checkUpdates(interactive) {
  if (checking) return;
  checking = true;
  try {
    const cur = code.current();
    let rel;
    try { rel = await code.latestRelease(enet.fetch.bind(enet)); }
    catch (e) { if (interactive) dialog.showMessageBox(panel, { type: 'error', title: NAME, message: 'No s’ha pogut comprovar si hi ha versions noves', detail: e.message }); return; }
    if (!rel || !newer(rel.version, cur.version)) {
      if (interactive) dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Tens l’última versió (${cur.version})` });
      return;
    }
    if (await isRunning()) {
      if (interactive) dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Hi ha la versió ${rel.version}`, detail: 'Amb els subtítols en marxa no s’actualitza res. Atura’ls i torna-ho a provar.' });
      return;
    }
    const ask = await dialog.showMessageBox(panel, {
      type: 'question', title: NAME, buttons: ['Actualitzar ara', 'Ara no'], defaultId: 0, cancelId: 1,
      message: `Hi ha una versió nova: ${rel.version} (tens la ${cur.version})`,
      detail: `${rel.notes.slice(0, 600)}\n\nNo es perd res: la clau, el guió i les tipografies es queden. Si la nova no arrenca, es torna sola a l’anterior.`,
    });
    if (ask.response !== 0) return;
    if (await isRunning()) return dialog.showMessageBox(panel, { type: 'info', title: NAME, message: 'Els subtítols s’han posat en marxa: no s’actualitza.' });
    let next;
    try { next = await code.download(rel, enet.fetch.bind(enet)); }
    catch (e) { return dialog.showMessageBox(panel, { type: 'error', title: NAME, message: 'No s’ha pogut baixar la versió nova', detail: e.message }); }
    code.setCurrent(next, cur);
    restartServer();
    if (await serverVersionIs(next.version)) {
      log(`✓ actualitzat a ${next.version}`);
      code.prune();
      reloadWindows();
      dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Actualitzat a la versió ${next.version}` });
    } else {
      const back = code.rollback();
      restartServer();
      await serverVersionIs(back.version, 15000);
      reloadWindows();
      dialog.showMessageBox(panel, { type: 'error', title: NAME, message: 'La versió nova no ha arrencat', detail: `S’ha tornat a la ${back.version}. No s’ha perdut res.` });
    }
    buildMenu();
  } finally { checking = false; }
}

async function rollbackMenu() {
  const cur = code.current();
  if (cur.bundled) return dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Ja fas servir la versió de sèrie (${cur.version})` });
  if (await isRunning()) return dialog.showMessageBox(panel, { type: 'info', title: NAME, message: 'Atura els subtítols abans de canviar de versió.' });
  const back = code.rollback();
  restartServer();
  await serverVersionIs(back.version, 15000);
  reloadWindows();
  buildMenu();
  dialog.showMessageBox(panel, { type: 'info', title: NAME, message: `Tornat a la versió ${back.version}` });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [
      { label: `Quant a ${NAME}`, role: 'about' },
      { label: `Versió ${code.current().version}${code.current().bundled ? '' : ' (actualitzada)'}`, enabled: false },
      { label: 'Comprovar actualitzacions…', click: () => checkUpdates(true) },
      { label: 'Tornar a la versió anterior', click: rollbackMenu },
      { type: 'separator' },
      { label: 'Obrir la carpeta de dades', click: () => shell.openPath(DATA_DIR) },
      { label: 'Obrir el registre de l’app', click: () => shell.openPath(LOG_FILE) },
      { type: 'separator' },
      { label: 'Canviar la clau d’OpenAI…', click: changeKey },
      { label: 'Esborrar la clau d’aquest Mac…', click: forgetKey },
      { type: 'separator' },
      { role: 'hide', label: `Amagar ${NAME}` },
      { type: 'separator' },
      { label: `Sortir de ${NAME}`, accelerator: 'Cmd+Q', click: () => confirmQuit() },
    ] },
    { label: 'Edita', submenu: [{ role: 'undo', label: 'Desfés' }, { role: 'redo', label: 'Refés' }, { type: 'separator' }, { role: 'cut', label: 'Retalla' }, { role: 'copy', label: 'Copia' }, { role: 'paste', label: 'Enganxa' }, { role: 'selectAll', label: 'Selecciona-ho tot' }] },
    { label: 'Guió', submenu: [
      { label: 'Carregar guió…', click: loadScript },
      { label: 'Retirar el guió', click: removeScript },
    ] },
    { label: 'Pantalla', submenu: [
      { label: 'Obrir la pantalla del públic', accelerator: 'Cmd+P', click: openScreen },
      { label: 'Tornar-la a la pantalla externa', accelerator: 'Cmd+Shift+P', click: placeScreen },
      { label: 'Pantalla completa (sí/no)', accelerator: 'Cmd+Shift+F', click: () => screenWin && !screenWin.isDestroyed() && screenWin.setFullScreen(!screenWin.isFullScreen()) },
      { label: 'Tancar la pantalla del públic', click: () => screenWin && !screenWin.isDestroyed() && screenWin.close() },
    ] },
    { label: 'Visualització', submenu: [
      { label: 'Recarregar el panell (continua enviant)', accelerator: 'Cmd+R', click: () => panel?.loadURL(`${BASE}/captura?reprendre=1`) },
      { role: 'toggleDevTools', label: 'Eines de desenvolupament' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Mida real' }, { role: 'zoomIn', label: 'Amplia' }, { role: 'zoomOut', label: 'Redueix' },
    ] },
    { role: 'windowMenu', label: 'Finestra' },
  ]));
}

// ─── Arrencada ───────────────────────────────────────────────────────────────
async function ensureKey() {
  migrateEnv();
  apiKey = readKey();
  while (!apiKey) {
    const ok = await askKey(null);
    if (!ok) {
      const r = await dialog.showMessageBox({ type: 'warning', title: NAME, buttons: ['Tornar-ho a provar', 'Sortir'], defaultId: 0, message: 'Sense la clau d’OpenAI no hi ha subtítols' });
      if (r.response === 1) { quitting = true; app.quit(); return false; }
    }
  }
  return true;
}

async function changeKey() {
  const ok = await askKey(panel);
  if (ok) { log('↻ clau canviada: es torna a engegar el servidor'); restartServer(); }
}

async function forgetKey() {
  const r = await dialog.showMessageBox(panel || undefined, { type: 'warning', title: NAME, buttons: ['Cancel·lar', 'Esborrar-la'], defaultId: 0, cancelId: 0,
    message: 'Esborrar la clau d’OpenAI d’aquest Mac?', detail: 'Els subtítols deixaran de funcionar fins que se n’hi posi una altra.' });
  if (r.response !== 1) return;
  try { fs.unlinkSync(KEY_FILE); } catch {}
  apiKey = null;
  log('✓ clau esborrada d’aquest Mac');
  try { server?.kill(); } catch {}   // el vigilant no l'engegarà fins que hi hagi una clau
  if (await askKey(panel)) startServerIfIdle();
}
function startServerIfIdle() { if (!server && !quitting && apiKey) server = startServer(); }

app.on('second-instance', () => { if (panel) { if (panel.isMinimized()) panel.restore(); panel.focus(); } });
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); confirmQuit(); } });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('activate', () => { if (!panel && !quitting) createPanel(); });

app.whenReady().then(async () => {
  log(`=== ${NAME} · dades a ${DATA_DIR}`);
  // HDMI desendollat i tornat a endollar: la pantalla del públic hi torna sola
  screen.on('display-added', () => setTimeout(placeScreen, 1500));
  screen.on('display-removed', () => setTimeout(placeScreen, 500));
  buildMenu();
  // Micròfon: l'app el demana al sistema (macOS) i en dona permís a les seves pàgines (només localhost)
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(wc.getURL().startsWith(BASE) && ['media', 'wake-lock', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => !!wc?.getURL?.().startsWith(BASE) && ['media', 'wake-lock', 'fullscreen', 'clipboard-sanitized-write'].includes(perm));

  if (!(await ensureKey())) return;
  if (!(await portFree())) {
    await dialog.showMessageBox({
      type: 'error', title: NAME, message: `Ja hi ha un servidor de subtítols obert (port ${PORT})`,
      detail: 'Segurament un «npm run acte» en un Terminal. Tanca’l (Ctrl+C) i torna a obrir l’app.',
    });
    quitting = true; app.quit(); return;
  }
  powerSaveBlocker.start('prevent-display-sleep');
  server = startServer();
  if (!(await waitServer())) log('✖ el servidor triga a respondre: s’obre igualment el panell (es reconnecta sol)');
  createPanel();
  // Comprovació d'actualitzacions en segon pla (només pregunta si n'hi ha i els subtítols estan aturats)
  setTimeout(() => checkUpdates(false).catch((e) => log('· comprovació d’actualitzacions:', e.message)), 20000);
  // Permís de micròfon de macOS: només si encara no hi és, i DESPRÉS d'obrir-ho tot (la pregunta del
  // sistema bloquejava l'arrencada fins que algú la contestava: 5 minuts el 14/10/2026)
  if (process.platform === 'darwin' && !process.env.SUBTITOLS_FAKE_AUDIO) {
    const st = systemPreferences.getMediaAccessStatus('microphone');
    log(`micròfon: ${st}`);
    if (st !== 'granted') setTimeout(() => systemPreferences.askForMediaAccess('microphone').then((ok) => log(`micròfon: ${ok ? 'permès' : 'DENEGAT (Configuració del Sistema → Privadesa i seguretat → Micròfon)'}`)).catch(() => {}), 1500);
  }
});
