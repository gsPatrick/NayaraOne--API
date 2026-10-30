'use strict';

const { recordUsage, consolidateClosedHours } = require('../accrual.service');
const { readFinopsParams } = require('../finops.params');
const { divHalfEven } = require('../money');
const { PLATFORM_DOMAIN } = require('../finops.constants');

/**
 * Coletor de egress (M9-D860 §3.2): contador de bytes de download (exportações, arquivos, API externa) x preço por GB (`egress_gb` em
 * `governanca.finops.precos`; 1 GB = `governanca.finops.gb_base` ao cubo bytes). 5 GB a R$ 0,50 por GB = 250 centavos.
 */
async function recordEgress(tenant, { kind, bytes, domain = PLATFORM_DOMAIN, at = new Date() }, transaction) {
  const params = await readFinopsParams(tenant, transaction);
  const price = params.prices.egress_gb;
  const total = BigInt(bytes);
  if (price === undefined || total <= 0n) return { recorded: false, reason: total <= 0n ? 'NO_BYTES' : 'PRICE_UNKNOWN' };
  await recordUsage(tenant, {
    category: 'EGRESS', service: `egress:${kind}`, domain, quantity: total.toString(), unit: 'bytes', costScaled: divHalfEven(total * price, params.gbBase ** 3n), calls: 1, at,
  }, transaction);
  return { recorded: true };
}

const collectEgress = (tenant, now, transaction) => consolidateClosedHours(tenant, now, ['EGRESS'], transaction);

module.exports = { recordEgress, collectEgress };
