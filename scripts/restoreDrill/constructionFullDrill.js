'use strict';

/**
 * Drill de restore de Obras e Pós-obra (Marco 6 — Caderno "Construção + Obras + Pós-obra" §13 DoD:
 * "testes adversariais/RLS/concorrência/restore verdes"; §14 "Produção somente após ... failure drills").
 * Mesmo desenho dos drills jurídico e de estoque, em DOIS clusters PostgreSQL locais e descartáveis —
 * nunca no banco de homologação/dev:
 *
 *   1. Cluster de ORIGEM: migrations do zero + seeds (como o CI), role de runtime NOSUPERUSER/NOBYPASSRLS.
 *   2. Fixtures pelos serviços reais de Obras (seedConstructionFixtures.js) como role de runtime.
 *   3. Backup com o script real do projeto (npm run backup → pg_dump -Fc).
 *   4. Cluster de DESTINO novo: roles do runbook, npm run restore.
 *   5. Verificação (verifyConstructionRestore.js): origem × destino tabela a tabela, invariantes da obra,
 *      RLS da role de runtime e a UNIQUE da conta a pagar da medição.
 *   6. Prova negativa: adultera o valor de uma medição no destino e confirma que a verificação ACUSA.
 *   7. Relatório (--report-dir) e teardown.
 *
 * Uso: node scripts/restoreDrill/constructionFullDrill.js [--keep] [--port 5543] [--report-dir <dir>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cl = require('../lib/disposableCluster');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argValue = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const PORT_SOURCE = Number(argValue('--port')) || 5543;
const PORT_TARGET = PORT_SOURCE + 1;
const REPORT_DIR = argValue('--report-dir');

const logLines = [];
function log(line = '') {
  console.log(line);
  logLines.push(line);
}
const step = (t) => log(`\n### ${t}`);

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-construction-drill-'));
  const backupDir = path.join(workDir, 'backup');
  const fixturesFile = path.join(workDir, 'fixtures.json');
  const reportFile = path.join(workDir, 'report.json');
  const tamperReport = path.join(workDir, 'report-tamper.json');
  const uploads = path.join(workDir, 'uploads');
  const git = cl.gitInfo();
  const startedAt = new Date();
  const childEnv = cl.makeChildEnv(cl.generateKeys());
  const toStop = [];
  let exitCode = 1;
  let tamperDetected = false;

  log('# Drill de restore — Obras e Pós-obra (Marco 6)');
  log(`Data: ${startedAt.toISOString()}`);
  log(`Commit da API: ${git.commit}${git.dirty ? ' (com alterações locais não commitadas)' : ''}`);
  log(`PostgreSQL: ${execFileSync(cl.bin('postgres'), ['--version'], { encoding: 'utf8' }).trim()}`);
  try {
    step(`1. Cluster de ORIGEM descartável (porta ${PORT_SOURCE})`);
    const src = cl.prepareDatabase({ port: PORT_SOURCE, db: 'drill_source', workDir, label: 'source' });
    toStop.push(src.dataDir);
    log(`  role ${cl.APP_ROLE} NOSUPERUSER/NOBYPASSRLS; ${src.migrated} migrations; seeds base; GRANT em ${src.schemaCount} schemas.`);

    fs.mkdirSync(uploads, { recursive: true });
    step('2. Fixtures pelos serviços reais de Obras (role de runtime, RLS real)');
    log(`  ${cl.mustRun('fixtures', 'node', ['scripts/restoreDrill/seedConstructionFixtures.js', '--out', fixturesFile], src.childEnv({ DATABASE_URL: src.appUrl, UPLOADS_DIR: uploads })).trim()}`);

    step('3. Backup com o script real (npm run backup → pg_dump -Fc)');
    const backupOut = cl.mustRun('npm run backup', 'npm', ['run', '--silent', 'backup', '--', '--out', backupDir],
      src.childEnv({ DATABASE_URL: src.appUrl, DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' }));
    const dumpFile = path.join(backupDir, fs.readdirSync(backupDir).find((f) => f.endsWith('.dump')));
    log(`  ${backupOut.split('\n').filter(Boolean).pop().replace(workDir, '<tmp>')}`);

    step(`4. Cluster de DESTINO novo (porta ${PORT_TARGET}) + restore pelo runbook`);
    const dataTarget = path.join(workDir, 'pgdata-target');
    cl.startCluster(dataTarget, PORT_TARGET, workDir);
    toStop.push(dataTarget);
    cl.createRuntimeRole(PORT_TARGET);
    cl.psql(PORT_TARGET, 'postgres', 'CREATE ROLE nayara_migration');
    // Achado neste drill (10/11/2026): desde as migrations de BI do Marco 9 (20260101009612) o dump traz GRANTs para
    // nayara_analytics_reader; sem a role no destino o restore falha. Criada como o runbook passa a instruir.
    cl.psql(PORT_TARGET, 'postgres', 'CREATE ROLE nayara_analytics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION');
    cl.psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    const restoreOut = cl.mustRun('npm run restore', 'npm', ['run', '--silent', 'restore', '--', '--file', dumpFile, '--target-db', 'drill_target'],
      src.childEnv({ DATABASE_URL: cl.appUrl(PORT_TARGET, 'drill_main'), DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' }));
    log(`  ${restoreOut.split('\n').filter(Boolean).pop().replace(workDir, '<tmp>')}`);

    step('5. Verificação pós-restore (scripts/restoreDrill/verifyConstructionRestore.js)');
    const verifyArgs = ['scripts/restoreDrill/verifyConstructionRestore.js', '--source-url', src.superUrl, '--target-url', cl.superUrl(PORT_TARGET, 'drill_target'),
      '--target-app-url', cl.appUrl(PORT_TARGET, 'drill_target'), '--fixtures', fixturesFile];
    const verify = cl.run('node', [...verifyArgs, '--report', reportFile], childEnv({}));
    for (const line of verify.output.split('\n')) log(line);

    step('6. Prova negativa: adultera o valor da medição no destino (+R$ 1,00) e roda a verificação de novo');
    const fx = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'));
    cl.psql(PORT_TARGET, 'drill_target', `UPDATE construction.stage_measurements SET total_amount = total_amount + 1 WHERE id = '${fx.measurementId}'`);
    const tampered = cl.run('node', [...verifyArgs, '--report', tamperReport], childEnv({}));
    const flagged = tampered.output.split('\n').filter((l) => l.includes('❌'));
    for (const l of flagged) log(`  ${l.trim()}`);
    tamperDetected = !tampered.ok && flagged.some((l) => l.includes('construction.stage_measurements')) && flagged.some((l) => l.includes('uma conta a pagar'));
    log(`  → adulteração ${tamperDetected ? 'DETECTADA ✅ (hash origem × destino e invariante da conta a pagar acusaram)' : 'NÃO detectada ❌'}`);

    exitCode = verify.ok && tamperDetected ? 0 : 1;
    log(`\nResultado do drill: ${exitCode === 0 ? 'APROVADO' : 'REPROVADO'}`);
  } catch (err) {
    log(`\n❌ Drill interrompido: ${err.message}`);
    exitCode = 1;
  } finally {
    step('7. Teardown');
    for (const d of toStop.reverse()) cl.stopCluster(d);
    if (REPORT_DIR) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const base = `drill-construction-restore-${startedAt.toISOString().slice(0, 10)}-${git.commit.slice(0, 7)}`;
      log(`  relatório salvo em ${base}.{log,json}`);
      fs.writeFileSync(path.join(REPORT_DIR, `${base}.log`), `${logLines.join('\n')}\n`);
      if (fs.existsSync(reportFile)) {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        fs.writeFileSync(path.join(REPORT_DIR, `${base}.json`), JSON.stringify({ commit: git.commit, dirty: git.dirty, date: startedAt.toISOString(), durationSeconds: (Date.now() - startedAt) / 1000, exitCode, provaNegativaDetectada: tamperDetected, ...report }, null, 2));
      }
    }
    if (KEEP) {
      log(`  --keep: diretório preservado em ${workDir} (clusters parados).`);
    } else {
      fs.rmSync(workDir, { recursive: true, force: true });
      log(`  clusters parados e diretório temporário apagado — nenhum resíduo. Duração total: ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
    }
  }
  process.exit(exitCode);
}

main();
