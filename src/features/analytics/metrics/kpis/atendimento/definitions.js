'use strict';

/**
 * M9-D672 — definição, no Metric Registry, dos quatro KPIs de Atendimento. Os 15 campos do livro (M9-D603): fonte (o read model de Marketing/Atendimento de cada KPI),
 * fórmula versionada no código (formulas/sup*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização e
 * regra de qualidade, como escritos na demanda. Versão 1. Todos NORMAL na tabela da M9-D712 (sem drill-down obrigatório).
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Atendimento (M9-D708): avaliações, satisfação, reclamações e SLA conforme o módulo de Marketing e Atendimento';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job diário às 00:05
const HOURLY = Object.freeze({ mode: 'SCHEDULE', cron: '0 * * * *', maxStalenessMinutes: 60 }); // evento + job a cada hora (o prazo vence sem evento)
const quality = (requiredFields, maxStalenessMinutes) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'sup.reviews', name: 'Reviews', sourceReadModel: 'rm_mkt_reviews', unit: 'SCORE', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Como o cliente avalia a Nayara nas plataformas públicas (Google e similares): nota média e quantas avaliações de cada nota.',
    formulaSemantic: 'Nota média = Σ nota ÷ número de reviews concluídos no mês de São Paulo da data-base (2 casas), com a contagem por nota (1 a 5) e por plataforma. Pedido sem retorno da plataforma não tem nota e não entra. Menos de analytics.qualidade.min_amostra reviews deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'plataforma', 'unidade'], qualityRule: quality(['reviews', 'rating_sum', 'rating_1', 'rating_5'], 1440),
  },
  {
    metricCode: 'sup.satisfaction', name: 'Satisfação (CSAT)', sourceReadModel: 'rm_support_satisfaction', unit: 'SCORE', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Como o cliente avalia o atendimento na pesquisa interna de satisfação, de 1 a 5, e quantos deram nota 4 ou 5.',
    formulaSemantic: 'CSAT = Σ notas ÷ respostas do mês de São Paulo da data-base (2 casas) e % de notas 4 ou 5 = (notas >= 4) ÷ respostas × 100 (2 casas). Menos de analytics.qualidade.min_amostra respostas deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'área', 'atendente'], qualityRule: quality(['responses', 'score_sum', 'positive'], 15),
  },
  {
    metricCode: 'sup.complaints_by_reason', name: 'Reclamações por motivo', sourceReadModel: 'rm_support_complaints', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas reclamações foram abertas no mês e qual a parte de cada motivo.',
    formulaSemantic: 'Contagem de reclamações abertas no mês de São Paulo da data-base por motivo (o tipo do caso) e % de cada motivo sobre o total (2 casas). Caso sem motivo vai a "Sem motivo"; acima de analytics.qualidade.max_sem_motivo_pct do total o KPI fica DEGRADED.',
    dimensions: ['empresa', 'motivo', 'área'], qualityRule: quality(['reason', 'count'], 15),
  },
  {
    metricCode: 'sup.sla_resolution', name: 'SLA de resolução', sourceReadModel: 'rm_support_sla', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: HOURLY,
    description: 'Qual a parte dos casos de atendimento resolvida dentro do prazo da sua prioridade, e quantos casos em aberto já estouraram o prazo.',
    formulaSemantic: '% dentro do SLA = casos resolvidos no mês de São Paulo da data-base com (resolução − abertura) <= horas da prioridade (analytics.sla.horas.<prioridade>) ÷ casos resolvidos × 100 (2 casas); abertos já vencidos em details.openOverdue. Caso sem prioridade usa MEDIA e deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'prioridade', 'área'], qualityRule: quality(['resolved', 'within_sla', 'without_priority'], 60),
  },
]);

module.exports = { DEFINITIONS };
