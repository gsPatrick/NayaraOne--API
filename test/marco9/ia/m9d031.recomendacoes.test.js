'use strict';

// M9-D031 — GET /v1/ai/recommendations, GET .../:id, POST .../accept e .../reject pelo app real: escopo da lista, replay do aceite,
// motivo da rejeição, permissões por rota e isolamento entre empresas. Só no cluster descartável (nunca MFA nem token forjado).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin } = require('../_helpers/aiHttpEnv');
const { subir, encerrar } = require('../_helpers/iaRotasEnv');
const { withTenantTransaction } = require('../../testHelpers');
const rec = require('../../../src/features/ai/recommendations');
const { dadosRec } = require('../_helpers/iaRecomendacao');
const { propor } = require('../_helpers/iaAprovacaoFluxo');

let env; let pessoas; let tenant;
const PAGAR = 'ia.financeira.permitir_proposta_pagamento';
before(async () => {
  if (!DISPOSABLE) return;
  ({ env, pessoas, tenant } = await subir(Number(process.env.M9D031_REC_TEST_PORT) || 21931));
  assert.equal((await env.call('PUT', `/settings/${PAGAR}`, env.tokens['A:gestor'], { value: true })).status, 200);
});
after(async () => { await encerrar(env, [PAGAR, 'ia.recomendacao.motivo_rejeicao_obrigatorio']); });

const T = (quem) => env.tokens[quem];
const criar = (targetUserId, extra = {}) => withTenantTransaction(tenant, async (tx) => (await rec.createRecommendation(
  { ...tenant, permissions: ['ai:use'] }, dadosRec({ targetUserId, ...extra }), tx
)).recommendation);
const novaProposta = () => withTenantTransaction(tenant, (tx) => propor(tenant, tx, { solicitante: pessoas.gestor }));

test('m9d031_lista_so_as_dirigidas_ao_usuario', { skip: SKIP }, async () => {
  const paraMaker = await criar(pessoas.maker);
  const paraChecker = await criar(pessoas.checker);
  const maker = await env.call('GET', '/ai/recommendations', T('A:maker'));
  assert.equal(maker.status, 200, JSON.stringify(maker.body));
  const ids = maker.body.data.map((r) => r.id);
  assert.ok(ids.includes(paraMaker.id));
  assert.ok(!ids.includes(paraChecker.id), 'quem só tem ai:read não vê a recomendação dirigida a outra pessoa');
  assert.ok(maker.body.data.every((r) => r.targetUserId === pessoas.maker));
  // auditoria vê a empresa toda
  const gestor = await env.call('GET', '/ai/recommendations?limit=100', T('A:gestor'));
  const todos = gestor.body.data.map((r) => r.id);
  assert.ok(todos.includes(paraMaker.id) && todos.includes(paraChecker.id));
  // filtro por estado, paginação (padrão 20, máximo 100) e ordem por created_at desc
  assert.equal((await env.call('GET', '/ai/recommendations?status=EXECUTED', T('A:gestor'))).body.data.every((r) => r.status === 'EXECUTED'), true);
  assert.equal((await env.call('GET', '/ai/recommendations?status=XYZ', T('A:gestor'))).status, 400);
  const pagina = await env.call('GET', '/ai/recommendations?limit=1&page=1', T('A:gestor'));
  assert.equal(pagina.body.data.length, 1);
  assert.equal(pagina.body.pagination.limit, 1);
  assert.ok(pagina.body.pagination.total >= 2);
  const seguinte = await env.call('GET', '/ai/recommendations?limit=1&page=2', T('A:gestor'));
  assert.notEqual(seguinte.body.data[0].id, pagina.body.data[0].id);
  assert.equal((await env.call('GET', '/ai/recommendations', T('A:gestor'))).body.pagination.limit, 20);
  assert.equal((await env.call('GET', '/ai/recommendations?limit=5000', T('A:gestor'))).body.pagination.limit, 100);
  const datas = gestor.body.data.map((r) => r.createdAt);
  assert.deepEqual(datas, [...datas].sort().reverse());
  // leitura de uma: a dirigida a outra pessoa é 404 para quem só lê as suas
  assert.equal((await env.call('GET', `/ai/recommendations/${paraMaker.id}`, T('A:maker'))).status, 200);
  const alheia = await env.call('GET', `/ai/recommendations/${paraChecker.id}`, T('A:maker'));
  assert.equal(alheia.status, 404); assert.equal(alheia.body.error.code, 'AI_RECOMMENDATION_NOT_FOUND');
  // informativa: o destinatário aceita com ai:read (sem proposta de ação)
  const aceita = await env.call('POST', `/ai/recommendations/${paraMaker.id}/accept`, T('A:maker'), {});
  assert.equal(aceita.status, 200, JSON.stringify(aceita.body));
  assert.equal(aceita.body.data.recommendation.status, 'ACCEPTED');
});

