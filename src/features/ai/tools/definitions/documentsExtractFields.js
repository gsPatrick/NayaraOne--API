'use strict';

const { uuid, text, nullable, obj } = require('./_schema');

const FIELD = {
  type: 'object',
  properties: {
    name: { type: 'string' }, value: { type: 'string' }, confidence: { type: 'number' },
    source: { type: 'object', properties: { fileId: { type: 'string' }, page: { type: ['integer', 'null'] } }, required: ['fileId'] },
  },
  required: ['name', 'value', 'confidence', 'source'],
};

module.exports = {
  name: 'documents.extractFields',
  version: 1,
  description: 'Extrai campos de um documento da empresa (ProposedExtraction): cada campo com valor, confiança e fonte (arquivo e página). É só sugestão: nada é gravado até uma pessoa confirmar.',
  permissionCode: 'ai:use',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'fileId', entity: 'file' }],
  inputSchema: obj({ fileId: uuid('Identificador do arquivo da empresa.'), documentType: text('Tipo do documento, se já conhecido (ex.: RG, INVOICE_NF).', 40) }, ['fileId']),
  outputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string' }, fileId: { type: 'string' }, fileName: { type: 'string' }, documentType: { type: 'string' }, typeSource: { type: 'string' }, status: { type: 'string' },
      overallConfidence: { type: 'number' }, minConfidence: { type: 'number' }, fields: { type: 'array', items: FIELD }, requiresHumanConfirmation: { type: 'boolean' },
      persisted: { type: 'boolean' }, pending: nullable('string'), source: { type: 'string' }, recommendationId: nullable('string'), asOf: { type: 'string' },
    },
    required: ['kind', 'fileId', 'documentType', 'status', 'fields', 'requiresHumanConfirmation', 'persisted'],
  },
  execute: (ctx, input) => ctx.services.documents.extractFields(input.fileId, input.documentType),
};
