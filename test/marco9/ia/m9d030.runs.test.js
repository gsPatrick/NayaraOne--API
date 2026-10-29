'use strict';

// M9-D030 — POST /v1/ai/runs e GET /v1/ai/runs/:id pelo app real com o provider sandbox: caminho feliz com fontes, idempotência, 202 do run
// longo, agente inexistente, rate limit, run de outra pessoa, empresa B, entrada inválida e o contrato da resposta.
// Só no cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaRunApiEnv');

let env; let tenant; let opp; let code;
const SINCRONO = 'ia.run.sincrono_max_ms';
const post = (quem, corpo) => env.call('POST', '/ai/runs', env.tokens[quem], corpo);
const corpo = (extra = {}) => ({ agentCode: code, purpose: 'Resumo da oportunidade', input: H.pedidoComFonte(opp.id), ...extra });
const contar = async (sql, params) => Number((await H.admin(sql, params)).rows[0].n);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D030_RUNS_TEST_PORT) || 21930));
  opp = (await H.criarOportunidadeCommitada(tenant)).opp;
  code = await H.agenteAtivo(env, tenant, { tools: ['crm.getOpportunity'] });
});
after(async () => { await H.encerrar(env, []); });

test('m9d030_post_runs_sincrono_ok', { skip: SKIP }, async () => {
  const res = await post('A:gestor', corpo());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.match(d.runId, /^[0-9a-f-]{36}$/);
  assert.equal(d.status, 'COMPLETED');
  assert.equal(d.groundingStatus, 'GROUNDED');
  assert.ok(d.answer.includes('estágio'));
  assert.ok(d.sources.length >= 1);
  const lido = await env.call('GET', `/ai/runs/${d.runId}`, env.tokens['A:gestor']);
  assert.equal(lido.status, 200);
  assert.equal(lido.body.data.status, 'COMPLETED');
  assert.equal(lido.body.data.agentCode, code);
});

test('m9d030_idempotency_key_mesmo_run', { skip: SKIP }, async () => {
  const chave = `idem-${Date.now()}`;
  const a = await post('A:gestor', corpo({ idempotencyKey: chave }));
  const b = await post('A:gestor', corpo({ idempotencyKey: chave }));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.data.runId, a.body.data.runId);
  assert.equal(b.body.data.replayed, true);
  assert.equal(a.body.data.replayed, false);
  assert.deepEqual(b.body.data.cost, a.body.data.cost, 'o custo não duplica');
  assert.equal(await contar('SELECT count(*) AS n FROM ai.ai_runs WHERE idempotency_key = $1', [chave]), 1);
  assert.equal(await contar('SELECT count(*) AS n FROM ai.tool_calls WHERE run_id = $1', [a.body.data.runId]), 1, 'a tool não roda de novo');
  const outro = await post('A:gestor', corpo({ idempotencyKey: chave, input: 'Outro pedido' }));
  assert.equal(outro.status, 409);
  assert.equal(outro.body.error.code, 'AI_RUN_IDEMPOTENCY_CONFLICT');
});

test('m9d030_run_longo_devolve_202', { skip: SKIP }, async () => {
  assert.equal((await env.call('PUT', `/settings/${SINCRONO}`, env.tokens['A:gestor'], { value: 1 })).status, 200);
  try {
    const res = await post('A:gestor', corpo());
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'RUNNING');
    const lido = await H.aguardarRun(env, env.tokens['A:gestor'], res.body.data.runId);
    assert.equal(lido.status, 200, 'o run aberto já é visível para a consulta');
    assert.equal(lido.body.data.status, 'COMPLETED', 'o run termina depois da resposta 202');
    assert.ok(lido.body.data.finishedAt);
  } finally {
    await env.call('PUT', `/settings/${SINCRONO}`, env.tokens['A:gestor'], { value: 25000 });
  }
});

