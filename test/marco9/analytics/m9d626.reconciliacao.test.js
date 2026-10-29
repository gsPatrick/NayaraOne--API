'use strict';

// M9-D626 — o painel Financeiro com KPIs calculados de verdade (não semeados) sobre uma massa de lançamentos reconcilia com o serviço atual getWeeklyHealthReport (portão do sprint B2
// da M9-D706) e abre o detalhe pelo item de sourceRefs do número. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envFin = require('../_helpers/painelFinEnv');
const { seedMass, cleanupMass } = require('../_helpers/m9d626Massa');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { getWeeklyHealthReport } = require('../../../src/features/finance/financialHealthReport.service');

const { FIN_USER, NOW, openPanel, http } = envFin;
const widgets = (res) => res.body.data.widgets;
const by = (res, c) => widgets(res).find((w) => w.metricCode === c);
const cellOf = (res, c) => by(res, 'fin.payables_7d').view.matrix.rows.flatMap((r) => r.cells).find((x) => x.metricCode === c);
const valueOf = (res, c) => (cellOf(res, c) || by(res, c)).metric.value;
let env;
let report;
let panel;

before(async () => {
  env = await envFin.setup();
  await seedMass(env, env.tenantA);
  report = await http.inTx(env.tenantA, {}, (tx) => getWeeklyHealthReport(tx, { now: NOW, companyId: env.tenantA.companyId }));
  panel = await openPanel(env, 'finance', { perms: FIN_USER });
});
after(async () => { await cleanupMass(env); await envFin.teardown(env); });

test('m9d626 valores do painel reconciliam com getWeeklyHealthReport na massa de teste', () => {
  assert.equal(panel.status, 200, JSON.stringify(panel.body));
  const pairs = [
    ['fin.payables_7d', report.dueNextSevenDays.payable.total], ['fin.payables_30d', report.dueNext30Days.payable.total], ['fin.payables_60d', report.dueNext60Days.payable.total],
    ['fin.receivables_7d', report.dueNextSevenDays.receivable.total], ['fin.receivables_30d', report.dueNext30Days.receivable.total], ['fin.receivables_60d', report.dueNext60Days.receivable.total],
    ['fin.overdue_receivables', report.overdue.receivable.total], ['fin.third_party_cash', report.freeCash.thirdPartyHeld],
  ];
  for (const [code, want] of pairs) assert.equal(money.cmp(valueOf(panel, code), String(want)), 0, `${code}: painel ${valueOf(panel, code)} x relatório ${want}`);
  assert.deepEqual(pairs.slice(0, 6).map(([, v]) => v), [15000, 18000, 36500, 18000, 65000, 112500], 'a massa dá os números do livro (exemplo da M9-D621 sem lançamento nos dias limite)');
  assert.equal(report.overdue.receivable.total, 6500);
  assert.equal(report.freeCash.thirdPartyHeld, 1000);
});

test('m9d626 painel e relatório não contam as mesmas coisas onde o livro as separa: terceiros em aberto não entram nos recebíveis próprios', () => {
  assert.equal(report.thirdPartyFunds.total, 54000, 'o relatório mostra os terceiros em aberto à parte');
  assert.equal(money.cmp(valueOf(panel, 'fin.receivables_7d'), '18000.00'), 0, 'e o painel não os soma aos recebíveis');
  assert.equal(by(panel, 'fin.third_party_cash').title, 'Dinheiro de terceiros (não é caixa livre)');
});

test('m9d626 janelas do painel acompanham o livro (hoje até hoje+N-1): o dia N+1 que o relatório semanal ainda conta fica fora do painel (DI-D626-4)', async () => {
  const ledger = require('../_helpers/m9d615Ledger');
  const { dayAt, refresh, kpis } = require('../_helpers/finKpiEnv');
  await ledger.entry(env, env.tenantA, { nature: 'PAYABLE', amount: '1000.00', due: dayAt(7) });
  await refresh(env.tenantA);
  await kpis(env.tenantA);
  const [after7, rep] = [await openPanel(env, 'finance', { perms: FIN_USER }), await http.inTx(env.tenantA, {}, (tx) => getWeeklyHealthReport(tx, { now: NOW, companyId: env.tenantA.companyId }))];
  assert.equal(money.cmp(valueOf(after7, 'fin.payables_7d'), '15000.00'), 0, 'o painel segue a janela do livro: 7 dias terminam em hoje+6');
  assert.equal(rep.dueNextSevenDays.payable.total, 16000, 'o relatório semanal antigo conta também o dia hoje+7');
});

test('m9d626 Ver detalhe: o item de sourceRefs do número abre o detalhe só com a permissão; sem ela vem o agregado', async () => {
  const cell = cellOf(panel, 'fin.payables_7d');
  assert.equal(cell.drilldown.enabled, true, 'contas a pagar em 7 dias é crítico');
  assert.equal(cell.drilldown.allowed, false, 'sem analytics:drilldown o painel não oferece o botão');
  const withPerm = await openPanel(env, 'finance', { perms: [...FIN_USER, 'analytics:drilldown'] });
  const allowed = cellOf(withPerm, 'fin.payables_7d').drilldown;
  assert.deepEqual([allowed.enabled, allowed.allowed], [true, true]);
  assert.equal(allowed.sourceRef.table, 'finance.financial_entries');
  const ref = allowed.sourceRef;
  const query = `filter=${encodeURIComponent(JSON.stringify(ref.filter))}&filterHash=${ref.filterHash}&filterSignature=${ref.filterSignature}&page=1&pageSize=20`;
  const open = await env.call('GET', `/analytics/metrics/fin.payables_7d/drilldown?${query}`, { perms: [...FIN_USER, 'analytics:drilldown'] });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const denied = await env.call('GET', `/analytics/metrics/fin.payables_7d/drilldown?${query}`, { perms: FIN_USER });
  assert.deepEqual([denied.status, denied.body.code || denied.body.error.code], [403, 'ANALYTICS_DRILLDOWN_FORBIDDEN']);
  assert.ok(JSON.stringify(denied.body).includes('aggregate'), 'a recusa traz o agregado permitido');
});
