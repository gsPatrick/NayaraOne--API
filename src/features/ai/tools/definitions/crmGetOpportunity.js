'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'crm.getOpportunity',
  version: 1,
  description: 'Consulta uma oportunidade do CRM: estágio, temperatura, valor esperado e próxima ação.',
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
    },
    required: ['id', 'personId', 'stage'],
  },
  execute: (ctx, input) => ctx.services.crmOpportunities.getById(input.opportunityId),
};
