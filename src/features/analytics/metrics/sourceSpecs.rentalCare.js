'use strict';

/**
 * M9-D642 / M9-D611 / M9-D690 — origem dos números dos KPIs de chamados, satisfação e repasses da Locação: quais registros do módulo reproduzem cada KPI (chamados de manutenção de
 * imóveis com contrato de locação ainda em aberto, registros de atendimento do mês de pessoas que são parte de contrato de locação e repasses atrasados). O filtro (assinado) é
 * montado por kpis/locacao-atendimento/filters. O detalhe abre os registros do filtro e só devolve ids a quem tem analytics:drilldown e a permissão do domínio; nada de pessoa,
 * descrição do chamado nem valor nas colunas. As condições do KPI só valem com o filtro completo (flags); sem elas a origem é a tabela inteira da empresa (consulta bruta da prova do M9-D712).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const NO_RESTRICTION = { sql: 'TRUE', replacements: {} };
const hasFlags = (filter, names) => names.every((n) => (filter.equals || {})[n] !== undefined);
const VALID_MONTH = "t.\"reference_month\" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'";
const DUE = "((to_date(t.\"reference_month\" || '-01', 'YYYY-MM-DD') + interval '1 month')::date - 1 + CAST(:careRepassDays AS integer))";

/** Imóvel do chamado com contrato de locação (tipo em analytics.locacao.tipos_contrato, não excluído). */
const leaseProperty = (filter) => (!hasFlags(filter, ['leaseTypes']) ? NO_RESTRICTION : {
  sql: 'EXISTS (SELECT 1 FROM legal.contracts c WHERE c.property_id = t."property_id" AND c.company_id = t."company_id" AND c.deleted_at IS NULL AND c.contract_type IN (:careLease))',
  replacements: { careLease: filter.equals.leaseTypes },
});

/** Registro de atendimento do mês de pessoa que é parte de contrato de locação. */
const leaseFeedback = (filter) => (!hasFlags(filter, ['leaseTypes', 'monthFrom', 'monthTo']) ? NO_RESTRICTION : {
  sql: `(t."created_at" >= :careFrom AND t."created_at" < :careTo AND t."person_id" IN (SELECT cp.person_id FROM legal.contract_parties cp JOIN legal.contracts c ON c.id = cp.contract_id
        WHERE cp.company_id = t."company_id" AND cp.deleted_at IS NULL AND c.deleted_at IS NULL AND c.contract_type IN (:careLease)))`,
  replacements: { careFrom: filter.equals.monthFrom, careTo: filter.equals.monthTo, careLease: filter.equals.leaseTypes },
});

/** Repasse atrasado: pendente cuja data prevista (fim do mês de referência + dias do parâmetro) é anterior à data-base; sem mês válido não há data prevista e não é atrasado. */
const overdueRepass = (filter) => (!hasFlags(filter, ['overdueBefore', 'repassDays']) ? NO_RESTRICTION : {
  sql: `(CASE WHEN ${VALID_MONTH} THEN ${DUE} < CAST(:careBefore AS date) ELSE FALSE END)`,
  replacements: { careBefore: filter.equals.overdueBefore, careRepassDays: filter.equals.repassDays },
});

const day = (value) => (value ? String(value).slice(0, 10) : null);
const SPECS = [
  {
    metricCode: 'rent.tickets', type: 'MAINTENANCE_CASES', table: 'construction.maintenance_cases', flags: ['leaseTypes'], columns: { status: 'status', equals: { deletedAt: 'deleted_at' } },
    predicates: [leaseProperty], describe: () => 'Chamados de manutenção em aberto de imóveis com contrato de locação (os abertos e fechados do mês e o tempo de resolução ficam nas dimensões, pelo read model)',
  },
  {
    metricCode: 'rent.satisfaction', type: 'FEEDBACK_CASES', table: 'crm.feedback_cases', flags: ['leaseTypes', 'monthFrom', 'monthTo'], columns: { equals: { deletedAt: 'deleted_at' } },
    predicates: [leaseFeedback], describe: (f) => `Registros de atendimento do mês de ${day(f.equals && f.equals.monthFrom)} de pessoas que são parte de contrato de locação (cada um vale uma resposta de satisfação)`,
  },
  {
    metricCode: 'rent.repasses', type: 'OWNER_REPASSES', table: 'finance.owner_repasses', flags: ['overdueBefore', 'repassDays'], columns: { status: 'status' },
    predicates: [overdueRepass], describe: (f) => `Repasses ao proprietário pendentes com data prevista anterior a ${day(f.equals && f.equals.overdueBefore)} (atrasados)`,
  },
];

const DETAIL = {
  'rent.tickets': { columns: ['property_id', 'status', 'created_at'], link: '/painel/contratos/lista' },
  'rent.satisfaction': { columns: ['type', 'created_at'], link: '/painel/crm' },
  'rent.repasses': { columns: ['contract_id', 'reference_month', 'status'], link: '/painel/financeiro' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { RENTAL_CARE_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
