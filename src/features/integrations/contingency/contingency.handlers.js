'use strict';

const { IntegrationConnection } = require('../../../models');
const { registerContingencyHandler } = require('../providers/contingency.registry');
const { FAMILY_DEFAULT_MODE } = require('./contingency.constants');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const { activateContingency, ctxFromCompany } = require('./contingency.activate');

/** Famílias que o framework liga ao gancho de M9-D201/D217. A IA (DEGRADE_TO_DETERMINISTIC) já tem o gancho dela (M9-D243) e a prova é da M9-D228. */
const FAMILIES_WITH_HANDLER = Object.freeze(Object.keys(FAMILY_DEFAULT_MODE).filter((d) => d !== 'AI'));

/**
 * Gancho de contingência da família: chamado por `triggerContingency` quando o circuito abre (informa a connection) ou quando a família não tem
 * connection ativa (404 INTEGRATION_CONNECTION_NOT_FOUND, sem connection). Ativa a contingência (idempotente) no escopo certo.
 */
function handlerFor(domain) {
  return async (info, transaction) => {
    const ctx = await ctxFromCompany(info.companyId, transaction);
    if (!ctx) return;
    if (info.connectionId) {
      const connection = await IntegrationConnection.findOne({ where: { id: info.connectionId, companyId: ctx.companyId }, transaction });
      if (connection) { await activateContingency(ctx, { connection }, [info.reason || 'CIRCUIT_OPEN'], transaction); return; }
    }
    // Família sem connection ativa: o pedido que bateu no 404 desfaz a própria transação, e a contingência não pode ir junto. Por isso ela é gravada em transação PRÓPRIA.
    await tenantTx(ctx, (independente) => activateContingency(ctx, { domain, providerCode: info.providerCode }, [info.reason || 'NO_ACTIVE_CONNECTION'], independente));
  };
}

function registerFamilyHandlers() {
  FAMILIES_WITH_HANDLER.forEach((domain) => registerContingencyHandler(domain, handlerFor(domain)));
  return FAMILIES_WITH_HANDLER;
}

module.exports = { registerFamilyHandlers, handlerFor, FAMILIES_WITH_HANDLER };
