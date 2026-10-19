'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const cadenceService = require('../src/features/billing/collectionCadence.service');
const { seedBillingRules } = require('../scripts/seedBillingRules');
const AppError = require('../src/utils/AppError');
const { CollectionCadenceStep, Notification, Task, OutboxEvent, BillingSchedule } = require('../src/models');

/**
 * Cadência de cobrança via Motor de Regras (REG-LOC-004) — conferência Nayara 18/10/2026,
 * matriz Marco 5 "Multa, juros, carência, cadência e acordo": "confirmar também cadência e
 * acordo versionado preservando a dívida". Caderno p.158: "Multa/juros/grace/cadência via Motor
 * de Regras; acordo versionado não apaga dívida."
 *
 * As datas são relativas a HOJE em São Paulo (o vencimento é hoje e o job roda com um "agora"
 * simulado N dias depois): a versão da regra semeada vale a partir do momento do seed, então
 * um "agora" no passado não teria regra vigente (fail-closed).
 */

let tenant;
let today;
let testStartedAt;

before(async () => {
  tenant = await getSeedTenant();
  testStartedAt = Date.now() + 60 * 1000;
  today = cadenceService.businessDateSaoPaulo(new Date(testStartedAt));
  // Garante a REG-LOC-004 publicada (idempotente — o CI e o banco de dev já semeiam).
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    await seedBillingRules(tenant, transaction);
  });
});

after(async () => {
  await sequelize.close();
});

// O vencimento fica DUE_SHIFT dias à frente de hoje: assim a etapa mais antecipada (D-3) roda
// com "agora" = hoje, nunca antes da publicação da versão semeada da regra.
const DUE_SHIFT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function ymdPlus(ymd, days) {
  const base = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * "Agora" simulado no dia `vencimento + days`: o instante real de hoje deslocado em dias inteiros
 * (mesmo horário). Usar o instante real, e não um horário fixo do dia, garante que o D-3 (= hoje)
 * nunca caia antes da publicação da versão semeada da regra.
 */
function at(days) {
  return new Date(testStartedAt + (DUE_SHIFT + days) * DAY_MS);
}

async function leaseWithScheduleDueToday(transaction, { amount = 2000 } = {}) {
  const suffix = uniqueSuffix();
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: amount, contractNumber: `QA-CADENCE-${suffix}` },
    tenant.userId,
    transaction
  );
  const schedule = await billingScheduleService.generateBillingSchedule(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      contractId: contract.id,
      period: ymdPlus(today, DUE_SHIFT).slice(0, 7),
      dueDate: ymdPlus(today, DUE_SHIFT),
      items: [{ componentType: 'RENT', amount }],
    },
    tenant.userId,
    transaction
  );
  return { contract, schedule };
}

async function run(contractId, days, transaction) {
  return cadenceService.runCollectionCadence(transaction, { now: at(days), contractId });
}

async function steps(scheduleId, transaction) {
  return cadenceService.listCadenceSteps(scheduleId, transaction);
}

function byCode(rows) {
  return Object.fromEntries(rows.map((row) => [row.stepCode, row]));
}

test('CAD-1: cada etapa da régua dispara no dia certo — lembrete D-3, avisos D+1/D+5, tarefa D+15, escalonamento jurídico D+30', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, schedule } = await leaseWithScheduleDueToday(transaction);


    await run(contract.id, -3, transaction);
    let rows = byCode(await steps(schedule.id, transaction));
    assert.equal(rows['REMINDER_D-3'].outcome, 'EXECUTED');
    assert.equal(rows['REMINDER_D-3'].daysFromDue, -3);
    const reminder = await Notification.findByPk(rows['REMINDER_D-3'].notificationId, { transaction });
    assert.equal(reminder.userId, tenant.userId, 'notificação vai para o responsável do contrato');
    assert.match(reminder.title, /vence em 3 dia/);

    await run(contract.id, 0, transaction);
    assert.equal((await steps(schedule.id, transaction)).length, 1, 'no dia do vencimento não há etapa (ainda não está atrasado)');

    await run(contract.id, 1, transaction);
    rows = byCode(await steps(schedule.id, transaction));
    assert.equal(rows.NOTICE_D1.outcome, 'EXECUTED');
    assert.equal(rows.NOTICE_D1.daysFromDue, 1);
    assert.match((await Notification.findByPk(rows.NOTICE_D1.notificationId, { transaction })).body, /R\$\s?2\.000,00/);

    await run(contract.id, 4, transaction);
    assert.equal((await steps(schedule.id, transaction)).length, 2, 'D+4: nenhuma etapa nova');

    await run(contract.id, 5, transaction);
    await run(contract.id, 15, transaction);
    await run(contract.id, 30, transaction);
    rows = byCode(await steps(schedule.id, transaction));
    assert.deepEqual(Object.keys(rows).sort(), ['LEGAL_D30', 'NOTICE_D1', 'NOTICE_D5', 'REMINDER_D-3', 'TASK_D15']);
    for (const row of Object.values(rows)) assert.equal(row.outcome, 'EXECUTED', `${row.stepCode} executada no dia, sem pular`);

    const task = await Task.findByPk(rows.TASK_D15.taskId, { transaction });
    assert.equal(task.priority, 'HIGH');
    assert.equal(task.relatedEntityId, schedule.id);
    const legal = await Task.findByPk(rows.LEGAL_D30.taskId, { transaction });
    assert.equal(legal.priority, 'URGENT');
    assert.match(legal.title, /cobrança jurídica/);

    const events = await OutboxEvent.findAll({ where: { aggregateId: schedule.id, eventType: 'charge.cadence_step' }, transaction });
    assert.equal(events.length, 5, 'um evento charge.cadence_step por etapa executada');
    const versionIds = new Set(Object.values(rows).map((row) => row.ruleVersionId));
    assert.equal(versionIds.size, 1, 'todas as etapas gravam a mesma versão da regra');
  });
});

