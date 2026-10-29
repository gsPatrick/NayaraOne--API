'use strict';

/**
 * M9-D632 — definição, no Metric Registry, dos cinco KPIs de visitas, propostas, imóveis, preços e mudanças de preço. Os 15 campos do livro (M9-D603): fonte (o read model de cada KPI), fórmula versionada no código (formulas/<código>.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização e regra de qualidade, como escritos na demanda. Versão 1. crm.proposals e prop.without_sale_by_period são CRITICAL (tabela da M9-D712): nascem com drill-down.
 */
const { EVENT, DAILY, quality } = require('./commercial.defs.common');

/** Os read models que alimentam os KPIs (nome da tabela em analytics; citado só aqui e em commercial.rows.*). */
const READ_MODELS = Object.freeze({ visits: 'rm_crm_visits_proposals', portfolio: 'rm_property_portfolio', prices: 'rm_property_price_changes' });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'crm.visits', name: 'Visitas', sourceReadModel: READ_MODELS.visits, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Atividade de visitas: agendadas no mês de São Paulo da data-base (canceladas fora), quantas foram realizadas e a taxa de comparecimento.',
    formulaSemantic: 'Contagem de visitas agendadas (fora as canceladas) e de realizadas (status DONE) no período, pela data da visita em São Paulo; taxa de comparecimento = realizadas ÷ agendadas × 100 (2 casas). Visita sem corretor no período deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'corretor', 'imóvel'], qualityRule: quality(['agent_user_id']),
  },
  {
    metricCode: 'crm.proposals', name: 'Propostas', sourceReadModel: READ_MODELS.visits, unit: 'COUNT', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Propostas enviadas no mês de São Paulo da data-base, quantas foram aceitas, recusadas e estão em aberto, o valor total proposto e a taxa de aceite.',
    formulaSemantic: 'Contagem de propostas enviadas no período (data do envio em São Paulo), das aceitas, recusadas, expiradas e em aberto (situação de hoje), soma do valor proposto (BRL, ESTIMATED); taxa de aceite = aceitas ÷ (aceitas + recusadas) × 100 (2 casas). Proposta sem valor deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'corretor', 'imóvel'], qualityRule: quality(['value']),
  },
  {
    metricCode: 'prop.active_properties', name: 'Imóveis ativos', sourceReadModel: READ_MODELS.portfolio, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Quantos imóveis estão disponíveis hoje, por finalidade (venda, locação) e por tipo.',
    formulaSemantic: 'Contagem de imóveis disponíveis (AVAILABLE, não excluídos nem inativos na publicação) na data-base; venda = com oferta de venda ativa, locação = só com oferta de locação ativa, sem oferta = o restante; por tipo. Imóvel sem status deixa o KPI DEGRADED, sem valor.',
    dimensions: ['empresa', 'finalidade', 'tipo', 'bairro'], qualityRule: quality(['availability_status'], 1440),
  },
  {
    metricCode: 'prop.without_sale_by_period', name: 'Imóveis sem venda por período', sourceReadModel: READ_MODELS.portfolio, unit: 'COUNT', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: DAILY,
    description: 'Há quanto tempo os imóveis à venda estão no mercado sem vender: quantos em cada faixa de dias (0-30, 31-90, 91-180 e 181+) e a lista dos mais antigos.',
    formulaSemantic: 'Contagem de imóveis disponíveis, publicados e com oferta de venda ativa, pelos dias de calendário de São Paulo entre a publicação e a data-base, nas faixas de analytics.imoveis.faixas_sem_venda_dias (padrão 30,90,180: 0-30, 31-90, 91-180, 181+); a última faixa é a lista de atenção. Imóvel publicado sem data de entrada no mercado fica fora das faixas, contado em "Sem data", e o KPI sai DEGRADED, sem valor.',
    dimensions: ['empresa', 'faixa', 'tipo', 'corretor captador'], qualityRule: quality(['published_at'], 1440),
  },
  {
    metricCode: 'prop.price_changes', name: 'Preço e mudanças de preço', sourceReadModel: READ_MODELS.prices, unit: 'COUNT', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas vezes o preço de oferta mudou no mês de São Paulo da data-base e a variação média em percentual (redução aparece negativa).',
    formulaSemantic: 'Contagem de mudanças de preço no período (data da mudança em São Paulo); variação média = média de (novo - anterior) ÷ anterior × 100 (2 casas, redução negativa) sobre as mudanças com preço anterior; a primeira entrada do histórico não entra na variação; só primeiras entradas deixam o KPI INCOMPLETE, sem valor.',
    dimensions: ['empresa', 'tipo', 'corretor'], qualityRule: quality(['old_price']),
  },
]);

module.exports = { DEFINITIONS, READ_MODELS };
