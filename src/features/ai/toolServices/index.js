'use strict';

// M9-D016 — monta os mapas `services` e `readModels` do contexto da tool (M9-D002) com os serviços de aplicação existentes,
// ligados à transação do tenant. As escritas só entram com `includeWrite` (execução já aprovada, M9-D019).
const { crmOpportunities, crmCustomers, crmTasks } = require('./crm.services');
const { radarMatches } = require('./radar.services');
const { financeHealth, financePayments } = require('./finance.services');
const { constructionProjects, legalContracts, legalDrafts, correspondentCases } = require('./operations.services');
const { knowledge } = require('./knowledge.services');
const { analyticsBi } = require('./analytics.services');
const { contactStatus, publicListings, handoff } = require('./atendimento.services');
const { crmPipeline, constructionPortfolio, inventoryRisks } = require('./aggregates.services');
const { legalExpiring, withStalledScope } = require('./scoped.services');
const { financeProjection } = require('./financeProjection.services');

function buildToolServices(transaction, scope = {}, { includeWrite = false } = {}) {
  const services = {
    crmOpportunities: crmOpportunities(transaction, scope),
    crmCustomers: crmCustomers(transaction),
    radarMatches: radarMatches(transaction, scope),
    financeHealth: financeHealth(transaction),
    constructionProjects: constructionProjects(transaction),
    legalContracts: legalContracts(transaction),
    correspondentCases: withStalledScope(correspondentCases(transaction, scope), transaction, scope), // M9-D035: a Diretoria recebe só o agregado
    knowledge: knowledge(transaction, scope),
    atendimentoContact: contactStatus(transaction, scope), // M9-D041: NAY Atendimento (contato do contexto, anúncios públicos, encaminhamento)
    atendimentoListings: publicListings(transaction, scope),
    atendimentoHandoff: handoff(transaction, scope),
    crmPipeline: crmPipeline(transaction), // M9-D035: leituras agregadas da NAY Diretoria
    constructionPortfolio: constructionPortfolio(transaction, scope),
    inventoryRisks: inventoryRisks(transaction, scope),
    legalExpiring: legalExpiring(transaction, scope),
    financeProjection: financeProjection(transaction, scope), // M9-D036: projeção de fluxo e anomalias da NAY Financeira
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
