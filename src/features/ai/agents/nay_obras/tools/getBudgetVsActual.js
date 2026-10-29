'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

module.exports = {
  name: 'construction.getBudgetVsActual',
  version: 1,
  description: 'Custos de uma obra: orçado (orçamento base mais mudanças aprovadas) x realizado (pago mais estoque consumido), desvio em reais e em percentual.',
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
      projectId: { type: 'string' }, code: nullable('string'), name: nullable('string'), budgeted: { type: 'string' }, actual: { type: 'string' }, deviation: { type: 'string' },
      deviationPct: nullable('string'), overBudget: { type: 'boolean' }, projectedTotalCost: { type: 'string' }, asOf: { type: 'string' },
      sources: { type: 'array', items: { type: 'object', properties: { entity: { type: 'string' }, id: { type: 'string' } } } },
    },
    required: ['projectId', 'budgeted', 'actual', 'deviation', 'overBudget', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.constructionObras.getBudgetVsActual(input.projectId),
};
