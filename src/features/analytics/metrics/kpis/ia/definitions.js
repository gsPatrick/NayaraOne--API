'use strict';

/**
 * M9-D681 — definição, no Metric Registry, dos quatro KPIs de IA. Os 15 campos do livro (M9-D603): fonte (o read model de cada KPI), fórmula versionada no código (formulas/ai*.js, id =
 * código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>, padrão "Tecnologia (papel ti-gestor)"), política de atualização (a da tabela de criticidade da
 * M9-D712) e regra de qualidade, como escritos na demanda. Versão 1. Todos NORMAL na tabela de criticidade (sem drill-down de BI).
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de IA (M9-D681): custo, fundamentação, orçamento e chamadas de ferramenta conforme as execuções da NAY';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const quality = (maxStalenessMinutes, requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'ai.cost_by_agent', name: 'Custo de IA por agente', sourceReadModel: 'rm_ai_cost', domain: 'TECH_AI', unit: 'BRL', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quanto a NAY custou no mês de São Paulo, por agente e por modelo, e quanto custa cada execução.',
    formulaSemantic: 'Σ custo em BRL das execuções concluídas no mês de SP por agente (a execução grava o custo já em reais; nenhuma cotação do dia da consulta entra), arredondado uma vez; custo por execução = custo ÷ execuções (2 casas). Execução que chamou modelo e não gravou custo deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'agente', 'modelo'], qualityRule: quality(15, ['cost_brl', 'runs', 'runs_without_cost']),
  },
  {
    metricCode: 'ai.quality_scores', name: 'Grounding e evaluation score', sourceReadModel: 'rm_ai_quality', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL',
    refreshPolicy: Object.freeze({ mode: 'SCHEDULE', cron: '0 3 * * 1', maxStalenessMinutes: 10080 }),
    description: 'Se a NAY responde com base em fontes (grounding) e a nota das avaliações do golden dataset, por agente e semana de São Paulo.',
    formulaSemantic: 'grounding = execuções com fonte ÷ execuções com fundamentação aplicável × 100 (2 casas) por agente e semana; evaluation = média das notas dos itens das avaliações da semana, de 0 a 100 (1 casa); respostas bloqueadas por grounding contadas à parte. Menos de analytics.qualidade.min_amostra execuções na semana deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'agente', 'semana'], qualityRule: quality(10080, ['runs', 'grounding_runs', 'grounding_score_sum']),
  },
  {
    metricCode: 'ai.budget', name: 'Budget de IA', sourceReadModel: 'rm_ai_cost', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quanto do orçamento mensal da NAY já foi consumido, por agente, com a projeção do mês e o alerta.',
    formulaSemantic: 'consumo% = custo do mês ÷ orçamento mensal × 100 (2 casas); projeção = custo ÷ dia do mês × dias do mês; agente acima de analytics.ia.alerta_budget_pct (padrão 80%) sinalizado. Agente sem orçamento definido ou com orçamento zero deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'agente'], qualityRule: quality(15, ['cost_brl', 'budget_brl']),
  },
  {
    metricCode: 'ai.tool_calls_blocked', name: 'Tool calls bloqueadas', sourceReadModel: 'rm_ai_tool_calls', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas ações a NAY tentou e foram barradas no mês de São Paulo, por agente, ferramenta e motivo. Cada recusa que o pipeline da NAY registra também incrementa o contador nayaraone_api_ai_tool_calls_blocked_total.',
    formulaSemantic: 'No mês de SP: chamadas de ferramenta totais, bloqueadas (estado BLOCKED por blocked_reason: allowlist, permissão, schema, injeção, cross-company, segredo, orçamento, política e STALE) e % bloqueadas = bloqueadas ÷ totais × 100 (2 casas). Aprovação humana pendente (PROPOSED) e rejeição humana (CANCELLED_BY_HUMAN) não são bloqueio. Bloqueio sem motivo deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'agente', 'ferramenta', 'motivo'], qualityRule: quality(15, ['calls', 'blocked', 'by_reason']),
  },
]);

module.exports = { DEFINITIONS };
