'use strict';

// M9-D844 — credencial na API real (banco descartável): segredo em hash e mostrado uma vez, consumidor criado no mesmo ato, rastro de uso por client_id, rotas externas (imóveis públicos, leads, contratos).
process.env.PORT = process.env.M9D844_DADOS_TEST_PORT || '21845';
process.env.API_DEPRECATION_ENABLED = 'true';
process.env.API_RATE_LIMIT_ENABLED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d844Env');
const { criarImovel, CANARY, CANARY_PRICE } = require('../_helpers/intReadModel');
const { comTenant, ctxDe } = require('../../integrations/dispatch/dispatchHelpers');
const rm = require('../../../src/features/properties/publicReadModel');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { identify } = require('../../../src/features/core-governance/api-governance/standards/rateLimit.identity');
const { signClientToken } = require('../../../src/features/core-governance/api-governance/clients/token');

const READ = 'governance:api:read';
const MANAGE = 'governance:api:manage';
let http;
let A;
let B;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const external = (token, method, path, body) => env.raw(method, `/api-external${path}`, { token, body });
const row = async (id) => (await env.adminQuery('SELECT * FROM governance.api_clients WHERE id = $1', [id])).rows[0];

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  await env.cleanClients();
  restore = await env.withRolePermissions({ 'CI GESTOR': { [READ]: true, [MANAGE]: true }, 'CI MAKER': { [READ]: false, [MANAGE]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], gestorB: ['B', 'gestor'] } });
});
after(async () => { if (env.DISPOSABLE) { await env.cleanClients(); await restore(); } await stopHttp({}); });

test('m9d844 segredo guardado em hash e mostrado uma vez', { skip: skip() }, async () => {
  const key = `qa-m9-idem-${Date.now()}`;
  const body = { name: env.unique('segredo'), kind: 'PROVIDER', ownerUserId: A.userId, scopes: ['properties:read', 'leads:write', 'properties:read'] };
  const created = await http.call('gestorA', 'POST', '/api-governance/clients', body, { 'Idempotency-Key': key });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const data = created.body.data;
  assert.match(data.clientSecret, /^nys_[A-Za-z0-9_-]{40,}$/);
  assert.match(data.clientId, /^nyc_[0-9a-f]{24}$/);
  assert.deepEqual([data.secretShown, data.status, data.kind, data.scopes], [true, 'ACTIVE', 'PROVIDER', ['properties:read', 'leads:write']], 'scopes repetidos entram uma vez');
  const stored = await row(data.id);
  assert.notEqual(stored.secret_hash, data.clientSecret);
  assert.match(stored.secret_hash, /^\$2[aby]\$\d{2}\$/, 'hash bcrypt');
  assert.ok(!JSON.stringify(stored).includes(data.clientSecret), 'nenhuma coluna guarda o segredo em claro');
  const replay = await http.call('gestorA', 'POST', '/api-governance/clients', body, { 'Idempotency-Key': key });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.deepEqual([replay.body.data.id, replay.body.data.clientSecret, replay.body.data.secretShown], [data.id, null, false], 'a repetição devolve a credencial sem o segredo');
  const keys = (await env.adminQuery('SELECT response_body::text AS body FROM governance.idempotency_keys WHERE company_id = $1', [A.companyId])).rows;
  assert.ok(keys.length >= 1 && keys.every((k) => !k.body.includes(data.clientSecret)), 'a resposta guardada para repetição não contém o segredo');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.api_clients WHERE id = $1', [data.id])).rows[0].n, 1, 'a repetição não cria outra credencial');
  const list = await http.call('gestorA', 'GET', '/api-governance/clients?status=ACTIVE&pageSize=1');
  assert.deepEqual(Object.keys(list.body.data[0]).filter((k) => /secret|hash/i.test(k)), [], 'a lista não traz segredo');
  const logs = (await env.adminQuery("SELECT before_json::text AS b, after_json::text AS a, reason FROM audit.audit_log WHERE entity_id = $1", [data.id])).rows;
  assert.ok(logs.length >= 1 && logs.every((l) => !`${l.a}${l.b}${l.reason}`.includes(data.clientSecret)), 'a auditoria registra o ciclo de vida sem o segredo');
  const second = await env.tokenFor({ clientId: data.clientId, clientSecret: data.clientSecret });
  assert.equal(second.status, 200, 'o segredo mostrado na criação funciona');
});

