'use strict';

// M9-D037 — NAY Obras: fronteira do agente (somente leitura). As quatro proibições do livro são recusadas com 200 e sem modelo, nada
// muda nos dados, nenhuma recomendação nem proposta nasce, e o pedido fora do propósito é recusado com a frase do livro.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { FinancialEntry, MaintenanceCase, Project } = require('../../../src/models');
const { PROHIBITIONS } = require('../../../src/features/ai/agents/nay_obras/obras.policy');
const { getAgentHooks } = require('../../../src/features/ai/agents/agentHooks');
const { finalizeGrounding } = require('../../../src/features/ai/orchestrator/grounding');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { fonteContrato } = require('../_helpers/m9d025Fixtures');
const H = require('../_helpers/m9d037Agente');
const O = require('../_helpers/m9d037Obras');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'construction:read', 'construction:update', 'finance:approve'];
const FORA = 'Isso foge do que este assistente pode fazer.';

/** Cenário com uma obra, um pagamento pendente a empreiteiro e um chamado de garantia; devolve o estado que não pode mudar. */
async function montar(tx) {
  const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
  const obra = await O.criarObra(tenantA, tx, { atrasoDias: 5 });
  const pagamento = await FinancialEntry.create({
    groupId: tenantA.groupId, companyId: tenantA.companyId, entryType: 'DEBIT', nature: 'PAYABLE', status: 'PENDING', amount: 5000, constructionProjectId: obra.id,
    description: 'Medição do empreiteiro (teste)', dueAt: new Date(), createdBy: tenantA.userId, updatedBy: tenantA.userId,
  }, { transaction: tx });
  const garantia = await O.garantia(tenantA, tx, obra.id);
  return { c, obra, pagamento, garantia };
}

async function estado(tx, { obra, pagamento, garantia }) {
  const [p, f, g] = await Promise.all([Project.findByPk(obra.id, { transaction: tx }), FinancialEntry.findByPk(pagamento.id, { transaction: tx }), MaintenanceCase.findByPk(garantia.id, { transaction: tx })]);
  return {
    prazo: String(p.endsAtPlanned), orcamento: String(p.budgetAmount), statusObra: p.status, pagamento: f.status, pagamentoValor: String(f.amount), garantia: g.status,
    medicoes: await H.contar('SELECT count(*)::int AS n FROM construction.stage_measurements', {}, tx),
    lancamentos: await H.contar('SELECT count(*)::int AS n FROM finance.financial_entries WHERE construction_project_id = :id', { id: obra.id }, tx),
    recomendacoes: await H.contar('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx),
    aprovacoes: await H.contar('SELECT count(*)::int AS n FROM ai.tool_calls', {}, tx),
  };
}

/** Pede o vedado: resposta 200 de recusa pela regra, sem modelo, sem tool e sem alterar nenhum dado. */
async function recusado(prohibitionCode, pedido) {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = await montar(tx);
    const antes = await estado(tx, ctx);
    const res = await H.perguntar(ctx.c, pedido);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE', 'recusa de fronteira não chama modelo');
    assert.equal(res.answer, PROHIBITIONS.find((p) => p.code === prohibitionCode).message);
    assert.deepEqual(res.proposals, []);
    assert.deepEqual(await estado(tx, ctx), antes, 'nenhum dado mudou, nenhuma recomendação nem tool call');
  });
}

test('m9d037_nao_altera_medicao', () => recusado('ALTERAR_MEDICAO', 'Altere a medição da etapa de fundação da obra para 80%.'));
test('m9d037_nao_aprova_pagamento_a_empreiteiro', () => recusado('APROVAR_PAGAMENTO_EMPREITEIRO', 'Aprove o pagamento do empreiteiro desta obra agora.'));
test('m9d037_nao_altera_cronograma_nem_orcamento', async () => {
  await recusado('ALTERAR_CRONOGRAMA_ORCAMENTO', 'Altere o cronograma da obra e adie a entrega em 30 dias.');
  await recusado('ALTERAR_CRONOGRAMA_ORCAMENTO', 'Aumente o orçamento da obra em R$ 50.000,00.');
});
test('m9d037_nao_encerra_garantia', () => recusado('ENCERRAR_GARANTIA', 'Encerre a garantia do chamado de infiltração.'));

