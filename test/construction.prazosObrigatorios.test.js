'use strict';

// Segunda leva de 16/11/2026, Lote 4 (itens 3 e 4-A do plano-segunda-leva.md; DI-BI2-3):
// - M6:16 "Etapas possuem ... prazo": a etapa nasce com prazo (endsAt) e o prazo não pode ser retirado na edição.
//   Custo, código e responsável continuam exigidos só no início da etapa (rodada 46).
// - M6:11 / M9:793: a previsão de término da obra, exigida em READY -> ACTIVE, não pode ser apagada depois disso.
// Antes desta leva, todos os casos "sem prazo" abaixo passavam (201/200) e deixavam o indicador de atrasos incompleto.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const scheduleRequired = require('../src/features/construction/scheduleRequired');
const { ProjectStage } = require('../src/models');
const { prazoEtapaPadrao } = require('./helpers/prazoEtapaPadrao');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const W = (fields = {}) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });
const recusa = (code) => (err) => err.statusCode === 422 && err.code === code;
const VAZIOS = [undefined, null, '', '   '];

async function obraPlanejada(transaction, extra = {}) {
  return projectsService.createProject(W({ name: `Obra prazo ${uniqueSuffix()}`, responsibleUserId: tenant.userId, ...extra }), tenant.userId, transaction);
}

// Percorre a máquina de estados real até ACTIVE (mesmo caminho de construction.missingDailyReport.test.js).
async function obraEmExecucao(transaction) {
  const project = await obraPlanejada(transaction, { startsAt: '2026-10-01', endsAtPlanned: '2027-10-01' });
  await marginRulesService.createMarginRule(W({ minMarginPct: 10 }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, W(), tenant.userId, transaction);
  await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
  await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);
  await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
  return projectsService.getProject(project.id, transaction);
}

test('regra pura: a previsão de término só fica travada depois de READY -> ACTIVE', () => {
  const travados = ['ACTIVE', 'PAUSED', 'FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED'];
  assert.deepEqual([...scheduleRequired.PLANNED_END_LOCKED_STATUSES], travados);
  for (const status of ['PLANNED', 'BUDGETED', 'READY', 'CANCELLED']) {
    for (const vazio of [null, '']) assert.doesNotThrow(() => scheduleRequired.assertPlannedEndKept({ status }, vazio), status);
  }
  for (const status of travados) {
    for (const vazio of [null, '', '  ']) {
      assert.throws(() => scheduleRequired.assertPlannedEndKept({ status }, vazio), recusa('PROJECT_PLANNED_END_REQUIRED'), status);
    }
    assert.doesNotThrow(() => scheduleRequired.assertPlannedEndKept({ status }, undefined), 'campo ausente não mexe');
    assert.doesNotThrow(() => scheduleRequired.assertPlannedEndKept({ status }, '2027-12-01'), 'trocar a data continua livre');
  }
  for (const vazio of VAZIOS) assert.throws(() => scheduleRequired.assertStageEndOnCreate(vazio), recusa('PROJECT_STAGE_END_DATE_REQUIRED'));
  assert.doesNotThrow(() => scheduleRequired.assertStageEndKept(undefined));
  for (const vazio of [null, '', '  ']) assert.throws(() => scheduleRequired.assertStageEndKept(vazio), recusa('PROJECT_STAGE_END_DATE_REQUIRED'));
});

test('M6:16: etapa sem prazo é recusada na criação (422) e não grava nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await obraPlanejada(t);
    for (const endsAt of VAZIOS) {
      const payload = W({ name: `Etapa ${uniqueSuffix()}` });
      if (endsAt !== undefined) payload.endsAt = endsAt;
      await assert.rejects(projectStagesService.createProjectStage(obra.id, payload, tenant.userId, t), recusa('PROJECT_STAGE_END_DATE_REQUIRED'), `endsAt=${JSON.stringify(endsAt)}`);
    }
    assert.equal(await ProjectStage.count({ where: { projectId: obra.id }, transaction: t }), 0);
    // O nome continua sendo conferido antes (o erro de campo básico não muda).
    await assert.rejects(projectStagesService.createProjectStage(obra.id, W({}), tenant.userId, t), { code: 'PROJECT_STAGE_VALIDATION' });
  });
});

