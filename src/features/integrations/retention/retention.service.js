'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { readRetentionPayload, AREAS } = require('./retention.params');

const AUDIT_ACTION = 'integration.retention.purge';
const ENTITY_TYPE = 'integration.purge_expired';

/**
 * Expurgo e redação por retenção da empresa da sessão (M9-D244): o ÚNICO caminho. Lê os prazos dos parâmetros, chama
 * integration.purge_expired() (SECURITY DEFINER; o runtime não tem DELETE nas tabelas) e grava a auditoria da execução com as
 * contagens por tabela, na mesma transação. `areas` limita a execução (health, errors, inbox, dispatch); sem ela roda tudo.
 * Devolve as contagens: { provider_health, integration_errors, webhook_inbox: {...}, dispatches: {...} }.
 */
async function purgeExpired(ctx, transaction, { areas = AREAS } = {}) {
  const payload = await readRetentionPayload(ctx, transaction, areas);
  const [[{ r }]] = await sequelize.query('SELECT "integration".purge_expired(CAST(:p AS jsonb)) AS r', { replacements: { p: JSON.stringify(payload) }, transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: AUDIT_ACTION, entityType: ENTITY_TYPE, entityId: null,
    beforeJson: { prazos: payload }, afterJson: { contagens: r }, reason: 'Expurgo por retenção das tabelas de integração (integration.purge_expired).',
  }, transaction);
  return r;
}

module.exports = { purgeExpired, AUDIT_ACTION, ENTITY_TYPE };
