'use strict';

/**
 * Parâmetros sensíveis com MFA recente para alterar (Maturacao/demandas/parametros.csv, coluna exige_mfa_para_alterar = "sim"): a entrada do SETTINGS_SCHEMA
 * leva `requiresMfa: true` no arquivo dono da chave, e a gravação só acontece com a verificação MFA recente de quem altera. A regra vive na camada de escrita
 * (upsertSetting), então vale para todo caminho: PUT /settings, PATCH /feature-flags com gravação nos parâmetros, importação, seeds e scripts.
 * Usa o mesmo mecanismo do resto da API (mfa.service.assertRecentMfa): 403 MFA_STEP_UP_REQUIRED sem verificação recente e 403 MFA_REQUIRED_NOT_ENABLED para
 * quem não tem MFA. Falha fechada: gravação sem pessoa identificada (sem actorUserId) é recusada com 403 MFA_STEP_UP_REQUIRED, porque não há de quem conferir.
 */
const AppError = require('../../utils/AppError');

const requiresMfa = (spec) => Boolean(spec && spec.requiresMfa === true);

async function assertMfaForSettingWrite(key, spec, actorUserId, transaction) {
  if (!requiresMfa(spec)) return;
  if (!actorUserId) {
    throw AppError.forbidden('Este parâmetro exige verificação MFA recente de quem altera; a gravação sem pessoa identificada é recusada.', 'MFA_STEP_UP_REQUIRED', { key });
  }
  const { assertRecentMfa } = require('../users/mfa.service'); // tardio: o serviço de MFA lê o próprio TTL pelo serviço de parâmetros
  await assertRecentMfa(actorUserId, transaction);
}

module.exports = { requiresMfa, assertMfaForSettingWrite };
