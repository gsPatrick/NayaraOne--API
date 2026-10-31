'use strict';

// M9-D904 §3.3 — o avanço também exige a última comparação paralela (M9-D903) limpa: concluída, sem DIFF_BLOCKER e nunca uma execução que falhou. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');
const { ENTITY, comparisonScenario } = require('../_helpers/m9d904Cmp');
const targets = require('../../../src/features/migration-v2/ingest/targets');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

const setup = async (entity = ENTITY) => { await env.addSectorUsers(A, 'CORRESPONDENTE', 4); await env.setEntities(A, 'CORRESPONDENTE', [entity]); };

test('m9d904 sem nenhuma comparação da entidade migrável o avanço espera; com o parâmetro desligado segue', { skip: skip() }, async () => {
  const restore = targets.overrideTarget('QA904_CMP', { entityType: 'QA904_CMP', canonical: (r) => r, readCanonical: async () => new Map() });
  try {
    await setup('QA904_CMP');
    const err = await env.fail(env.advance(A, 'CORRESPONDENTE'));
    assert.deepEqual([err.status, err.code, err.message], [409, 'GOV_CANARY_COMPARISON_PENDING', 'A última comparação paralela deste setor não está limpa.']);
    assert.deepEqual(err.details.problems, [{ entity: 'QA904_CMP', reason: 'NO_COMPARISON' }]);
    assert.equal(await env.percentOf(A, 'CORRESPONDENTE'), 0);
    await env.setParam(A, 'migracao.canary.exigir_comparacao', false);
    assert.equal((await env.advance(A, 'CORRESPONDENTE')).percent, 5, 'desligado o parâmetro, a ausência de comparação não impede');
  } finally { restore(); }
});

test('m9d904 comparação limpa libera; diferença bloqueante trava pela Torre e libera quando a execução seguinte a fecha', { skip: skip() }, async () => {
  await setup();
  const s = await comparisonScenario(A);
  try {
    const id = await s.pair('c-1', 'Contrato A', 'Contrato B');
    await s.pair('c-2', 'Contrato A', 'Contrato A');
    assert.equal((await env.fail(env.advance(A, 'CORRESPONDENTE'))).code, 'GOV_CANARY_COMPARISON_PENDING', 'janela ainda não iniciada: nenhuma comparação terminada');
    assert.equal((await env.tick(A, s.window.id, env.T0)).action, 'COMPLETED');
    const blocked = await env.fail(env.advance(A, 'CORRESPONDENTE'));
    assert.deepEqual([blocked.status, blocked.code], [409, 'GOV_CANARY_BLOCKERS_OPEN']);
    assert.ok(blocked.details.blockers.some((b) => b.code === 'GOV_PARALLEL_DIFF_BLOCKER' && b.entity === ENTITY));
    s.store.set(id, { name: 'Contrato A' });
    assert.equal((await env.tick(A, s.window.id, env.minutes(61))).action, 'COMPLETED');
    const ok = await env.advance(A, 'CORRESPONDENTE');
    assert.deepEqual([ok.previousPercent, ok.percent], [0, 5]);
  } finally { await s.dispose(); }
});

test('m9d904 comparação cuja última execução falhou nunca conta como limpa', { skip: skip() }, async () => {
  await setup();
  const s = await comparisonScenario(A);
  try {
    await s.pair('c-1', 'Contrato A', 'Contrato A');
    await env.tick(A, s.window.id, env.T0);
    await env.adminQuery(
      `INSERT INTO governance.parallel_runs (group_id, company_id, window_id, run_number, status, error_code, started_at, finished_at)
       SELECT $1, $2, $3, COALESCE(MAX(run_number), 0) + 1, 'FAILED', 'GOV_PARALLEL_SOURCE_DOWN', now(), now() FROM governance.parallel_runs WHERE window_id = $3`,
      [A.groupId, A.companyId, s.window.id]
    );
    const err = await env.fail(env.advance(A, 'CORRESPONDENTE'));
    assert.equal(err.code, 'GOV_CANARY_COMPARISON_PENDING');
    assert.equal(err.details.problems[0].reason, 'LAST_RUN_FAILED');
    assert.equal(await env.percentOf(A, 'CORRESPONDENTE'), 0);
  } finally { await s.dispose(); }
});

test('m9d904 comparação de outra entidade não pesa sobre o setor', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'CORRESPONDENTE', 4);
  await env.setEntities(A, 'CORRESPONDENTE', ['QA904_SEM_DESTINO']);
  const s = await comparisonScenario(A);
  try {
    await s.pair('c-1', 'Contrato A', 'Contrato B');
    await env.tick(A, s.window.id, env.T0);
    assert.equal((await env.advance(A, 'CORRESPONDENTE')).percent, 5, 'a diferença é de outra entidade, que não é deste setor');
  } finally { await s.dispose(); }
});
