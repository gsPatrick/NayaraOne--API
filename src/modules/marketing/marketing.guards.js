'use strict';

const { getSetting } = require('../../features/settings/settings.service');
const { MASS_WITHOUT_APPROVAL_KEY, MASS_ABSOLUTE_KEY, MARKETING_SETTING_DEFAULTS } = require('./marketing.settings');
const { mktMassPermissionRequired, mktMassLimitExceeded } = require('./marketing.errors');

const MASS_PERMISSION = 'marketing:send:mass';

/**
 * Mensagem em massa (Caderno §14: "Mass messaging exige permissão/limite"). Acima do teto absoluto: 422 MKT_MASS_LIMIT_EXCEEDED,
 * mesmo com permissão. Acima do limite sem aprovação: exige `marketing:send:mass` (a própria permissão é a confirmação explícita),
 * senão 403 MKT_MASS_PERMISSION_REQUIRED. Os dois tetos vêm da configuração da empresa (getSetting), nunca de valor fixo.
 * Este é o guarda reutilizado por quem agenda ou dispara (M9-D412, M9-D433, M9-D435).
 */
async function assertMassSendAllowed({ recipients, permissions, tenant, transaction }) {
  const count = Number(recipients);
  if (!Number.isInteger(count) || count < 0) {
    throw mktMassLimitExceeded({ recipients });
  }
  const withoutApproval = await getSetting(MASS_WITHOUT_APPROVAL_KEY, tenant, transaction, MARKETING_SETTING_DEFAULTS[MASS_WITHOUT_APPROVAL_KEY]);
  const absolute = await getSetting(MASS_ABSOLUTE_KEY, tenant, transaction, MARKETING_SETTING_DEFAULTS[MASS_ABSOLUTE_KEY]);
  if (count > absolute) throw mktMassLimitExceeded({ recipients: count, limit: absolute });
  if (count > withoutApproval && !(permissions || []).includes(MASS_PERMISSION)) {
    throw mktMassPermissionRequired({ recipients: count, limit: withoutApproval, required: MASS_PERMISSION });
  }
  return { recipients: count, limitWithoutApproval: withoutApproval, absoluteLimit: absolute, massConfirmed: count > withoutApproval };
}

/**
 * Kill switch (Caderno §8): a ATIVAÇÃO (`active:true`) não exige MFA, para não atrasar a resposta a um incidente; a REATIVAÇÃO
 * (qualquer outro valor, falha fechada) exige MFA step-up recente: 403 MFA_STEP_UP_REQUIRED (ou MFA_REQUIRED_NOT_ENABLED se a
 * pessoa nem tem MFA). Reutiliza o assertRecentMfa da plataforma; nunca chama endpoint de MFA.
 */
async function assertKillSwitchChangeAllowed({ active, userId, transaction }) {
  if (active === true) return { mfaRequired: false };
  // require tardio: mfa.service carrega os models (evita ciclo na carga do módulo).
  const { assertRecentMfa } = require('../../features/users/mfa.service');
  await assertRecentMfa(userId, transaction);
  return { mfaRequired: true };
}

module.exports = { MASS_PERMISSION, assertMassSendAllowed, assertKillSwitchChangeAllowed };
