'use strict';

// M9-D031 — GET /v1/ai/budgets (consumo e percentual) e POST /v1/ai/evaluations/run + GET .../:id pelo app real: 202 assíncrono,
// provider de testes por padrão, ciclo avaliar, homologar e ativar, permissões por rota e isolamento entre empresas.
// Só no cluster descartável (nunca MFA nem token forjado).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin } = require('../_helpers/aiHttpEnv');
const { subir, encerrar } = require('../_helpers/iaRotasEnv');
const { codigoNovo } = require('../_helpers/iaAvaliacao');

let env;
const REAL = 'ia.avaliacao.permitir_provider_real';
before(async () => {
  if (!DISPOSABLE) return;
  ({ env } = await subir(Number(process.env.M9D031_ORC_TEST_PORT) || 21932));
});
after(async () => { await encerrar(env, [REAL]); });

const T = (quem) => env.tokens[quem];
const CORPO_AGENTE = {
  purpose: 'Responder sobre pipeline comercial com fontes.', systemPolicy: 'Nunca invente dados. Cite as fontes.', modelPolicy: { capability: 'chat' },
  dataScopes: ['crm.opportunities'], limits: {}, criticality: 'NON_CRITICAL',
  tools: [{ toolName: 'crm.getOpportunity', permissionCode: 'crm:opportunities:read', riskLevel: 'LOW', requiresHumanApproval: false, enabled: true }],
};
async function esperar(id, quem = 'A:gestor') {
  for (let i = 0; i < 60; i += 1) {
    const r = await env.call('GET', `/ai/evaluations/${id}`, T(quem));
    if (['PASSED', 'FAILED', 'ERROR'].includes(r.body.data && r.body.data.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('avaliação não terminou');
}

test('m9d031_budgets_traz_consumo_e_percentual', { skip: SKIP }, async () => {
  const criado = await env.call('POST', '/ai/budgets', T('A:gestor'), { agentCode: 'NAY_COMERCIAL', limitAmount: '200.00' });
  assert.ok([201, 409].includes(criado.status), JSON.stringify(criado.body));
  const lista0 = await env.call('GET', '/ai/budgets', T('A:gestor'));
  const linha = lista0.body.data.find((b) => b.agentCode === 'NAY_COMERCIAL');
  assert.ok(linha, 'orçamento do agente existe');
  await env.call('PUT', `/ai/budgets/${linha.id}`, T('A:gestor'), { limitAmount: '200.00' });
  await admin('UPDATE ai.budgets SET consumed_amount = 80, reserved_amount = 0 WHERE id = $1', [linha.id]);
  const lista = await env.call('GET', '/ai/budgets', T('A:gestor'));
  assert.equal(lista.status, 200);
  const b = lista.body.data.find((x) => x.id === linha.id);
  assert.equal(b.limit, '200.00'); assert.equal(b.consumed, '80.000000'); assert.equal(b.reserved, '0.000000');
  assert.equal(b.pct, '40.00', 'R$ 200,00 com R$ 80,00 consumidos = 40,00%');
  assert.equal(b.consumedPct, '40.00');
  assert.ok(Array.isArray(b.alerts)); assert.ok(b.status);
  // com R$ 100,00 reservados, o consumo continua 40% (a reserva é separada)
  await admin('UPDATE ai.budgets SET reserved_amount = 100 WHERE id = $1', [linha.id]);
  const comReserva = (await env.call('GET', '/ai/budgets', T('A:gestor'))).body.data.find((x) => x.id === linha.id);
  assert.equal(comReserva.reserved, '100.000000'); assert.equal(comReserva.pct, '40.00');
  await admin('UPDATE ai.budgets SET consumed_amount = 0, reserved_amount = 0 WHERE id = $1', [linha.id]);
});

test('m9d031_evaluations_run_202_e_leitura', { skip: SKIP }, async () => {
  const code = codigoNovo();
  const agente = await env.call('POST', `/ai/agents/${code}/versions`, T('A:gestor'), CORPO_AGENTE);
  assert.equal(agente.status, 201, JSON.stringify(agente.body));
  const pedido = await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'all' }, { 'Idempotency-Key': `k-${code}` });
  assert.equal(pedido.status, 202, JSON.stringify(pedido.body));
  const id = pedido.body.data.evaluationRunId;
  assert.ok(id); assert.equal(pedido.body.data.status, 'QUEUED');
  const repetido = await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'all' }, { 'Idempotency-Key': `k-${code}` });
  assert.equal(repetido.status, 202); assert.equal(repetido.body.data.evaluationRunId, id); assert.equal(repetido.body.data.replayed, true);
  const pronta = await esperar(id);
  assert.equal(pronta.body.data.status, 'PASSED', JSON.stringify(pronta.body.data.metrics));
  assert.equal(pronta.body.data.providerCode, 'ai-sandbox');
  assert.ok(pronta.body.data.items.length >= 10);
  assert.ok(pronta.body.data.items.every((i) => typeof i.passed === 'boolean' && i.category));
  assert.equal((await env.call('GET', '/ai/evaluations?agentCode=' + code, T('A:gestor'))).body.data.length, 1);
  // validações do corpo
  assert.equal((await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'tudo' })).status, 400);
  assert.equal((await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: 'NAO_EXISTE_Q', suite: 'all' })).status, 404);

  // Ciclo da AI-015 por HTTP: a versão homologada como versão ainda não ativa sem a homologação humana da avaliação.
  assert.equal((await env.call('POST', `/ai/agents/${code}/versions/1/homologate`, T('A:checker'), { note: 'ok' })).status, 200);
  const semHomolog = await env.call('POST', `/ai/agents/${code}/versions/1/activate`, T('A:gestor'));
  assert.equal(semHomolog.status, 409); assert.equal(semHomolog.body.error.code, 'AI_AGENT_NOT_HOMOLOGATED');
  const proprio = await env.call('POST', `/ai/evaluations/${id}/homologate`, T('A:gestor'), { note: 'eu mesmo' });
  assert.equal(proprio.status, 403); assert.equal(proprio.body.error.code, 'AI_HOMOLOGATION_SELF_BLOCKED');
  const homolog = await env.call('POST', `/ai/evaluations/${id}/homologate`, T('A:checker'), { note: 'conferi os casos' });
  assert.equal(homolog.status, 200, JSON.stringify(homolog.body));
  assert.equal(homolog.body.data.homologationNote, 'conferi os casos');
  const ativa = await env.call('POST', `/ai/agents/${code}/versions/1/activate`, T('A:gestor'));
  assert.equal(ativa.status, 200, JSON.stringify(ativa.body));
  assert.equal(ativa.body.data.status, 'ACTIVE');
  // resultado imutável: o banco recusa mudar a avaliação final
  await assert.rejects(admin("UPDATE ai.evaluations SET status = 'FAILED' WHERE id = $1", [id]), /AI_EVALUATION_IMMUTABLE/);
});

