'use strict';

const { govError } = require('../../../governance.errors');

/**
 * Adaptadores da importação (M9-D832 §3.1 item 5): um por `intended_action`, cada um chamando o MESMO serviço de negócio que a tela usa. Contrato de cada adaptador:
 *   execute({ tenant, actorUserId, operation, payload, transaction }) -> { commandRef, undo, comparisons }  (comparisons = lista de { field, label, paper, command, kind })
 *   reverse({ tenant, actorUserId, operation, effect, transaction })  -> estorno pelo serviço normal (ou recusa 422 se o serviço não tem estorno).
 */
const ADAPTERS = [
  require('./lead'), require('./visit'), require('./proposal'), require('./keyDelivery'), require('./receivePayment'), require('./emergencyPayment'),
  require('./dailyReport'), require('./materialRequest'), require('./registerDocument'), require('./caseProgress'), require('./deadline'),
];
const BY_ACTION = Object.freeze(Object.fromEntries(ADAPTERS.map((adapter) => [adapter.action, adapter])));

function adapterFor(action) {
  const adapter = BY_ACTION[action];
  if (!adapter) throw govError(422, 'GOV_BCP_ACTION_INVALID', 'Esta ação não existe para o setor.');
  return adapter;
}

module.exports = { adapterFor, ACTIONS: Object.keys(BY_ACTION) };
