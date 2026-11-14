'use strict';

// M4-D022 seção 8, testes 12, 15 a 19, 22 a 25 (parâmetros do antifraude da DEC-007): cada parâmetro é lido pelo leitor único, o resultado muda quando
// o valor gravado muda e o valor fora da faixa do catálogo é recusado (422 SETTING_INVALID_VALUE, DI-DEC007-2). O teste 25 é a guarda estática (X45-D097)
// dos arquivos desta demanda. Também prova a duplicidade do pagamento sem vencimento (DI-DEC007-4). Serviço real, empresa isolada do banco descartável,
// cada caso numa transação desfeita.

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { gravarParametro } = require('./helpers/mfaRecente');
const { CATALOGO, kit } = require('./helpers/antifraudeDec007');
const antifraud = require('../src/modules/finance/application/services/finance-antifraud.service');
const gate = require('../src/modules/finance/application/services/payment-anomaly-gate');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTransactionsService = require('../src/modules/finance/application/services/bank-transactions.service');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const reconciliationService = require('../src/modules/finance/application/services/reconciliation.service');
const { AnomalyCase, Reconciliation, TenantSetting } = require('../src/models');

let tenant;
let costCenterId;
let resultCenterId;
const K = kit(() => tenant);
const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const set = (t, key, value) => gravarParametro(key, value, tenant, t);

before(async () => {
  tenant = await isolatedTenant('m4d022-parametros');
  await T.withTenantTransaction(tenant, async (t) => {
    costCenterId = (await T.createTestCostCenter(tenant, t)).id;
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
  });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

/** O valor abaixo do mínimo e acima do máximo do catálogo é recusado com 422 e nada é gravado. */
async function rejectsOutOfRange(key) {
  const [, min, max] = CATALOGO[key];
  for (const value of [min - 1, max + 1]) {
    await rollback(async (t) => {
      await assert.rejects(set(t, key, value), (err) => { assert.equal(err.statusCode, 422, `${key}=${value}`); assert.equal(err.code, 'SETTING_INVALID_VALUE'); return true; });
      assert.equal(await TenantSetting.count({ where: { companyId: tenant.companyId, key }, transaction: t }), 0);
    });
  }
}
const pay = (t, amount, extra = {}) => K.payable(t, amount, { costCenterId, ...extra });

test('m4d022_param_antifraude_outlier_bloqueio_multiplicador_muda_comportamento: 7x revisa com o padrão 10; com 6, 7x bloqueia', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['1000.00', '1000.00', '1000.00', '1000.00', '1000.00'], { costCenterId });
    const before7 = await pay(t, '7000.00', { bankAccountId: acc.id });
    assert.deepEqual(await K.casesOf(t, before7.id), ['AMOUNT_OUTLIER:MEDIUM']);
    await gate.evaluateAndAssertPreparable(before7, t);
    await set(t, 'antifraude.outlier_bloqueio_multiplicador', 6);
    const after7 = await pay(t, '7000.01', { bankAccountId: acc.id });
    assert.deepEqual(await K.casesOf(t, after7.id), ['AMOUNT_OUTLIER:HIGH']);
    await assert.rejects(gate.evaluateAndAssertPreparable(after7, t), (err) => err.code === 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED');
  });
  await rejectsOutOfRange('antifraude.outlier_bloqueio_multiplicador');
});

/** Pagamento igual cadastrado `days` dias atrás: o lançamento é append-only (created_at não muda), então a cópia entra por INSERT e o molde é cancelado. */
async function pastTwin(t, accountId, amount, dueAt, days) {
  const mold = await pay(t, amount, { bankAccountId: accountId, dueAt });
  await T.sequelize.query(
    `INSERT INTO finance.financial_entries SELECT (jsonb_populate_record(NULL::finance.financial_entries, to_jsonb(e)
       || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', NULL, 'created_at', now() - (:days || ' days')::interval, 'updated_at', now() - (:days || ' days')::interval))).*
       FROM finance.financial_entries e WHERE e.id = :id`,
    { replacements: { id: mold.id, days: String(days) }, transaction: t }
  );
  await financialEntriesService.cancelPendingFinancialEntry(mold.id, 'molde do teste da janela', tenant.userId, t);
}

