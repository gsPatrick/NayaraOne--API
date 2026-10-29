'use strict';

const { Op } = require('sequelize');
const { AuditLog } = require('../../../models');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { getSetting } = require('../../settings/settings.service');
const settings = require('./view.settings');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_ID = '-';

/**
 * Auditoria `dlp.view` (M9-D825 §3.1 item 2): UMA linha por recurso, classe e janela (`governanca.dlp.view.auditoria_janela_min`, padrão 1 minuto) para o mesmo usuário
 * e a mesma decisão; nunca grava o valor, só o recurso, a classe e a decisão. VIEW liberado grava `governance.dlp.view`; VIEW negado (valor devolvido mascarado)
 * grava `governance.dlp.view.blocked`. Devolve quantas linhas gravou. `transaction` já traz o contexto da empresa (RLS).
 */
async function recordView(tenant, req, result, transaction) {
  const action = result.decision === 'DENY' ? 'governance.dlp.view.blocked' : 'governance.dlp.view';
  const ids = [...new Set((Array.isArray(req.resourceIds) && req.resourceIds.length ? req.resourceIds : [NO_ID]).map(String))];
  const windowMinutes = settings.auditWindowOf(await getSetting(settings.AUDIT_WINDOW_KEY, tenant, transaction, settings.VIEW_SETTING_DEFAULTS[settings.AUDIT_WINDOW_KEY]));
  const now = new Date();
  const since = new Date(now.getTime() - windowMinutes * 60 * 1000);
  const recent = await AuditLog.findAll({
    where: { companyId: tenant.companyId, userId: req.actorUserId, action, entityType: req.resourceType, occurredAt: { [Op.gt]: since } }, attributes: ['afterJson'], transaction,
  });
  const seen = new Set(recent.filter((row) => row.afterJson && row.afterJson.classification === result.classification).map((row) => row.afterJson.resourceId));
  const fresh = ids.filter((id) => !seen.has(id));
  if (!fresh.length) return 0;
  const reason = result.decision === 'DENY' ? 'Valor sensível devolvido mascarado pelo DLP.' : 'Visualização de dado sensível registrada pelo DLP.';
  await AuditLog.bulkCreate(fresh.map((id) => ({
    groupId: tenant.groupId, companyId: tenant.companyId, userId: req.actorUserId, action, entityType: req.resourceType, entityId: UUID.test(id) ? id : null, beforeJson: null,
    afterJson: { resourceId: id, classification: result.classification, decision: result.decision, blockReason: result.blockReason }, reason, ipAddress: req.ip || null,
    correlationId: getCurrentCorrelationId(), occurredAt: now, createdBy: req.actorUserId, updatedBy: req.actorUserId,
  })), { transaction });
  return fresh.length;
}

module.exports = { recordView };
