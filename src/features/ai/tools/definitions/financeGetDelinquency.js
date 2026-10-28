'use strict';

const { obj, money } = require('./_schema');

module.exports = {
  name: 'finance.getDelinquency',
  version: 1,
  description: 'Inadimplência calculada pelo sistema: recebíveis vencidos, valor e proporção sobre o total elegível.',
  permissionCode: 'finance:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: { generatedAt: { type: 'string' }, overdueReceivable: money, overduePayable: money, overdueTotal: { type: 'number' }, delinquencyRatio: { type: 'number' } },
    required: ['generatedAt', 'overdueReceivable', 'overdueTotal', 'delinquencyRatio'],
  },
  execute: (ctx) => ctx.services.financeHealth.getDelinquency(),
};