test('m4d022_param_antifraude_duplicidade_janela_dias_muda_comportamento: o igual de 2 dias atrás conta com 90 e deixa de contar com 1', async () => {
  const due = '2027-06-10T15:00:00.000Z';
  await rollback(async (t) => {
    const acc = await K.account(t);
    await pastTwin(t, acc.id, '910.00', due, 2);
    assert.deepEqual(await K.casesOf(t, (await pay(t, '910.00', { bankAccountId: acc.id, dueAt: due })).id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH'], 'padrão 90 dias');
  });
  await rollback(async (t) => {
    await set(t, 'antifraude.duplicidade_janela_dias', 1);
    const acc = await K.account(t);
    await pastTwin(t, acc.id, '910.00', due, 2);
    assert.equal((await pay(t, '910.00', { bankAccountId: acc.id, dueAt: due })).requiresManualReview, false, 'com 1 dia, o de 2 dias atrás não conta');
  });
  await rejectsOutOfRange('antifraude.duplicidade_janela_dias');
});

test('dec007b_duplicidade_sem_vencimento_usa_a_competencia_como_data_de_referencia (DI-DEC007-4)', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    const first = await pay(t, '480.00', { bankAccountId: acc.id, competenceMonth: '2027-02' });
    assert.equal(first.requiresManualReview, false);
    const twin = await pay(t, '480.00', { bankAccountId: acc.id, competenceMonth: '2027-02' });
    assert.deepEqual(await K.casesOf(t, twin.id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH'], 'sem vencimento, mesma competência: duplicidade');
    assert.match(twin.manualReviewReason, /sem vencimento em um deles: vale a competência 2027-02/);
    await assert.rejects(gate.evaluateAndAssertPreparable(twin, t), (err) => err.code === 'FINANCE_DUPLICATE_PAYMENT_SUSPECT');
    assert.equal((await pay(t, '480.00', { bankAccountId: acc.id, competenceMonth: '2027-03' })).requiresManualReview, false, 'outra competência (pagamento recorrente) não é duplicidade');
    const withDue = await pay(t, '480.00', { bankAccountId: acc.id, dueAt: '2027-02-20T15:00:00.000Z', competenceMonth: '2027-02' });
    assert.deepEqual(await K.casesOf(t, withDue.id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH'], 'com vencimento contra um sem vencimento da mesma competência também confere');
  });
});

test('m4d022_param_antifraude_fornecedor_novo_dias_muda_comportamento: conta de 31 dias com histórico não é nova com 30; com 60 é', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t, { ageDays: 31 });
    await K.settled(t, acc.id, ['15000.00', '15000.00'], { costCenterId });
    assert.equal((await pay(t, '20000.00', { bankAccountId: acc.id })).requiresManualReview, false);
    await set(t, 'antifraude.fornecedor_novo_dias', 60);
    assert.deepEqual(await K.casesOf(t, (await pay(t, '20000.50', { bankAccountId: acc.id })).id), ['NEW_SUPPLIER_HIGH_VALUE:MEDIUM']);
  });
  await rejectsOutOfRange('antifraude.fornecedor_novo_dias');
});

test('m4d022_param_antifraude_fornecedor_novo_valor_minimo_muda_comportamento: 15.000 a fornecedor novo passa com 20.000 e retém com 10.000', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['14000.00', '14000.00'], { costCenterId });
    assert.equal((await pay(t, '15000.00', { bankAccountId: acc.id })).requiresManualReview, false);
    await set(t, 'antifraude.fornecedor_novo_valor_minimo', 10000);
    assert.deepEqual(await K.casesOf(t, (await pay(t, '15000.01', { bankAccountId: acc.id })).id), ['NEW_SUPPLIER_HIGH_VALUE:MEDIUM']);
  });
  await rejectsOutOfRange('antifraude.fornecedor_novo_valor_minimo');
});

