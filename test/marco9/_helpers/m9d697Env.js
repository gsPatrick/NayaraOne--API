'use strict';

// Apoio dos testes da M9-D697 (KPI degradado sem valor enganoso): reaproveita o ambiente da M9-D609 (métrica publicada, snapshot e relógio) e
// grava resultados de check de qualidade para a métrica. Banco descartável (127.0.0.1).
const env609 = require('./m9d609Env');
const { sequelize } = require('../../testHelpers');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');
const { recordQualityCheck } = require('../../../src/features/analytics/dataQualityCheckStore.service');
const sourceRefs = require('../../../src/features/analytics/metrics/sourceRefs');

const { sup } = env609;
const NOW = '2026-10-29T15:00:00Z'; // 12:00 em São Paulo
const TODAY = '2026-10-29';
const minutesAgo = (n) => new Date(new Date(NOW).getTime() - n * 60000).toISOString();

async function setup() {
  const env = await env609.setup();
  env.model = `rm_m9d697_${sup.sfx()}`;
  env.specs = [];
  env609.at(NOW);
  return env;
}

/** Métrica publicada com snapshot FRESH de hoje (valor 100) e o status gravado informado. */
async function freshMetric(env, tenant, { status = 'OK', value = '100.0000', ageMinutes = 5, prefix = 'fin' } = {}) {
  const m = await env609.publish(env, tenant, { prefix });
  await env609.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(ageMinutes), refreshedAt: minutesAgo(1), status, value });
  return m;
}

/** Resultado de uma execução do check (linha em data_quality_checks) que afeta as métricas informadas. */
function recordCheck(tenant, { checkCode = 'recon_saldo', metrics, status = 'FAILED', severity = 'CRITICAL', executedAt = NOW, readModel }) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    return recordQualityCheck({
      companyId: tenant.companyId, groupId: tenant.groupId, checkCode, readModel: readModel || 'rm_m9d697_x', checkType: 'RECONCILIATION', status,
      severity: status === 'PASSED' ? 'INFO' : severity, affectedMetricCodes: metrics, executedAt, observed: { diff: '12.50' }, expected: { diff: '0.00' },
    }, tenant, tx);
  });
}

/** KPI composto (components[]) registrado na origem; devolve o código. */
function registerComposite(env, code, components) {
  sourceRefs.registerSourceSpec({ metricCode: code, components });
  env.specs.push(code);
}

async function teardown(env) {
  for (const code of env.specs) sourceRefs.unregisterSourceSpec(code);
  const companies = [env.tenantA.companyId, env.tenantB.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query("DELETE FROM analytics.data_quality_checks WHERE company_id IN (:c) AND (read_model LIKE 'rm_m9d697%')", { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type LIKE 'analytics.quality.%' AND payload_json->>'readModel' LIKE 'rm_m9d697%'", { transaction });
  });
  await env609.teardown(env);
}

const inTx = sup.inTx;
module.exports = { ...env609, setup, teardown, freshMetric, recordCheck, registerComposite, inTx, NOW, TODAY, minutesAgo, sequelize };
