'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'crm.getPipelineSummary',
  version: 1,
  description: 'Funil comercial calculado pelo sistema: oportunidades em aberto por etapa, com quantidade e valor esperado.',
  permissionCode: 'crm:opportunities:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, source: { type: 'string' }, openCount: { type: 'integer' }, openValue: { type: 'number' },
      byStage: { type: 'array', items: { type: 'object', properties: { stage: { type: 'string' }, count: { type: 'integer' }, value: { type: 'number' } }, required: ['stage', 'count', 'value'] } },
    },
    required: ['generatedAt', 'source', 'openCount', 'openValue', 'byStage'],
  },
  execute: (ctx) => ctx.services.crmPipeline.getSummary(),
};