async function manualMatch(t, actor, amount) {
  const acc = await bankAccountsService.createBankAccount({ ...K.base(), bankCode: '104', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  const entry = await financialEntriesService.createFinancialEntry({ ...K.base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: acc.id, description: `conciliação ${T.uniqueSuffix()}` }, tenant.userId, t);
  const tx = await bankTransactionsService.createBankTransaction({ ...K.base(), bankAccountId: acc.id, amount, transactionDate: new Date() }, tenant.userId, t);
  await reconciliationService.matchReconciliation({ ...K.base(), financialEntryId: entry.id, bankTransactionId: tx.id }, actor, t);
  return { acc, entry, tx };
}
const reconCases = (t) => AnomalyCase.findAll({ where: { caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, transaction: t });

test('m4d022_param_antifraude_conciliacao_manual_usuario_7d_muda_comportamento: 3 da mesma pessoa não alertam com 5; com 3 alertam', async () => {
  await rollback(async (t) => {
    await K.store(t, 'antifraude.conciliacao_manual_percentual_mes', 100);
    await K.store(t, 'finance.antifraud_manual_reconciliation_min_count', 100);
    for (let i = 0; i < 3; i += 1) await manualMatch(t, tenant.userId, 10 + i);
    assert.equal((await reconCases(t)).length, 0);
    await set(t, 'antifraude.conciliacao_manual_usuario_7d', 3);
    await manualMatch(t, tenant.userId, 20);
    const [userCase] = await reconCases(t);
    assert.match(userCase.reason, /4 conciliações feitas à mão pela mesma pessoa nos últimos 7 dias \(limiar 3\)/);
  });
  await rejectsOutOfRange('antifraude.conciliacao_manual_usuario_7d');
});

async function autoMatch(t, amount) {
  const acc = await bankAccountsService.createBankAccount({ ...K.base(), bankCode: '104', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  const entry = await financialEntriesService.createFinancialEntry({ ...K.base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: acc.id, description: `auto ${T.uniqueSuffix()}` }, tenant.userId, t);
  const tx = await bankTransactionsService.createBankTransaction({ ...K.base(), bankAccountId: acc.id, amount, transactionDate: new Date() }, tenant.userId, t);
  await Reconciliation.create({ ...K.base(), financialEntryId: entry.id, bankTransactionId: tx.id, matchedAt: new Date(), matchMethod: 'AUTO_EXACT' }, { transaction: t });
}

test('m4d022_param_antifraude_conciliacao_manual_percentual_mes_muda_comportamento: 2 de 3 conciliações do mês à mão alertam com 30 e não com 70', async () => {
  for (const [pct, expected] of [[70, 0], [30, 1]]) {
    await rollback(async (t) => {
      await K.store(t, 'antifraude.conciliacao_manual_usuario_7d', 100);
      await K.store(t, 'finance.antifraud_manual_reconciliation_min_count', 100);
      if (pct !== 30) await set(t, 'antifraude.conciliacao_manual_percentual_mes', pct);
      await autoMatch(t, 40);
      await manualMatch(t, tenant.userId, 41);
      await manualMatch(t, tenant.userId, 42); // 2 manuais de 3 no mês = 66,7%
      assert.equal((await reconCases(t)).length, expected, `limiar ${pct}%`);
    });
  }
  await rejectsOutOfRange('antifraude.conciliacao_manual_percentual_mes');
});

test('m4d022_param_finance_bank_account_cooldown_hours_muda_comportamento: conta alterada há 20 h espera com 48 e recebe com 12', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t, { status: 'PENDING_COOLDOWN' });
    await T.sequelize.query("UPDATE finance.bank_accounts SET status = 'PENDING_COOLDOWN', updated_at = now() - interval '20 hours' WHERE id = :id", { replacements: { id: acc.id }, transaction: t });
    await assert.rejects(antifraud.assertBankAccountEligibleForPayment(acc.id, t), (err) => err.code === 'FINANCE_BANK_ACCOUNT_COOLDOWN');
    await set(t, 'finance.bank_account_cooldown_hours', 12);
    assert.equal((await antifraud.assertBankAccountEligibleForPayment(acc.id, t)).status, 'ACTIVE');
  });
  await rejectsOutOfRange('finance.bank_account_cooldown_hours');
});

test('m4d022_param_finance_antifraud_new_account_threshold_muda_comportamento: primeiro pagamento de 6.000 retém com 5.000 e passa com 7.000', async () => {
  await rollback(async (t) => {
    const first = await pay(t, '6000.00', { bankAccountId: (await K.account(t)).id });
    assert.deepEqual(await K.casesOf(t, first.id), ['NEW_ACCOUNT_IMMEDIATE_PAYMENT:MEDIUM']);
    assert.equal((await pay(t, '4999.99', { bankAccountId: (await K.account(t)).id })).requiresManualReview, false, 'fronteira R$ 4.999,99');
    await set(t, 'finance.antifraud_new_account_threshold', 7000);
    assert.equal((await pay(t, '6000.01', { bankAccountId: (await K.account(t)).id })).requiresManualReview, false);
  });
  await rejectsOutOfRange('finance.antifraud_new_account_threshold');
});

test('m4d022_param_finance_antifraud_history_multiplier_muda_comportamento: 4x a mediana revisa com 3 e passa com 5', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['1000.00', '1000.00', '1000.00', '1000.00', '1000.00'], { costCenterId });
    assert.deepEqual(await K.casesOf(t, (await pay(t, '4000.00', { bankAccountId: acc.id })).id), ['AMOUNT_OUTLIER:MEDIUM']);
    await set(t, 'finance.antifraud_history_multiplier', 5);
    assert.equal((await pay(t, '4000.01', { bankAccountId: acc.id })).requiresManualReview, false);
  });
  await rejectsOutOfRange('finance.antifraud_history_multiplier');
});

// X45-D097: nenhum número de política dos parâmetros acima escrito nos arquivos do antifraude de pagamento (os padrões ficam só em finance-settings.js).
const ARQUIVOS = ['payable-antifraud-findings.js', 'amount-outlier-finding.js', 'finance-antifraud.service.js', 'payment-anomaly-gate.js', 'antifraud-after-rollback.js', 'antifraud-parameters.service.js'];
const POLITICA = new Set([3, 5, 10, 12, 30, 48, 90, 5000, 20000]);

test('m4d022_guarda_estatica_sem_valor_de_politica_no_codigo', () => {
  const achados = [];
  for (const nome of ARQUIVOS) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'finance', 'application', 'services', nome), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const m of fonte.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)) if (POLITICA.has(Number(m[1]))) achados.push(`${nome}: ${m[1]}`);
  }
  assert.deepEqual(achados, [], achados.join('\n'));
});
