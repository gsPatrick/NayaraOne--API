'use strict';

/**
 * M9-D632 — entrada de cada fórmula dos cinco KPIs de visitas, propostas, imóveis e preços a partir das linhas dos read models (commercial.rows.*).
 * Mapeamento puro (sem banco). O instante de fonte de cada KPI fica em SNAPSHOT_KEY; os KPIs de imóveis (posição) só valem para hoje (POSITION_CODES).
 */
const { NO_DATE } = require('../../read-models/comercial-imoveis/portfolio');

const AVAILABLE = 'AVAILABLE';
const NO_STATUS = 'SEM_STATUS';
const POSITION_CODES = Object.freeze(['prop.active_properties', 'prop.without_sale_by_period']);

const total = (rows, field) => rows.reduce((acc, r) => acc + Number(r[field] || 0), 0);

function activeProperties(rows) {
  const available = rows.filter((r) => r.status === AVAILABLE);
  const byType = {};
  for (const r of available) for (const [type, n] of Object.entries(r.byType || {})) byType[type] = (byType[type] || 0) + Number(n);
  return {
    total: total(available, 'active'), sale: total(available, 'sale'), rent: total(available, 'rent'), withoutStatus: total(rows.filter((r) => r.status === NO_STATUS), 'active'), byType,
  };
}

/** Faixas na ordem dos limites do administrador (rótulo sem linha = zero); só imóveis publicados com oferta de venda ativa. */
function withoutSale(rows, labels) {
  const available = rows.filter((r) => r.status === AVAILABLE);
  const countOf = (label) => total(available.filter((r) => r.bucket === label), 'salePublished');
  return { bands: labels.map((label) => ({ label, count: countOf(label) })), noDate: countOf(NO_DATE) };
}

const INPUTS = Object.freeze({
  'crm.visits': (rows) => ({ scheduled: rows.visits.scheduled, done: rows.visits.done, withoutBroker: rows.visits.visitsNoBroker, byBroker: rows.visits.visitsByBroker }),
  'crm.proposals': (rows) => ({
    sent: rows.visits.sent, accepted: rows.visits.accepted, rejected: rows.visits.rejected, expired: rows.visits.expired, open: rows.visits.open, valueSent: rows.visits.valueSent,
    withoutValue: rows.visits.noValue, byBroker: rows.visits.proposalsByBroker,
  }),
  'prop.active_properties': (rows) => activeProperties(rows.portfolio),
  'prop.without_sale_by_period': (rows, ctx) => withoutSale(rows.portfolio, ctx.bandLabels),
  'prop.price_changes': (rows) => ({ changes: rows.prices.changes, withPrior: rows.prices.withPrior, pctSum: rows.prices.pctSum, byBroker: rows.prices.byBroker }),
});

const PARAMS = Object.freeze({
  'crm.visits': () => ({}), 'crm.proposals': () => ({}), 'prop.active_properties': () => ({}), 'prop.without_sale_by_period': () => ({}), 'prop.price_changes': () => ({}),
});

/** Qual instante de fonte (rows.snapshotAt) vale para cada KPI. */
const SNAPSHOT_KEY = Object.freeze({
  'crm.visits': 'visits', 'crm.proposals': 'visits', 'prop.active_properties': 'portfolio', 'prop.without_sale_by_period': 'portfolio', 'prop.price_changes': 'prices',
});

module.exports = { INPUTS, PARAMS, SNAPSHOT_KEY, POSITION_CODES };
