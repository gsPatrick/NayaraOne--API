'use strict';

const { PORTS } = require('../providers/ports');
const { resolveMaxClassification } = require('../minimization/minimization.params');

const slugOf = (publicCode) => String(publicCode).toLowerCase();

/** O pedido que o adapter do portal recebe: o read model público passado pelo mapper de saída da operação (M9-D219), a mesma allowlist e o mesmo teto de classificação do envio gravado. */
async function minimizedListing(readModel, ctx, transaction, operation = 'publishListing') {
  const mapper = PORTS.PORTAL.operations[operation].outputMapper;
  const maxClassification = await resolveMaxClassification('PORTAL', ctx, transaction);
  return mapper.run({ ...readModel, slug: slugOf(readModel.public_code) }, { domain: 'PORTAL', maxClassification, consentedFields: [] }).payload;
}

module.exports = { minimizedListing };
