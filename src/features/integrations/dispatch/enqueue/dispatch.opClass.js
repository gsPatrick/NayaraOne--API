'use strict';

const AppError = require('../../../../utils/AppError');
const { CRITICALITY_OPS } = require('../dispatch.constants');

/**
 * opClass efetivo (M9-D214 3.1 item 6): o padrão é o do port; o chamador pode ELEVAR (SAFE -> DANGEROUS), nunca rebaixar.
 * Pedido de rebaixamento é recusado em vez de ignorado em silêncio, para o erro de quem chama aparecer.
 */
function resolveOpClass(portDefault, requested) {
  if (requested === undefined || requested === null) return portDefault;
  if (!CRITICALITY_OPS.includes(requested)) {
    throw AppError.unprocessable(`Classe de risco inválida. Use: ${CRITICALITY_OPS.join(', ')}.`, 'INTEGRATION_DISPATCH_INVALID');
  }
  if (portDefault === 'DANGEROUS' && requested === 'SAFE') {
    throw AppError.unprocessable('A classe de risco de uma operação perigosa não pode ser reduzida.', 'INTEGRATION_OPCLASS_DOWNGRADE_FORBIDDEN');
  }
  return requested;
}

module.exports = { resolveOpClass };
