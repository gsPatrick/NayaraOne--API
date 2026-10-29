'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'construction.getPortfolioProgress',
  version: 1,
  description: 'Carteira de obras em execução calculada pelo sistema: quantidade, atrasadas, abaixo da margem mínima e avanço médio.',
  permissionCode: 'construction:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, source: { type: 'string' }, activeCount: { type: 'integer' }, overdueCount: { type: 'integer' }, belowMinMarginCount: { type: 'integer' },
      avgPhysicalProgressPct: { type: 'number' }, avgPlannedProgressPct: { type: 'number' }, truncated: { type: 'boolean' },
    },
    required: ['generatedAt', 'source', 'activeCount', 'overdueCount', 'belowMinMarginCount', 'avgPhysicalProgressPct', 'avgPlannedProgressPct'],
  },
  execute: (ctx) => ctx.services.constructionPortfolio.getProgress(),
};
