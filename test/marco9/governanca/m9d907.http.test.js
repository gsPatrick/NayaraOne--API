'use strict';

// M9-D907 — rotas do plano de rollback pela API real: permissão governance:migration:admin, PUT com 422 do livro, decisão do GO, relatório, resolução com 409 e o parâmetro de página.
// Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D907_HTTP_TEST_PORT || '21907';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d907Env');
const http = require('../_helpers/m9d806Http');

const ADMIN = 'governance:migration:admin';
const RUN = 'governance:migration:run';
let h; let A;
const call = (who, method, path, body) => h.call(who, method, path, body);

async function grant(role, codes) {
  await env.adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', [role, [ADMIN, RUN]]);
  if (codes.length) {
    await env.adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
  }
}

before(async () => {
  await grant('CI GESTOR', [ADMIN, RUN]);
  await grant('CI LEITURA', [RUN]);
  h = await http.startHttp({ port: process.env.PORT, grants: {}, logins: { gestor: ['A', 'gestor'], leitura: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  await env.cleanup(A);
});
afterEach(async () => { if (h && !h.skip) await env.cleanup(A); });
after(async () => { if (h && !h.skip) { await grant('CI GESTOR', []); await grant('CI LEITURA', []); await env.cleanup(A); } await http.stopHttp({}); });

test('m9d907 as cinco rotas exigem governance:migration:admin (403 com a mensagem do livro)', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const paths = [['GET', '/migration/external-ops'], ['PUT', '/migration/external-ops', { types: [] }], ['POST', '/migration/cutover/decision', { decision: 'GO' }], ['GET', '/migration/rollback-report'],
    ['POST', '/migration/rollback-items/00000000-0000-4000-8000-000000000907/resolve', {}]];
  for (const [method, path, body] of paths) {
    const res = await call('leitura', method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual([res.body.error.code, res.body.error.message], ['PERMISSION_DENIED', `Permissão ausente: ${ADMIN}.`]);
  }
  assert.equal((await env.adminQuery('SELECT 1 FROM governance.external_op_types WHERE company_id = $1', [A.companyId])).rows.length, 0, 'nada foi semeado nem gravado');
});

test('m9d907 PUT /migration/external-ops: 422 com a mensagem do livro e, depois, grava e lista', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const bad = await call('gestor', 'PUT', '/migration/external-ops', { types: [env.goodType('QA907_X', { compensation: '' })] });
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [422, 'GOV_ROLLBACK_COMPENSATION_REQUIRED', 'Defina o procedimento de compensação deste tipo de operação.']);
  assert.ok(bad.body.error.traceId);
  const ok = await call('gestor', 'PUT', '/migration/external-ops', { types: [env.goodType('QA907_X', { operations: ['qa907Http'] })] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const list = await call('gestor', 'GET', '/migration/external-ops');
  assert.ok(list.body.data.types.some((x) => x.code === 'QA907_X' && x.owner === 'QA-M9') && list.body.data.types.length === 9);
});

test('m9d907 decisão do GO, relatório com paginação e resolução com 409 pela API; o parâmetro define a página', async (t) => {
  if (h.skip) return t.skip(h.skip);
  assert.equal((await call('gestor', 'POST', '/migration/cutover/decision', { decision: 'x' })).body.error.code, 'GOV_CUTOVER_DECISION_INVALID');
  await env.markRollbackSimulated(A); // M9-D908: o GO pela API exige a simulação de rollback do DRY3
  const go = await call('gestor', 'POST', '/migration/cutover/decision', { decision: 'GO', reason: 'Ensaio.' });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.ok(go.body.data.t0);
  await env.adminQuery("UPDATE governance.external_op_types SET entity = 'QA907_ENTITY' WHERE company_id = $1 AND code = 'PAYMENT_SENT'", [A.companyId]);
  for (let i = 0; i < 5; i += 1) await env.record(A, { operation: 'submitPayment', reference: `http-${i}`, amountCents: 100, dangerous: true });
  await env.setParam(A, 'migracao.rollback.itens_por_pagina', 2);
  const rep = await call('gestor', 'GET', '/migration/rollback-report?type=PAYMENT_SENT&page=3');
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual([rep.body.data.groups[0].count, rep.body.data.items.pageSize, rep.body.data.items.rows.length, rep.body.data.items.page], [5, 2, 1, 3]);
  await env.addSectorUsers(A, 'ATENDIMENTO', 20);
  await env.setEntities(A, 'ATENDIMENTO', ['QA907_ENTITY']);
  await env.setParam(A, 'migracao.canary.exigir_comparacao', false);
  await env.advance(A, 'ATENDIMENTO');
  await env.rollback(A, 'ATENDIMENTO', { reason: 'Ensaio.' });
  const first = (await call('gestor', 'GET', '/migration/rollback-report?type=PAYMENT_SENT')).body.data.items.rows[0];
  const path = `/migration/rollback-items/${first.itemId}/resolve`;
  const ok = await call('gestor', 'POST', path, { note: 'Estorno pedido.', compensationRef: 'EST-9' });
  assert.deepEqual([ok.status, ok.body.data.state], [200, 'COMPENSATED']);
  const again = await call('gestor', 'POST', path, {});
  assert.deepEqual([again.status, again.body.error.code, again.body.error.message], [409, 'GOV_ROLLBACK_ITEM_FINAL', 'Este item de rollback já foi resolvido.']);
  const none = await call('gestor', 'POST', '/migration/rollback-items/00000000-0000-4000-8000-000000000907/resolve', {});
  assert.deepEqual([none.status, none.body.error.code], [404, 'GOV_NOT_FOUND']);
  assert.equal((await call('gestorB', 'POST', path, {})).status, 404, 'a outra empresa não enxerga o item');
});
