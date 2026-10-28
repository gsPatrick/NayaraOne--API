'use strict';

const { uuid, text, obj } = require('./_schema');

module.exports = {
  name: 'crm.createFollowUpTask',
  version: 1,
  description: 'Cria uma tarefa de retorno ao cliente numa oportunidade. Por padrão vira proposta para aprovação.',
  permissionCode: 'crm:tasks:create',
  riskLevel: 'LOW',
  category: 'WRITE',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'opportunityId', entity: 'crmOpportunity' }],
  inputSchema: obj({
    opportunityId: uuid('Identificador da oportunidade.'), title: text('Título da tarefa.', 200),
    description: text('Detalhe da tarefa.', 1000), dueAt: { type: 'string', format: 'date-time', description: 'Prazo da tarefa.' },
  }, ['opportunityId', 'title']),
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, dueAt: { type: ['string', 'null'] } }, required: ['id', 'title', 'status'] },
  execute: (ctx, input) => ctx.services.crmTasks.createFollowUp(input),
};
