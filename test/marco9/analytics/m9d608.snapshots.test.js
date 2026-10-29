'use strict';

// M9-D608 (3.4) — o rebuild nunca apaga metric_snapshots: valor corrigido do passado vira NOVA revisão (revision_no + 1, recalculated = true).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env608 = require('../_helpers/m9d608Env');
const sup = require('../../analytics.m9d603.support');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');

const { addSource, applyCommitted, ctxFor } = env608;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
let env;
let catalog;
let metricCode;

before(async () => {
  env = await env608.setup();
  catalog = registry.createFormulaCatalog(env.formulaDir);
  await addSource(env, env.tenantA, 'caixa', '1000.00');
  await applyCommitted(env, env.tenantA, 'caixa');
});
after(async () => {
  if (metricCode) {
    await env.admin.transaction(async (transaction) => {
      await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
      const ids = '(SELECT id FROM analytics.metric_definitions WHERE metric_code = :code)';
      await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE metric_id IN ${ids}`, { replacements: { code: metricCode }, transaction });
      await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN ${ids}`, { replacements: { code: metricCode }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_definitions WHERE metric_code = :code', { replacements: { code: metricCode }, transaction });
    });
  }
  await env608.teardown(env);
});

const snapshotsOf = async (metricId) => (await env.admin.query(
  'SELECT revision_no, recalculated, value_numeric::text AS value, calc_hash FROM analytics.metric_snapshots WHERE metric_id = :id ORDER BY as_of_date, revision_no', { replacements: { id: metricId } }
))[0];

test('m9d608 snapshots antigos preservados e novo marcado recalculated', async () => {
  const pub = await env608.inTx(env.tenantA, { commit: true }, async (tx) => {
    const published = await registry.publishMetric(sup.metricInput(env, { sourceReadModel: env.model }), sup.ctxOf(env.tenantA), tx, { catalog });
    return published;
  });
  metricCode = pub.definition.metric_code;
  const base = {
    groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, metricId: pub.definition.id, metricVersionId: pub.version.id, scopeType: 'COMPANY',
    scopeId: env.tenantA.companyId, periodStart: '2026-09-01', periodEnd: '2026-09-30', asOfDate: '2026-09-30', status: 'OK',
  };
  const old = { ...base, valueNumeric: '120000', calcHash: sha('v1') };
  await env608.inTx(env.tenantA, { commit: true }, async (tx) => { await sup.metrics.enableAnalyticsWriter(tx); await sup.metrics.recordSnapshot(old, tx); });
  const antes = await snapshotsOf(pub.definition.id);
  assert.equal(antes.length, 1);

  // o rebuild corrige o valor do passado: 119.000 em vez de 120.000
  env.corrections.push({ ...base, valueNumeric: '119000', calcHash: sha('v2') });
  const result = await readModels.rebuildReadModel(ctxFor(env.tenantA, { reason: 'Lançamento de origem corrigido' }), { model: env.model, companyId: env.tenantA.companyId });
  assert.equal(result.snapshotsRevised, 1);
  const depois = await snapshotsOf(pub.definition.id);
  assert.equal(depois.length, 2, 'o snapshot antigo continua lá e entra uma linha nova');
  assert.deepEqual(depois[0], antes[0], 'a linha antiga não foi tocada');
  assert.deepEqual([depois[1].revision_no, depois[1].recalculated, depois[1].value, depois[1].calc_hash], [2, true, '119000.0000', sha('v2')], 'revision_no + 1 e recalculated = true, sem violar o UNIQUE');
  const [[refresh]] = await env.admin.query(`SELECT rebuild_reason, rebuild_diff FROM analytics.read_model_refreshes WHERE id = :id`, { replacements: { id: result.refreshId } });
  assert.equal(refresh.rebuild_reason, 'Lançamento de origem corrigido', 'o histórico registra o motivo');
  assert.equal(refresh.rebuild_diff.snapshotsRevised, 1);

  // mesmo valor de novo: nada novo (idempotente); valor igual com data-base sem snapshot anterior: nada a corrigir
  env.corrections.push({ ...base, valueNumeric: '119000', calcHash: sha('v2') });
  env.corrections.push({ ...base, asOfDate: '2026-08-31', periodEnd: '2026-08-31', periodStart: '2026-08-01', valueNumeric: '5', calcHash: sha('v3') });
  const again = await readModels.rebuildReadModel(ctxFor(env.tenantA), { model: env.model, companyId: env.tenantA.companyId });
  assert.equal(again.snapshotsRevised, 0);
  assert.equal((await snapshotsOf(pub.definition.id)).length, 2);

  // e a leitura por data devolve a revisão mais nova, com a trilha completa preservada
  const read = await env608.inTx(env.tenantA, {}, (tx) => registry.readMetricAsOf(sup.ctxOf(env.tenantA, ['analytics:read']), { metricCode, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-09-30' }, tx));
  assert.deepEqual([read.revisionNo, read.value], [2, '119000.0000']);
});
