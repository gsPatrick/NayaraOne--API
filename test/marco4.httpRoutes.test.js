'use strict';

// GAP REAL CORRIGIDO (varredura completa Marco 4 contra o Caderno Técnico, 11/10/2026): toda a
// cobertura de testes do Marco 4 até aqui chamava os services diretamente — nenhum arquivo
// batia com requisição HTTP real contra o Express app (auth JWT real + middleware de tenant
// real + rotas reais), ao contrário do padrão já usado em `construction.httpRoutes.test.js`
// (Marco 6) e `marco3.httpRoutes.test.js` (Marco 3). Este arquivo fecha essa lacuna para o
// núcleo do Marco 4: plano de contas -> centro de custo/resultado -> lançamento -> listagem ->
// orçamento/projeção -> relatório semanal de saúde, tudo via fetch nativo contra o app real.
//
// Fica de fora dos endpoints cobertos aqui tudo que exige step-up MFA real (settle/execute de
// pagamento, transferência intercompany) — isso já tem prova de concorrência e regra de negócio
// via chamada direta de service em test/marco4.*.test.js e test/adversarial.finance.test.js;
// MFA real precisa de estado de usuário (segredo TOTP + verificação recente) que foge do
// escopo de "provar que a rota Express existe e está ligada ao middleware certo".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.MARCO4_HTTP_TEST_PORT || '34593';

const app = require('../app');
const { getSeedTenant, uniqueSuffix, withTenantTransaction, sequelize: seqHelper, createTestResultCenter } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { ChartOfAccount, CostCenter, ResultCenter, FinancialEntry, BudgetForecast, Commission, AnomalyCase, Person, Property } = require('../src/models');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const propertiesService = require('../src/features/properties/properties.service');

let tenant;
let baseUrl;
let token;

const createdChartAccountIds = [];
const createdCostCenterIds = [];
const createdResultCenterIds = [];
const createdEntryIds = [];
const createdBudgetForecastIds = [];
const createdCommissionIds = [];
const createdAnomalyCaseIds = [];

before(async () => {
  tenant = await getSeedTenant();

  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['finance:create', 'finance:read', 'finance:update'],
  });

  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (createdAnomalyCaseIds.length > 0) await AnomalyCase.destroy({ where: { id: createdAnomalyCaseIds }, force: true });
  if (createdCommissionIds.length > 0) await Commission.destroy({ where: { id: createdCommissionIds }, force: true });
  if (createdBudgetForecastIds.length > 0) await BudgetForecast.destroy({ where: { id: createdBudgetForecastIds }, force: true });
  if (createdEntryIds.length > 0) await FinancialEntry.destroy({ where: { id: createdEntryIds }, force: true });
  if (createdResultCenterIds.length > 0) await ResultCenter.destroy({ where: { id: createdResultCenterIds }, force: true });
  if (createdCostCenterIds.length > 0) await CostCenter.destroy({ where: { id: createdCostCenterIds }, force: true });
  if (createdChartAccountIds.length > 0) await ChartOfAccount.destroy({ where: { id: createdChartAccountIds }, force: true });

  const { sequelize } = require('./testHelpers');
  await sequelize.close();
  // Mesmo padrão de construction.httpRoutes.test.js/marco3.httpRoutes.test.js: sem referência
  // ao server HTTP (app.listen incondicional em app.js, não exportado) — o fim do processo do
  // test runner libera a porta.
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

