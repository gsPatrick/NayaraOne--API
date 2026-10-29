'use strict';

/**
 * M9-D710 — KPI fin.payments_settled_relevant (Pagamentos liquidados acima do valor relevante), versão 1. Contagem e soma (BRL) das saídas liquidadas na janela móvel
 * (analytics.centro.janela_horas) com valor igual ou acima de analytics.centro.valor_relevante (inclusivo; o filtro do limiar é feito no banco com a mesma regra). Estornadas somam zero (original
 * + compensatória); dinheiro de terceiros nunca soma ao próprio: aparece à parte em terceiros_qtd e terceiros_valor_brl. Entrada (rm_command_events, kind PAYMENT_SETTLED): { rows:
 * [{ account, thirdParty, count, amount }], previous: { count, amount }, undated }. Regra de qualidade: liquidação sem data (settledAt) -> INCOMPLETE, valor nulo.
 */
const { totalsOf, previousOf, groupBy, dimensionsOf, windowDimensions, undatedResult, hasUndated } = require('./_commandKpi');

function compute(input) {
  if (hasUndated(input)) return undatedResult('LIQUIDACAO_SEM_DATA', input.undated);
  const rows = input.rows || [];
  const own = rows.filter((r) => !r.thirdParty);
  const third = totalsOf(rows.filter((r) => r.thirdParty));
  const total = totalsOf(own);
  const previous = previousOf(input.previous);
  const byAccount = groupBy(own, (r) => r.account || 'SEM_CONTA');
  return {
    value: total.count, status: 'OK',
    details: { count: total.count, amount: total.amount, previous, thirdParty: third, byAccount: byAccount.map((g) => ({ account: g.key, count: g.count, amount: g.amount })) },
    dimensions: [...windowDimensions(total, previous), { key: 'terceiros_qtd', value: third.count }, { key: 'terceiros_valor_brl', value: third.amount }, ...dimensionsOf('conta', byAccount)],
  };
}

const row = (account, count, amount, thirdParty = false) => ({ account, thirdParty, count, amount });
const none = { count: '0', amount: '0.00' };
const okOf = (count, amount, previous, third, byAccount) => ({
  value: count, status: 'OK', details: { count, amount, previous, thirdParty: third, byAccount },
  dimensions: [{ key: 'valor_brl', value: amount }, { key: 'anterior_qtd', value: previous.count }, { key: 'anterior_valor_brl', value: previous.amount }, { key: 'terceiros_qtd', value: third.count }, { key: 'terceiros_valor_brl', value: third.amount },
    ...byAccount.flatMap((g) => [{ key: `conta:${g.account}:qtd`, value: g.count }, { key: `conta:${g.account}:valor_brl`, value: g.amount }])],
});

const testCases = [
  { kind: 'empty', name: 'nenhum pagamento relevante: zero', input: { rows: [], previous: none, undated: 0 }, expected: okOf('0', '0.00', none, none, []) },
  { kind: 'single', name: 'um pagamento relevante', input: { rows: [row('a1', 1, '10000.00')], previous: none, undated: 0 }, expected: okOf('1', '10000.00', none, none, [{ account: 'a1', count: '1', amount: '10000.00' }]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 10.000,00 e 25.000,00 (o de 9.999,99 já ficou de fora no banco) = 2 e 35.000,00',
    input: { rows: [row('a1', 1, '10000.00'), row('a2', 1, '25000.00')], previous: { count: 1, amount: '50000.00' }, undated: 0 },
    expected: okOf('2', '35000.00', { count: '1', amount: '50000.00' }, none, [{ account: 'a1', count: '1', amount: '10000.00' }, { account: 'a2', count: '1', amount: '25000.00' }]),
  },
  {
    kind: 'period_edge', name: 'dinheiro de terceiros fica à parte e estornado soma zero', input: { rows: [row('a1', 0, '0.00'), row('a1', 1, '12000.00', true)], previous: none, undated: 0 },
    expected: okOf('0', '0.00', none, { count: '1', amount: '12000.00' }, [{ account: 'a1', count: '0', amount: '0.00' }]),
  },
  {
    kind: 'rounding', name: 'valores com mais de duas casas arredondam uma só vez, meio para cima', input: { rows: [row('a1', 1, '10000.005')], previous: none, undated: 0 },
    expected: okOf('1', '10000.01', none, none, [{ account: 'a1', count: '1', amount: '10000.01' }]),
  },
  { kind: 'period_edge', name: 'liquidação sem data: INCOMPLETE e sem valor', input: { rows: [], previous: none, undated: 1 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'LIQUIDACAO_SEM_DATA', undated: '1' }, dimensions: [] } },
];

module.exports = { id: 'fin.payments_settled_relevant', version: 1, compute, testCases };
