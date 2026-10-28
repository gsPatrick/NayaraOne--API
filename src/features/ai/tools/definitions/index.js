'use strict';

// Tools iniciais da NAY (M9-D016): dez de leitura e três de escrita. Cada arquivo é uma definição; o registro valida todas no boot.
const INITIAL_DEFINITIONS = Object.freeze([
  require('./crmGetOpportunity'),
  require('./crmGetCustomerSummary'),
  require('./radarListMatchesForOpportunity'),
  require('./financeGetWeeklyHealth'),
  require('./financeGetDelinquency'),
  require('./constructionGetProjectProgress'),
  require('./legalGetContractSummary'),
  require('./correspondentGetCaseStatus'),
  require('./knowledgeSearch'),
  require('./memoryRecall'),
  require('./crmCreateFollowUpTask'),
  require('./financeProposePayment'),
  require('./legalDraftContract'),
]);

module.exports = { INITIAL_DEFINITIONS };
