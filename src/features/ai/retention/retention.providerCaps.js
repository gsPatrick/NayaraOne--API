'use strict';

const { listAiConnectionRetentions } = require('../readmodels/retentionSupport.readmodel');

/** Dias que cada valor de data_retention da conexão impõe. NONE e PROVIDER_DEFAULT não limitam: vale o prazo por classificação (DI-D028-2). */
const CAP_DAYS = Object.freeze({ '30D': 30 });

/**
 * Retenção contratada por provider de IA da empresa: integration.connections.config_json.data_retention (M9-D011). Com várias
 * conexões do mesmo provider vale a mais restritiva. Devolve { [provider_code]: dias } só para os providers que limitam.
 */
async function providerRetentionCaps(transaction) {
  const rows = await listAiConnectionRetentions(transaction);
  const caps = {};
  for (const row of rows) {
    const dias = CAP_DAYS[row.retention];
    if (dias !== undefined && (caps[row.provider_code] === undefined || dias < caps[row.provider_code])) caps[row.provider_code] = dias;
  }
  return caps;
}

module.exports = { providerRetentionCaps, CAP_DAYS };
