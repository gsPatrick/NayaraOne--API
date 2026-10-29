'use strict';

const { limit, obj } = require('./_schema');

// M9-D041 — anúncios públicos (a mesma visão que o site e os portais recebem do read model público). Nenhum dado de proprietário ou de cliente.
module.exports = {
  name: 'radar.listPublicListings',
  version: 1,
  description: 'Lista os anúncios públicos de imóveis da empresa (código, título, finalidade, tipo, preço público, bairro e cidade).',
  permissionCode: 'properties:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({ limit: limit('Máximo de anúncios devolvidos.', 20) }),
  outputSchema: {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' }, title: { type: 'string' }, purpose: { type: 'string' }, type: { type: 'string' }, price: { type: 'string' },
            neighborhood: { type: ['string', 'null'] }, city: { type: ['string', 'null'] }, bedrooms: { type: ['integer', 'null'] },
          },
          required: ['code', 'title'],
        },
      },
    },
    required: ['total', 'items'],
  },
  execute: (ctx, input) => ctx.services.atendimentoListings.list(input.limit),
};
