'use strict';

// PATCH /legal/deadlines/:id por HTTP real (JWT + middlewares + rotas): invariantes sobre o estado final.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.LEGAL_DEADLINE_FINAL_HTTP_TEST_PORT || '21634';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { prepararOrigem } = require('./helpers/prazoOrigem');
const { sequelize, newUser, concludedCriticalWithoutCaseResponsible: setup, snapshot } = require('./legal.deadlineFinalState.helpers');
const { signAccessToken } = require('../src/utils/jwt');

let tenant;
let baseUrl;
let token;

before(async () => {
  tenant = await getSeedTenant();
  await prepararOrigem(tenant);
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['legal:read', 'legal:create', 'legal:update'],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function patch(id, body, tok = token) {
  const res = await fetch(`${baseUrl}/legal/deadlines/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function fixture(opts, withB = false) {
  const fx = {};
  await withTenantTransaction(tenant, async (t) => {
    if (opts.withA) fx.a = await newUser(tenant, t);
    if (withB) fx.b = await newUser(tenant, t);
    Object.assign(fx, await setup(tenant, t, { responsibleUserId: fx.a?.id }));
  });
  return fx;
}
const snap = (id) => withTenantTransaction(tenant, (t) => snapshot(id, t));

test('HTTP cenario 1: reabrir CRITICAL retirando o unico responsavel -> 422 e estado preservado (incl. auditoria)', async () => {
  const fx = await fixture({ withA: true });
  const before = await snap(fx.d.id);
  const res = await patch(fx.d.id, { status: 'PENDING', responsibleUserId: null });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED');
  assert.deepEqual(await snap(fx.d.id), before);
  assert.equal(before.status, 'DONE');
});

test('HTTP cenario 2: reabrir CRITICAL sem responsavel atribuindo B valido -> 200', async () => {
  const fx = await fixture({}, true);
  const res = await patch(fx.d.id, { status: 'PENDING', responsibleUserId: fx.b.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = await snap(fx.d.id);
  assert.equal(s.status, 'PENDING');
  assert.equal(s.responsibleUserId, fx.b.id);
});

test('HTTP: sem legal:update -> 403; remover responsavel de CRITICAL DONE sem reabrir -> 200; criticality invalida -> 400', async () => {
  const fx = await fixture({ withA: true });
  const readOnly = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: ['legal:read'] });
  assert.equal((await patch(fx.d.id, { responsibleUserId: null }, readOnly)).status, 403);
  assert.equal((await patch(fx.d.id, { criticality: 'URGENTE' })).status, 400);
  const res = await patch(fx.d.id, { responsibleUserId: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await snap(fx.d.id)).responsibleUserId, null);
});
