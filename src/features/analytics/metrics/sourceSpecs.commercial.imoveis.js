'use strict';

/**
 * M9-D632 / M9-D611 — origem dos números dos cinco KPIs de visitas, propostas, imóveis e preços: quais registros do CRM e do cadastro de imóveis
 * reproduzem cada KPI. O filtro (período em instantes de São Paulo, início inclusivo e fim exclusivo) é montado e assinado por commercial.entries; as
 * condições que não variam (visita cancelada, imóvel inativo, oferta de venda ativa) são fixas aqui (`predicates`). O detalhe de cada KPI
 * (drill-down, M9-D690) abre os registros do filtro; só o CRM/Imóveis e o BI conferem a permissão.
 */
const { day, span, fixed, LIVE, PROPERTIES, registerAll } = require('./sourceSpecs.commercial.common');

const ACTIVE_AD = `t."availability_status" = 'AVAILABLE' AND COALESCE(t."publication_status", '') <> 'INACTIVE'`;
const SALE_OFFER = `EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.property_id = t.id AND o.company_id = t.company_id AND o.deleted_at IS NULL AND o.status = 'ACTIVE' AND o.offer_type = 'SALE')`;

const SPECS = [
  {
    type: 'VISITS', table: 'crm.visits', metricCode: 'crm.visits', columns: { period: 'scheduled_at', equals: LIVE }, predicates: [fixed(`t."status" <> 'CANCELED'`)],
    describe: (f) => `Visitas agendadas (fora as canceladas) com data ${span(f)}, sem as excluídas`,
  },
  { type: 'PROPOSALS', table: 'crm.proposals', metricCode: 'crm.proposals', columns: { period: 'sent_at', equals: LIVE }, describe: (f) => `Propostas enviadas ${span(f)}, sem as excluídas` },
  { ...PROPERTIES, metricCode: 'prop.active_properties', columns: { equals: LIVE }, predicates: [fixed(ACTIVE_AD)], describe: () => 'Imóveis disponíveis (não excluídos nem inativos na publicação)' },
  {
    ...PROPERTIES, metricCode: 'prop.without_sale_by_period', columns: { period: 'published_at', equals: LIVE }, predicates: [fixed(`${ACTIVE_AD} AND t."publication_status" = 'PUBLISHED' AND ${SALE_OFFER}`)],
    describe: (f) => `Imóveis disponíveis, publicados e com oferta de venda ativa, com data de publicação ${f.period && f.period.to ? `antes de ${day(f.period.to)}` : 'conhecida'}`,
  },
  { type: 'PRICE_CHANGES', table: 'real_estate.property_price_history', metricCode: 'prop.price_changes', columns: { period: 'changed_at' }, describe: (f) => `Mudanças de preço de oferta ${span(f)}` },
];

const DETAILS = {
  'crm.visits': { columns: ['status', 'agent_user_id', 'property_id'], link: '/painel/crm' },
  'crm.proposals': { columns: ['status', 'value', 'decided_at', 'opportunity_id', 'property_id'], link: '/painel/crm/propostas' },
  'prop.active_properties': { columns: ['availability_status', 'publication_status', 'property_type'], link: '/painel/imoveis/{id}' },
  'prop.without_sale_by_period': { columns: ['availability_status', 'publication_status', 'published_at', 'property_type', 'created_by'], link: '/painel/imoveis/{id}' },
  'prop.price_changes': { columns: ['old_price', 'new_price', 'reason_code', 'changed_by'], link: '/painel/imoveis' },
};

module.exports = { IMOVEIS_SOURCE_CODES: registerAll(SPECS, DETAILS) };
