'use strict';

// M9-D609 — o job analyticsSnapshotJob percorre as empresas, respeita a hora configurada e não reprocessa o dia concluído; as chaves de
// parâmetro estão no dicionário de configurações e as tabelas novas respeitam o isolamento por empresa. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d609Env');
const providers = require('../../../src/features/analytics/metrics/snapshots.providers');
const { runAnalyticsSnapshotJob } = require('../../../src/engines/jobs/analyticsSnapshotJob');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

let env;
let off;
let metric;

before(async () => {
  env = await e.setup();
  metric = await e.publish(env, env.tenantA);
  off = providers.registerSnapshotProvider({
    name: 'm9d609-job', metricCodes: [metric.code],
    async build(sc, asOfDate) {
      return [{ code: metric.code, inputs: [{
        metricId: metric.definition.id, metricVersionId: metric.version.id, companyId: sc.companyId, groupId: sc.groupId, scopeType: 'COMPANY', scopeId: sc.companyId,
        periodStart: asOfDate, periodEnd: asOfDate, asOfDate, valueNumeric: '3.0000', status: 'OK', sourceSnapshotAt: `${asOfDate}T22:00:00Z`,
        sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: e.sha(asOfDate), filterSignature: 'assinatura', count: 1 }], calcHash: e.sha(`job${asOfDate}`),
      }] }];
    },
  });
});
after(async () => { off(); await e.teardown(env); });

test('m9d609 o job percorre as empresas, respeita a hora e não reprocessa o dia concluído', async () => {
  const early = await runAnalyticsSnapshotJob({ now: new Date('2026-10-30T03:20:00Z'), force: false });
  assert.equal(early.snapshots, 0, '00:20 em São Paulo: antes das 00:30');
  const first = await runAnalyticsSnapshotJob({ now: new Date('2026-10-30T03:31:00Z'), force: true });
  assert.ok(first.companies >= 1 && first.snapshots >= 1, JSON.stringify(first));
  assert.equal(first.errors, 0);
  const again = await runAnalyticsSnapshotJob({ now: new Date('2026-10-30T04:00:00Z') });
  assert.equal(again.snapshots, 0, 'o dia concluído não volta a ser processado');
  const [rows] = await env.admin.query(
    "SELECT count(*)::int AS n FROM analytics.metric_snapshots WHERE metric_id = :id AND as_of_date = '2026-10-29'", { replacements: { id: metric.definition.id } });
  assert.equal(rows[0].n, 1);
});

test('m9d609 diário do job tem isolamento por empresa e as chaves de parâmetro existem no dicionário', async () => {
  const count = (viewer, owner) => e.sup.inTx(viewer, {}, (tx) => e.sup.sequelize.query(
    'SELECT count(*)::int AS n FROM analytics.snapshot_job_runs WHERE company_id = :c', { replacements: { c: owner.companyId }, transaction: tx }));
  assert.ok((await count(env.tenantA, env.tenantA))[0][0].n >= 1);
  assert.equal((await count(env.tenantB, env.tenantA))[0][0].n, 0, 'a empresa B não vê o diário da A');
  for (const key of ['analytics.snapshot.hora_execucao', 'analytics.snapshot.dias_retroativos_max', 'analytics.freshness.fator_expirado', 'analytics.freshness.max_minutos.FINANCE', 'analytics.freshness.max_minutos.TECH_AI']) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} está em SETTINGS_SCHEMA`);
  }
  assert.throws(() => SETTINGS_SCHEMA['analytics.snapshot.hora_execucao'].validate('analytics.snapshot.hora_execucao', '25:99'), /HH:MM/);
});
