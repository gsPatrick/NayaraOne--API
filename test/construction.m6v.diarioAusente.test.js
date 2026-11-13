'use strict';

// Verificação independente do Marco 6 — M6-108. Caderno Obras §6: "ausência de diário gera tarefa conforme regra". A regra
// é da empresa (parâmetros construction.diario_ausente.*): ligada/desligada, situações de obra, dias exigidos, feriados e
// prioridade da tarefa; a tarefa de documentação do prestador tem janela e prioridade próprias. Os padrões mantêm o
// comportamento anterior (obra ACTIVE, segunda a sexta, sem feriado, HIGH; 7 dias, MEDIUM).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W } = require('./constructionM6vFixture');
const { Task, Project } = require('../src/models');
const settingsService = require('../src/features/settings/settings.service');
const projectsService = require('../src/features/construction/projects.service');
const { detectMissingDailyReports } = require('../src/engines/jobs/missingDailyReportJob');
const { resolveMissingReportRule, previousRequiredDay } = require('../src/features/construction/missingDailyReportRule');

let tenant;
before(async () => {
  tenant = await H.getSeedTenant();
});
after(async () => {
  await H.sequelize.close();
});

const PERM = { permissions: ['construction:approve', 'settings:update'] };
const setParam = (t, key, value) => settingsService.upsertSetting(`construction.diario_ausente.${key}`, value, W(tenant), tenant.userId, t, PERM);

async function obraNaSituacao(t, status) {
  const obra = await projectsService.createProject(W(tenant, { name: `Obra diário ${H.uniqueSuffix()}`, responsibleUserId: tenant.userId }), tenant.userId, t);
  await Project.update({ status }, { where: { id: obra.id }, transaction: t });
  return obra;
}
const tarefasDa = (t, obra) => Task.findAll({ where: { relatedEntityType: 'construction.projects', relatedEntityId: obra.id }, transaction: t });

test('M6-108: padrão = regra anterior (obra ACTIVE, segunda a sexta, prioridade HIGH)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const regra = await resolveMissingReportRule(W(tenant), t);
    assert.equal(regra.enabled, true);
    assert.deepEqual(regra.statuses, ['ACTIVE']);
    assert.deepEqual([...regra.weekdays].sort(), [1, 2, 3, 4, 5]);
    assert.equal(regra.priority, 'HIGH');
    assert.equal(regra.docsWindowDays, 7);
    // Segunda-feira 09/11/2026 → o diário exigido é o de sexta 06/11.
    assert.equal(previousRequiredDay(new Date('2026-11-09T12:00:00Z'), regra), '2026-11-06');
    const ativa = await obraNaSituacao(t, 'ACTIVE');
    await detectMissingDailyReports(t, new Date('2026-11-09T12:00:00Z'), W(tenant));
    const [tarefa] = await tarefasDa(t, ativa);
    assert.ok(tarefa, 'obra ACTIVE sem diário gera tarefa');
    assert.equal(tarefa.priority, 'HIGH');
    assert.match(tarefa.title, /2026-11-06/);
  });
});

test('M6-108: a empresa configura a regra — situações, dias, feriados e prioridade valem; desligada, nada é criado', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    await setParam(t, 'status_obra', 'ACTIVE,PAUSED');
    await setParam(t, 'dias_semana', '1,2,3,4,5,6');
    await setParam(t, 'prioridade_tarefa', 'URGENT');
    await setParam(t, 'considerar_feriados', true);
    const pausada = await obraNaSituacao(t, 'PAUSED');
    // Segunda 16/11/2026: sábado 14/11 passa a ser exigido; com feriados, 15/11 (domingo) já não contaria.
    const regra = await resolveMissingReportRule(W(tenant), t);
    assert.equal(previousRequiredDay(new Date('2026-11-16T12:00:00Z'), regra), '2026-11-14');
    // Terça 03/11/2026: 02/11 (Finados) é feriado nacional → o exigido é sábado 31/10.
    assert.equal(previousRequiredDay(new Date('2026-11-03T12:00:00Z'), regra), '2026-10-31');
    await detectMissingDailyReports(t, new Date('2026-11-16T12:00:00Z'), W(tenant));
    const [tarefa] = await tarefasDa(t, pausada);
    assert.ok(tarefa, 'obra PAUSED entra pela regra da empresa');
    assert.equal(tarefa.priority, 'URGENT');
    assert.match(tarefa.title, /2026-11-14/);

    await setParam(t, 'ativo', false);
    const outra = await obraNaSituacao(t, 'ACTIVE');
    const r = await detectMissingDailyReports(t, new Date('2026-11-17T12:00:00Z'), W(tenant));
    assert.equal(r.ruleEnabled, false);
    assert.equal((await tarefasDa(t, outra)).length, 0, 'regra desligada não cria tarefa');
  });
});

test('M6-108: valores fora do catálogo são recusados pelo serviço de parâmetros', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(setParam(t, 'status_obra', 'ACTIVE,QUALQUER'), { code: 'SETTING_INVALID_VALUE' });
    await assert.rejects(setParam(t, 'dias_semana', '7'), { code: 'SETTING_INVALID_VALUE' });
    await assert.rejects(setParam(t, 'prioridade_tarefa', 'ALTISSIMA'), { code: 'SETTING_INVALID_VALUE' });
    await assert.rejects(setParam(t, 'documentos_janela_dias', 0), { code: 'SETTING_INVALID_VALUE' });
    await assert.rejects(settingsService.upsertSetting('construction.diario_ausente.ativo', false, W(tenant), tenant.userId, t, { permissions: ['settings:update'] }), (e) => /PERMISSION|SETTING/.test(e.code));
  });
});
