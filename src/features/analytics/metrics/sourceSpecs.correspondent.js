'use strict';

/**
 * M9-D661 / M9-D611 / M9-D690 — origem dos números dos KPIs do Correspondente: quais registros do módulo reproduzem cada KPI (casos de
 * financiamento, a primeira decisão de cada caso no histórico do provider e os direitos de comissão). O filtro (assinado) é montado por cor.filters.
 * O detalhe de cada KPI (drill-down) abre os registros do filtro e só devolve ids a quem tem analytics:drilldown e correspondent:read; nada de
 * solicitante, imóvel nem documentos nas colunas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

/** Decisão = o primeiro registro aplicado APPROVED ou REJECTED do caso (a mesma regra do read model: um caso decide uma vez, no primeiro desfecho). */
const firstDecisionPredicate = () => ({
  sql: `t."id" = (SELECT h.id FROM correspondent.provider_status_history h WHERE h.company_id = t."company_id" AND h.financing_case_id = t."financing_case_id"
         AND h.applied AND h.normalized_status IN ('APPROVED', 'REJECTED') ORDER BY h.occurred_at, h.id LIMIT 1)`,
  replacements: {},
});

const DECISIONS = {
  type: 'PROVIDER_DECISIONS', table: 'correspondent.provider_status_history', predicates: [firstDecisionPredicate],
  columns: { period: 'occurred_at', status: 'normalized_status', equals: { applied: 'applied' } },
};
const span = (f) => `de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}`;

const SPECS = [
  { metricCode: 'cor.cases_by_stage', type: 'FINANCING_CASES', table: 'correspondent.financing_cases', columns: { status: 'status' }, describe: () => 'Casos de financiamento da empresa em qualquer estágio' },
  { ...DECISIONS, metricCode: 'cor.approval_rate_by_provider', describe: (f) => `Decisões (aprovada ou rejeitada) dos casos de financiamento ${span(f)}, uma por caso` },
  { ...DECISIONS, metricCode: 'cor.analysis_time', describe: (f) => `Decisões dos casos de financiamento ${span(f)}; a média usa os dias entre o envio ao provider e a decisão` },
  {
    metricCode: 'cor.commission', type: 'COMMISSION_ENTITLEMENTS', table: 'correspondent.commission_entitlements', valueColumn: 'amount', columns: { status: 'status' },
    describe: () => 'Comissões do correspondente esperadas (direito registrado e ainda não confirmado pelo provider)',
  },
];

const DETAIL = {
  'cor.cases_by_stage': { columns: ['provider_code', 'product', 'updated_at'], link: '/painel/correspondente/{id}' },
  'cor.approval_rate_by_provider': { columns: ['financing_case_id', 'occurred_at'], link: '/painel/correspondente/{id}' },
  'cor.analysis_time': { columns: ['financing_case_id', 'occurred_at'], link: '/painel/correspondente/{id}' },
  'cor.commission': { columns: ['provider_code', 'financing_case_id', 'created_at'], link: '/painel/correspondente' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { COR_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
