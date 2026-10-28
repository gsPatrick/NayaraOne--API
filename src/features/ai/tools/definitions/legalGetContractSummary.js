'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'legal.getContractSummary',
  version: 1,
  description: 'Resumo de um contrato: tipo, número, situação, valor, vigência e quantidade de versões.',
  permissionCode: 'legal:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'contractId', entity: 'legalContract' }],
  inputSchema: obj({ contractId: uuid('Identificador do contrato.') }, ['contractId']),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' }, contractType: { type: 'string' }, contractNumber: nullable('string'), status: { type: 'string' },
      totalValue: { type: ['string', 'number', 'null'] }, startsAt: nullable('string'), endsAt: nullable('string'), versionsCount: { type: 'integer' },
    },
    required: ['id', 'contractType', 'status', 'versionsCount'],
  },
  execute: (ctx, input) => ctx.services.legalContracts.getSummary(input.contractId),
};
