'use strict';

/**
 * M9-D630 / M9-D631 / M9-D611 — origem dos números dos KPIs do funil comercial: quais registros do CRM reproduzem cada KPI (a tabela de origem é
 * crm.opportunities; a primeira resposta vem de crm.messages e a tarefa da próxima ação de core.tasks, dentro das condições fixas abaixo). O
 * filtro (período em instantes de São Paulo, início inclusivo e fim exclusivo, e os marcadores da janela) é montado e assinado por crm.entries.
 * O detalhe de cada KPI (drill-down, M9-D690) abre as oportunidades do filtro; só o CRM e o BI conferem a permissão.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const OPPORTUNITIES = {
  type: 'OPPORTUNITIES', table: 'crm.opportunities',
  columns: { equals: { deletedAt: 'deleted_at', origin: 'lead_source', brokerId: 'owner_user_id' } },
};
const CLOSED_STAGES = ['WON', 'LOST', 'WITHDRAWN']; // CLOSED_LIKE_STAGES de crm/dashboard.service.js
const TASK_ENTITY = 'crm.opportunities';
const TASK_CLOSED = ['DONE', 'CANCELED'];
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `${f.period && f.period.from ? `de ${day(f.period.from)} ` : ''}antes de ${f.period ? day(f.period.to) : 'hoje'}`;

/** Em aberto (fora dos estágios terminais) mais os terminais fechados na janela [crmClosedFrom, crmClosedTo) (limites vazios = sem limite). */
const stagePredicate = (filter) => ({
  sql: '(t."stage" NOT IN (:crmClosedStages) OR (t."closed_at" >= :crmClosedFrom AND t."closed_at" < :crmClosedTo))',
  replacements: { crmClosedStages: CLOSED_STAGES, crmClosedFrom: (filter.equals || {}).crmClosedFrom || '1970-01-01T00:00:00.000Z', crmClosedTo: (filter.equals || {}).crmClosedTo || '2999-01-01T00:00:00.000Z' },
});

/** Em aberto sem próxima ação válida: sem texto e data da próxima ação e sem tarefa aberta com vencimento a partir de crmTaskDueFrom. */
const withoutNextActionPredicate = (filter) => ({
  sql: `(t."stage" NOT IN (:crmClosedStages)
    AND NOT ((NULLIF(btrim(COALESCE(t."next_action", '')), '') IS NOT NULL AND t."next_action_due_at" IS NOT NULL)
      OR EXISTS (SELECT 1 FROM core.tasks k WHERE k.company_id = t.company_id AND k.related_entity_type = '${TASK_ENTITY}' AND k.related_entity_id = t.id AND k.deleted_at IS NULL
        AND k.status NOT IN (:crmTaskClosed) AND k.due_at >= :crmTaskDueFrom)))`,
  replacements: { crmClosedStages: CLOSED_STAGES, crmTaskClosed: TASK_CLOSED, crmTaskDueFrom: (filter.equals || {}).crmTaskDueFrom || '2999-01-01T00:00:00.000Z' },
});

const SPECS = [
  { ...OPPORTUNITIES, metricCode: 'crm.leads_by_origin', columns: { ...OPPORTUNITIES.columns, period: 'created_at' }, describe: (f) => `Oportunidades (leads) criadas ${span(f)}, sem as excluídas` },
  { ...OPPORTUNITIES, metricCode: 'crm.first_response_time', columns: { ...OPPORTUNITIES.columns, period: 'created_at' }, describe: (f) => `Oportunidades (leads) criadas ${span(f)}; a média usa a primeira mensagem de saída de um usuário de cada uma` },
  {
    ...OPPORTUNITIES, metricCode: 'crm.opportunities_by_stage', flags: ['crmClosedFrom', 'crmClosedTo'], predicates: [stagePredicate],
    columns: { ...OPPORTUNITIES.columns, status: 'stage' },
    describe: (f) => `Oportunidades em aberto mais as fechadas (ganha, perdida ou desistência) de ${day((f.equals || {}).crmClosedFrom) || 'sempre'} a ${day((f.equals || {}).crmClosedTo) || 'hoje'}`,
  },
  {
    ...OPPORTUNITIES, metricCode: 'crm.conversion_rate', columns: { ...OPPORTUNITIES.columns, status: 'stage', period: 'closed_at' },
    formulaId: 'crm.conversion_rate', rowColumns: ['stage'], formulaParams: { minSample: 1 },
    describe: (f) => `Oportunidades ganhas e perdidas (fora a desistência) fechadas ${span(f)}`,
  },
  { ...OPPORTUNITIES, metricCode: 'crm.loss_reasons', columns: { ...OPPORTUNITIES.columns, status: 'stage', period: 'closed_at' }, describe: (f) => `Oportunidades perdidas fechadas ${span(f)}, com o motivo da perda` },
  {
    ...OPPORTUNITIES, metricCode: 'crm.portfolio_without_next_action', flags: ['crmTaskDueFrom'], predicates: [withoutNextActionPredicate],
    describe: () => 'Oportunidades em aberto sem tarefa aberta com data posterior a hoje e sem próxima ação com texto e data',
  },
];

const DETAIL_COLUMNS = ['stage', 'lead_source', 'owner_user_id', 'created_at', 'closed_at'];
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, { columns: spec.metricCode === 'crm.loss_reasons' ? [...DETAIL_COLUMNS, 'lost_reason'] : DETAIL_COLUMNS, link: '/painel/crm' });
}

module.exports = { CRM_SOURCE_CODES: SPECS.map((s) => s.metricCode), CLOSED_STAGES, TASK_CLOSED };
