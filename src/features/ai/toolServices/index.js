'use strict';

// M9-D016 — monta os mapas `services` e `readModels` do contexto da tool (M9-D002) com os serviços de aplicação existentes,
// ligados à transação do tenant. As escritas só entram com `includeWrite` (execução já aprovada, M9-D019).
const { crmOpportunities, crmCustomers, crmTasks } = require('./crm.services');
const { radarMatches } = require('./radar.services');
const { financeHealth, financePayments } = require('./finance.services');
const { constructionProjects, legalContracts, legalDrafts, correspondentCases } = require('./operations.services');
const { knowledge } = require('./knowledge.services');
const { documents } = require('../agents/nay_documental/services');
const { analyticsBi } = require('./analytics.services');
const { constructionObras } = require('../agents/nay_obras/obras.toolServices');
const { legalNay } = require('../agents/nay_juridica/juridica.toolServices');
const { contactStatus, publicListings, handoff } = require('./atendimento.services');
const { crmPipeline, constructionPortfolio, inventoryRisks } = require('./aggregates.services');
const { legalExpiring, withStalledScope } = require('./scoped.services');
const { financeProjection } = require('./financeProjection.services');

function buildToolServices(transaction, scope = {}, { includeWrite = false } = {}) {
  const services = {
    crmOpportunities: crmOpportunities(transaction, scope),
    crmCustomers: crmCustomers(transaction, scope),
    radarMatches: radarMatches(transaction, scope),
    financeHealth: financeHealth(transaction),
    constructionProjects: constructionProjects(transaction),
    legalContracts: legalContracts(transaction),
    correspondentCases: withStalledScope(correspondentCases(transaction, scope), transaction, scope),
    knowledge: knowledge(transaction, scope),
    documents: documents(transaction, scope), // M9-D040: NAY Documental (OCR, classificação, extração e checagem, só leitura e sugestão)
    crmPipeline: crmPipeline(transaction),
    constructionPortfolio: constructionPortfolio(transaction, scope),
    inventoryRisks: inventoryRisks(transaction, scope),
    legalExpiring: legalExpiring(transaction, scope),
    financeProjection: financeProjection(transaction, scope),
    constructionObras: constructionObras(transaction, scope), // M9-D037: NAY Obras (custos, diário, qualidade e pós-obra)
    legalNay: legalNay(transaction, scope), // M9-D038: NAY Jurídica (comparação, checklist e prazos)
    analyticsBi: analyticsBi(transaction, scope), // M9-D695: leitura do BI pela NAY Diretoria (catálogo fechado, sem SQL)
    atendimentoContact: contactStatus(transaction, scope), // M9-D041: NAY Atendimento (contato do contexto, anúncios públicos, encaminhamento)
    atendimentoListings: publicListings(transaction, scope),
    atendimentoHandoff: handoff(transaction, scope),
  };
  if (includeWrite) {
    services.crmTasks = crmTasks(transaction, scope);
    services.financePayments = financePayments(transaction, scope);
    services.legalDrafts = legalDrafts(transaction, scope);
  }
  return { services, readModels: {} };
}

module.exports = { buildToolServices };
