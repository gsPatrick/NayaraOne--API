'use strict';

// Correções do Marco 3 (DI-M3CA-2, DI-M3CA-3, DI-M3CA-7), pelo serviço real e com rollback:
//  - CAD-10 / livro §10: o sistema grava WON e LOST (códigos antigos aceitos na entrada); WITHDRAWN não é estágio: vira LOST com
//    motivo de desistência; quem grava código antigo direto no banco também fica com o código do livro (gatilho);
//  - M3-12 / §3 crm.loss_reasons: motivos de ganho, perda e desistência são parâmetros da empresa;
//  - CRMX-005: reabrir não apaga o motivo da perda; o motivo antigo não fecha de novo; perda e proposta ficam no histórico.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { Opportunity, AuditLog, Proposal } = require('../src/models');
const opportunityService = require('../src/features/crm/opportunity.service');
const proposalsService = require('../src/features/crm/proposals.service');
const timelineService = require('../src/features/crm/opportunityTimeline.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { createOpportunity, createTestProperty } = require('./helpers/m3caCrm');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeOf = async (promise) => {
  try {
    await promise;
    return 'SEM_ERRO';
  } catch (err) {
    return err.code || err.message;
  }
};
const update = (id, body, t) => opportunityService.updateOpportunity(id, body, tenant.userId, t);

test('CAD-10: WON e LOST gravados com o código do livro; CLOSED_WON, CLOSED_LOST e GANHO aceitos na entrada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await createOpportunity(tenant, t);
    assert.equal((await update(a.id, { stage: 'WON', wonReason: 'REFERRAL' }, t)).stage, 'WON');
    const b = await createOpportunity(tenant, t);
    assert.equal((await update(b.id, { stage: 'CLOSED_WON', wonReason: 'REFERRAL' }, t)).stage, 'WON', 'código antigo na entrada, código do livro gravado');
    const c = await createOpportunity(tenant, t);
    assert.equal((await update(c.id, { stage: 'CLOSED_LOST', lostReason: 'COMPETITOR' }, t)).stage, 'LOST');
    const d = await createOpportunity(tenant, t, { stage: 'GANHO', wonReason: 'FAST_DECISION' });
    assert.equal(d.stage, 'WON');
    const [[gravado]] = await sequelize.query('SELECT stage FROM crm.opportunities WHERE id = :id', { replacements: { id: c.id }, transaction: t });
    assert.equal(gravado.stage, 'LOST', 'no banco fica LOST');

    // Quem ainda gravar o código antigo direto na tabela (integração antiga, script) fica com o código do livro.
    await sequelize.query("UPDATE crm.opportunities SET stage = 'CLOSED_WON', won_reason = 'REFERRAL' WHERE id = :id", { replacements: { id: c.id }, transaction: t });
    const [[viaSql]] = await sequelize.query('SELECT stage FROM crm.opportunities WHERE id = :id', { replacements: { id: c.id }, transaction: t });
    assert.equal(viaSql.stage, 'WON', 'gatilho grava WON no lugar de CLOSED_WON');
  });
});

test('CAD-10/M3-12: desistência é LOST com motivo de desistência (WITHDRAWN aceito na entrada e não gravado)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await createOpportunity(tenant, t);
    const desistiu = await update(opp.id, { stage: 'WITHDRAWN', withdrawnReason: 'CLIENT_GAVE_UP' }, t);
    assert.equal(desistiu.stage, 'LOST');
    assert.equal(desistiu.lostReason, 'CLIENT_GAVE_UP');
    assert.equal(desistiu.withdrawnReason, 'CLIENT_GAVE_UP', 'a categoria desistência fica marcada');

    const outra = await createOpportunity(tenant, t);
    assert.equal(await codeOf(update(outra.id, { stage: 'WITHDRAWN', withdrawnReason: 'PRICE_TOO_HIGH' }, t)), 'OPPORTUNITY_OUTCOME_REASON_INVALID', 'desistência só aceita motivo de desistência');
    const pelaPerda = await update(outra.id, { stage: 'LOST', lostReason: 'NO_RESPONSE' }, t);
    assert.equal(pelaPerda.withdrawnReason, 'NO_RESPONSE', 'motivo de desistência escolhido no LOST marca a desistência');
    const [[n]] = await sequelize.query("SELECT count(*)::int AS n FROM crm.opportunities WHERE id IN (:ids) AND stage = 'WITHDRAWN'", { replacements: { ids: [opp.id, outra.id] }, transaction: t });
    assert.equal(n.n, 0);
  });
});

