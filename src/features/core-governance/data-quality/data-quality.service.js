'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Dados mestres e qualidade — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D804 a M9-D808, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'data-quality',
    rotulo: 'Dados mestres e qualidade',
    habilitado: await isModuleEnabled('data-quality', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