test('CAD-2: rodar o job de novo não repete etapa; job parado executa só a etapa mais avançada e registra as anteriores como puladas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, schedule } = await leaseWithScheduleDueToday(transaction);

    await run(contract.id, 5, transaction);
    await run(contract.id, 5, transaction);
    await run(contract.id, 6, transaction);
    let rows = await steps(schedule.id, transaction);
    const executed = rows.filter((row) => row.outcome === 'EXECUTED');
    assert.deepEqual(executed.map((row) => row.stepCode), ['NOTICE_D5'], 'D+5 executa uma única vez');
    const skipped = rows.filter((row) => row.outcome === 'SKIPPED_SUPERSEDED').map((row) => row.stepCode).sort();
    assert.deepEqual(skipped, ['NOTICE_D1', 'REMINDER_D-3'], 'etapas vencidas enquanto o job estava parado ficam registradas como puladas, sem efeito');
    for (const row of rows.filter((r) => r.outcome === 'SKIPPED_SUPERSEDED')) {
      assert.equal(row.notificationId, null);
      assert.equal(row.taskId, null);
    }

    await run(contract.id, 16, transaction);
    await run(contract.id, 16, transaction);
    rows = await steps(schedule.id, transaction);
    assert.equal(rows.filter((row) => row.stepCode === 'TASK_D15').length, 1);
    const notifications = await Notification.count({ where: { userId: tenant.userId, title: { [require('sequelize').Op.like]: `%competência ${schedule.period}%` } }, transaction });
    assert.ok(notifications >= 1);
    const d5Notifications = rows.filter((row) => row.stepCode === 'NOTICE_D5');
    assert.equal(d5Notifications.length, 1);
  });
});

test('CAD-3: competência paga, ou com caso de cobrança em acordo, não recebe etapa de cobrança', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const paid = await leaseWithScheduleDueToday(transaction, { amount: 1500 });
    await billingScheduleService.registerPayment(paid.schedule.id, 1500, tenant.userId, transaction);
    await run(paid.contract.id, 5, transaction);
    assert.equal((await steps(paid.schedule.id, transaction)).length, 0, 'paga: nenhuma etapa');

    const partial = await leaseWithScheduleDueToday(transaction, { amount: 1500 });
    await billingScheduleService.registerPayment(partial.schedule.id, 500, tenant.userId, transaction);
    await run(partial.contract.id, 5, transaction);
    const partialRows = byCode(await steps(partial.schedule.id, transaction));
    assert.equal(partialRows.NOTICE_D5.outcome, 'EXECUTED', 'parcialmente paga ainda é cobrada');
    assert.equal(Number(partialRows.NOTICE_D5.balanceAtStep), 1000, 'cobra o saldo, não o total');

    const inAgreement = await leaseWithScheduleDueToday(transaction, { amount: 1800 });
    const collectionCase = await collectionCaseService.openCollectionCase(inAgreement.schedule.id, 10, tenant.userId, transaction);
    await collectionCaseService.createAgreement(collectionCase.id, { installments: 3, agreedAmount: 1900 }, tenant.userId, transaction);
    const summary = await run(inAgreement.contract.id, 15, transaction);
    assert.equal(summary.blocked, 1);
    assert.equal((await steps(inAgreement.schedule.id, transaction)).length, 0, 'em acordo: nenhuma etapa');
  });
});

