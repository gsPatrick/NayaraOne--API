'use strict';

// M9-D843 — Idempotency-Key pelo middleware padrão, pela API real (banco descartável): repetição, outro corpo, concorrência, falha sem chave, validade, lista fechada e o lote de dados mestres.
process.env.PORT = process.env.M9D843_IDEM_TEST_PORT || '21844';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d843Env');
const exportsEnv = require('../_helpers/exportsEnv');
const bulkEnv = require('../_helpers/m9d808Env');
const { withTenantTransaction } = require('../../testHelpers');
const { IDEMPOTENCY_REQUIRED_ROUTES } = require('../../../src/features/core-governance/api-governance/standards');

const RECORD = 'governance:bcp:record';
const IMPORT = 'governance:bcp:import';
const EXPORT = 'governance:dlp:export';
const BULK = 'governance:data-quality:bulk';
let http;
let A;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let seq = 0;
const key = (label) => { seq += 1; return `m9d843-${label}-${Date.now()}-${seq}`; };
const opBody = async (over = {}) => env.body(A, { evidenceFileId: await env.evidence(A), ...over });
const post = (path, body, k) => http.call('gestorA', 'POST', path, body, k ? { 'Idempotency-Key': k } : {});
const opsWith = async (reference) => Number((await env.adminQuery('SELECT count(*)::int AS n FROM governance.manual_operations WHERE manual_reference = $1', [reference])).rows[0].n);

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.cleanBcp();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'] });
  restore = await env.withRolePermissions({ 'CI GESTOR': { [RECORD]: true, [IMPORT]: true, [EXPORT]: true, [BULK]: true, 'governance:data-quality:read': true } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'] } });
});
after(async () => { if (env.DISPOSABLE) { await env.adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [A.userId]); await env.adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [A.userId]); await env.cleanIdem(); await env.cleanBcp(); await restore(); } await stopHttp({}); });

test('m9d843 mesma chave e mesmo corpo repete a resposta', { skip: skip() }, async () => {
  const body = await opBody();
  const k = key('replay');
  const first = await post('/bcp/manual-operations', body, k);
  assert.ok([200, 201].includes(first.status), JSON.stringify(first.body));
  assert.equal(first.headers.get('idempotent-replay'), null);
  const second = await post('/bcp/manual-operations', body, k);
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body, 'a resposta original');
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  assert.equal(await opsWith(body.manualReference), 1, 'um só efeito');
  const rows = await env.idemRows(A.companyId, '%POST /bcp/manual-operations');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response_status, first.status);
  assert.equal(rows[0].key, k);
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal((await post('/bcp/manual-operations', reordered, k)).headers.get('idempotent-replay'), 'true', 'a ordem dos campos não muda o corpo');
});

test('m9d843 mesma chave com outro corpo devolve 422', { skip: skip() }, async () => {
  const body = await opBody();
  const k = key('reused');
  assert.ok([200, 201].includes((await post('/bcp/manual-operations', body, k)).status));
  const other = await post('/bcp/manual-operations', { ...body, manualReference: env.reference('FIN') }, k);
  assert.equal(other.status, 422);
  assert.equal(other.body.error.code, 'GOV_IDEMPOTENCY_KEY_REUSED');
  assert.equal(other.body.error.message, 'Esta chave de idempotência já foi usada com outra requisição.');
  assert.equal(await opsWith(body.manualReference), 1);
});

test('m9d843 duas chamadas simultâneas com a mesma chave geram um efeito', { skip: skip() }, async () => {
  const body = await opBody();
  const k = key('race');
  const [one, two] = await Promise.all([post('/bcp/manual-operations', body, k), post('/bcp/manual-operations', body, k)]);
  assert.equal(one.status, two.status, JSON.stringify([one.body, two.body]));
  assert.ok([200, 201].includes(one.status));
  assert.equal([one, two].filter((r) => r.headers.get('idempotent-replay') === 'true').length, 1, 'exatamente uma resposta é a repetição');
  assert.deepEqual(one.body, two.body);
  assert.equal(await opsWith(body.manualReference), 1);
});

