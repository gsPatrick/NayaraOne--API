'use strict';

const { uuid, obj } = require('./_schema');

module.exports = {
  name: 'correspondent.getPendingRequirements',
  version: 1,
  description: 'Exigências abertas de um caso de financiamento: documentos do checklist ainda não validados, com o estado e a data de cada um.',
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
      financingCaseId: { type: 'string' }, caseStatus: { type: 'string' }, source: { type: 'string' }, asOf: { type: 'string' }, total: { type: 'integer' }, requiredOpen: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requirementId: { type: 'string' }, documentType: { type: 'string' }, documentLabel: { type: 'string' }, required: { type: 'boolean' },
            status: { type: 'string' }, statusLabel: { type: 'string' }, updatedAt: { type: ['string', 'null'] },
          },
          required: ['documentType', 'documentLabel', 'required', 'status'],
        },
      },
    },
    required: ['financingCaseId', 'caseStatus', 'total', 'items'],
  },
  execute: (ctx, input) => ctx.services.correspondentCases.getPendingRequirements(input.caseId),
};