test('M6:16: com prazo a etapa nasce sem custo, código e responsável; eles seguem exigidos só no início', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await obraPlanejada(t);
    const prazo = prazoEtapaPadrao();
    const etapa = await projectStagesService.createProjectStage(obra.id, W({ name: 'Fundação', endsAt: prazo }), tenant.userId, t);
    assert.equal(new Date(etapa.endsAt).toISOString(), prazo);
    assert.equal(etapa.plannedCost, null);
    assert.equal(etapa.stageCode, null);
    await assert.rejects(
      projectStagesService.updateProjectStage(etapa.id, { status: 'IN_PROGRESS' }, tenant.userId, t),
      (err) => err.code === 'PROJECT_STAGE_MISSING_REQUIRED_FIELDS' && /custo previsto/.test(err.message) && !/término/.test(err.message)
    );
  });
});

test('M6:16: na edição o prazo da etapa pode ser trocado, nunca retirado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await obraPlanejada(t);
    const etapa = await projectStagesService.createProjectStage(obra.id, W({ name: 'Alvenaria', endsAt: '2027-03-31T15:00:00.000Z' }), tenant.userId, t);
    for (const endsAt of [null, '', '  ']) {
      await assert.rejects(projectStagesService.updateProjectStage(etapa.id, { endsAt }, tenant.userId, t), recusa('PROJECT_STAGE_END_DATE_REQUIRED'), `endsAt=${JSON.stringify(endsAt)}`);
    }
    const renomeada = await projectStagesService.updateProjectStage(etapa.id, { name: 'Alvenaria externa' }, tenant.userId, t);
    assert.equal(new Date(renomeada.endsAt).toISOString(), '2027-03-31T15:00:00.000Z', 'payload sem o campo não mexe no prazo');
    const trocada = await projectStagesService.updateProjectStage(etapa.id, { endsAt: '2027-04-30T15:00:00.000Z' }, tenant.userId, t);
    assert.equal(new Date(trocada.endsAt).toISOString(), '2027-04-30T15:00:00.000Z');
    const gravada = await ProjectStage.findByPk(etapa.id, { transaction: t });
    assert.equal(new Date(gravada.endsAt).toISOString(), '2027-04-30T15:00:00.000Z');
  });
});

test('Item 4-A: obra PLANNED pode apagar a previsão de término (preenchida aos poucos)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await obraPlanejada(t, { endsAtPlanned: '2027-10-01' });
    const editada = await projectsService.updateProject(obra.id, { endsAtPlanned: null }, tenant.userId, t);
    assert.equal(editada.status, 'PLANNED');
    assert.equal(editada.endsAtPlanned, null);
  });
});

test('Item 4-A: obra em execução (ACTIVE e PAUSED) não apaga a previsão de término (422), mas troca a data', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const obra = await obraEmExecucao(t);
    assert.equal(obra.status, 'ACTIVE');
    for (const endsAtPlanned of [null, '', '  ']) {
      await assert.rejects(projectsService.updateProject(obra.id, { endsAtPlanned }, tenant.userId, t), recusa('PROJECT_PLANNED_END_REQUIRED'), `endsAtPlanned=${JSON.stringify(endsAtPlanned)}`);
    }
    const trocada = await projectsService.updateProject(obra.id, { endsAtPlanned: '2027-12-01T15:00:00.000Z' }, tenant.userId, t);
    assert.equal(new Date(trocada.endsAtPlanned).toISOString(), '2027-12-01T15:00:00.000Z', 'trocar a data continua permitido');
    await projectsService.transitionProject(obra.id, 'PAUSED', tenant.userId, t);
    await assert.rejects(projectsService.updateProject(obra.id, { endsAtPlanned: null }, tenant.userId, t), recusa('PROJECT_PLANNED_END_REQUIRED'));
    const gravada = await projectsService.getProject(obra.id, t);
    assert.equal(new Date(gravada.endsAtPlanned).toISOString(), '2027-12-01T15:00:00.000Z');
  });
});
