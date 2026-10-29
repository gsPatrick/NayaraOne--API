'use strict';

// M9-D019 — POST /v1/ai/recommendations/:id/accept|reject pelo app real: aprovador distinto, aceite por outra pessoa, replay, snapshot
// mudado (409 gravado), permissões e isolamento entre empresas. Só no cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');
const { withTenantTransaction } = require('../../testHelpers');
const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
const { propor } = require('../_helpers/iaAprovacaoFluxo');
const { contar } = require('../_helpers/iaAprovacao');

let env; let tenant; let gestorId; let checkerId;
const PAGAR = 'ia.financeira.permitir_proposta_pagamento';

async function usuario(tenantKey, perfil) {
  const r = await admin(
    `SELECT u.id, m.group_id, m.company_id FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id AND m.status = 'ACTIVE' WHERE u.email = $1 LIMIT 1`, [emailFor(tenantKey, perfil)]
  );
  return { id: r.rows[0].id, groupId: r.rows[0].group_id, companyId: r.rows[0].company_id };
}

before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'ai:approve', 'settings:read', 'settings:update', 'crm:tasks:create']);
  await grant('CI CHECKER', ['ai:read', 'ai:approve']);
  await grant('CI LEITURA', ['ai:read', 'ai:approve']);
  await grant('CI MAKER', ['ai:read']);
  env = await startHttpEnv(Number(process.env.M9D019_HTTP_TEST_PORT) || 21919, [['A', 'gestor'], ['A', 'checker'], ['A', 'leitura'], ['A', 'maker'], ['B', 'gestor']]);
  const g = await usuario('A', 'gestor');
  gestorId = g.id; checkerId = (await usuario('A', 'checker')).id;
  tenant = { groupId: g.groupId, companyId: g.companyId, userId: g.id };
  for (const chave of ['ia.habilitada', PAGAR]) assert.equal((await env.call('PUT', `/settings/${chave}`, env.tokens['A:gestor'], { value: true })).status, 200, chave);
  assert.equal((await env.call('PUT', '/settings/ia.habilitada', env.tokens['B:gestor'], { value: true })).status, 200, 'NAY ligada na empresa B');
});
after(async () => {
  if (!env) return;
  await env.call('PUT', `/settings/${PAGAR}`, env.tokens['A:gestor'], { value: false });
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['B:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

const novaProposta = () => withTenantTransaction(tenant, async (tx) => {
  const { c, id } = await propor(tenant, tx, { solicitante: gestorId });
  return { c, id };
});
const accept = (id, quem, body = {}) => env.call('POST', `/ai/recommendations/${id}/accept`, env.tokens[quem], body);
const reject = (id, quem, body) => env.call('POST', `/ai/recommendations/${id}/reject`, env.tokens[quem], body);
const intents = (c) => withTenantTransaction(tenant, (tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx));

test('m9d019_http_aprovador_distinto_aceite_por_outra_pessoa_e_replay', { skip: SKIP }, async () => {
  const { c, id } = await novaProposta();
  const proprio = await accept(id, 'A:gestor');
  assert.equal(proprio.status, 403);
  assert.equal(proprio.body.error.code, 'AI_APPROVAL_SELF_BLOCKED');
  assert.equal(await intents(c), 0, 'o lançamento só é afetado depois do aceite');
  const ok = await accept(id, 'A:checker');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.replayed, false);
  assert.equal(ok.body.data.outcome, 'EXECUTED');
  assert.equal(await intents(c), 1);
  const replay = await accept(id, 'A:checker');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.replayed, true);
  assert.equal(await intents(c), 1, 'replay não executa de novo');
  const outro = await accept(id, 'A:gestor');
  assert.equal(outro.status, 409);
  assert.equal(outro.body.error.code, 'AI_RECOMMENDATION_STATE');
});

test('m9d019_http_snapshot_mudado_409_gravado_e_rejeicao', { skip: SKIP }, async () => {
  const velha = await novaProposta();
  await admin("UPDATE finance.financial_entries SET status = 'PAID' WHERE id = $1", [velha.c.entry.id]);
  const stale = await accept(velha.id, 'A:checker');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'AI_PROPOSAL_STALE');
  const gravado = await admin('SELECT status FROM ai.ai_recommendations WHERE id = $1', [velha.id]);
  assert.equal(gravado.rows[0].status, 'STALE', 'o STALE sobrevive ao 409');
  assert.equal((await accept(velha.id, 'A:checker')).body.error.code, 'AI_RECOMMENDATION_STATE');
  assert.equal(await intents(velha.c), 0);

  const rej = await novaProposta();
  const semMotivo = await reject(rej.id, 'A:checker', {});
  assert.equal(semMotivo.status, 400);
  const ok = await reject(rej.id, 'A:checker', { reason: 'Não é este boleto.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.recommendation.status, 'REJECTED');
  assert.equal(await intents(rej.c), 0);
  const aposRejeitar = await accept(rej.id, 'A:checker');
  assert.equal(aposRejeitar.status, 409);
  assert.equal(aposRejeitar.body.error.code, 'AI_RECOMMENDATION_STATE');
});

test('m9d019_http_permissoes_e_isolamento_entre_empresas', { skip: SKIP }, async () => {
  const { c, id } = await novaProposta();
  const semAprovar = await accept(id, 'A:maker');
  assert.equal(semAprovar.status, 403);
  assert.equal(semAprovar.body.error.code, 'PERMISSION_DENIED');
  const semAcao = await accept(id, 'A:leitura');
  assert.equal(semAcao.status, 403);
  assert.equal(semAcao.body.error.code, 'AI_PERMISSION_DENIED');
  assert.equal((await env.call('POST', `/ai/recommendations/${id}/accept`, null, {})).status, 401);
  const outraEmpresa = await accept(id, 'B:gestor');
  assert.equal(outraEmpresa.status, 404, 'empresa B não enxerga a proposta da A');
  assert.equal(await intents(c), 0);
  assert.equal((await accept('nao-e-uuid', 'A:checker')).status, 404);
  assert.equal(checkerId !== gestorId, true);
});
