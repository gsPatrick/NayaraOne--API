'use strict';

const { countOpenHighRiskAnomalies } = require('./anomaly-cases.service');
const { startOfBusinessDay } = require('../../../../utils/businessDate');
const { AnomalyCase } = require('../../../../models');
const sources = require('./finance-health-sources');
const { readReceivableWeights } = require('./finance-health-settings');

// M4-20 — Relatório semanal de saúde financeira (Caderno M4 §19; Guia §13 "FinanceHealthReport").
//
// Cálculo REAL (nenhum número inventado), sob o RLS da empresa do contexto, somado em CENTAVOS inteiros. As leituras
// estão em finance-health-sources.js:
//  - previsto (a pagar, a receber, vencidos, janelas 7/30/60, inadimplência) = SALDO EM ABERTO de PENDING e
//    PARTIALLY_SETTLED; o recebível parcialmente recebido continua com o saldo (sonda P6: R$ 0,30 com 0,10 baixado = 0,20);
//  - realizado (margem, dinheiro de terceiros retido) = view finance.ledger, sem contar em dobro o pai quitado em baixas;
//  - dinheiro de terceiro (caução etc., M4-16/§13) nunca é resultado próprio: vem separado.

const toCents = (value) => Math.round(Number(value || 0) * 100);
const money = (cents) => Math.round(cents) / 100;
const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 100) / 100 : 0);
const emptyBucket = () => ({ count: 0, cents: 0, weightedCents: 0 });
const emptyPair = () => ({ payable: emptyBucket(), receivable: emptyBucket() });

function publicBucket(b, withWeight) {
  return withWeight ? { count: b.count, total: money(b.cents), weighted: money(b.weightedCents) } : { count: b.count, total: money(b.cents) };
}

function publicPair(pair) {
  return { payable: publicBucket(pair.payable, false), receivable: publicBucket(pair.receivable, true) };
}

/** Status do recebível para a ponderação (§19 "direitos previstos ponderados por status"). */
function receivableStatus(entry, dueAt, startToday) {
  if (dueAt && dueAt < startToday) return 'VENCIDO';
  return entry.status === 'PARTIALLY_SETTLED' ? 'PARCIAL' : 'EM_DIA';
}

function addTo(bucket, cents, weight) {
  bucket.count += 1;
  bucket.cents += cents;
  bucket.weightedCents += Math.round(cents * weight);
}

/** Distribui o saldo em aberto de cada lançamento nos indicadores de previsto. */
function aggregateOpen(openEntries, bounds, weights) {
  const acc = { payable: emptyBucket(), receivable: emptyBucket(), overdue: emptyPair(), d7: emptyPair(), d30: emptyPair(), d60: emptyPair(), third: emptyBucket() };
  for (const entry of openEntries) {
    const cents = toCents(entry.open_amount);
    if (entry.is_third_party_funds) {
      addTo(acc.third, cents, 1);
      continue; // dinheiro de terceiro não compõe resultado próprio (FIN-006).
    }
    const side = entry.nature === 'PAYABLE' ? 'payable' : 'receivable';
    const dueAt = entry.due_at ? new Date(entry.due_at) : null;
    const weight = side === 'receivable' ? weights[receivableStatus(entry, dueAt, bounds.startToday)] : 1;
    addTo(acc[side], cents, weight);
    if (!dueAt) continue;
    if (dueAt < bounds.startToday) addTo(acc.overdue[side], cents, weight);
    else {
      if (dueAt < bounds.horizon7) addTo(acc.d7[side], cents, weight);
      if (dueAt < bounds.horizon30) addTo(acc.d30[side], cents, weight);
      if (dueAt < bounds.horizon60) addTo(acc.d60[side], cents, weight);
    }
  }
  return acc;
}

async function managementAlerts(companyId, transaction) {
  const recurringManual = companyId
    ? await AnomalyCase.findAll({ where: { companyId, caseType: 'RECURRING_MANUAL_RECONCILIATION', status: 'OPEN' }, order: [['created_at', 'DESC']], transaction })
    : [];
  return {
    recurringManualReconciliation: {
      label: 'Conciliação manual recorrente',
      openCases: recurringManual.length,
      latestReason: recurringManual[0] ? recurringManual[0].reason : 'Nenhum alerta aberto.',
      latestCaseId: recurringManual[0] ? recurringManual[0].id : null,
    },
  };
}

function freeCashOf(bank, third) {
  const conciliated = toCents(bank.reconciled);
  const heldReconciled = toCents(third.held_reconciled);
  return {
    grossBankBalance: money(toCents(bank.gross)),
    conciliatedBankBalance: money(conciliated),
    thirdPartyHeld: money(toCents(third.held)),
    thirdPartyHeldConciliated: money(heldReconciled),
    thirdPartyHeldBasis: 'SETTLED',
    thirdPartyHeldLabel: 'Dinheiro de terceiros retido em caixa (realizado)',
    thirdPartyHeldDescription: 'Dinheiro de terceiro já recebido e ainda não devolvido, pelo ledger (cada recebimento uma vez, mesmo em baixas parciais). Difere do total em aberto, que é previsto.',
    basis: 'CONCILIATED',
    description: 'Caixa disponível = saldo das linhas do extrato já conciliadas menos o dinheiro de terceiros contido nelas (Caderno §19: saldos conciliados próprios).',
    value: money(conciliated - heldReconciled),
  };
}

