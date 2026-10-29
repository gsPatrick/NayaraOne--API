'use strict';

const { File } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const E = require('./retrieval.errors');
const V = require('./ingestion.input');
const { CLASSIFICATIONS } = require('./retrieval.constants');

/**
 * Classificação do arquivo no registro (M9-D022, passo 4): a NAY nunca adivinha a classificação; uma pessoa com `ai:admin` a registra em
 * people.files.classification e só então o arquivo pode ser indexado. A mudança fica na auditoria (antes e depois). A reconciliação
 * (M9-D023) leva a nova classificação aos chunks já indexados.
 */
async function classifyFile(ctx, fileId, body, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(fileId)) throw E.sourceInvalid();
  const classification = body && body.classification;
  if (!CLASSIFICATIONS.includes(classification)) throw E.classifyInvalid('Informe a classificação do documento.');
  const file = await File.findByPk(fileId, { transaction });
  if (!file) throw E.sourceInvalid();
  const before = file.classification || null;
  if (before !== classification) await file.update({ classification, updatedBy: ctx.userId || null }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'files.classification', entityType: 'File', entityId: file.id,
    beforeJson: { classification: before }, afterJson: { classification }, reason: `Documento classificado como ${classification}.`,
  }, transaction);
  return { fileId: file.id, classification };
}

module.exports = { classifyFile };
