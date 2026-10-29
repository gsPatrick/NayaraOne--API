'use strict';

/**
 * M9-D630 / M9-D631 — peças comuns das fórmulas dos KPIs do funil comercial: mensagem de dado incompleto, resultado sem valor (DEGRADED quando a
 * regra de qualidade falha, INCOMPLETE quando falta amostra), nome canônico de origem e comparação exata de percentual (sem arredondar antes).
 */
const money = require('./money');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';
const NO_ORIGIN = 'NAO_INFORMADA';
const NO_REASON = 'NAO_INFORMADO';
const NO_BROKER = '00000000-0000-0000-0000-000000000000';

/** Resultado sem valor: nunca um número enganoso. `status` é DEGRADED (regra de qualidade violada) ou INCOMPLETE (amostra insuficiente). */
const withoutValue = (status, reason, details = {}, dimensions = []) => ({ value: null, status, message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions });
const degraded = (reason, details, dimensions) => withoutValue('DEGRADED', reason, details, dimensions);
const incomplete = (reason, details, dimensions) => withoutValue('INCOMPLETE', reason, details, dimensions);

/** Origem sem diferença de caixa: "Site" e "SITE" são a mesma; vazia vira NAO_INFORMADA. */
const originKey = (text) => (String(text === undefined || text === null ? '' : text).trim().toUpperCase() || NO_ORIGIN);

/** parte/total acima de maxPct por cento? Compara em decimal exato (parte x 100 > limite x total), sem arredondar antes. */
const exceedsPct = (part, total, maxPct) => money.cmp(money.mul(part, 100), money.mul(maxPct, total)) > 0;

/** Soma de contagens em texto inteiro. */
const sumCounts = (list) => money.count(money.sum(list.map((v) => v || 0)));

/** Agrupa linhas por chave somando os campos numéricos; devolve Map(chave -> acumulado em texto). */
function groupSum(rows, keyOf, fieldOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    out.set(key, money.toString(money.add(out.get(key) || '0', fieldOf(row) || 0)));
  }
  return out;
}

/** Entradas [chave, valor] do Map em ordem de valor decrescente e, no empate, da chave. */
const byValueDesc = (map) => [...map.entries()].sort((a, b) => money.cmp(b[1], a[1]) || (a[0] < b[0] ? -1 : 1));

module.exports = { INCOMPLETE_MESSAGE, NO_ORIGIN, NO_REASON, NO_BROKER, degraded, incomplete, originKey, exceedsPct, sumCounts, groupSum, byValueDesc };
