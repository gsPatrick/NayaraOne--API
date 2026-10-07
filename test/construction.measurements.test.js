'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function setupProjectAndStage(transaction, suffix) {
  const project = await projectsService.createProject(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `HOMO QA — Obra medição ${suffix}`,
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

async function createSubmittedMeasurement(transaction, stageId, suffix, overrides = {}) {
  const measurement = await stageMeasurementsService.createStageMeasurement(
    stageId,
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      measuredPct: 40,
      measuredAt: '2026-09-01',
      items: [{ description: `Serviço ${suffix}`, quantity: 10, unitPrice: 150 }],
      ...overrides,
    },
    tenant.userId,
    transaction
  );
  return stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);
}

// --- M6-10/M6-21: máquina de estados completa -----------------------------------------------

test('M6-10 máquina de estados: DRAFT -> SUBMITTED -> REVIEWED -> APPROVED -> PAYABLE', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);

    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        measuredPct: 30,
        measuredAt: '2026-09-01',
        items: [{ description: 'Fundação', quantity: 1, unitPrice: 5000 }],
      },
      tenant.userId,
      transaction
    );
    assert.equal(measurement.status, 'DRAFT');
    assert.equal(measurement.totalAmount, '5000.00');

    const submitted = await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.ok(submitted.submittedAt);

    const reviewed = await stageMeasurementsService.reviewStageMeasurement(
      measurement.id,
      { notes: 'Medição conferida em campo.' },
      tenant.userId,
      transaction
    );
    assert.equal(reviewed.status, 'REVIEWED');
    assert.ok(reviewed.reviewedAt);

    const approved = await stageMeasurementsService.decideStageMeasurement(
      measurement.id,
      { decision: 'APPROVED' },
      tenant.userId,
      transaction
    );
    // Aprovar já avança automaticamente para PAYABLE (bug #5 do Marco 6: aprovação SEMPRE
    // gera obrigação financeira, nunca fica "aprovada" sem lançamento).
    assert.equal(approved.status, 'PAYABLE');
    assert.ok(approved.payableFinancialEntryId, 'medição aprovada precisa ter um lançamento financeiro vinculado');
  });
});

test('M6-10 transições inválidas são recusadas (não dá pra decidir uma medição em DRAFT)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 10, measuredAt: '2026-09-01' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'STAGE_MEASUREMENT_INVALID_STATUS');
        return true;
      }
    );
  });
});

test('M6-10 alteração após SUBMITTED cria uma revisão nova (não sobrescreve a original)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);
    const submitted = await createSubmittedMeasurement(transaction, stage.id, suffix);

    const revision = await stageMeasurementsService.reviseStageMeasurement(
      submitted.id,
      { measuredPct: 45, items: [{ description: 'Correção de quantitativo', quantity: 12, unitPrice: 150 }] },
      tenant.userId,
      transaction
    );

    assert.equal(revision.status, 'DRAFT');
    assert.equal(revision.parentMeasurementId, submitted.id);
    assert.equal(revision.revisionNumber, submitted.revisionNumber + 1);

    const original = await stageMeasurementsService.getStageMeasurement(submitted.id, transaction);
    assert.equal(original.status, 'SUPERSEDED', 'a medição original vira histórico (não é editada)');
    assert.equal(original.measuredPct, submitted.measuredPct, 'a original nunca é sobrescrita');
  });
});

// --- M6-11: itens de medição ------------------------------------------------------------------

test('M6-11 medição carrega itens (descrição/quantidade/preço unitário/total) e soma vira o total', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        measuredPct: 20,
        measuredAt: '2026-09-01',
        items: [
          { description: 'Alvenaria', quantity: 100, unitPrice: 25.5 },
          { description: 'Reboco', quantity: 50, unitPrice: 18.3 },
        ],
      },
      tenant.userId,
      transaction
    );

    const items = await stageMeasurementsService.listMeasurementItems(measurement.id, transaction);
    assert.equal(items.length, 2);
    assert.equal(items[0].total, '2550.00');
    assert.equal(items[1].total, '915.00');
    assert.equal(measurement.totalAmount, '3465.00');
  });
});

// --- M6-55/M6-68/M6-85: integração financeira real, idempotente -------------------------------

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

