'use strict';

/**
 * M9-D710 / M9-D611 / M9-D690 — origem dos números dos KPIs de fatos do dia do Centro de Comando: os registros do read model rm_command_events que reproduzem cada KPI (contratos assinados,
 * oportunidades ganhas, pagamentos liquidados relevantes). O registro de origem de cada fato (contrato, oportunidade, lançamento) é o source_id, que serve de id do detalhe. O filtro
 * (assinado) é montado por kpis/centro-comando/filters: janela [de, até) em instantes e, nos pagamentos, o limiar relevante. A lista mostra os fatos VIVOS da janela: a linha original que
 * não tem compensatória (revertido sai da contagem, como na soma do KPI); pagamentos só do próprio dinheiro (terceiros ficam de fora) e com valor igual ou acima do limiar (inclusivo).
 * O detalhe só devolve ids a quem tem analytics:drilldown e a permissão do domínio; nenhuma coluna traz nome, documento ou descrição.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');
const { DEFINITIONS } = require('./kpis/centro-comando/definitions');

const TABLE = `analytics.${DEFINITIONS[0].sourceReadModel}`; // a tabela vem da definição do registry

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}`;

/** Fato vivo do tipo: linha original (revision 0) sem compensatória do mesmo registro. */
const live = (kind) => () => ({
  sql: `(t."kind" = '${kind}' AND t."revision" = 0 AND NOT EXISTS (SELECT 1 FROM ${TABLE} r
    WHERE r.company_id = t."company_id" AND r.kind = t."kind" AND r.source_id = t."source_id" AND r.revision = 1))`,
  replacements: {},
});
/** Só o próprio dinheiro com valor igual ou acima do limiar do filtro (flag relevantFrom). Sem o flag (consulta bruta), não restringe. */
const relevantOwn = (filter) => {
  const from = (filter.equals || {}).relevantFrom;
  if (from === undefined || from === null) return { sql: 'TRUE', replacements: {} };
  return { sql: '(t."is_third_party" = false AND t."amount" >= CAST(:commandRelevantFrom AS numeric))', replacements: { commandRelevantFrom: from } };
};

const COMMON = { type: 'COMMAND_EVENTS', table: TABLE, idColumn: 'source_id', columns: { period: 'occurred_at' } };
const SPECS = [
  { ...COMMON, metricCode: 'legal.contracts_signed', predicates: [live('CONTRACT_SIGNED')], describe: (f) => `Contratos que passaram a assinados ${span(f)}, um por contrato (revertidos ficam de fora)` },
  { ...COMMON, metricCode: 'crm.opportunities_won', predicates: [live('OPPORTUNITY_WON')], describe: (f) => `Oportunidades que entraram no estágio ganho ${span(f)}, uma por oportunidade (ganhos desfeitos ficam de fora)` },
  {
    ...COMMON, metricCode: 'fin.payments_settled_relevant', flags: ['relevantFrom'], predicates: [live('PAYMENT_SETTLED'), relevantOwn],
    describe: (f) => `Saídas liquidadas ${span(f)} com valor igual ou acima do valor relevante (${(f.equals || {}).relevantFrom || 'configurado'}), só dinheiro próprio e sem estornadas`,
  },
];

const COLUMNS = ['kind', 'source_type', 'amount', 'contract_type', 'broker_id', 'origin', 'account_id'];
const DETAIL = {
  'legal.contracts_signed': { columns: COLUMNS, link: '/painel/contratos/lista' },
  'crm.opportunities_won': { columns: COLUMNS, link: '/painel/crm' },
  'fin.payments_settled_relevant': { columns: COLUMNS, link: '/painel/financeiro/lancamentos' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { COMMAND_EVENT_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
