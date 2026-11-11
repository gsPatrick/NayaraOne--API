'use strict';

// DEC-007 (Maturacao/demandas/decisoes.csv) — números do antifraude do Marco 4 §17, que o livro lista sem valores: duplicidade 90 dias; conta nova 48 h e
// R$ 5.000,00; múltiplo 3,0 revisa e 10,0 bloqueia; fornecedor novo 30 dias e R$ 20.000,00; conciliação manual 5 em 7 dias ou 30% no mês; estorno frequente
// 3 por usuário e 5 por empresa em 30 dias (empresa fica em 3, a regra que já existia: falha segura, DI-DEC007-1). Cada número é parâmetro da tela de
// Configurações; o teste prova o padrão, a fronteira, que mudar o parâmetro muda o resultado e a falha segura. Serviço real, empresa isolada do banco
// descartável, cada teste numa transação desfeita no fim.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { comMfaRecente } = require('./helpers/mfaRecente');
const settingsService = require('../src/features/settings/settings.service');
const antifraud = require('../src/features/finance/financeAntifraud.service');
const gate = require('../src/features/finance/paymentAnomalyGate');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const approvalsService = require('../src/features/finance/approvals.service');
const { KEYS, FINANCE_SETTINGS_DEFAULTS, FINANCE_SETTINGS_SCHEMA } = require('../src/features/finance/finance.settings');
const { AnomalyCase, FinancialEntry, TenantSetting, Reconciliation, User } = require('../src/models');
const { seedFinanceAntifraudRules } = require('../scripts/seedFinanceAntifraudRules');

let tenant;
let costCenterId;
let resultCenterId;
const users = [];