test('Marco 4 ponta a ponta via HTTP real: plano de contas -> centros -> lançamento -> listagem -> orçamento -> relatório', async () => {
  const suffix = uniqueSuffix();

  // 1. Plano de contas.
  const account = await http('POST', '/finance/chart-of-accounts', {
    code: `HTTP-${suffix.slice(-8)}`,
    name: `Conta HTTP ${suffix}`,
    accountType: 'EXPENSE',
    isAnalytic: true,
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  createdChartAccountIds.push(account.body.data.id);

  const accountsList = await http('GET', '/finance/chart-of-accounts');
  assert.equal(accountsList.status, 200);
  assert.ok(accountsList.body.data.some((a) => a.id === account.body.data.id));

  // 2. Centro de custo e centro de resultado.
  const costCenter = await http('POST', '/finance/cost-centers', { code: `CC-${suffix.slice(-8)}`, name: `Custo HTTP ${suffix}` });
  assert.equal(costCenter.status, 201, JSON.stringify(costCenter.body));
  createdCostCenterIds.push(costCenter.body.data.id);

  const resultCenter = await http('POST', '/finance/result-centers', { code: `RC-${suffix.slice(-8)}`, name: `Resultado HTTP ${suffix}` });
  assert.equal(resultCenter.status, 201, JSON.stringify(resultCenter.body));
  createdResultCenterIds.push(resultCenter.body.data.id);

  // 3. Lançamento (financial entry) PENDING — não exige MFA (só settle/execute exigem).
  const entry = await http('POST', '/finance/entries', {
    entryType: 'DEBIT',
    nature: 'PAYABLE',
    amount: 250.5,
    description: `Despesa HTTP ${suffix}`,
    costCenterId: costCenter.body.data.id,
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  createdEntryIds.push(entry.body.data.id);
  assert.equal(entry.body.data.status, 'PENDING');

  const entryGet = await http('GET', `/finance/entries/${entry.body.data.id}`);
  assert.equal(entryGet.status, 200);
  assert.equal(entryGet.body.data.amount, '250.50');

  const entriesList = await http('GET', '/finance/entries');
  assert.equal(entriesList.status, 200);
  assert.ok(entriesList.body.data.some((e) => e.id === entry.body.data.id));

  // 4. Orçamento/projeção (finance.budgets_forecasts, gap novo desta rodada) via rota real.
  const budget = await http('POST', '/finance/budget-forecasts', {
    competenceMonth: '2027-01',
    nature: 'PAYABLE',
    costCenterId: costCenter.body.data.id,
    forecastedAmount: 1000,
  });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  createdBudgetForecastIds.push(budget.body.data.id);

  const budgetList = await http('GET', '/finance/budget-forecasts?competenceMonth=2027-01');
  assert.equal(budgetList.status, 200);
  assert.ok(budgetList.body.data.some((b) => b.id === budget.body.data.id));

  const budgetCompare = await http('GET', '/finance/budget-forecasts/compare?competenceMonth=2027-01');
  assert.equal(budgetCompare.status, 200);
  const payableCompare = budgetCompare.body.data.find((c) => c.nature === 'PAYABLE');
  assert.ok(payableCompare.forecasted >= 1000);

  // 5. Relatório semanal de saúde — já inclui freeCash/marginBySector desta rodada.
  const health = await http('GET', '/finance/reports/weekly-health');
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(typeof health.body.data.freeCash.value, 'number');
  assert.ok(Array.isArray(health.body.data.marginBySector));
});

// GAP REAL CORRIGIDO (verificação cética adicional, Marco 4, 12/10/2026): `cancelCommission`
// (FIN-TS-017) e `listAnomalyCases`/`resolveAnomalyCase` (antifraude, §17/§19) tinham service
// completo e testado por chamada direta, mas NENHUMA rota HTTP os expunha — um humano não
// conseguia cancelar uma comissão nem ver/resolver um caso de anomalia pela API, muito menos
// pela interface. Rotas adicionadas em finance.routes.js; este teste prova que existem e
// funcionam de ponta a ponta.
test('FIN-TS-017 via HTTP: cancelar comissão exige motivo e gera ajuste auditável', async () => {
  const suffix = uniqueSuffix();
  const commission = await http('POST', '/finance/commissions', {
    beneficiaryUserId: tenant.userId,
    baseAmount: 5000,
    percentage: 5,
    idempotencyKey: `commission-http-${suffix}`,
  });
  assert.equal(commission.status, 201, JSON.stringify(commission.body));
  createdCommissionIds.push(commission.body.data.commission.id);

  const withoutReason = await http('POST', `/finance/commissions/${commission.body.data.commission.id}/cancel`, {});
  assert.equal(withoutReason.status, 400, JSON.stringify(withoutReason.body));
  assert.equal(withoutReason.body.error?.code, 'FINANCE_COMMISSION_CANCEL_REASON_REQUIRED');

  const cancelled = await http('POST', `/finance/commissions/${commission.body.data.commission.id}/cancel`, {
    reason: `Contrato cancelado — teste HTTP ${suffix}`,
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.commission.status, 'CANCELLED');
});

test('Anomaly cases via HTTP: listar e resolver um caso real', async () => {
  const anomalyCase = await withTenantTransaction(tenant, (transaction) =>
    AnomalyCase.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        caseType: 'HTTP_TEST',
        riskLevel: 'HIGH',
        reason: 'Caso fictício criado direto pelo teste HTTP para provar list/resolve via rota real',
        status: 'OPEN',
      },
      { transaction }
    )
  );
  createdAnomalyCaseIds.push(anomalyCase.id);

  const list = await http('GET', '/finance/anomaly-cases?status=OPEN&riskLevel=HIGH');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.data.some((c) => c.id === anomalyCase.id));

  const resolved = await http('POST', `/finance/anomaly-cases/${anomalyCase.id}/resolve`, {
    resolutionNote: 'Falso positivo confirmado — teste HTTP',
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.data.status, 'RESOLVED');

  const resolveAgain = await http('POST', `/finance/anomaly-cases/${anomalyCase.id}/resolve`, {});
  assert.equal(resolveAgain.status, 409, JSON.stringify(resolveAgain.body));
});

// FIN-TS-011 (§20 do Caderno: "Reabrir — Usuário comum — Negado"): a rota já é protegida por
// requirePermission('finance:approve') (finance.routes.js), mas nenhum teste provava isso pela
// camada HTTP real — verificação cética final do Marco 4 (11/10/2026).
test('FIN-TS-011: POST /finance/period-closures/reopen responde 403 para usuário sem finance:approve', async () => {
  const commonUserToken = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['member'],
    permissions: ['finance:read'],
  });
  const res = await fetch(`${baseUrl}/finance/period-closures/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${commonUserToken}` },
    body: JSON.stringify({ companyId: tenant.companyId, referenceMonth: '2031-01', reason: 'tentativa usuário comum' }),
  });
  assert.equal(res.status, 403);
});

