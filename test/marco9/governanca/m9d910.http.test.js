'use strict';

// M9-D910 — GET|PUT /data-classification pela API real (banco descartável): leitura com a permissão dos stewards, alteração só com governance:classification:manage, as recusas do livro,
// o filtro por classificação e a paginação. Evidência do critério "GET /data-classification".
process.env.PORT = process.env.M9D910_HTTP_TEST_PORT || '21910';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d910Env');
const http = require('../_helpers/m9d806Http');

const MANAGE = 'governance:classification:manage';
const GRANTS = { 'CI GESTOR': ['governance:data-quality:read', MANAGE], 'CI LEITURA': ['governance:data-quality:read'] };
let h;
let A;
before(async () => {
  h = await http.startHttp({ port: process.env.PORT, grants: GRANTS, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  for (const t of Object.values(h.tenants)) { await env.resetRetention(t); await env.ensure(t); }
});
after(async () => {
  if (!h.skip) {
    for (const t of Object.values(h.tenants)) await env.resetRetention(t);
    await env.adminQuery("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = $1", [MANAGE]);
  }
  await http.stopHttp(GRANTS);
});
const call = (who, method, path, body) => h.call(who, method, path, body);
const COL = { schema: 'people', table: 'persons', column: 'preferred_name' };

test('m9d910 GET /data-classification filtra por classificação, schema e tabela, pagina e devolve os atributos do livro', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const all = await call('leituraA', 'GET', '/data-classification?schema=people&table=persons&pageSize=5');
  assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 300));
  assert.equal(all.body.data.length, 5);
  assert.ok(all.body.pagination.total >= 10 && all.body.pagination.pageSize === 5);
  const row = all.body.data[0];
  for (const key of ['schema', 'table', 'column', 'classification', 'purpose', 'retentionPolicyId', 'masking', 'exportability', 'aiAllowed', 'ownerDomain']) assert.ok(key in row, key);
  const restricted = await call('leituraA', 'GET', '/data-classification?classification=RESTRICTED&pageSize=200');
  assert.equal(restricted.status, 200);
  assert.ok(restricted.body.data.length > 0 && restricted.body.data.every((r) => r.classification === 'RESTRICTED'));
  assert.ok(restricted.body.data.some((r) => r.table === 'persons' && r.column === 'tax_id_normalized'));
  const bad = await call('leituraA', 'GET', '/data-classification?classification=SECRETO');
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'VALIDATION_ERROR']);
  const page = await call('leituraA', 'GET', '/data-classification?pageSize=999');
  assert.equal(page.status, 400, 'pageSize acima do máximo é recusado');
});

test('m9d910 PUT /data-classification: sem governance:classification:manage é 403 (nada muda); com ele altera, audita e recusa política ausente e coluna inexistente', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const before = await env.rowOf(A, COL.schema, COL.table, COL.column);
  const denied = await call('leituraA', 'PUT', '/data-classification', { ...COL, classification: 'RESTRICTED' });
  assert.equal(denied.status, 403);
  assert.deepEqual([denied.body.error.code, denied.body.error.details.required], ['PERMISSION_DENIED', MANAGE]);
  assert.equal((await env.rowOf(A, COL.schema, COL.table, COL.column)).version, before.version);
  const noPolicy = await call('gestorA', 'PUT', '/data-classification', { ...COL, retention_policy_id: null });
  assert.deepEqual([noPolicy.status, noPolicy.body.error.code, noPolicy.body.error.message], [422, 'GOV_CLASS_RETENTION_REQUIRED', 'Informe a política de retenção.']);
  const missing = await call('gestorA', 'PUT', '/data-classification', { schema: 'people', table: 'persons', column: 'nao_existe_qa', classification: 'LOW' });
  assert.deepEqual([missing.status, missing.body.error.code, missing.body.error.message], [404, 'GOV_NOT_FOUND', 'Coluna não encontrada.']);
  const ok = await call('gestorA', 'PUT', '/data-classification', { ...COL, classification: 'RESTRICTED', masking: 'FULL', mask_pattern: null });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.deepEqual([ok.body.data.classification, ok.body.data.source, ok.body.meta.changed], ['RESTRICTED', 'MANUAL', true]);
  const again = await call('gestorA', 'PUT', '/data-classification', { ...COL, classification: 'RESTRICTED' });
  assert.equal(again.body.meta.changed, false, 'PUT igual não altera nada');
  const otherCompany = await call('gestorB', 'GET', `/data-classification?schema=${COL.schema}&table=${COL.table}&pageSize=200`);
  const sameColumn = otherCompany.body.data.find((r) => r.column === COL.column);
  assert.equal(sameColumn.source, 'AUTO', 'o ajuste da empresa A não aparece na B');
  const review = await call('leituraA', 'GET', '/data-classification/legacy-review');
  assert.equal(review.status, 200);
  assert.ok(Array.isArray(review.body.data));
  await env.put(A, { ...COL, classification: before.classification, masking: before.masking, mask_pattern: before.mask_pattern });
});
