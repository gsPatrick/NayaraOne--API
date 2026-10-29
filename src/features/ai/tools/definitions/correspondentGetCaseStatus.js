'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'correspondent.getCaseStatus',
  version: 1,
  description: 'Situação de um caso de financiamento: produto, finalidade, status e quantidade de proponentes.',
  permissionCode: 'correspondent:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'caseId', entity: 'financingCase' }],
  inputSchema: obj({ caseId: uuid('Identificador do caso de financiamento.') }, ['caseId']),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' }, status: { type: 'string' }, product: nullable('string'), purpose: nullable('string'), providerCode: nullable('string'),
      propertyId: nullable('string'), applicantsCount: { type: 'integer' }, canceledReason: nullable('string'),
      source: { type: 'string' }, updatedAt: nullable('string'), asOf: { type: 'string' },
    },
    required: ['id', 'status', 'applicantsCount'],
  },
  execute: (ctx, input) => ctx.services.correspondentCases.getStatus(input.caseId),
};
