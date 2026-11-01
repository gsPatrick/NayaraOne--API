'use strict';

const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const logger = require('../../utils/logger');

/**
 * Tentativa negada de gravar chave protegida (M9-D870, reabertura R4-L3): a recusa (403) desfaz a transação da requisição, então a linha de `audit.audit_log` é gravada numa
 * transação própria, depois da recusa. Nunca lança: falhar em auditar não muda a resposta 403.
 */
const ACTION = 'governance.setting.write_denied';
const ENTITY = 'core.tenant_setting';

/** `key`: a chave do dicionário; `via`: o caminho (PUT /settings, PATCH /feature-flags...). Quem chama só passa chave protegida; toda recusa 403 (permissão da rota, camada de escrita, plataforma ou dono) é auditada. */
async function auditDeniedSettingWrite(req, { key, via, err }) {
  try {
    if (!err || err.statusCode !== 403 || !key || !req.auth || !req.withTenantTransaction) return;
    const details = err.details || {};
    await req.withTenantTransaction((transaction) => registrarAuditoria({
      groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, action: ACTION, entityType: ENTITY, entityId: null,
      beforeJson: null, afterJson: { key, via, code: err.code, required: details.required || null }, reason: 'Tentativa negada de alterar parâmetro protegido.',
    }, transaction));
  } catch (error) {
    logger.warn({ err: error, key }, 'Falha ao auditar tentativa negada em chave protegida.');
  }
}

module.exports = { auditDeniedSettingWrite, ACTION, ENTITY };
