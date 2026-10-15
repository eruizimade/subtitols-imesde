// Fa «Subtítols IMESDE.app» a dist/ (Mac amb Apple Silicon).   node app/empaqueta.mjs
// La clau, el guió i les sessions NO hi van: viuen a ~/Documents/Subtitols-IMESDE.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// El programa de captura multicanal nativa (Swift) es compila aquí: no va al repositori
fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
execFileSync('swiftc', ['-O', path.join(ROOT, 'nadiu', 'captura.swift'), '-o', path.join(ROOT, 'bin', 'captura')], { stdio: 'inherit' });

const [out] = await packager({
  dir: ROOT,
  name: 'Subtítols IMESDE',
  executableName: 'Subtitols IMESDE',
  appBundleId: 'cat.imesde.subtitols',
  // la versió de package.json: la carcassa la fa servir per saber quines actualitzacions pot fer anar
  appVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  platform: 'darwin',
  arch: process.arch,
  icon: path.join(ROOT, 'app', 'Subtitols.icns'),
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  asar: false, // el servidor corre en un procés a part i llegeix public/ del disc: sense paquet asar
  prune: true,
  ignore: [
    /^\/(dist|sessions|guio-[^/]+|\.git)(\/|$)/,
    /^\/\.env$/, /^\/guio\.json$/, /^\/guio-revisio\.txt$/, /^\/ACTE-.*\.md$/,
    /^\/proves\/.*\.wav$/, /^\/app\/icona(\/|$)/, /^\/(prova|compara)\.mjs$/,
  ],
  extendInfo: {
    NSMicrophoneUsageDescription: 'Subtítols IMESDE escolta la taula de so per transcriure i traduir el que es diu.',
    LSApplicationCategoryType: 'public.app-category.productivity',
  },
});
const app = path.join(out, 'Subtítols IMESDE.app');
// Signatura ad hoc (Apple Silicon no obre res sense signar; en canviar el nom, la d'Electron ja no val)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
console.log(`\n✓ ${app}`);
