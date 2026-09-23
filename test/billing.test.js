'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');
const guaranteedRentService = require('../src/features/billing/guaranteedRent.service');
const rentAdvanceService = require('../src/features/billing/rentAdvance.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const closeoutService = require('../src/features/billing/closeout.service');
const { createMockIndexSourceAdapter, unavailableIndexSourceAdapter } = require('../src/features/billing/adapters/IndexSourceAdapter');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction, overrides = {}) {
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2000, ...overrides },
    tenant.userId,
    transaction
  );
  return contract;
}

async function activateContract(contract, transaction) {
  contract.status = 'ACTIVE';
  await contract.save({ transaction });
  return contract;
}

// --- DoD 1: competência duplicada é bloqueada com erro claro ---
test('billing: gerar cobrança duas vezes para a mesma competência é bloqueado com erro claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const payload = {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      contractId: contract.id,
      period: '2026-09',
      dueDate: '2026-09-05',
      items: [{ componentType: 'RENT', amount: 2000 }],
    };
    const first = await billingScheduleService.generateBillingSchedule(payload, tenant.userId, transaction);
    assert.ok(first.id);

    await assert.rejects(
      () => billingScheduleService.generateBillingSchedule(payload, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BILLING_SCHEDULE_DUPLICATE_PERIOD');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });
});

// --- DoD 3: pagamento parcial recompõe saldo corretamente ---
test('billing: pagamento parcial recompõe saldo e só fecha quando quitado totalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2026-10',
        dueDate: '2026-10-05',
        items: [{ componentType: 'RENT', amount: 1000 }, { componentType: 'CONDO', amount: 300 }],
      },
      tenant.userId,
      transaction
    );
    assert.equal(Number(schedule.totalAmount), 1300);
    assert.equal(Number(schedule.balance), 1300);
    assert.equal(schedule.status, 'OPEN');

    const afterPartial = await billingScheduleService.registerPayment(schedule.id, 500, tenant.userId, transaction);
    assert.equal(Number(afterPartial.paidAmount), 500);
    assert.equal(Number(afterPartial.balance), 800);
    assert.equal(afterPartial.status, 'PARTIALLY_PAID');

    const afterFull = await billingScheduleService.registerPayment(schedule.id, 800, tenant.userId, transaction);
    assert.equal(Number(afterFull.balance), 0);
    assert.equal(afterFull.status, 'PAID');

    await assert.rejects(
      () => billingScheduleService.registerPayment(schedule.id, 10, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'BILLING_SCHEDULE_ALREADY_PAID');
        return true;
      }
    );
  });
});

// --- DoD 2: índice de reajuste ausente vira PENDING_SOURCE, não inventa valor ---
test('billing: reajuste sem fonte de índice disponível vira PENDING_SOURCE sem inventar percentual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        indexCode: 'IGPM',
        period: '2026-09',
        oldRentAmount: 2000,
      },
      tenant.userId,
      transaction,
      unavailableIndexSourceAdapter
    );
    assert.equal(adjustment.status, 'PENDING_SOURCE');
    assert.equal(adjustment.rawIndexValue, null);
    assert.equal(adjustment.newRentAmount, null);
  });
});

test('billing: reajuste com fonte de índice disponível aplica o percentual (raw pode divergir de applied)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const mockAdapter = createMockIndexSourceAdapter({ 'IGPM:2026-09': 5 });
    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        indexCode: 'IGPM',
        period: '2026-09',
        oldRentAmount: 2000,
        appliedPercentageOverride: 3, // negociação: aplica 3% mesmo o índice bruto sendo 5%
      },
      tenant.userId,
      transaction,
      mockAdapter
    );
    assert.equal(adjustment.status, 'APPLIED');
    assert.equal(Number(adjustment.rawIndexValue), 5);
    assert.equal(Number(adjustment.appliedPercentage), 3);
    assert.equal(Number(adjustment.newRentAmount), 2060);
  });
});

