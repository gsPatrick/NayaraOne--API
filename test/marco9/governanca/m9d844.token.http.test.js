'use strict';

// M9-D844 — API externa na API real (banco descartável): emissão do token (client credentials), interseção de scopes, scope por rota, separação usuário x cliente, revogação imediata e expiração.
process.env.PORT = process.env.M9D844_HTTP_TEST_PORT || '21844';
process.env.API_DEPRECATION_ENABLED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d844Env');
const { signClientToken } = require('../../../src/features/core-governance/api-governance/clients/token');

const READ = 'governance:api:read';
const MANAGE = 'governance:api:manage';
let http;
let A;
let B;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const external = (token, method, path, body) => env.raw(method, `/api-external${path}`, { token, body });

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  await env.cleanClients();
  restore = await env.withRolePermissions({ 'CI GESTOR': { [READ]: true, [MANAGE]: true }, 'CI MAKER': { [READ]: false, [MANAGE]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], gestorB: ['B', 'gestor'] } });
});
after(async () => { if (env.DISPOSABLE) { await env.cleanClients(); await restore(); } await stopHttp({}); });

test('m9d844 token de cliente só recebe scopes permitidos', { skip: skip() }, async () => {
  const client = await env.createClient(http, 'gestorA', A, { scopes: ['contracts:read'] });
  assert.equal(client.response.status, 201, JSON.stringify(client.response.body));
  const wider = await env.tokenFor(client, { scope: 'contracts:read contracts:write leads:write' });
  assert.equal(wider.status, 200, JSON.stringify(wider.body));
  assert.equal(wider.body.scope, 'contracts:read', 'a interseção entre o pedido e o permitido');
  assert.deepEqual([wider.body.token_type, wider.body.expires_in], ['Bearer', 900], 'validade padrão do livro: 900 s');
  assert.equal(wider.headers.get('cache-control'), 'no-store');
  const none = await env.tokenFor(client, { scope: 'leads:write' });
  assert.deepEqual([none.status, none.body.error.code], [400, 'GOV_INVALID_SCOPE'], 'nenhum scope permitido: não vira token vazio');
  const all = await env.tokenFor(client, { scope: undefined });
  assert.equal(all.body.scope, 'contracts:read', 'sem scope na requisição vale tudo que a credencial tem');
  const grant = await env.tokenFor(client, { grant_type: 'password' });
  assert.deepEqual([grant.status, grant.body.error.code], [400, 'GOV_UNSUPPORTED_GRANT_TYPE']);
  const form = await env.raw('POST', '/api-external/oauth/token', { form: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret } });
  assert.equal(form.status, 200, 'o formulário urlencoded do RFC 6749 também vale');
});

test('m9d844 scopes separados por espaço são interpretados', { skip: skip() }, async () => {
  const client = await env.createClient(http, 'gestorA', A, { scopes: ['properties:read', 'leads:write', 'contracts:read'] });
  const spaced = await env.tokenFor(client, { scope: 'properties:read   contracts:read' });
  assert.deepEqual(spaced.body.scope.split(' ').sort(), ['contracts:read', 'properties:read']);
  const comma = await env.tokenFor(client, { scope: 'properties:read,contracts:read' });
  assert.equal(comma.status, 400, 'vírgula não é separador do RFC 6749: o texto inteiro é um scope desconhecido');
  const one = await env.tokenFor(client, { scope: 'leads:write' });
  assert.equal(one.body.scope, 'leads:write');
});

test('m9d844 rota sem scope devolve 403', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { scopes: ['properties:read'] });
  assert.equal(client.issued.status, 200);
  const ok = await external(client.accessToken, 'GET', '/properties');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(Array.isArray(ok.body.data) && ok.body.pagination, 'lista no formato único');
  const noScope = await external(client.accessToken, 'GET', '/contracts');
  assert.deepEqual([noScope.status, noScope.body.error.code, noScope.body.error.message], [403, 'GOV_INSUFFICIENT_SCOPE', 'A credencial não tem permissão para esta operação.']);
  assert.ok(noScope.body.error.traceId, 'traceId dentro de error');
  const lead = await external(client.accessToken, 'POST', '/leads', { name: 'QA-M9 Pessoa', email: 'qa-m9@exemplo.com' });
  assert.equal(lead.status, 403);
  const anon = await external(null, 'GET', '/properties');
  assert.deepEqual([anon.status, anon.body.error.code], [401, 'MISSING_ACCESS_TOKEN']);
});

test('m9d844 token de usuário não entra em rota externa e vice-versa', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { scopes: ['properties:read'] });
  const asUser = await external(http.tokens.gestorA, 'GET', '/properties');
  assert.deepEqual([asUser.status, asUser.body.error.code, asUser.body.error.message], [401, 'GOV_AUTH_INVALID_TOKEN_TYPE', 'Tipo de credencial não aceito aqui.']);
  for (const path of ['/auth/companies', '/api-governance/consumers', '/people']) {
    const res = await env.raw('GET', path, { token: client.accessToken });
    assert.deepEqual([res.status, res.body.error.code], [401, 'GOV_AUTH_INVALID_TOKEN_TYPE'], `rota interna ${path} recusa token de cliente`);
  }
  const mgmt = await env.raw('POST', '/api-governance/clients', { token: client.accessToken, body: {} });
  assert.equal(mgmt.status, 401, 'token de cliente não gere credenciais');
});