test('M3-12: as listas de motivos são parâmetros da empresa e crm.loss_reasons mostra a lista configurada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('crm.motivos.perda', 'IMOVEL_VENDIDO=Imóvel vendido a outro,COMPETITOR=Concorrente', tenant, tenant.userId, t);
    const opp = await createOpportunity(tenant, t);
    assert.equal(await codeOf(update(opp.id, { stage: 'LOST', lostReason: 'PRICE_TOO_HIGH' }, t)), 'OPPORTUNITY_OUTCOME_REASON_INVALID', 'motivo fora da lista configurada é recusado');
    assert.equal((await update(opp.id, { stage: 'LOST', lostReason: 'IMOVEL_VENDIDO' }, t)).lostReason, 'IMOVEL_VENDIDO', 'motivo novo do administrador vale');

    const [rows] = await sequelize.query(
      "SELECT outcome_stage, category, code, label FROM crm.loss_reasons WHERE company_id = :c AND category = 'LOSS' ORDER BY sort_order",
      { replacements: { c: tenant.companyId }, transaction: t }
    );
    assert.deepEqual(rows.map((r) => [r.outcome_stage, r.code, r.label]), [['LOST', 'IMOVEL_VENDIDO', 'Imóvel vendido a outro'], ['LOST', 'COMPETITOR', 'Concorrente']]);

    assert.equal(await codeOf(upsertSetting('crm.motivos.perda', 'sem formato', tenant, tenant.userId, t)), 'SETTING_INVALID_VALUE');
    assert.equal(await codeOf(upsertSetting('crm.motivos.desistencia', 'COMPETITOR=Concorrente', tenant, tenant.userId, t)), 'SETTING_INVALID_VALUE', 'o mesmo código não pode ser perda e desistência');
  });
});

test('CRMX-005/CRM-TS-008: reabrir não apaga a perda; o motivo antigo não fecha de novo; cada perda fica na linha do tempo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await createOpportunity(tenant, t);
    await update(opp.id, { stage: 'LOST', lostReason: 'PRICE_TOO_HIGH' }, t);
    const reaberta = await update(opp.id, { stage: 'NURTURE', nextAction: 'Recontato em 3 meses', nextActionDueAt: new Date(Date.now() + 90 * 86400000) }, t);
    assert.equal(reaberta.stage, 'NURTURE');
    assert.equal(reaberta.lostReason, 'PRICE_TOO_HIGH', 'reabrir mantém o motivo da perda anterior no registro');
    assert.equal(reaberta.closedAt, null);

    assert.equal(await codeOf(update(opp.id, { stage: 'LOST' }, t)), 'OPPORTUNITY_OUTCOME_REASON_REQUIRED', 'nova perda exige motivo no pedido');
    await update(opp.id, { stage: 'LOST', lostReason: 'LOCATION' }, t);

    const linha = await timelineService.getOpportunityTimeline(opp.id, t, { types: ['STAGE_CHANGE'] });
    const perdas = linha.filter((i) => i.data.toStage === 'LOST').map((i) => i.data.lostReason).sort();
    assert.deepEqual(perdas, ['LOCATION', 'PRICE_TOO_HIGH'], 'as duas perdas, com o motivo de cada uma, na linha do tempo');
    const trilha = await AuditLog.count({ where: { entityId: opp.id, action: 'opportunity.stage_change' }, transaction: t });
    assert.equal(trilha, 3);
    const atual = await Opportunity.findByPk(opp.id, { transaction: t });
    assert.equal(atual.lostReason, 'LOCATION');
  });
});

test('CRMX-005: proposta é histórico permanente — valor imutável, contraproposta é versão nova, as versões ficam', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const property = await createTestProperty(tenant, t);
    const opp = await createOpportunity(tenant, t, { propertyId: property.id });
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opp.id, propertyId: property.id };
    const v1 = await proposalsService.createProposal({ ...base, value: 500000, status: 'SENT' }, tenant.userId, t);
    assert.equal(await codeOf(proposalsService.updateProposalStatus(v1.id, { status: 'UNDER_NEGOTIATION', value: 450000 }, tenant.userId, t)), 'PROPOSAL_VALUE_IMMUTABLE');
    await proposalsService.updateProposalStatus(v1.id, { status: 'REJECTED' }, tenant.userId, t);
    const v2 = await proposalsService.createProposal({ ...base, value: 480000, status: 'SENT' }, tenant.userId, t);
    assert.equal(v2.versionNumber, 2);
    assert.equal(await codeOf(proposalsService.updateProposalStatus(v1.id, { status: 'SENT' }, tenant.userId, t)), 'PROPOSAL_INVALID_TRANSITION', 'proposta decidida não volta atrás');

    const versoes = await Proposal.findAll({ where: { opportunityId: opp.id }, order: [['version_number', 'ASC']], transaction: t });
    assert.deepEqual(versoes.map((p) => [p.versionNumber, Number(p.value), p.status]), [[1, 500000, 'REJECTED'], [2, 480000, 'SENT']]);
    assert.equal(typeof proposalsService.deleteProposal, 'undefined', 'não existe exclusão de proposta');
    const trilha = await AuditLog.count({ where: { entityId: v1.id, action: ['proposal.create', 'proposal.status_change'] }, transaction: t });
    assert.equal(trilha, 2, 'criação e decisão da v1 auditadas');
  });
});
