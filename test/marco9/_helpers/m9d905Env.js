'use strict';

// Apoio dos testes M9-D905 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const env = require('./m9d901Env');
const verifier = require('../../../src/features/migration-v2/integrity/batch.verify');
const verifyJob = require('../../../src/features/migration-v2/integrity/verify.job');

const { openTenantTx, q } = env;

/** Fonte CDC de PERSON com n pessoas válidas (nomes com acento), aplicadas num lote. Devolve { legacy, batch, records }. */
async function appliedPersons(tenant, n = 6, { entity = 'PERSON' } = {}) {
  const legacy = await env.installSource(tenant, { entity });
  for (let i = 1; i <= n; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord({ legalName: `João da Silva ${i} ${env.suffix()}` }));
  await env.run(tenant, { sourceSystem: legacy.system, entity });
  const [batch] = await env.batchesOf(legacy.system);
  return { legacy, batch, records: await env.recordsOf(legacy.system) };
}

/** Fonte de imóveis com n imóveis válidos aplicados num lote (WATERMARK não é preciso: o fake CDC serve). */
async function appliedProperties(tenant, n = 4) {
  const legacy = await env.installSource(tenant, { entity: 'PROPERTY' });
  for (let i = 1; i <= n; i += 1) {
    legacy.fake.event(`${i}`, 'I', i, { internalCode: `M9D905-${env.suffix()}`, title: `Imóvel ${i}`, propertyType: 'RESIDENTIAL', areaTotalM2: 80.5, bedrooms: 2, parkingSpots: 1, city: 'Natal' });
  }
  await env.run(tenant, { sourceSystem: legacy.system, entity: 'PROPERTY' });
  const [batch] = await env.batchesOf(legacy.system);
  return { legacy, batch, records: await env.recordsOf(legacy.system) };
}

const verify = (tenant, batchId) => openTenantTx(tenant, (tx) => verifier.verifyBatch(tenant, { userId: tenant.userId }, batchId, tx));
const verifyPending = (tenant) => verifyJob.verifyPending(tenant, { userId: tenant.userId });
const batchRow = async (id) => (await q('SELECT * FROM governance.mig_batches WHERE id = $1', [id]))[0];
const leavesOf = (batchId) => q('SELECT * FROM governance.mig_batch_leaves WHERE batch_id = $1 ORDER BY source_key', [batchId]);
const stateCounts = async (system) => Object.fromEntries((await q('SELECT state, count(*)::int AS n FROM governance.mig_records WHERE source_system = $1 GROUP BY state', [system])).map((r) => [r.state, r.n]));

module.exports = { ...env, appliedPersons, appliedProperties, verify, verifyPending, batchRow, leavesOf, stateCounts };
