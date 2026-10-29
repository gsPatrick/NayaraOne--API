'use strict';

const { obj } = require('./_schema');

// M9-D041 — status público de atendimento do contato da conversa. Sem argumentos: o contato é o do contexto (definido pelo servidor),
// por isso dado de outro cliente é inalcançável por esta tool.
module.exports = {
  name: 'crm.getCustomerContactStatus',
  version: 1,
  description: 'Informa se o contato desta conversa está identificado e quantas solicitações ele tem por etapa. Não recebe identificador: usa sempre o contato da conversa.',
  permissionCode: 'crm:opportunities:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: { known: { type: 'boolean' }, opportunities: { type: 'integer' }, byStage: { type: 'object', additionalProperties: { type: 'integer' } } },
    required: ['known', 'opportunities', 'byStage'],
  },
  execute: (ctx) => ctx.services.atendimentoContact.get(),
};
