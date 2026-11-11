#!/usr/bin/env node
'use strict';
/**
 * Etapa `migrations` da esteira do Marco 3 (Guia M3 §16): no banco DESCARTÁVEL já migrado do zero por scripts/withDisposableDb.js
 * (todas as migrations aplicadas, inclusive as de Pessoas, Imóveis, CRM e Radar), desfaz a última migration, refaz, e confere que uma
 * segunda execução não altera nada ("No migrations were executed"). As tabelas do livro e o RLS de cada uma são conferidos em seguida
 * pelos testes da mesma etapa (test/crm.livroEntidades.test.js e test/rls.catalog.allTables.test.js). Recusa rodar fora do banco descartável.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
  console.error('RECUSADO: a etapa migrations só roda em banco descartável (scripts/withDisposableDb.js).');
  process.exit(2);
}
const ROOT = path.resolve(__dirname, '..', '..');
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_ADMIN_URL, NODE_ENV: 'development' };

function cli(...args) {
  const r = spawnSync('npx', ['sequelize-cli', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) { console.error(`falhou: sequelize-cli ${args.join(' ')}`); process.exit(1); }
  return r.stdout || '';
}

cli('db:migrate:undo');
cli('db:migrate');
const segunda = cli('db:migrate');
if (!/No migrations were executed/.test(segunda)) {
  console.error('A segunda execução de db:migrate alterou o banco: migrations não idempotentes.');
  process.exit(1);
}
console.log('[migrations] desfez a última, refez, e a segunda execução não alterou nada.');
