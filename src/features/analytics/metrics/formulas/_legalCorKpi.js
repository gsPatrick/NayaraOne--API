'use strict';

/**
 * M9-D660 / M9-D661 — peças comuns das fórmulas dos KPIs do Jurídico e do Correspondente: mensagem de dado incompleto, resultado sem valor
 * (DEGRADED quando a regra de qualidade falha, INCOMPLETE quando falta dado ou amostra), comparação exata de percentual e ordenação estável.
 */
const money = require('./money');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';
const NO_RISK = 'SEM_CLASSIFICACAO'; // processo sem nível de risco (rm_legal_cases_risk)
const ALL_TYPES = 'TODOS'; // linha da empresa inteira em rm_legal_missing_docs

/** Resultado sem valor: nunca um número enganoso. */
const withoutValue = (status, reason, details = {}) => ({ value: null, status, message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions: [] });
const degraded = (reason, details) => withoutValue('DEGRADED', reason, details);
const incomplete = (reason, details) => withoutValue('INCOMPLETE', reason, details);

/** parte/total acima de maxPct por cento? Compara em decimal exato (parte x 100 > limite x total), sem arredondar antes. */
const exceedsPct = (part, total, maxPct) => money.cmp(money.mul(part, 100), money.mul(maxPct, total)) > 0;

const sumCounts = (list) => money.count(money.sum(list.map((v) => v || 0)));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Agrupa linhas por chave somando um campo inteiro; devolve Map(chave -> texto inteiro) na ordem de chegada. */
function groupCount(rows, keyOf, fieldOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    out.set(key, money.count(money.add(out.get(key) || '0', fieldOf(row) || 0)));
  }
  return out;
}

/** Entradas [chave, valor] ordenadas por valor decrescente e, no empate, pela chave. */
const byValueDesc = (map) => [...map.entries()].sort((a, b) => money.cmp(b[1], a[1]) || byText(a[0], b[0]));

module.exports = { INCOMPLETE_MESSAGE, NO_RISK, ALL_TYPES, degraded, incomplete, exceedsPct, sumCounts, groupCount, byValueDesc, byText };