before(async () => {
  tenant = await isolatedTenant('dec007');
  for (let i = 0; i < 3; i += 1) {
    users.push((await User.create({ email: `dec007-${i}-${T.uniqueSuffix()}@nayaraone.dev`, name: `DEC-007 ${i}`, passwordHash: 'x', status: 'ACTIVE' })).id);
  }
  await T.withTenantTransaction(tenant, async (t) => {
    costCenterId = (await T.createTestCostCenter(tenant, t)).id;
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
  });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const set = (t, key, value, actor = tenant.userId) => settingsService.upsertSetting(key, value, tenant, actor, t);
/** Parâmetro sensível (requiresMfa): grava com o MFA recente real de um usuário do teste. */
async function setWithMfa(t, key, value) {
  await comMfaRecente(users[0], tenant, t);
  return set(t, key, value, users[0]);
}

async function account(t, { ageDays = 0 } = {}) {
  const acc = await bankAccountsService.createBankAccount({ ...base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  acc.status = 'ACTIVE';
  await acc.save({ transaction: t });
  if (ageDays) await T.sequelize.query(`UPDATE finance.bank_accounts SET created_at = now() - (:d || ' days')::interval WHERE id = :id`, { replacements: { d: String(ageDays), id: acc.id }, transaction: t });
  return acc;
}
const settled = (t, bankAccountId, amounts) => Promise.all(amounts.map((amount) => FinancialEntry.create({ ...base(), bankAccountId, costCenterId, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `histórico ${T.uniqueSuffix()}`, status: 'SETTLED', settledAt: new Date(), competenceMonth: new Date().toISOString().slice(0, 7) }, { transaction: t })));
const payable = (t, amount, extra = {}) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'DEBIT', nature: 'PAYABLE', amount, costCenterId, description: `DEC-007 ${amount} ${T.uniqueSuffix()}`, ...extra }, tenant.userId, t);
const casesOf = async (t, entryId) => (await AnomalyCase.findAll({ where: { relatedEntityType: 'FinancialEntry', relatedEntityId: entryId }, order: [['caseType', 'ASC']], transaction: t })).map((c) => `${c.caseType}:${c.riskLevel}`);
const rejectsWith = (promise, code) => assert.rejects(promise, (err) => { assert.equal(err.code, code, `${err.code} ${err.message}`); return true; });

test('dec007_padroes_do_catalogo_e_faixas: padrões da DEC-007 no dicionário e no limiar efetivo sem regra publicada; fora da faixa é recusado', async () => {
  assert.deepEqual(
    [KEYS.newAccountThreshold, KEYS.bankAccountCooldownHours, KEYS.historyMultiplier, KEYS.outlierBlockMultiplier, KEYS.duplicateWindowDays, KEYS.newSupplierDays,
      KEYS.newSupplierMinAmount, KEYS.manualReconciliationUser7d, KEYS.manualReconciliationMonthPct, KEYS.frequentReversalUser30d, KEYS.frequentReversalCompany30d,
      KEYS.manualReconciliationMinCount, KEYS.manualReconciliationWindowDays].map((k) => FINANCE_SETTINGS_DEFAULTS[k]),
    [5000, 48, 3, 10, 90, 30, 20000, 5, 30, 3, 3, 3, 30]
  );
  await rollback(async (t) => {
    const th = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.deepEqual(
      [th.newAccountThreshold, th.cooldownHours, th.historyMultiplier, th.outlierBlockMultiplier, th.duplicateWindowDays, th.newSupplierDays, th.newSupplierMinAmount, th.ruleVersionId],
      [5000, 48, 3, 10, 90, 30, 20000, null]
    );
  });
  const bad = [[KEYS.outlierBlockMultiplier, 0.5], [KEYS.outlierBlockMultiplier, 1001], [KEYS.duplicateWindowDays, 0], [KEYS.duplicateWindowDays, 366], [KEYS.duplicateWindowDays, 1.5],
    [KEYS.newSupplierDays, 0], [KEYS.newSupplierDays, 366], [KEYS.newSupplierMinAmount, 0], [KEYS.newSupplierMinAmount, 1e9], [KEYS.manualReconciliationUser7d, 0],
    [KEYS.manualReconciliationUser7d, 101], [KEYS.manualReconciliationMonthPct, 0.5], [KEYS.manualReconciliationMonthPct, 100.5], [KEYS.frequentReversalUser30d, 0],
    [KEYS.frequentReversalUser30d, 101], [KEYS.frequentReversalCompany30d, 0], [KEYS.frequentReversalCompany30d, 1001], [KEYS.frequentReversalCompany30d, '5']];
  for (const [key, value] of bad) {
    assert.ok(FINANCE_SETTINGS_SCHEMA[key], key);
    await rollback((t) => rejectsWith(set(t, key, value), 'SETTING_INVALID_VALUE'));
  }
  // "não menor que o múltiplo de revisão": a trava compara com a outra chave da mesma empresa.
  await rollback(async (t) => {
    await rejectsWith(set(t, KEYS.outlierBlockMultiplier, 2.5), 'SETTING_INVALID_VALUE');
    await set(t, KEYS.outlierBlockMultiplier, 4);
    await rejectsWith(set(t, KEYS.historyMultiplier, 4.5), 'SETTING_INVALID_VALUE');
    await set(t, KEYS.historyMultiplier, 4);
  });
});

test('dec007_conta_nova_5000: primeiro pagamento a conta sem histórico retém a partir de R$ 5.000,00 (antes 10.000); o parâmetro muda a fronteira', async () => {
  await rollback(async (t) => {
    const below = await payable(t, '4999.99', { bankAccountId: (await account(t)).id });
    assert.equal(below.requiresManualReview, false);
    const at = await payable(t, '5000.00', { bankAccountId: (await account(t)).id });
    assert.equal(at.requiresManualReview, true);
    assert.match(at.manualReviewReason, /Primeiro pagamento desta conta bancária já no valor de 5000\.00 \(limite FIN-005 para conta sem histórico: 5000\.00\)/);
    assert.deepEqual(await casesOf(t, at.id), ['AMOUNT_OUTLIER:HIGH']);
    // Com a regra FIN-005 publicada o administrador decide o valor (sem ela, só vale o valor mais restritivo: dec007_falha_segura).
    await seedFinanceAntifraudRules(tenant, t);
    await setWithMfa(t, KEYS.newAccountThreshold, 6000);
    assert.equal((await payable(t, '5000.00', { bankAccountId: (await account(t)).id })).requiresManualReview, false, 'com o limite em 6.000, 5.000 passa');
    assert.equal((await payable(t, '6000.00', { bankAccountId: (await account(t)).id })).requiresManualReview, true, 'e 6.000 retém');
  });
});

test('dec007_multiplo_3_revisa_10_bloqueia: 3,0x retém para revisão (fluxo segue até a liquidação); 10,0x retém e bloqueia intenção e aprovação até a liberação', async () => {
  await rollback(async (t) => {
    const acc = await account(t);
    await settled(t, acc.id, ['1000.00', '1000.00']);
    assert.equal((await payable(t, '2999.99', { bankAccountId: acc.id })).requiresManualReview, false);
    const review = await payable(t, '3000.00', { bankAccountId: acc.id });
    assert.equal(review.requiresManualReview, true);
    assert.deepEqual(await casesOf(t, review.id), ['AMOUNT_OUTLIER:HIGH']);
    await gate.evaluateAndAssertPreparable(review, t); // revisão: não bloqueia preparar (a liquidação continua presa até a revisão)
    const high = await payable(t, '9999.99', { bankAccountId: acc.id });
    assert.deepEqual(await casesOf(t, high.id), ['AMOUNT_OUTLIER:HIGH']);
    const block = await payable(t, '10000.00', { bankAccountId: acc.id });
    assert.deepEqual(await casesOf(t, block.id), ['AMOUNT_OUTLIER:CRITICAL']);
    assert.match(block.manualReviewReason, /10\.0x a média histórica \(1000\.00\).*3x revisa, 10x bloqueia\)\. O pagamento fica bloqueado até a revisão/);
    await rejectsWith(paymentIntentsService.createPaymentIntent({ financialEntryId: block.id }, tenant.userId, t), 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED');
    await rejectsWith(approvalsService.createApprovalRequest({ ...base(), relatedEntityType: 'FinancialEntry', relatedEntityId: block.id, riskLevel: 'HIGH' }, tenant.userId, t), 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED');
    const released = await antifraud.clearManualReview(block.id, users[1], t, 'Conferido com o fornecedor e a nota fiscal.');
    await gate.evaluateAndAssertPreparable(released, t); // liberado por uma pessoa, o fluxo segue
    await set(t, KEYS.outlierBlockMultiplier, 5);
    assert.deepEqual(await casesOf(t, (await payable(t, '6000.00', { bankAccountId: acc.id })).id), ['AMOUNT_OUTLIER:CRITICAL'], 'bloqueio em 5x: 6x bloqueia');
  });
});

test('dec007_duplicidade_90_dias: mesmo favorecido, valor e vencimento de pagamento não cancelado na janela retém e bloqueia; vencimento diferente, cancelado ou fora da janela não', async () => {
  await rollback(async (t) => {
    const acc = await account(t);
    const due = '2027-03-10T15:00:00.000Z';
    const first = await payable(t, '700.00', { bankAccountId: acc.id, dueAt: due });
    assert.equal(first.requiresManualReview, false);
    const twin = await payable(t, '700.00', { bankAccountId: acc.id, dueAt: '2027-03-10T12:00:00.000Z' }); // mesmo dia em São Paulo
    assert.equal(twin.requiresManualReview, true);
    assert.deepEqual(await casesOf(t, twin.id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH']);
    assert.match(twin.manualReviewReason, new RegExp(`lançamento ${first.id}.*últimos 90 dias`));
    await rejectsWith(gate.evaluateAndAssertPreparable(twin, t), 'FINANCE_DUPLICATE_PAYMENT_SUSPECT');
    assert.equal((await payable(t, '700.00', { bankAccountId: acc.id, dueAt: '2027-04-10T15:00:00.000Z' })).requiresManualReview, false, 'outro vencimento');
    assert.equal((await payable(t, '700.01', { bankAccountId: acc.id, dueAt: due })).requiresManualReview, false, 'outro valor');
    // cancelado não conta
    const cancelled = await payable(t, '800.00', { bankAccountId: acc.id, dueAt: due });
    await financialEntriesService.cancelPendingFinancialEntry(cancelled.id, 'lançado por engano', tenant.userId, t);
    assert.equal((await payable(t, '800.00', { bankAccountId: acc.id, dueAt: due })).requiresManualReview, false);
    // janela: um pagamento igual lançado há 2 dias deixa de contar com a janela em 1 dia. O lançamento é append-only (created_at não muda), então a
    // cópia "de 2 dias atrás" entra por INSERT com a data no passado e o lançamento de hoje que serviu de molde é cancelado.
    const mold = await payable(t, '900.00', { bankAccountId: acc.id, dueAt: due });
    await T.sequelize.query(
      `INSERT INTO finance.financial_entries SELECT (jsonb_populate_record(NULL::finance.financial_entries, to_jsonb(e)
         || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', NULL, 'created_at', now() - interval '2 days', 'updated_at', now() - interval '2 days'))).*
         FROM finance.financial_entries e WHERE e.id = :id`,
      { replacements: { id: mold.id }, transaction: t }
    );
    await financialEntriesService.cancelPendingFinancialEntry(mold.id, 'molde do teste da janela', tenant.userId, t);
    await set(t, KEYS.duplicateWindowDays, 1);
    assert.equal((await payable(t, '900.00', { bankAccountId: acc.id, dueAt: due })).requiresManualReview, false, 'fora da janela de 1 dia');
    await set(t, KEYS.duplicateWindowDays, 90);
    assert.deepEqual(await casesOf(t, (await payable(t, '900.00', { bankAccountId: acc.id, dueAt: due })).id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH'], 'dentro de 90 dias');
    // liberação humana destrava
    const released = await antifraud.clearManualReview(twin.id, users[1], t, 'São duas parcelas distintas do mesmo contrato.');
    await gate.evaluateAndAssertPreparable(released, t);
  });
});

test('dec007_fornecedor_novo_30_dias_20000: conta cadastrada há menos de 30 dias recebendo a partir de R$ 20.000,00 retém (NEW_SUPPLIER_HIGH_VALUE); os dois parâmetros mudam o resultado', async () => {
  await rollback(async (t) => {
    const fresh = await account(t);
    await settled(t, fresh.id, ['15000.00', '15000.00']); // média 15.000: 20.000 não é valor fora do padrão
    assert.equal((await payable(t, '19999.99', { bankAccountId: fresh.id })).requiresManualReview, false);
    const at = await payable(t, '20000.00', { bankAccountId: fresh.id });
    assert.deepEqual(await casesOf(t, at.id), ['NEW_SUPPLIER_HIGH_VALUE:MEDIUM']);
    assert.match(at.manualReviewReason, /Fornecedor novo de alto valor: conta do favorecido cadastrada há 0 dia\(s\) \(menos de 30\), pagamento de 20000\.00/);
    await gate.evaluateAndAssertPreparable(at, t); // verificação antes de pagar, sem bloquear a preparação

    const old = await account(t, { ageDays: 31 });
    await settled(t, old.id, ['15000.00', '15000.00']);
    assert.equal((await payable(t, '20000.00', { bankAccountId: old.id })).requiresManualReview, false, 'cadastrada há 31 dias, com histórico');
    await set(t, KEYS.newSupplierDays, 60);
    assert.deepEqual(await casesOf(t, (await payable(t, '20000.50', { bankAccountId: old.id })).id), ['NEW_SUPPLIER_HIGH_VALUE:MEDIUM'], 'com 60 dias, a conta de 31 é nova');
    await set(t, KEYS.newSupplierMinAmount, 25000);
    assert.equal((await payable(t, '20001.00', { bankAccountId: old.id })).requiresManualReview, false, 'com o mínimo em 25.000, 20.001 passa');
  });
});

async function reversible(t) {
  return FinancialEntry.create({ ...base(), resultCenterId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '50.00', description: `estorno ${T.uniqueSuffix()}`, status: 'SETTLED', settledAt: new Date(), competenceMonth: new Date().toISOString().slice(0, 7) }, { transaction: t });
}
const reversalCases = (t) => AnomalyCase.findAll({ where: { caseType: 'FREQUENT_REVERSAL', status: 'OPEN' }, transaction: t });

test('dec007_estorno_frequente_usuario_3_empresa_3_em_30_dias: a 3ª pela mesma pessoa abre caso; 3 de pessoas diferentes também (empresa); o parâmetro da empresa muda o resultado', async () => {
  await rollback(async (t) => {
    await set(t, KEYS.frequentReversalCompany30d, 100);
    for (let i = 0; i < 2; i += 1) await financialEntriesService.reverseFinancialEntry((await reversible(t)).id, `estorno ${i}`, users[0], t);
    assert.equal((await reversalCases(t)).length, 0);
    await financialEntriesService.reverseFinancialEntry((await reversible(t)).id, 'estorno 3', users[0], t);
    const [one] = await reversalCases(t);
    assert.equal(one.riskLevel, 'HIGH');
    assert.match(one.reason, new RegExp(`3 estornos feitos pela mesma pessoa \\(usuário ${users[0]}\\) nos últimos 30 dias \\(limiar 3\\)`));
  });
  await rollback(async (t) => {
    await set(t, KEYS.frequentReversalUser30d, 100);
    await set(t, KEYS.frequentReversalCompany30d, 5);
    for (let i = 0; i < 3; i += 1) await financialEntriesService.reverseFinancialEntry((await reversible(t)).id, `estorno ${i}`, users[i], t);
    assert.equal((await reversalCases(t)).length, 0, 'com a empresa em 5 (valor da DEC-007), 3 estornos de pessoas diferentes não abrem caso');
    await set(t, KEYS.frequentReversalCompany30d, 3);
    await financialEntriesService.reverseFinancialEntry((await reversible(t)).id, 'estorno 4', users[1], t);
    const [company] = await reversalCases(t);
    assert.match(company.reason, /4 estornos na empresa nos últimos 30 dias \(limiar 3\)/);
  });
  await rollback(async (t) => {
    await set(t, KEYS.frequentReversalUser30d, 100);
    for (let i = 0; i < 3; i += 1) await financialEntriesService.reverseFinancialEntry((await reversible(t)).id, `estorno ${i}`, users[i], t);
    assert.equal((await reversalCases(t)).length, 1, 'padrão da empresa = 3 (regra que já existia, falha segura)');
  });
});

async function manualMatch(t, actor, amount) {
  const acc = await account(t);
  const entry = await financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: acc.id, description: `conciliação ${T.uniqueSuffix()}` }, tenant.userId, t);
  const tx = await bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: acc.id, amount, transactionDate: new Date() }, tenant.userId, t);
  return { acc, entry, tx, rec: await reconciliationService.matchReconciliation({ ...base(), financialEntryId: entry.id, bankTransactionId: tx.id }, actor, t) };
}
const reconCases = (t) => AnomalyCase.findAll({ where: { caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, transaction: t });

test('dec007_conciliacao_manual_5_por_usuario_em_7_dias_ou_mais_de_30_por_cento_do_mes: cada gatilho abre o seu caso e o parâmetro muda o resultado', async () => {
  await rollback(async (t) => {
    await set(t, KEYS.manualReconciliationMinCount, 100);
    await set(t, KEYS.manualReconciliationMonthPct, 100);
    for (let i = 0; i < 4; i += 1) await manualMatch(t, users[0], 10 + i);
    await manualMatch(t, users[1], 20); // outra pessoa não soma para o usuário 0
    assert.equal((await reconCases(t)).length, 0, '4 da mesma pessoa em 7 dias: abaixo de 5');
    await manualMatch(t, users[0], 30);
    const [userCase] = await reconCases(t);
    assert.deepEqual([userCase.relatedEntityType, userCase.relatedEntityId, userCase.riskLevel], ['User', users[0], 'MEDIUM']);
    assert.match(userCase.reason, /5 conciliações feitas à mão pela mesma pessoa nos últimos 7 dias \(limiar 5\)/);
    await manualMatch(t, users[0], 31);
    assert.equal((await reconCases(t)).length, 1, 'um caso aberto por pessoa a cada 7 dias');
  });
  await rollback(async (t) => {
    await set(t, KEYS.manualReconciliationMinCount, 100);
    await set(t, KEYS.manualReconciliationUser7d, 100);
    await set(t, KEYS.manualReconciliationMonthPct, 60);
    // uma conciliação automática do motor no mês
    const acc = await account(t);
    const entry = await financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 40, resultCenterId, bankAccountId: acc.id, description: `auto ${T.uniqueSuffix()}` }, tenant.userId, t);
    const tx = await bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: acc.id, amount: 40, transactionDate: new Date() }, tenant.userId, t);
    await Reconciliation.create({ ...base(), financialEntryId: entry.id, bankTransactionId: tx.id, matchedAt: new Date(), matchMethod: 'AUTO_EXACT' }, { transaction: t });
    await manualMatch(t, users[0], 41); // 1 de 2 = 50%
    assert.equal((await reconCases(t)).length, 0, '50% < 60%');
    await set(t, KEYS.manualReconciliationMonthPct, 30); // padrão da DEC-007
    await manualMatch(t, users[0], 42); // 2 de 3 = 66,7%
    const [monthCase] = await reconCases(t);
    assert.equal(monthCase.relatedEntityType, null);
    assert.match(monthCase.reason, /2 de 3 conciliações deste mês feitas à mão \(66\.7%, limiar 30%\)/);
  });
  await rollback(async (t) => {
    // a regra por empresa que já existia (3 em 30 dias) continua valendo além das da DEC-007
    await set(t, KEYS.manualReconciliationMonthPct, 100);
    for (let i = 0; i < 3; i += 1) await manualMatch(t, users[i], 50 + i);
    const [companyCase] = await reconCases(t);
    assert.match(companyCase.reason, /3 conciliações feitas à mão nos últimos 30 dias \(limiar 3\)/);
  });
});

