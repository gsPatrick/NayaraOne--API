'use strict';

const { uuid, text, nullable, obj } = require('./_schema');

const EXPECTED = obj({
  name: text('Nome esperado.', 200), taxNumber: text('CPF ou CNPJ esperado.', 30), documentNumber: text('Número do documento esperado.', 60),
  issuedAt: text('Data de emissão esperada.', 40), expiresAt: text('Data de validade esperada.', 40), valor_total: text('Valor total esperado, em reais.', 30),
});

const FINDING = {
  type: 'object',
  properties: {
    code: { type: 'string' }, field: nullable('string'), severity: { type: 'string' }, message: { type: 'string' }, found: nullable('string'), expected: nullable('string'),
  },
  required: ['code', 'severity', 'message'],
};

module.exports = {
  name: 'documents.checkConsistency',
  version: 1,
  description: 'Checa a consistência de um documento da empresa: campo obrigatório ausente, formato inválido, datas incoerentes, documento vencido e divergência contra o que a pessoa informou. Aponta, nunca corrige.',
  permissionCode: 'ai:use',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'fileId', entity: 'file' }],
  inputSchema: obj({ fileId: uuid('Identificador do arquivo da empresa.'), documentType: text('Tipo do documento, se já conhecido.', 40), expected: EXPECTED }, ['fileId']),
  outputSchema: {
    type: 'object',
    properties: {
      fileId: { type: 'string' }, documentType: { type: 'string' }, typeSource: { type: 'string' }, status: { type: 'string' }, overallConfidence: { type: 'number' },
      ok: { type: 'boolean' }, corrected: { type: 'boolean' }, findings: { type: 'array', items: FINDING }, checked: { type: 'array', items: { type: 'string' } },
      requiresHumanConfirmation: { type: 'boolean' }, persisted: { type: 'boolean' }, source: { type: 'string' }, asOf: { type: 'string' },
    },
    required: ['fileId', 'ok', 'findings', 'corrected', 'persisted'],
  },
  execute: (ctx, input) => ctx.services.documents.checkConsistency(input.fileId, input.documentType, input.expected),
};
