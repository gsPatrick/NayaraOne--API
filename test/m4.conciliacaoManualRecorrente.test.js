'use strict';

// Caderno M4 §17 "Conciliação manual recorrente -> Alerta gerencial" (§17.7). Defeito achado na
// captura ao vivo do fechamento do Marco 4 (10/11/2026): checkRecurringManualReconciliationAlert
// era código morto (sem chamada, sem rota). Agora toda conciliação MANUAL confirmada conta; ao
// atingir o limiar na janela abre um caso RECURRING_MANUAL_RECONCILIATION (MEDIUM) visível em
// GET /finance/anomaly-cases e no relatório semanal. Automática e sugestão confirmada sem
// escolha não contam; um casamento em grupo conta 1. HTTP real contra o app.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_CONCIL_MANUAL_TEST_PORT || '21614';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const { AnomalyCase, TenantSetting, Reconciliation } = require('../src/models');

const KEY = 'finance.antifraud_manual_reconciliation_min_count';
let tenant;
let http;
let token;
let resultCenterId;
let account;
let startCount;

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function manualCount() {
  const [row] = await inTenant((t) => T.sequelize.query(
    "SELECT COUNT(DISTINCT COALESCE(match_group_id, id))::int AS n FROM finance.reconciliations WHERE company_id = :c AND match_method IN ('MANUAL','MANUAL_CHOICE') AND matched_at >= now() - interval '30 days'",
    { replacements: { c: tenant.companyId }, type: T.sequelize.QueryTypes.SELECT, transaction: t }
  ));
  return row.n;
}
const openAlerts = () => inTenant((t) => AnomalyCase.findAll({ where: { caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, transaction: t }));

before(async () => {
  tenant = await isolatedTenant('conciliacao-manual');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  const user = await createUser(tenant, 'conciliador');
  token = tokenFor(tenant, user.id);
  await inTenant(async (t) => {
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
    account = await bankAccountsService.createBankAccount({ ...base(), bankCode: '104', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
    // Ponto de partida limpo: casos antigos do alerta resolvidos e limiar = já existentes + 3.
    await AnomalyCase.update({ status: 'RESOLVED', resolvedAt: new Date() }, { where: { caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, transaction: t });
  });
  startCount = await manualCount();
  await inTenant((t) => TenantSetting.create({ ...base(), key: KEY, value: startCount + 3 }, { transaction: t }));
  // DEC-007 acrescentou o gatilho "30% das conciliações do mês feitas à mão" (DI-DEC007-1). Este arquivo prova o gatilho por empresa (limiar/janela);
  // com o percentual em 100 o gatilho do mês não interfere (o percentual tem o teste próprio em dec007.antifraudeParametros.test.js).
  await inTenant((t) => TenantSetting.create({ ...base(), key: 'antifraude.conciliacao_manual_percentual_mes', value: 100 }, { transaction: t }));
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await inTenant((t) => TenantSetting.destroy({ where: { key: KEY }, force: true, transaction: t }));
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

async function pair(amount, extra = {}) {
  return inTenant(async (t) => {
    const entry = await financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: account.id, description: `§17.7 ${T.uniqueSuffix()}`, ...(extra.entry || {}) }, tenant.userId, t);
    const tx = await bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: account.id, amount, transactionDate: new Date(), ...(extra.tx || {}) }, tenant.userId, t);
    return { entry, tx };
  });
}
const methodOf = async (bankTransactionId) => (await inTenant((t) => Reconciliation.findOne({ where: { bankTransactionId }, transaction: t }))).matchMethod;

test('M4-§17.7 conciliação automática e sugestão confirmada sem escolha não contam como manual; par informado pela pessoa conta (match_method gravado)', async () => {
  const key = `auto-${T.uniqueSuffix()}`;
  const auto = await pair(41, { entry: { idempotencyKey: key }, tx: { externalTransactionId: key } });
  const autoRes = await http('POST', `/finance/bank-transactions/${auto.tx.id}/auto-reconcile`, token, {});
  assert.equal(autoRes.status, 200, JSON.stringify(autoRes.body));
  assert.equal(autoRes.body.data.autoReconciled, true);
  assert.equal(await methodOf(auto.tx.id), 'AUTO_EXACT');
  const key2 = `sug-${T.uniqueSuffix()}`;
  const sug = await pair(42, { entry: { idempotencyKey: key2 }, tx: { externalTransactionId: key2 } });
  const sugRes = await http('POST', `/finance/reconciliation/${sug.tx.id}/confirm`, token, {});
  assert.equal(sugRes.status, 201, JSON.stringify(sugRes.body));
  assert.equal(await methodOf(sug.tx.id), 'SUGGESTION_CONFIRMED');
  assert.equal(await manualCount(), startCount, 'nenhuma das duas conta');
  const manual = await pair(43);
  const manRes = await http('POST', '/finance/reconciliations', token, { financialEntryId: manual.entry.id, bankTransactionId: manual.tx.id });
  assert.equal(manRes.status, 201, JSON.stringify(manRes.body));
  assert.equal(await methodOf(manual.tx.id), 'MANUAL');
  assert.equal(await manualCount(), startCount + 1);
  assert.equal((await openAlerts()).length, 0, 'abaixo do limiar não há alerta');
});

test('M4-§17.7 ao atingir o limiar na janela abre UM caso RECURRING_MANUAL_RECONCILIATION (MEDIUM, rótulo em português) em GET /finance/anomaly-cases e no relatório semanal; a próxima conciliação manual não abre outro', async () => {
  const a = await inTenant((t) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId, bankAccountId: account.id, description: `§17.7 grupo A ${T.uniqueSuffix()}` }, tenant.userId, t));
  const b = await inTenant((t) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 15, resultCenterId, bankAccountId: account.id, description: `§17.7 grupo B ${T.uniqueSuffix()}` }, tenant.userId, t));
  const gtx = await inTenant((t) => bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: account.id, amount: 25, transactionDate: new Date() }, tenant.userId, t));
  const group = await http('POST', '/finance/reconciliations/group', token, { financialEntryIds: [a.id, b.id], bankTransactionIds: [gtx.id] });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  assert.equal(await manualCount(), startCount + 2, 'o grupo conta uma conciliação');
  assert.equal((await openAlerts()).length, 0);

  const e1 = await pair(77);
  const e2 = await inTenant((t) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 77, resultCenterId, bankAccountId: account.id, description: `§17.7 outro ${T.uniqueSuffix()}` }, tenant.userId, t));
  const choice = await http('POST', `/finance/reconciliation/${e1.tx.id}/confirm`, token, { financialEntryId: e2.id });
  assert.equal(choice.status, 201, JSON.stringify(choice.body));
  assert.equal(await methodOf(e1.tx.id), 'MANUAL_CHOICE');
  const alerts = await openAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].riskLevel, 'MEDIUM');
  assert.match(alerts[0].reason, new RegExp(`${startCount + 3} conciliações feitas à mão nos últimos 30 dias`));
  const listed = (await http('GET', '/finance/anomaly-cases', token)).body.data.find((c) => c.id === alerts[0].id);
  assert.equal(listed.caseTypeLabel, 'Conciliação manual recorrente');
  const report = await http('GET', '/finance/reports/weekly-health', token);
  assert.equal(report.status, 200);
  assert.equal(report.body.data.managementAlerts.recurringManualReconciliation.openCases, 1);
  assert.equal(report.body.data.managementAlerts.recurringManualReconciliation.latestCaseId, alerts[0].id);

  const more = await pair(88);
  assert.equal((await http('POST', '/finance/reconciliations', token, { financialEntryId: more.entry.id, bankTransactionId: more.tx.id })).status, 201);
  assert.equal((await openAlerts()).length, 1, 'caso aberto na janela não se repete');
});
