'use strict';

// Rotas HTTP da régua de cobrança (REG-LOC-004): RBAC real (JWT + requirePermission), 400 de
// payload/filtro inválido e sucesso. Nada é gravado no banco compartilhado: os GETs só leem e o
// POST de sucesso troca a escrita do service por um stub que roda a validação REAL
// (validateCadenceSteps) — a publicação em si já é coberta por billing.collectionCadence.test.js
// dentro de transação com rollback.

process.env.PORT = process.env.CADENCE_HTTP_TEST_PORT || '21617';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../app'); // eslint-disable-line no-unused-vars
const { sequelize, getSeedTenant } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const cadenceService = require('../src/features/billing/collectionCadence.service');

let tenant;
let baseUrl;
let tokenRead;
let tokenManage;
let tokenNone;
const originalPublish = cadenceService.publishCadenceRuleVersionAudited;
let publishCalls = 0;

before(async () => {
  tenant = await getSeedTenant();
  const base = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId };
  tokenRead = signAccessToken({ ...base, roles: ['viewer'], permissions: ['billing:read'] });
  tokenManage = signAccessToken({ ...base, roles: ['admin'], permissions: ['billing:read', 'billing:cadence:manage'] });
  tokenNone = signAccessToken({ ...base, roles: ['viewer'], permissions: ['crm:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;

  cadenceService.publishCadenceRuleVersionAudited = async (groupId, companyId, steps) => {
    const normalized = cadenceService.validateCadenceSteps(steps);
    publishCalls += 1;
    return { id: '00000000-0000-0000-0000-000000000001', versionNumber: 99, status: 'PUBLISHED', isCurrent: true, steps: normalized, groupId, companyId };
  };
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  cadenceService.publishCadenceRuleVersionAudited = originalPublish;
  await sequelize.close();
  process.exit(0);
});

function call(token, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const VALID_STEPS = [
  { code: 'NOTICE_D2', offsetDays: 2, action: 'NOTIFY' },
  { code: 'REMINDER_D-2', offsetDays: -2, action: 'NOTIFY' },
  { code: 'TASK_D10', offsetDays: 10, action: 'TASK' },
];

test('CAD-HTTP-01: sem billing:read → 403 na régua e nas etapas', async () => {
  assert.equal((await call(tokenNone, 'GET', '/billing/collection-cadence')).status, 403);
  assert.equal((await call(tokenNone, 'GET', '/billing/collection-cadence/steps')).status, 403);
});

test('CAD-HTTP-02: só billing:read não publica (403, service não chamado)', async () => {
  const before = publishCalls;
  const res = await call(tokenRead, 'POST', '/billing/collection-cadence/versions', { steps: VALID_STEPS });
  assert.equal(res.status, 403);
  assert.equal(publishCalls, before);
});

test('CAD-HTTP-03: payload inválido → 400 COLLECTION_CADENCE_INVALID', async () => {
  const cases = [
    {},
    { steps: [] },
    { steps: [{ code: 'X1', offsetDays: 0, action: 'NOTIFY' }] },
    { steps: [{ code: 'X1', offsetDays: 1.5, action: 'NOTIFY' }] },
    { steps: [{ code: 'X1', offsetDays: '3', action: 'NOTIFY' }] },
    { steps: [{ code: 'X1', offsetDays: 3, action: 'EMAIL' }] },
    { steps: [{ code: 'x minúsculo', offsetDays: 3, action: 'NOTIFY' }] },
    { steps: [{ code: 'A1', offsetDays: 3, action: 'NOTIFY' }, { code: 'A2', offsetDays: 3, action: 'TASK' }] },
    { steps: [{ code: 'A1', offsetDays: 400, action: 'NOTIFY' }] },
  ];
  for (const body of cases) {
    const res = await call(tokenManage, 'POST', '/billing/collection-cadence/versions', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.error.code, 'COLLECTION_CADENCE_INVALID');
  }
});

test('CAD-HTTP-04: publicar com billing:cadence:manage → 201 com etapas normalizadas (ordenadas)', async () => {
  const res = await call(tokenManage, 'POST', '/billing/collection-cadence/versions', { steps: VALID_STEPS });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.deepEqual(json.data.steps.map((s) => s.offsetDays), [-2, 2, 10]);
  assert.equal(json.data.groupId, tenant.groupId);
  assert.equal(json.data.companyId, tenant.companyId);
});

test('CAD-HTTP-05: GET régua vigente + histórico', async () => {
  const res = await call(tokenRead, 'GET', '/billing/collection-cadence');
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.ruleCode, 'REG-LOC-004');
  assert.ok(Array.isArray(data.versions));
  assert.deepEqual(data.actions, ['NOTIFY', 'TASK', 'ESCALATE_LEGAL']);
  if (data.current) {
    assert.ok(Array.isArray(data.current.steps));
    assert.equal(data.versions.filter((v) => v.isCurrent).length, 1);
  }
});

test('CAD-HTTP-06: etapas executadas com paginação e filtros', async () => {
  const res = await call(tokenRead, 'GET', '/billing/collection-cadence/steps?page=1&pageSize=5&outcome=executed&period=2026-10');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.data));
  assert.ok(json.data.length <= 5);
  assert.deepEqual(Object.keys(json.pagination).sort(), ['page', 'pageSize', 'total']);
  assert.equal(json.pagination.pageSize, 5);
  for (const row of json.data) {
    assert.equal(row.outcome, 'EXECUTED');
    assert.equal(row.period, '2026-10');
  }
  const capped = await (await call(tokenRead, 'GET', '/billing/collection-cadence/steps?pageSize=9999')).json();
  assert.equal(capped.pagination.pageSize, 200);
});

test('CAD-HTTP-07: filtros inválidos → 400 (não 500)', async () => {
  for (const qs of ['contractId=abc', 'billingScheduleId=1', 'period=2026-13', 'outcome=FOO', 'action=EMAIL']) {
    const res = await call(tokenRead, 'GET', `/billing/collection-cadence/steps?${qs}`);
    assert.equal(res.status, 400, qs);
  }
});
