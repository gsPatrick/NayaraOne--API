'use strict';

/**
 * Drill de restore/replay FINANCEIRO completo (Marco 4 — Caderno §21 "Restore/replay financeiro
 * validado", Guia do Marcelo §1.17 e §20, pedido M4-25 "Restore e replay financeiro sem
 * duplicidade"). Mesmo desenho dos drills jurídico e de estoque, em DOIS clusters PostgreSQL
 * locais e descartáveis — nunca no banco de homologação/dev:
 *
 *   1. ORIGEM (porta P): migrations do zero + seeds do CI; role nayara_runtime NOSUPERUSER/NOBYPASSRLS.
 *   2. Fixtures financeiras pelos serviços reais (seedFinanceFixtures.js), com commit.
 *   3. Backup com os scripts reais: npm run backup (pg_dump -Fc) + scripts/backupStorage.js.
 *   4. DESTINO NOVO (porta P+1, outro initdb):
 *      4a. restore SEM as roles → tem que falhar apontando as roles ausentes;
 *      4b. runbook: cria nayara_runtime + roles de apoio (restoreRoles.js), banco vazio, restore;
 *      4c. scripts/restoreStorage.js num diretório novo.
 *   5. Verificação (verifyFinanceRestore.js): origem × destino campo a campo e hash por objeto,
 *      bytes dos comprovantes, invariantes (saldo, append-only, período) e RLS.
 *   6. Replay e adulteração (replayFinanceRestore.js): callback, extrato, chave idempotente,
 *      baixa parcial, comissão, período fechado; adulteração detectada pelo hash.
 *   7. Relatório (--report-dir) sem segredos nem strings de conexão, e teardown.
 *
 * Uso: node scripts/restoreDrill/financeFullDrill.js [--keep] [--port 5523] [--report-dir <dir>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cl = require('../lib/disposableCluster');
const { createSupportRoles } = require('./restoreRoles');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argValue = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const PORT_SOURCE = Number(argValue('--port')) || 5523;
const PORT_TARGET = PORT_SOURCE + 1;
const REPORT_DIR = argValue('--report-dir');

const logLines = [];
let WORK = '';
function sanitize(line) {
  return String(line)
    .replace(/postgres(ql)?:\/\/\S+/gi, '<conexão local do drill omitida>')
    .replace(new RegExp(cl.APP_PASSWORD, 'g'), '<omitido>')
    .split(WORK || '\u0000').join('<tmp>');
}
function log(line = '') {
  const clean = sanitize(line);
  console.log(clean);
  logLines.push(clean);
}
const step = (t) => log(`\n### ${t}`);
// Última linha útil da saída (ignora avisos de depreciação do Node no stderr).
const last = (out) => out.split('\n').filter((l) => l && !/DeprecationWarning|--trace-deprecation/.test(l)).pop();

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-finance-drill-'));
  WORK = workDir;
  const backupDir = path.join(workDir, 'backup');
  const storageBackup = path.join(backupDir, 'storage');
  const uploadsSource = path.join(workDir, 'uploads-source');
  const uploadsTarget = path.join(workDir, 'uploads-target');
  const fixturesFile = path.join(workDir, 'fixtures.json');
  const verifyReport = path.join(workDir, 'verify.json');
  const replayReport = path.join(workDir, 'replay.json');
  const git = cl.gitInfo();
  const startedAt = new Date();
  const keys = cl.generateKeys();
  const childEnv = cl.makeChildEnv(keys);
  const toStop = [];
  const stages = {};
  let exitCode = 1;

  log('# Drill de restore/replay financeiro (Marco 4)');
  log(`Data: ${startedAt.toISOString()}`);
  log(`Commit da API: ${git.commit}${git.dirty ? ' (com alterações locais não commitadas)' : ''}`);
  log(`PostgreSQL: ${execFileSync(cl.bin('postgres'), ['--version'], { encoding: 'utf8' }).trim()}`);
  try {
    step(`1. Cluster de ORIGEM descartável (porta ${PORT_SOURCE})`);
    const src = cl.prepareDatabase({ port: PORT_SOURCE, db: 'drill_source', workDir, keys, label: 'source' });
    toStop.push(src.dataDir);
    log(`  role ${cl.APP_ROLE} NOSUPERUSER/NOBYPASSRLS; ${src.migrated} migrations; seeds base; GRANT em ${src.schemaCount} schemas.`);
    stages.origem = { migrations: src.migrated, schemas: src.schemaCount };

    step('2. Fixtures financeiras pelos serviços reais (role de runtime, RLS real, com commit)');
    fs.mkdirSync(uploadsSource, { recursive: true });
    log(`  ${last(cl.mustRun('fixtures', 'node', ['scripts/restoreDrill/seedFinanceFixtures.js', '--out', fixturesFile], childEnv({ DATABASE_URL: src.appUrl, UPLOADS_DIR: uploadsSource })))}`);

    step('3. Backup com os scripts reais (npm run backup → pg_dump -Fc; scripts/backupStorage.js)');
    const backupOut = cl.mustRun('npm run backup', 'npm', ['run', '--silent', 'backup', '--', '--out', backupDir],
      childEnv({ DATABASE_URL: src.appUrl, DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' }));
    const dumpFile = path.join(backupDir, fs.readdirSync(backupDir).find((f) => f.endsWith('.dump')));
    log(`  ${last(backupOut)}`);
    log(`  ${last(cl.mustRun('backupStorage', 'node', ['scripts/backupStorage.js', '--source', uploadsSource, '--out', storageBackup], childEnv({})))}`);
    stages.backup = { dumpBytes: fs.statSync(dumpFile).size };

    step(`4. Cluster de DESTINO NOVO (porta ${PORT_TARGET}, outro initdb)`);
    const dataTarget = path.join(workDir, 'pgdata-target');
    cl.startCluster(dataTarget, PORT_TARGET, workDir);
    toStop.push(dataTarget);
    cl.psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    const restoreEnv = childEnv({ DATABASE_URL: cl.appUrl(PORT_TARGET, 'drill_main'), DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' });
    const restoreArgs = ['run', '--silent', 'restore', '--', '--file', dumpFile, '--target-db', 'drill_target'];
    const first = cl.run('npm', restoreArgs, restoreEnv);
    const missing = (first.output.match(/servidor de destino: ([^.]+)\./) || [])[1] || '';
    const refused = !first.ok && /role\(s\) ausente\(s\)/i.test(first.output) && /nayara_runtime/.test(missing);
    log(`  4a. restore SEM as roles no destino → ${first.ok ? 'concluiu (ERRADO)' : 'falhou'}${refused ? ` apontando as roles ausentes ✅ (${missing})` : ' ❌'}`);
    if (!refused) throw new Error(`o restore sem as roles deveria falhar apontando-as:\n${last(first.output)}`);
    cl.createRuntimeRole(PORT_TARGET);
    const support = createSupportRoles(cl.psql, PORT_TARGET);
    cl.psql(PORT_TARGET, 'postgres', 'DROP DATABASE drill_target');
    cl.psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    log(`  4b. runbook: roles ${cl.APP_ROLE} + ${support.join(' + ')} criadas; banco vazio; restore → ${last(cl.mustRun('npm run restore', 'npm', restoreArgs, restoreEnv))}`);
    log(`      role ${cl.APP_ROLE} no destino: superuser/bypassrls = ${cl.psql(PORT_TARGET, 'postgres', `SELECT rolsuper || '/' || rolbypassrls FROM pg_roles WHERE rolname = '${cl.APP_ROLE}'`).trim()}`);
    log(`  4c. ${last(cl.mustRun('restoreStorage', 'node', ['scripts/restoreStorage.js', '--backup', storageBackup, '--target', uploadsTarget], childEnv({})))}`);
    stages.restore = { rolesAusentesDetectadas: missing, rolesCriadas: [cl.APP_ROLE, ...support] };

    const common = ['--fixtures', fixturesFile, '--source-url', src.superUrl, '--target-url', cl.superUrl(PORT_TARGET, 'drill_target'), '--target-app-url', cl.appUrl(PORT_TARGET, 'drill_target')];
    const targetEnv = childEnv({ DATABASE_URL: cl.appUrl(PORT_TARGET, 'drill_target'), UPLOADS_DIR: uploadsTarget });

    step('5. Verificação pós-restore (verifyFinanceRestore.js)');
    const verify = cl.run('node', ['scripts/restoreDrill/verifyFinanceRestore.js', ...common, '--source-uploads', uploadsSource, '--report', verifyReport], targetEnv);
    for (const line of verify.output.split('\n')) log(line);

    step('6. Replay pós-restore e adulteração deliberada (replayFinanceRestore.js)');
    const replay = cl.run('node', ['scripts/restoreDrill/replayFinanceRestore.js', ...common, '--report', replayReport], targetEnv);
    for (const line of replay.output.split('\n')) log(line);

    exitCode = verify.ok && replay.ok ? 0 : 1;
    const v = fs.existsSync(verifyReport) ? JSON.parse(fs.readFileSync(verifyReport, 'utf8')) : { approved: 0, total: 0 };
    const r = fs.existsSync(replayReport) ? JSON.parse(fs.readFileSync(replayReport, 'utf8')) : { approved: 0, total: 0 };
    log(`\nResultado do drill: ${exitCode === 0 ? 'APROVADO' : 'REPROVADO'} — ${v.approved + r.approved}/${v.total + r.total} checagens aprovadas.`);
  } catch (err) {
    log(`\n❌ Drill interrompido: ${err.message}`);
    exitCode = 1;
  } finally {
    step('7. Teardown');
    for (const d of toStop.reverse()) cl.stopCluster(d);
    const finishedAt = new Date();
    if (REPORT_DIR) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const base = `drill-finance-restore-${startedAt.toISOString().slice(0, 10)}-${git.commit.slice(0, 7)}`;
      const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
      const fixtures = read(fixturesFile);
      const verifyData = read(verifyReport);
      const replayData = read(replayReport);
      if (fixtures && fixtures.tenantA && fixtures.tenantA.payment) delete fixtures.tenantA.payment.webhookSignature;
      const report = {
        drill: 'restore/replay financeiro (Marco 4)', commit: git.commit, dirty: git.dirty, iniciadoEm: startedAt.toISOString(), terminadoEm: finishedAt.toISOString(),
        duracaoSegundos: (finishedAt - startedAt) / 1000, exitCode, comando: `node scripts/restoreDrill/financeFullDrill.js --port ${PORT_SOURCE} --report-dir ${path.relative(cl.API_ROOT, REPORT_DIR) || REPORT_DIR}`,
        etapas: stages, fixtures,
        checagens: { aprovadas: (verifyData ? verifyData.approved : 0) + (replayData ? replayData.approved : 0), total: (verifyData ? verifyData.total : 0) + (replayData ? replayData.total : 0) },
        objetos: verifyData ? verifyData.objectSummary : [], replays: replayData ? replayData.replays : [],
        verificacao: verifyData ? verifyData.checks : [], replayEAdulteracao: replayData ? replayData.checks : [],
      };
      fs.writeFileSync(path.join(REPORT_DIR, `${base}.json`), sanitize(JSON.stringify(report, null, 2)));
      log(`  relatório salvo em ${path.relative(cl.API_ROOT, REPORT_DIR) || REPORT_DIR}/${base}.{log,json}`);
      fs.writeFileSync(path.join(REPORT_DIR, `${base}.log`), `${logLines.join('\n')}\n`);
    }
    if (KEEP) log(`  --keep: diretório preservado em ${workDir} (clusters parados).`);
    else {
      fs.rmSync(workDir, { recursive: true, force: true });
      log(`  clusters parados e diretório temporário apagado — nenhum resíduo. Duração: ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
    }
    if (REPORT_DIR) fs.writeFileSync(path.join(REPORT_DIR, `drill-finance-restore-${startedAt.toISOString().slice(0, 10)}-${git.commit.slice(0, 7)}.log`), `${logLines.join('\n')}\n`);
  }
  process.exit(exitCode);
}

main();