test('m9d031_accept_replay_idempotente', { skip: SKIP }, async () => {
  const { c, id } = await novaProposta();
  const ok = await env.call('POST', `/ai/recommendations/${id}/accept`, T('A:checker'), {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.recommendation.status, 'EXECUTED'); assert.equal(ok.body.data.replayed, false);
  assert.ok(['EXECUTED', 'EXECUTION_FAILED'].includes(ok.body.data.outcome));
  const replay = await env.call('POST', `/ai/recommendations/${id}/accept`, T('A:checker'), { note: 'de novo' });
  assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true);
  const outro = await env.call('POST', `/ai/recommendations/${id}/accept`, T('A:gestor'), {});
  assert.equal(outro.status, 409); assert.equal(outro.body.error.code, 'AI_RECOMMENDATION_STATE');
  const execucoes = await admin('SELECT count(*)::int AS n FROM finance.payment_intents WHERE financial_entry_id = $1', [c.entry.id]);
  assert.ok(execucoes.rows[0].n <= 1, 'o replay não executa de novo');
  // REJECTED e STALE: aceitar depois é 409 AI_RECOMMENDATION_STATE
  const p2 = await novaProposta();
  assert.equal((await env.call('POST', `/ai/recommendations/${p2.id}/reject`, T('A:checker'), { reason: 'Já foi pago por outro meio.' })).status, 200);
  const sobreRejeitada = await env.call('POST', `/ai/recommendations/${p2.id}/accept`, T('A:checker'), {});
  assert.equal(sobreRejeitada.status, 409); assert.equal(sobreRejeitada.body.error.code, 'AI_RECOMMENDATION_STATE');
  const p3 = await novaProposta();
  await admin("UPDATE ai.ai_recommendations SET status = 'STALE' WHERE id = $1", [p3.id]);
  const sobreStale = await env.call('POST', `/ai/recommendations/${p3.id}/accept`, T('A:checker'), {});
  assert.equal(sobreStale.status, 409); assert.equal(sobreStale.body.error.code, 'AI_RECOMMENDATION_STATE');
  // quem pediu a execução não aprova a própria proposta: 403 AI_APPROVAL_SELF_BLOCKED
  const p4 = await novaProposta();
  const proprio = await env.call('POST', `/ai/recommendations/${p4.id}/accept`, T('A:gestor'), {});
  assert.equal(proprio.status, 403); assert.equal(proprio.body.error.code, 'AI_APPROVAL_SELF_BLOCKED');
  // snapshot mudado: o aceite grava STALE e responde 409 AI_PROPOSAL_STALE (a transação é confirmada antes)
  const p5 = await novaProposta();
  await admin("UPDATE finance.financial_entries SET status = 'PAID' WHERE id = $1", [p5.c.entry.id]);
  const desatualizada = await env.call('POST', `/ai/recommendations/${p5.id}/accept`, T('A:checker'), {});
  assert.equal(desatualizada.status, 409); assert.equal(desatualizada.body.error.code, 'AI_PROPOSAL_STALE');
  const lida = await env.call('GET', `/ai/recommendations/${p5.id}`, T('A:gestor'));
  assert.equal(lida.body.data.status, 'STALE');
});

