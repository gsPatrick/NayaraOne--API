'use strict';

/**
 * M9-D633 — entrada de cada fórmula dos três KPIs de Radar, captação e conversão por corretor a partir das linhas dos read models (commercial.rows.*).
 * Mapeamento puro (sem banco). Os limites do administrador (settings) entram em PARAMS; o instante de fonte de cada KPI, em SNAPSHOT_KEY.
 */
const INPUTS = Object.freeze({
  'radar.matches': (rows) => ({
    matches: rows.radar.matches, sent: rows.radar.sent, converted: rows.radar.converted, invalid: rows.radar.invalid, byOrigin: rows.radar.byOrigin, byBroker: rows.radar.byBroker,
  }),
  'crm.broker_capture': (rows) => ({ rows: rows.brokers.map((r) => ({ brokerId: r.brokerId, captured: r.captured, withValue: r.withValue, valueSum: r.valueSum })) }),
  'crm.broker_conversion': (rows) => ({ rows: rows.brokers.map((r) => ({ brokerId: r.brokerId, won: r.won, lost: r.lost })) }),
});

const PARAMS = Object.freeze({
  'radar.matches': () => ({}),
  'crm.broker_capture': (settings) => ({ maxNoBrokerPct: settings.maxNoBrokerPct }),
  'crm.broker_conversion': (settings) => ({ minSample: settings.minSample }),
});

const SNAPSHOT_KEY = Object.freeze({ 'radar.matches': 'radar', 'crm.broker_capture': 'brokers', 'crm.broker_conversion': 'brokers' });

module.exports = { INPUTS, PARAMS, SNAPSHOT_KEY, POSITION_CODES: [] };
