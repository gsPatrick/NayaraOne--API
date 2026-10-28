'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Governança de API — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D840 a M9-D844, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'api-governance',
    rotulo: 'Governança de API',
    habilitado: await isModuleEnabled('api-governance', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
