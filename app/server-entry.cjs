// Punt d'entrada del procés del servidor dins de l'app: carrega el server.mjs del CODI que toca
// (l'actualitzat, si n'hi ha un de vàlid; si no, el de sèrie). Ho decideix main.mjs (SUBTITOLS_CODE_DIR).
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const dir = process.env.SUBTITOLS_CODE_DIR || path.join(__dirname, '..');
import(pathToFileURL(path.join(dir, 'server.mjs')).href).catch((e) => { console.error(e); process.exit(1); });