test('M6-55/M6-68 medição aprovada gera obrigação financeira real e aprovar a MESMA medição duas vezes concorrentemente nunca cria duas contas a pagar', async () => {
  const suffix = uniqueSuffix();

  const { measurementId, projectId } = await withCommitted(async (t) => {
    const { project, stage } = await setupProjectAndStage(t, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        measuredPct: 60,
        measuredAt: '2026-09-01',
        items: [{ description: `Concorrência ${suffix}`, quantity: 1, unitPrice: 7777.77 }],
      },
      tenant.userId,
      t
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, t);
    return { measurementId: measurement.id, projectId: project.id };
  });

  try {
    // Duas aprovações REAIS disparadas ao mesmo tempo, cada uma em sua própria transação
    // commitada (conexões distintas) — é isso que exercita a corrida de verdade (não é só
    // chamar a função 2x em sequência).
    const resultados = await Promise.allSettled([
      withCommitted((t) => stageMeasurementsService.decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t)),
      withCommitted((t) => stageMeasurementsService.decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t)),
    ]);

    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    assert.equal(sucessos.length, 1, 'apenas UMA das duas aprovações concorrentes pode passar');
    const falha = resultados.find((r) => r.status === 'rejected');
    assert.ok(falha, 'a segunda aprovação concorrente precisa falhar');
    assert.equal(falha.reason.code, 'STAGE_MEASUREMENT_INVALID_STATUS');

    await withCommitted(async (t) => {
      const [rows] = await sequelize.query(
        `SELECT id FROM finance.financial_entries WHERE idempotency_key = :key`,
        { replacements: { key: `measurement.payable:${measurementId}` }, transaction: t }
      );
      assert.equal(rows.length, 1, 'só pode existir UM lançamento financeiro para esta medição');

      const measurement = await stageMeasurementsService.getStageMeasurement(measurementId, t);
      assert.equal(measurement.status, 'PAYABLE');
      assert.ok(measurement.payableFinancialEntryId);
      assert.equal(measurement.payableFinancialEntryId, rows[0].id);

      const [entryRows] = await sequelize.query(
        `SELECT amount, construction_project_id FROM finance.financial_entries WHERE id = :id`,
        { replacements: { id: rows[0].id }, transaction: t }
      );
      assert.equal(Number(entryRows[0].amount), 7777.77);
      assert.equal(entryRows[0].construction_project_id, projectId, 'M6-97: lançamento carrega a dimensão da obra');
    });
  } finally {
    // Limpeza — banco de dev compartilhado entre agentes/suítes (mesmo padrão de ADV-F21 em
    // test/adversarial.finance.test.js).
    await withCommitted(async (t) => {
      await sequelize.query(`UPDATE construction.stage_measurements SET payable_financial_entry_id = NULL WHERE id = :id`, {
        replacements: { id: measurementId },
        transaction: t,
      });
      await sequelize.query(
        `DELETE FROM finance.financial_entries WHERE idempotency_key = :key`,
        { replacements: { key: `measurement.payable:${measurementId}` }, transaction: t }
      );
      await sequelize.query(`DELETE FROM construction.measurement_items WHERE measurement_id = :id`, {
        replacements: { id: measurementId },
        transaction: t,
      });
      await sequelize.query(`DELETE FROM construction.stage_measurements WHERE id = :id`, {
        replacements: { id: measurementId },
        transaction: t,
      });
      await sequelize.query(
        `DELETE FROM construction.project_stages WHERE project_id = :pid`,
        { replacements: { pid: projectId }, transaction: t }
      );
      await sequelize.query(`DELETE FROM construction.projects WHERE id = :id`, { replacements: { id: projectId }, transaction: t });
    });
  }
});

test('M6-55 aprovar medição sem valor definido (sem itens/totalAmount) é recusado — nunca gera obrigação financeira de valor zero/indefinido', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 10, measuredAt: '2026-09-01' },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);

    await assert.rejects(
      () => stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'STAGE_MEASUREMENT_MISSING_AMOUNT');
        return true;
      }
    );
  });
});

// --- M6-42/M6-99: read model de custo -----------------------------------------------------------

test('M6-42 GET .../health devolve os 9 campos do read model de custo com valores reais', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, stage } = await setupProjectAndStage(transaction, suffix);
    const measurement = await createSubmittedMeasurement(transaction, stage.id, suffix);
    await stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction);

    const health = await projectHealthService.getProjectHealth(project.id, transaction);

    for (const field of [
      'baselineBudget',
      'approvedChanges',
      'committedCost',
      'actualFinancialCost',
      'consumedInventoryCost',
      'forecastToComplete',
      'projectedTotalCost',
      'projectedMargin',
      'updatedAt',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(health, field), `campo "${field}" ausente no health`);
    }

    assert.equal(health.baselineBudget, 100000);
    // A medição aprovada ainda está PENDING no ledger (não foi liquidada) — não entra em
    // actualFinancialCost (que só soma o que JÁ SAIU), mas aparece no KPI de pendências.
    assert.equal(health.actualFinancialCost, 0);
    assert.equal(health.kpis.payablePendingTotal, 1500);
  });
});

test('M6-42 GET .../health não quebra quando Change Orders ainda não existe (tabela de outra fatia)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await setupProjectAndStage(transaction, suffix);
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(typeof health.approvedChanges, 'number');
  });
});

