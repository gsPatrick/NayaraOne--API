'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'finance.getCashflowProjection',
  version: 1,
  description: 'Projeção de fluxo de caixa calculada pelo sistema; cada valor vem rotulado REALIZADO, PREVISTO ou ESTIMADO.',
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
      generatedAt: { type: 'string' }, source: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { indicator: { type: 'string' }, label: { type: 'string' }, nature: { type: 'string', enum: ['REALIZADO', 'PREVISTO', 'ESTIMADO'] }, value: { type: 'number' } }, required: ['indicator', 'label', 'nature', 'value'] } },
    },
    required: ['generatedAt', 'source', 'items'],
  },
  execute: (ctx) => ctx.services.financeProjection.getCashflow(),
};
