'use strict';

/**
 * M9-D672 / M9-D611 / M9-D690 — origem dos números dos KPIs de Atendimento: quais registros do módulo reproduzem cada KPI (pedidos de avaliação concluídos, casos de atendimento
 * abertos e casos resolvidos). O filtro (assinado) é montado por kpis/atendimento/filters. O detalhe de cada KPI (drill-down) abre os registros do filtro e só devolve ids a quem tem
 * analytics:drilldown; nada de pessoa, telefone, e-mail nem texto do caso nas colunas. O SLA também conta os chamados de manutenção (construction.maintenance_cases), que a
 * origem de uma tabela só não abre: a origem mostra os casos de atendimento e o resto fica no read model (DI-D672-4).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}`;

/** Pedido de avaliação do mês: o instante é o da conclusão (sem ele, a última alteração), como o read model; `need` é a nota que precisa estar preenchida. */
const reviewMonth = (need) => (filter) => ({
  sql: `(t."${need}" IS NOT NULL AND COALESCE(t."completed_at", t."updated_at") >= :reviewFrom AND COALESCE(t."completed_at", t."updated_at") < :reviewTo)`,
  replacements: { reviewFrom: (filter.equals || {}).monthFrom, reviewTo: (filter.equals || {}).monthTo },
});
const REVIEWS = { type: 'REVIEW_REQUESTS', table: 'marketing.review_requests', flags: ['monthFrom', 'monthTo'], columns: { status: 'status', equals: { deletedAt: 'deleted_at' } } };
const CASES = { type: 'FEEDBACK_CASES', table: 'crm.feedback_cases', columns: { status: 'status', equals: { deletedAt: 'deleted_at' } } };

const SPECS = [
  { ...REVIEWS, metricCode: 'sup.reviews', predicates: [reviewMonth('public_rating')], describe: (f) => `Avaliações públicas concluídas no mês de ${day(f.equals && f.equals.monthFrom)} (com nota da plataforma)` },
  { ...REVIEWS, metricCode: 'sup.satisfaction', predicates: [reviewMonth('satisfaction_score')], describe: (f) => `Respostas da pesquisa de satisfação do mês de ${day(f.equals && f.equals.monthFrom)}` },
  {
    ...CASES, metricCode: 'sup.complaints_by_reason', columns: { ...CASES.columns, period: 'created_at' }, predicates: [() => ({ sql: "t.\"type\" <> 'COMPLIMENT'", replacements: {} })],
    describe: (f) => `Reclamações e conflitos abertos ${span(f)} (elogio não conta); o motivo é o tipo do caso`,
  },
  { ...CASES, metricCode: 'sup.sla_resolution', columns: { ...CASES.columns, period: 'resolved_at' }, describe: (f) => `Casos de atendimento resolvidos ${span(f)}, medidos contra o SLA da prioridade` },
];

const DETAIL = {
  'sup.reviews': { columns: ['platform', 'public_rating', 'completed_at'], link: null },
  'sup.satisfaction': { columns: ['satisfaction_score', 'completed_at'], link: null },
  'sup.complaints_by_reason': { columns: ['type', 'severity', 'created_at'], link: '/painel/crm' },
  'sup.sla_resolution': { columns: ['severity', 'created_at', 'resolved_at'], link: '/painel/crm' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { SUPPORT_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
