'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'construction.getWarrantyCases',
  version: 1,
  description: 'Pós-obra da obra: chamados de garantia, com situação, severidade, prazo da garantia e referência a cada chamado.',
  permissionCode: 'construction:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'projectId', entity: 'constructionProject' }],
  inputSchema: obj({ projectId: uuid('Identificador da obra.') }, ['projectId']),
  outputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' }, total: { type: 'integer' }, open: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, status: { type: 'string' }, severity: nullable('string'), category: nullable('string'), description: nullable('string'),
            warrantyDeadlineAt: nullable('string'), slaDueAt: nullable('string'),
          },
          required: ['id', 'status'],
        },
      },
      asOf: { type: 'string' },
    },
    required: ['projectId', 'total', 'open', 'items', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.constructionObras.getWarrantyCases(input.projectId),
};
