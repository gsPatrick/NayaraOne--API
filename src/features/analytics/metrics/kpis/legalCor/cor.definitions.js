'use strict';

/**
 * M9-D661 — definição, no Metric Registry, dos quatro KPIs do Correspondente Bancário. Os 15 campos do livro (M9-D603): fonte (o read model do
 * Correspondente de cada KPI), fórmula versionada no código (formulas/cor*.js, id = código do indicador), dimensões, unidade, owner (parâmetro
 * analytics.owner.<código>), política de atualização e regra de qualidade, como escritos na demanda. Versão 1. cor.commission é CRITICAL (dinheiro
 * parado, tabela da M9-D712): nasce com drill-down.
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Correspondente (M9-D708): casos, aprovação, tempo de análise e comissão conforme o módulo Correspondente';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'cor.cases_by_stage', name: 'Financing cases por estágio', sourceReadModel: 'rm_fin_cases_stage', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos casos de financiamento há em cada estágio do fluxo e quanto tempo, em média, estão parados no estágio atual.',
    formulaSemantic: 'Contagem de casos por estágio na data-base e tempo médio no estágio em dias de calendário de São Paulo (1 casa); casos fora de um estágio válido ficam em details.invalid. Caso sem estágio deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'estágio', 'provider', 'corretor'], qualityRule: quality(['stage']),
  },
  {
    metricCode: 'cor.approval_rate_by_provider', name: 'Aprovação e rejeição por provider', sourceReadModel: 'rm_fin_provider_outcome', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas propostas cada banco aprovou e rejeitou no mês e a taxa de aprovação; pendentes não entram.',
    formulaSemantic: 'Por provider no mês de São Paulo da data-base: aprovadas, rejeitadas e taxa = aprovadas ÷ (aprovadas + rejeitadas) × 100, 2 casas. Menos de analytics.qualidade.min_amostra decisões deixa o provider INCOMPLETE; sem nenhum provider com amostra o KPI sai INCOMPLETE.',
    dimensions: ['empresa', 'provider', 'produto'], qualityRule: quality(['approved', 'rejected']),
  },
  {
    metricCode: 'cor.analysis_time', name: 'Tempo de análise', sourceReadModel: 'rm_fin_provider_outcome', unit: 'DAYS', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos dias, em média, o banco leva entre receber o pedido e decidir (aprovar ou rejeitar).',
    formulaSemantic: 'Média dos dias de calendário de São Paulo entre o envio ao provider e a decisão, só dos casos decididos no mês da data-base, com 1 casa; casos enviados e ainda sem decisão em details.pending. Decisão sem data de envio deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'provider', 'produto'], qualityRule: quality(['analysis_count', 'analysis_days_sum']),
  },
  {
    metricCode: 'cor.commission', name: 'Comissão esperada, confirmada e recebida', sourceReadModel: 'rm_fin_commission', unit: 'BRL', valueNature: 'ESTIMATED', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'A comissão do correspondente em três séries que nunca se somam: esperada, confirmada pelo banco e recebida, e o que falta receber.',
    formulaSemantic: 'Três séries separadas: esperada (ESTIMATED) = soma da comissão prevista; confirmada (PLANNED) = soma da comissão dos casos aprovados; recebida (ACTUAL) = soma das comissões recebidas com lançamento liquidado. Confirmada − recebida = a receber. Comissão recebida sem caso ou sem lançamento liquidado vinculado deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'provider', 'produto', 'corretor'], qualityRule: quality(['expected', 'confirmed', 'received', 'received_unlinked']),
  },
]);

module.exports = { DEFINITIONS };
