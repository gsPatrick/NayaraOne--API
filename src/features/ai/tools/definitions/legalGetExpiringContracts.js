'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'legal.getExpiringContracts',
  version: 1,
  description: 'Contratos ativos a vencer por faixa de dias, calculados pelo sistema. Para a Diretoria devolve só quantidade e valor por faixa; a lista nominal é dos agentes do jurídico.',
  permissionCode: 'legal:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, source: { type: 'string' }, mode: { type: 'string' },
      bands: { type: 'array', items: { type: 'object', properties: { fromDays: { type: 'integer' }, toDays: { type: 'integer' }, count: { type: 'integer' }, total: { type: 'number' } }, required: ['fromDays', 'toDays', 'count', 'total'] } },
      contracts: { type: 'array', items: { type: 'object', properties: { contractId: { type: 'string' }, contractNumber: { type: ['string', 'null'] }, endsAt: { type: 'string' }, daysLeft: { type: 'integer' }, value: { type: 'number' } }, required: ['contractId', 'endsAt', 'daysLeft', 'value'] } },
    },
    required: ['generatedAt', 'source', 'mode', 'bands'],
  },
  execute: (ctx) => ctx.services.legalExpiring.getExpiring(),
};
