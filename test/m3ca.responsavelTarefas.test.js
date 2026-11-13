'use strict';

// Correções do Marco 3 (DI-M3CA-1, DI-M3CA-4, DI-M3CA-5), pelo serviço real e com rollback:
//  - M3-11 / CRMX-006 / Guia §7 assertResponsibleUser: toda oportunidade tem responsável ativo da empresa;
//  - M3-12 / Guia §8 markLost -> tasks.cancelFuture: marcar LOST cancela as tarefas pendentes na mesma transação;
//  - CAD-11 / livro §11 "Tarefa vencida escala conforme regra": só tarefa de oportunidade em aberto escala; depois do prazo
//    configurável (crm.tarefa_vencida.escalar_gerencia_apos_horas) chega à gerência.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { Task, AuditLog, Notification, OutboxEvent } = require('../src/models');
const opportunityService = require('../src/features/crm/opportunity.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { escalateOverdueCrmTasks } = require('../src/engines/jobs/crmTaskOverdueJob');
const { createMember, createOutsider, createOpportunity } = require('./helpers/m3caCrm');

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

async function task(transaction, opportunity, { status = 'OPEN', dueAt, title = 'Tarefa' } = {}) {
  return Task.create(
    {
      groupId: tenant.groupId, companyId: tenant.companyId, assignedToUserId: tenant.userId, title, relatedEntityType: 'crm.opportunities',
      relatedEntityId: opportunity.id, dueAt, status, createdBy: tenant.userId, updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('M3-11/CRMX-006: a oportunidade sempre nasce com responsável e o responsável não pode sumir nem ser de fora da empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const corretor = await createMember(tenant, t, { label: 'corretor', permissions: ['crm:opportunities:read:own'] });
    const fora = await createOutsider(t);

    const semDono = await createOpportunity(tenant, t, {}, corretor);
    assert.equal(semDono.ownerUserId, corretor, 'sem ownerUserId, quem cria é o responsável');

    const comDono = await createOpportunity(tenant, t, { ownerUserId: corretor });
    assert.equal(comDono.ownerUserId, corretor);

    assert.equal(await codeOf(createOpportunity(tenant, t, { ownerUserId: fora })), 'OPPORTUNITY_RESPONSIBLE_INVALID', 'usuário sem vínculo com a empresa não é responsável');
    assert.equal(await codeOf(opportunityService.updateOpportunity(comDono.id, { ownerUserId: null }, tenant.userId, t)), 'OPPORTUNITY_RESPONSIBLE_REQUIRED');
    assert.equal(await codeOf(opportunityService.updateOpportunity(comDono.id, { ownerUserId: '' }, tenant.userId, t)), 'OPPORTUNITY_RESPONSIBLE_REQUIRED');
    assert.equal(await codeOf(opportunityService.updateOpportunity(comDono.id, { ownerUserId: fora }, tenant.userId, t)), 'OPPORTUNITY_RESPONSIBLE_INVALID');
    const trocado = await opportunityService.updateOpportunity(comDono.id, { ownerUserId: tenant.userId }, tenant.userId, t);
    assert.equal(trocado.ownerUserId, tenant.userId, 'troca para outro usuário ativo da empresa é aceita');
  });
});

test('M3-11/CRMX-006: lead automático (sem usuário) recebe o responsável padrão configurado pelo administrador', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const plantao = await createMember(tenant, t, { label: 'plantao' });
    const automatico = await createOpportunity(tenant, t, {}, null);
    assert.ok(automatico.ownerUserId, 'mesmo sem usuário, a oportunidade nasce com responsável (gestor da empresa)');

    await upsertSetting('crm.lead_automatico.responsavel_padrao', plantao, tenant, tenant.userId, t);
    const configurado = await createOpportunity(tenant, t, {}, null);
    assert.equal(configurado.ownerUserId, plantao, 'o responsável padrão vem do parâmetro');

    const fora = await createOutsider(t);
    assert.equal(await codeOf(upsertSetting('crm.lead_automatico.responsavel_padrao', fora, tenant, tenant.userId, t)), 'SETTING_INVALID_VALUE');
  });
});

