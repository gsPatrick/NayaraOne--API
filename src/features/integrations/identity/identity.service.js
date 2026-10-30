'use strict';

const adapterRegistry = require('../registry/adapterRegistry');
const { invoke } = require('../registry/adapterInvoke');
const { peekHeader } = require('../../../shared/identity/jwtStrict');
const { localIssuer } = require('../../../shared/identity/localClaims');
const { triggerContingency } = require('../providers/contingency.registry');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const jwt = require('jsonwebtoken');
const { fallbackDenied, tokenInvalid } = require('../providers/identity/identity.errors');
const { readIdentityParams } = require('./identity.params');
const { externalIdentityState } = require('./identity.state');

/** Garante os adapters de identidade no registro (o servidor os registra no boot; scripts e testes de serviço usam este atalho). */
function ensureIdentityRegistered() {
  const { IdentityLocalAdapter } = require('../providers/identity/identity-local.adapter');
  const { IdentitySandboxAdapter } = require('../providers/identity/sandbox/identity-sandbox.adapter');
  [IdentityLocalAdapter, IdentitySandboxAdapter].forEach((A) => { if (!adapterRegistry.has(new A(null).providerCode())) adapterRegistry.register(A); });
}

const isLocalToken = (token) => {
  try { const d = jwt.decode(String(token || '')); return Boolean(d) && d.iss === localIssuer(); } catch { return false; }
};

const localAdapter = () => { ensureIdentityRegistered(); const a = adapterRegistry.instantiate('identity-local'); a.ctx = Object.freeze({ connection: Object.freeze({ id: 'builtin:identity-local', providerCode: 'identity-local', config: {} }) }); return a; };

/**
 * Valida o token de acesso (M9-D242). Token do próprio sistema: sempre pelo `identity-local`. Token de outro emissor: pelo fornecedor externo da empresa (JWKS com cache, `iss`,
 * `aud`, `exp`, `nbf` obrigatórios, algoritmo em lista); sem fornecedor ativo ou com ele fora, a contingência da família IDENTITY é acionada e a validação falha (401).
 * Devolve { subject, claims, provider }.
 */
async function verifyToken(tenant, token, transaction) {
  ensureIdentityRegistered();
  const params = await readIdentityParams(tenant, transaction);
  const meta = { tenant, transaction, clockToleranceS: params.clockToleranceS, algorithms: params.algorithms, jwksCacheTtlS: params.jwksCacheTtlS };
  if (isLocalToken(token) || !peekHeader(token)) {
    const adapter = localAdapter();
    let bruta = null;
    await invoke(adapter, 'verifyToken', { token }, { meta, onResponse: (x) => { bruta = x; } });
    return { subject: bruta.subject, claims: bruta.claims, provider: 'identity-local' };
  }
  const estado = await externalIdentityState(tenant, transaction);
  if (!estado.configured || !estado.available) {
    if (estado.configured) await triggerContingency({ domain: 'IDENTITY', companyId: tenant.companyId, providerCode: null, reason: estado.reason }, transaction);
    throw tokenInvalid(estado.configured ? estado.reason : 'NO_IDENTITY_PROVIDER');
  }
  const connection = estado.connections[0];
  const adapter = await adapterRegistry.resolve(connection, tenant, transaction);
  let bruta = null;
  await invoke(adapter, 'verifyToken', { token }, { meta, onResponse: (x) => { bruta = x; } });
  return { subject: bruta.subject, claims: bruta.claims, provider: connection.providerCode };
}

/**
 * Regra de acesso local na contingência (M9-D242 3.2, INT-015): com o provedor externo fora (sem connection ativa, circuito aberto ou saúde DOWN), o login
 * local (identity-local) só segue para quem a política libera: `local_fallback_enabled` ligado e o usuário com papel administrador (`local_fallback_admin_enabled`).
 * Sem provedor externo configurado ou com ele de pé, o login local não muda. Aciona a contingência da família e registra o uso. 403 INTEGRATION_IDENTITY_FALLBACK_DENIED
 * quando a política não libera. `access`: { userId, roles }. Devolve { allowed, viaFallback, reason }.
 */
async function assertLocalLoginAllowed(tenant, access, transaction) {
  const estado = await externalIdentityState(tenant, transaction);
  if (!estado.configured || estado.available) return { allowed: true, viaFallback: false, reason: null };
  await triggerContingency({ domain: 'IDENTITY', companyId: tenant.companyId, providerCode: null, reason: estado.reason }, transaction);
  const params = await readIdentityParams(tenant, transaction);
  const admin = (access.roles || []).some((r) => params.adminRoles.includes(r));
  if (!(params.localFallbackEnabled && params.localFallbackAdminEnabled && admin)) throw fallbackDenied();
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: access.userId || null, action: 'integration.identity.local_fallback_used', entityType: 'User', entityId: access.userId || null,
    afterJson: { reason: estado.reason }, reason: 'Login local liberado a administrador porque o provedor de identidade está fora (contingência).',
  }, transaction);
  return { allowed: true, viaFallback: true, reason: estado.reason };
}

module.exports = { verifyToken, assertLocalLoginAllowed, ensureIdentityRegistered };
