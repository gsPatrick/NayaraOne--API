'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Proteção contra vazamento (DLP) — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D820 a M9-D825, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'dlp',
    rotulo: 'Proteção contra vazamento (DLP)',
    habilitado: await isModuleEnabled('dlp', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
