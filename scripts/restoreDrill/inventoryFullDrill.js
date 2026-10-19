'use strict';

/**
 * Drill de restore de Estoque / Compras / Seguros / Patrimônio (Marco 7, DoD "restore verdes").
 * Mesmo desenho do drill jurídico (legalFullDrill.js), em DOIS clusters PostgreSQL locais e
 * descartáveis — nunca no banco de homologação/dev:
 *
 *   1. Cluster de ORIGEM: migrations do zero + seeds (como o CI), role de runtime
 *      NOSUPERUSER/NOBYPASSRLS.
 *   2. Fixtures pelos serviços reais (seedInventoryFixtures.js) como role de runtime.
 *   3. Backup com o script real do projeto (npm run backup → pg_dump -Fc).
 *   4. Cluster de DESTINO novo: roles criadas pelo procedimento do runbook, npm run restore.
 *   5. Verificação (verifyRestoreInventoryProcurementData.js): invariantes de saldo × ledger,
 *      pedidos/recebimentos/divergências/payables, apólices/parcelas, ativos; origem × destino
 *      tabela a tabela (contagem + SHA-256); RLS da role de runtime no destino.
 *   6. Prova negativa: adultera um saldo no destino e confirma que a verificação ACUSA.
 *   7. Relatório (--report-dir) e teardown.
 *
 * Uso: node scripts/restoreDrill/inventoryFullDrill.js [--keep] [--port 5452] [--report-dir <dir>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cl = require('../lib/disposableCluster');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argValue = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const PORT_SOURCE = Number(argValue('--port')) || 5452;
const PORT_TARGET = PORT_SOURCE + 1;
const REPORT_DIR = argValue('--report-dir');

const logLines = [];
function log(line = '') {
  console.log(line);
  logLines.push(line);
}
const step = (t) => log(`\n### ${t}`);

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-inventory-drill-'));
  const backupDir = path.join(workDir, 'backup');
  const fixturesFile = path.join(workDir, 'fixtures.json');
  const reportFile = path.join(workDir, 'report.json');
  const tamperReport = path.join(workDir, 'report-tamper.json');
  const git = cl.gitInfo();
  const startedAt = new Date();
  const keys = cl.generateKeys();
  const childEnv = cl.makeChildEnv(keys);
  const toStop = [];
  let exitCode = 1;

  log('# Drill de restore — Estoque / Compras / Seguros / Patrimônio (Marco 7)');
  log(`Data: ${startedAt.toISOString()}`);
  log(`Commit da API: ${git.commit}${git.dirty ? ' (com alterações locais não commitadas)' : ''}`);
  log(`PostgreSQL: ${execFileSync(cl.bin('postgres'), ['--version'], { encoding: 'utf8' }).trim()}`);
  try {
    step(`1. Cluster de ORIGEM descartável (porta ${PORT_SOURCE})`);
    const src = cl.prepareDatabase({ port: PORT_SOURCE, db: 'drill_source', workDir, keys, label: 'source' });
    toStop.push(src.dataDir);
    log(`  role ${cl.APP_ROLE} NOSUPERUSER/NOBYPASSRLS; ${src.migrated} migrations; seeds base; GRANT em ${src.schemaCount} schemas.`);

    step('2. Fixtures pelos serviços reais (role de runtime, RLS real)');
    log(`  ${cl.mustRun('fixtures', 'node', ['scripts/restoreDrill/seedInventoryFixtures.js', '--out', fixturesFile], childEnv({ DATABASE_URL: src.appUrl }))}`);

    step('3. Backup com o script real (npm run backup → pg_dump -Fc)');
    const backupOut = cl.mustRun('npm run backup', 'npm', ['run', '--silent', 'backup', '--', '--out', backupDir],
      childEnv({ DATABASE_URL: src.appUrl, DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' }));
    const dumpFile = path.join(backupDir, fs.readdirSync(backupDir).find((f) => f.endsWith('.dump')));
    log(`  ${backupOut.split('\n').filter(Boolean).pop().replace(workDir, '<tmp>')}`);

    step(`4. Cluster de DESTINO novo (porta ${PORT_TARGET}) + restore pelo runbook`);
    const dataTarget = path.join(workDir, 'pgdata-target');
    cl.startCluster(dataTarget, PORT_TARGET, workDir);
    toStop.push(dataTarget);
    cl.createRuntimeRole(PORT_TARGET);
    cl.psql(PORT_TARGET, 'postgres', 'CREATE ROLE nayara_migration');
    cl.psql(PORT_TARGET, 'postgres', 'CREATE DATABASE drill_target');
    const restoreOut = cl.mustRun('npm run restore', 'npm', ['run', '--silent', 'restore', '--', '--file', dumpFile, '--target-db', 'drill_target'],
      childEnv({ DATABASE_URL: cl.appUrl(PORT_TARGET, 'drill_main'), DB_MIGRATION_USER: cl.SUPER, DB_MIGRATION_PASSWORD: 'trust-local' }));
    log(`  ${restoreOut.split('\n').filter(Boolean).pop().replace(workDir, '<tmp>')}`);

    step('5. Verificação pós-restore (scripts/verifyRestoreInventoryProcurementData.js)');
    const verifyArgs = ['scripts/verifyRestoreInventoryProcurementData.js', '--source-url', src.superUrl, '--target-url', cl.superUrl(PORT_TARGET, 'drill_target'),
      '--target-app-url', cl.appUrl(PORT_TARGET, 'drill_target'), '--fixtures', fixturesFile];
    const verify = cl.run('node', [...verifyArgs, '--report', reportFile], childEnv({}));
    for (const line of verify.output.split('\n')) log(line);

    step('6. Prova negativa: adultera 1 saldo no destino (+1 unidade) e roda a verificação de novo');
    cl.psql(PORT_TARGET, 'drill_target', 'UPDATE inventory.stock_balances SET quantity_on_hand = quantity_on_hand + 1 WHERE id = (SELECT id FROM inventory.stock_balances ORDER BY id LIMIT 1)');
    const tampered = cl.run('node', [...verifyArgs, '--report', tamperReport], childEnv({}));
    const flagged = tampered.output.split('\n').filter((l) => l.includes('❌'));
    for (const l of flagged) log(`  ${l.trim()}`);
    const tamperDetected = !tampered.ok && flagged.some((l) => l.includes('soma dos movimentos')) && flagged.some((l) => l.includes('idênticas'));
    log(`  → adulteração ${tamperDetected ? 'DETECTADA ✅ (verificação saiu com erro)' : 'NÃO detectada ❌'}`);

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
      const base = `drill-inventory-restore-${startedAt.toISOString().slice(0, 10)}-${git.commit.slice(0, 7)}`;
      log(`  relatório salvo em ${path.relative(cl.API_ROOT, REPORT_DIR) || REPORT_DIR}/${base}.{log,json}`);
      fs.writeFileSync(path.join(REPORT_DIR, `${base}.log`), `${logLines.join('\n')}\n`);
      if (fs.existsSync(reportFile)) {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        fs.writeFileSync(path.join(REPORT_DIR, `${base}.json`), JSON.stringify({ commit: git.commit, dirty: git.dirty, date: startedAt.toISOString(), durationSeconds: (Date.now() - startedAt) / 1000, exitCode, ...report }, null, 2));
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
