'use strict';

/**
 * Gancho de contingência por família (Marco 9, M9-D201, regra 3). Quando uma família não tem connection ACTIVE
 * para a empresa, `resolveConnection` responde 404 `INTEGRATION_CONNECTION_NOT_FOUND` e aciona o modo de
 * contingência da família, se existir. As demandas donas registram o seu modo: D226 (banco), D227 (assinatura),
 * D228 (financiamento), D242 (identidade) e as demais da seção 18 do livro. Família sem modo registrado só
 * recebe o 404. Um defeito no modo de contingência nunca vira erro 500 (roda em savepoint e é registrado em log).
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');

const handlers = new Map();

/** `handler({ domain, companyId, providerCode }, transaction)`; um único modo por família (o último registrado vale). */
function registerContingencyHandler(domain, handler) {
  if (typeof handler !== 'function') throw new TypeError('O modo de contingência precisa ser uma função.');
  handlers.set(String(domain), handler);
}

function clearContingencyHandlers() {
  handlers.clear();
}

function hasContingencyHandler(domain) {
  return handlers.has(String(domain));
}

async function triggerContingency(info, transaction) {
  const handler = handlers.get(String(info.domain));
  if (!handler) return false;
  try {
    await sequelize.transaction({ transaction }, (savepoint) => handler(info, savepoint));
    return true;
  } catch (err) {
    logger.error({ err, domain: info.domain, companyId: info.companyId }, 'Falha ao acionar a contingência da integração (o 404 segue)');
    return false;
  }
}

module.exports = { registerContingencyHandler, clearContingencyHandlers, hasContingencyHandler, triggerContingency };
