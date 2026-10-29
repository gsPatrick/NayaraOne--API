'use strict';

/** Motivo de bloqueio -> código MKT_ e mensagem em português (um só dicionário para canSend, cooldown e condições). */
const BLOCK_REASONS = Object.freeze({
  SUPPRESSED: { code: 'MKT_SUPPRESSED', message: 'Esta pessoa pediu para não receber mensagens.' },
  OPT_OUT: { code: 'MKT_SUPPRESSED', message: 'Esta pessoa pediu para não receber mensagens.' },
  NO_ADDRESS: { code: 'MKT_NO_ADDRESS', message: 'A pessoa não tem endereço de contato utilizável neste canal.' },
  QUIET_HOURS: { code: 'MKT_QUIET_HOURS', message: 'Fora do horário permitido de contato.' },
  FREQUENCY_CAP: { code: 'MKT_FREQUENCY_CAP_EXCEEDED', message: 'Limite de mensagens atingido para esta pessoa.' },
  NO_CONSENT: { code: 'MKT_NO_CONSENT', message: 'Não há consentimento para esta finalidade.' },
  CHANNEL_POLICY: { code: 'MKT_CHANNEL_POLICY', message: 'O canal exige template oficial fora da janela de atendimento.' },
  COOLDOWN: { code: 'MKT_COOLDOWN_ACTIVE', message: 'A automação está em período de espera para esta pessoa.' },
  CONDITION_FALSE: { code: 'MKT_CONDITION_FALSE', message: 'As condições da automação não foram atendidas.' },
  CONDITION_ERROR: { code: 'MKT_CONDITION_ERROR', message: 'Não foi possível avaliar as condições.' },
});

/** Monta a decisão de bloqueio: { allowed:false, reason, code, message, nextEligibleAt }. */
function blocked(reason, extra = {}) {
  const info = BLOCK_REASONS[reason];
  return { allowed: false, reason, blocked_reason: reason, code: info.code, message: info.message, nextEligibleAt: extra.nextEligibleAt || null, ...extra };
}

module.exports = { BLOCK_REASONS, blocked };
