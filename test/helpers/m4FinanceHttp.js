'use strict';

/**
 * Apoio aos testes HTTP do Financeiro (Marco 4) contra o app Express real.
 * O MFA recente é simulado por linhas de core.mfa_credentials + core.mfa_step_ups gravadas no
 * banco DESCARTÁVEL do teste — NUNCA pelo endpoint de MFA, nunca com token forjado de outra forma
 * que não a assinatura de teste já usada pelas baterias HTTP (signAccessToken).
 */
const { signAccessToken } = require('../../src/utils/jwt');
const { encryptSecret } = require('../../src/utils/mfaCrypto');
const { User, MfaCredential, MfaStepUp } = require('../../src/models');
const { withTenantTransaction, uniqueSuffix } = require('../testHelpers');

const FINANCE_ALL = [
  'finance:read', 'finance:create', 'finance:update', 'finance:settle', 'finance:approve',
  'finance:reconcile', 'finance:bankAccounts', 'finance:chartOfAccounts',
];

/**
 * createUser — usuário do teste no tenant. `mfa`: 'recent' (credencial + verificação válida),
 * 'enabled' (credencial sem verificação recente) ou 'none'.
 */
async function createUser(tenant, label, mfa = 'recent') {
  const user = await User.create({
    email: `m4-${label}-${uniqueSuffix()}@nayaraone.dev`, name: `M4 ${label}`, passwordHash: 'x', status: 'ACTIVE',
    mfaEnabled: mfa !== 'none', mfaMethod: mfa !== 'none' ? 'TOTP' : null,
  });
  if (mfa !== 'none') {
    await withTenantTransaction(tenant, async (t) => {
      const T = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });
      await MfaCredential.create(T({ userId: user.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }), { transaction: t });
      if (mfa === 'recent') {
        await MfaStepUp.create(T({ userId: user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60000) }), { transaction: t });
      }
    });
  }
  return user;
}

function tokenFor(tenant, userId, permissions = FINANCE_ALL) {
  return signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });
}

function client(baseUrl) {
  return async function http(method, path, token, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json, code: json && json.error ? json.error.code : null };
  };
}

module.exports = { createUser, tokenFor, client, FINANCE_ALL };
