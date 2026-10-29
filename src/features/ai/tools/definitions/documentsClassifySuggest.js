'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'documents.classifySuggest',
  version: 1,
  description: 'Sugere o tipo de um documento da empresa (RG, comprovante de renda, nota fiscal...) com a confiança e as evidências. É só sugestão: não grava a classificação.',
  permissionCode: 'ai:use',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'fileId', entity: 'file' }],
  inputSchema: obj({ fileId: uuid('Identificador do arquivo da empresa.') }, ['fileId']),
  outputSchema: {
    type: 'object',
    properties: {
      fileId: { type: 'string' }, fileName: { type: 'string' }, suggestedType: { type: 'string' }, confidence: { type: 'number' }, lowConfidence: { type: 'boolean' },
      minConfidence: { type: 'number' }, alternatives: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, confidence: { type: 'number' } }, required: ['type', 'confidence'] } },
      evidence: { type: 'array', items: { type: 'string' } }, requiresHumanConfirmation: { type: 'boolean' }, persisted: { type: 'boolean' }, source: { type: 'string' },
      recommendationId: nullable('string'), asOf: { type: 'string' },
    },
    required: ['fileId', 'suggestedType', 'confidence', 'requiresHumanConfirmation', 'persisted'],
  },
  execute: (ctx, input) => ctx.services.documents.classifySuggest(input.fileId),
};
