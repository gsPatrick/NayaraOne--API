'use strict';

// M9-D862 — os achados abertos aparecem em GET /finops/health (com a permissão certa e isolados por grupo) depois de o job do detector rodar (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d862.http.test.js"

process.env.PORT = process.env.M9D862_HTTP_TEST_PORT || '21862';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d861Http');
const env = require('../_helpers/m9d862Env');
const { runDetectorJob } = require('../../../src/engines/jobs/finopsDetectorsJob');
const { byCode } = require('../../../src/features/core-governance/finops/detectors/run');

before(async () => { await http.start(); });
after(async () => {
  if (http.state.tenants) {
    await http.adminQuery("DELETE FROM integration.outbox_events WHERE event_type = 'qa.fila'");
    await http.adminQuery('DELETE FROM governance.finops_findings WHERE company_id = ANY($1::uuid[])', [[http.state.tenants.A.companyId, http.state.tenants.B.companyId]]);
  }
  await http.stop();
});

async function commitOutbox(tenant, n) {
  const tx = await env.sequelize.transaction();
  try {
    await env.sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction: tx });
    await env.outbox(tenant, tx, n);
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
}

test('m9d862 findings abertos saem em GET /finops/health e cada empresa vê só os seus', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A, B } = http.state.tenants;
  const [{ n: resto }] = await env.withRollbackTenantTransaction(A, (tx) => env.q(tx, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE company_id = :c AND status = 'PENDING'", { c: A.companyId })); // resto de outros arquivos no mesmo banco
  await commitOutbox(A, 6200);
  const result = await runDetectorJob(byCode('QUEUE_BACKLOG'), env.NOW, { force: true });
  assert.equal(result.errors, 0, JSON.stringify(result));
  assert.equal((await http.call(null, 'GET', '/finops/health')).status, 401);
  const denied = await http.call('A:leitura', 'GET', '/finops/health');
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  const ok = await http.call('A:gestor', 'GET', '/finops/health');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const queue = ok.body.data.achados.find((a) => a.detector === 'QUEUE_BACKLOG');
  assert.ok(queue, 'o achado da fila aparece');
  assert.deepEqual([queue.assunto, queue.situacao, queue.desperdicioEstimadoCentavos, queue.evidencia.pendentes], ['outbox', 'OPEN', 0, resto + 6200]);
  assert.ok(ok.body.data.detectores.some((d) => d.detector === 'queue_backlog' && d.situacao === 'OK'), 'a execução do detector aparece');
  assert.ok(!ok.body.data.coletores.some((c) => String(c.coletor).startsWith('det_')), 'os coletores de custo não misturam detectores');
  const other = await http.call('B:gestor', 'GET', '/finops/health');
  assert.equal(other.status, 200);
  assert.ok(!other.body.data.achados.some((a) => a.detector === 'QUEUE_BACKLOG'), 'o grupo B não vê o achado do A');
  assert.ok(B.companyId !== A.companyId);
});
