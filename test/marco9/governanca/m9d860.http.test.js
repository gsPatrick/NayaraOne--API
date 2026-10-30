'use strict';

// M9-D860 — GET /finops/health com as duas séries separadas (banco descartável com API real).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d860.http.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, teardownEnv, call } = require('../../helpers/m9d800Env');
const env = require('../_helpers/m9d860Env');
const ledger = require('../../../src/features/core-governance/finops/ledger.service');

let httpSkip;
before(async () => { ({ httpSkip } = await setupEnv()); });
after(async () => { await teardownEnv(); });

test('m9d860 GET /finops/health devolve estimado e faturado separados, sem total misto', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const tenants = await env.loadTenants();
  const day = new Date().toISOString().slice(0, 10);
  const { sequelize } = env;
  const tx = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenants.A.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenants.A.companyId }, transaction: tx });
    await ledger.recordLines(tenants.A, [
      env.dayLine(tenants.A, day, { service: 'http-e', sourceRef: env.uniq(), amountCents: 300 }),
      env.dayLine(tenants.A, day, { service: 'http-b', costKind: 'BILLED', sourceRef: env.uniq(), amountCents: 700 }),
    ], tx);
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; }
  try {
    const sem = await call(null, 'GET', '/finops/health');
    assert.equal(sem.status, 401);
    const denied = await call('A:leitura', 'GET', '/finops/health');
    assert.equal(denied.status, 403);
    const ok = await call('A:gestor', 'GET', '/finops/health');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const { custos, coletores } = ok.body.data;
    assert.ok(custos.estimado.totalCents >= 300 && custos.faturado.totalCents >= 700);
    assert.deepEqual(Object.keys(custos).filter((k) => /total/i.test(k)), []);
    assert.ok(Array.isArray(coletores));
  } finally {
    await env.adminQuery('DELETE FROM governance.cost_read_model WHERE group_id = $1', [tenants.A.groupId]);
    await env.adminQuery('DELETE FROM governance.cost_ledger WHERE group_id = $1', [tenants.A.groupId]);
  }
});