test('m9d031_evaluations_sem_provider_real_por_padrao', { skip: SKIP }, async () => {
  const code = codigoNovo();
  assert.equal((await env.call('POST', `/ai/agents/${code}/versions`, T('A:gestor'), CORPO_AGENTE)).status, 201);
  const recusado = await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'golden', providerCode: 'anbtech' });
  assert.equal(recusado.status, 409); assert.equal(recusado.body.error.code, 'AI_REAL_PROVIDER_EVAL_DISABLED');
  assert.equal(recusado.body.error.message, 'Avaliações usam o provedor de testes nesta empresa.');
  // o provedor de testes pode ser pedido explicitamente
  const sandbox = await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'golden', providerCode: 'ai-sandbox' });
  assert.equal(sandbox.status, 202);
  assert.equal((await esperar(sandbox.body.data.evaluationRunId)).body.data.providerCode, 'ai-sandbox');
  // com o parâmetro ligado, o provedor real ainda precisa estar registrado (a conta real é configuração, D011); 'anbtech' não é adapter nenhum
  assert.equal((await env.call('PUT', `/settings/${REAL}`, T('A:gestor'), { value: true })).status, 200);
  const semAdapter = await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'golden', providerCode: 'anbtech' });
  assert.equal(semAdapter.status, 404); assert.equal(semAdapter.body.error.code, 'AI_PROVIDER_NOT_FOUND');
  assert.equal((await env.call('PUT', `/settings/${REAL}`, T('A:gestor'), { value: false })).status, 200);
  assert.equal((await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'golden', providerCode: 'anbtech' })).status, 409);
});

test('m9d031_permissoes_por_rota: orçamentos e avaliações', { skip: SKIP }, async () => {
  const corpo = { agentCode: 'NAY_COMERCIAL', suite: 'golden' };
  for (const [metodo, rota, body] of [['POST', '/ai/evaluations/run', corpo], ['GET', '/ai/evaluations/00000000-0000-4000-8000-000000000000'], ['GET', '/ai/budgets']]) {
    assert.equal((await env.call(metodo, rota, undefined, body)).status, 401, `${metodo} ${rota} sem token`);
  }
  const maker = await env.call('POST', '/ai/evaluations/run', T('A:maker'), corpo);
  assert.equal(maker.status, 403); assert.equal(maker.body.error.code, 'PERMISSION_DENIED'); assert.equal(maker.body.error.message.startsWith('Você não tem permissão'), true);
  assert.equal((await env.call('GET', '/ai/evaluations/00000000-0000-4000-8000-000000000000', T('A:maker'))).status, 403);
  assert.equal((await env.call('POST', '/ai/evaluations/00000000-0000-4000-8000-000000000000/homologate', T('A:leitura'), {})).status, 403);
  assert.equal((await env.call('GET', '/ai/budgets', T('A:maker'))).status, 403, 'orçamento exige ai:budget ou ai:audit');
  assert.equal((await env.call('GET', '/ai/budgets', T('A:gestor'))).status, 200);
});

test('m9d031_empresa_b_404: avaliações e orçamentos', { skip: SKIP }, async () => {
  const code = codigoNovo();
  assert.equal((await env.call('POST', `/ai/agents/${code}/versions`, T('A:gestor'), CORPO_AGENTE)).status, 201);
  const id = (await env.call('POST', '/ai/evaluations/run', T('A:gestor'), { agentCode: code, suite: 'golden' })).body.data.evaluationRunId;
  await esperar(id);
  const lida = await env.call('GET', `/ai/evaluations/${id}`, T('B:gestor'));
  assert.equal(lida.status, 404); assert.equal(lida.body.error.code, 'AI_EVALUATION_NOT_FOUND');
  const homolog = await env.call('POST', `/ai/evaluations/${id}/homologate`, T('B:gestor'), { note: 'x' });
  assert.equal(homolog.status, 404);
  assert.equal((await env.call('GET', `/ai/evaluations?agentCode=${code}`, T('B:gestor'))).body.data.length, 0);
  const rodar = await env.call('POST', '/ai/evaluations/run', T('B:gestor'), { agentCode: code, suite: 'golden' });
  assert.equal(rodar.status, 404); assert.equal(rodar.body.error.code, 'AI_AGENT_NOT_FOUND');
  const budgetsB = await env.call('GET', '/ai/budgets', T('B:gestor'));
  assert.equal(budgetsB.status, 200);
  assert.ok(!budgetsB.body.data.some((b) => b.consumed === '80.000000'));
});
