'use strict';

/**
 * M9-D708 (3.3) — relatórios de referência do Financeiro. O caixa livre, o dinheiro de terceiros, as contas a pagar e a receber (7, 30 e 60 dias), os vencidos,
 * as conciliações pendentes e a necessidade para respirar são conferidos contra o relatório de saúde financeira do próprio módulo (`getWeeklyHealthReport`),
 * que calcula tudo por conta própria (saldo do extrato bancário, lançamentos pendentes), sem passar pelo read model do BI. O BI não importa serviço de outra
 * área (BI-001): estes adaptadores ficam em scripts/ e são injetados em `reconcileMetric`.
 * Cada adaptador recebe { ctx, now, snapshot, transaction } e devolve { value, label }.
 */
const { getWeeklyHealthReport } = require('../../../src/modules/finance/application/services/finance-health.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { reconcileDetail } = require('../../../src/features/analytics/metrics/sourceRefs');

const SOURCE = 'Relatório de saúde financeira (getWeeklyHealthReport, módulo Financeiro)';
const cache = new WeakMap(); // um relatório por transação e instante (os 19 KPIs leem o mesmo)

async function report({ ctx, now, transaction }) {
  const byNow = cache.get(transaction) || new Map();
  const key = now ? new Date(now).toISOString() : 'agora';
  if (!byNow.has(key)) byNow.set(key, await getWeeklyHealthReport(transaction, { now, companyId: ctx.companyId }));
  cache.set(transaction, byNow);
  return byNow.get(key);
}

const brl = (n) => money.money(String(n));
// M4LR (DI-M4LR-7): o "caixa disponível" do relatório passou a ser o CONCILIADO próprio (Caderno §19). O KPI do BI fin.free_cash é a
// conta do extrato inteiro menos o dinheiro de terceiros retido; a referência dele segue essa mesma conta, com as partes que o relatório
// devolve (extrato importado e terceiros retidos pelo ledger, cada recebimento uma vez).
const extractMinusThirdParty = (r) => money.toString(money.sub(brl(r.freeCash.grossBankBalance), brl(r.freeCash.thirdPartyHeld)));
const pick = (label, read) => async (args) => ({ value: brl(read(await report(args))), label: `${SOURCE}: ${label}` });

/** Parcelas de comissão sem lançamento a pagar: o componente da necessidade que o relatório de saúde não traz (vem do detalhe do componente no snapshot). */
async function commissionsUnlinked({ ctx, snapshot, asOfDate, transaction }) {
  const ref = ((snapshot && snapshot.source_refs) || []).find((r) => r.component === 'fin.commissions_unlinked_30d');
  if (!ref) return '0.00';
  return (await reconcileDetail(ctx, 'fin.commissions_unlinked_30d', ref, '0', { asOfDate, units: { 'fin.commissions_unlinked_30d': 'BRL' } }, transaction)).detail;
}

const breathingNeed = async (args) => {
  const r = await report(args);
  const gross = money.sub(money.sum([brl(r.overdue.payable.total), brl(r.dueNext30Days.payable.total), await commissionsUnlinked(args)]), extractMinusThirdParty(r));
  return { value: money.cmp(gross, 0) > 0 ? money.money(gross) : money.money(0), label: `${SOURCE}: vencidas + a pagar em 30 dias + comissões sem lançamento - caixa livre` };
};

const WINDOWS = { 7: 'dueNextSevenDays', 30: 'dueNext30Days', 60: 'dueNext60Days' };
const windowReports = Object.fromEntries(Object.entries(WINDOWS).flatMap(([days, field]) => [
  [`fin.payables_${days}d`, pick(`contas a pagar em ${days} dias`, (r) => r[field].payable.total)],
  [`fin.receivables_${days}d`, pick(`contas a receber em ${days} dias`, (r) => r[field].receivable.total)],
]));

const FINANCE_REPORTS = Object.freeze({
  'fin.free_cash': pick('caixa livre (saldo do extrato menos dinheiro de terceiros retido)', (r) => extractMinusThirdParty(r)),
  'fin.third_party_cash': pick('dinheiro de terceiros retido em caixa', (r) => r.freeCash.thirdPartyHeld),
  'fin.overdue_payables': pick('contas a pagar vencidas', (r) => r.overdue.payable.total),
  'fin.overdue_receivables': pick('contas a receber vencidas', (r) => r.overdue.receivable.total),
  'fin.reconciliations_pending': async (args) => ({ value: String((await report(args)).pendingReconciliations.count), label: `${SOURCE}: transações do extrato sem conciliação` }),
  'fin.breathing_need': breathingNeed,
  ...windowReports,
});

module.exports = { FINANCE_REPORTS };