test('m9d030_agente_inexistente_404', { skip: SKIP }, async () => {
  const res = await post('A:gestor', corpo({ agentCode: 'NAO_EXISTE_JAMAIS' }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'AI_AGENT_NOT_FOUND');
  assert.equal(res.body.error.message, 'Agente não encontrado.');
});

test('m9d030_rate_limit_429', { skip: SKIP }, async () => {
  const limitado = await H.agenteAtivo(env, tenant, { limits: { max_runs_por_minuto_usuario: 2 } });
  const pedido = { agentCode: limitado, purpose: 'Taxa', input: 'Olá [[RESPOSTA:Olá.]]' };
  assert.equal((await post('A:gestor', pedido)).status, 200);
  assert.equal((await post('A:gestor', pedido)).status, 200);
  const terceira = await post('A:gestor', pedido);
  assert.equal(terceira.status, 429, JSON.stringify(terceira.body));
  assert.equal(terceira.body.error.code, 'AI_RATE_LIMITED');
  assert.equal(terceira.body.error.message, 'Muitas consultas em pouco tempo. Aguarde um instante.');
});

test('m9d030_run_de_outro_usuario_404_sem_audit', { skip: SKIP }, async () => {
  const feito = await post('A:checker', corpo());
  assert.equal(feito.status, 200, JSON.stringify(feito.body));
  const id = feito.body.data.runId;
  const dono = await env.call('GET', `/ai/runs/${id}`, env.tokens['A:checker']);
  assert.equal(dono.status, 200);
  const outro = await env.call('GET', `/ai/runs/${id}`, env.tokens['A:maker']);
  assert.equal(outro.status, 404);
  assert.equal(outro.body.error.code, 'AI_RUN_NOT_FOUND');
  assert.equal(outro.body.error.message, 'Execução não encontrada.');
  const auditor = await env.call('GET', `/ai/runs/${id}`, env.tokens['A:gestor']);
  assert.equal(auditor.status, 200, 'ai:audit lê o run de outra pessoa');
  assert.equal((await env.call('GET', `/ai/runs/${id}`, env.tokens['A:leitura'])).status, 403);
});

test('m9d030_empresa_b_404', { skip: SKIP }, async () => {
  const feito = await post('A:gestor', corpo());
  const lidoPelaB = await env.call('GET', `/ai/runs/${feito.body.data.runId}`, env.tokens['B:gestor']);
  assert.equal(lidoPelaB.status, 404);
  assert.equal(lidoPelaB.body.error.code, 'AI_RUN_NOT_FOUND');
  const daB = await env.call('POST', '/ai/runs', env.tokens['B:gestor'], corpo());
  assert.equal(daB.status, 404, 'o agente da empresa A não existe para a B');
  assert.equal(daB.body.error.code, 'AI_AGENT_NOT_FOUND');
});

test('m9d030_entrada_invalida_400', { skip: SKIP }, async () => {
  const mensagem = 'Informe uma mensagem de até 8.000 caracteres.';
  for (const input of ['', '   ', 'x'.repeat(8001), 123, null, undefined]) {
    const res = await post('A:gestor', corpo({ input }));
    assert.equal(res.status, 400, `input ${String(input).slice(0, 10)}`);
    assert.equal(res.body.error.code, 'AI_INPUT_INVALID');
    assert.equal(res.body.error.message, mensagem);
  }
  assert.equal((await post('A:gestor', corpo({ input: 'x'.repeat(8000) }))).status, 200, '8.000 caracteres é aceito');
  const antes = await contar('SELECT count(*) AS n FROM ai.ai_runs WHERE company_id = $1', [tenant.companyId]);
  const semFinalidade = await post('A:gestor', corpo({ purpose: '  ' }));
  assert.equal(semFinalidade.status, 400);
  assert.equal(semFinalidade.body.error.code, 'AI_PURPOSE_REQUIRED');
  const contexto = await post('A:gestor', corpo({ context: { entityType: 'crm.opportunity' } }));
  assert.equal(contexto.status, 400);
  assert.equal(contexto.body.error.code, 'AI_INPUT_INVALID');
  assert.equal(await contar('SELECT count(*) AS n FROM ai.ai_runs WHERE company_id = $1', [tenant.companyId]), antes, 'entrada inválida não cria run');
});

test('m9d030_resposta_traz_fontes_confianca_snapshot', { skip: SKIP }, async () => {
  const res = await post('A:gestor', corpo({ context: { entityType: 'crm.opportunity', entityId: opp.id } }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  for (const campo of ['runId', 'status', 'answer', 'sources', 'groundingStatus', 'confidence', 'snapshotAt', 'proposals', 'cost', 'routingPath']) assert.ok(campo in d, campo);
  assert.equal(typeof d.confidence, 'number');
  assert.ok(!Number.isNaN(Date.parse(d.snapshotAt)));
  assert.equal(d.cost.currency, 'BRL');
  assert.match(d.cost.amount, /^\d+\.\d{6}$/);
  assert.ok(['RULE', 'SMALL_MODEL', 'ADVANCED_MODEL', 'CACHE'].includes(d.routingPath));
  assert.deepEqual(d.proposals, []);
  const fonte = d.sources[0];
  for (const campo of ['ref', 'type', 'title', 'classification', 'retrievedAt']) assert.ok(campo in fonte, `fonte.${campo}`);
  const lido = (await env.call('GET', `/ai/runs/${d.runId}`, env.tokens['A:gestor'])).body.data;
  assert.equal(lido.toolCalls.length, 1);
  assert.equal(lido.toolCalls[0].toolName, 'crm.getOpportunity');
  assert.equal(lido.toolCalls[0].status, 'SUCCEEDED');
  assert.deepEqual(lido.blockEvents, []);
  assert.equal(lido.cost.currency, 'BRL');
  assert.ok(lido.sources.length >= 1);
});
