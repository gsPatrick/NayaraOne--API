'use strict';

// M9-D020 — tabela "Falha por passo", passos 6, 9 e 11: provedor, voltas, tokens, tempo, saída fora do schema, número sem origem e
// aterramento. Também o estado final do run só depois de validar a saída (teste 14) e o escalonamento do roteador dentro do run.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const AppError = require('../../../src/utils/AppError');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { AGORA, definirParametro } = require('../_helpers/iaOrcamento');
const { espiaRegistry } = require('../_helpers/iaEspia');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' }, confidence: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const comSchema = { modelPolicy: { capability: 'chat', maxOutputTokens: 800, cacheableTaskTypes: [], outputSchema: SCHEMA } };

test('m9d020_tabela_falha_passo_6_provedor_fallback_e_tempo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    H.falhou(await H.rodar(c, 'Classifique [[FALHA:UNAVAILABLE]] [[RESPOSTA:ok]]', { taskType: 'classificar' }), 503, 'AI_PROVIDER_UNAVAILABLE', 'FAILED');
    // Limite do fornecedor: também indisponível para o usuário (503) quando não há fallback.
    H.falhou(await H.rodar(c, 'Classifique [[FALHA:RATE_LIMIT]] [[RESPOSTA:ok]]', { taskType: 'classificar' }), 503, 'AI_PROVIDER_UNAVAILABLE', 'FAILED');
    // Sem fallback seguro (o seletor da D013 recusa): 503 AI_FALLBACK_UNSAFE, run FAILED.
    const inseguro = await H.cenario(tenantA, tx, { deps: { fallbackSelector: async () => { throw new AppError('A NAY não está disponível agora. Nenhuma ação foi executada.', 503, 'AI_FALLBACK_UNSAFE'); } } });
    const r = H.falhou(await H.rodar(inseguro, 'Classifique [[FALHA:UNAVAILABLE]] [[RESPOSTA:ok]]', { taskType: 'classificar' }), 503, 'AI_FALLBACK_UNSAFE', 'FAILED');
    assert.equal((await H.lerRun(r.runId, tx)).error_code, 'AI_FALLBACK_UNSAFE');
    // Tempo estourado numa volta: 504 AI_RUN_TIMEOUT. O sandbox simula a latência contra o timeout do pedido (30.000 ms por padrão).
    const t = H.falhou(await H.rodar(c, 'Classifique [[LENTO:31000]] [[RESPOSTA:ok]]', { taskType: 'classificar' }), 504, 'AI_RUN_TIMEOUT', 'FAILED');
    assert.equal(t.error.message, 'A NAY demorou demais para responder. Tente novamente.');
  });
});

test('m9d020_fallback_seguro_registra_o_salto_no_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry({ falharNa: 1, kind: 'UNAVAILABLE' });
    const c = await H.cenario(tenantA, tx, {
      deps: { registry, fallbackSelector: async ({ decision }) => ({ ...decision, provider: 'ai-sandbox', model: 'sandbox-1' }) },
    });
    const res = await H.rodar(c, 'Classifique [[RESPOSTA:Tipo comercial.]]', { taskType: 'classificar' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(pedidos.length, 2, 'a segunda tentativa aconteceu');
    const run = await H.lerRun(res.runId, tx);
    assert.deepEqual(run.fallback_trail, [{ from: 'ai-sandbox/sandbox-1', to: 'ai-sandbox/sandbox-1', reason: 'UNAVAILABLE' }]);
  });
});

test('m9d020_limite_de_voltas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await definirParametro(tenantA, 'ia.agente.max_voltas', 2, tx);
    const pede = `[[TOOL!:crm.getOpportunity:{"opportunityId":"${c.opp.id}"}]]`;
    const res = H.falhou(await H.rodar(c, `Resuma ${pede}`), 422, 'AI_MAX_TURNS_EXCEEDED', 'FAILED');
    assert.equal(res.error.message, 'A NAY não conseguiu concluir dentro do limite de etapas.');
    assert.equal((await H.chamadas(res.runId, tx)).length, 2, 'só as duas voltas permitidas executaram tool');
  });
});

