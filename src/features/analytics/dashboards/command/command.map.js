'use strict';

/**
 * M9-D685 (3.2-A) — mapa FECHADO "item -> origem" do Centro de Comando. Nenhum item sai fora desta tabela: cada tipo aponta para um `metric_code` do registro ou
 * para as instâncias de alerta (`alert_instances`). Os seis blocos, na ordem do livro (§4), e as métricas de que cada um depende (`dependsOn`, avaliadas pela
 * M9-D697: com alguma DEGRADED, INCOMPLETE ou STALE o bloco adia a conclusão). Só dado puro, sem banco e sem cálculo.
 */
const BLOCKS = Object.freeze([
  { key: 'ACONTECEU', position: 2, title: 'O que aconteceu', question: 'O que aconteceu na janela?' },
  { key: 'DECISAO', position: 3, title: 'O que exige decisão', question: 'O que está esperando alguém decidir?' },
  { key: 'RISCO', position: 4, title: 'Onde há risco', question: 'Onde há risco?' },
  { key: 'DINHEIRO', position: 5, title: 'Onde há dinheiro parado ou perdido', question: 'Onde há dinheiro parado ou perdido?' },
  { key: 'PRAZOS', position: 6, title: 'Quais prazos estão críticos', question: 'Quais prazos estão críticos?' },
  { key: 'OPORTUNIDADES', position: 7, title: 'Quais oportunidades merecem atenção', question: 'Quais oportunidades merecem atenção?' },
]);

const ALERTS = 'alert_instances';

/** { block, type, origin: { metricCode } | { alert: ALERTS }, demand }: a tabela 3.2-A linha a linha. */
const ITEM_MAP = Object.freeze([
  { block: 'ACONTECEU', type: 'VARIACAO_KPI', origin: { critical: true }, demand: 'M9-D694' },
  { block: 'ACONTECEU', type: 'CONTRATO_ASSINADO', origin: { metricCode: 'legal.contracts_signed' }, demand: 'M9-D710' },
  { block: 'ACONTECEU', type: 'OPORTUNIDADE_GANHA', origin: { metricCode: 'crm.opportunities_won' }, demand: 'M9-D710' },
  { block: 'ACONTECEU', type: 'PAGAMENTO_RELEVANTE', origin: { metricCode: 'fin.payments_settled_relevant' }, demand: 'M9-D710' },
  { block: 'ACONTECEU', type: 'ALERTA_ABERTO_OU_RESOLVIDO', origin: { alert: ALERTS }, demand: 'M9-D691' },
  { block: 'DECISAO', type: 'APROVACAO_FINANCEIRA', origin: { metricCode: 'fin.approvals_pending' }, demand: 'M9-D709' },
  { block: 'DECISAO', type: 'AJUSTE_ESTOQUE', origin: { metricCode: 'inv.adjustments_pending' }, demand: 'M9-D709' },
  { block: 'DECISAO', type: 'APROVACAO_REGRA', origin: { metricCode: 'tec.rule_approvals_pending' }, demand: 'M9-D709' },
  { block: 'DECISAO', type: 'PROPOSTA_NAY', origin: { metricCode: 'ai.proposals_pending' }, demand: 'M9-D709' },
  { block: 'DECISAO', type: 'ALERTA_RECONHECIDO', origin: { alert: ALERTS }, demand: 'M9-D691' },
  { block: 'RISCO', type: 'ALERTA_ABERTO', origin: { alert: ALERTS }, demand: 'M9-D691' },
  { block: 'RISCO', type: 'ANOMALIA_FINANCEIRA', origin: { metricCode: 'fin.anomalies_open' }, demand: 'M9-D624' },
  { block: 'RISCO', type: 'PROCESSO_RISCO_ALTO', origin: { metricCode: 'legal.cases_by_risk' }, demand: 'M9-D660' },
  { block: 'RISCO', type: 'GARANTIA_VENCIDA', origin: { metricCode: 'rent.guarantees_expiring' }, demand: 'M9-D641' },
  { block: 'RISCO', type: 'OBRA_MARGEM_BAIXA', origin: { metricCode: 'obra.projected_margin' }, demand: 'M9-D650' },
  { block: 'RISCO', type: 'INTEGRACAO_FORA_SLO', origin: { metricCode: 'tec.integration_errors' }, demand: 'M9-D680' },
  { block: 'DINHEIRO', type: 'DINHEIRO_COMPONENTE', origin: { metricCodes: ['fin.overdue_receivables', 'obra.measurements', 'cor.commission', 'fin.owner_repasses_pending', 'inv.losses', 'obra.waste', 'obra.postwork_cost'] }, demand: 'M9-D622' },
  { block: 'PRAZOS', type: 'PRAZO_JURIDICO', origin: { metricCode: 'legal.deadlines' }, demand: 'M9-D660' },
  { block: 'PRAZOS', type: 'GARANTIA_A_VENCER', origin: { metricCode: 'rent.guarantees_expiring' }, demand: 'M9-D641' },
  { block: 'PRAZOS', type: 'CONTAS_A_PAGAR', origin: { metricCode: 'fin.payables_7d' }, demand: 'M9-D621' },
  { block: 'PRAZOS', type: 'ATRASO_OBRA', origin: { metricCode: 'obra.delays' }, demand: 'M9-D651' },
  { block: 'PRAZOS', type: 'VISTORIA_CHAVE_ATRASADA', origin: { metricCode: 'rent.inspections_keys' }, demand: 'M9-D641' },
  { block: 'OPORTUNIDADES', type: 'OPORTUNIDADE_PARADA', origin: { metricCode: 'crm.opportunities_by_stage' }, demand: 'M9-D631' },
  { block: 'OPORTUNIDADES', type: 'PROPOSTA_EM_ABERTO', origin: { metricCode: 'crm.proposals' }, demand: 'M9-D632' },
  { block: 'OPORTUNIDADES', type: 'MATCH_SEM_CONTATO', origin: { metricCode: 'radar.matches' }, demand: 'M9-D633' },
  { block: 'OPORTUNIDADES', type: 'IMOVEL_SEM_VENDA', origin: { metricCode: 'prop.without_sale_by_period' }, demand: 'M9-D632' },
]);

