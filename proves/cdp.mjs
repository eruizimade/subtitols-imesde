// Control remot de les finestres de l'app (proves): l'app s'ha d'engegar amb SUBTITOLS_DEBUG_PORT=9333.
//   node proves/cdp.mjs <tros-url> eval "<js>"     → avalua JS a la pàgina i n'imprimeix el resultat
//   node proves/cdp.mjs <tros-url> shot fitxer.png  → captura de pantalla
//   node proves/cdp.mjs <tros-url> crash            → fa petar la pàgina (prova d'autorecuperació)
//   node proves/cdp.mjs list                        → pàgines obertes
import fs from 'node:fs';
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9333;
const [what, cmd, arg] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
if (what === 'list') { for (const p of pages) console.log(p.type, p.url, p.title); process.exit(0); }
const page = pages.find((p) => p.type === 'page' && p.url.includes(what));
if (!page) { console.error('no trobo cap pàgina amb', what); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const call = (method, params = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = (raw) => { const m = JSON.parse(raw); if (m.id === my) { ws.off('message', on); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  ws.on('message', on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
await new Promise((r) => ws.once('open', r));
if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(r.exceptionDetails ? 'EXCEPCIÓ: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : JSON.stringify(r.result.value));
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('desat', arg);
} else if (cmd === 'file') {
  const { root } = await call('DOM.getDocument');
  const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await call('DOM.setFileInputFiles', { nodeId, files: [arg] });
  console.log('fitxer posat', arg);
} else if (cmd === 'crash') {
  call('Page.crash').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  console.log('crash enviat');
}
ws.close();
process.exit(0);