test('m9d844 criar a credencial cria o consumidor no mesmo ato e o uso é rastreado por client_id', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { kind: 'PARTNER', scopes: ['properties:read'] });
  const consumer = (await env.adminQuery('SELECT * FROM governance.api_consumers WHERE client_id = $1', [client.clientId])).rows[0];
  assert.ok(consumer, 'consumidor criado junto');
  assert.deepEqual([consumer.kind, consumer.owner_user_id, consumer.status, consumer.company_id], ['PARTNER', A.userId, 'ACTIVE', A.companyId]);
  assert.equal((await row(client.id)).consumer_id, consumer.id);
  assert.equal((await external(client.accessToken, 'GET', '/properties')).status, 200);
  await env.consumersApi.flushUsage();
  const usage = (await env.adminQuery('SELECT target_key FROM governance.api_consumer_usage WHERE consumer_id = $1 ORDER BY target_key', [consumer.id])).rows.map((r) => r.target_key);
  assert.ok(usage.includes('ROUTE:GET /api-external/properties') && usage.includes('MAJOR:1'), `uso por rota e major a partir do token, sem X-Client-Id: ${usage}`);
  assert.ok(usage.includes('ROUTE:POST /api-external/oauth/token'), `a emissão do token também fica no rastro: ${usage}`);
  const listed = await http.call('gestorA', 'GET', '/api-governance/consumers?kind=PARTNER');
  assert.ok(listed.body.data.some((c) => c.id === consumer.id && c.lastSeenAt), 'o catálogo da D841 mostra o consumidor externo visto');
  const noOwner = await http.call('gestorA', 'POST', '/api-governance/clients', { name: env.unique('x'), kind: 'PARTNER', ownerUserId: B.userId, scopes: ['properties:read'] });
  assert.equal(noOwner.status, 422, 'o responsável deve ser usuário da empresa');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.api_clients WHERE name = $1', [noOwner.body && 'x'])).rows[0].n, 0);
});

test('m9d844 limite de requisições é por client_id, não por token', { skip: skip() }, async () => {
  const client = await env.createClient(http, 'gestorA', A, { scopes: ['properties:read'] });
  const t1 = signClientToken({ clientId: client.clientId, groupId: A.groupId, companyId: A.companyId, scopes: ['properties:read'] }, 60);
  const t2 = signClientToken({ clientId: client.clientId, groupId: A.groupId, companyId: A.companyId, scopes: ['properties:read'] }, 61);
  const reqOf = (token) => ({ get: (name) => ({ authorization: `Bearer ${token}` })[name.toLowerCase()], originalUrl: '/api/v1/api-external/properties', url: '/api-external/properties' });
  assert.notEqual(t1, t2);
  assert.equal(identify(reqOf(t1)).scopeKey, identify(reqOf(t2)).scopeKey, 'dois tokens da mesma credencial dividem o contador');
  const res = await external(t1, 'GET', '/properties');
  assert.ok(res.headers.get('x-ratelimit-limit'), 'X-RateLimit-* nas respostas externas');
});

test('m9d844 imóveis externos trazem só campos públicos da empresa da credencial', { skip: skip() }, async () => {
  const imovel = await criarImovel(A);
  await comTenant(A, (t) => rm.syncPublicPropertyReadModel(imovel.id, ctxDe(A), t));
  const clientA = await env.clientWithToken(http, 'gestorA', A, { scopes: ['properties:read'] });
  const clientB = await env.clientWithToken(http, 'gestorB', B, { scopes: ['properties:read'] });
  const res = await external(clientA.accessToken, 'GET', '/properties?pageSize=200');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mine = res.body.data.find((p) => p.title === 'Apartamento de 3 quartos no Batel');
  assert.ok(mine, 'o imóvel publicado aparece');
  assert.ok(Object.keys(mine).every((k) => rm.PUBLIC_FIELDS.includes(k)), 'só campos da lista pública');
  assert.ok(!res.text.includes(CANARY) && !res.text.includes(CANARY_PRICE) && !res.text.includes(imovel.id), 'nada interno nem o identificador interno');
  const other = await external(clientB.accessToken, 'GET', '/properties?pageSize=200');
  assert.ok(!other.text.includes(mine.public_code), 'a empresa B não vê imóvel da empresa A');
  assert.equal((await external(clientA.accessToken, 'GET', '/properties?pageSize=201')).status, 400);
});

