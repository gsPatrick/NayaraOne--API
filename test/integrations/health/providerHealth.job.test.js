'use strict';

// Marco 9, M9-D206 — job de agregação (COMMITA dados: só em banco descartável).
//   node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 test/integrations/health/providerHealth.job.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { IntegrationConnection } = require('../../../src/models');
const health = require('../../../src/features/integrations/health');
const { runIntegrationHealthAggregateJob } = require('../../../src/engines/jobs/integrationHealthAggregateJob');

let tenant;
let connectionId;

before(async () => {
  tenant = await getSeedTenant();
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    const c = await IntegrationConnection.create({
      groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'financing-manual', environment: 'HOMOLOG',
      label: `QA-M9 job ${uniqueSuffix()}`, status: 'ACTIVE',
    }, { transaction: t });
    connectionId = c.id;
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

after(async () => {
  health.resetHealthSampleSources();
  if (connectionId && process.env.DATABASE_ADMIN_URL) {
    const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
    await admin.query('DELETE FROM integration.provider_health WHERE connection_id = :id', { replacements: { id: connectionId } });
    await admin.query('DELETE FROM integration.connections WHERE id = :id', { replacements: { id: connectionId } });
    await admin.close();
  }
  await sequelize.close();
});

const contar = () => sequelize.transaction(async (t) => {
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  const [r] = await sequelize.query('SELECT count(*)::int AS n FROM integration.provider_health WHERE connection_id = :id', { replacements: { id: connectionId }, transaction: t, type: sequelize.QueryTypes.SELECT });
  return r.n;
});

test('health_job_grava_janelas_e_respeita_o_intervalo_da_empresa', async () => {
  health.registerHealthSampleSource(async () => ({ calls: [{ ok: true, latencyMs: 80 }], lastSampleAt: new Date() }));
  const primeira = await runIntegrationHealthAggregateJob({ now: new Date() });
  assert.ok(primeira.companies >= 1);
  assert.ok(primeira.processed >= 1);
  assert.equal(primeira.errors, 0);
  assert.equal(await contar(), 4);
  // segunda rodada logo em seguida: a empresa ainda está dentro do intervalo (padrão 60 s) e nada é regravado
  const segunda = await runIntegrationHealthAggregateJob({ now: new Date(Date.now() + 5000) });
  assert.equal(segunda.processed, 0);
  // depois do intervalo roda de novo e não duplica as janelas
  const terceira = await runIntegrationHealthAggregateJob({ now: new Date(Date.now() + 61000) });
  assert.ok(terceira.processed >= 1);
  assert.ok((await contar()) >= 4 && (await contar()) <= 8, 'no máximo as janelas novas do bucket seguinte');
});
