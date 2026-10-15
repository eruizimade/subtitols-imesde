// Publica una versió nova a GitHub perquè les apps instal·lades es puguin actualitzar.
//
//   1. Puja «version» a package.json (i «shellMin» si la carcassa —app/— ha canviat de manera incompatible)
//   2. git commit + git push
//   3. node app/publica.mjs "Què canvia en aquesta versió"
//
// Fa una «release» vX.Y.Z amb:
//   codi-X.Y.Z.zip (+ .sha256)          → el que es baixen les apps instal·lades (servidor, panell, pantalla)
//   Subtitols-IMESDE-X.Y.Z-mac.zip      → l'app sencera, per a instal·lacions noves
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO } from './codi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const v = pkg.version;
const notes = process.argv.slice(2).join(' ') || `Versió ${v}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

// El que es publica ha de ser el que hi ha a GitHub
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).toString().trim();
if (dirty) { console.error('✖ Hi ha canvis sense desar a git. Fes commit i push abans de publicar.\n' + dirty); process.exit(1); }

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitols-publica-'));
const stage = path.join(out, 'codi');
fs.mkdirSync(stage);
fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
run('swiftc', ['-O', 'nadiu/captura.swift', '-o', 'bin/captura']);   // captura multicanal nativa
for (const f of ['server.mjs', 'nadiu.mjs', 'guio.mjs', 'package.json', 'LLEGEIX-ME.md']) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
fs.mkdirSync(path.join(stage, 'bin'));
fs.copyFileSync(path.join(ROOT, 'bin', 'captura'), path.join(stage, 'bin', 'captura'));
fs.chmodSync(path.join(stage, 'bin', 'captura'), 0o755);
fs.cpSync(path.join(ROOT, 'public'), path.join(stage, 'public'), { recursive: true });
fs.cpSync(path.join(ROOT, 'node_modules', 'ws'), path.join(stage, 'node_modules', 'ws'), { recursive: true });

const zip = path.join(out, `codi-${v}.zip`);
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', stage, zip]);
const sum = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(`${zip}.sha256`, `${sum}  codi-${v}.zip\n`);

run('node', ['app/empaqueta.mjs']);
const appZip = path.join(out, `Subtitols-IMESDE-${v}-mac.zip`);
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(ROOT, 'dist', 'Subtítols IMESDE-darwin-arm64', 'Subtítols IMESDE.app'), appZip]);

run('gh', ['release', 'create', `v${v}`, '--repo', REPO, '--title', `v${v}`, '--notes', notes, zip, `${zip}.sha256`, appZip]);
console.log(`\n✓ Publicada la v${v}. Les apps instal·lades la trobaran a «Comprovar actualitzacions…» (o soles en obrir-se).`);
