'use strict';

/**
 * M9-D660 — definição, no Metric Registry, dos quatro KPIs do Jurídico. Os 15 campos do livro (M9-D603): fonte (o read model do Jurídico de cada KPI),
 * fórmula versionada no código (formulas/legal*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>),
 * política de atualização e regra de qualidade, como escritos na demanda. Versão 1. legal.deadlines e legal.cases_by_risk são CRITICAL (tabela da
 * M9-D712): nascem com drill-down.
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Jurídico (M9-D708): prazos, processos, valores e documentos conforme o módulo Jurídico';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job às 00:05 (a idade do prazo depende do relógio)
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'legal.deadlines', name: 'Prazos próximos e vencidos', sourceReadModel: 'rm_legal_deadlines', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: DAILY,
    description: 'Quantos prazos jurídicos abertos vencem nos próximos 7 dias, até 30 dias ou já venceram, e há quantos dias venceu o mais antigo.',
    formulaSemantic: 'Contagem de prazos abertos em três faixas disjuntas do calendário de São Paulo: próximos 7 dias (hoje até hoje+6), até 30 dias (hoje+7 até hoje+29) e vencidos (antes de hoje, com o mais antigo em dias). De hoje+30 em diante só conta no total de abertos. Prazo sem data deixa o KPI INCOMPLETE e pede alerta CRITICAL.',
    dimensions: ['empresa', 'tipo de prazo', 'responsável', 'processo'], qualityRule: quality(['without_date']),
  },
  {
    metricCode: 'legal.cases_by_risk', name: 'Processos por risco', sourceReadModel: 'rm_legal_cases_risk', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Quantos processos ativos há em cada nível de risco (baixo, médio, alto, crítico) e quantos ainda estão sem classificação.',
    formulaSemantic: 'Contagem de processos ativos por nível de risco e tipo de processo na data-base; processo sem nível entra em "Sem classificação". Sem classificação acima de analytics.qualidade.max_sem_risco_pct deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'risco', 'tipo de processo'], qualityRule: quality(['risk_level']),
  },
  {
    metricCode: 'legal.values', name: 'Valores estimados e confirmados', sourceReadModel: 'rm_legal_values', unit: 'BRL', valueNature: 'ESTIMATED', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quanto os processos ativos podem custar (estimado) e quanto já foi confirmado por condenação, acordo ou perda; as duas séries nunca se somam.',
    formulaSemantic: 'Duas séries separadas: estimado (ESTIMATED) = soma do valor estimado dos processos ativos; confirmado (ACTUAL) = soma de condenações, acordos ou perdas já confirmados. Processo ativo sem valor estimado é contado em details.withoutValue, nunca como zero.',
    dimensions: ['empresa', 'tipo de processo', 'risco'], qualityRule: quality(['estimated_total', 'confirmed_total']),
  },
  {
    metricCode: 'legal.missing_documents', name: 'Documentos faltantes', sourceReadModel: 'rm_legal_missing_docs', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas exigências documentais de contratos ainda estão pendentes e em quantos contratos.',
    formulaSemantic: 'Contagem de exigências de contratos ainda não satisfeitas nem dispensadas (status pendente), por tipo de exigência, mais a contagem de contratos com pelo menos uma exigência pendente. Exigência sem prazo (contrato sem início de vigência) acima de analytics.qualidade.max_exigencia_sem_prazo_pct deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'tipo de documento', 'contrato'], qualityRule: quality(['requirements_without_deadline']),
  },
]);

module.exports = { DEFINITIONS };
