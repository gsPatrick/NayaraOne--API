'use strict';

/**
 * M9-D633 / M9-D611 — origem dos números dos três KPIs de Radar, captação e conversão por corretor: os eventos radar.matched do outbox, os imóveis
 * cadastrados e as oportunidades ganhas e perdidas. O filtro (período em instantes de São Paulo, início inclusivo e fim exclusivo) é montado e assinado
 * por commercial.entries. A conversão por corretor é percentual (modo RECOMPUTE): o detalhe refaz a fórmula sobre as oportunidades do filtro. O
 * detalhe de cada KPI (drill-down, M9-D690) abre os registros do filtro; só o CRM/Imóveis e o BI conferem a permissão.
 */
const { span, LIVE, PROPERTIES, registerAll } = require('./sourceSpecs.commercial.common');

const SPECS = [
  {
    type: 'OUTBOX_EVENTS', table: 'integration.outbox_events', metricCode: 'radar.matches', columns: { period: 'occurred_at', equals: { eventType: 'event_type' } },
    describe: (f) => `Cruzamentos do Radar (evento radar.matched) ${span(f)}`,
  },
  { ...PROPERTIES, metricCode: 'crm.broker_capture', columns: { period: 'created_at', equals: LIVE }, describe: (f) => `Imóveis cadastrados (captados) ${span(f)}, sem os excluídos` },
  {
    type: 'OPPORTUNITIES', table: 'crm.opportunities', metricCode: 'crm.broker_conversion', columns: { status: 'stage', period: 'closed_at', equals: LIVE },
    formulaId: 'crm.broker_conversion', rowColumns: ['stage', 'owner_user_id'], formulaParams: { minSample: 1 },
    describe: (f) => `Oportunidades ganhas e perdidas (fora a desistência) fechadas ${span(f)}`,
  },
];

const DETAILS = {
  'radar.matches': { columns: ['aggregate_id', 'status'], link: '/painel/radar' },
  'crm.broker_capture': { columns: ['property_type', 'created_by'], link: '/painel/imoveis/{id}' },
  'crm.broker_conversion': { columns: ['stage', 'owner_user_id'], link: '/painel/crm' },
};

module.exports = { CORRETORES_SOURCE_CODES: registerAll(SPECS, DETAILS) };