test('CAD-4: nova versão da régua vale para novos ciclos; ciclo já iniciado segue na versão em que começou e o registro antigo é imutável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const first = await leaseWithScheduleDueToday(transaction);
    await run(first.contract.id, 1, transaction);
    const [firstD1] = await steps(first.schedule.id, transaction).then((rows) => rows.filter((row) => row.stepCode === 'NOTICE_D1'));
    const v1Id = firstD1.ruleVersionId;

    const v2 = await cadenceService.publishCadenceRuleVersion(
      tenant.groupId,
      tenant.companyId,
      [
        { code: 'NOTICE_D2', offsetDays: 2, action: 'NOTIFY' },
        { code: 'LEGAL_D10', offsetDays: 10, action: 'ESCALATE_LEGAL' },
      ],
      tenant.userId,
      transaction
    );
    assert.notEqual(v2.id, v1Id);

    const second = await leaseWithScheduleDueToday(transaction);
    await run(second.contract.id, 2, transaction);
    const secondRows = byCode(await steps(second.schedule.id, transaction));
    assert.equal(secondRows.NOTICE_D2.ruleVersionId, v2.id, 'ciclo novo usa a versão nova');
    assert.equal(secondRows.NOTICE_D1, undefined, 'a versão nova não tem D+1');

    await run(first.contract.id, 5, transaction);
    await run(first.contract.id, 10, transaction);
    const firstRows = byCode(await steps(first.schedule.id, transaction));
    assert.equal(firstRows.NOTICE_D5.ruleVersionId, v1Id, 'ciclo iniciado na v1 continua na v1');
    assert.equal(firstRows.LEGAL_D10, undefined, 'etapa da v2 não entra no ciclo da v1');
    assert.equal(firstRows.NOTICE_D1.id, firstD1.id, 'registro já executado preservado');

    await sequelize.query('SAVEPOINT cad4_immutable', { transaction });
    await assert.rejects(
      () => sequelize.query('UPDATE finance.collection_cadence_steps SET outcome = :o WHERE id = :id', { replacements: { o: 'SKIPPED_SUPERSEDED', id: firstD1.id }, transaction }),
      /append-only/
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT cad4_immutable', { transaction });
    await sequelize.query('SAVEPOINT cad4_delete', { transaction });
    await assert.rejects(
      () => sequelize.query('DELETE FROM finance.collection_cadence_steps WHERE id = :id', { replacements: { id: firstD1.id }, transaction }),
      /append-only/
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT cad4_delete', { transaction });
  });
});

test('CAD-5: a cadência nunca altera a dívida — competência e caso de cobrança mantêm os valores do início ao fim da régua', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, schedule } = await leaseWithScheduleDueToday(transaction, { amount: 2345.67 });
    const collectionCase = await collectionCaseService.openCollectionCase(schedule.id, 5, tenant.userId, transaction);
    const before = await BillingSchedule.findByPk(schedule.id, { transaction });
    const caseBefore = collectionCase.toJSON();

    for (const day of [-3, 1, 5, 15, 30]) await run(contract.id, day, transaction);

    const after = await BillingSchedule.findByPk(schedule.id, { transaction });
    assert.equal(String(after.totalAmount), String(before.totalAmount));
    assert.equal(String(after.balance), String(before.balance));
    assert.equal(String(after.paidAmount), String(before.paidAmount));
    assert.equal(after.status, before.status);
    const caseAfter = await collectionCaseService.getCollectionCase(collectionCase.id, transaction);
    assert.equal(String(caseAfter.originalDebtAmount), String(caseBefore.originalDebtAmount));
    assert.equal(String(caseAfter.currentBalance), String(caseBefore.currentBalance));
    assert.equal(String(caseAfter.penaltyAmount), String(caseBefore.penaltyAmount));
    assert.equal(String(caseAfter.interestAmount), String(caseBefore.interestAmount));
    assert.equal((await steps(schedule.id, transaction)).filter((row) => row.outcome === 'EXECUTED').length, 5);
  });
});

test('CAD-6: a régua só aceita etapas estruturadas válidas, e o plano de etapas é determinístico', () => {
  const invalid = [
    [],
    [{ code: 'X1', offsetDays: 0, action: 'NOTIFY' }],
    [{ code: 'X1', offsetDays: 2, action: 'SEND_SMS' }],
    [{ code: 'X1', offsetDays: 2.5, action: 'NOTIFY' }],
    [{ code: 'X1', offsetDays: 2, action: 'NOTIFY' }, { code: 'X1', offsetDays: 3, action: 'NOTIFY' }],
    [{ code: 'X1', offsetDays: 2, action: 'NOTIFY' }, { code: 'X2', offsetDays: 2, action: 'TASK' }],
    [{ code: 'eval(1)', offsetDays: 2, action: 'NOTIFY' }],
    [{ code: 'X1', offsetDays: 400, action: 'NOTIFY' }],
  ];
  for (const steps of invalid) {
    assert.throws(() => cadenceService.validateCadenceSteps(steps), (err) => err instanceof AppError && err.code === 'COLLECTION_CADENCE_INVALID');
  }

  const plan = cadenceService.planSteps(cadenceService.validateCadenceSteps(cadenceService.DEFAULT_CADENCE_STEPS), 16, new Set());
  assert.deepEqual(plan.toExecute.map((s) => s.code), ['TASK_D15']);
  assert.deepEqual(plan.toSkip.map((s) => s.code).sort(), ['NOTICE_D1', 'NOTICE_D5', 'REMINDER_D-3']);
  const early = cadenceService.planSteps(cadenceService.validateCadenceSteps(cadenceService.DEFAULT_CADENCE_STEPS), -2, new Set());
  assert.deepEqual(early.toExecute.map((s) => s.code), ['REMINDER_D-3']);
  assert.equal(early.toSkip.length, 0);
});
