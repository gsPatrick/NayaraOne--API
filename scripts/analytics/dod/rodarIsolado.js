'use strict';

/**
 * M9-D707 — roda DENTRO de `withDisposableDb.js`: semeia os dois tenants do CI e executa `node --test` com os argumentos recebidos, num banco
 * descartável só deste arquivo. Recusa rodar fora do banco descartável em 127.0.0.1 (nunca toca a homologação).
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bancoDescartavelAtivo, ambienteDosComandos } = require('../ci/ambiente');

const API_ROOT = path.join(__dirname, '..', '..', '..');

if (!bancoDescartavelAtivo()) {
  console.error('Recusado: o banco não é descartável em 127.0.0.1.');
  process.exit(1);
}
const env = ambienteDosComandos();
const seed = spawnSync(process.execPath, ['scripts/seed-ci-two-tenants.js'], { cwd: API_ROOT, env, encoding: 'utf8' });
if (seed.status !== 0) {
  console.error(`semente dos dois tenants falhou\n${seed.stdout || ''}${seed.stderr || ''}`);
  process.exit(seed.status || 1);
}
process.exit(spawnSync(process.execPath, process.argv.slice(2), { cwd: API_ROOT, env, stdio: 'inherit' }).status ?? 1);
