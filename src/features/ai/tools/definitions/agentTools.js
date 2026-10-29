'use strict';

// Tools que pertencem a um agente da NAY (M9-D034 a D041), além das treze iniciais da M9-D016. Cada arquivo é uma definição; o registro
// valida todas no boot, contra o catálogo de permissões. Agente novo acrescenta as suas aqui.
const AGENT_TOOL_DEFINITIONS = Object.freeze([
  require('./correspondentGetStalledCases'),
  require('./correspondentGetPendingRequirements'),
  require('./correspondentCompareSimulations'),
  require('./crmGetCustomerContactStatus'),
  require('./radarListPublicListings'),
  require('./crmCreateHandoffTask'),
  require('./crmGetPipelineSummary'),
  require('./constructionGetPortfolioProgress'),
  require('./inventoryGetStockRisks'),
  require('./legalGetExpiringContracts'),
  require('./financeGetCashflowProjection'),
  require('./financeGetAnomalies'),
  require('./documentsTranscribe'),
  require('./documentsClassifySuggest'),
  require('./documentsExtractFields'),
  require('./documentsCheckConsistency'),
]);

module.exports = { AGENT_TOOL_DEFINITIONS };
