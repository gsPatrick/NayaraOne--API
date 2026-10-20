'use strict';
// Revisão 19/10/2026 — D1 (POST /files ignora groupId/companyId do corpo) e B1 (webhook de
// assinatura sandbox exige hash do documento e é recusado em produção).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { emailFor } = require('../scripts/seed-ci-two-tenants');
const { sequelize, User } = require('../src/models');
const { assertSandboxWebhookAllowed } = require('../src/features/legal/legal.controller');

process.env.PORT = process.env.M45_SEC_HTTP_TEST_PORT || '21611';
let skipReason = null;
let appLoaded = false;
let baseUrl;
const tokens = {};

before(async () => {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente — seed de dois tenants só existe no CI/reprodução.'; return; }
  if (!(await User.findOne({ where: { email: emailFor('A', 'maker') } }))) { skipReason = 'Seed de dois tenants não encontrado.'; return; }
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 300));
  for (const k of ['A', 'B']) {
    const res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(k, 'maker'), password }) });
    tokens[k] = (await res.json()).data.accessToken;
  }
});
after(async () => { await sequelize.close().catch(() => {}); if (appLoaded) process.exit(0); });

test('D1: POST /files com groupId/companyId do tenant B no corpo grava no tenant do token (A)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const claimsA = JSON.parse(Buffer.from(tokens.A.split('.')[1], 'base64').toString());
  const claimsB = JSON.parse(Buffer.from(tokens.B.split('.')[1], 'base64').toString());
  assert.notEqual(claimsA.companyId, claimsB.companyId);
  const res = await fetch(`${baseUrl}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.A}` },
    body: JSON.stringify({ groupId: claimsB.groupId, companyId: claimsB.companyId, fileName: 'd1.txt', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 d1 fictício').toString('base64'), category: 'documents' }),
  });
  const body = await res.json();
  if (res.status === 403) return assert.equal(body.error.code, 'PERMISSION_DENIED'); // maker sem permissão de arquivo: já bloqueado
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.data.companyId, claimsA.companyId);
  assert.equal(body.data.groupId, claimsA.groupId);
  assert.notEqual(body.data.companyId, claimsB.companyId);
});

test('B1: webhook sandbox sem hash do documento é recusado (400 LEGAL_WEBHOOK_HASH_REQUIRED)', () => {
  assert.throws(() => assertSandboxWebhookAllowed({}, {}), (e) => e.code === 'LEGAL_WEBHOOK_HASH_REQUIRED' && e.statusCode === 400);
  assert.throws(() => assertSandboxWebhookAllowed(undefined, {}), (e) => e.code === 'LEGAL_WEBHOOK_HASH_REQUIRED');
  assert.doesNotThrow(() => assertSandboxWebhookAllowed({ contentHash: 'abc' }, {}));
  assert.doesNotThrow(() => assertSandboxWebhookAllowed({ documentHash: 'abc' }, { DEPLOY_ENVIRONMENT: 'homologacao' }));
});

test('B1: webhook sandbox é recusado com DEPLOY_ENVIRONMENT=production mesmo com hash (403)', () => {
  assert.throws(() => assertSandboxWebhookAllowed({ contentHash: 'abc' }, { DEPLOY_ENVIRONMENT: 'production' }), (e) => e.code === 'LEGAL_SANDBOX_WEBHOOK_FORBIDDEN_IN_PRODUCTION' && e.statusCode === 403);
});
