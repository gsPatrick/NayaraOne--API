'use strict';

/**
 * M9-D641 — definição, no Metric Registry, dos três KPIs de prazos da Locação. Os 15 campos do livro (M9-D603): fonte (o read model de Locação de cada KPI), fórmula versionada no
 * código (formulas/rent*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização (job às 00:05, porque o prazo vence com
 * a passagem do dia) e regra de qualidade, como escritos na demanda. Versão 1. rent.guarantees_expiring e rent.inspections_keys são CRITICAL (tabela da M9-D712): nascem com drill-down.
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Locação (M9-D708): garantias, obrigações, vistorias e chaves conforme o módulo de Contratos e Locação';
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job às 00:05
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 1440, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'rent.guarantees_expiring', name: 'Garantias vencendo', sourceReadModel: 'rm_rental_guarantees', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: DAILY,
    description: 'Quantas garantias de contratos de locação ativos vencem nos próximos 30 dias, em até 60 dias, e quantas já venceram sem renovação.',
    formulaSemantic: 'Contagem de garantias ativas de contratos de locação ACTIVE com vencimento de hoje até hoje+29 (30 dias, o valor), de hoje até hoje+59 (60 dias) e já vencidas (antes de hoje), por tipo de garantia, no calendário de São Paulo. Garantia sem data de vencimento, fora os tipos sem vencimento de analytics.locacao.garantias_sem_vencimento, deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'tipo de garantia', 'contrato'], qualityRule: quality(['expiring_30d', 'expiring_60d', 'expired', 'without_date']),
  },
  {
    metricCode: 'rent.obligations_pending', name: 'Obrigações pendentes', sourceReadModel: 'rm_rental_obligations', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Quantas obrigações (exigências documentais e troca de titularidade de contas) dos contratos de locação seguem em aberto, quantas já passaram do prazo e há quantos dias a mais antiga venceu.',
    formulaSemantic: 'Contagem de obrigações abertas de contratos de locação não encerrados (o valor), com as vencidas separadas (prazo = início do contrato, antes de hoje), as a vencer e a idade em dias da vencida mais antiga. Obrigação sem prazo deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'tipo de obrigação', 'contrato'], qualityRule: quality(['pending', 'overdue', 'without_deadline', 'oldest_overdue_days']),
  },
  {
    metricCode: 'rent.inspections_keys', name: 'Vistorias e chaves', sourceReadModel: 'rm_rental_inspections_keys', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: DAILY,
    description: 'Quantas vistorias de locação estão pendentes e atrasadas, e quantas chaves seguem fora e já passaram da devolução prevista.',
    formulaSemantic: 'Vistorias pendentes (agendadas e não realizadas, o valor) e atrasadas (data prevista anterior a hoje); chaves entregues e não devolvidas de contratos ACTIVE e atrasadas (devolução prevista, o fim do contrato, anterior a hoje). Chave sem data prevista deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'tipo de vistoria', 'imóvel'], qualityRule: quality(['inspections_pending', 'inspections_overdue', 'keys_out', 'keys_return_overdue', 'keys_without_return_date']),
  },
]);

module.exports = { DEFINITIONS };
