'use strict';

/**
 * M9-D632 / M9-D633 — peças comuns das fórmulas dos KPIs de visitas, propostas, imóveis, Radar e corretores: mensagem de dado incompleto,
 * resultado sem valor (DEGRADED quando a regra de qualidade falha, INCOMPLETE quando falta amostra ou base), contagem inteira em texto e as
 * dimensões por corretor (chave `corretor:<id>:<medida>`, em ordem de id, para o snapshot ser repetível).
 */
const money = require('./money');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';
const NO_BROKER = '00000000-0000-0000-0000-000000000000';

/** Resultado sem valor: nunca um número enganoso; os detalhes e as dimensões que continuam verdadeiros seguem junto. */
const withoutValue = (status, reason, details = {}, dimensions = []) => ({ value: null, status, message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions });
const degraded = (reason, details, dimensions) => withoutValue('DEGRADED', reason, details, dimensions);
const incomplete = (reason, details, dimensions) => withoutValue('INCOMPLETE', reason, details, dimensions);

/** Contagem inteira em texto; vazio, nulo e texto numérico viram "0" ou o inteiro. */
const count = (value) => money.count(value === undefined || value === null || value === '' ? 0 : value);
const sumCounts = (list) => money.count(money.sum(list.map((v) => (v === undefined || v === null || v === '' ? 0 : v))));

/**
 * Dimensões por corretor a partir de { idDoCorretor: contagem } (uma medida) ou { idDoCorretor: { chave: contagem } } (várias):
 * `measures` mapeia a chave do objeto para o nome da medida na dimensão.
 */
function brokerDimensions(byBroker, measures) {
  const out = [];
  for (const id of Object.keys(byBroker || {}).sort()) {
    const entry = byBroker[id];
    if (typeof measures === 'string') out.push({ key: `corretor:${id}:${measures}`, value: count(entry) });
    else for (const [field, name] of Object.entries(measures)) out.push({ key: `corretor:${id}:${name}`, value: count((entry || {})[field]) });
  }
  return out;
}

/** Dimensões `<prefixo>:<chave>` a partir de { chave: contagem }, em ordem de chave. */
const keyedDimensions = (prefix, counts) => Object.keys(counts || {}).sort().map((k) => ({ key: `${prefix}:${k}`, value: count(counts[k]) }));

module.exports = { INCOMPLETE_MESSAGE, NO_BROKER, degraded, incomplete, count, sumCounts, brokerDimensions, keyedDimensions };
