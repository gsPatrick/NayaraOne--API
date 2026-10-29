'use strict';

const { uuid, limit, nullable, obj } = require('./_schema');

module.exports = {
  name: 'radar.listMatchesForOpportunity',
  version: 1,
  description: 'Lista os imóveis que combinam com o Radar de busca ligado a uma oportunidade, por pontuação do Radar e com o motivo do match.',
  permissionCode: 'radar:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'opportunityId', entity: 'crmOpportunity' }],
  inputSchema: obj({ opportunityId: uuid('Identificador da oportunidade.'), limit: limit('Máximo de imóveis devolvidos.', 50) }, ['opportunityId']),
  outputSchema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string' },
      radars: { type: 'integer' },
      total: { type: 'integer' },
      hasMore: { type: 'boolean' },
      extra: { type: 'integer' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: { propertyId: { type: 'string' }, radarId: { type: 'string' }, score: { type: ['number', 'null'] }, title: nullable('string'), city: nullable('string'), reason: nullable('string') },
          required: ['propertyId'],
        },
      },
    },
    required: ['opportunityId', 'radars', 'matches'],
  },
  execute: (ctx, input) => ctx.services.radarMatches.listForOpportunity(input.opportunityId, input.limit),
};
