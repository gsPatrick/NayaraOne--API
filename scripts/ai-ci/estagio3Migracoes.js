'use strict';

/**
 * Estágio 3 da esteira da NAY (M9-D044): aplica TODAS as migrations num banco vazio (cluster descartável próprio), verifica RLS FORCE,
 * política e GRANT em toda tabela `ai.*`, desfaz até a migration `ai` mais nova (inclusive) e reaplica, e verifica de novo.
 * Sai com 1 ao primeiro problema. Com `--so-verificar`, só confere as tabelas `ai.*` do banco em DATABASE_ADMIN_URL (usado pelo teste).
 * Porta do cluster: AI_CI_PORTA3 ou sorteio entre 55000 e 56999. Nunca lê o .env.
 */
const fs = require('node:fs');
const path = require('node:path');
const cluster = require('../lib/disposableCluster');
const { problemasDasTabelasAi } = require('./lib/migracoes');

const MIGRATIONS = path.join(cluster.API_ROOT, 'migrations');
const ESCOPO_AI = /(?:CREATE|ALTER)\s+TABLE\s+(?:IF NOT EXISTS\s+)?"?ai"?\.|schema:\s*['"]ai['"]/i;

const porta = () => Number(process.env.AI_CI_PORTA3) || 55000 + Math.floor(Math.random() * 2000);

function migrationAiMaisNova() {
  const arquivos = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.js')).sort();
  for (let i = arquivos.length - 1; i >= 0; i -= 1) {
    if (ESCOPO_AI.test(fs.readFileSync(path.join(MIGRATIONS, arquivos[i]), 'utf8'))) return arquivos[i];
  }
  return null;
}

async function conferir(url, rotulo) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const problemas = await problemasDasTabelasAi(async (sql) => (await client.query(sql)).rows);
    if (problemas.length) throw new Error(`${rotulo}: ${problemas.length} problema(s) nas tabelas ai.*:\n- ${problemas.join('\n- ')}`);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'ai'");
    console.log(`[estagio 3] ${rotulo}: ${rows[0].n} tabelas ai.* com RLS FORCE, política e GRANT ao nayara_runtime.`);
  } finally {
    await client.end();
  }
}

async function completo() {
  const p = porta();
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nayara-ci-ai-'));
  const dataDir = path.join(dir, `pgdata-ci-ai-${p}`);
  cluster.startCluster(dataDir, p, dir);
  try {
    cluster.createRuntimeRole(p);
    cluster.psql(p, 'postgres', 'CREATE DATABASE ci_ai');
    const url = cluster.superUrl(p, 'ci_ai');
    const env = cluster.makeChildEnv(cluster.generateKeys())({ DATABASE_URL: url, NODE_ENV: 'development' });
    const aplicadas = (cluster.mustRun('migrations', 'npx', ['sequelize-cli', 'db:migrate'], env).match(/migrated/g) || []).length;
    console.log(`[estagio 3] ${aplicadas} migrations aplicadas em banco vazio (127.0.0.1:${p}).`);
    await conferir(url, 'depois de aplicar');
    const alvo = migrationAiMaisNova();
    if (!alvo) throw new Error('nenhuma migration do schema ai encontrada');
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
