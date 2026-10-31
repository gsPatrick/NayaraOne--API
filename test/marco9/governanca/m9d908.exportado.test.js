'use strict';

// M9-D908 (reabertura G2, L5, L6): o GO reconhece o relatório EXPORTADO e assinado do ensaio, não o banco do ensaio (que só existe em banco descartável). Adulteração, falta de
// assinatura e falta de chave recusam o GO; o registro dos ganchos é explícito. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const env = require('../_helpers/m9d908Dry');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

const gapReason = (err) => err.details.gaps.find((g) => g.code === 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED').detail.reason;
const edit = (file, change) => { const body = JSON.parse(fs.readFileSync(file, 'utf8')); change(body); fs.writeFileSync(file, JSON.stringify(body)); };

test('m9d908 o GO reconhece o relatório exportado mesmo sem o ensaio no banco do GO', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.conclusion, 'APROVADO');
    const file = s.exported.read();
    assert.equal(file.signature_alg, 'HMAC-SHA256');
    assert.equal(file.report_id, report.id);
    // o banco do GO (outro ambiente) não tem o ensaio: apaga o relatório e o GO passa pelo arquivo
    await env.adminQuery('DELETE FROM governance.mig_dry_reports WHERE company_id = $1', [A.companyId]);
    assert.ok((await env.decide(A, 'GO')).t0, 'GO aceito só com o arquivo exportado');
  } finally { s.dispose(); }
});

test('m9d908 o GO recusa relatório exportado adulterado, sem assinatura ou sem a chave', { skip: skip() }, async () => {
  await env.markRollbackSimulated(A, false);
  const file = process.env.MIGRATION_DRY3_REPORT_PATH;
  // edição à mão: vermelho vira verde sem reassinar
  edit(file, (body) => { body.criteria.rollback_simulated.ok = true; });
  const forged = await env.fail(env.decide(A, 'GO'));
  assert.equal(forged.code, 'GOV_CUTOVER_NOT_READY');
  assert.match(gapReason(forged), /alterado depois de assinado/);
  // sem assinatura
  edit(file, (body) => { delete body.signature; });
  assert.match(gapReason(await env.fail(env.decide(A, 'GO'))), /não está assinado/);
  // assinatura de outra chave
  await env.markRollbackSimulated(A, true);
  process.env.MIGRATION_DRY3_SIGNING_KEY = 'outra-chave-de-teste-diferente';
  assert.match(gapReason(await env.fail(env.decide(A, 'GO'))), /alterado depois de assinado/);
  // sem chave configurada no ambiente do GO
  delete process.env.MIGRATION_DRY3_SIGNING_KEY;
  assert.match(gapReason(await env.fail(env.decide(A, 'GO'))), /chave de assinatura/);
  // ensaio exportado REPROVADO, mesmo assinado e com a simulação verde
  await env.markRollbackSimulated(A, true);
  require('../../../src/features/migration-v2/dryrun/dry.export').exportReport({ id: 'qa-m9-reprovado', conclusion: 'REPROVADO', criteria: { rollback_simulated: { ok: true } }, commit: 'qa-m9' });
  assert.match(gapReason(await env.fail(env.decide(A, 'GO'))), /não foi APROVADO/);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows[0].n, 0);
});

test('m9d908 o GO sem arquivo exportado é recusado e o registro dos ganchos é idempotente', { skip: skip() }, async () => {
  env.dry.install();
  process.env.MIGRATION_DRY3_REPORT_PATH = '/nao/existe/dry3-report.json';
  const none = await env.fail(env.decide(A, 'GO'));
  assert.match(gapReason(none), /não foi encontrado/);
  assert.equal(none.details.gaps.find((g) => g.code === 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED').detail.reportId, null);
  // `install` registra uma vez só, por mais que seja chamado
  const readiness = require('../../../src/features/migration-v2/rollback/readiness');
  const before = (await env.openTenantTx(A, (tx) => readiness.collect(env.tenantOf(A), tx))).length;
  env.dry.install();
  assert.equal((await env.openTenantTx(A, (tx) => readiness.collect(env.tenantOf(A), tx))).length, before);
});
