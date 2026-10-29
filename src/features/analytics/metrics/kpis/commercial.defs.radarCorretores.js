'use strict';

/**
 * M9-D633 — definição, no Metric Registry, dos três KPIs de Radar matches, captação por corretor e conversão por corretor. Os 15 campos do livro (M9-D603): fonte (o read model de cada KPI), fórmula versionada no código (formulas/<código>.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização e regra de qualidade, como escritos na demanda. Versão 1. radar.matches é CRITICAL (tabela da M9-D712): nasce com drill-down.
 */
const { EVENT, quality } = require('./commercial.defs.common');

/** Os read models que alimentam os KPIs (nome da tabela em analytics; citado só aqui e em commercial.rows.*). */
const READ_MODELS = Object.freeze({ radar: 'rm_radar_matches', brokers: 'rm_broker_performance' });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'radar.matches', name: 'Radar matches', sourceReadModel: READ_MODELS.radar, unit: 'COUNT', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Quantos cruzamentos o Radar fez entre perfis de busca e imóveis no mês de São Paulo da data-base, quantos já foram avisados, quantos viraram negócio e a taxa de conversão.',
    formulaSemantic: 'No período: cruzamentos gerados (evento radar.matched), avisados (evento publicado ou tratado), convertidos (a pessoa do radar tem oportunidade ganha no mesmo imóvel) e taxa = convertidos ÷ gerados × 100 (2 casas). Cruzamento sem perfil ou sem imóvel ativo deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'origem do perfil', 'corretor'], qualityRule: quality(['property_id']),
  },
  {
    metricCode: 'crm.broker_capture', name: 'Captação por corretor', sourceReadModel: READ_MODELS.brokers, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos imóveis cada corretor captou no mês de São Paulo da data-base, os sem captador e o valor médio pedido dos captados.',
    formulaSemantic: 'Contagem de imóveis cadastrados no período (data de criação em São Paulo) por corretor captador (quem cadastrou) e "Sem captador"; valor médio pedido = soma da oferta ativa dos captados ÷ quantos têm oferta (BRL, ESTIMATED, 2 casas). "Sem captador" acima de analytics.qualidade.max_sem_corretor_pct (padrão 5%) deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'corretor', 'tipo'], qualityRule: quality(['created_by']),
  },
  {
    metricCode: 'crm.broker_conversion', name: 'Conversão por corretor', sourceReadModel: READ_MODELS.brokers, unit: 'PERCENT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'De cada corretor, quantas oportunidades decididas no mês de São Paulo da data-base viraram venda: ganhas ÷ (ganhas + perdidas).',
    formulaSemantic: 'Para cada corretor responsável: ganhas ÷ (ganhas + perdidas) do período × 100 (2 casas), decididas pela data de fechamento em São Paulo; o ranking só mostra o corretor com pelo menos analytics.qualidade.min_amostra fechadas (padrão 5); abaixo disso o corretor fica INCOMPLETE; empresa com menos fechadas que o mínimo deixa o KPI INCOMPLETE, sem valor.',
    dimensions: ['empresa', 'corretor'], qualityRule: quality(['owner_user_id', 'stage']),
  },
]);

module.exports = { DEFINITIONS, READ_MODELS };
