'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'legal.getDeadlines',
  version: 1,
  description: 'Prazos dos processos do contrato, com a fonte (documento ou evento de origem). Prazo sem fonte exata precisa de confirmação humana.',
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
      contractId: { type: 'string' }, contractNumber: nullable('string'), currentVersion: nullable('integer'), total: { type: 'integer' },
      deadlines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, description: nullable('string'), dueAt: { type: 'string' }, status: { type: 'string' }, overdue: { type: 'boolean' },
            caseNumber: nullable('string'), sourceDocument: nullable('string'), sourceEvent: nullable('string'),
          },
          required: ['id', 'dueAt', 'status', 'overdue'],
        },
      },
      groundingSources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, version: nullable('string'), clause: nullable('string'), excerpt: nullable('string'), values: { type: 'array', items: { type: 'string' } } } } },
      asOf: { type: 'string' },
    },
    required: ['contractId', 'total', 'deadlines', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.legalNay.getDeadlines(input.contractId),
};