test('m9d843 chave fora de 8 a 128 caracteres devolve 400 e a falha não consome a chave', { skip: skip() }, async () => {
  const body = await opBody();
  const tooShort = await post('/bcp/manual-operations', body, 'curta');
  assert.deepEqual([tooShort.status, tooShort.body.error.code], [400, 'GOV_IDEMPOTENCY_KEY_INVALID']);
  const k = key('falha');
  const broken = await post('/bcp/manual-operations', { ...body, evidenceFileId: undefined }, k);
  assert.ok(broken.status >= 400, 'o pedido falha');
  assert.equal((await env.idemRows(A.companyId)).filter((r) => r.key === k).length, 0, 'a chave some junto com o efeito desfeito');
  const retry = await post('/bcp/manual-operations', body, k);
  assert.ok([200, 201].includes(retry.status), JSON.stringify(retry.body));
});

test('m9d843 a chave vencida volta a valer como nova', { skip: skip() }, async () => {
  const body = await opBody();
  const k = key('vencida');
  await post('/bcp/manual-operations', body, k);
  await env.adminQuery("UPDATE governance.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE key = $1", [k]);
  const next = await opBody();
  const again = await post('/bcp/manual-operations', next, k);
  assert.ok([200, 201].includes(again.status), JSON.stringify(again.body));
  assert.equal(again.headers.get('idempotent-replay'), null);
  assert.equal(await opsWith(next.manualReference), 1);
});

test('m9d843 as quatro rotas da lista exigem Idempotency-Key', { skip: skip() }, async () => {
  assert.deepEqual([...IDEMPOTENCY_REQUIRED_ROUTES].sort(), ['POST /bcp/manual-operations/import', 'POST /data-quality/bulk-changes', 'POST /dlp/share-links', 'POST /exports']);
  for (const route of IDEMPOTENCY_REQUIRED_ROUTES) {
    const path = route.slice('POST '.length);
    const res = await post(path, {}, null);
    assert.deepEqual([route, res.status, res.body.error.code, res.body.error.message], [route, 400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.']);
  }
  const optional = await post('/bcp/manual-operations', await opBody(), null);
  assert.ok([200, 201].includes(optional.status), 'nas demais criações a chave é opcional');
});

test('m9d843 POST /data-quality/bulk-changes passa pelo middleware padrão sem mudar o contrato HTTP', { skip: skip() }, async () => {
  // Sem endpoint de MFA e sem token forjado: o banco descartável recebe uma credencial habilitada de teste e o passo de verificação recente (como o m9d822).
  await env.adminQuery("DELETE FROM core.mfa_credentials WHERE user_id = $1", [A.userId]);
  await env.adminQuery(`INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, failed_attempts, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'teste-m9d843', true, now(), '{}', 0, now(), now())`, [A.userId, A.groupId, A.companyId]);
  await exportsEnv.grantMfa(A);
  const { city, rows } = await withTenantTransaction(A, (tx) => bulkEnv.properties(A, tx, 2));
  const body = bulkEnv.bulkBody(city, { city: 'Cidade Padrao QA' });
  const k = key('bulk');
  const first = await post('/data-quality/bulk-changes', body, k);
  assert.ok([200, 201, 202].includes(first.status), JSON.stringify(first.body));
  const second = await post('/data-quality/bulk-changes', body, k);
  assert.equal(second.status, first.status);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(second.body, first.body);
  const stored = await env.idemRows(A.companyId, '%POST /data-quality/bulk-changes');
  assert.deepEqual([stored.length, stored[0].key, stored[0].response_status], [1, k, first.status], 'a chave está no registro do middleware padrão');
  const other = await post('/data-quality/bulk-changes', bulkEnv.bulkBody(city, { city: 'Outra Cidade QA' }), k);
  assert.deepEqual([other.status, other.body.error.code], [422, 'GOV_IDEMPOTENCY_KEY_REUSED']);
  assert.ok(rows.length === 2);
});