test('m9d020_quinta_volta_falha_422_max_voltas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { limit: '100.00' });
    const pede = `[[TOOL!:crm.getOpportunity:{"opportunityId":"${c.opp.id}"}]]`;
    const res = H.falhou(await H.rodar(c, `Resuma ${pede} [[CUSTO:1]]`), 422, 'AI_MAX_TURNS_EXCEEDED', 'FAILED');
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.status, 'FAILED');
    assert.equal(run.error_code, 'AI_MAX_TURNS_EXCEEDED');
    assert.equal((await H.chamadas(res.runId, tx)).length, 4, 'quatro voltas (padrão ia.agente.max_voltas) e nenhuma tool nova na quinta');
    assert.equal(res.trace.filter((s) => s.step === 6).length, 5, 'cinco gerações do modelo');
    const orc = await H.orcamentoDe(c.code, tx);
    assert.equal(Number(orc.reserved_amount), 0, 'reserva liberada');
    assert.equal(Number(orc.consumed_amount), 5, 'as cinco chamadas gastaram R$ 1,00 cada');
    assert.equal(Number(run.cost_amount), 5);
  });
});

test('m9d020_limite_de_tokens_do_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await definirParametro(tenantA, 'ia.agente.max_tokens_run', 100, tx);
    const longo = `${'contexto longo da consulta '.repeat(30)}${H.pedirOportunidade(c)} [[RESPOSTA:ok [1].]]`;
    const res = H.falhou(await H.rodar(c, longo), 422, 'AI_TOKEN_LIMIT_EXCEEDED', 'FAILED');
    assert.equal(res.error.message, 'A NAY atingiu o limite de processamento desta consulta.');
    const run = await H.lerRun(res.runId, tx);
    assert.ok(run.tokens_in > 100, 'os tokens acumulados passaram do teto');
    assert.equal(run.status, 'FAILED');
  });
});

test('m9d020_timeout_total', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    let agora = AGORA.getTime();
    const c = await H.cenario(tenantA, tx, { deps: { clock: () => agora, onSpan: (e) => { if (e.event === 'end' && e.step === 6) agora += 6000; } } });
    await definirParametro(tenantA, 'ia.agente.timeout_total_ms', 5000, tx);
    const res = H.falhou(await H.rodar(c, `Resuma ${H.pedirOportunidade(c)} [[RESPOSTA:ok [1].]]`), 504, 'AI_RUN_TIMEOUT', 'FAILED');
    assert.equal((await H.lerRun(res.runId, tx)).error_code, 'AI_RUN_TIMEOUT');
  });
});

test('m9d020_estado_final_so_apos_validar_saida', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const vistos = [];
    const c = await H.cenario(tenantA, tx, { agentOver: comSchema });
    c.orch.deps.onSpan = async (e) => {
      if (e.runId) vistos.push(`${e.event}:${e.step}:${(await H.lerRun(e.runId, tx)).status}`);
    };
    // Saída fora do schema nas duas tentativas: o run nunca esteve COMPLETED e termina FAILED com 422.
    const ruim = H.falhou(await H.rodar(c, 'Responda [[JSON:{"outra":"coisa"}]]'), 422, 'AI_OUTPUT_INVALID', 'FAILED');
    assert.equal(vistos.some((v) => v.endsWith('COMPLETED')), false, 'nunca COMPLETED antes do fim da validação');
    assert.ok(vistos.includes('start:11:RUNNING'), 'ao começar o passo 11 o run ainda está RUNNING');
    assert.equal((await H.lerRun(ruim.runId, tx)).status, 'FAILED');
    assert.equal(ruim.error.message, 'A NAY não conseguiu produzir uma resposta válida.');
    assert.equal(ruim.trace.filter((s) => s.step === 6).length, 2, 'uma nova tentativa de geração (volta ao passo 6)');
    assert.equal(ruim.trace.filter((s) => s.step === 10).length, 2, 'o custo extra é acrescentado no passo 10 seguinte');
    // Saída válida: RUNNING durante o passo 11 e COMPLETED só ao fim.
    vistos.length = 0;
    const boa = await H.rodar(c, 'Responda [[JSON:{"answer":"Tudo certo.","confidence":0.9}]]', { taskType: 'conversa' });
    assert.equal(boa.ok, true, JSON.stringify(boa.error));
    assert.ok(vistos.includes('start:11:RUNNING'));
    assert.ok(vistos.includes('end:11:COMPLETED'));
    assert.equal(boa.answer.includes('Tudo certo.'), true);
  });
});

