'use strict';

/**
 * M9-D640 / M9-D611 / M9-D690 — origem dos números dos KPIs de contratos ativos, vacância e inadimplência da locação: quais registros reproduzem cada KPI. Contratos ativos: os
 * contratos de locação ACTIVE (a contagem é o valor). Vacância: os imóveis locáveis (mesma regra do read model, rentable.sql.js); como é PERCENT o detalhe refaz a conta sobre as linhas
 * (alugado ou não). Inadimplência da locação: as entradas próprias de contratos de locação da janela (a base da taxa), refeita sobre as linhas como a taxa do Financeiro. O filtro
 * (assinado) é montado por kpis/locacao-carteira/filters; as condições do KPI só valem com o filtro completo (flag leaseTypes); sem ele a origem é a tabela inteira da empresa (consulta
 * bruta da prova da M9-D712). O detalhe só devolve ids a quem tem analytics:drilldown e a permissão do domínio; nada de pessoa nem de texto nas colunas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');
const { rentableWhere } = require('../read-models/locacao/rentable.sql');

const NONE = { sql: 'TRUE', replacements: {} };
const complete = (filter) => Array.isArray((filter.equals || {}).leaseTypes);
const day = (value) => (value ? String(value).slice(0, 10) : null);

const leaseType = (filter) => (!complete(filter) ? NONE : { sql: 't."contract_type" IN (:rentalLease)', replacements: { rentalLease: filter.equals.leaseTypes } });
const leaseContractOfEntry = (filter) => (!complete(filter) ? NONE : {
  sql: 'EXISTS (SELECT 1 FROM legal.contracts c WHERE c.id = t."contract_id" AND c.company_id = t."company_id" AND c.deleted_at IS NULL AND c.contract_type IN (:rentalLease))',
  replacements: { rentalLease: filter.equals.leaseTypes },
});
const rentable = (filter) => {
  if (!complete(filter) || !Array.isArray(filter.equals.worksStatuses)) return NONE;
  return { sql: `(${rentableWhere('t', { leaseTypes: ':rentalLease', worksStatuses: ':rentalWorks' }).sql})`, replacements: { rentalLease: filter.equals.leaseTypes, rentalWorks: filter.equals.worksStatuses } };
};
const rentedColumn = (filter) => (!complete(filter) ? { sql: 'FALSE', replacements: {} } : {
  sql: rentableWhere('t', { leaseTypes: ':rentalRented', worksStatuses: ':rentalWorks' }).rented, replacements: { rentalRented: filter.equals.leaseTypes },
});

const SPECS = [
  {
    metricCode: 'rent.active_contracts', type: 'CONTRACTS', table: 'legal.contracts', flags: ['leaseTypes'], columns: { status: 'status', equals: { deletedAt: 'deleted_at' } }, predicates: [leaseType],
    describe: () => 'Contratos de locação com status ativo (ACTIVE); os suspensos ficam à parte',
  },
  {
    metricCode: 'rent.vacancy', type: 'PROPERTIES', table: 'real_estate.properties', flags: ['leaseTypes', 'worksStatuses'], columns: { equals: { deletedAt: 'deleted_at' } }, predicates: [rentable],
    formulaId: 'rent.vacancy', rowExpressions: { rented: rentedColumn },
    describe: () => 'Imóveis locáveis (finalidade de locação ativa no portfólio); a vacância é a parte deles sem contrato de locação ativo',
  },
  {
    metricCode: 'rent.delinquency', type: 'LEDGER_ENTRIES', table: 'finance.financial_entries', flags: ['leaseTypes'], predicates: [leaseContractOfEntry],
    columns: { status: 'status', nature: 'nature', period: 'due_at', equals: { thirdParty: 'is_third_party_funds', reversal: 'reversal_of_entry_id' } },
    formulaId: 'rent.delinquency', rowColumns: ['status', 'amount'], rowExpressions: { due_day: "(t.\"due_at\" AT TIME ZONE 'America/Sao_Paulo')::date" },
    describe: (f) => `Entradas próprias de contratos de locação (sem estornos nem cancelamentos) com vencimento de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}: a base da inadimplência da locação`,
  },
];

const DETAIL = {
  'rent.active_contracts': { columns: ['contract_type', 'starts_at', 'ends_at'], link: '/painel/contratos/lista' },
  'rent.vacancy': { columns: ['property_type', 'availability_status'], link: '/painel/imoveis/lista' },
  'rent.delinquency': { columns: ['contract_id', 'due_at', 'settled_at', 'status'], link: '/painel/financeiro/lancamentos/{id}' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { RENTAL_PORTFOLIO_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