// Bug real corrigido nesta auditoria (rodada 18, 2026-10-05): a conclusão automática da etapa
// (ciclo 4) mutava stage.status direto, por fora de updateProjectStage — nunca disparava
// project.stage.completed (M6-106, evento canônico que Financeiro/BI esperam no barramento) nem
// auditava a transição da ProjectStage.
test('M6-106: aprovar medição de 100% completa a etapa E publica project.stage.completed', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);

    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 100, measuredAt: '2026-09-01', items: [{ description: 'Entrega final', quantity: 1, unitPrice: 5000 }] },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);
    await stageMeasurementsService.reviewStageMeasurement(measurement.id, {}, tenant.userId, transaction);
    await stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction);

    await stage.reload({ transaction });
    assert.equal(stage.status, 'DONE');

    const { OutboxEvent } = require('../src/models');
    const events = await OutboxEvent.findAll({ where: { aggregateId: stage.id, eventType: 'project.stage.completed' }, transaction });
    assert.equal(events.length, 1, 'completar a etapa via aprovação de medição precisa publicar project.stage.completed, não só mudar o status');
  });
});

// Bug real corrigido nesta auditoria (rodada 46, 2026-10-05): o contrato (TAB-0701) trata
// stage_code/planned_cost/planned_start/planned_end como NOT NULL — mas nada impedia uma etapa
// entrar em execução (IN_PROGRESS) sem nenhum desses campos preenchidos.
test('M6-TAB0701: iniciar etapa (PENDING -> IN_PROGRESS) exige stageCode/plannedCost/startsAt/endsAt', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await setupProjectAndStage(transaction, suffix);
    const stage = await projectStagesService.createProjectStage(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Etapa sem dados ${suffix}`, sequence: 2 },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectStagesService.updateProjectStage(stage.id, { status: 'IN_PROGRESS' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROJECT_STAGE_MISSING_REQUIRED_FIELDS');
        return true;
      }
    );

    const started = await projectStagesService.updateProjectStage(
      stage.id,
      { status: 'IN_PROGRESS', stageCode: `ET-${suffix}`, plannedCost: 1000, startsAt: '2026-10-01', endsAt: '2026-11-01' },
      tenant.userId,
      transaction
    );
    assert.equal(started.status, 'IN_PROGRESS');
  });
});

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 3, 2026-10-06): updateProjectStage aceitava
// QUALQUER transição de status (pular PENDING->DONE direto, ou regredir DONE->PENDING/
// IN_PROGRESS->PENDING) via chamada direta à API — só o front nunca mandava "status" fora da
// sequência, mas o backend não tinha gate. Mesmo ângulo do bug já corrigido em
// updateMaintenanceCase (ciclo 2).
test('M6: updateProjectStage recusa transição de status fora da sequência válida', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);
    assert.equal(stage.status, 'PENDING');

    // PENDING -> DONE direto (pulando IN_PROGRESS) deve ser recusado.
    await assert.rejects(
      () => projectStagesService.updateProjectStage(stage.id, { status: 'DONE' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROJECT_STAGE_STATUS_TRANSITION_INVALID');
        return true;
      }
    );

    const started = await projectStagesService.updateProjectStage(
      stage.id,
      { status: 'IN_PROGRESS', stageCode: `ET2-${suffix}`, plannedCost: 500, startsAt: '2026-10-01', endsAt: '2026-11-01' },
      tenant.userId,
      transaction
    );
    assert.equal(started.status, 'IN_PROGRESS');

    // IN_PROGRESS -> PENDING (regressão) deve ser recusado.
    await assert.rejects(
      () => projectStagesService.updateProjectStage(started.id, { status: 'PENDING' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROJECT_STAGE_STATUS_TRANSITION_INVALID');
        return true;
      }
    );

    const done = await projectStagesService.updateProjectStage(started.id, { status: 'DONE' }, tenant.userId, transaction);
    assert.equal(done.status, 'DONE');

    // DONE -> qualquer coisa (reabrir) deve ser recusado.
    await assert.rejects(
      () => projectStagesService.updateProjectStage(done.id, { status: 'IN_PROGRESS' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROJECT_STAGE_STATUS_TRANSITION_INVALID');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): totalAmount manual
// (sem items) era persistido sem Number.isFinite — "NaN" passava o guard de decideStageMeasurement
// e aprovava a medição com totalAmount=NaN, propagando pro payable financeiro real.
test('createStageMeasurement/reviseStageMeasurement recusam totalAmount manual "NaN"', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await setupProjectAndStage(transaction, suffix);

    await assert.rejects(
      () => stageMeasurementsService.createStageMeasurement(
        stage.id,
        { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 40, measuredAt: '2026-09-01', totalAmount: 'NaN' },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'STAGE_MEASUREMENT_VALIDATION'); return true; }
    );

    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 40, measuredAt: '2026-09-01', totalAmount: 1000 },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);

    await assert.rejects(
      () => stageMeasurementsService.reviseStageMeasurement(measurement.id, { totalAmount: 'NaN' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'STAGE_MEASUREMENT_VALIDATION'); return true; }
    );
  });
});
