'use strict';

// M9-D016 — monta os mapas `services` e `readModels` do contexto da tool (M9-D002) com os serviços de aplicação existentes,
// ligados à transação do tenant. As escritas só entram com `includeWrite` (execução já aprovada, M9-D019).
const { crmOpportunities, crmCustomers, crmTasks } = require('./crm.services');
const { radarMatches } = require('./radar.services');
const { financeHealth, financePayments } = require('./finance.services');
const { constructionProjects, legalContracts, legalDrafts, correspondentCases } = require('./operations.services');
const { knowledge } = require('./knowledge.services');
const { analyticsBi } = require('./analytics.services');

function buildToolServices(transaction, scope = {}, { includeWrite = false } = {}) {
  const services = {
    crmOpportunities: crmOpportunities(transaction),
    crmCustomers: crmCustomers(transaction),
    radarMatches: radarMatches(transaction),
    financeHealth: financeHealth(transaction),
    constructionProjects: constructionProjects(transaction),
    legalContracts: legalContracts(transaction),
    correspondentCases: correspondentCases(transaction, scope),
    knowledge: knowledge(transaction, scope),
    analyticsBi: analyticsBi(transaction, scope), // M9-D695: leitura do BI pela NAY Diretoria (catálogo fechado, sem SQL)
  };
  if (includeWrite) {
    services.crmTasks = crmTasks(transaction, scope);
    services.financePayments = financePayments(transaction, scope);
    services.legalDrafts = legalDrafts(transaction, scope);
  }
  return { services, readModels: {} };
}

module.exports = { buildToolServices };
