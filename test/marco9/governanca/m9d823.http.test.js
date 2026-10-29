'use strict';

// M9-D823 — links externos pela API real (banco descartável): criar, abrir sem login, revogar, nova abertura 404, auditoria dos acessos, prazo acima do teto, limite por IP (429),
// cabeçalhos da rota pública e isolamento entre empresas.
process.env.PORT = process.env.M9D823_HTTP_TEST_PORT || '21823';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/shareEnv');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const logger = require('../../../src/utils/logger');

let http;
let A;
let restore;
let contract;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const EXPORT = 'governance:dlp:export';

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { [EXPORT]: true, 'legal:read': true }, 'CI MAKER': { [EXPORT]: true, 'legal:read': true }, 'CI LEITURA': { [EXPORT]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  A = http.tenants.A;
  await env.cleanShares();
  contract = await env.makeContract(A);
});
afterEach(async () => { if (env.DISPOSABLE) await env.cleanShares(); });
after(async () => {
  if (env.DISPOSABLE) {
    await env.cleanShares();
    await restore();
  }
  await stopHttp({});
});

const create = (who, over = {}, key) => http.call(who, 'POST', '/dlp/share-links', env.body(contract, over), { 'Idempotency-Key': key || env.nextKey('http') });
const publicGet = (token, headers = {}) => fetch(`${http.baseUrl}/public/share/${token}`, { headers });
const tokenOf = (res) => res.body.data.token;

test('m9d823 criar, abrir sem login, revogar e abrir de novo (404) pela API', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const created = await create('gestorA');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, token, url } = created.body.data;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url, `http://127.0.0.1:${process.env.PORT}/api/v1/public/share/${token}`, 'a URL completa vem uma vez');
  assert.equal(created.body.data.status, 'ACTIVE');
  assert.equal(created.headers.get('cache-control'), 'no-store');

  const opened = await publicGet(token);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('cache-control'), 'no-store');
  assert.equal(opened.headers.get('x-robots-tag'), 'noindex');
  assert.ok(opened.headers.get('x-ratelimit-limit') && opened.headers.get('x-ratelimit-remaining'));
  const body = await opened.json();
  assert.equal(body.data.resourceType, 'legal.contract');
  assert.equal(body.data.resource.id, contract.id);
  assert.equal(body.data.resource.totalValue, '***');
  assert.deepEqual(body.data.resource.parties.map((p) => [p.name, p.taxId]), [['***', '***']]);

  const listed = await http.call('gestorA', 'GET', '/dlp/share-links');
  assert.equal(listed.body.data.find((l) => l.id === id).accessCount, 1);
  assert.equal(JSON.stringify(listed.body).includes(token), false);

  const revoked = await http.call('gestorA', 'POST', `/dlp/share-links/${id}/revoke`);
  assert.deepEqual([revoked.status, revoked.body.data.status], [200, 'REVOKED']);
  const gone = await publicGet(token);
  assert.equal(gone.status, 404);
  const goneBody = await gone.json();
  assert.deepEqual([goneBody.error.code, goneBody.error.message], ['GOV_LINK_UNAVAILABLE', 'Link indisponível.']);
  const unknown = await (await publicGet('a'.repeat(43))).json();
  assert.deepEqual({ ...unknown.error, traceId: null }, { ...goneBody.error, traceId: null }, 'inexistente e revogado têm a mesma resposta');
  const audits = await env.auditOf('dlp.share.accessed', id);
  assert.equal(audits.length, 1, 'só o acesso que abriu foi auditado');
  const again = await http.call('gestorA', 'POST', `/dlp/share-links/${id}/revoke`);
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_LINK_ALREADY_FINAL']);
});

test('m9d823 sem Idempotency-Key 400, sem permissão 403, prazo acima do teto 422 e HIGH sem MFA 403', { skip: skip() }, async () => {
  const noKey = await http.call('gestorA', 'POST', '/dlp/share-links', env.body(contract));
  assert.deepEqual([noKey.status, noKey.body.error.code], [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED']);
  const noPerm = await create('leituraA');
  assert.deepEqual([noPerm.status, noPerm.body.error.code], [403, 'PERMISSION_DENIED']);
  await env.revokeMfa(A.userId);
  const noMfa = await create('gestorA');
  assert.deepEqual([noMfa.status, noMfa.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  await env.grantMfa(A);
  const long = await create('gestorA', { expiresInHours: 100 });
  assert.deepEqual([long.status, long.body.error.code, long.body.error.message], [422, 'GOV_LINK_EXPIRY_TOO_LONG', 'O prazo máximo para esta classificação é de 48 horas.']);
  const bad = await create('gestorA', { resourceType: 'finance.entries' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_LINK_RESOURCE_INVALID']);
  const missing = await create('gestorA', { resourceId: '00000000-0000-4000-8000-000000000000' });
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'GOV_NOT_FOUND']);
});

test('m9d823 acesso público excedendo o limite por IP devolve 429', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const created = await create('gestorA');
  const token = tokenOf(created);
  await env.inBusinessTx(A, (tx) => upsertSetting('governanca.api.rate_limit.anonimo_por_minuto', 3, env.tenantOf(A), A.userId, tx));
  await env.adminQuery('DELETE FROM governance.public_access_counters');
  const statuses = [];
  let last;
  for (let i = 0; i < 5; i += 1) { last = await publicGet(token); statuses.push(last.status); }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  const body = await last.json();
  assert.deepEqual([body.error.code, body.error.message], ['GOV_RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.']);
  const retry = Number(last.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60, `Retry-After entre 1 e 60 (veio ${retry})`);
  const garbage = await publicGet('b'.repeat(43));
  assert.equal(garbage.status, 404, 'token que não existe é medido pelo padrão do catálogo (60/min), não pelo limite da empresa; ainda assim conta no contador do IP');
  const { rows } = await env.adminQuery('SELECT sum(hits)::int AS hits FROM governance.public_access_counters');
  assert.equal(rows[0].hits, 6);
});

test('m9d823 link de outra empresa não abre pela sessão da primeira e o contador é compartilhado entre processos (no banco)', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const created = await create('gestorA');
  const foreign = await http.call('gestorB', 'POST', `/dlp/share-links/${created.body.data.id}/revoke`);
  assert.deepEqual([foreign.status, foreign.body.error.code], [404, 'GOV_NOT_FOUND'], 'revogar link de outra empresa: 404');
  const other = await http.call('makerA', 'POST', `/dlp/share-links/${created.body.data.id}/revoke`);
  assert.deepEqual([other.status, other.body.error.code, other.body.error.message], [403, 'GOV_LINK_NOT_OWNER', 'Você não pode revogar este link.']);
  const table = await env.adminQuery("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'governance.public_access_counters'::regclass");
  assert.deepEqual([table.rows[0].relrowsecurity, table.rows[0].relforcerowsecurity], [true, true]);
});

test('m9d823 o token nunca aparece no log da API (abertura, 404 e 429)', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const lines = [];
  const stop = logger.addLogTap((line) => lines.push(line));
  try {
    const created = await create('gestorA');
    const token = tokenOf(created);
    await publicGet(token);
    await http.call('gestorA', 'POST', `/dlp/share-links/${created.body.data.id}/revoke`);
    await publicGet(token);
    await publicGet(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
    assert.ok(lines.some((line) => line.includes('/public/share/')), 'a rota pública foi registrada');
    assert.equal(lines.some((line) => line.includes(token)), false, 'o token em claro não está em nenhuma linha de log');
    assert.ok(lines.some((line) => line.includes('/public/share/[REDACTED]')));
  } finally { stop(); }
});