test('m9d844 credencial revogada não obtém token', { skip: skip() }, async () => {
  const client = await env.createClient(http, 'gestorA', A, { scopes: ['properties:read'] });
  const revoked = await http.call('gestorA', 'POST', `/api-governance/clients/${client.id}/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, 'REVOKED');
  const res = await env.tokenFor(client);
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [401, 'GOV_CLIENT_DISABLED', 'Esta credencial está desativada.']);
  const again = await http.call('gestorA', 'POST', `/api-governance/clients/${client.id}/revoke`);
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_API_CLIENT_REVOKED']);
  const wrong = await env.tokenFor({ clientId: client.clientId, clientSecret: 'segredo-errado' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'GOV_INVALID_CLIENT'], 'segredo errado de credencial revogada não revela a situação');
  const unknown = await env.tokenFor({ clientId: 'nyc_inexistente', clientSecret: 'x' });
  assert.deepEqual([unknown.status, unknown.body.error.code, unknown.body.error.message], [401, 'GOV_INVALID_CLIENT', 'Credenciais inválidas.']);
});

test('m9d844 token já emitido de credencial revogada é recusado na chamada seguinte', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { scopes: ['properties:read'] });
  assert.equal((await external(client.accessToken, 'GET', '/properties')).status, 200, 'antes de revogar o token vale');
  assert.equal((await http.call('gestorA', 'POST', `/api-governance/clients/${client.id}/revoke`)).status, 200);
  const after = await external(client.accessToken, 'GET', '/properties');
  assert.deepEqual([after.status, after.body.error.code], [401, 'GOV_CLIENT_DISABLED'], 'o JWT ainda não venceu, mas a credencial está REVOGADA');
});

test('m9d844 token expirado devolve 401 GOV_TOKEN_EXPIRED', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { scopes: ['properties:read'] });
  const expired = signClientToken({ clientId: client.clientId, groupId: A.groupId, companyId: A.companyId, scopes: ['properties:read'] }, -30);
  const res = await external(expired, 'GET', '/properties');
  assert.deepEqual([res.status, res.body.error.code], [401, 'GOV_TOKEN_EXPIRED']);
  const garbage = await external('nao.e.jwt', 'GET', '/properties');
  assert.deepEqual([garbage.status, garbage.body.error.code], [401, 'GOV_TOKEN_INVALID']);
  const other = signClientToken({ clientId: 'nyc_nao_existe', groupId: A.groupId, companyId: A.companyId, scopes: ['properties:read'] }, 60);
  assert.deepEqual([(await external(other, 'GET', '/properties')).status], [401], 'token de credencial inexistente');
});

test('m9d844 isolamento entre empresas', { skip: skip() }, async () => {
  const clientA = await env.clientWithToken(http, 'gestorA', A, { scopes: ['contracts:read'] });
  const clientB = await env.clientWithToken(http, 'gestorB', B, { scopes: ['contracts:read'] });
  const listA = await http.call('gestorA', 'GET', '/api-governance/clients');
  assert.ok(listA.body.data.some((c) => c.clientId === clientA.clientId) && listA.body.data.every((c) => c.clientId !== clientB.clientId), 'cada gestor vê as credenciais da própria empresa');
  assert.ok(listA.body.data.every((c) => c.secretHash === undefined && c.clientSecret === undefined), 'a lista nunca traz segredo nem hash');
  assert.equal((await http.call('gestorA', 'POST', `/api-governance/clients/${clientB.id}/revoke`)).status, 404, 'revogar credencial de outra empresa: 404');
  assert.equal((await external(clientB.accessToken, 'GET', '/contracts')).status, 200, 'a credencial de B segue valendo');
  const forged = signClientToken({ clientId: clientB.clientId, groupId: A.groupId, companyId: A.companyId, scopes: ['contracts:read'] }, 60);
  assert.equal((await external(forged, 'GET', '/contracts')).status, 401, 'client_id de B com a empresa de A não existe na empresa de A');
});

test('m9d844 criar e revogar exigem governance:api:manage', { skip: skip() }, async () => {
  const body = { name: env.unique('sem-permissao'), kind: 'PARTNER', ownerUserId: A.userId, scopes: ['properties:read'] };
  const denied = await http.call('makerA', 'POST', '/api-governance/clients', body);
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  assert.equal((await http.call('makerA', 'GET', '/api-governance/clients')).status, 403);
  const anon = await env.raw('POST', '/api-governance/clients', { body });
  assert.equal(anon.status, 401);
  const invalid = await http.call('gestorA', 'POST', '/api-governance/clients', { ...body, scopes: ['properties:write'], kind: 'APP' });
  assert.deepEqual([invalid.status, invalid.body.error.code], [422, 'GOV_API_CLIENT_INVALID']);
  assert.deepEqual(invalid.body.error.details.problems.map((p) => p.field).sort(), ['kind', 'scopes']);
  const noOwner = await http.call('gestorA', 'POST', '/api-governance/clients', { ...body, ownerUserId: undefined });
  assert.equal(noOwner.status, 422);
});
