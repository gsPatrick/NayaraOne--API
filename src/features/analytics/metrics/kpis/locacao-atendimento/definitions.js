'use strict';

/**
 * M9-D642 — definição, no Metric Registry, dos três KPIs de pós-venda da Locação (chamados, satisfação e repasses). Os 15 campos do livro (M9-D603): fonte (o read model de Locação de cada
 * KPI), fórmula versionada no código (formulas/rent*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização (evento
 * a cada 15 min; os repasses também pela agenda, porque o prazo vence com a passagem do dia) e regra de qualidade, como escritos na demanda e na tabela de criticidade (M9-D712).
 * Versão 1. Nenhum é CRITICAL: sem drill-down próprio nesta entrega além da origem registrada (sourceSpecs.rentalCare).
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Locação (M9-D708): chamados, satisfação e repasses conforme o módulo de Contratos e Locação';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const QUARTER_HOURLY = Object.freeze({ mode: 'SCHEDULE', cron: '*/15 * * * *', maxStalenessMinutes: 15 }); // job a cada 15 min
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'rent.tickets', name: 'Chamados da locação', sourceReadModel: 'rm_rental_tickets', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos chamados de manutenção dos imóveis alugados seguem em aberto, quantos foram abertos e fechados no mês e em quantas horas, em média, foram resolvidos.',
    formulaSemantic: 'Chamados de manutenção de imóveis com contrato de locação: em aberto na data-base (o valor), abertos e fechados do 1º dia do mês de São Paulo até a data-base e tempo médio de resolução = horas de resolução dos fechados no período ÷ fechados no período (1 casa). Chamado fechado sem data de abertura deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'tipo', 'contrato', 'imóvel'], qualityRule: quality(['open_total', 'opened_period', 'closed_period', 'resolution_hours_period', 'without_open_date']),
  },
  {
    metricCode: 'rent.satisfaction', name: 'Satisfação da locação', sourceReadModel: 'rm_rental_satisfaction', unit: 'SCORE', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Como inquilinos e proprietários avaliam a locação: nota média das respostas do mês, com o número de respostas e a média de cada papel.',
    formulaSemantic: 'Média aritmética das notas das respostas ligadas a contratos de locação no mês de São Paulo da data-base (Σ notas ÷ respostas, 2 casas), com o número de respostas e a média separada por inquilino e proprietário. Menos de analytics.qualidade.min_amostra respostas deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'papel', 'contrato'], qualityRule: quality(['responses', 'score_sum', 'tenant_responses', 'owner_responses']),
  },
  {
    metricCode: 'rent.repasses', name: 'Repasses de locação', sourceReadModel: 'rm_rental_repasses', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: QUARTER_HOURLY,
    description: 'Quantos repasses ao proprietário estão atrasados, quantos e quanto foram pagos no mês, quantos estão pendentes no prazo e que parte dos devidos foi paga até a data prevista.',
    formulaSemantic: 'Repasses de aluguel ao proprietário: atrasados (pendentes com data prevista anterior a hoje, o valor), pagos no mês de São Paulo (contagem e valor), pendentes no prazo e % no prazo = pagos até a data prevista ÷ devidos no período (data prevista de 1º do mês até a data-base) × 100 (2 casas). Repasse sem data prevista deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'proprietário', 'contrato'], qualityRule: quality(['pending', 'paid', 'overdue', 'due_count', 'on_time_count', 'without_due_date']),
  },
]);

module.exports = { DEFINITIONS };
