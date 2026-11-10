'use strict';

/**
 * M3-05 pela ROTA (HTTP real): criar, alterar e inativar empresa do grupo. Defeito achado na captura ao vivo do Marco 3:
 * PATCH e DELETE de outra empresa do grupo davam 500 (o audit_log tem RLS por empresa e a auditoria era gravada no contexto
 * da empresa de quem age). O teste de serviço passava porque a criação deixava o contexto na empresa nova.
 * Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3_COMPANIES_HTTP_PORT || '21663';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog } = require('../src/models');

let tenant;
let baseUrl;
let token;
let tokenSemPermissao;

before(async () => {
  tenant = await getSeedTenant();
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  token = signAccessToken({ ...claims, permissions: ['companies:create', 'companies:read', 'companies:update', 'companies:delete'] });
  tokenSemPermissao = signAccessToken({ ...claims, permissions: ['companies:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body, tk = token) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('ROTA M3-05: cria, altera e inativa outra empresa do grupo, com auditoria antes/depois na empresa alterada', async () => {
  const s = uniqueSuffix();
  const criada = await http('POST', '/companies', { name: `Filial HTTP ${s}`, legalName: `Filial HTTP ${s} Ltda` });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const id = criada.body.data.id;
  const alterada = await http('PATCH', `/companies/${id}`, { name: `Filial HTTP ${s} (centro)` });
  assert.equal(alterada.status, 200, JSON.stringify(alterada.body));
  assert.equal(alterada.body.data.name, `Filial HTTP ${s} (centro)`);
  const inativada = await http('DELETE', `/companies/${id}`);
  assert.equal(inativada.status, 200, JSON.stringify(inativada.body));
  const lista = await http('GET', '/companies');
  assert.ok(!lista.body.data.some((c) => c.id === id), 'inativada sai da listagem');
  const auds = await withTenantTransaction({ ...tenant, companyId: id }, (t) => AuditLog.findAll({ where: { entityId: id }, order: [['occurred_at', 'ASC']], transaction: t }));
  assert.deepEqual(auds.map((a) => a.action), ['company.create', 'company.update', 'company.delete']);
  assert.match(auds[1].beforeJson.name, /Filial HTTP/);
  assert.equal(auds[1].afterJson.name, `Filial HTTP ${s} (centro)`);
});

test('ROTA M3-05: sem permissão de alterar é 403 e nada muda', async () => {
  const s = uniqueSuffix();
  const criada = await http('POST', '/companies', { name: `Filial negada ${s}` });
  const negado = await http('PATCH', `/companies/${criada.body.data.id}`, { name: 'x' }, tokenSemPermissao);
  assert.equal(negado.status, 403);
  const lida = await http('GET', `/companies/${criada.body.data.id}`);
  assert.equal(lida.body.data.name, `Filial negada ${s}`);
});
