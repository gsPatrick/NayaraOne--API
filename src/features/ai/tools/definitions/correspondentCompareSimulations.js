'use strict';

const { uuid, obj } = require('./_schema');

const nullableNumber = { type: ['number', 'null'] };

module.exports = {
  name: 'correspondent.compareSimulations',
  version: 1,
  description: 'Simulações já registradas de um caso de financiamento, lado a lado (valor, prazo, parcela, taxa informada e custo total). Não estima nada novo nem indica aprovação.',
  permissionCode: 'correspondent:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'caseId', entity: 'financingCase' }],
  inputSchema: obj({ caseId: uuid('Identificador do caso de financiamento.') }, ['caseId']),
  outputSchema: {
    type: 'object',
    properties: {
      financingCaseId: { type: 'string' }, source: { type: 'string' }, asOf: { type: 'string' }, referenceAmount: nullableNumber, total: { type: 'integer' }, truncated: { type: 'boolean' }, termsDiffer: { type: 'boolean' },
      simulations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, providerCode: { type: 'string' }, amount: { type: 'number' }, termMonths: { type: 'integer' }, monthlyPayment: { type: 'number' },
            rate: nullableNumber, rateInformed: { type: 'boolean' }, totalCost: { type: 'number' }, createdAt: { type: ['string', 'null'] },
            lowestPayment: { type: 'boolean' }, lowestTotalCost: { type: 'boolean' },
          },
          required: ['id', 'providerCode', 'amount', 'termMonths', 'monthlyPayment'],
        },
      },
    },
    required: ['financingCaseId', 'total', 'simulations'],
  },
  execute: (ctx, input) => ctx.services.correspondentCases.compareSimulations(input.caseId),
};
