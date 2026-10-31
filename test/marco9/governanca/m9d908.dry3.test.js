'use strict';

// M9-D908 §3.3 e §3.4 — o ensaio DRY3 de ponta a ponta no banco descartável: aprovado com os seis critérios, reprovado por blocker e por volume, relatório sem dado pessoal em claro
// (hash e comparação usam o valor real), arquivo exportado e as regras de exibição. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d908Dry');
const blockersProviders = require('../../../src/features/migration-v2/control/blockers.providers');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

test('m9d908 DRY3 completo aprovado com relatório e projeção', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.status, 'COMPLETED', JSON.stringify(report.errors));
    assert.equal(report.conclusion, 'APROVADO', JSON.stringify([report.criteria, report.errors]));
    for (const name of ['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated', 'rollback_simulated']) assert.equal(report.criteria[name].ok, true, name);
    assert.deepEqual(report.phases.map((p) => p.name), ['CLOCK', 'LOAD', 'DELTA', 'VERIFY', 'VOLUME', 'TZ_SAMPLE', 'COMPARE', 'ROLLBACK', 'TOWER']);
    assert.ok(report.phases.every((p) => p.status === 'DONE' && Number.isInteger(p.durationMs)), 'duração por fase');
    assert.deepEqual(report.volumes.map((v) => [v.entity, v.origin, v.destination, v.equal]), [['PERSON', 5, 5, true]]);
    assert.deepEqual([report.criteria.batches_verified.total > 0, report.criteria.batches_verified.pct], [true, 100]);
    assert.deepEqual([report.criteria.rollback_simulated.activated, report.criteria.rollback_simulated.rolledBack, report.criteria.rollback_simulated.pendingItems], [6, 6, 0]);
    assert.equal(report.criteria.clock_tz_validated.tzChecked, 5, 'as cinco pessoas de borda conferidas ponto a ponto');
    assert.deepEqual(report.blockers, []);
    assert.ok(report.durationMs === undefined || report.finishedAt, 'relatório fechado');
    // exportação para o fechamento do bloco F
    const file = s.exported.read();
    assert.deepEqual(Object.keys(file).sort(), ['commit', 'conclusion', 'criteria', 'generated_at', 'report_id']);
    assert.equal(file.conclusion, 'APROVADO');
    assert.match(file.commit, /^[0-9a-f]{7,40}$|^unknown$/);
    assert.ok(Date.now() - new Date(file.generated_at) < 120000);
    assert.equal(Object.values(file.criteria).every((c) => c.ok), true);
    // a janela de comparação do ensaio não fica aberta
    assert.equal((await env.adminQuery("SELECT count(*)::int AS n FROM governance.parallel_windows WHERE company_id = $1 AND status <> 'CLOSED'", [A.companyId])).rows[0].n, 0);
  } finally { s.dispose(); }
});

test('m9d908 DRY3 reprova com qualquer blocker', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  const off = blockersProviders.register('qa908-blocker', async () => [{ code: 'GOV_MIG_QA908', entity: 'PERSON', ref: 'qa908', owner: null, detail: { motivo: 'teste' } }]);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.conclusion, 'REPROVADO');
    assert.equal(report.criteria.blockers_zero.ok, false);
    assert.deepEqual(report.criteria.blockers_zero.codes, ['GOV_MIG_QA908']);
    assert.deepEqual(report.blockers, [{ code: 'GOV_MIG_QA908', entity: 'PERSON', ref: 'qa908' }]);
    assert.equal(report.criteria.counts_match.ok, true, 'só o critério do blocker caiu');
    assert.equal(s.exported.read().conclusion, 'REPROVADO', 'o arquivo carrega a reprovação');
  } finally { off(); s.dispose(); }
});

