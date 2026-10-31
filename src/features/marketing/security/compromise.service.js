'use strict';

const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const integrations = require('../../integrations');
const { ports } = require('./compromise.ports');

const AUDIT_ACTION = 'marketing.channel.compromised';

/**
 * M9-D433 — conta social comprometida (Caderno §14: "revoke token + kill switch"). O bloqueio do canal (kill switch CHANNEL, origem COMPROMISED_ACCOUNT) já foi gravado pela
 * M9-D425; este tratador, chamado na mesma transação, faz o resto da sequência: (1) revoga o token no adapter do canal; (2) marca COMPROMISED as conexões vivas da família do
 * canal no framework de Integrações. Reautorizar exige nova credencial no cofre e a liberação do canal (M9-D430). A falha em revogar NÃO desfaz o bloqueio nem a marca da conexão:
 * o resultado volta com `handled: false` e o motivo, e quem chamou mantém o canal travado. Marcar de novo devolve o mesmo estado (conexão já COMPROMISED não é tocada).
 */
async function handleCompromised({ tenant, channel, reason, actorUserId, transaction }) {
  const family = ports().familyOf(channel);
  let revoked = false;
  let error = null;
  try {
    const adapter = await ports().resolveChannelAdapter(channel, { tenant, transaction, mode: 'AUTO' });
    const out = await adapter.revoke({ channel });
    revoked = Boolean(out && out.revoked === true);
    if (!revoked) error = 'MKT_REVOKE_NOT_CONFIRMED';
  } catch (err) {
    error = (err && err.code) || 'MKT_REVOKE_FAILED';
    logger.error({ err: err && err.message, channel }, 'marketing.channel.compromised.revoke_failed');
  }
  const connections = await integrations.compromiseDomainConnections({
    companyId: tenant.companyId, groupId: tenant.groupId, userId: actorUserId || null, domain: family, reason, transaction,
  });
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actorUserId || null, action: AUDIT_ACTION, entityType: 'marketing.channel', entityId: null,
    beforeJson: { channel, tokenRevoked: false, connections: connections.map((c) => ({ id: c.id, status: c.from })) },
    afterJson: { channel, tokenRevoked: revoked, error, connections: connections.map((c) => ({ id: c.id, status: 'COMPROMISED' })), killSwitch: 'CHANNEL' },
    reason,
  }, transaction);
  return { handled: revoked, revoked, ...(error ? { error } : {}), connections: connections.map((c) => c.id), connectionStatus: connections.length ? 'COMPROMISED' : null, killSwitch: { scope: 'CHANNEL', channel, active: true } };
}

module.exports = { handleCompromised, AUDIT_ACTION };
