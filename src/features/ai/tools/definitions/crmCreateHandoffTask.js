'use strict';

const { text, obj } = require('./_schema');

// M9-D041 — encaminhamento a uma pessoa. Chamado pela identidade de serviço do canal (`servicePath: INFORMATIVE`) deixa só uma recomendação
// informativa HANDOFF para o responsável; chamado por uma pessoa segue a regra geral das escritas (proposta, D019). Sem id de contato:
// o contato é o do contexto da conversa.
module.exports = {
  name: 'crm.createHandoffTask',
  version: 1,
  description: 'Encaminha a conversa a um atendente humano com o motivo e um resumo curto. Não cria tarefa por conta própria nem promete retorno em nome da empresa.',
  permissionCode: 'crm:tasks:create',
  servicePermissionCode: 'ai:read',
  servicePath: 'INFORMATIVE',
  riskLevel: 'MEDIUM',
  category: 'WRITE',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({
    topic: { type: 'string', enum: ['FORA_DA_POLITICA', 'CANAL_EXTERNO', 'SOLICITACAO_HUMANA', 'OUTRO'], description: 'Motivo do encaminhamento.' },
    summary: text('Resumo curto do pedido do cliente, sem dados pessoais.', 500),
  }, ['topic', 'summary']),
  outputSchema: {
    type: 'object',
    properties: { recommendationId: { type: 'string' }, status: { type: 'string' }, replayed: { type: 'boolean' }, assigned: { type: 'boolean' } },
    required: ['recommendationId', 'status'],
  },
  execute: (ctx, input) => ctx.services.atendimentoHandoff.create(input),
};
