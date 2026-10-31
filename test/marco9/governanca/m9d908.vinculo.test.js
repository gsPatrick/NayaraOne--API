'use strict';

// M9-D908 (reabertura da rodada 2, N2): o GO só vale com o relatório do ensaio vinculado a esta empresa, ao commit em execução, recente, com os seis critérios verdes, todos os
// lotes verificados e volume mínimo. Cada limite é parâmetro do administrador. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../_helpers/m9d908Dry');
const reports = require('../_helpers/m9d908Report');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

const GAP = 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED';
const reason = (err) => err.details.gaps.find((g) => g.code === GAP).detail.reason;
const go = async () => { await env.adminQuery('DELETE FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId]); return env.decide(A, 'GO'); };
const refused = async (fields, pattern) => { reports.writeReport(A, fields); const err = await env.fail(go()); assert.equal(err && err.code, 'GOV_CUTOVER_NOT_READY'); assert.match(reason(err), pattern); };
const accepted = async (fields) => { reports.writeReport(A, fields); assert.ok((await go()).t0, 'GO aceito'); };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('m9d908 o GO aceita o relatório íntegro, da empresa, do commit em execução, recente e com volume', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try { await accepted({}); } finally { s.dispose(); }
});

test('m9d908 o GO recusa relatório assinado de outra empresa ou sem empresa', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await refused({ company_id: (await env.loadTenants()).B.companyId }, /outra empresa/);
    await refused({ company_id: undefined }, /outra empresa/);
  } finally { s.dispose(); }
});

test('m9d908 o GO recusa relatório de outro commit, salvo se o administrador desligar a exigência', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await refused({ commit: 'deadbeef00000000000000000000000000000000' }, /outro commit/);
    await env.setParam(A, 'migracao.dry3.exigir_commit_igual', false);
    await accepted({ commit: 'deadbeef00000000000000000000000000000000' });
  } finally { s.dispose(); }
});

test('m9d908 o GO recusa relatório velho, e a validade é parâmetro', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await refused({ generated_at: '2019-01-01T00:00:00.000Z' }, /mais velho que o prazo/);
    await refused({ generated_at: daysAgo(8) }, /mais velho que o prazo/);
    await accepted({ generated_at: daysAgo(6) });
    await env.setParam(A, 'migracao.dry3.validade_horas', 24);
    await refused({ generated_at: daysAgo(2) }, /mais velho que o prazo/);
    await refused({ generated_at: new Date(Date.now() + 86400000).toISOString() }, /data de geração/);
  } finally { s.dispose(); }
});

test('m9d908 o GO exige os seis critérios verdes e todos os lotes verificados, não só a simulação de rollback', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    for (const name of ['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated']) {
      await refused({ criteria: reports.criteria({ [name]: { ...reports.criteria()[name], ok: false } }) }, new RegExp(`critério.*${name}`));
    }
    await refused({ criteria: reports.criteria({ batches_verified: { ok: true, total: 40, verified: 39, pct: 97.5 } }) }, /lotes/);
    await refused({ criteria: { rollback_simulated: { ok: true } } }, /critério/);
  } finally { s.dispose(); }
});

test('m9d908 o GO exige volume mínimo e o mínimo é parâmetro', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'migracao.dry3.volume_minimo'", [A.companyId]); // volta ao padrão (1000)
    const small = reports.criteria({ counts_match: { ok: true, entities: 1, mismatched: 0, rows: 5, destinationRows: 5 } });
    await refused({ criteria: small }, /volume/);
    await refused({ criteria: reports.criteria({ counts_match: { ok: true, entities: 1, mismatched: 0 } }) }, /volume/);
    await env.setParam(A, 'migracao.dry3.volume_minimo', 5);
    await accepted({ criteria: small });
  } finally { s.dispose(); }
});

test('m9d908 o GO recusa relatório sem identificador de ensaio', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await refused({ report_id: 'qa-m9-qualquer' }, /identificador/);
    await refused({ report_id: undefined }, /identificador/);
  } finally { s.dispose(); }
});

test('m9d908 o ensaio real exporta empresa, volume e commit; em teste, sem caminho explícito, nunca grava em docs/governance', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.conclusion, 'APROVADO');
    const file = s.exported.read();
    assert.equal(file.company_id, A.companyId);
    assert.equal(file.criteria.counts_match.rows, 5);
    assert.equal(file.criteria.counts_match.destinationRows, 5);
    delete process.env.MIGRATION_DRY3_REPORT_PATH;
    const { exportPath } = require('../../../src/features/migration-v2/dryrun/dry.export');
    assert.ok(exportPath().startsWith(os.tmpdir()) || exportPath().startsWith(fs.realpathSync(os.tmpdir())), 'sem caminho explícito, o teste grava no diretório temporário');
    assert.ok(!exportPath().includes(`${path.sep}docs${path.sep}governance`));
  } finally { s.dispose(); }
});
