// Un OpenAI de mentida, en aquest ordinador: per provar el servidor sense clau, sense internet i sense cost.
//
//   node proves/simulador.mjs [port=4398]
//   OPENAI_API_KEY=prova OPENAI_WS_URL=ws://localhost:4398/v1/realtime OPENAI_HTTP_URL=http://localhost:4398 PORT=4399 node server.mjs
//   node proves/resistencia.mjs 1 --host=localhost:4399
//
// Què fa:
//   - transcripció: per cada ~0,4 s d'àudio que rep, «transcriu» una paraula d'un text fix (amb punts i comes)
//   - traducció: torna «[idioma] text» a trossos, com el streaming de debò, amb el recompte de tokens al final
//   - avaries a demanda (des d'un altre Terminal):
//       curl localhost:4398/mata      la connexió es queda oberta però muda: ni text ni senyals de vida
//       curl localhost:4398/reviu     torna a anar
//       curl localhost:4398/talla     tanca de cop totes les sessions de transcripció
//       curl localhost:4398/401       les traduccions i la clau fallen amb 401 (/reviu ho desfà)
//       curl localhost:4398/estat     què ha rebut
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.argv[2] || 4398);
const TEXT = ('Bona tarda a tothom i benvinguts al Palau de la Música Catalana. Avui tenim el plaer de presentar un concert molt ' +
  'especial, amb obres de Mozart i de Brahms. Abans de començar, voldria agrair la feina de totes les persones que ho han ' +
  'fet possible. Esperem que en gaudiu molt. Moltes gràcies.').split(' ');
const st = { mort: false, e401: false, sessions: 0, obertes: 0, audioS: 0, traduccions: 0, pings: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/mata') { st.mort = true; return json(200, st); }
  if (url.pathname === '/reviu') { st.mort = false; st.e401 = false; return json(200, st); }
  if (url.pathname === '/401') { st.e401 = true; return json(200, st); }
  if (url.pathname === '/talla') { for (const c of wss.clients) c.terminate(); return json(200, st); }
  if (url.pathname === '/estat') return json(200, { ...st, audioS: Math.round(st.audioS) });
  if (st.e401) return json(401, { error: { message: 'Incorrect API key provided (simulador)' } });
  if (url.pathname.startsWith('/v1/models/')) return json(200, { id: url.pathname.split('/').pop() });
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { return json(400, { error: { message: 'JSON' } }); }
      if (st.mort) return; // penjada: no respon mai
      st.traduccions++;
      const text = j.messages?.at(-1)?.content || '';
      const lang = /Tradueix el text al (\S+)\./.exec(j.messages?.[0]?.content || '')?.[1] || '?';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const words = `[${lang}] ${text}`.split(' ');
      for (let i = 0; i < words.length; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: (i ? ' ' : '') + words[i] } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 25));
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: words.length, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  json(404, { error: { message: 'no' } });
});

// autoPong: false → els senyals de vida es responen a mà, per poder deixar de fer-ho (/mata)
const wss = new WebSocketServer({ server, autoPong: false });
wss.on('connection', (ws) => {
  st.sessions++; st.obertes++;
  let pending = 0, i = 0;
  ws.on('ping', (d) => { st.pings++; if (!st.mort) ws.pong(d); });
  ws.on('close', () => { st.obertes--; });
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
    if (st.mort) return;
    if (ev.type === 'session.update') return ws.send(JSON.stringify({ type: 'session.updated' }));
    if (ev.type !== 'input_audio_buffer.append') return;
    const pcm = Buffer.from(ev.audio, 'base64');
    const s = pcm.length / 48000;
    st.audioS += s;
    // només «transcriu» si hi ha so (com el model de debò, que amb silenci calla)
    let sum = 0; for (let k = 0; k + 1 < pcm.length; k += 8) { const v = pcm.readInt16LE(k); sum += v * v; }
    if (Math.sqrt(sum / Math.max(1, pcm.length / 8)) < 650) return;
    pending += s;
    while (pending >= 0.4) {
      pending -= 0.4;
      ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: (i % TEXT.length ? ' ' : i ? ' ' : '') + TEXT[i % TEXT.length] }));
      i++;
    }
  });
});
server.listen(PORT, () => console.log(`Simulador d'OpenAI a http://localhost:${PORT}  (/mata /reviu /talla /401 /estat)`));
