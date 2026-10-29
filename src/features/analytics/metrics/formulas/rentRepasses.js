'use strict';

/**
 * M9-D642 — KPI rent.repasses (Repasses de locação), versão 1. Repasses ao proprietário (cancelados não entram). O valor é a POSIÇÃO no fim do dia-base: quantos repasses estão atrasados
 * (pendentes ou aprovados e não pagos, com data prevista anterior a hoje). Saem ainda os pagos no período (contagem e valor, do mês de São Paulo da data-base), os pendentes no prazo
 * (contagem e valor, data prevista de hoje em diante) e o % no prazo = repasses pagos até a data prevista ÷ repasses devidos no período (data prevista de 1º do mês até a data-base) × 100,
 * 2 casas, arredondado uma só vez (sem devidos no período, não há percentual). Dinheiro em decimal exato (centavos), nunca ponto flutuante. Entrada (rm_rental_repasses, linha do
 * dia-base): { row: { pending, paid, overdue, pendingCount, paidCount, overdueCount, dueCount, onTimeCount, withoutDueDate } | null }. Regra de qualidade: repasse sem data prevista -> DEGRADED;
 * retrato do dia ainda não calculado ou campo nulo -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded } = require('./_legalCorKpi');

const FIELDS = ['pending', 'paid', 'overdue', 'pendingCount', 'paidCount', 'overdueCount', 'dueCount', 'onTimeCount', 'withoutDueDate'];

function compute(input) {
  const row = input.row;
  if (!row || FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const withoutDueDate = money.count(row.withoutDueDate);
  if (money.cmp(withoutDueDate, 0) > 0) return degraded('REPASSE_SEM_DATA_PREVISTA', { withoutDueDate });
  const overdue = money.count(row.overdueCount);
  const due = money.count(row.dueCount);
  const onTime = money.count(row.onTimeCount);
  const details = {
    overdue, overdueAmount: money.money(row.overdue), paid: money.count(row.paidCount), paidAmount: money.money(row.paid),
    pendingOnTime: money.count(money.sub(row.pendingCount, row.overdueCount)), pendingOnTimeAmount: money.money(money.sub(row.pending, row.overdue)),
    due, onTime, onTimePct: money.cmp(due, 0) > 0 ? money.percent(onTime, due).value : null,
  };
  const dimensions = [
    { key: 'pagos_qtd', value: details.paid }, { key: 'pagos_brl', value: details.paidAmount }, { key: 'pendentes_no_prazo_qtd', value: details.pendingOnTime },
    { key: 'pendentes_no_prazo_brl', value: details.pendingOnTimeAmount }, { key: 'atrasados_brl', value: details.overdueAmount }, { key: 'devidos_qtd', value: due }, { key: 'no_prazo_qtd', value: onTime },
  ];
  if (details.onTimePct !== null) dimensions.push({ key: 'no_prazo_pct', value: details.onTimePct });
  return { value: overdue, status: 'OK', details, dimensions };
}

const row = (c = {}) => ({ pending: '0.00', paid: '0.00', overdue: '0.00', pendingCount: 0, paidCount: 0, overdueCount: 0, dueCount: 0, onTimeCount: 0, withoutDueDate: 0, ...c });
const okOf = (overdue, d) => ({
  value: overdue, status: 'OK', details: d,
  dimensions: [
    { key: 'pagos_qtd', value: d.paid }, { key: 'pagos_brl', value: d.paidAmount }, { key: 'pendentes_no_prazo_qtd', value: d.pendingOnTime }, { key: 'pendentes_no_prazo_brl', value: d.pendingOnTimeAmount },
    { key: 'atrasados_brl', value: d.overdueAmount }, { key: 'devidos_qtd', value: d.due }, { key: 'no_prazo_qtd', value: d.onTime }, ...(d.onTimePct === null ? [] : [{ key: 'no_prazo_pct', value: d.onTimePct }]),
  ],
});
const detail = (c) => ({ overdue: '0', overdueAmount: '0.00', paid: '0', paidAmount: '0.00', pendingOnTime: '0', pendingOnTimeAmount: '0.00', due: '0', onTime: '0', onTimePct: null, ...c });
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum repasse: zero atrasados e sem percentual', input: { row: row() }, expected: okOf('0', detail({})) },
  {
    kind: 'single', name: 'um repasse pago no prazo: 100,00%', input: { row: row({ paid: '1000.00', paidCount: 1, dueCount: 1, onTimeCount: 1 }) },
    expected: okOf('0', detail({ paid: '1', paidAmount: '1000.00', due: '1', onTime: '1', onTimePct: '100.00' })),
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 40 devidos, 37 no prazo dão 92,50% e 3 atrasados',
    input: { row: row({ pending: '2400.00', overdue: '900.00', pendingCount: 8, overdueCount: 3, paid: '18500.50', paidCount: 37, dueCount: 40, onTimeCount: 37 }) },
    expected: okOf('3', detail({ overdue: '3', overdueAmount: '900.00', paid: '37', paidAmount: '18500.50', pendingOnTime: '5', pendingOnTimeAmount: '1500.00', due: '40', onTime: '37', onTimePct: '92.50' })),
  },
  { kind: 'period_edge', name: 'repasse sem data prevista: DEGRADED e sem valor', input: { row: row({ pendingCount: 2, pending: '300.00', withoutDueDate: 1 }) }, expected: bad('REPASSE_SEM_DATA_PREVISTA', { withoutDueDate: '1' }) },
  { kind: 'period_edge', name: 'retrato do dia ainda não calculado: DEGRADED e sem valor', input: { row: row({ dueCount: null }) }, expected: bad('READ_MODEL_NAO_RECALCULADO', {}) },
  {
    kind: 'rounding', name: '2 de 3 no prazo dão 66,67% e centavos somam exatos (0,10 + 0,20 pagos = 0,30)', input: { row: row({ paid: '0.30', paidCount: 2, dueCount: 3, onTimeCount: 2 }) },
    expected: okOf('0', detail({ paid: '2', paidAmount: '0.30', due: '3', onTime: '2', onTimePct: '66.67' })),
  },
];

module.exports = { id: 'rent.repasses', version: 1, compute, testCases };
