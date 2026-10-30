'use strict';

const { getMarketingParam } = require('../cadence/marketingParam.service');
const { FREQUENCY_CAP_KEY } = require('../cadence/cadence.defaults');

const CAP_SCOPE = 'PERSON_CHANNEL_PURPOSE';

/**
 * Cap da versão das automações prontas (M9-D440, "não hard-code cadência"): o MESMO número do cap global da empresa (parâmetro marketing.frequency_cap.global) no momento da instalação.
 * O global continua valendo à parte na hora de cada envio (o menor dos dois bloqueia), então quem muda o parâmetro depois muda o efeito sem deploy e a versão publicada não carrega número do código.
 */
async function seedFrequencyCap(tenant, transaction) {
  const global = await getMarketingParam(FREQUENCY_CAP_KEY, tenant, transaction);
  return { max: global.messages, windowDays: global.days, scope: CAP_SCOPE };
}

module.exports = { seedFrequencyCap, CAP_SCOPE };
