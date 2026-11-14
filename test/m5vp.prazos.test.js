'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — livro §15 "Prazos jurídicos":
 *  - M5-A0108 "due_at em timezone correto": o fuso vem da configuração da empresa (`legal.prazos.fuso_horario`), não de -03:00 fixo;
 *  - M5-A0109 "Alertas escalonados por regra": antecedência e escalonamento por criticidade são parâmetros (padrão 48 h / 24 h);
 *  - M5-A0110 "Prazo crítico vencido abre ocorrência HIGH/CRITICAL": também quando a criticidade sobe depois do 1º alerta.
 * Serviço e job reais, em transação desfeita (RLS do tenant de seed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { LegalDeadline, Task, Notification } = require('../src/models');
const { newUser, newCase, newDeadline, PAST } = require('./m5fech.juridico.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const HOUR = 3600000;
const set = (key, value, t) => upsertSetting(key, value, tenant, tenant.userId, t);
const reload = (id, t) => LegalDeadline.findByPk(id, { transaction: t });

test('M5-A0108/§15: o vencimento só com a data fecha às 23:59 do fuso configurado pela empresa (Manaus = UTC-4), e o texto da tarefa usa esse fuso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const padrao = await newDeadline(legalCase.id, tenant, t, { dueAt: '2027-03-10' });
    assert.equal(new Date(padrao.dueAt).toISOString(), '2027-03-11T02:59:00.000Z', 'sem configuração: 23:59 de Brasília');

    await set('legal.prazos.fuso_horario', 'America/Manaus', t);
    const manaus = await newDeadline(legalCase.id, tenant, t, { dueAt: '2027-03-10' });
    assert.equal(new Date(manaus.dueAt).toISOString(), '2027-03-11T03:59:00.000Z', '23:59 de Manaus');
    const comHora = await newDeadline(legalCase.id, tenant, t, { dueAt: '2027-03-10T17:00' });
    assert.equal(new Date(comHora.dueAt).toISOString(), '2027-03-10T21:00:00.000Z', 'hora local de Manaus');
    const task = await Task.findByPk(manaus.taskId, { transaction: t });
    assert.match(task.description, /America\/Manaus/);
    // Remarcar também usa o fuso da empresa.
    const remarcado = await legalDeadlinesService.updateLegalDeadline(manaus.id, { dueAt: '2027-03-12', changeReason: 'Prorrogação deferida' }, tenant.userId, t);
    assert.equal(new Date(remarcado.dueAt).toISOString(), '2027-03-13T03:59:00.000Z');

    await assert.rejects(() => set('legal.prazos.fuso_horario', 'Lua/Base_Alfa', t), (err) => err.code === 'SETTING_INVALID_VALUE');
  });
});

test('M5-A0109/§15: antecedência do aviso e escalonamento seguem o parâmetro da criticidade, não 48 h/24 h fixos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: owner.id, escalationUserId: tenant.userId });
    const now = new Date();
    const in60h = new Date(now.getTime() + 60 * HOUR);
    const low = await newDeadline(legalCase.id, tenant, t, { criticality: 'LOW', dueAt: in60h, responsibleUserId: owner.id });
    const medium = await newDeadline(legalCase.id, tenant, t, { criticality: 'MEDIUM', dueAt: in60h, responsibleUserId: owner.id });

    await set('legal.prazos.alerta_antecedencia_horas.LOW', 72, t);
    await processDeadlinesInTransaction(t, now);
    assert.equal((await reload(low.id, t)).lastAlertedSeverity, 'DUE_SOON', 'LOW avisa com 72 h de antecedência');
    assert.equal((await reload(medium.id, t)).lastAlertedSeverity, null, 'MEDIUM continua no padrão de 48 h');
    const list = await legalDeadlinesService.listLegalDeadlines(t, { legalCaseId: legalCase.id });
    assert.equal(list.find((d) => d.id === low.id).severity, 'DUE_SOON');
    assert.equal(list.find((d) => d.id === medium.id).severity, 'NORMAL');

    const critical = await newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', dueAt: PAST(1), responsibleUserId: owner.id });
    const high = await newDeadline(legalCase.id, tenant, t, { criticality: 'HIGH', dueAt: PAST(1), responsibleUserId: owner.id });
    await set('legal.prazos.escalonamento_horas.CRITICAL', 2, t);
    await processDeadlinesInTransaction(t, now); // primeiro alerta de vencido
    const later = new Date(now.getTime() + 3 * HOUR);
    await processDeadlinesInTransaction(t, later);
    assert.ok((await reload(critical.id, t)).escalatedAt, 'CRITICAL escala depois de 2 h');
    assert.equal((await reload(high.id, t)).escalatedAt, null, 'HIGH continua esperando as 24 h do padrão');
    await processDeadlinesInTransaction(t, new Date(now.getTime() + 25 * HOUR));
    assert.ok((await reload(high.id, t)).escalatedAt, 'HIGH escala depois de 24 h');
    const escalations = await Notification.count({ where: { userId: tenant.userId, title: 'ESCALONAMENTO — prazo jurídico vencido sem tratativa' }, transaction: t });
    assert.ok(escalations >= 2);

    await assert.rejects(() => set('legal.prazos.escalonamento_horas.CRITICAL', 0, t), (err) => err.code === 'SETTING_INVALID_VALUE');
  });
});

test('M5-A0110/§15: prazo LOW vencido já alertado, elevado a HIGH, abre UMA ocorrência HIGH na rodada seguinte', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: owner.id });
    const d = await newDeadline(legalCase.id, tenant, t, { criticality: 'LOW', dueAt: PAST(2), responsibleUserId: owner.id });
    const now = new Date();
    await processDeadlinesInTransaction(t, now);
    assert.equal((await reload(d.id, t)).lastAlertedSeverity, 'OVERDUE');
    assert.equal((await reload(d.id, t)).occurrenceTaskId, null, 'LOW vencido não abre ocorrência');

    await legalDeadlinesService.updateLegalDeadline(d.id, { criticality: 'HIGH' }, tenant.userId, t);
    await processDeadlinesInTransaction(t, new Date(now.getTime() + HOUR));
    const fresh = await reload(d.id, t);
    assert.ok(fresh.occurrenceTaskId, 'ocorrência aberta');
    const occ = await Task.findAll({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: d.id }, transaction: t });
    assert.equal(occ.length, 1);
    assert.equal(occ[0].priority, 'HIGH');
    assert.equal(occ[0].assignedToUserId, owner.id);

    await processDeadlinesInTransaction(t, new Date(now.getTime() + 2 * HOUR));
    assert.equal(await Task.count({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: d.id }, transaction: t }), 1, 'não duplica');
  });
});
