'use strict';

/**
 * Drill de restore jurídico completo — F05 da conferência Nayara de 18/10/2026.
 *
 * Tudo acontece num cluster PostgreSQL 16 LOCAL e descartável (diretório temporário, porta
 * própria), nunca no banco de homologação/dev compartilhado:
 *
 *   1. initdb + start do cluster descartável; role de runtime `nayara_runtime` criada
 *      NOSUPERUSER/NOBYPASSRLS antes das migrations (os GRANTs condicionais das migrations
 *      aplicam-se a ela), mais o mesmo GRANT por schema que o CI aplica.
 *   2. Banco de ORIGEM: migrations do zero + seeds base (mesmos comandos do CI).
 *   3. Fixtures controladas pelos serviços reais (seedLegalFixtures.js), como role de runtime,
 *      com arquivos gravados cifrados num storage de origem isolado (UPLOADS_DIR).
 *   4. Backup: pg_dump -Fc do banco de origem + cópia do storage de arquivos.
 *   5. Restore: banco de DESTINO novo + pg_restore (com GRANTs/policies) + storage copiado do
 *      backup para um diretório novo.
 *   6. Verificação (verifyLegalRestore.js): dados campo a campo, bytes dos arquivos, relações,
 *      exportação do dossiê e permissões pós-restore (RLS e RBAC pela API real), adulteração.
 *   7. Teardown: cluster parado e diretório apagado (use --keep para inspecionar).
 *
 * Pré-requisito: binários do PostgreSQL 16 (Homebrew: /opt/homebrew/opt/postgresql@16/bin, ou
 * DRILL_PG_BIN). FILES_ENCRYPTION_KEY e JWT_ACCESS_SECRET vêm do .env — a MESMA chave de
 * arquivos precisa existir no ambiente restaurado (sem ela os bytes não são legíveis).
 *
 * Uso: node scripts/restoreDrill/legalFullDrill.js [--keep] [--port 5442]
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const API_ROOT = path.join(__dirname, '..', '..');
const PG_BIN = process.env.DRILL_PG_BIN || '/opt/homebrew/opt/postgresql@16/bin';
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PORT = Number(argv[argv.indexOf('--port') + 1]) || Number(process.env.DRILL_PG_PORT) || 5442;
const SUPER = 'drill_super';
const APP_ROLE = 'nayara_runtime';
const APP_PASSWORD = 'drill_runtime_local_only';
const HTTP_PORT = 21611;

function bin(name) {
  const full = path.join(PG_BIN, name);
  if (!fs.existsSync(full)) throw new Error(`Binário do PostgreSQL não encontrado: ${full} (defina DRILL_PG_BIN).`);
  return full;
}

function step(title) {
  console.log(`\n### ${title}`);
}

function superUrl(db) {
  return `postgres://${SUPER}@127.0.0.1:${PORT}/${db}`;
}

function appUrl(db) {
  return `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${PORT}/${db}`;
}

function psql(db, sql) {
  return execFileSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', SUPER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { encoding: 'utf8' });
}

// Ambiente base dos processos filhos: herda o .env (chaves de criptografia, JWT), mas força
// conexão local sem SSL e desliga os jobs periódicos (NODE_ENV=test).
function childEnv(extra) {
  const env = { ...process.env, DB_SSL: 'false', NODE_ENV: 'test', LOG_LEVEL: 'silent', ...extra };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
  return env;
}

function run(title, command, args, env) {
  const res = spawnSync(command, args, { cwd: API_ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status !== 0) {
    throw new Error(`${title} falhou (exit ${res.status}):\n${output.split('\n').slice(-40).join('\n')}`);
  }
  return output;
}

function grantRuntime(db) {
  const schemas = psql(db, "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'").split('\n').filter(Boolean);
  for (const schema of schemas) {
    psql(db, `GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE}; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${APP_ROLE};`);
  }
  return schemas.length;
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-legal-drill-'));
  const dataDir = path.join(workDir, 'pgdata');
  const uploadsSource = path.join(workDir, 'uploads-source');
  const storageBackup = path.join(workDir, 'storage-backup');
  const uploadsTarget = path.join(workDir, 'uploads-target');
  const dumpFile = path.join(workDir, 'drill_source.dump');
  const fixturesFile = path.join(workDir, 'fixtures.json');
  const reportFile = path.join(workDir, 'report.json');
  let started = false;
  let exitCode = 1;

  console.log(`Drill de restore jurídico — diretório de trabalho: ${workDir}`);
  try {
    step(`1. Cluster PostgreSQL descartável (porta ${PORT})`);
    execFileSync(bin('initdb'), ['-D', dataDir, '-U', SUPER, '--auth=trust', '--encoding=UTF8', '--locale=C'], { stdio: 'ignore' });
    execFileSync(bin('pg_ctl'), ['-D', dataDir, '-o', `-p ${PORT} -k ${workDir} -c listen_addresses=127.0.0.1`, '-l', path.join(workDir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
    started = true;
    psql('postgres', `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`);
    psql('postgres', 'CREATE DATABASE drill_source');
    console.log(`  cluster ativo; role ${APP_ROLE} criada NOSUPERUSER/NOBYPASSRLS; banco drill_source criado.`);

    step('2. Origem: migrations do zero + seeds base (mesmos comandos do CI)');
    const superEnv = childEnv({ DATABASE_URL: superUrl('drill_source') });
    const migrateOut = run('migrations', 'npx', ['sequelize-cli', 'db:migrate'], { ...superEnv, NODE_ENV: 'development' });
    const migrated = (migrateOut.match(/migrated/g) || []).length;
    for (const seed of ['scripts/seed-dev.js', 'scripts/seedBillingRules.js', 'scripts/seedRealEstateRules.js']) {
      run(seed, 'node', [seed], { ...superEnv, NODE_ENV: 'development' });
    }
    const schemaCount = grantRuntime('drill_source');
    console.log(`  ${migrated} migrations aplicadas; seeds base aplicados; GRANT para ${APP_ROLE} em ${schemaCount} schemas.`);

    step('3. Fixtures controladas pelos serviços reais (role de runtime, storage isolado)');
    fs.mkdirSync(uploadsSource, { recursive: true });
    console.log(`  ${run('fixtures', 'node', ['scripts/restoreDrill/seedLegalFixtures.js', '--out', fixturesFile], childEnv({ DATABASE_URL: appUrl('drill_source'), UPLOADS_DIR: uploadsSource }))}`);

    step('4. Backup: pg_dump -Fc + cópia do storage de arquivos');
    execFileSync(bin('pg_dump'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', SUPER, '-Fc', '-f', dumpFile, 'drill_source']);
    fs.cpSync(uploadsSource, storageBackup, { recursive: true });
    const backedUp = fs.readdirSync(storageBackup, { recursive: true }).filter((p) => fs.statSync(path.join(storageBackup, p)).isFile()).length;
    console.log(`  dump: ${(fs.statSync(dumpFile).size / 1024).toFixed(0)} KB; storage: ${backedUp} arquivo(s) copiado(s).`);

    step('5. Restore: banco novo + pg_restore + storage restaurado do backup');
    psql('postgres', 'CREATE DATABASE drill_target');
    execFileSync(bin('pg_restore'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', SUPER, '-d', 'drill_target', '--exit-on-error', dumpFile]);
    fs.cpSync(storageBackup, uploadsTarget, { recursive: true });
    console.log('  drill_target restaurado (com policies e GRANTs); storage restaurado em diretório próprio.');

    step('6. Verificação pós-restore');
    const verify = spawnSync('node', [
      'scripts/restoreDrill/verifyLegalRestore.js',
      '--fixtures', fixturesFile,
      '--source-url', superUrl('drill_source'),
      '--target-url', superUrl('drill_target'),
      '--source-uploads', uploadsSource,
      '--target-app-url', appUrl('drill_target'),
      '--report', reportFile,
    ], { cwd: API_ROOT, env: childEnv({ DATABASE_URL: appUrl('drill_target'), UPLOADS_DIR: uploadsTarget, PORT: String(HTTP_PORT) }), encoding: 'utf8', stdio: 'inherit' });
    exitCode = verify.status === 0 ? 0 : 1;
  } catch (err) {
    console.error(`\n❌ Drill interrompido: ${err.message}`);
    exitCode = 1;
  } finally {
    step('7. Teardown');
    if (started) {
      try { execFileSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch (e) { /* já parado */ }
    }
    if (KEEP) {
      console.log(`  --keep: diretório preservado em ${workDir} (cluster parado).`);
    } else {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log('  cluster parado e diretório temporário apagado — nenhum resíduo.');
    }
  }
  process.exit(exitCode);
}

main();
