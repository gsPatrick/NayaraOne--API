'use strict';

const { obj } = require('./_schema');

// Compartilhada entre agentes (M9-D035 e M9-D039): para a Diretoria (escopo `correspondent.summary`) a saída traz `byStage` e nenhum caso;
// para o agente do Correspondente traz `items` com o motivo de cada caso. O escopo é aplicado no servidor (toolServices/scoped.services.js).
module.exports = {
  name: 'correspondent.getStalledCases',
  version: 1,
  description: 'Casos de financiamento parados além do limiar do Correspondente (dias sem atividade). Para a Diretoria devolve só a quantidade por etapa; a lista com o motivo de cada caso é dos agentes do correspondente.',
  permissionCode: 'correspondent:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' }, asOf: { type: 'string' }, mode: { type: 'string' }, thresholdDays: { type: 'integer' }, total: { type: 'integer' }, truncated: { type: 'boolean' },
      byStage: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, count: { type: 'integer' } }, required: ['status', 'count'] } },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            financingCaseId: { type: 'string' }, status: { type: 'string' }, idleDays: { type: 'integer' }, reason: { type: 'string' },
            pendingRequirementTypes: { type: 'array', items: { type: 'string' } },
          },
          required: ['financingCaseId', 'status', 'idleDays'],
        },
      },
    },
    required: ['source', 'thresholdDays', 'total'],
  },
  execute: (ctx) => ctx.services.correspondentCases.getStalledCases(),
};
