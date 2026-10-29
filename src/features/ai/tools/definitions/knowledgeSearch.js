'use strict';

const { text, limit, obj } = require('./_schema');

module.exports = {
  name: 'knowledge.search',
  version: 1,
  description: 'Busca na base de conhecimento homologada da empresa (políticas e regras vigentes).',
  permissionCode: 'ai:use',
  servicePermissionCode: 'ai:read', // M9-D041: a identidade de serviço de um canal é só de leitura e lê o conhecimento com ai:read
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({ query: text('Termo da busca.', 200), limit: limit('Máximo de itens devolvidos.', 20) }, ['query']),
  outputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, version: { type: 'integer' }, classification: { type: 'string' }, summary: { type: 'string' } },
          required: ['id', 'title'],
        },
      },
    },
    required: ['items'],
  },
  execute: (ctx, input) => ctx.services.knowledge.search(input.query, input.limit),
};
