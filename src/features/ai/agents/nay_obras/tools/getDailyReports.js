'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'construction.getDailyReports',
  version: 1,
  description: 'Resumo do diário de obra (RDO) na janela configurada: serviços, ocorrências e bloqueios, cada um com a referência ao diário.',
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
      projectId: { type: 'string' }, windowDays: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' }, totalInWindow: { type: 'integer' }, withBlockages: { type: 'integer' },
      reports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, reportDate: { type: 'string' }, servicesPerformed: nullable('string'), occurrences: nullable('string'), blockages: nullable('string'),
            workforceCount: nullable('integer'), weather: nullable('string'),
          },
          required: ['id', 'reportDate'],
        },
      },
      asOf: { type: 'string' },
    },
    required: ['projectId', 'windowDays', 'totalInWindow', 'withBlockages', 'reports', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.constructionObras.getDailyReports(input.projectId),
};
