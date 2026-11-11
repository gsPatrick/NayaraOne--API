'use strict';

/**
 * Marco 3, M3-05 "Empresas e unidades com criação, alteração, inativação e permissões" (verificação independente de
 * 11/11/2026: a unidade não gravava auditoria e não tinha teste). HTTP real; só em banco descartável.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3IM_UNIDADE_HTTP_PORT || '36105';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog } = require('../src/models');

let tenant;
let baseUrl;
let tokenAdmin;
let tokenLeitura;

before(async () => {
  tenant = await getSeedTenant();
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  tokenAdmin = signAccessToken({ ...claims, permissions: ['units:create', 'units:read', 'units:update', 'units:delete'] });
  tokenLeitura = signAccessToken({ ...claims, permissions: ['units:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, p, body, token = tokenAdmin) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const auditoria = (id) => withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { entityId: id, entityType: 'Unit' }, order: [['occurred_at', 'ASC']], transaction: t }));

test('unidade: criar, alterar, inativar e excluir pela rota, cada passo auditado com antes e depois', async () => {
  const s = uniqueSuffix();
  const criada = await http('POST', '/units', { name: `Filial ${s}`, code: `F-${s.slice(-4)}` });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const id = criada.body.data.id;
  assert.equal(criada.body.data.companyId, tenant.companyId, 'empresa vem da sessão, nunca do corpo');

  const alterada = await http('PATCH', `/units/${id}`, { name: `Filial Centro ${s}` });
  assert.equal(alterada.status, 200);
  const inativada = await http('PATCH', `/units/${id}`, { status: 'INACTIVE' });
  assert.equal(inativada.status, 200);
  assert.equal(inativada.body.data.status, 'INACTIVE');
  const invalida = await http('PATCH', `/units/${id}`, { status: 'APAGADA' });
  assert.equal(invalida.status, 400);
  assert.equal(invalida.body.error.code, 'UNIT_VALIDATION');
  assert.equal((await http('PATCH', `/units/${id}`, { name: '   ' })).status, 400);

  const excluida = await http('DELETE', `/units/${id}`);
  assert.equal(excluida.status, 200);

  const aud = await auditoria(id);
  assert.deepEqual(aud.map((a) => a.action), ['unit.create', 'unit.update', 'unit.inactivate', 'unit.delete']);
  assert.equal(aud[0].beforeJson, null);
  assert.equal(aud[0].afterJson.name, `Filial ${s}`);
  assert.equal(aud[1].beforeJson.name, `Filial ${s}`);
  assert.equal(aud[1].afterJson.name, `Filial Centro ${s}`);
  assert.equal(aud[2].beforeJson.status, 'ACTIVE');
  assert.equal(aud[2].afterJson.status, 'INACTIVE');
  assert.ok(aud[3].afterJson.deletedAt || aud[3].afterJson.deleted_at, 'exclusão lógica registrada');
  assert.equal(aud[3].userId, tenant.userId);
});

test('unidade: permissões — só leitura não cria, não altera nem exclui (403) e nada é gravado', async () => {
  const s = uniqueSuffix();
  const criada = await http('POST', '/units', { name: `Unidade perm ${s}` });
  const id = criada.body.data.id;
  assert.equal((await http('POST', '/units', { name: `Negada ${s}` }, tokenLeitura)).status, 403);
  assert.equal((await http('PATCH', `/units/${id}`, { status: 'INACTIVE' }, tokenLeitura)).status, 403);
  assert.equal((await http('DELETE', `/units/${id}`, undefined, tokenLeitura)).status, 403);
  const lida = await http('GET', `/units/${id}`, undefined, tokenLeitura);
  assert.equal(lida.status, 200);
  assert.equal(lida.body.data.status, 'ACTIVE');
  assert.deepEqual((await auditoria(id)).map((a) => a.action), ['unit.create']);
});
