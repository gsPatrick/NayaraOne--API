'use strict';

const { isModuleEnabled } = require('../governance.module');

/**
 * Calendário unificado — serviço do módulo. O alicerce (M9-D800) entrega o esqueleto: o estado do módulo para a empresa. As regras de
 * negócio entram nas demandas M9-D801, M9-D802 e M9-D803, sobre este mesmo arquivo.
 */
async function getOverview(tenant, transaction) {
  return {
    modulo: 'calendar',
    rotulo: 'Calendário unificado',
    habilitado: await isModuleEnabled('calendar', tenant, transaction),
    fase: 'alicerce',
    itens: [],
  };
}

module.exports = { getOverview };
