'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Linhagem de dados — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D810 e M9-D811, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'lineage',
    rotulo: 'Linhagem de dados',
    habilitado: await isModuleEnabled('lineage', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