// --- DoD 4: guaranteed rent vs advance não se misturam ---
test('billing: aluguel garantido e antecipação são produtos/tabelas separados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    await activateContract(contract, transaction);

    const guaranteed = await guaranteedRentService.enrollGuaranteedRent(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, coverageStartsAt: '2026-09-01' },
      tenant.userId,
      transaction
    );
    const advance = await rentAdvanceService.requestRentAdvance(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, monthsAdvanced: 3, principalAmount: 6000, costAmount: 300 },
      tenant.userId,
      transaction
    );

    assert.notEqual(guaranteed.constructor.name, advance.constructor.name);
    assert.equal(guaranteed.constructor.name, 'GuaranteedRentContract');
    assert.equal(advance.constructor.name, 'RentAdvance');

    const { guaranteedRentContract, payableEntry, receivableEntry } = await guaranteedRentService.payGuaranteedRent(
      guaranteed.id,
      { period: '2026-09', amount: 2000 },
      tenant.userId,
      transaction
    );
    assert.equal(guaranteedRentContract.paymentsJson.length, 1);
    assert.equal(payableEntry.nature, 'PAYABLE');
    assert.equal(receivableEntry.nature, 'RECEIVABLE');

    await rentAdvanceService.proposeRentAdvance(advance.id, tenant.userId, transaction);
    const accepted = await rentAdvanceService.acceptRentAdvance(advance.id, tenant.userId, transaction);
    const paid = await rentAdvanceService.payRentAdvance(accepted.id, tenant.userId, transaction);
    assert.ok(paid.principalEntryId);
    assert.ok(paid.costEntryId);
    assert.notEqual(paid.principalEntryId, paid.costEntryId);
  });
});

// --- DoD 5: reimbursement criado corretamente quando parte errada paga conta ---
test('billing: reembolso é criado quando a imobiliária paga utilidade da responsabilidade da outra parte', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const { obligation } = await utilitiesService.createUtilityObligation(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        utilityType: 'WATER',
        responsibleParty: 'TENANT',
      },
      tenant.userId,
      transaction
    );

    // Cenário 1: a própria parte responsável paga -> sem reembolso.
    const noReimbursement = await utilitiesService.recordUtilityPayment(
      obligation.id,
      { amount: 120, paidByParty: 'TENANT' },
      tenant.userId,
      transaction
    );
    assert.equal(noReimbursement.reimbursement, null);

    // Cenário 2: a imobiliária paga uma conta que era do locatário -> gera reembolso + FinancialEntry.
    const withReimbursement = await utilitiesService.recordUtilityPayment(
      obligation.id,
      { amount: 150, paidByParty: 'AGENCY' },
      tenant.userId,
      transaction
    );
    assert.ok(withReimbursement.reimbursement);
    assert.equal(withReimbursement.reimbursement.owedByParty, 'TENANT');
    assert.equal(Number(withReimbursement.reimbursement.amount), 150);
    assert.ok(withReimbursement.financialEntry);
    assert.equal(withReimbursement.financialEntry.nature, 'RECEIVABLE');
    assert.equal(withReimbursement.reimbursement.financialEntryId, withReimbursement.financialEntry.id);
  });
});

// --- DoD 6: closeout bloqueia com pendência crítica e libera sem pendência ---
test('billing: closeout bloqueia com cobrança em aberto e libera quando quitada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2026-11',
        dueDate: '2026-11-05',
        items: [{ componentType: 'RENT', amount: 2000 }],
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => closeoutService.closeoutContract(contract.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CLOSEOUT_BLOCKED');
        assert.ok(err.details.reasons.some((r) => r.type === 'OPEN_BILLING'));
        return true;
      }
    );

    await billingScheduleService.registerPayment(schedule.id, 2000, tenant.userId, transaction);

    const result = await closeoutService.closeoutContract(contract.id, tenant.userId, transaction);
    assert.equal(result.status, 'COMPLETED');
  });
});

