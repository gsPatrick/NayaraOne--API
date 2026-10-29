'use strict';

/**
 * M9-D630 — definição, no Metric Registry, dos KPIs de leads por origem e de tempo até a primeira resposta (a M9-D631 acrescenta os outros quatro). Os 15 campos do livro (M9-D603): fonte (o read model do CRM de cada
 * KPI), fórmula versionada no código (formulas/crm*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.crm.<kpi>),
 * política de atualização e regra de qualidade, como escritos nas demandas. Versão 1.
 */
const { readCrmOwner } = require('../../read-models/crmKpi.settings');

/** Os read models do funil que alimentam os KPIs (nome da tabela em analytics; citado só aqui e em crm.rows). */
const READ_MODELS = Object.freeze({ lead: 'rm_crm_lead_daily' });
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
]);

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return {
    ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', valueNature: 'ACTUAL', formulaId: def.metricCode,
    ownerRole: await readCrmOwner(def.metricCode, scope, transaction),
  };
}

module.exports = { DEFINITIONS, publishInput, READ_MODELS };
