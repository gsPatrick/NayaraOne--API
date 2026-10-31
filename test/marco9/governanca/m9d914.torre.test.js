'use strict';

// M9-D914 — com banco: as seis áreas obrigatórias semeadas pelo carregador da M9-D810 (a visão de cobertura da API inclui a migração) e cada número da Torre de controle
// (M9-D901) tem a métrica correspondente no registro. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const lineageEnv = require('../_helpers/m9d810Env');
const env = require('../_helpers/m9d901Env');
const service = require('../../../src/features/core-governance/lineage/lineage.service');
const seed = require('../../../src/features/core-governance/lineage/lineage.seed');
const { MANDATORY_AREAS } = require('../../../src/features/core-governance/lineage/lineage.constants');
const { METRICS, EXPORTS } = require('../../../src/features/core-governance/lineage/kit/migrationCatalog');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d914 as seis áreas obrigatórias estão semeadas e a cobertura da API inclui a migração em 100%', { skip: skip() }, async () => {
  await lineageEnv.withRollbackTenantTransaction(tenants.A, async (tx) => {
    await seed.ensureSeeded(tenants.A, tx);
    const registry = await service.loadRegistry(tenants.A, tx);
    const areas = new Set(registry.nodes.filter((n) => ['METRIC', 'EXPORT'].includes(n.nodeType)).map((n) => n.area));
    for (const area of MANDATORY_AREAS) assert.ok(areas.has(area), `área ${area} semeada`);
    const overview = await service.getOverview(tenants.A, tx);
    assert.deepEqual(overview.cobertura.uncovered, []);
    assert.equal(overview.cobertura.percent, 100);
    const migration = registry.nodes.filter((n) => n.area === 'MIGRATION' && ['METRIC', 'EXPORT'].includes(n.nodeType)).map((n) => n.code).sort();
    assert.deepEqual(migration, [...METRICS.map((m) => m.code), ...EXPORTS.map((e) => e.code)].sort());
    assert.ok(registry.nodes.every((n) => n.ownerDomain && n.description), 'nenhum nó sem responsável ou descrição');
  });
});

test('m9d914 métricas da Torre estão registradas como críticas: cada número da Torre tem a sua', { skip: skip() }, async () => {
  const A = tenants.A;
  const legacy = await env.installSource(A, { entity: 'PERSON' });
  await env.seedRecords(A, legacy.system, 'PERSON', { MIGRATED: 2, RECONCILED: 1, QUARANTINED: 1, PENDING_REVIEW: 1 });
  const tower = await env.getTower(A, await env.newRun(A, legacy.system, 'PERSON'));
  // o que a Torre devolve -> a métrica que o registra
  const byMetric = { MIG_TOTAL: tower.totals.total, MIG_MIGRATED: tower.totals.migrated, MIG_QUARANTINED: tower.totals.quarantined, MIG_PENDING_REVIEW: tower.totals.pending_review, MIG_RECONCILED: tower.totals.reconciled, MIG_ETA: tower.eta, MIG_BLOCKERS: tower.blockers };
  assert.deepEqual(Object.keys(byMetric).sort(), METRICS.map((m) => m.code).sort(), 'toda métrica registrada é um número da Torre e vice-versa');
  for (const [code, value] of Object.entries(byMetric)) assert.notEqual(value, undefined, `${code} existe na resposta da Torre`);
  assert.deepEqual([tower.totals.total, tower.totals.migrated, tower.totals.reconciled, tower.totals.quarantined, tower.totals.pending_review], [5, 3, 1, 1, 1]);
  legacy.dispose();
});
