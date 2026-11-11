'use strict';

// Correções do Marco 3 (M3-20 e CAD-15; livro §15 "Ocorrência possui responsável, SLA, severidade e conclusão" e "Reclamação
// grave escala para gerência"; DI-M3CA-5 e DI-M3CA-6), pelo serviço real e com rollback:
//  - o SLA vem dos parâmetros da empresa (sem valor fixo no código);
//  - a ocorrência sempre tem responsável (o informado precisa ser usuário ativo da empresa);
//  - o escalonamento por SLA vencido (job) e o manual chegam à gerência.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { Notification, OutboxEvent, FeedbackCase } = require('../src/models');
const feedbackCasesService = require('../src/features/crm/feedbackCases.service');
const { escalateOverdueFeedbackCases } = require('../src/engines/jobs/feedbackCaseAlertJob');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { createMember, createOutsider, createPerson, createOpportunity } = require('./helpers/m3caCrm');

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
const HOUR = 3600 * 1000;
const open = (t, extra, actor = tenant.userId) => feedbackCasesService.createFeedbackCase(
  { groupId: tenant.groupId, companyId: tenant.companyId, type: 'COMPLAINT', description: 'Atendimento demorado', ...extra }, actor, t
);

test('M3-20/CAD-15: o SLA de cada severidade vem do parâmetro da empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await createPerson(tenant, t);
    await upsertSetting('crm.ocorrencia.sla_horas.media', 5, tenant, tenant.userId, t);
    await upsertSetting('crm.ocorrencia.sla_horas.baixa', 300, tenant, tenant.userId, t);
    const antes = Date.now();
    const media = await open(t, { personId: person.id, severity: 'MEDIUM' });
    const baixa = await open(t, { personId: person.id, severity: 'LOW' });
    const horas = (c) => (new Date(c.slaDueAt).getTime() - antes) / HOUR;
    assert.ok(Math.abs(horas(media) - 5) < 0.1, `MEDIUM com 5 h configuradas (veio ${horas(media)})`);
    assert.ok(Math.abs(horas(baixa) - 300) < 0.1, `LOW com 300 h configuradas (veio ${horas(baixa)})`);
    assert.equal(await codeOf(upsertSetting('crm.ocorrencia.sla_horas.alta', 0, tenant, tenant.userId, t)), 'SETTING_INVALID_VALUE');
  });
});

test('M3-20/CAD-15: ocorrência sempre tem responsável; o informado precisa ser usuário ativo da empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const corretor = await createMember(tenant, t, { label: 'corretor' });
    const fora = await createOutsider(t);
    const opp = await createOpportunity(tenant, t, { ownerUserId: corretor });

    assert.equal(await codeOf(open(t, { personId: opp.personId, assignedToUserId: fora })), 'FEEDBACK_CASE_ASSIGNEE_INVALID');
    const daOportunidade = await open(t, { personId: opp.personId, opportunityId: opp.id });
    assert.equal(daOportunidade.assignedToUserId, corretor, 'sem responsável informado, vale o responsável da oportunidade');
    const semOportunidade = await open(t, { personId: opp.personId });
    assert.equal(semOportunidade.assignedToUserId, tenant.userId, 'sem oportunidade, quem abre responde');
    const automatica = await open(t, { personId: opp.personId }, null);
    assert.ok(automatica.assignedToUserId, 'aberta por automação, também nasce com responsável');
  });
});

test('M3-20/CAD-15: SLA vencido escala pelo job e avisa a gerência, não só o responsável', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const gestor = await createMember(tenant, t, { label: 'gestor', permissions: ['crm:dashboard:read'] });
    const corretor = await createMember(tenant, t, { label: 'corretor' });
    const person = await createPerson(tenant, t);
    const caso = await open(t, { personId: person.id, severity: 'MEDIUM', assignedToUserId: corretor });
    await FeedbackCase.update({ slaDueAt: new Date(Date.now() - HOUR) }, { where: { id: caso.id }, transaction: t });

    await escalateOverdueFeedbackCases(t, new Date());
    const atual = await FeedbackCase.findByPk(caso.id, { transaction: t });
    assert.equal(atual.status, 'ESCALATED');
    const avisos = await Notification.findAll({ where: { userId: [gestor, corretor] }, transaction: t });
    assert.deepEqual([...new Set(avisos.map((n) => n.userId))].sort(), [corretor, gestor].sort(), 'responsável e gerência avisados');
    const evento = await OutboxEvent.findOne({ where: { aggregateId: caso.id, eventType: 'crm.feedback_case.escalated' }, transaction: t });
    assert.ok(evento.payloadJson.notifiedUserIds.includes(gestor));
  });
});

test('M3-20/CAD-15: a gerência é a do parâmetro crm.gerencia.permissao (escalonamento manual)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const diretor = await createMember(tenant, t, { label: 'diretor', permissions: ['crm:opportunities:read:all'] });
    const painel = await createMember(tenant, t, { label: 'painel', permissions: ['crm:dashboard:read'] });
    await upsertSetting('crm.gerencia.permissao', 'crm:opportunities:read:all', tenant, tenant.userId, t);
    const person = await createPerson(tenant, t);
    const caso = await open(t, { personId: person.id, severity: 'LOW' });
    await feedbackCasesService.escalateFeedbackCase(caso.id, { automatic: false }, tenant.userId, t);
    assert.equal(await Notification.count({ where: { userId: diretor }, transaction: t }), 1, 'quem tem a permissão configurada é avisado');
    assert.equal(await Notification.count({ where: { userId: painel }, transaction: t }), 0, 'a permissão antiga não vale mais');
    assert.equal(await codeOf(upsertSetting('crm.gerencia.permissao', 'nao:existe', tenant, tenant.userId, t)), 'SETTING_INVALID_VALUE');
  });
});
