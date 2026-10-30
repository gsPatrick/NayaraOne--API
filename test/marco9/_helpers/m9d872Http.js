'use strict';

// Apoio HTTP dos testes M9-D872 (não é teste): API real em banco descartável com o mesmo login da M9-D870 e o MFA recente do gestor concedido direto no banco
// (nunca por endpoint de MFA). Perfis: A:gestor (gestão de flags), A:leitura (sem nada de governança) e B:gestor.
const http = require('./m9d870Http');

const stepUp = (tenant) => http.adminQuery(`INSERT INTO core.mfa_step_ups (id, user_id, group_id, company_id, verified_at, expires_at, created_at, updated_at)
  VALUES (gen_random_uuid(), $1, $2, $3, now(), now() + interval '10 minutes', now(), now())`, [tenant.userId, tenant.groupId, tenant.companyId]);
const revokeMfa = (tenant) => http.adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [tenant.userId]);
/** MFA habilitado e verificado há pouco, gravado direto no banco DESCARTÁVEL (mesmo expediente da M9-D852; nunca por endpoint de MFA). */
async function enableMfaWithoutStepUp(tenant) {
  await http.adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [tenant.userId]);
  await http.adminQuery(`INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, failed_attempts, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'teste-m9d872', true, now(), '{}', 0, now(), now())`, [tenant.userId, tenant.groupId, tenant.companyId]);
  await revokeMfa(tenant);
}
async function grantMfa(tenant) { await enableMfaWithoutStepUp(tenant); await stepUp(tenant); }
const dropMfa = async (tenant) => { await revokeMfa(tenant); await http.adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [tenant.userId]); };

module.exports = { ...http, grantMfa, enableMfaWithoutStepUp, revokeMfa, dropMfa };
