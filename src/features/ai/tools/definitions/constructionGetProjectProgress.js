'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'construction.getProjectProgress',
  version: 1,
  description: 'Andamento físico e de prazo de uma obra: avanço medido, avanço planejado, atraso e margem projetada.',
  permissionCode: 'construction:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'projectId', entity: 'constructionProject' }],
  inputSchema: obj({ projectId: uuid('Identificador da obra.') }, ['projectId']),
  outputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' }, physicalProgressPct: { type: 'number' }, plannedProgressPct: { type: 'number' },
      scheduleProgressPct: { type: ['number', 'null'] }, scheduleDelayDays: { type: 'integer' }, isOverdue: { type: 'boolean' },
      baselineBudget: { type: 'number' }, projectedTotalCost: { type: 'number' }, projectedMargin: { type: 'number' },
      marginPct: { type: ['number', 'null'] }, belowMinMargin: { type: ['boolean', 'null'] }, updatedAt: nullable('string'),
    },
    required: ['projectId', 'physicalProgressPct', 'plannedProgressPct', 'scheduleDelayDays', 'isOverdue'],
  },
  execute: (ctx, input) => ctx.services.constructionProjects.getProgress(input.projectId),
};
