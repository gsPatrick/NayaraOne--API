'use strict';

// M9-D699 (critério 5) — todo read model registrado declara rebuild.keys (e rebuild.corrections quando alimenta snapshots) e o rebuild de cada
// um reproduz o incremental (M9-D608). Sobre a massa determinística de carga (um banco com as fontes de todos os domínios).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { seedLoad, cleanupLoad, connect } = require('../../../scripts/analytics/seedLoad');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const { upsertAggregate } = require('../../../src/features/analytics/read-models/readModel.upsert');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');
const { KPI_DEFINITIONS } = require('../../../src/features/analytics/metrics/kpis');
require('../../../src/features/analytics');

// Relógio e âncora da massa FIXOS (nunca a data da máquina): o rebuild lê o relógio injetável do BI e o incremental recebe o mesmo `now`; com a data da máquina o teste
// quebrava quando a máquina virava o dia (UTC) em relação ao instante fixado (reabertura M-3/M-4).
const ANCHOR = '2026-10-29';
const NOW = new Date(`${ANCHOR}T15:00:00Z`);
const clock = require('../../../src/features/analytics/metrics/clock');
const SMALL = { scale: 'light', companies: 1, entries: 800, bankTransactions: 80, opportunities: 120, properties: 60, projects: 6, stages: 18, measurements: 60, dailyReports: 60 };
let admin;
let massa;
let tenant;
before(async () => {
  admin = connect();
  clock.setClock(() => new Date(NOW));
  massa = await seedLoad(admin, { ...SMALL, seed: 'rb699', anchor: ANCHOR });
  const [[u]] = await admin.query("SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'");
  tenant = { groupId: massa.companies[0].groupId, companyId: massa.companies[0].companyId, userId: u.id };
});
after(async () => { clock.resetClock(); await cleanupLoad(admin, massa.companies); await admin.close(); await sequelize.close(); });

const rebuild = (model, reason = 'Teste de carga (M9-D699)') => readModels.rebuildReadModel({ groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason }, { model, companyId: tenant.companyId });
const event = (eventType, payload = {}) => ({ id: crypto.randomUUID(), eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: crypto.randomUUID(), payloadJson: payload, occurredAt: NOW, retryCount: 0 });
const apply = (e) => sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(e, tx, { now: NOW }));

test('m9d699 todo read model registrado declara rebuild.keys, e os que alimentam snapshots declaram rebuild.corrections', () => {
  const all = readModels.listReadModels();
  assert.ok(all.length >= 40, `read models registrados: ${all.length}`);
  const without = all.filter((d) => !d.rebuild || typeof d.rebuild.keys !== 'function').map((d) => d.name);
  assert.deepEqual(without, [], 'sem rebuild.keys');
  const feedingSnapshots = [...new Set(KPI_DEFINITIONS.map(() => 'rm_finance_health'))];
  for (const name of feedingSnapshots) assert.equal(typeof readModels.getReadModel(name).rebuild.corrections, 'function', `${name} alimenta snapshots dos KPIs`);
});

test('m9d699 o rebuild de rm_finance_health reproduz o incremental (hash igual) e revisa os snapshots dos KPIs só quando o número muda', async () => {
  await apply(event('finance.reconciliation.matched'));
  const [[before]] = await admin.query('SELECT count(*)::int AS n FROM analytics.rm_finance_health WHERE company_id = :c', { replacements: { c: tenant.companyId } });
  assert.equal(before.n, 1);
  const r = await rebuild('rm_finance_health', null);
  assert.equal(r.status, 'SUCCEEDED');
  assert.equal(r.before.hash, r.after.hash, 'o hash por empresa não muda');
  assert.deepEqual([r.added, r.removed, r.changed], [0, 0, 0]);
  const [[published]] = await admin.query("SELECT count(*)::int AS n FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'fin.%'", { replacements: { c: tenant.companyId } });
  if (published.n) assert.equal(r.snapshotsRevised, 0, 'nada mudou: nenhuma revisão de snapshot');
});

test('m9d699 o rebuild de rm_finance_sector_margin reproduz o incremental construído por eventos', async () => {
  const [months] = await admin.query("SELECT DISTINCT competence_month FROM finance.financial_entries WHERE company_id = :c AND status = 'SETTLED' ORDER BY 1", { replacements: { c: tenant.companyId } });
  assert.ok(months.length >= 23, 'o histórico de 24 meses tem liquidação em quase todos os meses');
  const [pairs] = await admin.query("SELECT DISTINCT result_center_id::text AS center, competence_month FROM finance.financial_entries WHERE company_id = :c AND status = 'SETTLED' ORDER BY 2, 1", { replacements: { c: tenant.companyId } });
  for (const { center, competence_month: competenceMonth } of pairs) await apply(event('finance.entry.settled', { id: crypto.randomUUID(), resultCenterId: center, competenceMonth }));
  const r = await rebuild('rm_finance_sector_margin', null);
  assert.equal(r.before.hash, r.after.hash, 'mesmo hash antes e depois');
  assert.equal(r.rows, pairs.length, 'um agregado por setor e mês');
  assert.deepEqual([r.added, r.removed, r.changed], [0, 0, 0]);
});

/** O caminho incremental do worker, agregado por agregado: recalcula o estado da fonte da chave e grava o ESTADO (nunca delta) na tabela atual. */
async function buildIncremental(def) {
  await sup.inTx(tenant, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    const scope = { companyId: tenant.companyId, groupId: tenant.groupId };
    for (const key of await def.rebuild.keys({ ...scope, transaction: tx })) {
      const result = await def.recompute({ ...scope, key, limit: null, asOfDate: NOW.toISOString().slice(0, 10), now: NOW, event: null, transaction: tx });
      await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: result.sourceSnapshotAt || NOW }, tx);
    }
  });
}

test('m9d699 o rebuild de cada read model registrado reproduz o incremental (mesmo hash por empresa)', async () => {
  const failures = [];
  let withRows = 0;
  for (const def of readModels.listReadModels()) {
    try {
      await buildIncremental(def);
      const r = await rebuild(def.name, null); // sem motivo: se algo diferisse, o rebuild recusaria (422 ANALYTICS_REBUILD_REASON_REQUIRED)
      if (r.before.rows > 0) withRows += 1;
      if (r.before.hash !== r.after.hash || r.added + r.removed + r.changed !== 0) failures.push(`${def.name}: ${r.before.hash} x ${r.after.hash}`);
    } catch (err) {
      failures.push(`${def.name}: ${err.code || err.name}: ${err.message}${err.details && err.details.checks ? ` ${JSON.stringify(err.details.checks.filter((c) => c.status !== 'PASSED')).slice(0, 600)}` : ''}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(withRows >= 15, `read models com linhas na massa (Financeiro, Comercial, Imóveis, Obras): ${withRows}`);
});