test('m9d908 contagem por entidade confere com a origem', { skip: skip() }, async () => {
  const invalid = env.personRecord({ taxId: '123' }); // CPF inválido: vai à quarentena, nunca ao destino
  const s = await env.scenario(A, { extra: [invalid] });
  try {
    const report = await env.runDry3(A);
    const person = report.volumes.find((v) => v.entity === 'PERSON');
    assert.deepEqual([person.origin, person.destination, person.difference, person.equal], [6, 5, 1, false]);
    assert.equal(report.conclusion, 'REPROVADO');
    assert.deepEqual([report.criteria.counts_match.ok, report.criteria.counts_match.code], [false, 'GOV_MIG_VOLUME_MISMATCH']);
    const volumePhase = report.phases.find((p) => p.name === 'VOLUME');
    assert.deepEqual([volumePhase.status, volumePhase.error.code, volumePhase.error.message], ['FAILED', 'GOV_MIG_VOLUME_MISMATCH', 'O volume migrado não confere com a origem.']);
    assert.equal(report.quarantine.QUARANTINED, 1, 'a quarentena aparece no relatório');
    assert.ok(report.blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN'));
  } finally { s.dispose(); }
});

test('m9d908 verificação de hash e comparação usam o valor real mesmo com exibição mascarada', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    const report = await env.runDry3(A);
    assert.equal(report.conclusion, 'APROVADO', JSON.stringify([report.criteria, report.errors, report.blockers]));
    assert.equal(report.criteria.batches_verified.pct, 100, 'hash do lote calculado sobre o valor real: nunca "falha em bater"');
    assert.equal(report.criteria.parallel_clean.blockers, 0, 'a comparação paralela leu o valor real');
    assert.ok(report.samples.length > 0 && report.samples.every((x) => x.masked === true));
    const text = JSON.stringify(report);
    for (const name of s.names) assert.ok(!text.includes(name), `nome em claro: ${name} ${JSON.stringify(report.samples.slice(0, 2))}`);
    for (const taxId of s.taxIds) assert.ok(!text.includes(taxId), 'CPF em claro no relatório');
    assert.ok(report.samples.some((x) => x.fields.some((f) => typeof f.value === 'string' && f.value.includes('*'))), 'valores mostrados com máscara');
    const fileText = JSON.stringify(s.exported.read());
    for (const name of s.names) assert.ok(!fileText.includes(name));
    const rows = await env.adminQuery("SELECT status FROM governance.mig_batches WHERE company_id = $1 AND source_system = $2", [A.companyId, s.legacy.system]);
    assert.ok(rows.rows.length > 0 && rows.rows.every((r) => r.status === 'VERIFIED'));
    // com o parâmetro ligado (ambiente que pode ver o claro) a exibição sai sem máscara; hash e comparação continuam iguais
    await env.setParam(A, 'migracao.dry3.dados_pessoais_em_claro', true);
    await env.adminQuery('DELETE FROM governance.mig_dry_reports WHERE company_id = $1', [A.companyId]);
    const clear = await env.runDry3(A);
    assert.ok(clear.samples.every((x) => x.masked === false));
    assert.ok(JSON.stringify(clear.samples).includes(s.names[0]), 'exibição em claro quando o ambiente de ensaio pode ver');
  } finally { s.dispose(); }
});

test('m9d908 o número de exemplos e a duração da janela são parâmetros', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await env.setParam(A, 'migracao.dry3.exemplos_no_relatorio', 2);
    await env.setParam(A, 'migracao.dry3.janela_comparacao_min', 30);
    await env.setParam(A, 'migracao.fuso.amostra_por_entidade', 3);
    const report = await env.runDry3(A);
    assert.equal(report.samples.length, 2);
    const tz = report.phases.find((p) => p.name === 'TZ_SAMPLE').detail.entities[0];
    assert.deepEqual([tz.sampled, tz.checked], [3, 3], 'a amostra respeita migracao.fuso.amostra_por_entidade');
    assert.ok(tz.edge >= 3, 'as datas de borda entram primeiro');
    const [window] = (await env.adminQuery("SELECT starts_at, ends_at FROM governance.parallel_windows WHERE company_id = $1 AND name = 'DRY3' AND source_system = $2", [A.companyId, s.legacy.system])).rows;
    assert.equal(Math.round((new Date(window.ends_at) - new Date(window.starts_at)) / 60000), 31, '30 minutos de janela mais 1 de antecedência');
  } finally { s.dispose(); }
});

test('m9d908 ensaio interrompido marca ABORTED sem aprovar e o RUNNING vencido é liberado', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    const open = await env.dry.openDryRun(A, { userId: A.userId });
    const again = await env.fail(env.dry.openDryRun(A, { userId: A.userId }));
    assert.deepEqual([again.status, again.code], [409, 'GOV_MIG_DRY_RUNNING']);
    await env.setParam(A, 'migracao.dry3.timeout_min', 1);
    const next = await env.dry.openDryRun(A, { userId: A.userId }, { now: new Date(Date.now() + 5 * 60000) });
    assert.notEqual(next.id, open.id);
    const stale = await env.reportRow(open.id);
    assert.deepEqual([stale.status, stale.conclusion], ['ABORTED', null]);
    // erro inesperado no meio também aborta (e nada é exportado)
    await env.adminQuery("UPDATE governance.mig_dry_reports SET status = 'ABORTED', finished_at = now() WHERE company_id = $1 AND status = 'RUNNING'", [A.companyId]);
    const load = require('../../../src/features/migration-v2/dryrun/dry.load');
    const original = load.loadAll;
    load.loadAll = async () => { throw new Error('queda no meio da carga'); };
    try {
      const report = await env.runDry3(A);
      assert.equal(report.conclusion, 'REPROVADO', 'fase com erro reprova');
      assert.equal(report.phases.find((p) => p.name === 'LOAD').status, 'FAILED');
    } finally { load.loadAll = original; }
    // falha ao exportar o arquivo (caminho impossível): o ensaio vira ABORTED, não COMPLETED, e nada é aprovado
    await env.adminQuery('DELETE FROM governance.mig_dry_reports WHERE company_id = $1', [A.companyId]);
    process.env.MIGRATION_DRY3_REPORT_PATH = '/dev/null/nao-existe/dry3-report.json';
    const aborted = await env.runDry3(A);
    assert.deepEqual([aborted.status, aborted.conclusion], ['ABORTED', null]);
    assert.equal(aborted.errors[0].phase, 'ORCHESTRATOR');
  } finally { s.dispose(); }
});
