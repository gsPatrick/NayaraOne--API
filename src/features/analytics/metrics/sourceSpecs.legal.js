'use strict';

/**
 * M9-D660 / M9-D611 / M9-D690 — origem dos números dos KPIs do Jurídico: quais registros do módulo Jurídico reproduzem cada KPI (prazos abertos,
 * processos ativos, exigências pendentes de contratos vivos). O filtro (assinado) é montado por legal.filters. O detalhe de cada KPI (drill-down)
 * abre os registros do filtro e só devolve ids a quem tem analytics:drilldown e legal:read; nada de partes, teor nem advogado nas colunas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

/** Processo ativo = status e fase fora da lista de encerrados do filtro (parâmetro analytics.juridico.processo_encerrado_status). Sem a lista, não restringe. */
const activePredicate = (filter) => {
  const list = (filter.equals || {}).legalFinished;
  if (!Array.isArray(list) || !list.length) return { sql: 'TRUE', replacements: {} };
  return { sql: "(upper(t.\"status\") NOT IN (:legalFinished) AND upper(COALESCE(t.\"phase\", '')) NOT IN (:legalFinished))", replacements: { legalFinished: list } };
};

/** Exigência de contrato vivo: não excluído, nem cancelado, nem encerrado (a mesma regra do read model). */
const liveContractPredicate = () => ({
  sql: "EXISTS (SELECT 1 FROM legal.contracts c WHERE c.id = t.\"contract_id\" AND c.company_id = t.\"company_id\" AND c.deleted_at IS NULL AND c.status NOT IN ('CANCELLED', 'CLOSED'))",
  replacements: {},
});

const CASES = { type: 'LEGAL_CASES', table: 'legal.legal_cases', flags: ['legalFinished'], predicates: [activePredicate], columns: { equals: { deletedAt: 'deleted_at' } } };

const SPECS = [
  {
    metricCode: 'legal.deadlines', type: 'LEGAL_DEADLINES', table: 'legal.legal_deadlines', columns: { period: 'due_at', status: 'status', equals: { deletedAt: 'deleted_at' } },
    describe: (f) => `Prazos jurídicos abertos que venceram ou vencem antes de ${day(f.period && f.period.to) || 'hoje+30'} (vencidos, próximos 7 dias e até 30 dias)`,
  },
  { ...CASES, metricCode: 'legal.cases_by_risk', describe: () => 'Processos jurídicos ativos (fora os encerrados, arquivados, cancelados e excluídos)' },
  { ...CASES, metricCode: 'legal.values', valueColumn: 'estimated_amount', describe: () => 'Processos jurídicos ativos; o valor é o estimado de cada um (sem valor estimado não soma)' },
  {
    metricCode: 'legal.missing_documents', type: 'CONTRACT_REQUIREMENTS', table: 'legal.contract_requirements', columns: { status: 'status' }, predicates: [liveContractPredicate],
    describe: () => 'Exigências documentais pendentes de contratos vigentes ou em andamento (nem atendidas nem dispensadas)',
  },
];

const DETAIL = {
  'legal.deadlines': { columns: ['legal_case_id', 'responsible_user_id', 'due_at'], link: '/painel/contratos/processos' },
  'legal.cases_by_risk': { columns: ['case_type', 'risk_level', 'phase'], link: '/painel/contratos/processos' },
  'legal.values': { columns: ['case_type', 'risk_level', 'phase'], link: '/painel/contratos/processos' },
  'legal.missing_documents': { columns: ['contract_id', 'requirement_type'], link: '/painel/contratos/lista' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { LEGAL_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
