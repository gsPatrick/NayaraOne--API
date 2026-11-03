'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const rentAdvanceService = require('../src/features/billing/rentAdvance.service');
const guaranteedRentService = require('../src/features/billing/guaranteedRent.service');
const AppError = require('../src/utils/AppError');
const { FinancialEntry, CostCenter, ResultCenter } = require('../src/models');

/**
 * Antecipação de aluguel — recuperação no Financeiro (conferência Nayara 18/10/2026, matriz
 * Marco 5 "Aluguel garantido x antecipação": "Produtos separados, obrigação/crédito,
 * principal/custo e recuperação financeira sem confusão de caixa"; Caderno p.158 "Rent advance:
 * ... payment/recovery; principal e custo separados no Financeiro").
 */

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createActiveLease(transaction, suffix = uniqueSuffix()) {
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2000, contractNumber: `QA-ADV-REC-${suffix}` },
    tenant.userId,
    transaction
  );
  contract.status = 'ACTIVE';
  await contract.save({ transaction });
  return contract;
}

async function paidAdvance(transaction, { principalAmount = 6000, costAmount = 300 } = {}) {
  const contract = await createActiveLease(transaction);
  const advance = await rentAdvanceService.requestRentAdvance(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, monthsAdvanced: 3, principalAmount, costAmount },
    tenant.userId,
    transaction
  );
  await rentAdvanceService.proposeRentAdvance(advance.id, tenant.userId, transaction);
  await rentAdvanceService.acceptRentAdvance(advance.id, tenant.userId, transaction);
  const paid = await rentAdvanceService.payRentAdvance(advance.id, tenant.userId, transaction);
  return { contract, advance: paid };
}

async function principalRecoveryEntries(advanceId, transaction) {
  return FinancialEntry.findAll({
    where: { idempotencyKey: { [Op.like]: `rent_advance.recovery_principal:${advanceId}:%` } },
    order: [['created_at', 'ASC']],
    transaction,
  });
}

async function settledChildren(parentEntryId, transaction) {
  return FinancialEntry.findAll({ where: { parentEntryId, status: 'SETTLED' }, transaction });
}