async function withCommitted(fn) {
  const t = await seqHelper.transaction();
  try {
    await seqHelper.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await seqHelper.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await seqHelper.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// GAP REAL CORRIGIDO (ciclo de verificação adicional, Marco 4, 12/10/2026 — varredura
// função-por-função de todo src/features/finance/): 5 funções de service existiam, completas e
// usadas em teste direto, mas NENHUMA tinha rota HTTP nem controller — settleFinancialEntryPartial
// (FIN-TS-006, fora deste arquivo por exigir MFA, já provado em test/marco4.batch3.test.js),
// listClassificationPendings/resolveClassificationPending, autoReconcileSuggestion (nunca
// chamada de lugar nenhum, nem internamente — código morto),
// getOwnerRepasseComposition e getCommissionAdjustments.
test('GAP fechado via HTTP: fila de pendências de classificação é listável e resolvível pela rota', async () => {
  const suffix = uniqueSuffix();
  const pending = await withCommitted((t) =>
    FinancialEntry.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'CREDIT',
        nature: 'PENDING_CLASSIFICATION',
        status: 'PENDING',
        amount: 42.5,
        description: `Excedente HTTP ${suffix}`,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction: t }
    )
  );
  createdEntryIds.push(pending.id);

  const list = await http('GET', '/finance/entries/classification-pendings');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.data.some((e) => e.id === pending.id));

  const resolve = await http('POST', `/finance/entries/classification-pendings/${pending.id}/resolve`, { finalNature: 'ADJUSTMENT' });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
  assert.equal(resolve.body.data.nature, 'ADJUSTMENT');
  assert.equal(resolve.body.data.status, 'SETTLED');
});