test('m9d020_saida_valida_de_primeira_nao_regera', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Saída que obedece ao schema de primeira: uma só geração, sem nova tentativa.
    const { registry, pedidos } = espiaRegistry();
    const c = await H.cenario(tenantA, tx, { agentOver: comSchema, deps: { registry } });
    const res = await H.rodar(c, 'Responda [[JSON:{"answer":"Ok","confidence":0.8}]]');
    assert.equal(res.ok, true);
    assert.equal(pedidos.length, 1, 'saída válida de primeira: sem nova tentativa');
  });
});

test('m9d020_escalonamento_do_roteador_dentro_do_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await H.cenario(tenantA, tx, { agentOver: comSchema, limit: '100.00', deps: { registry } });
    // Confiança 0,2 (< 0,6): o pequeno escala UMA vez para o avançado; o custo das duas chamadas fica no run.
    const res = await H.rodar(c, 'Classifique [[JSON:{"answer":"Tipo comercial","confidence":0.2}]]', { taskType: 'classificar' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual(pedidos.map((p) => p.model), ['sandbox-1', 'sandbox-advanced-1']);
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.escalated, true);
    assert.equal(run.routing_path, 'ADVANCED_MODEL');
    assert.equal(run.model_code, 'sandbox-advanced-1');
    // Com o parâmetro Desligado não escala.
    await definirParametro(tenantA, 'ia.router.escalonar_para_avancado', false, tx);
    const sem = await H.rodar(c, 'Classifique [[JSON:{"answer":"Tipo comercial","confidence":0.2}]]', { taskType: 'classificar' });
    assert.equal((await H.lerRun(sem.runId, tx)).escalated, false);
  });
});

test('m9d020_tabela_falha_passo_11_numero_sem_origem_e_fato_sem_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const fin = await H.cenario(tenantA, tx, { tools: ['finance.getWeeklyHealth'], perms: [...H.PERMS, 'finance:read'] });
    const pede = '[[TOOL:finance.getWeeklyHealth:{}]]';
    // Número que não vem do read model: regerado uma vez e, persistindo, 422 AI_NUMBER_NOT_FROM_SOURCE.
    const r1 = H.falhou(await H.rodar(fin, `Qual a inadimplência? ${pede} [[RESPOSTA:A inadimplência é R$ 999,00 [1].]]`), 422, 'AI_NUMBER_NOT_FROM_SOURCE', 'FAILED');
    assert.equal(r1.trace.filter((s) => s.step === 6).length, 3, 'a volta da tool, a resposta e uma regeração');
    // O número escrito pelo servidor (placeholder do read model) passa.
    const r2 = await H.rodar(fin, `Qual a inadimplência? ${pede} [[RESPOSTA:A inadimplência é {{num:inadimplencia_valor}} [1].]]`);
    assert.equal(r2.ok, true, JSON.stringify(r2.error));
    assert.match(r2.answer, /R\$ 0,00/);
    assert.equal(r2.groundingStatus, 'GROUNDED');
    // Fato sem fonte com `ia.grounding.bloquear_sem_fonte` Ligado: 422 AI_UNGROUNDED_FACT.
    const c = await H.cenario(tenantA, tx);
    await definirParametro(tenantA, 'ia.grounding.bloquear_sem_fonte', true, tx);
    H.falhou(await H.rodar(c, 'Qual o prazo? [[RESPOSTA:O prazo é de 30 dias [1].]]'), 422, 'AI_UNGROUNDED_FACT', 'FAILED');
  });
});
