'use strict';

// Caderno M4 §17 "Conciliação manual recorrente -> Alerta gerencial" (§17.7): o livro pede o alerta e não fixa limiar nem janela, então são parâmetros do
// administrador (aba "Financeiro" de Configurações), gravados pelo mesmo caminho das outras abas (PUT /settings/:key, settings:update, SETTINGS_SCHEMA com
// faixa). O teste grava e lê pela API, confere a recusa de valor fora da faixa e de perfil sem a permissão, e prova que o alerta passa a usar o valor gravado.
// HTTP real contra o app, numa empresa isolada do banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_PARAMETROS_FIN_TEST_PORT || '21615';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated, FINANCE_ALL } = require('./helpers/m4FinanceHttp');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTransactionsService = require('../src/modules/finance/application/services/bank-transactions.service');
const { KEYS, FINANCE_SETTINGS_DEFAULTS } = require('../src/modules/finance/application/services/finance-settings');
const { AnomalyCase } = require('../src/models');

const MIN = KEYS.manualReconciliationMinCount;
const WINDOW = KEYS.manualReconciliationWindowDays;
let tenant;
let http;
let admin;
let semPermissao;
let resultCenterId;
let account;

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const put = (key, value, token = admin) => http('PUT', `/settings/${encodeURIComponent(key)}`, token, { value });
const read = async (key) => (await http('GET', `/settings/${encodeURIComponent(key)}`, admin)).body.data.value;
const openAlerts = () => inTenant((t) => AnomalyCase.findAll({ where: { caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, transaction: t }));

async function manualCount() {
  const [row] = await inTenant((t) => T.sequelize.query(
    "SELECT COUNT(DISTINCT COALESCE(match_group_id, id))::int AS n FROM finance.reconciliations WHERE company_id = :c AND match_method IN ('MANUAL','MANUAL_CHOICE')",
    { replacements: { c: tenant.companyId }, type: T.sequelize.QueryTypes.SELECT, transaction: t }
  ));
  return row.n;
}

async function manualReconciliation(amount) {
  const { entry, tx } = await inTenant(async (t) => ({
    entry: await financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: account.id, description: `§17.7 parâmetro ${T.uniqueSuffix()}` }, tenant.userId, t),
    tx: await bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: account.id, amount, transactionDate: new Date() }, tenant.userId, t),
  }));
  const res = await http('POST', '/finance/reconciliations', admin, { financialEntryId: entry.id, bankTransactionId: tx.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

before(async () => {
  tenant = await isolatedTenant('parametros-financeiro');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  const user = await createUser(tenant, 'admin-parametros');
  admin = tokenFor(tenant, user.id, [...FINANCE_ALL, 'settings:read', 'settings:update']);
  const outro = await createUser(tenant, 'sem-settings-update');
  semPermissao = tokenFor(tenant, outro.id, [...FINANCE_ALL, 'settings:read']);
  await inTenant(async (t) => {
    // DEC-007: o gatilho "30% das conciliações do mês feitas à mão" dispararia na 1ª conciliação manual da empresa isolada; em 100 ele não interfere
    // neste arquivo, que prova o gatilho por limiar/janela (o percentual tem o teste próprio em dec007.antifraudeParametros.test.js).
    await require('../src/models').TenantSetting.create({ ...base(), key: 'antifraude.conciliacao_manual_percentual_mes', value: 100 }, { transaction: t });
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
    account = await bankAccountsService.createBankAccount({ ...base(), bankCode: '104', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  });
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

test('M4-§17.7 parâmetros: o administrador grava e lê o limiar e a janela da conciliação manual recorrente pelo PUT e GET /settings', async () => {
  assert.equal(FINANCE_SETTINGS_DEFAULTS[MIN], 3);
  assert.equal(FINANCE_SETTINGS_DEFAULTS[WINDOW], 30);
  const min = await put(MIN, 2);
  assert.equal(min.status, 200, JSON.stringify(min.body));
  assert.equal(min.body.data.value, 2);
  const win = await put(WINDOW, 15);
  assert.equal(win.status, 200, JSON.stringify(win.body));
  assert.equal(await read(MIN), 2);
  assert.equal(await read(WINDOW), 15);
  const listed = await http('GET', '/settings?prefix=finance.antifraud_manual_reconciliation_', admin);
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.fromEntries(listed.body.data.map((row) => [row.key, row.value])), { [MIN]: 2, [WINDOW]: 15 });
});

test('M4-§17.7 parâmetros: valor fora da faixa ou do tipo é recusado com 422 SETTING_INVALID_VALUE (DI-DEC007-2) e o valor gravado não muda', async () => {
  for (const [key, value] of [[MIN, 0], [MIN, 101], [MIN, 2.5], [MIN, '3'], [MIN, -1], [WINDOW, 0], [WINDOW, 366], [WINDOW, 7.5], [WINDOW, null]]) {
    const res = await put(key, value);
    assert.equal(res.status, 422, `${key}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.code, 'SETTING_INVALID_VALUE', `${key}=${JSON.stringify(value)}`);
  }
  assert.equal(await read(MIN), 2);
  assert.equal(await read(WINDOW), 15);
});

test('M4-§17.7 parâmetros: perfil sem settings:update é recusado com 403 PERMISSION_DENIED e o valor gravado não muda', async () => {
  for (const [key, value] of [[MIN, 50], [WINDOW, 90]]) {
    const res = await put(key, value, semPermissao);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.code, 'PERMISSION_DENIED');
  }
  assert.equal(await read(MIN), 2);
  assert.equal(await read(WINDOW), 15);
});

test('M4-§17.7 parâmetros: com o limiar gravado em 2 e a janela em 15 dias, a 2ª conciliação manual abre o caso RECURRING_MANUAL_RECONCILIATION', async () => {
  assert.equal(await manualCount(), 0, 'empresa isolada começa sem conciliação manual');
  await manualReconciliation(31);
  assert.equal((await openAlerts()).length, 0, 'com 1 conciliação manual e limiar 2 ainda não há alerta');
  await manualReconciliation(32);
  const alerts = await openAlerts();
  assert.equal(alerts.length, 1, 'a 2ª conciliação manual atinge o limiar gravado');
  assert.equal(alerts[0].riskLevel, 'MEDIUM');
  assert.match(alerts[0].reason, /2 conciliações feitas à mão nos últimos 15 dias \(limiar 2\)/);
});

test('M4-§17.7 parâmetros: as demais chaves do Financeiro (antifraude e AUTO_STRONG) gravam pelo mesmo caminho e respeitam a faixa', async () => {
  const ok = [[KEYS.bankAccountCooldownHours, 720], [KEYS.bankAccountCooldownHours, 0], [KEYS.historyMultiplier, 2.5], [KEYS.newAccountThreshold, 5000], [KEYS.reconciliationAutoStrong, true], [KEYS.reconciliationAutoStrong, false]];
  for (const [key, value] of ok) {
    const res = await put(key, value);
    assert.equal(res.status, 200, `${key}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
    assert.equal(await read(key), value);
  }
  // Antifraude (DI-DEC007-2): 422 com a frase do rótulo; a chave booleana da conciliação automática continua com o 400 de antes.
  const bad = [[KEYS.bankAccountCooldownHours, 721, 422], [KEYS.bankAccountCooldownHours, -1, 422], [KEYS.historyMultiplier, 0.5, 422], [KEYS.historyMultiplier, 101, 422], [KEYS.newAccountThreshold, -1, 422], [KEYS.reconciliationAutoStrong, 'sim', 400]];
  for (const [key, value, status] of bad) {
    const res = await put(key, value);
    assert.equal(res.status, status, `${key}=${JSON.stringify(value)}`);
    assert.equal(res.code, 'SETTING_INVALID_VALUE', `${key}=${JSON.stringify(value)}`);
  }
  assert.equal((await put(KEYS.reconciliationAutoStrong, true, semPermissao)).code, 'PERMISSION_DENIED');
  assert.equal(await read(KEYS.reconciliationAutoStrong), false);
});