test('m9d031_reject_exige_motivo', { skip: SKIP }, async () => {
  const { id } = await novaProposta();
  for (const corpo of [{}, { reason: '' }, { reason: '   ' }, { reason: 'abc' }, { reason: 'x'.repeat(501) }, { reason: 42 }]) {
    const r = await env.call('POST', `/ai/recommendations/${id}/reject`, T('A:checker'), corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 40));
    assert.equal(r.body.error.code, 'AI_REJECTION_REASON_REQUIRED');
    assert.equal(r.body.error.message, 'Informe o motivo da rejeição.');
  }
  assert.equal((await env.call('GET', `/ai/recommendations/${id}`, T('A:gestor'))).body.data.status, 'PENDING');
  const ok = await env.call('POST', `/ai/recommendations/${id}/reject`, T('A:checker'), { reason: 'Boleto pago por outro meio.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.recommendation.status, 'REJECTED');
  assert.equal((await env.call('POST', `/ai/recommendations/${id}/reject`, T('A:checker'), { reason: 'Boleto pago por outro meio.' })).body.data.replayed, true);
  // o administrador pode tornar o motivo opcional (parâmetro), mas o que vier ainda precisa ter de 5 a 500 caracteres
  assert.equal((await env.call('PUT', '/settings/ia.recomendacao.motivo_rejeicao_obrigatorio', T('A:gestor'), { value: false })).status, 200);
  const outra = await novaProposta();
  assert.equal((await env.call('POST', `/ai/recommendations/${outra.id}/reject`, T('A:checker'), { reason: 'abc' })).body.error.code, 'AI_REJECTION_REASON_REQUIRED');
  assert.equal((await env.call('POST', `/ai/recommendations/${outra.id}/reject`, T('A:checker'), {})).status, 200);
});

test('m9d031_permissoes_por_rota: recomendações', { skip: SKIP }, async () => {
  const { id } = await novaProposta();
  for (const [metodo, rota] of [['GET', '/ai/recommendations'], ['GET', `/ai/recommendations/${id}`], ['POST', `/ai/recommendations/${id}/accept`], ['POST', `/ai/recommendations/${id}/reject`]]) {
    assert.equal((await env.call(metodo, rota)).status, 401, `${metodo} ${rota} sem token`);
  }
  const semLer = await env.call('GET', '/ai/recommendations', T('A:leitura'));
  assert.equal(semLer.status, 403); assert.equal(semLer.body.error.code, 'PERMISSION_DENIED');
  const maker = await env.call('POST', `/ai/recommendations/${id}/accept`, T('A:maker'), {});
  assert.equal(maker.status, 403); assert.equal(maker.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await env.call('POST', `/ai/recommendations/${id}/reject`, T('A:maker'), { reason: 'sem permissão aqui' })).status, 403);
  assert.equal((await env.call('GET', '/ai/recommendations', T('A:gestor'))).status, 200);
});

test('m9d031_empresa_b_404: recomendações', { skip: SKIP }, async () => {
  const { id } = await novaProposta();
  const lista = await env.call('GET', '/ai/recommendations?limit=100', T('B:gestor'));
  assert.equal(lista.status, 200);
  assert.ok(!lista.body.data.some((r) => r.id === id));
  const lida = await env.call('GET', `/ai/recommendations/${id}`, T('B:gestor'));
  assert.equal(lida.status, 404); assert.equal(lida.body.error.code, 'AI_RECOMMENDATION_NOT_FOUND');
  assert.equal((await env.call('POST', `/ai/recommendations/${id}/accept`, T('B:gestor'), {})).status, 404);
  const rejeitar = await env.call('POST', `/ai/recommendations/${id}/reject`, T('B:gestor'), { reason: 'não é da minha empresa' });
  assert.equal(rejeitar.status, 404); assert.equal(rejeitar.body.error.code, 'AI_RECOMMENDATION_NOT_FOUND');
});