test('M3-12/Guia §8: marcar LOST cancela as tarefas pendentes (futura e vencida), com auditoria; concluída não muda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await createOpportunity(tenant, t);
    const futura = await task(t, opp, { dueAt: new Date(Date.now() + 86400000), title: 'Futura' });
    const andamento = await task(t, opp, { status: 'IN_PROGRESS', dueAt: new Date(Date.now() - 3600000), title: 'Vencida em andamento' });
    const feita = await task(t, opp, { status: 'DONE', dueAt: new Date(Date.now() - 86400000), title: 'Feita' });

    const perdida = await opportunityService.updateOpportunity(opp.id, { stage: 'LOST', lostReason: 'COMPETITOR' }, tenant.userId, t);

    for (const id of [futura.id, andamento.id]) {
      const atual = await Task.findByPk(id, { transaction: t });
      assert.equal(atual.status, 'CANCELED', `tarefa ${atual.title} cancelada pela perda`);
      const trilha = await AuditLog.findOne({ where: { entityId: id, action: 'opportunity.task_cancel_on_lost' }, transaction: t });
      assert.ok(trilha, 'cancelamento auditado');
      assert.equal(trilha.afterJson.status, 'CANCELED');
    }
    assert.equal((await Task.findByPk(feita.id, { transaction: t })).status, 'DONE', 'tarefa concluída fica como estava');
    assert.equal(perdida.stage, 'LOST');
    const evento = await OutboxEvent.findOne({ where: { aggregateId: futura.id, eventType: 'crm.task.cancelled' }, transaction: t });
    assert.ok(evento, 'o Calendário recebe o cancelamento da tarefa');
  });
});

test('CAD-11/M3-12: tarefa de oportunidade ganha ou perdida não escala; a de oportunidade aberta escala e chega à gerência pela regra configurável', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const gestor = await createMember(tenant, t, { label: 'gestor', permissions: ['crm:dashboard:read'] });
    const corretor = await createMember(tenant, t, { label: 'corretor' });
    const vencida = new Date(Date.now() - 5 * 3600000); // venceu há 5 horas

    const aberta = await createOpportunity(tenant, t, { ownerUserId: corretor });
    const tarefaAberta = await task(t, aberta, { dueAt: vencida, title: 'Retornar cliente' });

    const ganha = await createOpportunity(tenant, t, { ownerUserId: corretor });
    const tarefaGanha = await task(t, ganha, { dueAt: vencida, title: 'Tarefa da ganha' });
    await opportunityService.updateOpportunity(ganha.id, { stage: 'WON', wonReason: 'PRICE_ACCEPTED' }, tenant.userId, t);

    const perdida = await createOpportunity(tenant, t, { ownerUserId: corretor });
    await opportunityService.updateOpportunity(perdida.id, { stage: 'LOST', lostReason: 'LOCATION' }, tenant.userId, t);
    const tarefaPerdida = await task(t, perdida, { dueAt: vencida, title: 'Tarefa criada depois da perda' });

    // Regra: gerência só depois de 48 h vencida. Com 5 h, só o 1º nível (responsável e dono da oportunidade).
    await upsertSetting('crm.tarefa_vencida.escalar_gerencia_apos_horas', 48, tenant, tenant.userId, t);
    await escalateOverdueCrmTasks(t, new Date());

    const nivel1 = await AuditLog.findOne({ where: { entityId: tarefaAberta.id, action: 'crm.task.job_escalation' }, transaction: t });
    assert.ok(nivel1, 'tarefa vencida de oportunidade aberta escala (1º nível)');
    for (const id of [tarefaGanha.id, tarefaPerdida.id]) {
      const escalou = await AuditLog.count({ where: { entityId: id, action: ['crm.task.job_escalation', 'crm.task.job_escalation_management'] }, transaction: t });
      assert.equal(escalou, 0, 'tarefa de oportunidade ganha/perdida não escala');
    }
    const avisoCorretor = await Notification.count({ where: { userId: corretor, title: 'Tarefa de CRM vencida' }, transaction: t });
    assert.equal(avisoCorretor, 1, 'o dono da oportunidade é avisado no 1º nível');
    const gestorAntes = await Notification.count({ where: { userId: gestor }, transaction: t });
    assert.equal(gestorAntes, 0, 'antes do prazo configurado a gerência não é acionada');

    // O administrador reduz o prazo para 2 h: a mesma tarefa (5 h vencida) chega à gerência na próxima rodada, uma vez só.
    await upsertSetting('crm.tarefa_vencida.escalar_gerencia_apos_horas', 2, tenant, tenant.userId, t);
    await escalateOverdueCrmTasks(t, new Date());
    await escalateOverdueCrmTasks(t, new Date());
    const avisoGestor = await Notification.count({ where: { userId: gestor, title: 'Tarefa de CRM vencida escalada para a gerência' }, transaction: t });
    assert.equal(avisoGestor, 1, 'a gerência recebe o escalonamento uma vez');
    const nivel2 = await AuditLog.findOne({ where: { entityId: tarefaAberta.id, action: 'crm.task.job_escalation_management' }, transaction: t });
    assert.ok(nivel2 && nivel2.afterJson.notifiedUserIds.includes(gestor), 'auditoria do 2º nível lista o gestor avisado');
    const evento = await OutboxEvent.findOne({ where: { aggregateId: tarefaAberta.id, eventType: 'crm.task.escalated' }, transaction: t });
    assert.ok(evento, 'evento crm.task.escalated publicado');
    assert.equal(await AuditLog.count({ where: { entityId: tarefaAberta.id, action: 'crm.task.job_escalation' }, transaction: t }), 1, '1º nível não se repete');
  });
});
