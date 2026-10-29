'use strict';

/**
 * M9-D709 / M9-D611 / M9-D690 — origem dos números dos KPIs da fila de decisão do Centro de Comando: os itens do read model rm_decision_queue que esperam
 * decisão (status PENDING) de cada fila. O número do KPI é a contagem desses itens, e o detalhe (drill-down) devolve as mesmas linhas, ordenadas pelo pedido
 * mais antigo; a decisão em si continua nos módulos de origem (o link abre o item lá). O detalhe só mostra ids, valor, datas e códigos: nenhum texto livre.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');
const { KINDS } = require('../read-models/decisao-fila.kinds');
const { KPI_DEFINITIONS } = require('./kpis/decisao/definitions');

/** O read model de cada KPI vem das definições (a varredura de segurança M9-D700 só deixa citar o nome do read model na camada read-models e nas definições). */
const RM = Object.freeze(Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.metricCode, `analytics.${d.sourceReadModel}`])));
const BY_METRIC = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [k.metricCode, { kind, ...k }])));

const SPECS = Object.keys(BY_METRIC).map((metricCode) => ({
  metricCode, type: 'DECISION_QUEUE', table: RM[metricCode], columns: { status: 'status', period: 'requested_at', equals: { queueKind: 'kind' } },
  describe: () => `Itens da fila de decisão (${BY_METRIC[metricCode].sourceType}) que esperam decisão, do pedido mais antigo ao mais novo`,
}));

const DETAILS = {
  'fin.approvals_pending': { columns: ['source_id', 'approval_type', 'approval_tier', 'amount', 'requested_at'], link: '/painel/financeiro/aprovacoes' },
  'inv.adjustments_pending': { columns: ['source_id', 'reason_code', 'amount', 'requested_at'], link: '/painel/estoque' },
  'tec.rule_approvals_pending': { columns: ['source_id', 'rule_id', 'requested_at'], link: '/painel/configuracoes' },
  'ai.proposals_pending': { columns: ['source_id', 'agent_code', 'proposal_type', 'requested_at'], link: '/painel/ia' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAILS[spec.metricCode]);
}

module.exports = { DECISION_QUEUE_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
