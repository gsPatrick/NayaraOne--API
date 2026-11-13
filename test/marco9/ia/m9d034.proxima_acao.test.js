'use strict';

// M9-D034 capacidade 2 — sugerir a próxima ação: regra de código primeiro (sem contato, proposta sem resposta, documentos pendentes),
// modelo pequeno só quando nenhuma regra vale, e a sugestão como recomendação NEXT_ACTION (risco LOW, sem ação proposta).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const { espiaRegistry } = require('../_helpers/iaEspia');
const { definirParametro } = require('../_helpers/iaOrcamento');
const C = require('../_helpers/iaComercial');
const { nextActionRules, RULES } = require('../../../src/features/ai/agents/nay_comercial/comercial.rules');
const { FinancingCase } = require('../../../src/models');
const caseDocuments = require('../../../src/features/correspondent/cases/caseDocuments.service');
const financingCases = require('../../../src/features/correspondent/cases/financingCases.service');
const { Person } = require('../../../src/models');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const TASK = 'sugerir_proxima_acao';
const PARAMS = { daysWithoutContact: 7, daysProposalNoReply: 5 };

test('m9d034_proxima_acao_regras_puras_na_ordem_do_livro', () => {
  assert.equal(nextActionRules({ closed: false, daysWithoutContact: 7, proposals: [], pendingDocuments: [] }, PARAMS), null, 'exatamente 7 dias não passa de 7');
  const sem = nextActionRules({ closed: false, daysWithoutContact: 8, proposals: [{ unanswered: true, daysSinceSent: 6 }], pendingDocuments: ['RG', 'CPF'] }, PARAMS);
  assert.equal(sem.rule, RULES.NO_CONTACT);
  assert.equal(sem.title, 'Retomar contato');
  assert.deepEqual(sem.matched, [RULES.NO_CONTACT, RULES.PROPOSAL, RULES.DOCUMENTS]);
  const prop = nextActionRules({ closed: false, daysWithoutContact: 2, proposals: [{ unanswered: true, daysSinceSent: 6 }, { unanswered: false, daysSinceSent: 30 }], pendingDocuments: [] }, PARAMS);
  assert.equal(prop.title, 'Fazer follow-up da proposta');
  assert.equal(nextActionRules({ closed: false, daysWithoutContact: 2, proposals: [{ unanswered: true, daysSinceSent: 5 }], pendingDocuments: [] }, PARAMS), null, 'exatamente 5 dias não passa de 5');
  const docs = nextActionRules({ closed: false, daysWithoutContact: 1, proposals: [], pendingDocuments: ['COMPROVANTE_RENDA', 'IPTU'] }, PARAMS);
  assert.equal(docs.title, 'Cobrar documentos COMPROVANTE_RENDA, IPTU');
  assert.equal(nextActionRules({ closed: true, stage: 'WON', daysWithoutContact: null, proposals: [], pendingDocuments: ['RG'] }, PARAMS).rule, RULES.CLOSED);
});

test('m9d034_proxima_acao_por_regra_antes_de_modelo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await C.cenario(tenantA, tx, { dias: 9, deps: { registry } });
    await C.mensagem(c, 'OUTBOUND');
    const { outcome: o } = await c.pedir(TASK, 'Qual a próxima ação desta oportunidade?');
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.equal(o.routingPath, 'RULE');
    assert.match(o.answer, /Retomar contato/);
    assert.equal(pedidos.length, 0, 'a regra resolve sem modelo');
    assert.equal(o.proposals.length, 1);
    const [rec] = await q('SELECT * FROM ai.ai_recommendations WHERE id = :id', { id: o.proposals[0].id }, tx);
    assert.equal(rec.recommendation_type, 'NEXT_ACTION');
    assert.equal(rec.risk_level, 'LOW');
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.proposed_action, null, 'sem ação proposta: só texto');
    assert.equal(rec.target_user_id, c.auth.userId);
    assert.equal(rec.related_entity_id, c.opp.id);
    assert.equal(rec.ai_run_id, o.runId);
    // Mudar o limite pelo parâmetro muda a decisão (nada fixo no código): com 10 dias de alerta, 9 dias não dispara.
    await definirParametro(tenantA, 'ia.comercial.dias_sem_contato_alerta', 10, tx);
    const { outcome: folga } = await c.pedir(TASK, 'Qual a próxima ação?');
    assert.equal(folga.routingPath, 'SMALL_MODEL', 'nenhuma regra vale: o modelo pequeno redige');
  });
});

