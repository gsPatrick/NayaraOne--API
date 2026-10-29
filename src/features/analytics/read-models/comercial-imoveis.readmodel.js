'use strict';

/**
 * M9-D616 — read models de Comercial/CRM e Imóveis (schema analytics, um arquivo por tabela em comercial-imoveis/): leads por dia, origem
 * e corretor; oportunidades por estágio; desfechos e motivos de perda; carteira sem próxima ação; visitas e propostas; carteira de
 * imóveis; mudanças de preço; Radar; desempenho por corretor. Só ids e agregados: nome e documento de pessoa nunca entram aqui.
 * Quem lê são os serviços de métrica (M9-D613); o worker (M9-D607) aplica o ESTADO recalculado do agregado, idempotente por sourceEventId.
 */
module.exports = {
  leadDaily: require('./comercial-imoveis/lead-daily'),
  opportunityStage: require('./comercial-imoveis/opportunity-stage'),
  outcome: require('./comercial-imoveis/outcome'),
  nextAction: require('./comercial-imoveis/next-action'),
  visitsProposals: require('./comercial-imoveis/visits-proposals'),
  portfolio: require('./comercial-imoveis/portfolio'),
  priceChanges: require('./comercial-imoveis/price-changes'),
  radarMatches: require('./comercial-imoveis/radar-matches'),
  brokerPerformance: require('./comercial-imoveis/broker-performance'),
};
