'use strict';

const { readCircuitState } = require('../../../integrations');
const { activeAiConnections } = require('../providerConnections');

/**
 * O circuito do provedor está aberto para a empresa? (estado de M9-D206/D217, por conexão ativa.) Provedor sem conexão (sandbox) não tem
 * circuito. Falha ao ler o estado conta como aberto: na dúvida, não se troca para ele (falha fechada).
 */
async function circuitIsOpen(providerCode, tenant, transaction) {
  try {
    const found = (await activeAiConnections(tenant, transaction)).find((x) => x.connection.providerCode === providerCode);
    if (!found) return false;
    const circuit = await readCircuitState(found.connection.id, tenant, transaction);
    return circuit.circuitState === 'OPEN';
  } catch (err) {
    return true;
  }
}

module.exports = { circuitIsOpen };