test('m9d844 lead externo entra no funil com prazo configurável e recusa duplicidade', { skip: skip() }, async () => {
  const client = await env.clientWithToken(http, 'gestorA', A, { scopes: ['leads:write'] });
  const email = `qa-m9-${Date.now()}@exemplo.com`;
  const before = Date.now();
  const created = await external(client.accessToken, 'POST', '/leads', { name: 'QA-M9 Interessada', email, phone: '(41) 99999-0000', message: 'QA-M9 quer visitar' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const opp = (await env.adminQuery('SELECT * FROM crm.opportunities WHERE id = $1', [created.body.data.opportunityId])).rows[0];
  assert.deepEqual([opp.stage, opp.company_id], ['NEW', A.companyId]);
  const hours = (new Date(opp.next_action_due_at).getTime() - before) / 3600000;
  assert.ok(hours > 23.9 && hours < 24.1, `prazo padrão de 24 h: ${hours}`);
  const contacts = (await env.adminQuery('SELECT contact_type FROM people.person_contacts WHERE person_id = $1 ORDER BY contact_type', [opp.person_id])).rows.map((r) => r.contact_type);
  assert.deepEqual(contacts, ['EMAIL', 'PHONE']);
  const dup = await external(client.accessToken, 'POST', '/leads', { name: 'QA-M9 Interessada', email });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'GOV_EXTERNAL_LEAD_DUPLICATE']);
  await env.inTx(A, (tx) => upsertSetting('governanca.api.externo.lead_prazo_horas', 48, env.tenantOf(A), A.userId, tx));
  const later = await external(client.accessToken, 'POST', '/leads', { name: 'QA-M9 Outra', email: `outra-${email}`, message: 'QA-M9' });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const due = (await env.adminQuery('SELECT next_action_due_at AS d FROM crm.opportunities WHERE id = $1', [later.body.data.opportunityId])).rows[0].d;
  assert.ok(Math.abs((new Date(due).getTime() - Date.now()) / 3600000 - 48) < 0.1, 'o parâmetro governanca.api.externo.lead_prazo_horas vale');
  await env.inTx(A, (tx) => upsertSetting('governanca.api.externo.lead_prazo_horas', 24, env.tenantOf(A), A.userId, tx));
  for (const bad of [{}, { name: 'QA-M9 X' }, { name: 'QA-M9 X', email: 'sem-arroba' }, { name: 'QA-M9 X', phone: '123' }, { name: 'QA-M9 X', email, propertyId: 'nao-uuid' }]) {
    const res = await external(client.accessToken, 'POST', '/leads', bad);
    assert.deepEqual([res.status, res.body.error.code], [422, 'GOV_EXTERNAL_LEAD_INVALID'], JSON.stringify(bad));
  }
});

test('m9d844 contratos externos são resumidos e da empresa da credencial', { skip: skip() }, async () => {
  const number = `QA-M9-${Date.now()}`;
  await env.adminQuery("INSERT INTO legal.contracts (id, group_id, company_id, contract_type, contract_number, status, total_value, created_by, updated_by) VALUES (gen_random_uuid(), $1, $2, 'SALE', $3, 'DRAFT', 987654.32, $4, $4)", [A.groupId, A.companyId, number, A.userId]);
  const clientA = await env.clientWithToken(http, 'gestorA', A, { scopes: ['contracts:read'] });
  const clientB = await env.clientWithToken(http, 'gestorB', B, { scopes: ['contracts:read'] });
  const res = await external(clientA.accessToken, 'GET', '/contracts?pageSize=200');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mine = res.body.data.find((c) => c.contractNumber === number);
  assert.deepEqual(Object.keys(mine).sort(), ['contractNumber', 'contractType', 'endsAt', 'id', 'propertyId', 'startsAt', 'status']);
  assert.ok(!res.text.includes('987654'), 'sem valor total');
  assert.ok(!(await external(clientB.accessToken, 'GET', '/contracts?pageSize=200')).text.includes(number), 'isolamento entre empresas');
});

test('m9d844 parâmetros da API externa existem e são lidos', { skip: skip() }, async () => {
  const client = await env.createClient(http, 'gestorA', A, { scopes: ['properties:read'] });
  await env.inTx(A, (tx) => upsertSetting('governanca.api.cliente.token_validade_s', 120, env.tenantOf(A), A.userId, tx));
  const short = await env.tokenFor(client);
  assert.equal(short.body.expires_in, 120, 'governanca.api.cliente.token_validade_s vale');
  await env.inTx(A, (tx) => upsertSetting('governanca.api.cliente.token_validade_s', 900, env.tenantOf(A), A.userId, tx));
  await env.inTx(A, (tx) => upsertSetting('governanca.api.cliente.segredo_custo', 5, env.tenantOf(A), A.userId, tx));
  const cheap = await env.createClient(http, 'gestorA', A, { scopes: ['properties:read'] });
  assert.match((await row(cheap.id)).secret_hash, /^\$2[aby]\$05\$/, 'governanca.api.cliente.segredo_custo vale');
  await env.inTx(A, (tx) => upsertSetting('governanca.api.cliente.segredo_custo', 10, env.tenantOf(A), A.userId, tx));
  assert.equal((await env.tokenFor(cheap)).status, 200);
});
