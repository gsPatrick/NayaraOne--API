'use strict';

// ACHADO REAL (auditoria adversarial pós-DoD, Frente 8 — Validação/Casos extremos): o módulo
// `correspondent` (Marco 8) tinha 14 arquivos de teste, mas NENHUM batia HTTP real contra o
// Express app (auth real via JWT + requirePermission real + errorHandler real) — todos chamavam
// o service direto. Isso nunca provou que: (a) `requirePermission` de fato bloqueia quem não tem
// a permissão certa, (b) um UUID malformado na URL vira 400 amigável (não 500 cru do Postgres),
// (c) um valor numérico maior que a precisão da coluna DECIMAL vira 400 amigável (mesma classe de
// bug já corrigida globalmente no Marco 7, mas nunca testada especificamente para este módulo).
// Mesmo padrão de `test/construction.httpRoutes.test.js`.

process.env.PORT = process.env.CORRESPONDENT_HTTP_TEST_PORT || '34592';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../app');
const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Person, FinancingCase, File, ExternalCaseRouting } = require('../src/models');

let tenant;
let baseUrl;
let token;
let tokenNoCreate;
let tokenNoDocumentsRead;
const createdCaseIds = [];
const createdPersonIds = [];
const createdFileIds = [];

before(async () => {
  tenant = await getSeedTenant();

  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['correspondent:create', 'correspondent:read', 'correspondent:documents:read', 'correspondent:fiscal'],
  });

  // GAP real de permissão: nunca houve prova HTTP de que correspondent:create é exigido de
  // verdade (lido no código-fonte das rotas, nunca testado).
  tokenNoCreate = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['viewer'],
    permissions: ['correspondent:read'],
  });

  // GAP real de permissão (ponto crítico do Caderno — "corretor não lê extrato/renda de outro
  // caso sem permissão"): nunca houve prova HTTP de que correspondent:read SEM
  // correspondent:documents:read de fato filtra o array `documents`.
  tokenNoDocumentsRead = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['broker'],
    permissions: ['correspondent:create', 'correspondent:read'],
  });

  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (createdCaseIds.length > 0) {
    await FinancingCase.destroy({ where: { id: createdCaseIds }, force: true });
  }
  if (createdPersonIds.length > 0) {
    await Person.destroy({ where: { id: createdPersonIds }, force: true });
  }
  if (createdFileIds.length > 0) {
    await File.destroy({ where: { id: createdFileIds }, force: true });
  }
  if (createdCaseIds.length > 0) {
    await ExternalCaseRouting.destroy({ where: { financingCaseId: createdCaseIds }, force: true }).catch(() => {});
  }
  await sequelize.close();
  process.exit(0);
});

function authFetch(bearerToken, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearerToken}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createPrincipal() {
  const principal = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return Person.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `HTTP Proponente ${uniqueSuffix()}`,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
  });
  createdPersonIds.push(principal.id);
  return principal;
}

test('CORRESPONDENT-HTTP-01: criar caso sem correspondent:create é bloqueado com 403, não 500', async () => {
  const res = await authFetch(tokenNoCreate, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [{ personId: '00000000-0000-0000-0000-000000000000', role: 'PRINCIPAL' }],
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(!/sequelize|postgres|internal/i.test(body.error?.message || ''), 'mensagem não deve vazar termo técnico');
});

test('CORRESPONDENT-HTTP-02: GET com UUID malformado na URL vira 400 amigável, nunca 500 cru', async () => {
  const res = await authFetch(token, 'GET', '/financing-cases/nao-e-um-uuid-valido');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(!/invalid input syntax|postgres|sequelizedatabaseerror/i.test(body.error?.message || ''), 'não deve vazar erro cru do Postgres');
});

test('CORRESPONDENT-HTTP-03: criar caso de verdade via HTTP real (201/200), persiste e aparece no GET', async () => {
  const principal = await createPrincipal();
  const res = await authFetch(token, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const caseId = body.data.id;
  createdCaseIds.push(caseId);

  const getRes = await authFetch(token, 'GET', `/financing-cases/${caseId}`);
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.data.id, caseId);
  assert.equal(getBody.data.status, 'DRAFT');
});

test('CORRESPONDENT-HTTP-04: valor de simulação absurdamente alto é bloqueado com erro de negócio limpo (gate de elegibilidade), nunca erro técnico cru', async () => {
  const principal = await createPrincipal();
  const createRes = await authFetch(token, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
  });
  const { data: createdCase } = await createRes.json();
  createdCaseIds.push(createdCase.id);

  // DECIMAL(14,2) comporta no máximo 12 dígitos inteiros — 10^13 estouraria a coluna se chegasse
  // até o banco. Na prática o gate de elegibilidade (Fase 4) bloqueia antes disso com 422, o que
  // é o comportamento correto (mais específico que um 400 genérico). O que importa aqui é que o
  // valor NUNCA chega a virar um erro técnico cru do Postgres pro usuário final.
  const res = await authFetch(token, 'POST', `/financing-cases/${createdCase.id}/simulations`, {
    amount: 99999999999999,
    termMonths: 360,
  });
  assert.ok(res.status >= 400 && res.status < 500, `esperava 4xx, recebeu ${res.status}`);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(!/numeric field overflow|sequelizedatabaseerror/i.test(body.error?.message || ''), 'não deve vazar erro cru do Postgres');
  assert.equal(body.error.code, 'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT');
});

