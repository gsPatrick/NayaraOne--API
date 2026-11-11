'use strict';

/**
 * M9-D641 / M9-D611 / M9-D690 — origem dos números dos KPIs de prazos da Locação: quais registros do módulo de Contratos reproduzem cada KPI (garantias ativas vencendo em 30 dias, exigências
 * pendentes e vistorias pendentes de contratos de locação). O filtro (assinado) é montado por kpis/locacao-prazos/filters. O detalhe (drill-down) abre os registros do filtro e só devolve
 * ids a quem tem analytics:drilldown e legal:read; nada de garantidor, valor nem texto da exigência nas colunas. Obrigações também contam trocas de titularidade de contas de consumo
 * (legal.lease_obligations) e o KPI de vistorias e chaves também conta chaves: a origem de uma tabela só abre o principal (exigências e vistorias), o resto fica no read model (DI-D641-4).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const NO_RESTRICTION = { sql: 'TRUE', replacements: {} };
/** As condições do KPI só valem com o filtro completo do KPI (flag leaseTypes); sem ele a origem é a tabela inteira da empresa (consulta bruta da prova do M9-D712). */
const complete = (filter) => Array.isArray((filter.equals || {}).leaseTypes);

/** Contrato de locação do filtro: tipo em analytics.locacao.tipos_contrato (flag leaseTypes), não excluído; `status` restringe o status do contrato quando informado. */
const leaseContract = (column, status) => (filter) => (!complete(filter) ? NO_RESTRICTION : {
  sql: `EXISTS (SELECT 1 FROM legal.contracts c WHERE c.id = t."${column}" AND c.company_id = t."company_id" AND c.deleted_at IS NULL AND c.contract_type IN (:rentalLease)${status})`,
  replacements: { rentalLease: filter.equals.leaseTypes },
});
const dueWindow = (filter) => (!complete(filter) ? NO_RESTRICTION : { sql: 't."ends_at" >= :guaranteeFrom AND t."ends_at" < :guaranteeTo', replacements: { guaranteeFrom: filter.equals.windowFrom, guaranteeTo: filter.equals.windowTo } });
const openInspection = (filter) => (!complete(filter) ? NO_RESTRICTION : { sql: "t.\"status\" NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')", replacements: {} });

const day = (value) => (value ? String(value).slice(0, 10) : null);
const SPECS = [
  {
    metricCode: 'rent.guarantees_expiring', type: 'GUARANTEES', table: 'legal.guarantees', flags: ['leaseTypes', 'windowFrom', 'windowTo'], columns: { status: 'status', equals: { deletedAt: 'deleted_at' } },
    predicates: [leaseContract('contract_id', " AND c.status = 'ACTIVE'"), dueWindow],
    describe: (f) => `Garantias ativas de contratos de locação ativos que vencem de ${day(f.equals && f.equals.windowFrom)} até antes de ${day(f.equals && f.equals.windowTo)} (30 dias)`,
  },
  {
    metricCode: 'rent.obligations_pending', type: 'CONTRACT_REQUIREMENTS', table: 'legal.contract_requirements', flags: ['leaseTypes'], columns: { status: 'status' },
    predicates: [leaseContract('contract_id', " AND c.status NOT IN ('TERMINATED', 'CLOSED')")],
    describe: () => 'Exigências documentais pendentes de contratos de locação não encerrados (as trocas de titularidade de contas entram no número pelo read model)',
  },
  {
    metricCode: 'rent.inspections_keys', type: 'INSPECTIONS', table: 'legal.inspections', flags: ['leaseTypes'], columns: { equals: { deletedAt: 'deleted_at' } },
    predicates: [leaseContract('contract_id', ''), openInspection],
    describe: () => 'Vistorias pendentes de contratos de locação (nem concluídas nem canceladas); as chaves entram nas dimensões pelo read model',
  },
];

const DETAIL = {
  'rent.guarantees_expiring': { columns: ['contract_id', 'guarantee_type', 'ends_at'], link: '/painel/contratos/lista' },
  'rent.obligations_pending': { columns: ['contract_id', 'requirement_type'], link: '/painel/contratos/lista' },
  'rent.inspections_keys': { columns: ['contract_id', 'inspection_type', 'scheduled_at'], link: '/painel/contratos/lista' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { RENTAL_DEADLINE_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
