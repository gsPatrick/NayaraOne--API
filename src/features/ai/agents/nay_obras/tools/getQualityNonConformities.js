'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'construction.getQualityNonConformities',
  version: 1,
  description: 'Qualidade da obra: não conformidades abertas e encerradas, com severidade, situação e referência a cada registro.',
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
      projectId: { type: 'string' }, total: { type: 'integer' }, open: { type: 'integer' }, closed: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, severity: nullable('string'), status: { type: 'string' }, description: nullable('string'), openedAt: nullable('string'), closedAt: nullable('string'), slaDueAt: nullable('string'),
          },
          required: ['id', 'status'],
        },
      },
      asOf: { type: 'string' },
    },
    required: ['projectId', 'total', 'open', 'closed', 'items', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.constructionObras.getQualityNonConformities(input.projectId),
};
