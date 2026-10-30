'use strict';

// Apoio dos testes (não é teste): obtém o impacto de uma ação destrutiva e monta o corpo `confirmation` como a tela (ConfirmAction) faria:
// "Entendi o impacto" marcado, o código do registro digitado, a justificativa e o impactToken da simulação.
const assert = require('node:assert/strict');
const { adminQuery } = require('../../m9d801.helpers');

const DEFAULT_JUSTIFICATION = 'QA-M9 confirmação de teste da ação destrutiva.';

/** { confirmation } para a ação cujo impacto está em `impactPath` (GET) ou `impactPath` + `impactBody` (POST). */
async function confirmationFor(http, who, impactPath, { method = 'GET', body, justification = DEFAULT_JUSTIFICATION, headers } = {}) {
  const res = await http.call(who, method, impactPath, body, headers);
  assert.equal(res.status, 200, `impacto ${impactPath}: ${JSON.stringify(res.body)}`);
  const d = res.body.data;
  return {
    confirmation: { understood: true, impactToken: d.impactToken, ...(d.level >= 3 ? { typedCode: d.record.code, justification } : {}) },
    impact: d,
  };
}

/** Corpo da ação com a confirmação pronta (o corpo da ação vem em `body`). */
async function withConfirmation(http, who, impactPath, body = {}, opts = {}) {
  const { confirmation } = await confirmationFor(http, who, impactPath, opts);
  return { ...body, confirmation };
}

/**
 * MFA habilitado e verificado há pouco para o usuário do tenant, gravado direto no banco DESCARTÁVEL (nunca por endpoint de MFA, nunca token forjado): o mesmo
 * expediente dos testes da M9-D822/D823/D843. Só serve a rotas que exigem MFA recente.
 */
async function grantRecentMfa(tenant, userId = tenant.userId) {
  await adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [userId]);
  await adminQuery(`INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, failed_attempts, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'teste-m9d852', true, now(), '{}', 0, now(), now())`, [userId, tenant.groupId, tenant.companyId]);
  await adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]);
  await adminQuery(`INSERT INTO core.mfa_step_ups (id, user_id, group_id, company_id, verified_at, expires_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, now(), now() + interval '10 minutes', now(), now())`, [userId, tenant.groupId, tenant.companyId]);
}

const revokeRecentMfa = async (userId) => { await adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]); };

module.exports = { confirmationFor, withConfirmation, grantRecentMfa, revokeRecentMfa, DEFAULT_JUSTIFICATION };