test('billing: closeout bloqueia com transferência de utilidade pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    await utilitiesService.createUtilityObligation(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        utilityType: 'ELECTRICITY',
        responsibleParty: 'TENANT',
        transferRequired: true,
      },
      tenant.userId,
      transaction
    );

    const eligibility = await closeoutService.checkCloseoutEligibility(contract.id, transaction);
    assert.ok(eligibility.some((r) => r.type === 'PENDING_UTILITY_TRANSFER'));
  });
});

// --- DoD: carência antes de considerar em atraso, via Motor de Regras ---
test('billing: caso de cobrança dentro da carência (REG-LOC-002) é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2026-12',
        dueDate: '2026-12-05',
        items: [{ componentType: 'RENT', amount: 2000 }],
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => collectionCaseService.openCollectionCase(schedule.id, 1, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'COLLECTION_CASE_WITHIN_GRACE_PERIOD');
        return true;
      }
    );

    const collectionCase = await collectionCaseService.openCollectionCase(schedule.id, 10, tenant.userId, transaction);
    assert.ok(Number(collectionCase.penaltyAmount) > 0);
    assert.ok(Number(collectionCase.currentBalance) > Number(collectionCase.originalDebtAmount));

    const withAgreement = await collectionCaseService.createAgreement(
      collectionCase.id,
      { installments: 3, agreedAmount: 1500, notes: 'Acordo de teste' },
      tenant.userId,
      transaction
    );
    assert.equal(withAgreement.status, 'AGREEMENT');
    assert.equal(withAgreement.agreementsJson.length, 1);
    // Dívida original nunca é apagada/alterada mesmo após o acordo.
    assert.equal(Number(withAgreement.originalDebtAmount), Number(collectionCase.originalDebtAmount));
  });
});

