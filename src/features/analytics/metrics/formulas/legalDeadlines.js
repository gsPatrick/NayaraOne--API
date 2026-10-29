'use strict';

/**
 * M9-D660 — KPI legal.deadlines (Prazos próximos e vencidos), versão 1. Posição no fim do dia-base: contagem de prazos abertos em três faixas
 * DISJUNTAS do calendário de São Paulo (as mesmas do rm_legal_deadlines): próximos 7 dias (hoje até hoje+6), até 30 dias (hoje+7 até hoje+29) e
 * vencidos (antes de hoje, com os dias do mais antigo). O valor é a soma das três faixas; o que vence de hoje+30 em diante só entra em
 * details.beyond30Days. Entrada: { next7, to29, overdue, oldestOverdueDays, openTotal, withoutDate }. Regra de qualidade: prazo sem data deixa o
 * KPI INCOMPLETE, sem valor, e pede alerta CRITICAL (details.alertSeverity). Contagens inteiras em decimal exato.
 */
const money = require('./money');
const { incomplete } = require('./_legalCorKpi');

function compute(input) {
  const withoutDate = money.count(input.withoutDate || 0);
  if (money.cmp(withoutDate, 0) > 0) return incomplete('PRAZO_SEM_DATA', { withoutDate, alertSeverity: 'CRITICAL' });
  const bands = [money.count(input.next7 || 0), money.count(input.to29 || 0), money.count(input.overdue || 0)];
  const total = money.count(money.sum(bands));
  const open = money.count(input.openTotal || 0);
  const oldest = input.oldestOverdueDays === null || input.oldestOverdueDays === undefined ? null : money.count(input.oldestOverdueDays);
  const dimensions = [{ key: 'proximos_7d_qtd', value: bands[0] }, { key: 'ate_30d_qtd', value: bands[1] }, { key: 'vencidos_qtd', value: bands[2] }];
  if (oldest !== null) dimensions.push({ key: 'mais_antigo_vencido_dias', value: oldest });
  const beyond = money.count(money.sub(open, total));
  return { value: total, status: 'OK', details: { next7Days: bands[0], upTo30Days: bands[1], overdue: bands[2], oldestOverdueDays: oldest, openTotal: open, beyond30Days: beyond }, dimensions };
}

const base = { next7: 0, to29: 0, overdue: 0, oldestOverdueDays: null, openTotal: 0, withoutDate: 0 };
const okOf = (value, d, dims) => ({ value, status: 'OK', details: d, dimensions: dims });
const dims = (a, b, c, oldest) => [{ key: 'proximos_7d_qtd', value: a }, { key: 'ate_30d_qtd', value: b }, { key: 'vencidos_qtd', value: c }, ...(oldest ? [{ key: 'mais_antigo_vencido_dias', value: oldest }] : [])];
const det = (a, b, c, oldest, open, beyond) => ({ next7Days: a, upTo30Days: b, overdue: c, oldestOverdueDays: oldest, openTotal: open, beyond30Days: beyond });

const testCases = [
  { kind: 'empty', name: 'nenhum prazo aberto: zero em todas as faixas', input: base, expected: okOf('0', det('0', '0', '0', null, '0', '0'), dims('0', '0', '0', null)) },
  { kind: 'single', name: 'um prazo vencido há 3 dias', input: { ...base, overdue: 1, oldestOverdueDays: 3, openTotal: 1 }, expected: okOf('1', det('0', '0', '1', '3', '1', '0'), dims('0', '0', '1', '3')) },
  {
    kind: 'typical', name: 'exemplo da demanda: 7 prazos nos próximos 7 dias e 2 vencidos', input: { ...base, next7: 7, to29: 4, overdue: 2, oldestOverdueDays: 11, openTotal: 13 },
    expected: okOf('13', det('7', '4', '2', '11', '13', '0'), dims('7', '4', '2', '11')),
  },
  {
    kind: 'period_edge', name: 'prazo de hoje+30 em diante fica fora das faixas e só conta no total de abertos', input: { ...base, next7: 1, to29: 1, openTotal: 5 },
    expected: okOf('2', det('1', '1', '0', null, '5', '3'), dims('1', '1', '0', null)),
  },
  {
    kind: 'rounding', name: 'contagens grandes somam exatas (sem ponto flutuante)', input: { ...base, next7: '9007199254740993', to29: 1, openTotal: '9007199254740994' },
    expected: okOf('9007199254740994', det('9007199254740993', '1', '0', null, '9007199254740994', '0'), dims('9007199254740993', '1', '0', null)),
  },
  {
    kind: 'period_edge', name: 'prazo sem data: INCOMPLETE, sem valor e com alerta CRITICAL', input: { ...base, next7: 3, openTotal: 4, withoutDate: 1 },
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PRAZO_SEM_DATA', withoutDate: '1', alertSeverity: 'CRITICAL' }, dimensions: [] },
  },
];

module.exports = { id: 'legal.deadlines', version: 1, compute, testCases };
