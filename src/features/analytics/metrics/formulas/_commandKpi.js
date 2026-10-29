'use strict';

/**
 * M9-D710 — peças comuns das fórmulas dos fatos do dia do Centro de Comando (contratos assinados, oportunidades ganhas, pagamentos liquidados relevantes): soma exata de contagens e
 * de valores em BRL (arredondamento único no fim, M9-D605), agrupamento estável por dimensão e o resultado de dado incompleto. Entrada comum: linhas já somadas no banco por
 * dimensão ({ count, amount, ... }), o total da janela imediatamente anterior ({ count, amount }) e `undated` (fatos sem data, que tornam o número não confiável).
 */
const money = require('./money');
const { incomplete, byText } = require('./_legalCorKpi');

const ZERO = Object.freeze({ count: '0', amount: '0.00' });

/** { count, amount } da lista de linhas (contagem inteira exata; valor com duas casas, arredondado uma só vez). */
function totalsOf(rows) {
  return { count: money.count(money.sum(rows.map((r) => r.count || 0))), amount: money.money(money.sum(rows.map((r) => r.amount || 0))) };
}

/** Total anterior normalizado (ausente = zero). */
const previousOf = (previous) => (previous ? { count: money.count(previous.count || 0), amount: money.money(previous.amount || 0) } : ZERO);

/** Agrupa as linhas pelo texto de `keyOf` e devolve [{ key, count, amount }] em ordem de chave. */
function groupBy(rows, keyOf) {
  const keys = [...new Set(rows.map(keyOf))].sort(byText);
  return keys.map((key) => ({ key, ...totalsOf(rows.filter((r) => keyOf(r) === key)) }));
}

/** Dimensões de um agrupamento: `<prefixo>:<chave>:qtd` e `<prefixo>:<chave>:valor_brl`. */
const dimensionsOf = (prefix, groups) => groups.flatMap((g) => [{ key: `${prefix}:${g.key}:qtd`, value: g.count }, { key: `${prefix}:${g.key}:valor_brl`, value: g.amount }]);

/** Dimensões do total e da janela anterior. */
const windowDimensions = (total, previous) => [
  { key: 'valor_brl', value: total.amount }, { key: 'anterior_qtd', value: previous.count }, { key: 'anterior_valor_brl', value: previous.amount },
];

const undatedResult = (reason, undated) => incomplete(reason, { undated: money.count(undated) });
const hasUndated = (input) => money.cmp(input.undated || 0, 0) > 0;

module.exports = { totalsOf, previousOf, groupBy, dimensionsOf, windowDimensions, undatedResult, hasUndated };
