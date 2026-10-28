'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Continuidade operacional (BCP) — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D830 a M9-D834, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'bcp',
    rotulo: 'Continuidade operacional (BCP)',
    habilitado: await isModuleEnabled('bcp', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
