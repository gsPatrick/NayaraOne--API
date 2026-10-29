'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'inventory.getStockRisks',
  version: 1,
  description: 'Risco de falta de estoque calculado pelo sistema: itens em risco por nível e itens com risco de ruptura.',
  permissionCode: 'inventory:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, source: { type: 'string' }, windowDays: { type: 'integer' }, atRiskCount: { type: 'integer' }, stockoutCount: { type: 'integer' },
      byLevel: { type: 'object', properties: { HIGH: { type: 'integer' }, MEDIUM: { type: 'integer' }, LOW: { type: 'integer' } }, required: ['HIGH', 'MEDIUM', 'LOW'] },
    },
    required: ['generatedAt', 'source', 'atRiskCount', 'stockoutCount', 'byLevel'],
  },
  execute: (ctx) => ctx.services.inventoryRisks.getRisks(),
};
