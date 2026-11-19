// Enllaç públic: envia els subtítols, en UN idioma, cap a imesde.app perquè algú els pugui seguir des de fora
// (https://imesde.app/subtitolsXXXXXXXX). El contracte sencer és a docs/enllac-public.md.
//
// - Sempre és aquest servidor qui truca cap a fora (HTTPS sortint): la xarxa del recinte no ha d'obrir res.
// - Cada enviament porta l'estat sencer (les últimes frases): si se'n perd un, el següent ho arregla.
// - Res d'això no pot afectar mai els subtítols de la sala: tot són peticions amb temps màxim, sense cua,
//   i qualsevol error només es mostra al panell.
// - La clau d'emissió i els ajustos viuen a <dades>/enllac.json (no al navegador): valen per a tots els actes.
import fs from 'node:fs';
import path from 'node:path';

const MIN_GAP_MS = 400;     // com a molt un enviament cada 400 ms
const BEAT_MS = 10000;      // batec mentre hi ha sessió
const TIMEOUT_MS = 5000;

export function createLink({ dataDir, baseUrl, bootId, langs, payload, onStatus, log }) {
  const FILE = path.join(dataDir, 'enllac.json');
  const cfg = { clau: '', url: '', token: '', lang: 'en', on: false };
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (typeof j.clau === 'string') cfg.clau = j.clau;
    if (typeof j.url === 'string') cfg.url = j.url;
    if (typeof j.token === 'string') cfg.token = j.token;
    if (langs.includes(j.lang)) cfg.lang = j.lang;
    cfg.on = !!j.on && !!cfg.clau;
  } catch { /* encara no n'hi ha */ }

  // state: 'off' (sense clau o apagat) · 'ready' (a punt, sense sessió) · 'ok' (emetent) · 'error'
  let host = 'imesde.app';
  try { host = new URL(baseUrl).host.replace(/^www\./, ''); } catch {}
  // host: on s'envia (imesde.app o, de moment, preview.imesde.app); el panell el diu als seus textos
  const status = { configured: false, on: false, lang: cfg.lang, url: '', host, state: 'off', error: null, lastOkAt: 0, viewers: null };
  let seq = 0, lastSig = '', lastSentAt = 0, inFlight = false, timer = null, fails = 0, retryAt = 0, wasLive = false;

  const save = () => {
    try { fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); }
    catch (e) { log(`✖ enllaç públic: no s'ha pogut desar (${e.message})`); }
  };
  const setState = (state, error = null) => {
    const changed = status.state !== state || status.error !== error;
    status.state = state; status.error = error;
    return changed;
  };
  function sync() {
    Object.assign(status, { configured: !!cfg.clau, on: cfg.on, lang: cfg.lang, url: cfg.url });
    if (!cfg.clau || !cfg.on) { setState('off'); status.viewers = null; }
    else if (status.state === 'off') setState('ready');
    onStatus();
  }
  const why = (e) => (e?.auth || e?.http ? e.message : `no es pot arribar a ${host} (hi ha internet?)`);

  function call(method, body, key = cfg.clau) {
    return fetch(baseUrl + '/api/subtitols/feed', {
      method, body,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  const httpError = (r) => Object.assign(new Error(r.status === 401 ? `${host} no reconeix aquesta clau` : `${host} respon ${r.status}`), { http: true, auth: r.status === 401 });

  // Comprova una clau i en desa l'adreça pública. No canvia res si la clau no val.
  async function setKey(clau) {
    clau = String(clau || '').trim();
    if (clau.length < 16 || clau.length > 200 || /\s/.test(clau)) return { ok: false, msg: 'Això no sembla una clau d’emissió' };
    try {
      const r = await call('GET', undefined, clau);
      if (!r.ok) throw httpError(r);
      const j = await r.json();
      if (typeof j?.url !== 'string' || !/^https?:\/\/\S+$/.test(j.url)) throw Object.assign(new Error(`${host} ha respost una cosa inesperada`), { http: true });
      Object.assign(cfg, { clau, url: j.url, token: typeof j.token === 'string' ? j.token : '' });
      lastSig = ''; fails = 0; retryAt = 0;
      save(); sync(); touch();
      log(`✓ enllaç públic a punt: ${cfg.url}`);
      return { ok: true, msg: `Enllaç a punt: ${cfg.url}` };
    } catch (e) { return { ok: false, msg: why(e) }; }
  }

  function set({ on, lang } = {}) {
    if (typeof on === 'boolean') cfg.on = on && !!cfg.clau;
    if (langs.includes(lang)) cfg.lang = lang;
    fails = 0; retryAt = 0;
    save(); sync(); touch();
  }

  function forget() {
    // un últim «ja no hi ha subtítols» amb la clau vella, sense esperar-ne la resposta
    if (cfg.clau && wasLive) call('POST', JSON.stringify({ v: 1, boot: bootId, seq: ++seq, now: Date.now(), lang: cfg.lang, running: false, hidden: false, clearAt: 0, blocks: [] })).then((r) => r.body?.cancel?.()).catch(() => {});
    Object.assign(cfg, { clau: '', url: '', token: '', on: false });
    wasLive = false; lastSig = '';
    save(); sync();
    log('✓ enllaç públic: clau treta');
  }

  function plan(ms) { if (!timer) timer = setTimeout(tick, Math.max(0, ms)); }
  // Ha canviat alguna cosa (o pot haver canviat): es mira ara si cal enviar
  function touch() { clearTimeout(timer); timer = null; plan(0); }

  function tick() {
    timer = null;
    if (!cfg.clau || inFlight) return; // en acabar l'enviament en curs es torna a mirar
    const p = payload(cfg.lang);
    const live = cfg.on && !!p.running;
    if (!live && !wasLive) { if (cfg.on && setState('ready')) onStatus(); return; } // res a dir
    const st = live ? p : { running: false, hidden: false, clearAt: 0, blocks: [] };
    // tEnd no compta: canvia a cada paraula; ja viatja amb el text i amb el batec
    const sig = JSON.stringify([live, st.hidden, st.clearAt, cfg.lang, st.blocks.map((b) => [b.id, b.text, b.final, b.speaker])]);
    const now = Date.now();
    if (sig === lastSig && !(live && now - lastSentAt >= BEAT_MS)) { if (live) plan(BEAT_MS - (now - lastSentAt)); return; }
    const wait = Math.max(lastSentAt + MIN_GAP_MS, retryAt) - now;
    if (wait > 0) return plan(wait);
    inFlight = true; lastSentAt = now;
    let changed = false;
    call('POST', JSON.stringify({ v: 1, boot: bootId, seq: ++seq, now, lang: cfg.lang, running: st.running, hidden: st.hidden, clearAt: st.clearAt, blocks: st.blocks }))
      .then(async (r) => {
        if (r.status === 429) { retryAt = Date.now() + Math.min(30, Math.max(1, Number(r.headers.get('retry-after')) || 2)) * 1000; throw httpError(r); }
        if (!r.ok) throw httpError(r);
        // opcional: el relleu pot dir quanta gent ho mira ara
        let viewers = null;
        if (r.status === 200) { try { const j = await r.json(); if (Number.isFinite(j?.viewers)) viewers = Math.max(0, Math.round(j.viewers)); } catch {} } else r.body?.cancel?.();
        if (fails) log('✓ enllaç públic: torna a anar');
        lastSig = sig; wasLive = live; fails = 0; retryAt = 0; status.lastOkAt = Date.now();
        changed = setState(live ? 'ok' : cfg.on ? 'ready' : 'off') || status.viewers !== viewers;
        status.viewers = live ? viewers : null;
      })
      .catch((e) => {
        if (!fails++) log(`✖ enllaç públic: ${why(e)}`);
        // clau refusada: no cal insistir cada segon; la resta, espera creixent fins a 10 s
        retryAt = Math.max(retryAt, Date.now() + (e?.auth ? 30000 : Math.min(MIN_GAP_MS * 2 ** fails, 10000)));
        changed = setState('error', why(e));
      })
      .finally(() => { inFlight = false; if (changed) onStatus(); plan(0); });
  }

  Object.assign(status, { configured: !!cfg.clau, on: cfg.on, url: cfg.url, state: cfg.clau && cfg.on ? 'ready' : 'off' });
  return {
    status, setKey, set, forget, touch,
    // l'idioma de l'enllaç s'ha de traduir encara que no surti a la pantalla de la sala
    get activeLang() { return cfg.clau && cfg.on ? cfg.lang : null; },
  };
}