test('dec007_falha_segura: valor gravado ilegível vira o padrão; sem regra publicada o valor gravado só vale se for mais restritivo', async () => {
  await rollback(async (t) => {
    await TenantSetting.create({ ...base(), key: KEYS.newAccountThreshold, value: 'abc' }, { transaction: t });
    await TenantSetting.create({ ...base(), key: KEYS.outlierBlockMultiplier, value: 'x' }, { transaction: t });
    const th = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.equal(th.newAccountThreshold, 5000);
    assert.equal(th.outlierBlockMultiplier, 10);
  });
  await rollback(async (t) => {
    await setWithMfa(t, KEYS.newAccountThreshold, 50000); // mais frouxo que o padrão
    await setWithMfa(t, KEYS.bankAccountCooldownHours, 12);
    const loose = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.deepEqual([loose.newAccountThreshold, loose.cooldownHours], [5000, 48], 'regra FIN-005 não publicada: o valor mais frouxo não vale');
    await set(t, KEYS.newAccountThreshold, 1000, users[0]);
    await set(t, KEYS.bankAccountCooldownHours, 72, users[0]);
    const strict = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.deepEqual([strict.newAccountThreshold, strict.cooldownHours], [1000, 72], 'o mais restritivo vale');
  });
});

test('dec007_resfriamento_da_reativacao_manual_le_o_parametro: a conta nova não volta a ACTIVE antes da espera configurada', async () => {
  await rollback(async (t) => {
    const acc = await bankAccountsService.createBankAccount({ ...base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
    await rejectsWith(bankAccountsService.updateBankAccount(acc.id, { status: 'ACTIVE' }, tenant.userId, t), 'FINANCE_BANK_ACCOUNT_COOLDOWN');
    await TenantSetting.create({ ...base(), key: KEYS.bankAccountCooldownHours, value: 72 }, { transaction: t });
    await T.sequelize.query("UPDATE finance.bank_accounts SET updated_at = now() - interval '50 hours' WHERE id = :id", { replacements: { id: acc.id }, transaction: t });
    await rejectsWith(bankAccountsService.updateBankAccount(acc.id, { status: 'ACTIVE' }, tenant.userId, t), 'FINANCE_BANK_ACCOUNT_COOLDOWN'); // 50 h < 72 h (antes: 48 h fixas liberavam)
    await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: KEYS.bankAccountCooldownHours }, force: true, transaction: t });
    assert.equal((await bankAccountsService.updateBankAccount(acc.id, { status: 'ACTIVE' }, tenant.userId, t)).status, 'ACTIVE', 'com o padrão de 48 h, 50 h já passaram');
  });
});