function sumCents(entries) {
  return entries.reduce((acc, e) => acc + Math.round(Number(e.amount) * 100), 0);
}

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError, veio ${err && err.message}`);
    assert.equal(err.code, code);
    return true;
  };
}

test('ADV-REC-1: o pagamento da antecipação lança principal e custo separados, com valor, natureza e centro conferidos', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, advance } = await paidAdvance(transaction, { principalAmount: 6000, costAmount: 300 });

    const principal = await FinancialEntry.findByPk(advance.principalEntryId, { transaction });
    const cost = await FinancialEntry.findByPk(advance.costEntryId, { transaction });

    assert.equal(principal.nature, 'PAYABLE');
    assert.equal(principal.entryType, 'DEBIT');
    assert.equal(Number(principal.amount), 6000);
    assert.equal(principal.contractId, contract.id);
    const principalCenter = await CostCenter.findByPk(principal.costCenterId, { transaction });
    assert.equal(principalCenter.code, 'LOCACAO-ANTECIPACAO');

    assert.equal(cost.nature, 'RECEIVABLE');
    assert.equal(cost.entryType, 'CREDIT');
    assert.equal(Number(cost.amount), 300);
    assert.equal(cost.contractId, contract.id);
    const costCenter = await ResultCenter.findByPk(cost.resultCenterId, { transaction });
    assert.equal(costCenter.code, 'LOCACAO-ANTECIPACAO');
  });
});

test('ADV-REC-2: recuperações parciais e total geram os lançamentos certos — custo primeiro (baixa do recebível de custo), depois principal (recebível próprio)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { advance } = await paidAdvance(transaction, { principalAmount: 6000, costAmount: 300 });

    // 1ª recuperação: R$ 200,00 — cabe inteira no custo.
    let current = await rentAdvanceService.recoverRentAdvance(advance.id, 200, tenant.userId, transaction);
    assert.equal(current.status, 'RECOVERING');
    assert.equal(Number(current.recoveredAmount), 200);
    let costEntry = await FinancialEntry.findByPk(advance.costEntryId, { transaction });
    assert.equal(costEntry.status, 'PARTIALLY_SETTLED');
    assert.equal(sumCents(await settledChildren(advance.costEntryId, transaction)), 20000);
    assert.equal((await principalRecoveryEntries(advance.id, transaction)).length, 0, 'nada do principal recuperado ainda');

    // 2ª: R$ 4.100,00 — R$ 100,00 fecham o custo, R$ 4.000,00 voltam do principal.
    current = await rentAdvanceService.recoverRentAdvance(advance.id, 4100, tenant.userId, transaction);
    assert.equal(Number(current.recoveredAmount), 4300);
    costEntry = await FinancialEntry.findByPk(advance.costEntryId, { transaction });
    assert.equal(costEntry.status, 'SETTLED');
    assert.equal(sumCents(await settledChildren(advance.costEntryId, transaction)), 30000, 'custo nunca recebido além de R$ 300,00');
    let principalEntries = await principalRecoveryEntries(advance.id, transaction);
    assert.equal(principalEntries.length, 1);
    assert.equal(Number(principalEntries[0].amount), 4000);
    assert.equal(principalEntries[0].nature, 'RECEIVABLE');
    assert.equal(principalEntries[0].entryType, 'CREDIT');
    assert.equal(principalEntries[0].status, 'SETTLED');
    assert.equal(principalEntries[0].contractId, advance.contractId);
    const recoveryCenter = await ResultCenter.findByPk(principalEntries[0].resultCenterId, { transaction });
    assert.equal(recoveryCenter.code, 'LOCACAO-ANTECIPACAO-RECUPERACAO', 'volta do principal num centro separado do custo');

    // 3ª: R$ 2.000,00 — fecha o principal; antecipação RECOVERED.
    current = await rentAdvanceService.recoverRentAdvance(advance.id, 2000, tenant.userId, transaction);
    assert.equal(current.status, 'RECOVERED');
    assert.equal(Number(current.recoveredAmount), 6300);
    principalEntries = await principalRecoveryEntries(advance.id, transaction);
    assert.equal(principalEntries.length, 2);
    assert.equal(sumCents(principalEntries), 600000, 'soma do principal recuperado = principal antecipado');
  });
});

test('ADV-REC-3: recuperação acima do saldo, valor zero, negativo ou não numérico é recusada sem lançar nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { advance } = await paidAdvance(transaction, { principalAmount: 1000, costAmount: 100 });

    for (const invalid of [0, -50, 'abc', NaN, null, '', 0.004]) {
      await assert.rejects(
        () => rentAdvanceService.recoverRentAdvance(advance.id, invalid, tenant.userId, transaction),
        expectCode('RENT_ADVANCE_RECOVERY_INVALID_AMOUNT'),
        `valor ${String(invalid)} deveria ser recusado`
      );
    }

    await assert.rejects(
      () => rentAdvanceService.recoverRentAdvance(advance.id, 1100.01, tenant.userId, transaction),
      expectCode('RENT_ADVANCE_RECOVERY_EXCEEDS_BALANCE')
    );

    await rentAdvanceService.recoverRentAdvance(advance.id, 600, tenant.userId, transaction);
    await assert.rejects(
      () => rentAdvanceService.recoverRentAdvance(advance.id, 500.01, tenant.userId, transaction),
      expectCode('RENT_ADVANCE_RECOVERY_EXCEEDS_BALANCE'),
      'restam R$ 500,00 — R$ 500,01 passa do saldo'
    );

    const reloaded = await rentAdvanceService.getRentAdvance(advance.id, transaction);
    assert.equal(Number(reloaded.recoveredAmount), 600, 'as tentativas recusadas não mexeram no saldo');
    assert.equal(sumCents(await principalRecoveryEntries(advance.id, transaction)), 50000, 'só a recuperação válida lançou principal (600 - 100 de custo)');

    const done = await rentAdvanceService.recoverRentAdvance(advance.id, 500, tenant.userId, transaction);
    assert.equal(done.status, 'RECOVERED');
    await assert.rejects(
      () => rentAdvanceService.recoverRentAdvance(advance.id, 1, tenant.userId, transaction),
      expectCode('RENT_ADVANCE_INVALID_STATUS'),
      'antecipação já recuperada não aceita mais recuperação'
    );
  });
});

test('ADV-REC-4: aluguel garantido segue separado — recuperação da antecipação não toca centros nem lançamentos do garantido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, advance } = await paidAdvance(transaction, { principalAmount: 3000, costAmount: 0 });
    const guaranteed = await guaranteedRentService.enrollGuaranteedRent(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, coverageStartsAt: '2026-09-01' },
      tenant.userId,
      transaction
    );
    const { payableEntry, receivableEntry } = await guaranteedRentService.payGuaranteedRent(
      guaranteed.id,
      { period: '2026-09', amount: 2000 },
      tenant.userId,
      transaction
    );

    await rentAdvanceService.recoverRentAdvance(advance.id, 3000, tenant.userId, transaction);

    const [recovery] = await principalRecoveryEntries(advance.id, transaction);
    const recoveryCenter = await ResultCenter.findByPk(recovery.resultCenterId, { transaction });
    const guaranteedCenter = await ResultCenter.findByPk(receivableEntry.resultCenterId, { transaction });
    assert.notEqual(recoveryCenter.id, guaranteedCenter.id);
    assert.equal(guaranteedCenter.code, 'LOCACAO-ALUGUEL-GARANTIDO');
    assert.match(recovery.idempotencyKey, /^rent_advance\./);

    const payableAfter = await FinancialEntry.findByPk(payableEntry.id, { transaction });
    const receivableAfter = await FinancialEntry.findByPk(receivableEntry.id, { transaction });
    assert.equal(payableAfter.status, payableEntry.status);
    assert.equal(receivableAfter.status, receivableEntry.status, 'o crédito do garantido a recuperar do locatário não foi baixado pela antecipação');
  });
});

test('ADV-REC-5: duas recuperações SIMULTÂNEAS que juntas passam do saldo — só uma passa, a outra é recusada, saldo nunca estoura', async () => {
  const suffix = uniqueSuffix();
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

  // Commit real para exercitar concorrência de verdade. Os registros ficam no banco de dev,
  // identificáveis pelo contrato QA-ADV-REC-<sufixo> (lançamentos não podem ser apagados — trigger
  // append-only do ledger).
  const advanceId = await withCommitted(async (t) => {
    const contract = await createActiveLease(t, suffix);
    const advance = await rentAdvanceService.requestRentAdvance(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, monthsAdvanced: 3, principalAmount: 6000, costAmount: 0 },
      tenant.userId,
      t
    );
    await rentAdvanceService.proposeRentAdvance(advance.id, tenant.userId, t);
    await rentAdvanceService.acceptRentAdvance(advance.id, tenant.userId, t);
    await rentAdvanceService.payRentAdvance(advance.id, tenant.userId, t);
    return advance.id;
  });

  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let pendingReads = 2;
  const waitBothReads = () => {
    pendingReads -= 1;
    if (pendingReads === 0) release();
    return barrier;
  };

  const recover = (amount) =>
    withCommitted(async (t) => {
      await rentAdvanceService.getRentAdvance(advanceId, t);
      await waitBothReads();
      return rentAdvanceService.recoverRentAdvance(advanceId, amount, tenant.userId, t);
    });

  const results = await Promise.allSettled([recover(4000), recover(4000)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'só uma das duas cabe no saldo de R$ 6.000,00');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'RENT_ADVANCE_RECOVERY_EXCEEDS_BALANCE');

  await withCommitted(async (t) => {
    const advance = await rentAdvanceService.getRentAdvance(advanceId, t);
    assert.equal(Number(advance.recoveredAmount), 4000);
    assert.equal(sumCents(await principalRecoveryEntries(advanceId, t)), 400000, 'um único lançamento de R$ 4.000,00 no Financeiro');
  });
});
