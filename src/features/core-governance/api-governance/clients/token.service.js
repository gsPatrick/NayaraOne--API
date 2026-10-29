'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getSetting } = require('../../../settings/settings.service');
const { inTenantTx } = require('../consumers/tenantTx');
const E = require('./clients.errors');
const S = require('./clients.settings');
const repository = require('./clients.repository');
const { verifySecret } = require('./secret');
const { signClientToken, scopesOf } = require('./token');

/**
 * POST /api-external/oauth/token (M9-D844 §3.2): OAuth2 client credentials. Confere grant_type, client_id e segredo (bcrypt; credencial desconhecida gasta o mesmo tempo), recusa credencial
 * revogada (401 GOV_CLIENT_DISABLED) e concede a INTERSEÇÃO entre os scopes pedidos (separados por espaço) e os da credencial; sem `scope` na requisição vale tudo que a credencial tem.
 * Pedido que não deixa nenhum scope concedido é 400 GOV_INVALID_SCOPE. Devolve o corpo do RFC 6749 (`access_token`, `token_type`, `expires_in`, `scope`).
 */
async function issueToken(body = {}) {
  if (body.grant_type !== 'client_credentials') throw E.unsupportedGrant();
  const { client_id: clientId, client_secret: clientSecret } = body;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || !clientId || !clientSecret || clientId.length > 80 || clientSecret.length > 200) throw E.invalidClient();
  const client = await repository.findByClientId(clientId);
  if (!(await verifySecret(clientSecret, client && client.secretHash))) throw E.invalidClient();
  if (client.status !== 'ACTIVE') throw E.clientDisabled();
  const tenant = { groupId: client.groupId, companyId: client.companyId };
  const requested = body.scope === undefined ? null : scopesOf(String(body.scope));
  const granted = requested === null ? client.scopes : client.scopes.filter((scope) => requested.includes(scope));
  if (requested !== null && !granted.length) throw E.invalidScope({ requested, allowed: client.scopes });
  const ttl = await inTenantTx(tenant, async (transaction) => {
    const seconds = Number(await getSetting(S.TOKEN_TTL_KEY, tenant, transaction, S.CLIENTS_SETTING_DEFAULTS[S.TOKEN_TTL_KEY]));
    await registrarAuditoria({
      ...tenant, actorUserId: null, action: 'api.client.token_issued', entityType: 'ApiClient', entityId: client.id,
      beforeJson: null, afterJson: { clientId, scopes: granted }, reason: `Token emitido para a credencial ${client.name}.`,
    }, transaction);
    return seconds;
  });
  return { access_token: signClientToken({ clientId, ...tenant, scopes: granted }, ttl), token_type: 'Bearer', expires_in: ttl, scope: granted.join(' ') };
}

module.exports = { issueToken };
