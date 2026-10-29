'use strict';

// M9-D030 — POST /v1/ai/agents/:code/chat pelo app real com o provider sandbox: a conversa não vira memória (AI-010), agente
// inexistente (404) e desabilitado (409), conversationId como agrupador de runs que expira em ia.chat.conversa_validade_horas.
// Só no cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaRunApiEnv');

let env; let tenant; let code;
const VALIDADE = 'ia.chat.conversa_validade_horas';
const chat = (quem, agente, corpo) => env.call('POST', `/ai/agents/${agente}/chat`, env.tokens[quem], corpo);
const definir = async (chave, valor) => assert.equal((await env.call('PUT', `/settings/${chave}`, env.tokens['A:gestor'], { value: valor })).status, 200, chave);
const contar = async (sql, params) => Number((await H.admin(sql, params)).rows[0].n);
/** Envelhece os runs da conversa (superusuário do cluster descartável, sem os gatilhos de imutabilidade). */
const envelhecer = (conversationId, horas) => H.envelhecerRuns(conversationId, horas);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D030_CHAT_TEST_PORT) || 21931));
  code = await H.agenteAtivo(env, tenant, { tools: ['crm.getOpportunity'] });
});
after(async () => { await H.encerrar(env, []); });

test('m9d030_chat_nao_grava_memoria', { skip: SKIP }, async () => {
  const memoriasAntes = await contar('SELECT count(*) AS n FROM ai.memories WHERE company_id = $1', [tenant.companyId]);
  const primeira = await chat('A:gestor', code, { message: 'Olá, me chamo Marina e prefiro contato por telefone [[RESPOSTA:Anotado.]]' });
  assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
  const conversa = primeira.body.data.conversationId;
  assert.match(conversa, /^[0-9a-f-]{36}$/);
  const segunda = await chat('A:gestor', code, { message: 'Qual o meu nome? [[RESPOSTA:Não tenho essa informação.]]', conversationId: conversa });
  assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
  assert.equal(segunda.body.data.conversationId, conversa, 'o conversationId agrupa os runs');
  assert.notEqual(segunda.body.data.runId, primeira.body.data.runId);
  assert.equal(await contar('SELECT count(*) AS n FROM ai.ai_runs WHERE conversation_id = $1', [conversa]), 2);
  assert.equal(await contar('SELECT count(*) AS n FROM ai.memories WHERE company_id = $1', [tenant.companyId]), memoriasAntes, 'a conversa não vira memória');
  const lido = await env.call('GET', `/ai/runs/${segunda.body.data.runId}`, env.tokens['A:gestor']);
  assert.equal(lido.body.data.conversationId, conversa);
});

test('m9d030_chat_agente_inexistente_404_desabilitado_409_e_validade_parametrizada', { skip: SKIP }, async () => {
  const inexistente = await chat('A:gestor', 'NAO_EXISTE_JAMAIS', { message: 'Oi' });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.body.error.code, 'AI_AGENT_NOT_FOUND');

  await definir('ai.agents.enabled', 'OUTRO_AGENTE');
  try {
    const desabilitado = await chat('A:gestor', code, { message: 'Oi' });
    assert.equal(desabilitado.status, 409);
    assert.equal(desabilitado.body.error.code, 'AI_AGENT_DISABLED');
  } finally { await definir('ai.agents.enabled', '*'); }

  const inicio = await chat('A:gestor', code, { message: 'Bom dia [[RESPOSTA:Bom dia.]]' });
  const conversa = inicio.body.data.conversationId;
  await envelhecer(conversa, 2);
  await definir(VALIDADE, 1);
  try {
    const vencida = await chat('A:gestor', code, { message: 'Continuando', conversationId: conversa });
    assert.equal(vencida.status, 410, JSON.stringify(vencida.body));
    assert.equal(vencida.body.error.code, 'AI_CONVERSATION_EXPIRED');
    assert.equal(vencida.body.error.message, 'Esta conversa expirou. Inicie uma nova conversa.');
    await definir(VALIDADE, 48);
    const viva = await chat('A:gestor', code, { message: 'Continuando [[RESPOSTA:Certo.]]', conversationId: conversa });
    assert.equal(viva.status, 200, 'com a validade maior a mesma conversa segue');
    assert.equal(viva.body.data.conversationId, conversa);
  } finally { await definir(VALIDADE, 24); }
});

test('m9d030_chat_conversa_de_outra_pessoa_404_e_entrada_invalida_400', { skip: SKIP }, async () => {
  const dela = await chat('A:checker', code, { message: 'Oi [[RESPOSTA:Oi.]]' });
  assert.equal(dela.status, 200, JSON.stringify(dela.body));
  const alheia = await chat('A:gestor', code, { message: 'Oi', conversationId: dela.body.data.conversationId });
  assert.equal(alheia.status, 404);
  assert.equal(alheia.body.error.code, 'AI_CONVERSATION_NOT_FOUND');
  for (const message of ['', 'x'.repeat(8001), 5]) {
    const ruim = await chat('A:gestor', code, { message });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.error.code, 'AI_INPUT_INVALID');
  }
  const idInvalido = await chat('A:gestor', code, { message: 'Oi', conversationId: 'nao-e-uuid' });
  assert.equal(idInvalido.status, 400);
  assert.equal(idInvalido.body.error.code, 'AI_INPUT_INVALID');
});
