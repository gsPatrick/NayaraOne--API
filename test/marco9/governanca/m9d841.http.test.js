'use strict';

// M9-D841 — a API real (banco descartável): cabeçalhos Deprecation/Sunset/Link, 410 pelo relógio, GET /api-governance/consumers com filtros, rastro de uso por X-Client-App e permissões.
process.env.PORT = process.env.M9D841_HTTP_TEST_PORT || '21841';
process.env.API_DEPRECATION_ENABLED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d841Env');

const READ = 'governance:api:read';
const MANAGE = 'governance:api:manage';
const ROUTE = 'ROUTE:GET /auth/companies';
const WEB = { 'X-Client-App': 'nayara-web' };
let http;
let A;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const ping = (who, headers = {}) => http.call(who, 'GET', '/auth/companies', null, headers);
const announce = (who, body) => http.call(who, 'POST', '/api-governance/deprecations', body);
const consumers = (who, query = '') => http.call(who, 'GET', `/api-governance/consumers${query}`);

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.cleanApi();
  restore = await env.withRolePermissions({ 'CI GESTOR': { [READ]: true, [MANAGE]: true }, 'CI MAKER': { [READ]: false, [MANAGE]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], gestorB: ['B', 'gestor'] } });
});
after(async () => { if (env.DISPOSABLE) { await env.cleanApi(); await restore(); } await stopHttp({}); });

test('m9d841 resposta traz Deprecation e Sunset', { skip: skip() }, async () => {
  const sunsetAt = env.isoIn(60);
  const created = await announce('gestorA', { target: ROUTE, ownerUserId: A.userId, sunsetAt, replacement: '/v2/auth/companies', replacementNote: 'rota nova' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.data.status, created.body.data.target, created.body.data.replacement], ['ANNOUNCED', ROUTE, '/v2/auth/companies']);
  const res = await ping('gestorA');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('deprecation'), `@${Math.floor(new Date(created.body.data.announcedAt).getTime() / 1000)}`, 'RFC 9745: @epoch do anúncio');
  assert.equal(res.headers.get('sunset'), new Date(created.body.data.sunsetAt).toUTCString(), 'data HTTP do desligamento');
  assert.match(res.headers.get('link'), /<\/v2\/auth\/companies>; rel="successor-version"/);
  const other = await http.call('gestorA', 'GET', '/api-governance/consumers');
  assert.equal(other.headers.get('deprecation'), null, 'só a rota deprecada leva o cabeçalho');
  assert.equal((await ping('gestorB')).headers.get('deprecation'), null, 'a deprecação é da empresa A');
  const major = await announce('gestorA', { target: 'MAJOR:1', ownerUserId: A.userId, sunsetAt: env.isoIn(30) });
  assert.equal(major.status, 201);
  const viaMajor = await http.call('gestorA', 'GET', '/api-governance/consumers');
  assert.ok(viaMajor.headers.get('deprecation'), 'deprecar a major 1 marca toda rota /v1');
  assert.equal(viaMajor.headers.get('sunset'), new Date(major.body.data.sunsetAt).toUTCString());
  const both = await ping('gestorA');
  assert.equal(both.headers.get('sunset'), new Date(major.body.data.sunsetAt).toUTCString(), 'vale o desligamento mais próximo entre rota e major');
  await http.call('gestorA', 'POST', `/api-governance/deprecations/${major.body.data.id}/cancel`);
  const listed = await http.call('gestorA', 'GET', '/api-governance/deprecations?status=CANCELLED');
  assert.equal(listed.body.data.length, 1);
  assert.equal((await http.call('gestorA', 'GET', '/api-governance/consumers')).headers.get('deprecation'), null, 'cancelada: sai dos cabeçalhos na hora');
  await http.call('gestorA', 'POST', `/api-governance/deprecations/${created.body.data.id}/cancel`);
  assert.equal((await ping('gestorA')).headers.get('deprecation'), null);
});

