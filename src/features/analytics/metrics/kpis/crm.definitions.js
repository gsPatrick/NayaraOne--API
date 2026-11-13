'use strict';

/**
 * M9-D630 / M9-D631 — definição, no Metric Registry, dos seis KPIs do funil comercial. Os 15 campos do livro (M9-D603): fonte (o read model do CRM de cada
 * KPI), fórmula versionada no código (formulas/crm*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.crm.<kpi>),
 * política de atualização e regra de qualidade, como escritos nas demandas. Versão 1. crm.opportunities_by_stage é CRITICAL (oportunidades paradas,
 * bloco 6; tabela da M9-D712): nasce com drill-down.
 */
const { readCrmOwner } = require('../../read-models/crmKpi.settings');

/** Os read models do funil que alimentam os KPIs (nome da tabela em analytics; citado só aqui e em crm.rows). */
const READ_MODELS = Object.freeze({ lead: 'rm_crm_lead_daily', stage: 'rm_crm_opportunity_stage', outcome: 'rm_crm_outcome', next: 'rm_crm_next_action' });
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Comercial (M9-D708): leads, funil, conversão e carteira conforme o CRM';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job às 00:05 (e o evento, que também recalcula)
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'crm.leads_by_origin', name: 'Leads por origem', sourceReadModel: READ_MODELS.lead, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'De onde vêm os contatos: oportunidades criadas no mês de São Paulo da data-base, até ela, por origem, com a participação de cada origem.',
    formulaSemantic: 'Contagem de leads (oportunidades) com createdAt, no calendário de São Paulo, dentro do período, agrupada por origem (vazia = NAO_INFORMADA); percentual = contagem ÷ total × 100 (2 casas); o total é a soma das origens. Mais de analytics.qualidade.max_origem_vazia_pct de leads sem origem deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'origem', 'corretor', 'período'], qualityRule: quality(['origin']),
  },
  {
    metricCode: 'crm.first_response_time', name: 'Tempo até a primeira resposta', sourceReadModel: READ_MODELS.lead, unit: 'MINUTES', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Em quanto tempo a equipe responde ao primeiro contato: média, em minutos, entre a criação do lead e a primeira mensagem de saída de um usuário.',
    formulaSemantic: 'Para cada lead criado no período e já respondido: segundos entre createdAt e a primeira mensagem de saída humana; KPI = média aritmética dos segundos, em minutos com 1 casa; leads sem resposta não entram na média e são contados em details.withoutResponse; relógio de 24 h corridas. Menos de analytics.qualidade.min_amostra respondidos deixa o KPI INCOMPLETE.',
    dimensions: ['empresa', 'origem', 'corretor'], qualityRule: quality(['first_response_count']),
  },
  {
    metricCode: 'crm.opportunities_by_stage', name: 'Oportunidades por estágio', sourceReadModel: READ_MODELS.stage, unit: 'COUNT', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: DAILY,
    description: 'O funil: quantas oportunidades há em cada etapa, as encerradas no mês (ganha, perdida, desistência) e o tempo médio parado em cada etapa.',
    formulaSemantic: 'Contagem de oportunidades por stage na data-base (posição), incluindo os estágios terminais fechados no mês; ordem dos estágios do pipeline (analytics.comercial.ordem_estagios); tempo médio parado no estágio atual em dias (data de calendário de São Paulo). Oportunidade sem estágio deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'estágio', 'corretor', 'origem'], qualityRule: quality(['stage']),
  },
  {
    metricCode: 'crm.conversion_rate', name: 'Conversão', sourceReadModel: READ_MODELS.outcome, unit: 'PERCENT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas oportunidades decididas viram venda: ganhas ÷ (ganhas + perdidas) no mês de São Paulo da data-base. Desistência não conta.',
    formulaSemantic: 'conversão = ganhas no período ÷ (ganhas + perdidas no período) × 100, 2 casas, onde ganha e perdida são decididas pela data de fechamento em São Paulo; denominador zero → nulo e INCOMPLETE; menos de analytics.qualidade.min_amostra fechadas → INCOMPLETE.',
    dimensions: ['empresa', 'origem', 'corretor', 'período'], qualityRule: quality(['won', 'lost']),
  },
  {
    metricCode: 'crm.loss_reasons', name: 'Motivos de perda', sourceReadModel: READ_MODELS.outcome, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Por que as oportunidades se perdem: perdidas no mês de São Paulo da data-base, por motivo, com a participação de cada motivo.',
    formulaSemantic: 'Contagem das oportunidades LOST no período por lostReason (mesmo agrupamento de getCrmDashboard), percentual por motivo e total igual ao número de perdidas; perdida sem motivo vai a "Sem motivo" (NAO_INFORMADO). "Sem motivo" acima de analytics.qualidade.max_sem_motivo_pct deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'motivo', 'corretor', 'origem'], qualityRule: quality(['lost_reason']),
  },
  {
    metricCode: 'crm.portfolio_without_next_action', name: 'Carteira sem próxima ação', sourceReadModel: READ_MODELS.next, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Quantas oportunidades em aberto estão sem uma próxima ação marcada (risco de esfriar), e a parte que isso representa da carteira.',
    formulaSemantic: 'Contagem e percentual de oportunidades em aberto sem próxima ação válida (sem tarefa aberta com data posterior a hoje e sem nextAction preenchida conforme opportunityNextAction.validator.js) na data-base; percentual = sem ação ÷ em aberto × 100. Oportunidade em aberto sem corretor deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'corretor', 'estágio'], qualityRule: quality(['next_action', 'broker_id']),
  },
]);

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return {
    ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', valueNature: 'ACTUAL', formulaId: def.metricCode,
    ownerRole: await readCrmOwner(def.metricCode, scope, transaction),
  };
}

module.exports = { DEFINITIONS, publishInput, READ_MODELS };
