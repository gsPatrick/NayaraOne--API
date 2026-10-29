'use strict';

const { exportDimobFile, listDimobRecords } = require('../../../../correspondent/fiscal/dimob.service');
const { pick, UUID } = require('./filters');
const { filterInvalid } = require('../export.errors');

const need = (filter) => { if (!filter.batchId) throw filterInvalid({ field: 'batchId' }); return filter; };

/**
 * Arquivo anual da DIMOB, antes GET /fiscal/dimob-batches/:id/file. O leiaute é o do lote (versionado por ano, com colunas escolhidas pela empresa em Fiscal): por isso é
 * arquivo pronto (`ready`), só CSV, sem escolha de colunas, e a máscara por coluna não se aplica (o arquivo é o documento fiscal).
 */
module.exports = {
  code: 'correspondent.dimob',
  label: 'Arquivo da DIMOB',
  onDemand: true,
  formats: ['CSV'],
  permission: 'correspondent:fiscal',
  fixedLayout: true,
  sourceFiles: ['features/correspondent/fiscal/dimob.service.js'],
  lineage: { existingExportCode: 'dimob.file' },
  columns: [],
  parseFilter: (filter) => need(pick(filter, ['batchId'], { batchId: UUID })),
  estimate: async (ctx, filter, transaction) => (await listDimobRecords(filter.batchId, ctx.groupId, ctx.companyId, transaction)).records.length,
  collect: async (ctx, filter, transaction) => {
    const file = await exportDimobFile(filter.batchId, ctx.userId, ctx.groupId, ctx.companyId, transaction);
    return { ready: { text: file.content, fileName: file.fileName, mimeType: file.contentType }, rowCount: file.content.split('\n').filter((l) => l && !l.startsWith('#')).length - 1 };
  },
};
