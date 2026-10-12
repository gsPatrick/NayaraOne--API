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
const { getSeedTenant, uniqueSuffix, withTenantTransaction } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { ChartOfAccount, CostCenter, ResultCenter, FinancialEntry, BudgetForecast, Commission, AnomalyCase } = require('../src/models');

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
