'use strict';

// M9-D046 — GET/POST /v1/ai/release-gates e a trava de PUT /v1/settings/ia.ambiente pelo app real: permissão ai:admin, 409 do portão incompleto,
// 403 da aprovação final pela mesma pessoa, idempotência e produção liberada com o portão completo. Só no cluster descartável (nunca MFA).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin, grant } = require('../_helpers/aiHttpEnv');
const { subir, encerrar } = require('../_helpers/iaRotasEnv');
const { emailFor } = require('../../../scripts/seed-ci-two-tenants');

const PORTA = Number(process.env.M9D046_HTTP_TEST_PORT) || 21946;
let env; let tenant;
before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await subir(PORTA));
  await grant('CI CHECKER', ['ai:admin', 'settings:read', 'settings:update']);
  // As permissões entram no token no login: a segunda pessoa com ai:admin entra de novo depois da concessão (login normal, sem MFA).
  const res = await fetch(`http://127.0.0.1:${PORTA}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', 'checker'), password: process.env.CI_TENANT_USERS_PASSWORD }),
  });
  assert.equal(res.status, 200);
  env.tokens['A:checker'] = (await res.json()).data.accessToken;
  await admin('DELETE FROM ai.release_gates WHERE group_id = $1', [tenant.groupId]);
});
after(async () => {
  if (DISPOSABLE && tenant) await admin('DELETE FROM ai.release_gates WHERE group_id = $1', [tenant.groupId]);
  await encerrar(env, []);
});

const T = (quem) => env.tokens[quem];
const gate = (quem, body, headers) => env.call('POST', '/ai/release-gates', T(quem), body, headers);

test('m9d046_http_portao_incompleto_409_e_producao_liberada', { skip: SKIP }, async () => {
  assert.equal((await env.call('GET', '/ai/release-gates', T('A:maker'))).status, 403, 'sem ai:admin');
  assert.equal((await gate('A:maker', { item: 'PENTEST' })).status, 403);
  const vazio = await env.call('GET', '/ai/release-gates', T('A:gestor'));
  assert.equal(vazio.status, 200);
  assert.equal(vazio.body.data.environment, 'LAB');
  assert.equal(vazio.body.data.complete, false);
  const recusa = await env.call('PUT', '/settings/ia.ambiente', T('A:gestor'), { value: 'PRODUCAO' });
  assert.equal(recusa.status, 409);
  assert.equal(recusa.body.error.code, 'AI_PRODUCTION_GATE_INCOMPLETE');
  assert.match(recusa.body.error.message, /^Faltam aprovações para liberar a NAY em produção: .*PENTEST/);
  for (const item of ['DEV_DEPLOY', 'LAB_VALIDATION', 'RED_TEAM', 'PENTEST', 'PRIVACY_REVIEW']) {
    const r = await gate('A:gestor', { item, status: 'APPROVED', evidenceRef: 'QA-M9 evidência' }, { 'Idempotency-Key': `d046-${item}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const repetida = await gate('A:gestor', { item: 'PENTEST', status: 'REJECTED' }, { 'Idempotency-Key': 'd046-PENTEST' });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.body.data.status, 'APPROVED');
  assert.equal(repetida.body.meta.replayed, true);
  // Agentes e provedores que outros testes deixaram ativos na empresa também precisam da sua aprovação.
  const faltando = (await env.call('GET', '/ai/release-gates', T('A:gestor'))).body.data.missing.map((m) => /^(AGENT_EVALUATION|PROVIDER_REVIEW) \((.+)\)$/.exec(m)).filter(Boolean);
  for (const [, item, ref] of faltando) assert.equal((await gate('A:gestor', { item, scopeRef: ref, status: 'APPROVED' })).status, 201);
  const mesma = await gate('A:gestor', { item: 'PRODUCTION_APPROVAL', status: 'APPROVED' });
  assert.equal(mesma.status, 403);
  assert.equal(mesma.body.error.code, 'AI_GATE_SELF_APPROVAL_BLOCKED');
  assert.equal(mesma.body.error.message, 'Outra pessoa precisa aprovar a liberação em produção.');
  const outra = await gate('A:checker', { item: 'PRODUCTION_APPROVAL', status: 'APPROVED' });
  assert.equal(outra.status, 201, JSON.stringify(outra.body));
  assert.equal(outra.body.data.approvedBy, (await env.call('GET', '/ai/release-gates?item=PRODUCTION_APPROVAL', T('A:gestor'))).body.data.gates[0].approvedBy);
  const ok = await env.call('PUT', '/settings/ia.ambiente', T('A:gestor'), { value: 'PRODUCAO' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await env.call('PUT', '/settings/ia.ambiente', T('A:gestor'), { value: 'LAB' })).status, 200);
  const outraEmpresa = await env.call('GET', '/ai/release-gates', T('B:gestor'));
  assert.deepEqual(outraEmpresa.body.data.gates, [], 'a empresa B não vê as aprovações da A');
});
