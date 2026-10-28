'use strict';

const { obj, money } = require('./_schema');

const janela = { type: 'object', properties: { payable: money, receivable: money }, required: ['payable', 'receivable'] };

module.exports = {
  name: 'finance.getWeeklyHealth',
  version: 1,
  description: 'Saúde financeira da semana calculada pelo sistema: a pagar, a receber, vencidos e próximos vencimentos.',
  permissionCode: 'finance:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, windowEndsAt: { type: 'string' },
      payablePending: money, receivablePending: money, projectedNetBalance: { type: 'number' },
      overdue: { type: 'object', properties: { payable: money, receivable: money, total: { type: 'number' } }, required: ['payable', 'receivable', 'total'] },
      dueNextSevenDays: janela, dueNext30Days: janela, dueNext60Days: janela,
      delinquencyRatio: { type: 'number' },
    },
    required: ['generatedAt', 'payablePending', 'receivablePending', 'projectedNetBalance', 'overdue'],
  },
  execute: (ctx) => ctx.services.financeHealth.getWeekly(),
};