test('billing: duas aberturas CONCORRENTES de caso de cobrança para a mesma competência não duplicam', async () => {
  const suffix = uniqueSuffix();
  // Concorrência real precisa de transações COMMITADAS (duas conexões enxergando o mesmo
  // estado) — mesmo padrão do ADV-F21 (test/adversarial.finance.test.js).
  async function withCommitted(fn) {
    const t = await sequelize.transaction();
    try {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
      const r = await fn(t);
      await t.commit();
      return r;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  const { contractId, scheduleId } = await withCommitted(async (t) => {
    const contract = await createLeaseContract(t, { contractNumber: `QA-BILLING-RACE-${suffix}` });
    const schedule = await billingScheduleService.generateBillingSchedule(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        period: '2026-11',
        dueDate: '2026-11-05',
        items: [{ componentType: 'RENT', amount: 2000 }],
      },
      tenant.userId,
      t
    );
    return { contractId: contract.id, scheduleId: schedule.id };
  });

  // BARREIRA DE SINCRONIZAÇÃO (mesmo padrão do ADV-L17, ver commit 97dfd14): sem ela, a corrida
  // depende de sorte de timing de I/O — contra um Postgres local rápido a 2ª transação pode só
  // começar depois que a 1ª já commitou, lendo o estado já atualizado (CollectionCase já
  // criado) e sendo legitimamente rejeitada por COLLECTION_CASE_DUPLICATE sem nenhum conflito
  // de lock real ter ocorrido. A barreira força as duas a terminarem a leitura inicial da
  // competência antes de qualquer uma seguir para o lock/checagem de duplicidade.
  let liberarBarreira;
  const barreira = new Promise((resolve) => { liberarBarreira = resolve; });
  let leiturasPendentes = 2;
  const aguardarAsDuasLeituras = () => {
    leiturasPendentes -= 1;
    if (leiturasPendentes === 0) liberarBarreira();
    return barreira;
  };

  const abrirCaso = () =>
    withCommitted(async (t) => {
      await billingScheduleService.getBillingSchedule(scheduleId, t);
      await aguardarAsDuasLeituras();
      return collectionCaseService.openCollectionCase(scheduleId, 10, tenant.userId, t);
    });

  try {
    const resultados = await Promise.allSettled([abrirCaso(), abrirCaso()]);
    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    assert.equal(sucessos.length, 1, 'apenas UMA das aberturas concorrentes pode passar');
    const falha = resultados.find((r) => r.status === 'rejected');
    assert.equal(falha.reason.code, 'COLLECTION_CASE_DUPLICATE');

    await withCommitted(async (t) => {
      const casos = await collectionCaseService.listCollectionCases(t, { contractId });
      assert.equal(casos.length, 1, 'nunca deve existir mais de um caso de cobrança para a mesma competência');
    });
  } finally {
    // Limpeza: dados de teste num banco compartilhado — removidos via SQL direto.
    await withCommitted(async (t) => {
      await sequelize.query('DELETE FROM finance.collection_cases WHERE billing_schedule_id = :id', { replacements: { id: scheduleId }, transaction: t });
      await sequelize.query('DELETE FROM finance.billing_schedule_items WHERE billing_schedule_id = :id', { replacements: { id: scheduleId }, transaction: t });
      await sequelize.query('DELETE FROM finance.billing_schedules WHERE id = :id', { replacements: { id: scheduleId }, transaction: t });
      await sequelize.query('DELETE FROM legal.contracts WHERE id = :id', { replacements: { id: contractId }, transaction: t });
    });
  }
});

// --- DoD 7: isolamento RLS entre tenants ---
//
// NOTA DE AMBIENTE: a role de conexão usada por este ambiente de dev/teste
// (`DB_USER`/`DATABASE_URL` do .env) é SUPERUSER com `rolbypassrls = true` (confirmado via
// `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`) — Postgres
// SEMPRE ignora RLS para uma role com bypassrls, independentemente de
// ENABLE/FORCE ROW LEVEL SECURITY estarem corretos nas tabelas. Isso é uma característica do
// usuário de banco deste ambiente compartilhado, não um bug das migrations. Por isso, em vez de
// um teste comportamental (que passaria "por acidente" mesmo se a policy estivesse quebrada,
// já que a role sempre ignora RLS), verificamos a CONFIGURAÇÃO real de RLS no catálogo do
// Postgres para cada tabela nova do módulo billing: `relrowsecurity`/`relforcerowsecurity`
// (pg_class) ligados, e a policy `tenant_isolation` existente (pg_policies) filtrando por
// `company_id`. Isso é o que efetivamente garante o isolamento entre tenants quando a
// aplicação roda com a role de runtime real (sem bypassrls) em produção.
test('billing: RLS está corretamente configurada (ENABLE+FORCE+policy tenant_isolation) em todas as tabelas novas', async () => {
  const tables = [
    'billing_schedules',
    'billing_schedule_items',
    'collection_cases',
    'rent_adjustments',
    'guaranteed_rent_contracts',
    'rent_advances',
    'utility_obligations',
    'utility_accounts',
    'utility_reimbursements',
    'ownership_transfer_tasks',
  ];

  const [classRows] = await sequelize.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'finance' AND c.relname IN (:tables)
  `, { replacements: { tables } });

  assert.equal(classRows.length, tables.length, 'todas as tabelas novas devem existir no schema finance');
  for (const row of classRows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: ROW LEVEL SECURITY deveria estar habilitada`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname}: FORCE ROW LEVEL SECURITY deveria estar habilitada`);
  }

  const [policyRows] = await sequelize.query(`
    SELECT tablename, policyname, qual
    FROM pg_policies
    WHERE schemaname = 'finance' AND tablename IN (:tables)
  `, { replacements: { tables } });

  assert.equal(policyRows.length, tables.length, 'todas as tabelas novas devem ter exatamente uma policy');
  for (const row of policyRows) {
    assert.equal(row.policyname, 'tenant_isolation');
    assert.match(row.qual, /company_id/);
  }
});
