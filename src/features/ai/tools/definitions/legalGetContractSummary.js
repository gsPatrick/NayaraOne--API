'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'legal.getContractSummary',
  version: 1,
  description: 'Resumo de um contrato: tipo, número, situação, valor, vigência, versão vigente e os trechos dela, cada um citado com contrato, versão e trecho.',
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
      // M9-D038: versão vigente e os trechos dela, cada um citado com contrato, versão e trecho (fontes exatas da resposta).
      currentVersion: { type: ['object', 'null'], properties: { number: { type: 'integer' }, id: { type: 'string' }, contentHash: nullable('string') } },
      clauses: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, title: { type: 'string' }, version: { type: 'integer' } } } },
      groundingSources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, version: nullable('string'), clause: nullable('string'), excerpt: nullable('string'), values: { type: 'array', items: { type: 'string' } } } } },
      asOf: nullable('string'),
    },
    required: ['id', 'contractType', 'status', 'versionsCount'],
  },
  execute: (ctx, input) => ctx.services.legalNay.getContractSummary(input.contractId),
};
