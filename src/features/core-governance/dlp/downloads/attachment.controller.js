'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { File } = require('../../../../models');
const { govError, govNotFound } = require('../../governance.errors');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const scale = require('../../../../shared/data-classification/scale');
const { checkExplicitClass } = require('./attachment.class');
const { assertUuid } = require('./download.input');

/**
 * PUT /files/:id/classification (M9-D920 §3.2): a classe do anexo só muda por quem tem `governance:classification:manage` (a rota exige a permissão). Corpo { classification }
 * (LOW, MEDIUM, HIGH ou RESTRICTED). A mudança fica na auditoria `files.classification` com antes e depois; valor igual não grava nem audita.
 */
const putClassification = catchAsync(async (req, res) => {
  const value = checkExplicitClass(req.body && req.body.classification, req.auth.permissions);
  if (!value) throw govError(400, 'GOV_FILE_CLASSIFICATION_INVALID', 'Informe a classificação do arquivo.');
  const data = await req.withTenantTransaction(async (transaction) => {
    const file = await File.findByPk(assertUuid(req.params.id), { transaction, lock: transaction.LOCK.UPDATE });
    if (!file) throw govNotFound('Arquivo não encontrado.');
    const before = scale.normalize(file.getDataValue('classification'));
    if (before !== value) {
      await file.update({ classification: value, updatedBy: req.auth.userId }, { transaction });
      await registrarAuditoria({
        groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, action: 'files.classification', entityType: 'File', entityId: file.id,
        beforeJson: { classification: before }, afterJson: { classification: value }, reason: `Classificação do arquivo "${file.fileName}" alterada de ${before} para ${value}.`,
      }, transaction);
    }
    return { fileId: file.id, classification: value, changed: before !== value };
  });
  return success(res, { data });
});

module.exports = { putClassification };