test('CORRESPONDENT-HTTP-05: criar caso sem proponente retorna mensagem específica em português via HTTP real', async () => {
  const res = await authFetch(token, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [],
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /proponente/i);
});

test('CORRESPONDENT-HTTP-06: documento RESTRICTED só aparece pra quem tem correspondent:documents:read, via HTTP real', async () => {
  const principal = await createPrincipal();
  const createRes = await authFetch(token, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
  });
  const { data: createdCase } = await createRes.json();
  createdCaseIds.push(createdCase.id);

  const reqRes = await authFetch(token, 'POST', `/financing-cases/${createdCase.id}/requirements`, {
    documentType: 'RG_CPF',
  });
  const { data: requirement } = await reqRes.json();

  const file = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: `http-doc-${uniqueSuffix()}.pdf`,
        mimeType: 'application/pdf',
        storageKey: `test/${uniqueSuffix()}.pdf`,
        sizeBytes: 10,
      },
      { transaction }
    );
  });
  createdFileIds.push(file.id);

  const uploadRes = await authFetch(token, 'POST', `/financing-cases/${createdCase.id}/documents`, {
    requirementId: requirement.id,
    fileId: file.id,
  });
  assert.equal(uploadRes.status, 201, `upload falhou: ${JSON.stringify(await uploadRes.json())}`);

  // Com a permissão: documents vem preenchido.
  const withRes = await authFetch(token, 'GET', `/financing-cases/${createdCase.id}/requirements`);
  const withBody = await withRes.json();
  const withReq = withBody.data.find((r) => r.id === requirement.id);
  assert.ok(Array.isArray(withReq.documents) && withReq.documents.length > 0, 'com a permissão, documents deveria vir preenchido');

  // SEM a permissão: status/tipo continua visível, mas documents vem vazio — nunca vaza.
  const withoutRes = await authFetch(tokenNoDocumentsRead, 'GET', `/financing-cases/${createdCase.id}/requirements`);
  assert.equal(withoutRes.status, 200);
  const withoutBody = await withoutRes.json();
  const withoutReq = withoutBody.data.find((r) => r.id === requirement.id);
  assert.equal(withoutReq.documentType, 'RG_CPF', 'status/tipo do requirement continua visível sem a permissão');
  assert.ok(Array.isArray(withoutReq.documents) && withoutReq.documents.length === 0, 'sem a permissão, documents precisa vir vazio — nunca vazar fileId/metadado');
});

test('CORRESPONDENT-HTTP-07: webhook público com assinatura inválida é rejeitado via HTTP real, pra um externalCaseId que existe de verdade', async () => {
  // Precisa de um ExternalCaseRouting real: senão o fluxo responde "unknown_routing" (200) ANTES
  // de checar a assinatura — correto do ponto de vista de segurança (não revela se o caso
  // existe), mas isso significa que testar a rejeição de assinatura de verdade exige montar o
  // roteamento primeiro, senão o teste nunca exercita a checagem de HMAC de verdade.
  const principal = await createPrincipal();
  const createRes = await authFetch(token, 'POST', '/financing-cases', {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
  });
  const { data: createdCase } = await createRes.json();
  createdCaseIds.push(createdCase.id);

  const externalCaseId = `http-webhook-real-${uniqueSuffix()}`;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await ExternalCaseRouting.create(
      { externalCaseId, financingCaseId: createdCase.id, providerCode: 'sandbox', groupId: tenant.groupId, companyId: tenant.companyId },
      { transaction }
    );
  });

  const payload = JSON.stringify({ externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' });
  const res = await fetch(`${baseUrl}/correspondent/webhooks/financing/sandbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'assinatura-forjada-nao-bate' },
    body: payload,
  });
  assert.equal(res.status, 401, `esperava 401, recebeu ${res.status}`);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'CORRESPONDENT_WEBHOOK_HMAC_INVALID');
  assert.ok(!/stack|sequelizedatabaseerror|internal server/i.test(JSON.stringify(body)), 'não deve vazar erro técnico cru');
});

test('CORRESPONDENT-HTTP-08: corpo JSON malformado não derruba a rota com erro técnico cru', async () => {
  const res = await fetch(`${baseUrl}/financing-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{ isso não é json válido',
  });
  assert.ok(res.status >= 400 && res.status < 500, `esperava 4xx, recebeu ${res.status}`);
  const text = await res.text();
  assert.ok(!/at JSON\.parse|SyntaxError|\/Users\//i.test(text), `não deve vazar stack/caminho de arquivo: ${text.slice(0, 300)}`);
});
