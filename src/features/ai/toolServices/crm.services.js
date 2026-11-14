'use strict';

// Serviços de CRM que as tools da NAY podem chamar (M9-D016): sempre os serviços de aplicação existentes, ligados à
// transação do tenant (RLS) e, nas escritas, ao usuário que age. Nada de SQL.
const opportunityService = require('../../crm/opportunity.service');
const { createOpportunityTask } = require('../../crm/opportunityTasks.service');
const personService = require('../../people/person.service');
const { toPlain } = require('./plain');
const { loadOpportunityFacts } = require('../agents/nay_comercial/comercial.data');
const { readComercialParams } = require('../agents/nay_comercial/comercial.params');
const { scopeOfToolScope } = require('../agents/nay_comercial/comercial.scope');

/**
 * Oportunidade com a atividade calculada pelo código (M9-D034): interações recentes, dias sem contato, tarefas abertas, propostas enviadas sem
 * resposta e documentos pendentes. O modelo lê esses fatos; nunca calcula.
 */
function crmOpportunities(transaction, scope = {}) {
  return {
    async getById(id) {
      // Escopo de carteira (livro do Marco 3 §18): o corretor (read:own) só lê a oportunidade de que é responsável; a de outro é 404.
      const ownerScope = scopeOfToolScope(scope);
      const facts = await loadOpportunityFacts(id, transaction, { now: new Date(), ownerScope });
      const base = toPlain(await opportunityService.getOpportunity(id, transaction));
      const params = await readComercialParams({ groupId: scope.groupId, companyId: scope.companyId }, transaction);
      return {
        ...base,
        activity: {
          lastInteractionAt: facts.lastInteractionAt, daysWithoutContact: facts.daysWithoutContact, contactBase: facts.contactBase,
          interactions: facts.interactions.slice(0, params.summaryInteractions), openTasks: facts.openTasks, sentProposals: facts.proposals, pendingDocuments: facts.pendingDocuments, asOf: facts.asOf,
        },
      };
    },
  };
}

function crmCustomers(transaction, scope = {}) {
  return {
    async getSummary(personId) {
      const pessoa = toPlain(await personService.getPerson(personId, transaction));
      // Na carteira própria (read:own), a contagem por etapa só considera as oportunidades de que o corretor é responsável.
      const oportunidades = await opportunityService.listOpportunities(transaction, { personId, ownerScope: scopeOfToolScope(scope) });
      const byStage = {};
      for (const o of oportunidades) byStage[o.stage] = (byStage[o.stage] || 0) + 1;
      return { ...pessoa, opportunities: { total: oportunidades.length, byStage } };
    },
  };
}

/** Escrita: só entra no contexto quando a aprovação (M9-D019) ou a política de baixo risco liberou a execução. */
function crmTasks(transaction, { userId }) {
  return {
    async createFollowUp(input) {
      const task = await createOpportunityTask(
        input.opportunityId, { title: input.title, description: input.description, dueAt: input.dueAt, priority: 'NORMAL' }, userId, transaction
      );
      return toPlain(task);
    },
  };
}

module.exports = { crmOpportunities, crmCustomers, crmTasks };
