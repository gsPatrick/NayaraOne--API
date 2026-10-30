#!/usr/bin/env node
'use strict';

/**
 * Estágio 3 da esteira do Marketing (M9-D438): aplica TODAS as migrations num banco vazio (cluster descartável próprio), confere as 15 tabelas do livro e RLS FORCE, política e GRANT em toda
 * tabela `marketing.*`, desfaz até a migration do schema `marketing` mais nova (inclusive), reaplica e confere de novo. Sai com 1 ao primeiro problema (MKT_CI_STAGE_FAILED na esteira).
 * Com `--so-verificar`, só confere as tabelas do banco em DATABASE_ADMIN_URL (127.0.0.1, banco descartável; usado pelo teste). Porta do cluster: MKT_CI_PORTA3 ou sorteio entre 55000 e 56999.
 * Nunca lê o .env.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cluster = require('../../lib/disposableCluster');
const { problemasDasTabelasMarketing } = require('./lib/migracoes');

const MIGRATIONS = path.join(cluster.API_ROOT, 'migrations');
const ESCOPO = /(?:CREATE|ALTER)\s+TABLE\s+(?:IF NOT EXISTS\s+)?"?marketing"?\.|schema:\s*['"]marketing['"]/i;
const porta = () => Number(process.env.MKT_CI_PORTA3) || 55000 + Math.floor(Math.random() * 2000);

function migrationMaisNova() {
  const arquivos = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.js')).sort();
  for (let i = arquivos.length - 1; i >= 0; i -= 1) if (ESCOPO.test(fs.readFileSync(path.join(MIGRATIONS, arquivos[i]), 'utf8'))) return arquivos[i];
  return null;
}

async function conferir(url, rotulo) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const problemas = await problemasDasTabelasMarketing(async (sql) => (await client.query(sql)).rows);
    if (problemas.length) throw new Error(`${rotulo}: ${problemas.length} problema(s) nas tabelas marketing.*:\n- ${problemas.join('\n- ')}`);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'marketing'");
    console.log(`[estagio 3] ${rotulo}: ${rows[0].n} tabelas marketing.* (as 15 do livro incluídas) com RLS FORCE, política e GRANT ao nayara_runtime.`);
  } finally {
    await client.end();
  }
}

async function completo() {
  const p = porta();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-ci-mkt-'));
  const dataDir = path.join(dir, `pgdata-ci-mkt-${p}`);
  cluster.startCluster(dataDir, p, dir);
  try {
    cluster.createRuntimeRole(p);
    cluster.psql(p, 'postgres', 'CREATE DATABASE ci_mkt');
    const url = cluster.superUrl(p, 'ci_mkt');
    const env = cluster.makeChildEnv(cluster.generateKeys())({ DATABASE_URL: url, NODE_ENV: 'development' });
    const aplicadas = (cluster.mustRun('migrations', 'npx', ['sequelize-cli', 'db:migrate'], env).match(/migrated/g) || []).length;
    console.log(`[estagio 3] ${aplicadas} migrations aplicadas em banco vazio (cluster descartável).`);
    await conferir(url, 'depois de aplicar');
    const alvo = migrationMaisNova();
    if (!alvo) throw new Error('nenhuma migration do schema marketing encontrada');
    cluster.mustRun(`desfazer até ${alvo}`, 'npx', ['sequelize-cli', 'db:migrate:undo:all', '--to', alvo], env);
    console.log(`[estagio 3] migrations desfeitas até ${alvo} (inclusive).`);
    const reaplicadas = (cluster.mustRun('reaplicar', 'npx', ['sequelize-cli', 'db:migrate'], env).match(/migrated/g) || []).length;
    console.log(`[estagio 3] ${reaplicadas} migrations reaplicadas.`);
    await conferir(url, 'depois de desfazer e reaplicar');
  } finally {
    cluster.stopCluster(dataDir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function soVerificar() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('--so-verificar exige DATABASE_ADMIN_URL em 127.0.0.1 (banco descartável)');
  await conferir(url, 'verificação');
}

(process.argv.includes('--so-verificar') ? soVerificar() : completo()).then(
  () => { console.log('[estagio 3] migrations: OK'); },
  (err) => { console.error(`[estagio 3] REPROVADO: ${err.message}`); process.exit(1); },
);