test('m9d037_proibicoes_respeitadas', async () => {
  const pedidos = {
    ALTERAR_MEDICAO: 'Corrija a medição desta obra.',
    APROVAR_PAGAMENTO_EMPREITEIRO: 'Libere o pagamento ao empreiteiro.',
    ALTERAR_CRONOGRAMA_ORCAMENTO: 'Mude o orçamento da obra.',
    ENCERRAR_GARANTIA: 'Feche a garantia desta obra.',
  };
  assert.deepEqual(Object.keys(pedidos).sort(), PROHIBITIONS.map((p) => p.code).sort(), 'as quatro proibições do livro');
  for (const [codigo, pedido] of Object.entries(pedidos)) await recusado(codigo, pedido);
  // O termo da proibição é parâmetro da empresa: uma frase nova passa a ser recusada sem mexer em código.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS, params: { 'ia.nay_obras.proibicao.encerrar_garantia': 'dar por encerrada a garantia' } });
    const res = await H.perguntar(c, 'Pode dar por encerrada a garantia desta obra?');
    assert.equal(res.answer, PROHIBITIONS.find((p) => p.code === 'ENCERRAR_GARANTIA').message);
  });
});

test('m9d037_acao_sugerida_so_texto_sem_recomendacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: [...PERMS, 'crm:tasks:create'] });
    const obra = await O.criarObra(tenantA, tx, { atrasoDias: 4 });
    const contagem = async () => ({
      rec: await H.contar('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx),
      chamadas: await H.contar('SELECT count(*)::int AS n FROM ai.tool_calls WHERE status = \'PROPOSED\'', {}, tx),
    });
    const antes = await contagem();
    // Resposta com termo crítico (multa): em agente que cria recomendação, vira confirmação humana; aqui fica só o texto.
    const res = await H.perguntar(c, `Consulte [[TOOL:construction.getDailyReports:{"projectId":"${obra.id}"}]] [[RESPOSTA:A obra pode ter multa por atraso, confirme com a diretoria.]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual(res.proposals, [], 'nenhuma proposta nem recomendação na resposta');
    // Pedir uma ação de escrita (tarefa de acompanhamento) é recusado: o agente não tem tool de escrita.
    const escrita = await H.perguntar(c, 'Crie uma tarefa de acompanhamento da obra [[TOOL:crm.createFollowUpTask:{"title":"Cobrar a obra"}]]');
    assert.equal(escrita.ok, false);
    assert.equal(escrita.error.code, 'AI_TOOL_NOT_ALLOWED');
    assert.deepEqual(await contagem(), antes, 'nenhuma recomendação nem proposta foi criada');
    // Mesmo com fonte exata e prazo crítico (que num agente de escrita vira recomendação de confirmação), a NAY Obras só deixa o aviso no texto.
    assert.equal(getAgentHooks('NAY_OBRAS').readOnly, true);
    assert.equal(Boolean((getAgentHooks('NAY_JURIDICA') || {}).readOnly), false, 'o gancho é só da NAY Obras');
    const { run } = await runs.startRun(c.ctx, { agentName: 'NAY_OBRAS', purpose: 'prazo da obra', inputSummary: 'quando vence?' }, tx);
    const ctx = { ...c.ctx, permissions: PERMS };
    const crit = await finalizeGrounding(ctx, { runId: run.id, agentCode: 'NAY_OBRAS', answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fonteContrato()] }, tx);
    assert.equal(crit.requiresHumanConfirmation, true);
    assert.match(crit.answer, /Confirmação humana necessária antes de agir\./);
    assert.equal(crit.recommendation, null, 'o aviso fica só no texto: nenhuma recomendação');
    assert.deepEqual(await contagem(), antes);
  });
});

test('m9d037_pedido_fora_do_proposito_e_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    for (const pedido of ['Qual a receita de bolo de cenoura?', 'Escreva um poema sobre o mar.']) {
      const res = await H.perguntar(c, pedido);
      assert.equal(res.ok, true, JSON.stringify(res.error));
      assert.equal(res.answer, FORA);
      assert.equal(res.routingPath, 'RULE');
    }
  });
  // O escopo é parâmetro: com o termo "bolo" na lista, o mesmo pedido deixa de ser recusado por escopo.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS, params: { 'ia.nay_obras.termos_escopo': 'obra,bolo' } });
    assert.notEqual((await H.perguntar(c, 'Qual a receita de bolo de cenoura?')).answer, FORA);
  });
});
