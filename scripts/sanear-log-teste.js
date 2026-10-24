#!/usr/bin/env node
'use strict';
/**
 * Uso: node scripts/sanear-log-teste.js <log-original> <log-saneado> [--guardar-original <diretorio-fora-do-repo>]
 * Imprime JSON com os dois SHA-256 e as contagens. O original NUNCA deve ficar dentro do repositório.
 */
const fs = require('node:fs');
const path = require('node:path');
const { sanearLog } = require('./lib/sanearLog');

const [, , entrada, saida, flag, destino] = process.argv;
if (!entrada || !saida) {
  console.error('uso: sanear-log-teste.js <original> <saneado> [--guardar-original <dir>]');
  process.exit(2);
}
const original = fs.readFileSync(entrada, 'utf8');
const r = sanearLog(original, { nomeOriginal: path.basename(entrada) });
if (flag === '--guardar-original' && destino) {
  fs.mkdirSync(destino, { recursive: true });
  const alvo = path.join(destino, path.basename(entrada));
  if (path.resolve(entrada) !== path.resolve(alvo)) fs.copyFileSync(entrada, alvo);
}
fs.writeFileSync(saida, r.texto);
const { texto, ...resumo } = r;
console.log(JSON.stringify({ arquivo: path.basename(saida), ...resumo }, null, 2));
