'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * FinOps — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D860 a M9-D863, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'finops',
    rotulo: 'FinOps',
    habilitado: await isModuleEnabled('finops', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
