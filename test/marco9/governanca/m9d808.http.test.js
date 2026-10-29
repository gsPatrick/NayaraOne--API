'use strict';

// M9-D808 — POST|GET /data-quality/bulk-changes pela API real (banco descartável): permissão, tentativa auditada, Idempotency-Key, MFA e isolamento.
// Nunca chama endpoint de MFA: o que se prova é a recusa MFA_* sem verificação recente (o lote real exige o código digitado pelo operador).
process.env.PORT = process.env.M9D808_HTTP_TEST_PORT || '21658';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d808Env');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');
const bulk = require('../../../src/features/core-governance/data-quality/bulk.service');

const READ = 'governance:data-quality:read';
const GRANTS = { 'CI GESTOR': [READ, 'governance:data-quality:manage', 'governance:data-quality:bulk'], 'CI LEITURA': [READ] };
let http;
before(async () => { http = await startHttp({ port: process.env.PORT, grants: GRANTS, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } }); });
after(async () => { await stopHttp(GRANTS); });

const postBulk = (who, body, key) => http.call(who, 'POST', '/data-quality/bulk-changes', body, key ? { 'Idempotency-Key': key } : {});

test('m9d808 bulk master data sem permissão bloqueia: 403, nada gravado e a tentativa fica auditada', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const { tenants } = http;
  const { city, rows } = await withTenantTransaction(tenants.A, (tx) => env.properties(tenants.A, tx, 2));
  const denied = await postBulk('leituraA', env.bulkBody(city, { city: 'Nao Pode QA' }), env.key());
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.body.error.details.required, 'governance:data-quality:bulk');
  assert.equal(await env.cityOf(rows[0].id), city);
  const { rows: lots } = await adminQuery('SELECT 1 FROM governance.bulk_changes WHERE company_id = $1 AND filter_json->>\'city\' = $2', [tenants.A.companyId, city]);
  assert.equal(lots.length, 0);
  const { rows: audits } = await adminQuery("SELECT user_id, after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.bulk_change.blocked' AND after_json->>'code' = 'PERMISSION_DENIED' ORDER BY occurred_at DESC LIMIT 1", [tenants.A.companyId]);
  assert.equal(audits.length, 1, 'bloqueio auditado');
  assert.equal(audits[0].after_json.required, 'governance:data-quality:bulk');
  assert.ok(audits[0].user_id, 'com o autor da tentativa');
  const readList = await http.call('leituraA', 'GET', '/data-quality/bulk-changes');
  assert.deepEqual([readList.status, readList.body.error.code], [403, 'PERMISSION_DENIED']);
});

test('m9d808 criar lote sem Idempotency-Key devolve 400 GOV_IDEMPOTENCY_KEY_REQUIRED', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const { city, rows } = await withTenantTransaction(http.tenants.A, (tx) => env.properties(http.tenants.A, tx, 1));
  const res = await postBulk('gestorA', env.bulkBody(city, { city: 'Sem Chave QA' }));
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.']);
  assert.equal(await env.cityOf(rows[0].id), city);
});

test('m9d808 o lote exige MFA recente (linha 9 da M9-D852) e nada é gravado sem ele', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const { city, rows } = await withTenantTransaction(http.tenants.A, (tx) => env.properties(http.tenants.A, tx, 2));
  const res = await postBulk('gestorA', env.bulkBody(city, { city: 'Sem MFA QA' }), env.key());
  assert.equal(res.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(res.body.error.code), res.body.error.code);
  assert.equal(await env.cityOf(rows[0].id), city);
});

test('m9d808 /impact (sem gravar) e GET do lote: 200 do dono, 404 da outra empresa, 400 de filtro inválido', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const { tenants } = http;
  const { city } = await withTenantTransaction(tenants.A, (tx) => env.properties(tenants.A, tx, 3));
  const impact = await http.call('gestorA', 'POST', '/data-quality/bulk-changes/impact', env.bulkBody(city, { city: 'Simulado QA' }));
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.deepEqual(impact.body.data.counts, { records: 3, willChange: 3, byRecordType: { PROPERTY: 3 } });
  assert.deepEqual([impact.body.data.totalAmountCents, impact.body.data.blockers], [0, []]);
  const badFilter = await http.call('gestorA', 'POST', '/data-quality/bulk-changes/impact', env.bulkBody(city, { city: 'X' }, { filter: "1=1" }));
  assert.deepEqual([badFilter.status, badFilter.body.error.code, badFilter.body.error.message], [400, 'GOV_BULK_FILTER_INVALID', 'Filtro inválido.']);
  // O lote em si é criado pelo serviço (a rota exige o código de MFA digitado); a consulta é pela API.
  const done = await withTenantTransaction(tenants.A, (tx) => bulk.executeBulk(tenants.A, { userId: tenants.A.userId, roles: [] }, env.bulkBody(city, { city: 'Lote Http QA' }), { idempotencyKey: env.key() }, tx));
  const detail = await http.call('gestorA', 'GET', `/data-quality/bulk-changes/${done.lot.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual([detail.body.data.lot.status, detail.body.data.lot.affectedCount, detail.body.data.items.length], ['DONE', 3, 3]);
  assert.equal(JSON.stringify(detail.body.data.items).includes('Lote Http QA'), false, 'o claro não vai nos itens');
  assert.deepEqual(detail.body.data.lot.patch, { city: 'Lote Http QA' }, 'o lote guarda o patch pedido');
  const list = await http.call('gestorA', 'GET', '/data-quality/bulk-changes?pageSize=5');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((l) => l.id === done.lot.id));
  const other = await http.call('gestorB', 'GET', `/data-quality/bulk-changes/${done.lot.id}`);
  assert.deepEqual([other.status, other.body.error.code, other.body.error.message], [404, 'GOV_NOT_FOUND', 'Registro não encontrado.']);
  const bad = await http.call('gestorA', 'GET', '/data-quality/bulk-changes/nao-e-uuid');
  assert.equal(bad.status, 404);
});