function delinquencyOf(acc) {
  const side = (s) => ({ overdue: money(acc.overdue[s].cents), eligible: money(acc[s].cents), ratio: ratio(acc.overdue[s].cents, acc[s].cents) });
  return { receivable: side('receivable'), payable: side('payable') };
}

/**
 * getWeeklyHealthReport — fotografia da saúde financeira no momento da chamada (as janelas de N dias incluem hoje e vão até o
 * fim do N-ésimo dia, no calendário de São Paulo; vencido = vence antes de hoje).
 */
async function getWeeklyHealthReport(transaction, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const bounds = {
    startToday: startOfBusinessDay(now),
    horizon7: startOfBusinessDay(now, 8),
    horizon30: startOfBusinessDay(now, 31),
    horizon60: startOfBusinessDay(now, 61),
  };
  const weights = await readReceivableWeights({ companyId: options.companyId, groupId: options.groupId }, transaction);
  const acc = aggregateOpen(await sources.readOpenEntries(transaction), bounds, weights);

  const report = {
    generatedAt: now.toISOString(),
    sourceSnapshotAt: now.toISOString(),
    windowEndsAt: bounds.horizon7.toISOString(),
    basis: 'OPEN_BALANCE',
    receivableWeights: weights,
    payablePending: publicBucket(acc.payable, false),
    receivablePending: publicBucket(acc.receivable, true),
    overdue: { ...publicPair(acc.overdue), total: money(acc.overdue.payable.cents + acc.overdue.receivable.cents) },
    dueNextSevenDays: publicPair(acc.d7),
    // Caderno §19 "Contas/Recebíveis 7/30/60 dias": 30/60 são cumulativos (tudo que vence até ali).
    dueNext30Days: publicPair(acc.d30),
    dueNext60Days: publicPair(acc.d60),
    // F-11: PREVISTO (saldo em aberto de terceiro); o REALIZADO retido está em freeCash.thirdPartyHeld.
    thirdPartyFunds: {
      count: acc.third.count,
      total: money(acc.third.cents),
      basis: 'PENDING',
      label: 'Dinheiro de terceiros em aberto (previsto)',
      description: 'Saldo em aberto dos lançamentos de dinheiro de terceiro (cauções etc.). Não é o que já está retido em caixa.',
    },
  };
  report.projectedNetBalance = money(acc.receivable.cents - acc.payable.cents);

  // §19 "Inadimplência — vencidos/total elegível": recebíveis (quem deve à empresa) separados das contas a pagar em atraso.
  report.delinquency = delinquencyOf(acc);
  report.delinquencyRatio = report.delinquency.receivable.ratio;

  const pendingRec = await sources.readPendingReconciliations(transaction);
  report.pendingReconciliations = { count: Number(pendingRec.count || 0), total: money(toCents(pendingRec.total)), inflow: money(toCents(pendingRec.inflow)), outflow: money(toCents(pendingRec.outflow)) };

  const commissions = await sources.readProvisionedCommissions(transaction);
  report.provisionedCommissions = { count: Number(commissions.count || 0), total: money(toCents(commissions.total)) };

  const repasses = await sources.readPendingOwnerRepasses(transaction);
  report.pendingOwnerRepasses = {
    count: Number(repasses.count || 0),
    total: money(toCents(repasses.total)),
    approvedNotPaid: { count: Number(repasses.approved_count || 0), total: money(toCents(repasses.approved_total)) },
  };

  // §19 "Anomalias — casos HIGH/CRITICAL abertos" e §17 "Conciliação manual recorrente -> alerta gerencial".
  report.openHighRiskAnomalies = options.companyId ? await countOpenHighRiskAnomalies(options.companyId, transaction) : null;
  report.managementAlerts = await managementAlerts(options.companyId, transaction);

  report.freeCash = freeCashOf(await sources.readBankBalances(transaction), await sources.readThirdPartyHeld(transaction));

  report.marginBySector = (await sources.readMarginBySector(transaction)).map((row) => {
    const revenue = toCents(row.revenue);
    const costs = toCents(row.costs);
    return { resultCenterId: row.result_center_id || null, revenueRealized: money(revenue), costsAttributed: money(costs), margin: money(revenue - costs) };
  });

  // §19 "Necessidade para respirar = saídas obrigatórias próximas - caixa livre - entradas altamente prováveis": a pagar vencido
  // e em 7 dias (saldo em aberto), menos o caixa disponível, menos os recebíveis dos próximos 7 dias ponderados por status.
  const mandatoryOut = acc.overdue.payable.cents + acc.d7.payable.cents;
  const probableIn = acc.d7.receivable.weightedCents;
  report.breathingNeed = {
    value: money(mandatoryOut - toCents(report.freeCash.value) - probableIn),
    mandatoryOutflows: money(mandatoryOut),
    probableInflows: money(probableIn),
    excludesFreeCashBalance: false,
  };
  return report;
}

/**
 * countOverdueEntries — quantidade de contas próprias vencidas com saldo em aberto (PENDING ou PARTIALLY_SETTLED), para
 * alerta/monitoramento sem carregar o relatório inteiro.
 */
async function countOverdueEntries(transaction, now = new Date()) {
  const startToday = startOfBusinessDay(now);
  const open = await sources.readOpenEntries(transaction);
  return open.filter((e) => !e.is_third_party_funds && e.due_at && new Date(e.due_at) < startToday).length;
}

module.exports = { getWeeklyHealthReport, countOverdueEntries };