test('m9d034_proxima_acao_proposta_sem_resposta_por_regra_e_sem_repetir_no_dia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await C.cenario(tenantA, tx, { dias: 6, deps: { registry } });
    await C.mensagem(c, 'INBOUND');
    await C.propostaEnviada(c);
    const { outcome: o } = await c.pedir(TASK, 'Qual a próxima ação?');
    assert.match(o.answer, /Fazer follow-up da proposta/);
    assert.equal(pedidos.length, 0);
    // A mesma sugestão pendente no mesmo dia não se repete (dedupe da D007): a segunda chamada devolve a mesma recomendação.
    const { outcome: repetida } = await c.pedir(TASK, 'Qual a próxima ação?');
    assert.equal(repetida.proposals[0].id, o.proposals[0].id);
  });
});

test('m9d034_proxima_acao_cliente_respondeu_nenhuma_regra_vale_e_o_modelo_redige', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await C.cenario(tenantA, tx, { dias: 6, deps: { registry } });
    await C.mensagem(c, 'INBOUND');
    await C.propostaEnviada(c);
    await C.mensagem(c, 'INBOUND'); // o cliente respondeu depois do envio: a proposta deixa de estar sem resposta
    const { outcome: o } = await c.pedir(TASK, `Qual a próxima ação? [[TOOL:crm.getOpportunity:{"opportunityId":"${c.opp.id}"}]] [[RESPOSTA:Sugiro agendar uma visita ao imóvel [1].]]`);
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.equal(o.routingPath, 'SMALL_MODEL');
    assert.ok(pedidos.length >= 1, 'o modelo redigiu a sugestão a partir dos fatos');
    assert.match(o.answer, /Sugiro agendar uma visita/);
    const [rec] = await q('SELECT recommendation_type, risk_level, proposed_action, payload_json FROM ai.ai_recommendations WHERE id = :id', { id: o.proposals[0].id }, tx);
    assert.equal(rec.recommendation_type, 'NEXT_ACTION');
    assert.equal(rec.risk_level, 'LOW');
    assert.equal(rec.proposed_action, null);
    assert.equal(rec.payload_json.source, 'MODEL');
  });
});

test('m9d034_proxima_acao_documentos_pendentes_do_financiamento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx, { dias: 0 });
    await C.mensagem(c, 'INBOUND');
    const t = c.tenant;
    const principal = await Person.create({ groupId: t.groupId, companyId: t.companyId, personType: 'PF', legalName: `Proponente ${c.opp.id.slice(0, 6)}`, createdBy: t.userId, updatedBy: t.userId }, { transaction: tx });
    const caso = await financingCases.createFinancingCase({ groupId: t.groupId, companyId: t.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, t.userId, tx);
    await FinancingCase.update({ opportunityId: c.opp.id }, { where: { id: caso.id }, transaction: tx });
    await caseDocuments.createRequirement(caso.id, { documentType: 'COMPROVANTE_RENDA' }, t.userId, { groupId: t.groupId, companyId: t.companyId }, tx);
    const { outcome: o } = await c.pedir(TASK, 'Qual a próxima ação?');
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.match(o.answer, /Cobrar documentos COMPROVANTE_RENDA/);
    const { outcome: resumo } = await c.pedir('resumir_oportunidade', 'Resuma');
    assert.ok(resumo.structured.pendencias.some((p) => p.includes('COMPROVANTE_RENDA')));
  });
});

test('m9d034_proxima_acao_oportunidade_encerrada_nao_gera_recomendacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx, { dias: 30 });
    await q("UPDATE crm.opportunities SET stage = 'WON', closed_at = now() WHERE id = :id RETURNING id", { id: c.opp.id }, tx);
    const { outcome: o } = await c.pedir(TASK, 'Qual a próxima ação?');
    assert.match(o.answer, /encerrada/);
    assert.deepEqual(o.proposals, []);
  });
});
