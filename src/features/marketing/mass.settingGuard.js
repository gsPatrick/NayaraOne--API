'use strict';

/**
 * M9-D402 — trava de gravação dos dois limites de mensagem em massa: o teto absoluto de destinatários nunca fica abaixo do
 * limite sem aprovação (senão o disparo "liberado" já nasceria acima do teto). A comparação lê a OUTRA chave da mesma empresa
 * (getSetting, com o padrão do catálogo quando ainda não configurada). Vale para qualquer caminho que grave a chave.
 * Carregada pelo settings.service; getSetting é resolvido na hora do uso (settings.service importa este arquivo).
 */
const AppError = require('../../utils/AppError');
const { registerSettingGuard } = require('../settings/settingGuards');
const { MASS_WITHOUT_APPROVAL_KEY, MASS_ABSOLUTE_KEY, MARKETING_SETTING_DEFAULTS } = require('./marketing.settings');

const CODE = 'MKT_MASS_LIMITS_INCONSISTENT';

async function readOther(key, tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const raw = await getSetting(key, tenant, transaction, MARKETING_SETTING_DEFAULTS[key]);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : MARKETING_SETTING_DEFAULTS[key];
}

registerSettingGuard(MASS_ABSOLUTE_KEY, async (value, tenant, _actorUserId, transaction) => {
  const withoutApproval = await readOther(MASS_WITHOUT_APPROVAL_KEY, tenant, transaction);
  if (value < withoutApproval) {
    throw AppError.unprocessable(`O teto absoluto de destinatários não pode ser menor que o limite sem aprovação (${withoutApproval}).`, CODE, { key: MASS_ABSOLUTE_KEY, value, limiteSemAprovacao: withoutApproval });
  }
});

registerSettingGuard(MASS_WITHOUT_APPROVAL_KEY, async (value, tenant, _actorUserId, transaction) => {
  const absolute = await readOther(MASS_ABSOLUTE_KEY, tenant, transaction);
  if (value > absolute) {
    throw AppError.unprocessable(`O limite sem aprovação não pode ser maior que o teto absoluto de destinatários (${absolute}).`, CODE, { key: MASS_WITHOUT_APPROVAL_KEY, value, tetoAbsoluto: absolute });
  }
});
