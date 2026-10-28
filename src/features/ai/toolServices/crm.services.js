'use strict';

// Serviços de CRM que as tools da NAY podem chamar (M9-D016): sempre os serviços de aplicação existentes, ligados à
// transação do tenant (RLS) e, nas escritas, ao usuário que age. Nada de SQL.
const opportunityService = require('../../crm/opportunity.service');
const { createOpportunityTask } = require('../../crm/opportunityTasks.service');
const personService = require('../../people/person.service');
const { toPlain } = require('./plain');

function crmOpportunities(transaction) {
  return { getById: async (id) => toPlain(await opportunityService.getOpportunity(id, transaction)) };
}

function crmCustomers(transaction) {
  return {
    async getSummary(personId) {
      const pessoa = toPlain(await personService.getPerson(personId, transaction));
      const oportunidades = await opportunityService.listOpportunities(transaction, { personId });
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
