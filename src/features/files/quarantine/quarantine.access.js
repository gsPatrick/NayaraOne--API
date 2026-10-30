'use strict';

const { FileQuarantine } = require('../../../models');
const errors = require('./quarantine.errors');
const { STATUS } = require('./quarantine.constants');

/**
 * assertReleased — a única porta para QUEM USA um arquivo que veio de fora (tela, link, adapter que envia): só o que foi liberado pela quarentena passa. Em verificação: 423
 * INTEGRATION_FILE_QUARANTINED; infectado: 422 INTEGRATION_FILE_INFECTED; recusado ou vencido: 422 INTEGRATION_FILE_REJECTED. Devolve { fileId, sha256, classification } do arquivo promovido.
 */
async function assertReleased(tenant, quarantineId, transaction) {
  const row = await FileQuarantine.findOne({ where: { id: quarantineId, companyId: tenant.companyId }, transaction });
  if (!row) throw errors.notFound();
  if (row.status === STATUS.QUARANTINED) throw errors.quarantined();
  if (row.status === STATUS.INFECTED) throw errors.infected();
  if (row.status !== STATUS.CLEAN) throw errors.rejected(row.status);
  return { fileId: row.promotedFileId, sha256: row.cleanSha256 || row.sha256, classification: 'CONFIDENTIAL' };
}

module.exports = { assertReleased };
