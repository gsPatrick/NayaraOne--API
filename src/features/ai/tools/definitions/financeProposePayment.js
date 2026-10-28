'use strict';

const { uuid, obj } = require('./_schema');

module.exports = {
  name: 'finance.proposePayment',
  version: 1,
  description: 'Propõe a intenção de pagamento de um lançamento a pagar. Sempre proposta: nunca paga sem aprovação humana.',
  permissionCode: 'finance:create',
  riskLevel: 'CRITICAL',
  category: 'WRITE',
  domain: 'FINANCIAL',
  requiresHumanApproval: true,
  idempotent: false,
  entityRefs: [{ arg: 'financialEntryId', entity: 'financialEntry' }],
  inputSchema: obj({ financialEntryId: uuid('Identificador do lançamento financeiro a pagar.') }, ['financialEntryId']),
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, financialEntryId: { type: 'string' } }, required: ['id', 'status'] },
  execute: (ctx, input) => ctx.services.financePayments.proposeIntent(input.financialEntryId),
};
