'use strict';

// Frente 5 (conferência 18/10/2026 item 10): dispensa de requisito do checklist exige permissão
// PRÓPRIA `legal:waive`. Antes bastava legal:update no PATCH com "waivedReason". HTTP real
// (JWT + middlewares + rotas).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.F5_WAIVE_HTTP_TEST_PORT || '21611';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { getSeedTenant, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Contract, ContractRequirement } = require('../src/models');

let tenant;
let baseUrl;
const createdContractIds = [];

function tokenWith(permissions) {
  return signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions,
  });
}

async function http(token, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (createdContractIds.length > 0) {
    await ContractRequirement.destroy({ where: { contractId: createdContractIds }, force: true });
    await Contract.destroy({ where: { id: createdContractIds }, force: true });
  }
  await sequelize.close();
  process.exit(0);
});

test('legal:waive existe no catálogo de permissões (seed da migration 460)', async () => {
  const [rows] = await sequelize.query(
    "SELECT p.code FROM core.permissions p WHERE p.code = 'legal:waive'"
  );
  assert.equal(rows.length, 1);
});

test('dispensa sem legal:waive -> 403 (PATCH e rota dedicada); com legal:waive -> 200', async () => {
  const base = ['legal:create', 'legal:read', 'legal:update', 'legal:approve'];
  const noWaive = tokenWith(base);
  const withWaive = tokenWith([...base, 'legal:waive']);
  const onlyWaive = tokenWith(['legal:waive']);

  const contract = await http(noWaive, 'POST', '/legal/contracts', { contractType: 'SERVICE', totalValue: 500 });
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  createdContractIds.push(contract.body.data.id);
  const generated = await http(noWaive, 'POST', `/legal/contracts/${contract.body.data.id}/requirements/generate`, {});
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  const [r1, r2] = generated.body.data;
  assert.ok(r1 && r2, 'SERVICE agora tem checklist com 2 itens');

  const patchDenied = await http(noWaive, 'PATCH', `/legal/requirements/${r1.id}`, { waivedReason: `F5 ${uniqueSuffix()}` });
  assert.equal(patchDenied.status, 403, JSON.stringify(patchDenied.body));
  assert.equal(patchDenied.body.error.code, 'PERMISSION_DENIED');

  const routeDenied = await http(noWaive, 'POST', `/legal/requirements/${r1.id}/waive`, { reason: 'F5' });
  assert.equal(routeDenied.status, 403, JSON.stringify(routeDenied.body));

  const listed = await http(noWaive, 'GET', `/legal/contracts/${contract.body.data.id}/requirements`);
  assert.equal(listed.body.data.find((r) => r.id === r1.id).status, 'PENDING', '403 não pode ter gravado a dispensa');

  const noReason = await http(onlyWaive, 'POST', `/legal/requirements/${r1.id}/waive`, {});
  assert.equal(noReason.status, 400, JSON.stringify(noReason.body));

  const waived = await http(onlyWaive, 'POST', `/legal/requirements/${r1.id}/waive`, { reason: 'Dispensado com permissão própria' });
  assert.equal(waived.status, 200, JSON.stringify(waived.body));
  assert.equal(waived.body.data.status, 'WAIVED');

  const waivedPatch = await http(withWaive, 'PATCH', `/legal/requirements/${r2.id}`, { waivedReason: 'Dispensa via PATCH com legal:waive' });
  assert.equal(waivedPatch.status, 200, JSON.stringify(waivedPatch.body));
  assert.equal(waivedPatch.body.data.status, 'WAIVED');
});
