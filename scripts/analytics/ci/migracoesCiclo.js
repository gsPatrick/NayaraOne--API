#!/usr/bin/env node
'use strict';

/**
 * M9-D705 etapa 3 — migrations do BI em banco descartável: (1) RLS FORCE e GRANT ao nayara_runtime em toda tabela `analytics` com o banco
 * recém-migrado do zero; (2) sobe e desce (up/down/up) das migrations do BI com os dados da semente presentes (a "cópia"); (3) o mesmo
 * conferido de novo depois de subir outra vez. Só roda em banco descartável em 127.0.0.1.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { bancoDescartavelAtivo } = require('./ambiente');
const { lerTabelasAnalytics, avaliarTabelas } = require('./gates/migracoes');

const API_ROOT = path.join(__dirname, '..', '..', '..');
const PRIMEIRA_DO_BI = '20260101009600-create-analytics-metrics-core.js';

function cli(args, env) {
  const r = spawnSync('npx', ['sequelize-cli', ...args], { cwd: API_ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sequelize-cli ${args.join(' ')} falhou:\n${(r.stdout || '') + (r.stderr || '')}`.slice(0, 3000));
  return r.stdout || '';
}

async function confere(sequelize, rotulo) {
  const r = avaliarTabelas(await lerTabelasAnalytics((sql) => sequelize.query(sql, { type: 'SELECT' })));
  if (!r.ok) throw new Error(`${rotulo}: ${r.problemas.join(' ')}`);
  console.log(`${rotulo}: tabelas analytics com RLS FORCE e GRANT ao nayara_runtime.`);
}

async function main() {
  if (!bancoDescartavelAtivo() || !process.env.DATABASE_ADMIN_URL) throw new Error('Recusado: a etapa só roda em banco descartável em 127.0.0.1 (scripts/withDisposableDb.js).');
  const { sequelize } = require('../../../src/models');
  try {
    await confere(sequelize, 'migrations em banco vazio (do zero)');
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_ADMIN_URL, NODE_ENV: 'development' };
    cli(['db:migrate:undo:all', '--to', PRIMEIRA_DO_BI], env);
    console.log('down das migrations do BI concluído.');
    cli(['db:migrate'], env);
    console.log('up das migrations do BI concluído.');
    await confere(sequelize, 'migrations depois de up/down/up');
  } finally {
    await sequelize.close();
  }
}

main().catch((e) => { console.error(`Migrations do BI reprovadas: ${e.message}`); process.exitCode = 1; });
