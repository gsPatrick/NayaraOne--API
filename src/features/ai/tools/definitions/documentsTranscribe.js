'use strict';

const { uuid, nullable, obj } = require('./_schema');

module.exports = {
  name: 'documents.transcribe',
  version: 1,
  description: 'OCR: texto de um arquivo da empresa já verificado pelo antivírus (PDF, Word, imagem ou áudio), cortado no tamanho máximo, com a referência ao arquivo. Não grava o texto.',
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
      fileId: { type: 'string' }, fileName: { type: 'string' }, mimeType: { type: 'string' }, source: { type: 'string' }, scanStatus: { type: 'string' }, method: { type: 'string' },
      provider: nullable('string'), totalChars: { type: 'integer' }, returnedChars: { type: 'integer' }, truncated: { type: 'boolean' }, text: { type: 'string' },
      textSha256: { type: 'string' }, persisted: { type: 'boolean' }, asOf: { type: 'string' },
    },
    required: ['fileId', 'text', 'scanStatus', 'persisted'],
  },
  execute: (ctx, input) => ctx.services.documents.transcribe(input.fileId),
};
