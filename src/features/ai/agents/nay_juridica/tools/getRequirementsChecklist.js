'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'legal.getRequirementsChecklist',
  version: 1,
  description: 'Checklist de requisitos do contrato: quais estão satisfeitos, pendentes ou dispensados, com a referência a cada requisito.',
  permissionCode: 'legal:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'contractId', entity: 'legalContract' }],
  inputSchema: obj({ contractId: uuid('Identificador do contrato.') }, ['contractId']),
  outputSchema: {
    type: 'object',
    properties: {
      contractId: { type: 'string' }, contractNumber: nullable('string'), total: { type: 'integer' }, satisfied: { type: 'integer' }, pending: { type: 'integer' }, waived: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, code: { type: 'string' }, description: nullable('string'), type: nullable('string'), status: { type: 'string' }, satisfiedAt: nullable('string') },
          required: ['id', 'code', 'status'],
        },
      },
      asOf: { type: 'string' },
    },
    required: ['contractId', 'total', 'satisfied', 'pending', 'waived', 'items', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.legalNay.getRequirementsChecklist(input.contractId),
};
