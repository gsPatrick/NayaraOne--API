'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv (M9-D229), usados quando a empresa não configurou. */
const PADROES = Object.freeze({ countryCode: '55', leadDeadlineHours: 24, recordBodyMaxChars: 65536 });
/** Teto do texto do registro manual (DI-M9R-16). */
const RECORD_BODY_TETO = 1048576;

async function readMessagingParams(tenant, transaction) {
  const [pais, prazo, registro] = await Promise.all([
    getSetting('integration.messaging.country_code', tenant, transaction, PADROES.countryCode),
    getSetting('integration.messaging.inbound_lead_prazo_horas', tenant, transaction, PADROES.leadDeadlineHours),
    getSetting('integration.messaging.record_body_max_chars', tenant, transaction, PADROES.recordBodyMaxChars),
  ]);
  return {
    countryCode: typeof pais === 'string' && /^[1-9]\d{0,2}$/.test(pais) ? pais : PADROES.countryCode,
    leadDeadlineHours: Number.isInteger(prazo) && prazo >= 1 ? prazo : PADROES.leadDeadlineHours,
    recordBodyMaxChars: Number.isInteger(registro) && registro >= 1 && registro <= RECORD_BODY_TETO ? registro : PADROES.recordBodyMaxChars,
  };
}

module.exports = { PADROES, RECORD_BODY_TETO, readMessagingParams };
