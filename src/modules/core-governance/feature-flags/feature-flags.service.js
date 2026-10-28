'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Feature flags e configuração — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D870 a M9-D872, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'feature-flags',
    rotulo: 'Feature flags e configuração',
    habilitado: await isModuleEnabled('feature-flags', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
