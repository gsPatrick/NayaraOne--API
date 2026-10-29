'use strict';

// M9-D825 — POST /dlp/copy-events pela API real (banco descartável): corpo, HTTP e reavaliação da política, sinais e auditoria.
process.env.PORT = process.env.M9D825_COPY_TEST_PORT || '21826';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d825Env');

let http;
before(async () => { http = await env.startDlpHttp(process.env.PORT); });
after(async () => { await env.stopDlpHttp(); });
const event = (over = {}) => ({ resourceType: 'finance.bank_account', resourceId: '9d3b6a0e-0000-4000-8000-000000000001', field: 'accountNumber', outcome: 'DENIED', ...over });
const signalsOf = (tenant, userId) => env.adminQuery('SELECT kind, classification, outcome, count FROM governance.access_signals WHERE company_id = $1 AND user_id = $2 ORDER BY occurred_at', [tenant.companyId, userId]).then((r) => r.rows);
const makerId = async () => (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'")).rows[0].id;

test('m9d825 copy-events exige apenas login e responde 201 com id', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const anon = await fetch(`${http.baseUrl}/dlp/copy-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event()) });
  assert.equal(anon.status, 401);
  const res = await http.call('makerA', 'POST', '/dlp/copy-events', event());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(typeof res.body.data.id, 'string', 'o perfil maker, sem nenhuma permissão de DLP, registra a própria ação');
  const again = await http.call('makerA', 'POST', '/dlp/copy-events', event());
  assert.notEqual(again.body.data.id, res.body.data.id, 'cópia repetida gera novo registro');
});

test('m9d825 negação de RESTRICTED vira auditoria e sinal COPY negado', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const res = await http.call('makerA', 'POST', '/dlp/copy-events', event());
  assert.equal(res.status, 201);
  const audit = (await env.adminQuery("SELECT * FROM audit.audit_log WHERE id = $1", [res.body.data.id])).rows[0];
  assert.deepEqual([audit.action, audit.entity_type], ['governance.dlp.copy.blocked', 'finance.bank_account']);
  assert.equal(audit.before_json.field, 'accountNumber');
  assert.ok(!JSON.stringify(audit).includes(env.ACCOUNT), 'nunca o valor');
  assert.deepEqual((await signalsOf(http.tenants.A, await makerId())).map((r) => [r.kind, r.classification, r.outcome]), [['COPY', 'RESTRICTED', 'DENIED']]);
});

test('m9d825 copy-events ALLOWED para campo RESTRICTED devolve 403 e registra a negação', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const res = await http.call('makerA', 'POST', '/dlp/copy-events', event({ outcome: 'ALLOWED' }));
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [403, 'GOV_DLP_DENIED', 'Este dado não pode ser copiado.']);
  assert.ok(res.body.error.traceId);
  const rows = await signalsOf(http.tenants.A, await makerId());
  assert.deepEqual(rows.map((r) => [r.kind, r.classification, r.outcome]), [['COPY', 'RESTRICTED', 'DENIED']], 'a negação ficou registrada como sinal');
  const blocked = (await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.copy.blocked'", [http.tenants.A.companyId])).rows;
  assert.ok(blocked.length >= 1, 'e na auditoria');
});

test('m9d825 COPY de HIGH é permitido com auditoria e sinal', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const res = await http.call('makerA', 'POST', '/dlp/copy-events', event({ field: 'agency', outcome: 'ALLOWED' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const audit = (await env.adminQuery('SELECT action, after_json FROM audit.audit_log WHERE id = $1', [res.body.data.id])).rows[0];
  assert.equal(audit.action, 'governance.dlp.copy');
  assert.equal(audit.after_json.classification, 'HIGH');
  assert.deepEqual((await signalsOf(http.tenants.A, await makerId())).map((r) => [r.kind, r.classification, r.outcome]), [['COPY', 'HIGH', 'ALLOWED']]);
});

test('m9d825 campo inexistente, corpo inválido e LOW', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const unknown = await http.call('makerA', 'POST', '/dlp/copy-events', event({ field: 'campoQueNaoExiste' }));
  assert.deepEqual([unknown.status, unknown.body.error.code], [400, 'GOV_DLP_POLICY_INVALID']);
  const type = await http.call('makerA', 'POST', '/dlp/copy-events', event({ resourceType: 'tipo.inexistente' }));
  assert.deepEqual([type.status, type.body.error.code], [400, 'GOV_DLP_POLICY_INVALID']);
  for (const bad of [{ outcome: 'TALVEZ' }, { resourceId: '' }, { field: undefined }, { resourceType: undefined }]) {
    const res = await http.call('makerA', 'POST', '/dlp/copy-events', event(bad));
    assert.deepEqual([res.status, res.body.error.code], [400, 'GOV_DLP_REQUEST_INVALID'], JSON.stringify(bad));
  }
  assert.equal((await signalsOf(http.tenants.A, await makerId())).length, 0, 'recusas não geram sinal');
});

test('m9d825 isolamento entre empresas no registro de cópia', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const res = await http.call('gestorB', 'POST', '/dlp/copy-events', event());
  assert.equal(res.status, 201);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.access_signals WHERE company_id = $1', [http.tenants.A.companyId])).rows[0].n, 0);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.access_signals WHERE company_id = $1', [http.tenants.B.companyId])).rows[0].n, 1);
});

test('m9d825 a suspensão por anomalia não atinge VIEW nem COPY', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const maker = await makerId();
  await env.adminQuery('INSERT INTO governance.user_dlp_state (group_id, company_id, user_id, dlp_restricted_until) VALUES ($1,$2,$3, now() + interval \'5 hours\')', [http.tenants.A.groupId, http.tenants.A.companyId, maker]);
  const copy = await http.call('makerA', 'POST', '/dlp/copy-events', event({ field: 'agency', outcome: 'ALLOWED' }));
  assert.equal(copy.status, 201);
  const view = await http.call('makerA', 'GET', '/finance/bank-accounts');
  assert.equal(view.status, 200);
});
