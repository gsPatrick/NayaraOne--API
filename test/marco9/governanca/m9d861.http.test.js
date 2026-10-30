'use strict';

// M9-D861 — POST/PATCH/GET /finops/budgets e o health pela API real, com permissão e isolamento entre grupos (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d861.http.test.js"

process.env.PORT = process.env.M9D861_HTTP_TEST_PORT || '21861';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d861Http');

// Orçamentos têm escopo único por grupo e este arquivo grava de verdade (HTTP): limpa os dos dois grupos antes e depois para não colidir com outros arquivos nem deixar resto.
async function clean() {
  if (!http.state.tenants) return;
  const groups = [http.state.tenants.A.groupId, http.state.tenants.B.groupId];
  await http.adminQuery('DELETE FROM governance.budget_alerts WHERE budget_id IN (SELECT id FROM governance.budgets WHERE group_id = ANY($1::uuid[]))', [groups]);
  await http.adminQuery('DELETE FROM governance.budgets WHERE group_id = ANY($1::uuid[])', [groups]);
}
before(async () => { await http.start(); await clean(); });
after(async () => { await clean(); await http.stop(); });
const skipReason = () => http.state.skip;

test('m9d861 cadastro e alteração de orçamento pela API, com os erros do livro', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  assert.equal((await http.call(null, 'POST', '/finops/budgets', {})).status, 401);
  assert.equal((await http.call('A:leitura', 'POST', '/finops/budgets', {})).status, 403);
  const bad = await http.call('A:gestor', 'POST', '/finops/budgets', { amountCents: 0, ownerUserId: A.userId });
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [422, 'GOV_BUDGET_AMOUNT_INVALID', 'O orçamento deve ser maior que zero.']);
  const noOwner = await http.call('A:gestor', 'POST', '/finops/budgets', { amountCents: 1000 });
  assert.deepEqual([noOwner.status, noOwner.body.error.code], [422, 'GOV_BUDGET_OWNER_REQUIRED']);
  const ok = await http.call('A:gestor', 'POST', '/finops/budgets', { environment: 'DEV', domain: 'PLATFORM', amountCents: 500000, ownerUserId: A.userId });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.environment, ok.body.data.valorCentavos, ok.body.data.percentual], ['DEV', 500000, 0]);
  const dup = await http.call('A:gestor', 'POST', '/finops/budgets', { environment: 'DEV', amountCents: 1000, ownerUserId: A.userId });
  assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.message], [409, 'GOV_BUDGET_DUPLICATE', 'Já existe orçamento para este escopo.']);
  const patched = await http.call('A:gestor', 'PATCH', `/finops/budgets/${ok.body.data.id}`, { amountCents: 600000 });
  assert.deepEqual([patched.status, patched.body.data.valorCentavos], [200, 600000]);
  assert.equal((await http.call('A:gestor', 'PATCH', `/finops/budgets/${ok.body.data.id}`, { amountCents: -1 })).status, 422);
  assert.equal((await http.call('A:gestor', 'PATCH', '/finops/budgets/nao-e-uuid', { amountCents: 10 })).status, 404);
  const health = await http.call('A:gestor', 'GET', '/finops/health');
  const mine = health.body.data.orcamentos.find((b) => b.id === ok.body.data.id);
  assert.ok(mine && mine.consumo.estimado && mine.consumo.faturado && mine.limiares.length === 4, 'o health traz o orçamento com as duas séries');
});

test('m9d861 isolamento entre grupos', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const mineA = await http.call('A:gestor', 'POST', '/finops/budgets', { environment: 'HOMOLOG', amountCents: 100000, ownerUserId: A.userId });
  assert.equal(mineA.status, 201, JSON.stringify(mineA.body));
  const listB = await http.call('B:gestor', 'GET', '/finops/budgets');
  assert.equal(listB.status, 200);
  assert.ok(!listB.body.data.some((b) => b.id === mineA.body.data.id), 'o grupo B não vê o orçamento do A');
  assert.equal((await http.call('B:gestor', 'PATCH', `/finops/budgets/${mineA.body.data.id}`, { amountCents: 1 })).status, 404);
  const asOwnerB = await http.call('B:gestor', 'POST', '/finops/budgets', { environment: 'HOMOLOG', amountCents: 100000, ownerUserId: A.userId });
  assert.equal(asOwnerB.body.error.code, 'GOV_BUDGET_OWNER_INVALID', 'o responsável precisa ser da própria empresa');
});
