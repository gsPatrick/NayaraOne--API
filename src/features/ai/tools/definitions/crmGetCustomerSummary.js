'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'crm.getCustomerSummary',
  version: 1,
  description: 'Resumo de um cliente ou lead: cadastro, qualidade dos dados e oportunidades por estágio.',
  permissionCode: 'people:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'personId', entity: 'person' }],
  inputSchema: obj({ personId: uuid('Identificador da pessoa.') }, ['personId']),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' }, personType: { type: 'string' }, legalName: { type: 'string' }, preferredName: nullable('string'), status: { type: 'string' },
      dataQuality: { type: 'object', properties: { score: { type: 'integer' }, missing: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } } } } } },
      opportunities: { type: 'object', properties: { total: { type: 'integer' }, byStage: { type: 'object', additionalProperties: { type: 'integer' } } }, required: ['total'] },
    },
    required: ['id', 'personType', 'legalName', 'status'],
  },
  execute: (ctx, input) => ctx.services.crmCustomers.getSummary(input.personId),
};
