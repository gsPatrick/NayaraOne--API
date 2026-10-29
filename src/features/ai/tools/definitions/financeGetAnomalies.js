'use strict';

const { obj } = require('./_schema');

module.exports = {
  name: 'finance.getAnomalies',
  version: 1,
  description: 'Anomalias financeiras abertas e os limiares da regra FIN-005 em vigor; somente leitura.',
  permissionCode: 'finance:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  inputSchema: obj({}),
  outputSchema: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' }, source: { type: 'string' }, openCount: { type: 'integer' },
      rule: { type: 'object', properties: { code: { type: 'string' }, ruleVersionId: { type: ['string', 'null'] }, historyMultiplier: { type: 'number' }, newAccountThreshold: { type: 'number' }, cooldownHours: { type: 'number' } }, required: ['code'] },
      byRisk: { type: 'object', properties: { LOW: { type: 'integer' }, MEDIUM: { type: 'integer' }, HIGH: { type: 'integer' }, CRITICAL: { type: 'integer' } } },
      items: { type: 'array', items: { type: 'object', properties: { caseId: { type: 'string' }, caseType: { type: 'string' }, riskLevel: { type: 'string' }, reason: { type: 'string' }, relatedEntityId: { type: ['string', 'null'] }, createdAt: { type: 'string' } }, required: ['caseId', 'caseType', 'riskLevel'] } },
    },
    required: ['generatedAt', 'source', 'openCount', 'rule', 'byRisk', 'items'],
  },
  execute: (ctx) => ctx.services.financeProjection.getAnomalies(),
};
