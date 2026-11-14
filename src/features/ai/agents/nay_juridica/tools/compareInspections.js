'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

// Fechamento M5 (livro §11): a NAY compara a vistoria de entrada com a de saída e SUGERE as diferenças; cada uma vira uma
// recomendação PENDENTE que uma pessoa aceita ou rejeita (responsabilidade e cobrança são decisão humana).
const sourceItem = { type: 'object', properties: { title: { type: 'string' }, version: nullable('string'), clause: nullable('string'), excerpt: nullable('string'), values: { type: 'array', items: { type: 'string' } } } };
const divergence = {
  type: 'object',
  properties: {
    itemId: nullable('string'), itemName: { type: 'string' }, roomCode: nullable('string'), itemCode: nullable('string'), entryCondition: nullable('string'), exitCondition: nullable('string'),
    reason: { type: 'string' }, damageDescription: nullable('string'), estimatedBudget: nullable('number'),
  },
};

module.exports = {
  name: 'legal.compareInspections',
  version: 1,
  description: 'Compara a vistoria de entrada com a de saída do mesmo imóvel: itens que mudaram de condição, sumiram ou apareceram, com dano e orçamento citados da vistoria. Só sugere; a responsabilidade e a cobrança são validadas por uma pessoa.',
  permissionCode: 'legal:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'entryInspectionId', entity: 'legalInspection' }, { arg: 'exitInspectionId', entity: 'legalInspection' }],
  inputSchema: obj({ entryInspectionId: uuid('Vistoria de entrada.'), exitInspectionId: uuid('Vistoria de saída (ou final).') }, ['entryInspectionId', 'exitInspectionId']),
  outputSchema: {
    type: 'object',
    properties: {
      entryInspectionId: { type: 'string' }, exitInspectionId: { type: 'string' }, divergences: { type: 'array', items: divergence }, totalDivergences: { type: 'integer' },
      requiresHumanValidation: { type: 'boolean' }, recommendationIds: { type: 'array', items: { type: 'string' } }, groundingSources: { type: 'array', items: sourceItem }, asOf: { type: 'string' },
    },
    required: ['entryInspectionId', 'exitInspectionId', 'divergences', 'totalDivergences', 'requiresHumanValidation', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.legalNay.compareInspections(input.entryInspectionId, input.exitInspectionId),
};
