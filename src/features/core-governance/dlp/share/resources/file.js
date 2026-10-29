'use strict';

const { getFileContent } = require('../../../../files/files.service');
const { assertCanReadFile } = require('../../../../files/fileAccess.service');
const { notShareable, watermarkUnsupported } = require('../share.errors');

const MARKABLE = ['text/csv'];

/**
 * Arquivo avulso (people.files): o link entrega o próprio arquivo. Quem compartilha precisa poder ler o arquivo (as mesmas regras do download autenticado) e documento
 * RESTRICTED do Correspondente não se compartilha. A marca d'água só se aplica a texto/CSV (acrescenta a linha final); outro tipo cuja classe exige marca é recusado na criação.
 */
module.exports = {
  code: 'files.file',
  label: 'Arquivo avulso',
  permission: null,
  fields: { id: 'LOW', fileName: 'MEDIUM', mimeType: 'LOW', sizeBytes: 'LOW', checksumSha256: 'LOW' },
  canMark: (mimeType) => MARKABLE.includes(String(mimeType || '').toLowerCase()),
  async assertShareable(ctx, id, transaction) {
    const { file, restricted } = await assertCanReadFile(id, { userId: ctx.userId, companyId: ctx.companyId, permissions: ctx.permissions }, transaction);
    if (restricted) throw notShareable();
    return file;
  },
  assertWatermarkable(file) {
    if (!MARKABLE.includes(String(file.mimeType || '').toLowerCase())) throw watermarkUnsupported();
  },
  async load(_ctx, id, transaction) {
    let file;
    try { file = await getFileContent(id, transaction, null); } catch (_e) { return null; }
    return {
      data: { id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256 },
      file: { buffer: file.getDataValue('content'), fileName: file.fileName, mimeType: file.mimeType },
    };
  },
};
