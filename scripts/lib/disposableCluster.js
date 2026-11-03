'use strict';

/**
 * Cluster PostgreSQL local e DESCARTÁVEL (initdb num diretório temporário, porta própria,
 * socket próprio) — mesma técnica do drill jurídico (scripts/restoreDrill/legalFullDrill.js),
 * extraída para ser reaproveitada pelo drill de restore de Estoque/Compras/Seguros, pelo teste de
 * carga de Estoque/Compras e pelos failure drills. Nunca toca o banco de homologação/dev: o
 * DATABASE_URL de cada processo filho é montado aqui (127.0.0.1, banco "drill_*") e nenhuma
 * credencial do .env é herdada.
 *
 * Banco preparado do mesmo jeito que o CI: migrations do zero + seeds base como superusuário do
 * cluster, role de runtime `nayara_runtime` NOSUPERUSER/NOBYPASSRLS com GRANT por schema.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const API_ROOT = path.join(__dirname, '..', '..');
const SUPER = 'drill_super';
const APP_ROLE = 'nayara_runtime';
const APP_PASSWORD = 'drill_runtime_local_only';

const PG_BIN = process.env.DRILL_PG_BIN
  || ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin']
    .find((d) => fs.existsSync(path.join(d, 'initdb')))
  || '';

function bin(name) {
  const full = path.join(PG_BIN, name);
  if (!PG_BIN || !fs.existsSync(full)) throw new Error(`Binário do PostgreSQL não encontrado: ${full} (defina DRILL_PG_BIN).`);
  return full;
}

const superUrl = (port, db) => `postgres://${SUPER}@127.0.0.1:${port}/${db}`;
const appUrl = (port, db) => `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${port}/${db}`;

function psql(port, db, sql) {
  return execFileSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', SUPER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { encoding: 'utf8' });
}

// Chaves temporárias geradas a cada execução — nenhum segredo do .env entra.
function generateKeys() {
  return {
    FILES_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    PII_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
  };
}

function makeChildEnv(keys) {
  return function childEnv(extra) {
    const env = { ...process.env, DB_SSL: 'false', NODE_ENV: 'test', LOG_LEVEL: 'silent', APP_API_PREFIX: '/api', ...keys, ...extra };
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
    if (!extra || !extra.DB_MIGRATION_USER) {
      delete env.DB_MIGRATION_USER;
      delete env.DB_MIGRATION_PASSWORD;
    }
    return env;
  };
}

function run(command, args, env, opts = {}) {
  const res = spawnSync(command, args, { cwd: API_ROOT, env, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, status: res.status, output };
}

function mustRun(title, command, args, env) {
  const res = run(command, args, env);
  if (!res.ok) throw new Error(`${title} falhou (exit ${res.status}):\n${res.output.split('\n').slice(-40).join('\n')}`);
  return res.output;
}

function startCluster(dataDir, port, workDir) {
  const env = { ...process.env, LC_ALL: 'C' };
  execFileSync(bin('initdb'), ['-D', dataDir, '-U', SUPER, '--auth=trust', '--encoding=UTF8', '--locale=C'], { stdio: 'ignore', env });
  execFileSync(bin('pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -k ${workDir} -c listen_addresses=127.0.0.1 -c max_connections=200`, '-l', path.join(workDir, `pg-${port}.log`), '-w', 'start'], { stdio: 'ignore', env });
}

function stopCluster(dataDir) {
  const env = { ...process.env, LC_ALL: 'C' };
  try { execFileSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'ignore', env }); } catch (e) { /* já parado */ }
}

function createRuntimeRole(port) {
  psql(port, 'postgres', `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`);
}

function grantRuntime(port, db) {
  const schemas = psql(port, db, "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'").split('\n').filter(Boolean);
  for (const schema of schemas) {
    psql(port, db, `GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${APP_ROLE};`);
  }
  return schemas.length;
}

/**
 * Sobe um cluster, cria o banco `db` e o prepara como o CI (migrations + seeds + GRANT).
 * Retorna { workDir, dataDir, port, db, superUrl, appUrl, childEnv, migrated, schemaCount, stop }.
 */
function prepareDatabase({ port, db = 'drill_source', workDir, keys, label = 'cluster' }) {
  const ownWorkDir = !workDir;
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-drill-'));
  const dataDir = path.join(dir, `pgdata-${label}-${port}`);
  startCluster(dataDir, port, dir);
  const childEnv = makeChildEnv(keys || generateKeys());
  const handle = {
    workDir: dir,
    dataDir,
    port,
    db,
    superUrl: superUrl(port, db),
    appUrl: appUrl(port, db),
    childEnv,
    stop() {
      stopCluster(dataDir);
      if (ownWorkDir && !process.env.DRILL_KEEP) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  try {
    createRuntimeRole(port);
    psql(port, 'postgres', `CREATE DATABASE ${db}`);
    const superEnv = childEnv({ DATABASE_URL: superUrl(port, db), NODE_ENV: 'development' });
    const migrateOut = mustRun('migrations', 'npx', ['sequelize-cli', 'db:migrate'], superEnv);
    handle.migrated = (migrateOut.match(/migrated/g) || []).length;
    for (const seed of ['scripts/seed-dev.js', 'scripts/seedBillingRules.js', 'scripts/seedRealEstateRules.js']) {
      mustRun(seed, 'node', [seed], superEnv);
    }
    handle.schemaCount = grantRuntime(port, db);
  } catch (err) {
    handle.stop();
    throw err;
  }
  return handle;
}

function gitInfo() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: API_ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: API_ROOT, encoding: 'utf8' });
  return { commit: (res.stdout || '').trim() || 'desconhecido', dirty: Boolean((dirty.stdout || '').trim()) };
}

module.exports = {
  API_ROOT, SUPER, APP_ROLE, APP_PASSWORD, PG_BIN,
  bin, psql, superUrl, appUrl, generateKeys, makeChildEnv, run, mustRun,
  startCluster, stopCluster, createRuntimeRole, grantRuntime, prepareDatabase, gitInfo,
};
