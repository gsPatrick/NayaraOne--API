'use strict';

/**
 * Drill de restore jurídico completo — F05 da conferência Nayara de 18/10/2026 (revisado após a
 * revisão independente do mesmo dia).
 *
 * Tudo acontece em DOIS clusters PostgreSQL locais e descartáveis (diretórios temporários,
 * portas próprias), nunca no banco de homologação/dev compartilhado:
 *
 *   1. Cluster de ORIGEM (porta P): initdb; role de runtime `nayara_runtime` criada
 *      NOSUPERUSER/NOBYPASSRLS; banco drill_source com migrations do zero + seeds base (mesmos
 *      comandos do CI) e GRANT por schema para a role de runtime.
 *   2. Fixtures controladas pelos serviços reais (seedLegalFixtures.js), como role de runtime,
 *      com arquivos gravados cifrados num storage isolado (UPLOADS_DIR).
 *   3. Backup com os SCRIPTS REAIS do projeto — os mesmos do runbook:
 *        npm run backup          (scripts/backupDatabase.js, pg_dump -Fc com a credencial de DDL)
 *        scripts/backupStorage.js (cópia do storage + manifesto SHA-256 por arquivo)
 *   4. Cluster de DESTINO NOVO (porta P+1, outro initdb): a role de runtime NÃO existe.
 *      4a. Restore sem a role (npm run restore) → TEM que falhar apontando a role ausente
 *          (antes da correção desta rodada, o script engolia o erro e "concluía com sucesso"
 *          sem nenhum GRANT para a aplicação).
 *      4b. Procedimento do runbook: cria a role de runtime, recria o banco de destino vazio e
 *          refaz o restore → sucesso.
 *      4c. scripts/restoreStorage.js num diretório novo, conferindo cada arquivo contra o
 *          manifesto.
 *   5. Verificação (verifyLegalRestore.js): dados campo a campo (separando campos com valor de
 *      campos nulos dos dois lados), bytes dos arquivos contra o SHA-256 independente gravado
 *      pelas fixtures, documento assinado, relações (inclusive polimórficas), trilha de
 *      auditoria, exportação do dossiê, permissões pós-restore (RLS + RBAC pela API real,
 *      exportação e download), replay do callback bancário pela ROTA do webhook com HMAC, e
 *      adulteração de bytes.
 *   6. Relatório versionável (commit, data, saída completa) em --report-dir.
 *   7. Teardown: os dois clusters parados e o diretório apagado (use --keep para inspecionar).
 *
 * Chaves: o drill GERA chaves temporárias (FILES_ENCRYPTION_KEY, JWT_*, MFA_ENCRYPTION_KEY,
 * PII_HASH_SECRET) — não lê nenhum segredo do .env. Num restore REAL, a FILES_ENCRYPTION_KEY de
 * produção é obrigatória no ambiente restaurado (sem ela os bytes restaurados são ilegíveis);
 * ver runbook.
 *
 * Pré-requisito: binários do PostgreSQL 17 (Homebrew: /opt/homebrew/opt/postgresql@17/bin — a
 * mesma major da homologação), ou DRILL_PG_BIN.
 *
 * Uso: node scripts/restoreDrill/legalFullDrill.js [--keep] [--port 5442] [--report-dir <dir>]
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const API_ROOT = path.join(__dirname, '..', '..');
const PG_BIN = process.env.DRILL_PG_BIN || ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin'].find((d) => fs.existsSync(path.join(d, 'initdb'))) || '';
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argValue = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const PORT_SOURCE = Number(argValue('--port')) || Number(process.env.DRILL_PG_PORT) || 5442;
const PORT_TARGET = PORT_SOURCE + 1;
const REPORT_DIR = argValue('--report-dir');
const SUPER = 'drill_super';
const APP_ROLE = 'nayara_runtime';
const APP_PASSWORD = 'drill_runtime_local_only';
const HTTP_PORT = 21611;

const logLines = [];
function log(line = '') {
  console.log(line);
  logLines.push(line);
}

function bin(name) {
  const full = path.join(PG_BIN, name);
  if (!PG_BIN || !fs.existsSync(full)) throw new Error(`Binário do PostgreSQL não encontrado: ${full} (defina DRILL_PG_BIN).`);
  return full;
}

function step(title) {
  log(`\n### ${title}`);
}

const superUrl = (port, db) => `postgres://${SUPER}@127.0.0.1:${port}/${db}`;
const appUrl = (port, db) => `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${port}/${db}`;

function psql(port, db, sql) {
  return execFileSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', SUPER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { encoding: 'utf8' });
}

// Chaves temporárias geradas a cada execução — nenhum segredo do .env entra no drill.
const DRILL_KEYS = {
  FILES_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
  PII_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
};

// Ambiente base dos processos filhos: conexão local sem SSL, jobs periódicos desligados
// (NODE_ENV=test), chaves temporárias do drill e nenhuma credencial de banco herdada do .env.
function childEnv(extra) {
  const env = { ...process.env, DB_SSL: 'false', NODE_ENV: 'test', LOG_LEVEL: 'silent', ...DRILL_KEYS, ...extra };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
  if (!extra || !extra.DB_MIGRATION_USER) {
    delete env.DB_MIGRATION_USER;
    delete env.DB_MIGRATION_PASSWORD;
  }
  return env;
}

function run(title, command, args, env) {
  const res = spawnSync(command, args, { cwd: API_ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, status: res.status, output };
}

function mustRun(title, command, args, env) {
  const res = run(title, command, args, env);
  if (!res.ok) throw new Error(`${title} falhou (exit ${res.status}):\n${res.output.split('\n').slice(-40).join('\n')}`);
  return res.output;
}

function startCluster(dataDir, port, workDir) {
  execFileSync(bin('initdb'), ['-D', dataDir, '-U', SUPER, '--auth=trust', '--encoding=UTF8', '--locale=C'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -k ${workDir} -c listen_addresses=127.0.0.1`, '-l', path.join(workDir, `pg-${port}.log`), '-w', 'start'], { stdio: 'ignore' });
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

function gitInfo() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: API_ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: API_ROOT, encoding: 'utf8' });
  return { commit: (res.stdout || '').trim() || 'desconhecido', dirty: Boolean((dirty.stdout || '').trim()) };
}

function filesUnder(root) {
  return fs.readdirSync(root, { recursive: true }).filter((p) => fs.statSync(path.join(root, String(p))).isFile()).length;
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-legal-drill-'));
  const dataSource = path.join(workDir, 'pgdata-source');
  const dataTarget = path.join(workDir, 'pgdata-target');
  const uploadsSource = path.join(workDir, 'uploads-source');
  const backupDir = path.join(workDir, 'backup');
  const storageBackup = path.join(backupDir, 'storage');
  const uploadsTarget = path.join(workDir, 'uploads-target');
  const fixturesFile = path.join(workDir, 'fixtures.json');
  const reportFile = path.join(workDir, 'report.json');
  const started = [];
  let exitCode = 1;
  const git = gitInfo();
  const startedAt = new Date();

  log('# Drill de restore jurídico (F05)');
  log(`Data: ${startedAt.toISOString()}`);
  log(`Commit da API: ${git.commit}${git.dirty ? ' (com alterações locais não commitadas)' : ''}`);
  log(`PostgreSQL: ${execFileSync(bin('postgres'), ['--version'], { encoding: 'utf8' }).trim()}`);
  log(`Diretório de trabalho: ${workDir}`);
  try {
    step(`1. Cluster de ORIGEM descartável (porta ${PORT_SOURCE})`);
    startCluster(dataSource, PORT_SOURCE, workDir);
    started.push(dataSource);
    createRuntimeRole(PORT_SOURCE);
    psql(PORT_SOURCE, 'postgres', 'CREATE DATABASE drill_source');
    const superEnvSource = childEnv({ DATABASE_URL: superUrl(PORT_SOURCE, 'drill_source') });
    const migrateOut = mustRun('migrations', 'npx', ['sequelize-cli', 'db:migrate'], { ...superEnvSource, NODE_ENV: 'development' });
    const migrated = (migrateOut.match(/migrated/g) || []).length;
    for (const seed of ['scripts/seed-dev.js', 'scripts/seedBillingRules.js', 'scripts/seedRealEstateRules.js']) {
      mustRun(seed, 'node', [seed], { ...superEnvSource, NODE_ENV: 'development' });
    }
    const schemaCount = grantRuntime(PORT_SOURCE, 'drill_source');
    log(`  role ${APP_ROLE} NOSUPERUSER/NOBYPASSRLS; ${migrated} migrations; seeds base; GRANT em ${schemaCount} schemas.`);

    step('2. Fixtures controladas pelos serviços reais (role de runtime, storage isolado)');
    fs.mkdirSync(uploadsSource, { recursive: true });
    log(`  ${mustRun('fixtures', 'node', ['scripts/restoreDrill/seedLegalFixtures.js', '--out', fixturesFile], childEnv({ DATABASE_URL: appUrl(PORT_SOURCE, 'drill_source'), UPLOADS_DIR: uploadsSource }))}`);

    step('3. Backup com os scripts reais do projeto (npm run backup + scripts/backupStorage.js)');
    // backupDatabase.js lê a conexão de DATABASE_URL e eleva para a credencial de DDL
    // (DB_MIGRATION_USER/PASSWORD) só no pg_dump — exatamente como em produção.
    const backupEnv = childEnv({ DATABASE_URL: appUrl(PORT_SOURCE, 'drill_source'), DB_MIGRATION_USER: SUPER, DB_MIGRATION_PASSWORD: 'trust-local' });
    const backupOut = mustRun('npm run backup', 'npm', ['run', '--silent', 'backup', '--', '--out', backupDir], backupEnv);
    const dumpFile = path.join(backupDir, fs.readdirSync(backupDir).find((f) => f.endsWith('.dump')));
    log(`  ${backupOut.split('\n').filter(Boolean).pop()}`);
    log(`  ${mustRun('backupStorage', 'node', ['scripts/backupStorage.js', '--source', uploadsSource, '--out', storageBackup], childEnv({}))}`);

    step(`4. Cluster de DESTINO NOVO (porta ${PORT_TARGET}, outro initdb — a role de runtime não existe)`);
    startCluster(dataTarget, PORT_TARGET, workDir);
    started.push(dataTarget);
    const roleBefore = psql(PORT_TARGET, 'postgres', `SELECT COUNT(*) FROM pg_roles WHERE rolname = '${APP_ROLE}'`).trim();
    log(`  role ${APP_ROLE} no cluster novo antes do restore: ${roleBefore === '0' ? 'ausente' : 'PRESENTE (inesperado)'}`);
    if (roleBefore !== '0') throw new Error('o cluster de destino deveria nascer sem a role de runtime');
    psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    // DATABASE_URL aponta para o cluster de destino com um nome de banco DIFERENTE do destino —
    // restoreDatabase.js recusa restaurar sobre o banco "principal" do ambiente.
    const restoreEnv = childEnv({ DATABASE_URL: appUrl(PORT_TARGET, 'drill_main'), DB_MIGRATION_USER: SUPER, DB_MIGRATION_PASSWORD: 'trust-local' });

    log('  4a. npm run restore SEM a role de runtime no destino:');
    const firstAttempt = run('npm run restore (sem role)', 'npm', ['run', '--silent', 'restore', '--', '--file', dumpFile, '--target-db', 'drill_target'], restoreEnv);
    const missingRoleDetected = !firstAttempt.ok && /role\(s\) ausente\(s\)/i.test(firstAttempt.output) && /nayara_runtime/.test(firstAttempt.output);
    log(`      → ${firstAttempt.ok ? 'concluiu (ERRADO: restore sem GRANTs para a aplicação)' : 'falhou'}${missingRoleDetected ? ` apontando as roles ausentes ✅ (${(firstAttempt.output.match(/servidor de destino: ([^.]+)\./) || [])[1] || ''})` : ''}`);
    if (!missingRoleDetected) throw new Error(`o restore sem a role deveria falhar apontando a role ausente:\n${firstAttempt.output.split('\n').slice(-10).join('\n')}`);

    log('  4b. Procedimento do runbook: cria as roles que o dump referencia (nayara_runtime e nayara_migration), recria o banco vazio, refaz o restore:');
    createRuntimeRole(PORT_TARGET);
    // nayara_migration: role NOLOGIN criada pela migration 336 (dona de default privileges) —
    // o dump referencia essa role; num cluster novo ela também precisa existir antes do restore.
    psql(PORT_TARGET, 'postgres', 'CREATE ROLE nayara_migration');
    psql(PORT_TARGET, 'postgres', 'DROP DATABASE drill_target');
    psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    log(`      → ${mustRun('npm run restore', 'npm', ['run', '--silent', 'restore', '--', '--file', dumpFile, '--target-db', 'drill_target'], restoreEnv).split('\n').filter(Boolean).pop()}`);
    const runtimeAttrs = psql(PORT_TARGET, 'postgres', `SELECT rolsuper || '/' || rolbypassrls FROM pg_roles WHERE rolname = '${APP_ROLE}'`).trim();
    log(`      → role ${APP_ROLE} no destino: superuser/bypassrls = ${runtimeAttrs}`);

    log('  4c. scripts/restoreStorage.js num diretório novo:');
    log(`      → ${mustRun('restoreStorage', 'node', ['scripts/restoreStorage.js', '--backup', storageBackup, '--target', uploadsTarget], childEnv({}))}`);
    log(`      → ${filesUnder(uploadsTarget)} arquivo(s) no storage restaurado.`);

    step('5. Verificação pós-restore');
    const verify = spawnSync('node', [
      'scripts/restoreDrill/verifyLegalRestore.js',
      '--fixtures', fixturesFile,
      '--source-url', superUrl(PORT_SOURCE, 'drill_source'),
      '--target-url', superUrl(PORT_TARGET, 'drill_target'),
      '--source-uploads', uploadsSource,
      '--target-app-url', appUrl(PORT_TARGET, 'drill_target'),
      '--report', reportFile,
    ], { cwd: API_ROOT, env: childEnv({ DATABASE_URL: appUrl(PORT_TARGET, 'drill_target'), UPLOADS_DIR: uploadsTarget, PORT: String(HTTP_PORT) }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of `${verify.stdout || ''}${verify.stderr || ''}`.split('\n')) log(line);
    exitCode = verify.status === 0 ? 0 : 1;
  } catch (err) {
    log(`\n❌ Drill interrompido: ${err.message}`);
    exitCode = 1;
  } finally {
    step('6. Teardown');
    for (const dataDir of started.reverse()) {
      try { execFileSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch (e) { /* já parado */ }
    }
    if (REPORT_DIR) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const stamp = startedAt.toISOString().slice(0, 10);
      const base = `drill-legal-restore-${stamp}-${git.commit.slice(0, 7)}`;
      fs.writeFileSync(path.join(REPORT_DIR, `${base}.log`), `${logLines.join('\n')}\n`);
      if (fs.existsSync(reportFile)) {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        fs.writeFileSync(path.join(REPORT_DIR, `${base}.json`), JSON.stringify({ commit: git.commit, dirty: git.dirty, date: startedAt.toISOString(), exitCode, ...report }, null, 2));
      }
      log(`  relatório salvo em ${REPORT_DIR}/${base}.{log,json}`);
    }
    if (KEEP) {
      log(`  --keep: diretório preservado em ${workDir} (clusters parados).`);
    } else {
      fs.rmSync(workDir, { recursive: true, force: true });
      log('  clusters parados e diretório temporário apagado — nenhum resíduo.');
    }
  }
  process.exit(exitCode);
}

main();