const FACT_CODES = Object.freeze(['legal.contracts_signed', 'crm.opportunities_won', 'fin.payments_settled_relevant']);
const QUEUE_CODES = Object.freeze(['fin.approvals_pending', 'inv.adjustments_pending', 'tec.rule_approvals_pending', 'ai.proposals_pending']);
const MONEY_CODES = Object.freeze(ITEM_MAP.find((e) => e.type === 'DINHEIRO_COMPONENTE').origin.metricCodes);

/** Métricas de que cada bloco depende (as lidas por ele, sem contar as lidas só para variação). */
const DEPENDS_ON = Object.freeze({
  ACONTECEU: FACT_CODES,
  DECISAO: QUEUE_CODES,
  RISCO: ['fin.anomalies_open', 'legal.cases_by_risk', 'rent.guarantees_expiring', 'obra.projected_margin', 'tec.integration_errors'],
  DINHEIRO: MONEY_CODES,
  PRAZOS: ['legal.deadlines', 'rent.guarantees_expiring', 'fin.payables_7d', 'obra.delays', 'rent.inspections_keys'],
  OPORTUNIDADES: ['crm.opportunities_by_stage', 'crm.proposals', 'radar.matches', 'prop.without_sale_by_period'],
});

/** Tela do painel de origem de cada família de indicador (o item é um link para ela; o detalhe fica no drill-down do indicador). */
const PANEL_OF_PREFIX = Object.freeze({
  fin: '/painel/analytics/financeiro', legal: '/painel/analytics/juridico', rent: '/painel/analytics/locacao', obra: '/painel/analytics/obras', inv: '/painel/analytics/estoque',
  cor: '/painel/analytics/correspondente', crm: '/painel/analytics/crm', radar: '/painel/analytics/crm', prop: '/painel/analytics/crm', tec: '/painel/analytics/tecnologia',
  ai: '/painel/analytics/tecnologia', mkt: '/painel/analytics/marketing', sup: '/painel/analytics/atendimento',
});
const FALLBACK_PANEL = '/painel/centro-de-comando';

const panelOf = (metricCode) => PANEL_OF_PREFIX[String(metricCode).split('.')[0]] || FALLBACK_PANEL;

module.exports = { BLOCKS, ITEM_MAP, DEPENDS_ON, FACT_CODES, QUEUE_CODES, MONEY_CODES, ALERTS, panelOf, FALLBACK_PANEL };
