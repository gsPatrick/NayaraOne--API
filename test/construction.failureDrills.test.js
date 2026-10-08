'use strict';

/**
 * construction.failureDrills.test.js — Caderno Técnico, página 165, item 13 ("segurança/
 * antifraude do módulo de Obras" — evidência de "security scan e load/failure tests" pedida
 * pela auditora externa, 08/10/2026).
 *
 * Este arquivo cobre a parte de FAILURE DRILLS (simulação real de falha, não apenas "a função
 * não lança erro"): cada drill força um erro de verdade NO MEIO de uma transação de negócio
 * real (depois do lock pessimista, antes do commit) e confirma que o rollback é completo —
 * nada fica "pela metade" (nem o agregado principal, nem o evento de domínio/Outbox, nem o
 * lançamento financeiro). Usa o mesmo padrão `withRollbackTenantTransaction`/`withCommitted` do
 * resto da suíte (ver test/testHelpers.js e test/construction.measurements.test.js).
 *
 * Drill 1 — falha de conexão/timeout simulada durante decideStageMeasurement (aprovação de
 *   medição): mocka temporariamente financialEntriesService.createFinancialEntry (chamada
 *   DEPOIS do lock pessimista em getStageMeasurement, ANTES do commit) para rejeitar como se a
 *   conexão com o Financeiro tivesse caído. Confirma que a medição permanece no estado anterior
 *   (REVIEWED), sem financial_entry, sem status PAYABLE.
 * Drill 2 — falha ao publicar evento na Outbox durante approveBudget: mocka temporariamente
 *   OutboxEvent.create (chamado por publishBudgetApproved) para rejeitar. Confirma que o budget
 *   NÃO fica aprovado (nem o Project avança de PLANNED pra BUDGETED) — tudo ou nada.
 * Drill 3 — concorrência real: duas aprovações simultâneas da MESMA medição (duas transações
 *   commitadas de verdade, não a mesma chamada 2x em sequência) — confirma que o lock
 *   pessimista garante que só uma aprovação vence e a segunda falha com
 *   STAGE_MEASUREMENT_INVALID_STATUS, sem duplicar o lançamento financeiro.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { OutboxEvent } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// Mesmo helper de test/construction.measurements.test.js — transação REALMENTE commitada
// (conexão própria), necessária pra exercitar rollback/corrida de verdade (uma transação
// `withRollbackTenantTransaction` nunca commita nada, então não serve pra provar que um
// rollback FORÇADO no meio do caminho não deixa resíduo).
async function withCommitted(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function setupProjectAndStage(transaction, suffix) {
  const project = await projectsService.createProject(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `FAILURE DRILL — Obra ${suffix}`,
      budgetAmount: 100000,
    },
    tenant.userId,
    transaction
  );
  const stage = await projectStagesService.createProjectStage(
    project.id,
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `Etapa ${suffix}`, sequence: 1, plannedPct: 50 },
    tenant.userId,
    transaction
  );
  return { project, stage };
}

// --- Drill 1: falha de conexão/timeout durante aprovação de medição --------------------------

test('DRILL 1 — timeout simulado em financialEntriesService.createFinancialEntry durante decideStageMeasurement: medição permanece REVIEWED, sem payable', async () => {
  const suffix = uniqueSuffix();

  const { measurementId } = await withCommitted(async (t) => {
    const { stage } = await setupProjectAndStage(t, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        measuredPct: 40,
        measuredAt: '2026-09-01',
        items: [{ description: `Drill 1 ${suffix}`, quantity: 1, unitPrice: 1234.56 }],
      },
      tenant.userId,
      t
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, t);
    await stageMeasurementsService.reviewStageMeasurement(measurement.id, {}, tenant.userId, t);
    return { measurementId: measurement.id };
  });

  // Mock temporário: simula a conexão com o Financeiro caindo DEPOIS que decideStageMeasurement
  // já travou a linha da medição (lock pessimista em getStageMeasurement) e já mutou o status
  // em memória para APPROVED/stage DONE — exatamente o "meio do caminho" de uma transação real.
  const originalCreateFinancialEntry = financialEntriesService.createFinancialEntry;
  financialEntriesService.createFinancialEntry = async () => {
    const err = new Error('DRILL: timeout simulado de conexão com o Financeiro (ETIMEDOUT)');
    err.code = 'ETIMEDOUT';
    throw err;
  };

  try {
    await assert.rejects(
      () => withCommitted((t) => stageMeasurementsService.decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t)),
      /timeout simulado/
    );
  } finally {
    financialEntriesService.createFinancialEntry = originalCreateFinancialEntry;
  }

  // Confirma rollback REAL e completo: medição continua REVIEWED (não ficou "pela metade" em
  // APPROVED nem PAYABLE), sem payableFinancialEntryId, e nenhum lançamento financeiro foi
  // criado (mesmo tendo chegado perto — o INSERT nunca commitou).
  await withCommitted(async (t) => {
    const measurement = await stageMeasurementsService.getStageMeasurement(measurementId, t);
    assert.equal(measurement.status, 'REVIEWED', 'rollback precisa devolver a medição ao estado anterior à tentativa de aprovação');
    assert.equal(measurement.payableFinancialEntryId, null);
    assert.equal(measurement.approvedAt, null);

    const [rows] = await sequelize.query(
      `SELECT id FROM finance.financial_entries WHERE idempotency_key = :key`,
      { replacements: { key: `measurement.payable:${measurementId}` }, transaction: t }
    );
    assert.equal(rows.length, 0, 'nenhum lançamento financeiro pode sobreviver ao rollback do drill');
  });
});

// --- Drill 2: falha ao publicar evento na Outbox durante aprovação de orçamento --------------

test('DRILL 2 — falha simulada em OutboxEvent.create durante approveBudget: budget e project permanecem como antes (tudo ou nada)', async () => {
  const suffix = uniqueSuffix();

  // approveBudget exige uma MarginRule ativa (Motor de Regras genérico — ver
  // marginRulesService.getActiveMarginRule). Mesmo padrão de test/construction.budget.test.js:
  // cria uma versão nova (commitada de verdade, precisa de conexão própria) e, no finally,
  // apaga tudo e reativa a que estava vigente antes, pra não poluir o tenant compartilhado.
  const {
    MarginRule: MarginRuleModel,
    RuleVersion: RuleVersionModel,
    RuleScope: RuleScopeModel,
    RulePublication: RulePublicationModel,
    RuleEvaluationLog: RuleEvaluationLogModel,
  } = require('../src/models');
  const previouslyActiveRule = await MarginRuleModel.findOne({ where: { groupId: tenant.groupId, companyId: tenant.companyId, isActive: true } });

  const { budgetId, projectId, marginRuleId } = await withCommitted(async (t) => {
    const project = await projectsService.createProject(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        name: `FAILURE DRILL 2 — Obra ${suffix}`,
        budgetAmount: 0,
      },
      tenant.userId,
      t
    );
    const marginRule = await marginRulesService.createMarginRule(
      { groupId: tenant.groupId, companyId: tenant.companyId, minMarginPct: 15 },
      tenant.userId,
      t
    );
    const budget = await budgetsService.createBudget(project.id, { groupId: tenant.groupId, companyId: tenant.companyId }, tenant.userId, t);
    await budgetLinesService.createBudgetLine(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, category: 'MATERIAL', description: `Linha drill 2 ${suffix}`, plannedAmount: 50000, budgetId: budget.id },
      tenant.userId,
      t
    );
    return { budgetId: budget.id, projectId: project.id, marginRuleId: marginRule.id };
  });

  // Mock temporário: approveBudget chama publishBudgetApproved -> publishDomainEvent ->
  // OutboxEvent.create (padrão Transactional Outbox). Simula a gravação do evento falhando
  // DEPOIS que o budget já foi mutado em memória (status=APPROVED, baselineAmount/ruleVersionId
  // já atribuídos) e ANTES do commit — se o rollback não for completo, o budget ficaria
  // aprovado sem o evento correspondente no barramento (inconsistência real pro Financeiro/BI).
  const originalOutboxCreate = OutboxEvent.create;
  OutboxEvent.create = async () => {
    throw new Error('DRILL: falha simulada ao publicar evento na Outbox (conexão perdida)');
  };

  try {
    await assert.rejects(
      () => withCommitted((t) => budgetsService.approveBudget(budgetId, tenant.userId, t)),
      /DRILL: falha simulada ao publicar evento na Outbox/
    );
  } finally {
    OutboxEvent.create = originalOutboxCreate;
  }

  try {
    await withCommitted(async (t) => {
      const budget = await budgetsService.getBudget(budgetId, t);
      assert.equal(budget.status, 'DRAFT', 'budget não pode ficar aprovado se o evento de domínio não foi publicado na mesma transação');
      assert.equal(budget.baselineAmount, null);
      assert.equal(budget.approvedAt, null);

      const { Project } = require('../src/models');
      const project = await Project.findByPk(projectId, { transaction: t });
      assert.equal(project.status, 'PLANNED', 'rollback precisa reverter também a transição automática PLANNED -> BUDGETED');
      assert.equal(project.budgetAmount, '0.00');
    });
  } finally {
    // Limpeza — mesmo padrão de test/construction.budget.test.js: apaga os dados commitados de
    // verdade (banco de dev compartilhado) e reativa a MarginRule que estava vigente antes.
    const { Budget, BudgetLine, Project } = require('../src/models');
    await withCommitted(async (t) => {
      await BudgetLine.destroy({ where: { projectId }, transaction: t, force: true });
      await Budget.destroy({ where: { id: budgetId }, transaction: t, force: true });
      await Project.destroy({ where: { id: projectId }, transaction: t, force: true });
      await RuleEvaluationLogModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RuleScopeModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RulePublicationModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RuleVersionModel.destroy({ where: { id: marginRuleId }, transaction: t, force: true });
      await MarginRuleModel.destroy({ where: { id: marginRuleId }, transaction: t, force: true });
      if (previouslyActiveRule) {
        await MarginRuleModel.update({ isActive: true }, { where: { id: previouslyActiveRule.id }, transaction: t });
        await RuleVersionModel.update({ effectiveUntil: null }, { where: { id: previouslyActiveRule.id }, transaction: t });
      }
    });
  }
});

// --- Drill 3: concorrência real — duas aprovações simultâneas da mesma medição ---------------

test('DRILL 3 — duas aprovações concorrentes da MESMA medição: lock pessimista garante só 1 sucesso, sem payable duplicado', async () => {
  const suffix = uniqueSuffix();

  const { measurementId } = await withCommitted(async (t) => {
    const { stage } = await setupProjectAndStage(t, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        measuredPct: 70,
        measuredAt: '2026-09-01',
        items: [{ description: `Drill 3 ${suffix}`, quantity: 1, unitPrice: 999.99 }],
      },
      tenant.userId,
      t
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, t);
    await stageMeasurementsService.reviewStageMeasurement(measurement.id, {}, tenant.userId, t);
    return { measurementId: measurement.id };
  });

  // Duas aprovações REAIS disparadas ao mesmo tempo, cada uma em sua própria transação/conexão
  // — exercita a corrida de verdade contra o lock pessimista (transaction.LOCK.UPDATE) em
  // getStageMeasurement, não apenas duas chamadas sequenciais da mesma função.
  const resultados = await Promise.allSettled([
    withCommitted((t) => stageMeasurementsService.decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t)),
    withCommitted((t) => stageMeasurementsService.decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t)),
  ]);

  const sucessos = resultados.filter((r) => r.status === 'fulfilled');
  const falhas = resultados.filter((r) => r.status === 'rejected');
  assert.equal(sucessos.length, 1, 'apenas UMA das duas aprovações concorrentes pode vencer o lock pessimista');
  assert.equal(falhas.length, 1, 'a segunda aprovação concorrente precisa falhar, nunca ser aceita silenciosamente');
  assert.equal(falhas[0].reason.code, 'STAGE_MEASUREMENT_INVALID_STATUS');

  await withCommitted(async (t) => {
    const [rows] = await sequelize.query(
      `SELECT id FROM finance.financial_entries WHERE idempotency_key = :key`,
      { replacements: { key: `measurement.payable:${measurementId}` }, transaction: t }
    );
    assert.equal(rows.length, 1, 'só pode existir UM lançamento financeiro mesmo com duas aprovações concorrentes');

    const measurement = await stageMeasurementsService.getStageMeasurement(measurementId, t);
    assert.equal(measurement.status, 'PAYABLE');

    // Limpeza — banco de dev compartilhado entre agentes/suítes (mesmo padrão de ADV-F21 em
    // test/adversarial.finance.test.js e do teste de concorrência em
    // test/construction.measurements.test.js).
    await sequelize.query(`UPDATE construction.stage_measurements SET payable_financial_entry_id = NULL WHERE id = :id`, {
      replacements: { id: measurementId },
      transaction: t,
    });
    await sequelize.query(`DELETE FROM finance.financial_entries WHERE id = :id`, { replacements: { id: rows[0].id }, transaction: t });
  });
});
