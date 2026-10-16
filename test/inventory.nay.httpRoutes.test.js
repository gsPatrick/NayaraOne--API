'use strict';

// Rotas HTTP reais da NAY Estoque e do OCR de NF (mesmo padrão de
// construction.httpRoutes.test.js: app real numa porta alternativa + JWT real + middleware de
// tenant real + RLS real). Só chamadas que NÃO persistem nada (leituras e caminhos de erro, cuja
// transação por request é revertida) — o fluxo com escrita já é coberto pelos testes de service
// com rollback (inventory.nay.test.js / inventory.receiptOcr.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.INVENTORY_NAY_HTTP_TEST_PORT || '34613';

require('../app');
const { sequelize, getSeedTenant } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');

let baseUrl;
let tokenInventoryOnly;
let tokenWithProcurement;

before(async () => {
  const tenant = await getSeedTenant();
  const base = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  tokenInventoryOnly = signAccessToken({ ...base, permissions: ['inventory:read', 'inventory:create'] });
  tokenWithProcurement = signAccessToken({ ...base, permissions: ['inventory:read', 'inventory:create', 'procurement:create'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

function call(method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('HTTP NAY: listar sugestões e anomalias responde com o envelope padrão (leitura pura)', async () => {
  const suggestions = await call('GET', '/inventory/nay/purchase-suggestions', tokenInventoryOnly);
  assert.equal(suggestions.status, 200);
  const sBody = await suggestions.json();
  assert.equal(sBody.success, true);
  assert.ok(Array.isArray(sBody.data));

  const anomalies = await call('GET', '/inventory/nay/loss-case-anomalies?windowDays=30', tokenInventoryOnly);
  assert.equal(anomalies.status, 200);
  const aBody = await anomalies.json();
  assert.equal(aBody.data.financialEffect, 'NONE');
  assert.deepEqual(aBody.data.decisionsMade, []);
  assert.equal(aBody.data.parameters.windowDays, 30);
});

test('HTTP NAY: aprovar sugestão (abrir compra) exige procurement:create — inventory sozinho não basta', async () => {
  const id = '00000000-0000-0000-0000-000000000000';
  const denied = await call('POST', `/inventory/nay/purchase-suggestions/${id}/approve`, tokenInventoryOnly, {});
  assert.equal(denied.status, 403);

  const allowed = await call('POST', `/inventory/nay/purchase-suggestions/${id}/approve`, tokenWithProcurement, {});
  assert.equal(allowed.status, 404);
  const body = await allowed.json();
  assert.equal(body.error.code, 'INVENTORY_NAY_SUGGESTION_NOT_FOUND');
});

test('HTTP NAY: rotas exigem autenticação', async () => {
  const res = await call('GET', '/inventory/nay/purchase-suggestions', null);
  assert.equal(res.status, 401);
});

test('HTTP OCR NF: rota montada e validações de arquivo aplicadas', async () => {
  const empty = await call('POST', '/inventory/receipts/ocr-suggestions', tokenInventoryOnly, { fileName: 'nf.pdf', mimeType: 'application/pdf' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'INVENTORY_RECEIPT_OCR_VALIDATION');

  const html = await call('POST', '/inventory/receipts/ocr-suggestions', tokenInventoryOnly, {
    fileName: 'nf.html',
    mimeType: 'text/html',
    contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
  });
  assert.equal(html.status, 400);
  assert.equal((await html.json()).error.code, 'FILE_UPLOAD_TYPE_NOT_ALLOWED');
});
