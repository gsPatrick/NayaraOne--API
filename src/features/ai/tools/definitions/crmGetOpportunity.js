'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'crm.getOpportunity',
  version: 1,
  description: 'Consulta uma oportunidade do CRM: estágio, valor esperado, próxima ação e a atividade (última interação, dias sem contato, tarefas abertas, propostas sem resposta e documentos pendentes).',
  permissionCode: 'crm:opportunities:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'opportunityId', entity: 'crmOpportunity' }],
  inputSchema: obj({ opportunityId: uuid('Identificador da oportunidade.') }, ['opportunityId']),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' }, personId: { type: 'string' }, propertyId: nullable('string'), ownerUserId: nullable('string'),
      stage: { type: 'string' }, temperature: nullable('string'), expectedValue: { type: ['string', 'number', 'null'] },
      nextAction: nullable('string'), nextActionDueAt: nullable('string'), closedAt: nullable('string'),
      lostReason: nullable('string'), wonReason: nullable('string'), withdrawnReason: nullable('string'),
      activity: {
        type: 'object',
        properties: {
          lastInteractionAt: nullable('string'), daysWithoutContact: { type: ['integer', 'null'] }, contactBase: { type: 'string' }, asOf: { type: 'string' },
          interactions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, occurredAt: { type: 'string' }, channel: nullable('string'), direction: nullable('string'), status: nullable('string') } } },
          openTasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: nullable('string'), dueAt: nullable('string'), status: { type: 'string' } } } },
          sentProposals: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: nullable('string'), sentAt: { type: 'string' }, daysSinceSent: { type: ['integer', 'null'] }, unanswered: { type: 'boolean' } } } },
          pendingDocuments: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: ['id', 'personId', 'stage'],
  },
  execute: (ctx, input) => ctx.services.crmOpportunities.getById(input.opportunityId),
};
