'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv (M9-D229), usados quando a empresa não configurou. */
const PADROES = Object.freeze({ countryCode: '55', leadDeadlineHours: 24 });

async function readMessagingParams(tenant, transaction) {
  const [pais, prazo] = await Promise.all([
    getSetting('integration.messaging.country_code', tenant, transaction, PADROES.countryCode),
    getSetting('integration.messaging.inbound_lead_prazo_horas', tenant, transaction, PADROES.leadDeadlineHours),
  ]);
  return {
    countryCode: typeof pais === 'string' && /^[1-9]\d{0,2}$/.test(pais) ? pais : PADROES.countryCode,
    leadDeadlineHours: Number.isInteger(prazo) && prazo >= 1 ? prazo : PADROES.leadDeadlineHours,
  };
}

module.exports = { PADROES, readMessagingParams };
