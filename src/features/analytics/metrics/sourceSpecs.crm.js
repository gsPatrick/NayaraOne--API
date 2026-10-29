'use strict';

/**
 * M9-D630 / M9-D611 — origem dos números dos KPIs do funil comercial: quais registros do CRM reproduzem cada KPI (a tabela de origem é
 * crm.opportunities; a primeira resposta vem de crm.messages). O
 * filtro (período em instantes de São Paulo, início inclusivo e fim exclusivo, e os marcadores da janela) é montado e assinado por crm.entries.
 * O detalhe de cada KPI (drill-down, M9-D690) abre as oportunidades do filtro; só o CRM e o BI conferem a permissão.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const OPPORTUNITIES = {
  type: 'OPPORTUNITIES', table: 'crm.opportunities',
  columns: { equals: { deletedAt: 'deleted_at', origin: 'lead_source', brokerId: 'owner_user_id' } },
};
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `${f.period && f.period.from ? `de ${day(f.period.from)} ` : ''}antes de ${f.period ? day(f.period.to) : 'hoje'}`;

const SPECS = [
  { ...OPPORTUNITIES, metricCode: 'crm.leads_by_origin', columns: { ...OPPORTUNITIES.columns, period: 'created_at' }, describe: (f) => `Oportunidades (leads) criadas ${span(f)}, sem as excluídas` },
  { ...OPPORTUNITIES, metricCode: 'crm.first_response_time', columns: { ...OPPORTUNITIES.columns, period: 'created_at' }, describe: (f) => `Oportunidades (leads) criadas ${span(f)}; a média usa a primeira mensagem de saída de um usuário de cada uma` },
];

const DETAIL_COLUMNS = ['lead_source', 'owner_user_id', 'created_at'];
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, { columns: DETAIL_COLUMNS, link: '/painel/crm' });
}

module.exports = { CRM_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
