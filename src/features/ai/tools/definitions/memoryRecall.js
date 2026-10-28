'use strict';

const { text, limit, obj } = require('./_schema');
const { aiNotAvailable } = require('../../ai.errors');

module.exports = {
  name: 'memory.recall',
  version: 1,
  description: 'Recupera fatos estruturados que a NAY guardou sobre o assunto (nunca a conversa inteira).',
  permissionCode: 'ai:use',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({ subject: text('Assunto ou chave do fato.', 120), limit: limit('Máximo de fatos devolvidos.', 20) }),
  outputSchema: {
    type: 'object',
    properties: { facts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, expiresAt: { type: ['string', 'null'] } }, required: ['key', 'value'] } } },
    required: ['facts'],
  },
  // O serviço de memória é da M9-D009; sem ele registrado a tool responde que ainda não está disponível.
  execute: (ctx, input) => {
    if (!('memory' in ctx.services)) throw aiNotAvailable('memory');
    return ctx.services.memory.recall(input.subject, input.limit);
  },
};
