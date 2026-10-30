'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrão do parametros.csv (M9-D222), usado quando a empresa não configurou. */
const PADROES = Object.freeze({ reportValidityDays: 30 });

async function readContractParams(tenant, transaction) {
  const dias = await getSetting('integration.contract.report_validity_days', tenant, transaction, PADROES.reportValidityDays);
  return { reportValidityDays: Number.isInteger(dias) && dias >= 1 ? dias : PADROES.reportValidityDays };
}

module.exports = { PADROES, readContractParams };