test('GAP fechado via HTTP: autoReconcileSuggestion concilia sozinho um match EXATO, pela rota', async () => {
  const suffix = uniqueSuffix();
  const bankAccount = await withCommitted((t) =>
    bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '237', accountNumber: `m4auto-${suffix.slice(-8)}` },
      tenant.userId,
      t
    )
  );
  const externalId = `EXT-${suffix}`;
  const resultCenter = await withCommitted((t) => createTestResultCenter(tenant, t));
  // EXATO exige, ao mesmo tempo: mesmo valor, referência batendo pelo externalTransactionId ==
  // idempotencyKey do lançamento, mesma bankAccountId (contraparte) e data dentro da janela —
  // ver reconciliation.service.js#classifyMatch.
  const entry = await http('POST', '/finance/entries', {
    entryType: 'CREDIT',
    nature: 'RECEIVABLE',
    amount: 777.0,
    description: `Recebimento conciliação HTTP ${suffix}`,
    bankAccountId: bankAccount.id,
    resultCenterId: resultCenter.id,
    idempotencyKey: externalId,
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  createdEntryIds.push(entry.body.data.id);

  const csvText = `externaltransactionid,transactiondate,description,amount\n${externalId},${new Date().toISOString().slice(0, 10)},Recebimento conciliação HTTP ${suffix},777.00\n`;
  const imported = await http('POST', '/finance/bank-transactions/import', { bankAccountId: bankAccount.id, csvText });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const bankTransactionId = imported.body.data.imported[0].id;

  const auto = await http('POST', `/finance/bank-transactions/${bankTransactionId}/auto-reconcile`, {});
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(auto.body.data.finalClass, 'EXACT', JSON.stringify(auto.body.data));
  assert.equal(auto.body.data.autoReconciled, true, JSON.stringify(auto.body));
  assert.equal(auto.body.data.reconciliation.financialEntryId, entry.body.data.id);
});

test('GAP fechado via HTTP: histórico de ajustes de comissão é consultável pela rota', async () => {
  const suffix = uniqueSuffix();
  const commission = await http('POST', '/finance/commissions', {
    beneficiaryUserId: tenant.userId,
    baseAmount: 2000,
    percentage: 5,
    idempotencyKey: `commission-http-${suffix}`,
  });
  assert.equal(commission.status, 201, JSON.stringify(commission.body));
  createdCommissionIds.push(commission.body.data.commission.id);

  const cancel = await http('POST', `/finance/commissions/${commission.body.data.commission.id}/cancel`, { reason: 'teste de rota HTTP' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

  const adjustments = await http('GET', `/finance/commissions/${commission.body.data.commission.id}/adjustments`);
  assert.equal(adjustments.status, 200, JSON.stringify(adjustments.body));
  assert.ok(adjustments.body.data.length >= 1, JSON.stringify(adjustments.body));
  assert.equal(adjustments.body.data[0].adjustmentType, 'CANCELLATION_REVERSAL');
});

test('GAP fechado via HTTP: composição do repasse de proprietário é consultável pela rota (Caderno §12)', async () => {
  const suffix = uniqueSuffix();
  const repasse = await withCommitted(async (t) => {
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M4-comp HTTP ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M4-comp Imóvel ${suffix}`, internalCode: `M4COMP-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      t
    );
    const resultCenter = await createTestResultCenter(tenant, t);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, description: `M4-comp aluguel ${suffix}`, resultCenterId: resultCenter.id },
      tenant.userId,
      t
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, t);
    return ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        ownerPersonId: owner.id,
        sourceEntryIds: [recebimento.id],
        deductionsAmount: 50,
        idempotencyKey: `repasse-http-${suffix}`,
      },
      tenant.userId,
      t
    );
  });

  const composition = await http('GET', `/finance/owner-repasses/${repasse.id}/composition`);
  assert.equal(composition.status, 200, JSON.stringify(composition.body));
  assert.equal(composition.body.data.ownerRepasseId, repasse.id);
  assert.ok(Array.isArray(composition.body.data.composition));
  assert.ok(composition.body.data.composition.length >= 1, JSON.stringify(composition.body.data));
});