test('m9d841 após sunset devolve 410', { skip: skip() }, async () => {
  const created = await announce('gestorA', { target: ROUTE, ownerUserId: A.userId, announcedAt: '2026-01-01', sunsetAt: '2026-03-01' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const res = await ping('gestorA');
  assert.equal(res.status, 410);
  assert.deepEqual([res.body.error.code, res.body.error.message], ['GOV_API_VERSION_SUNSET', 'Esta versão da API foi desativada.']);
  assert.ok(res.body.error.traceId);
  assert.ok(res.headers.get('sunset'), 'o 410 também leva Sunset');
  assert.equal((await http.call('gestorA', 'GET', '/api-governance/consumers')).status, 200, 'outras rotas seguem');
  assert.equal((await ping('gestorB')).status, 200, 'outra empresa não é desligada');
  const manage = await http.call('gestorA', 'GET', '/api-governance/deprecations');
  assert.equal(manage.status, 200, 'as rotas de gestão da deprecação nunca são desligadas');
});

test('m9d841 após sunset_at devolve 410 mesmo com status ANNOUNCED', { skip: skip() }, async () => {
  const [row] = (await env.adminQuery("SELECT id, status FROM governance.api_deprecations WHERE company_id = $1 AND target = $2 AND status <> 'CANCELLED'", [A.companyId, ROUTE])).rows;
  assert.equal(row.status, 'ANNOUNCED', 'o job das 07:00 ainda não rodou: o status é ANNOUNCED');
  assert.equal((await ping('gestorA')).status, 410, 'o relógio decide, não o status');
  const done = await env.inTx(A, (transaction) => env.consumersApi.evaluateDeprecations({ tenant: env.tenantOf(A), now: new Date(), transaction }));
  assert.equal(done.sunset, 1);
  assert.equal((await env.depRow(row.id)).status, 'SUNSET');
  assert.equal((await ping('gestorA')).status, 410, 'continua 410 depois do job');
  await env.adminQuery("UPDATE governance.api_deprecations SET status = 'CANCELLED' WHERE id = $1", [row.id]);
  env.consumersApi.clearContextCache();
  assert.equal((await ping('gestorA')).status, 200, 'cancelada, a rota volta');
});

test('m9d841 GET consumers filtra usingDeprecated', { skip: skip() }, async () => {
  await env.cleanApi();
  const using = await env.registerConsumer(A, { kind: 'PROVIDER', apiVersionUsed: 2 });
  const free = await env.registerConsumer(A, { kind: 'PARTNER' });
  const stale = await env.registerConsumer(A, { kind: 'PARTNER' });
  await env.addUsage(A, using.id, 'ROUTE:GET /legal/contracts', 3);
  await env.addUsage(A, using.id, 'MAJOR:2', 3);
  await env.addUsage(A, free.id, 'ROUTE:GET /people', 3);
  await env.addUsage(A, stale.id, 'ROUTE:GET /legal/contracts', 60);
  const dep = await announce('gestorA', { target: 'ROUTE:GET /legal/contracts', ownerUserId: A.userId, sunsetAt: env.isoIn(20) });
  assert.equal(dep.status, 201);
  const yes = await consumers('gestorA', '?usingDeprecated=true');
  assert.equal(yes.status, 200);
  assert.deepEqual(yes.body.data.map((c) => c.id), [using.id], 'só quem usou o alvo na janela de 30 dias');
  const item = yes.body.data[0];
  assert.deepEqual([item.name, item.kind, item.status, item.ownerUserId, item.apiVersionUsed], [using.name, 'PROVIDER', 'ACTIVE', A.userId, 2]);
  assert.deepEqual(item.versionsUsed, [2]);
  assert.deepEqual(item.deprecations.map((d) => [d.target, d.status, d.id]), [['ROUTE:GET /legal/contracts', 'ANNOUNCED', dep.body.data.id]]);
  assert.ok(item.daysToSunset >= 19 && item.daysToSunset <= 20, `daysToSunset ${item.daysToSunset}`);
  assert.ok(item.lastSeenAt === null || typeof item.lastSeenAt === 'string');
  assert.equal(yes.body.pagination.total, 1);
  const no = await consumers('gestorA', '?usingDeprecated=false&kind=PARTNER');
  assert.deepEqual(no.body.data.map((c) => c.id).sort(), [free.id, stale.id].sort());
  assert.ok(no.body.data.every((c) => c.deprecations.length === 0 && c.daysToSunset === null));
  assert.deepEqual((await consumers('gestorA', '?apiVersion=2')).body.data.map((c) => c.id), [using.id], 'filtro por versão usada (catálogo ou uso MAJOR)');
  assert.deepEqual((await consumers('gestorA', '?status=RETIRED')).body.data, []);
  const page = await consumers('gestorA', '?pageSize=1&page=2');
  assert.deepEqual([page.body.data.length, page.body.pagination.page, page.body.pagination.pageSize, page.body.pagination.total >= 3], [1, 2, 1, true]);
  for (const bad of ['?kind=OUTRO', '?status=X', '?apiVersion=0', '?usingDeprecated=talvez']) assert.equal((await consumers('gestorA', bad)).status, 400, bad);
  assert.equal((await consumers('gestorA', '?pageSize=201')).status, 400);
});

test('m9d841 uso por alvo alimenta usingDeprecated e o evento de aviso', { skip: skip() }, async () => {
  await env.cleanApi();
  await env.adminQuery("DELETE FROM governance.api_consumers WHERE company_id = $1", [A.companyId]);
  env.consumersApi.clearContextCache();
  const unknown = await ping('gestorA', { 'X-Client-App': 'app-desconhecido' });
  assert.equal(unknown.status, 200);
  await env.consumersApi.flushUsage();
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.api_consumer_usage')).rows[0].n, 0, 'valor desconhecido não é rastreado');
  const first = await ping('gestorA', WEB);
  assert.equal(first.status, 200);
  await env.consumersApi.flushUsage();
  const [web] = (await env.adminQuery("SELECT * FROM governance.api_consumers WHERE company_id = $1 AND app_key = 'nayara-web'", [A.companyId])).rows;
  assert.deepEqual([web.kind, web.status, web.name, web.api_version_used], ['APP', 'ACTIVE', 'Front web Nayara One', 1]);
  assert.ok(web.owner_user_id, 'o consumidor semeado tem responsável');
  assert.ok(web.last_seen_at, 'last_seen_at atualizado');
  assert.deepEqual((await env.usageOf(web.id)).map((u) => u.targetKey), [ROUTE, 'MAJOR:1'].sort(), 'uso por major e por rota com parâmetros');
  const marks = await env.usageOf(web.id);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await ping('gestorA', WEB);
  await env.consumersApi.flushUsage();
  assert.deepEqual(await env.usageOf(web.id), marks, 'no máximo uma gravação por hora por consumidor e alvo');
  const dep = await announce('gestorA', { target: ROUTE, ownerUserId: A.userId, sunsetAt: env.isoIn(12) });
  assert.equal(dep.status, 201);
  const using = await consumers('gestorA', '?usingDeprecated=true');
  assert.deepEqual(using.body.data.map((c) => c.id), [web.id], 'o consumidor que chamou a rota deprecada aparece');
  const done = await env.inTx(A, (transaction) => env.consumersApi.evaluateDeprecations({ tenant: env.tenantOf(A), now: new Date(), transaction }));
  assert.equal(done.events, 1);
  const [event] = await env.dueEvents(web.id);
  assert.deepEqual([event.payload_json.consumerId, event.payload_json.target], [web.id, ROUTE]);
  assert.equal((await consumers('gestorB', '?usingDeprecated=true')).body.data.length, 0, 'isolamento entre empresas');
  assert.ok((await consumers('gestorB')).body.data.every((c) => c.id !== web.id));
  const refused = await ping('gestorA', { ...WEB, 'X-Client-Id': 'qualquer' });
  assert.equal(refused.status, 200);
});

test('m9d841 rotas exigem permissão e validam o corpo', { skip: skip() }, async () => {
  assert.equal((await consumers('makerA')).status, 403);
  const denied = await http.call('makerA', 'POST', '/api-governance/deprecations', { target: 'MAJOR:1', sunsetAt: env.isoIn(10), ownerUserId: A.userId });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  const noOwner = await announce('gestorA', { target: 'MAJOR:5', sunsetAt: env.isoIn(10) });
  assert.deepEqual([noOwner.status, noOwner.body.error.code, noOwner.body.error.message], [422, 'GOV_API_OWNER_REQUIRED', 'Informe o responsável pela deprecação.']);
  const order = await announce('gestorA', { target: 'MAJOR:5', ownerUserId: A.userId, announcedAt: '2026-10-27', sunsetAt: '2026-10-20' });
  assert.deepEqual([order.status, order.body.error.code], [422, 'GOV_API_DEPRECATION_INVALID']);
  assert.equal((await http.call('gestorA', 'POST', `/api-governance/deprecations/${A.userId}/cancel`)).status, 404);
  assert.equal((await http.call('gestorA', 'GET', '/api-governance/deprecations?status=XYZ')).status, 400);
});
