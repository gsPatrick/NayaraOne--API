'use strict';

// M9-D712 (reabertura) — a semente publica a versão 1 com o catálogo REAL de fórmulas do código (sem catálogo injetado): as métricas cuja
// fórmula já existe saem PUBLISHED v1, a convenção do id é o código do indicador com a versão no campo `version` (não `<código>.v1`).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env712 = require('../_helpers/m9d712Env');
const seed = require('../../../src/features/analytics/metrics/seed');
const { getFormulaCatalog } = require('../../../src/features/analytics/metrics/formulaCatalog');

let env;
before(async () => { env = await env712.setup(); });
after(() => env712.teardown(env));

const inTx = (fn) => env712.inTx(env.tenantA, { writer: false }, async (tx) => {
  await env712.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
  return fn(tx);
});

test('m9d712 a semente usa o id da fórmula do catálogo real: o código do indicador, com a versão no campo version', () => {
  const real = getFormulaCatalog();
  for (const row of seed.listCriticalityRows()) {
    assert.equal(row.formulaId, row.code, `${row.code}: a tabela aponta o id do catálogo (sem sufixo .v1)`);
    if (real.has(row.formulaId)) assert.equal(real.get(row.formulaId).version, 1, `${row.code}: fórmula entregue é a versão 1`);
  }
});

test('m9d712 com o catálogo real, fin.reconciliations_pending e fin.anomalies_open (M9-D624) saem PUBLISHED v1 com criticidade e value_nature', async () => {
  await inTx(async (tx) => {
    const codes = ['fin.reconciliations_pending', 'fin.anomalies_open'];
    const rows = seed.listCriticalityRows().filter((r) => codes.includes(r.code));
    assert.equal(rows.length, 2);
    const out = await seed.seedMetricRegistry(env712.GLOBAL_CTX, tx, { rows, now: env712.todayMinus(10) }); // sem `catalog`: usa o catálogo real
    assert.deepEqual(out.pending, [], JSON.stringify(out.pending));
    assert.deepEqual([...out.published].sort(), [...codes].sort());
    const [got] = await env712.sequelize.query(
      `SELECT d.metric_code, d.status, d.criticality, d.drilldown_enabled, v.version, v.value_nature, v.formula_id
         FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
        WHERE d.company_id IS NULL AND d.group_id IS NULL AND d.metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open') ORDER BY d.metric_code`, { transaction: tx }
    );
    assert.deepEqual(got.map((r) => [r.metric_code, r.status, r.version, r.criticality, r.drilldown_enabled, r.value_nature, r.formula_id]), [
      ['fin.anomalies_open', 'PUBLISHED', 1, 'CRITICAL', true, 'ACTUAL', 'fin.anomalies_open'],
      ['fin.reconciliations_pending', 'PUBLISHED', 1, 'NORMAL', false, 'ACTUAL', 'fin.reconciliations_pending'],
    ]);
    const again = await seed.seedMetricRegistry(env712.GLOBAL_CTX, tx, { rows, now: env712.todayMinus(10) });
    assert.deepEqual([again.published.length, again.existing.length], [0, 2], 'idempotente com o catálogo real');
  });
});

test('m9d712 com o catálogo real, as métricas ainda sem fórmula ficam pendentes nomeando a demanda dona', async () => {
  await inTx(async (tx) => {
    const real = getFormulaCatalog();
    const rows = seed.listCriticalityRows().filter((r) => !real.has(r.formulaId)).slice(0, 3);
    if (!rows.length) return; // todas as fórmulas já foram entregues
    const out = await seed.seedMetricRegistry(env712.GLOBAL_CTX, tx, { rows, now: env712.todayMinus(10) });
    assert.equal(out.published.length, 0);
    assert.equal(out.pending.length, rows.length);
    assert.match(out.pending[0].reason, /ainda não existe no código \(M9-D\d+\)/);
  });
});
