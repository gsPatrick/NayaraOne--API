'use strict';

/**
 * CAD-09 (livro Marco 3 §9: "Oportunidade pode vincular financing_case do módulo Correspondente. Status do financiamento atualiza
 * CRM por eventos, sem duplicar dados bancários dentro do CRM"). A mudança de status do caso só publica o evento no outbox; o
 * consumidor do CRM, no despacho, grava o retrato (status + data + referência do caso) na oportunidade e o item da linha do tempo.
 * Reprocesso não duplica; nada bancário chega ao CRM; oportunidade de outra empresa não é tocada.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../src/features/correspondent/cases/submissions.service');
const caseWorkflow = require('../src/features/correspondent/cases/caseWorkflow.service');
const { getOpportunityTimeline } = require('../src/features/crm/opportunityTimeline.service');
const { CONSUMER, TIMELINE_ACTION } = require('../src/features/crm/financingStatus.consumer');
const { publishDomainEvent } = require('../src/engines/events/outbox');
const { Person, File, OutboxEvent, AuditLog, Opportunity, IntegrationInbox } = require('../src/models');
const { despacharNaTransacao, reabrirEventos } = require('./helpers/outboxEmTransacao');

let tenant;
let outra;
before(async () => {
  tenant = await getSeedTenant();
  const [groups] = await sequelize.query('SELECT id FROM core.groups WHERE id != :g ORDER BY created_at LIMIT 5', { replacements: { g: tenant.groupId } });
  for (const g of groups) {
    const c = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: g.id }, transaction: t });
      const [[row]] = await sequelize.query('SELECT id FROM core.companies LIMIT 1', { transaction: t });
      return row;
    });
    if (c) { outra = { groupId: g.id, companyId: c.id, userId: tenant.userId }; break; }
  }
  assert.ok(outra, 'precisa de outra empresa (seed-ci-two-tenants)');
});
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const timelineAudits = (t, opportunityId) => AuditLog.findAll({ where: { entityType: 'Opportunity', entityId: opportunityId, action: TIMELINE_ACTION }, order: [['occurred_at', 'ASC']], transaction: t });
const rawOpportunity = async (t, id) => (await sequelize.query('SELECT * FROM crm.opportunities WHERE id = :id', { replacements: { id }, transaction: t }))[0][0];

async function oportunidade(t, owner = tenant) {
  const person = await Person.create({ groupId: owner.groupId, companyId: owner.companyId, personType: 'PF', legalName: `Cliente Fin Evento ${uniqueSuffix()}` }, { transaction: t });
  return Opportunity.create({ groupId: owner.groupId, companyId: owner.companyId, personId: person.id, stage: 'FINANCING', nextAction: 'Acompanhar banco', nextActionDueAt: new Date(Date.now() + 86400000) }, { transaction: t });
}

/** Caso com documento validado (dados bancários/pessoais no checklist) e enviado ao banco com valor: o que NÃO pode chegar ao CRM. */
async function casoEnviado(t, opportunityId) {
  const principal = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente Fin ${uniqueSuffix()}` }, { transaction: t });
  const fc = await financingCasesService.createFinancingCase({ ...ctx(), opportunityId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
  const req = await caseDocumentsService.createRequirement(fc.id, { documentType: 'RG_CPF' }, tenant.userId, ctx(), t);
  const file = await File.create({ ...ctx(), fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', storageKey: `test/${uniqueSuffix()}.pdf`, sizeBytes: 10 }, { transaction: t });
  await caseDocumentsService.uploadDocument(fc.id, req.id, { fileId: file.id }, tenant.userId, ctx(), t);
  await caseDocumentsService.validateRequirement(fc.id, req.id, tenant.userId, ctx(), t, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
  const submission = await submissionsService.submitFinancingCase(fc.id, { consent: true, amount: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, t);
  assert.equal(submission.status, 'SUBMITTED', 'pré-condição: envio ao banco aceito');
  return { fc, submission };
}

test('CAD-09: status do caso -> evento no outbox (CRM intocado antes do despacho) -> despacho atualiza retrato e linha do tempo; reprocesso não duplica; nada bancário no CRM', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await oportunidade(t);
    const antes = await rawOpportunity(t, opp.id);
    const { fc, submission } = await casoEnviado(t, opp.id);
    await caseWorkflow.cancelCase(fc.id, { reason: 'Cliente desistiu do financiamento' }, tenant.userId, tenant.groupId, tenant.companyId, t);

    const eventos = await OutboxEvent.findAll({ where: { aggregateId: fc.id, eventType: ['financing.case.created', 'financing.status.changed'] }, order: [['occurred_at', 'ASC']], transaction: t });
    const statusEvents = eventos.filter((e) => e.eventType === 'financing.status.changed');
    assert.ok(statusEvents.length >= 2, 'cada mudança de status publicou financing.status.changed');
    assert.equal(statusEvents[statusEvents.length - 1].payloadJson.status, 'CANCELED');
    for (const e of eventos) {
      assert.equal(e.status, 'PENDING');
      assert.equal(e.payloadJson.opportunityId, opp.id, 'o evento leva a referência da oportunidade');
    }
    // Sem escrita no CRM antes do despacho.
    assert.equal((await timelineAudits(t, opp.id)).length, 0, 'nenhum item de linha do tempo antes do despacho');
    const semDespacho = await rawOpportunity(t, opp.id);
    assert.equal(semDespacho.financing_status, null);
    assert.equal(semDespacho.financing_case_id, null);

    const r1 = await despacharNaTransacao(tenant, t, { id: eventos.map((e) => e.id) });
    assert.equal(r1.dispatched, eventos.length);
    const depois = await rawOpportunity(t, opp.id);
    assert.equal(depois.financing_status, 'CANCELED', 'o retrato da oportunidade mostra o status atual do financiamento');
    assert.equal(depois.financing_case_id, fc.id);
    assert.ok(depois.financing_status_at instanceof Date);
    assert.equal(depois.stage, 'FINANCING', 'o consumidor não decide estágio');
    assert.equal(depois.lock_version, antes.lock_version, 'o retrato não mexe na versão da oportunidade (não atrapalha edição do corretor)');
    const mudou = Object.keys(depois).filter((k) => String(depois[k]) !== String(antes[k]));
    assert.deepEqual(mudou.filter((k) => !['updated_at'].includes(k)).sort(), ['financing_case_id', 'financing_status', 'financing_status_at']);

    const audits = await timelineAudits(t, opp.id);
    assert.equal(audits.length, eventos.length, 'um item de linha do tempo por evento');
    const timeline = await getOpportunityTimeline(opp.id, t, { types: ['FINANCING_STATUS'] });
    assert.equal(timeline.length, eventos.length);
    assert.equal(timeline[0].data.status, 'CANCELED', 'o mais recente primeiro');
    assert.match(timeline[0].data.reason, /Cancelado/);
    assert.ok(timeline.some((i) => i.data.status === 'DRAFT'), 'o vínculo inicial (financing.case.created) também aparece');

    // Nada bancário no CRM: nem na oportunidade, nem na linha do tempo.
    const noCrm = JSON.stringify({ depois, audits: audits.map((a) => ({ b: a.beforeJson, a: a.afterJson, r: a.reason })), timeline });
    for (const proibido of ['12345-6', '52998224725', '200000', 'accountNumber', 'income', 'amount', 'proposal', 'providerCode', submission.externalCaseId]) {
      assert.ok(!noCrm.includes(String(proibido)), `dado bancário "${proibido}" vazou para o CRM`);
    }

    // Reprocesso: os mesmos eventos entregues de novo não duplicam nada.
    await reabrirEventos(eventos.map((e) => e.id), t);
    const r2 = await despacharNaTransacao(tenant, t, { id: eventos.map((e) => e.id) });
    assert.equal(r2.dispatched, eventos.length);
    assert.equal((await timelineAudits(t, opp.id)).length, eventos.length, 'reprocesso não duplica a linha do tempo');
    assert.equal(await IntegrationInbox.count({ where: { consumerName: CONSUMER, eventId: eventos.map((e) => e.id) }, transaction: t }), eventos.length);
    assert.equal((await rawOpportunity(t, opp.id)).financing_status, 'CANCELED');
  });
});

test('CAD-09: evento atrasado entra na linha do tempo mas não volta o retrato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await oportunidade(t);
    const principal = await Person.create({ ...ctx(), personType: 'PF', legalName: `Proponente Atraso ${uniqueSuffix()}` }, { transaction: t });
    const fc = await financingCasesService.createFinancingCase({ ...ctx(), opportunityId: opp.id, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
    const pub = (status, at) => publishDomainEvent({
      ...ctx(), aggregateType: 'FinancingCase', aggregateId: fc.id, eventType: 'financing.status.changed',
      payload: { id: fc.id, previousStatus: null, status, opportunityId: opp.id, changedAt: at, manualWorkflow: false },
      idempotencyKey: `financing.status.changed:teste-cad09:${opp.id}:${status}`,
    }, t);
    const novo = await pub('APPROVED', '2026-11-10T12:00:00.000Z');
    await despacharNaTransacao(tenant, t, { id: novo.id });
    const velho = await pub('UNDER_ANALYSIS', '2026-11-09T12:00:00.000Z');
    await despacharNaTransacao(tenant, t, { id: velho.id });
    const row = await rawOpportunity(t, opp.id);
    assert.equal(row.financing_status, 'APPROVED');
    assert.equal(new Date(row.financing_status_at).toISOString(), '2026-11-10T12:00:00.000Z');
    const timeline = await getOpportunityTimeline(opp.id, t, { types: ['FINANCING_STATUS'] });
    assert.deepEqual(timeline.map((i) => i.data.status), ['APPROVED', 'UNDER_ANALYSIS'], 'linha do tempo na ordem dos fatos');
  });
});

test('CAD-09: evento da empresa A apontando para oportunidade da empresa B não toca a oportunidade de B', async () => {
  const oppB = await withTenantTransaction(outra, (t) => oportunidade(t, outra));
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ev = await publishDomainEvent({
      ...ctx(), aggregateType: 'FinancingCase', aggregateId: oppB.id, eventType: 'financing.status.changed',
      payload: { id: null, previousStatus: 'SUBMITTED', status: 'APPROVED', opportunityId: oppB.id, changedAt: new Date().toISOString() },
      idempotencyKey: `financing.status.changed:teste-cad09-outra:${oppB.id}`,
    }, t);
    const r = await despacharNaTransacao(tenant, t, { id: ev.id });
    assert.equal(r.dispatched, 1, 'o evento foi consumido (sem erro), mas não achou a oportunidade na empresa A');
  });
  await withTenantTransaction(outra, async (t) => {
    const row = await rawOpportunity(t, oppB.id);
    assert.equal(row.financing_status, null, 'oportunidade de outra empresa não foi tocada');
    assert.equal((await timelineAudits(t, oppB.id)).length, 0);
  });
});
