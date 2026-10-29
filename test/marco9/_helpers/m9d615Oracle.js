'use strict';

// Apoio da M9-D615: cálculo INDEPENDENTE (JavaScript puro sobre as linhas do ledger) dos números do read model, para conferir o SQL do
// worker. Usa a aritmética decimal exata do BI (sem ponto flutuante) e a mesma regra de calendário (vencimento por data de São Paulo).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { startOfBusinessDay } = require('../../../src/utils/businessDate');

const D = (v) => new Date(v).getTime();
const sum = (rows) => money.money(money.sum(rows.map((r) => r.amount)));
const net = (rows) => money.money(money.sub(sum(rows.filter((r) => r.nature === 'RECEIVABLE')), sum(rows.filter((r) => r.nature === 'PAYABLE'))));

/** rows = linhas de finance.financial_entries da empresa; asOf = 'AAAA-MM-DD'; windowDays = janela da inadimplência. */
function expectedFromLedger(rows, asOf, windowDays) {
  const base = new Date(`${asOf}T12:00:00-03:00`);
  const at = (n) => startOfBusinessDay(base, n).getTime();
  const live = rows.filter((r) => !r.reversal_of_entry_id);
  const own = live.filter((r) => !r.is_third_party_funds);
  const third = live.filter((r) => r.is_third_party_funds);
  const settled = (list) => list.filter((r) => r.status === 'SETTLED' && r.settled_at && D(r.settled_at) < at(1));
  const pending = (list, nature) => list.filter((r) => r.status === 'PENDING' && r.nature === nature);
  const due = (list, from, to) => list.filter((r) => r.due_at && (from === null || D(r.due_at) >= from) && D(r.due_at) < to);
  const out = { free_cash: net(settled(own)), third_party_cash: net(settled(third)) };
  for (const n of [7, 30, 60]) {
    out[`payables_${n}d`] = sum(due(pending(own, 'PAYABLE'), at(0), at(n)));
    out[`receivables_${n}d`] = sum(due(pending(own, 'RECEIVABLE'), at(0), at(n)));
  }
  const winStart = at(-(windowDays - 1));
  out.overdue_payables = sum(due(pending(own, 'PAYABLE'), null, at(0)));
  out.overdue_amount = sum(due(pending(own, 'RECEIVABLE'), null, at(0)));
  out.overdue_amount_in_window_90d = sum(due(pending(own, 'RECEIVABLE'), winStart, at(0)));
  out.overdue_amount_outside_window_90d = sum(due(pending(own, 'RECEIVABLE'), null, winStart));
  out.receivables_base_90d = sum(due(own.filter((r) => r.nature === 'RECEIVABLE' && !['REVERSED', 'CANCELLED'].includes(r.status)), winStart, at(1)));
  out.entries_without_due_date = own.filter((r) => r.status === 'PENDING' && ['PAYABLE', 'RECEIVABLE'].includes(r.nature) && !r.due_at).length;
  return out;
}

module.exports = { expectedFromLedger, money };
