'use strict';

const { resolveTools } = require('./reconcile.service');
const { runStrategies } = require('./reconcile.lookup');

/**
 * probeProvider — a consulta da reconciliação (M9-D215) feita SEM mudar o envio, para o retry humano da M9-D250: pergunta ao fornecedor, pelas
 * mesmas três estratégias do motor, se a operação já existe. Devolve { verdict: FOUND | NOT_FOUND | INCONCLUSIVE, found, trail }. Connection parada, sem adapter ou
 * operação sem estratégia de consulta é INCONCLUSIVE (quem decide é a pessoa que confirmou com MFA). A linha precisa estar travada por quem chama.
 */
async function probeProvider(ctx, row, transaction) {
  const tools = await resolveTools(ctx, row, transaction);
  if (tools.failure) return { verdict: 'INCONCLUSIVE', found: null, trail: [{ strategy: 'ALL', outcome: 'ERROR', code: tools.failure }] };
  return runStrategies({ ctx, dispatch: row, adapter: tools.adapter, port: tools.port, statusDef: tools.statusDef, transaction });
}

module.exports = { probeProvider };
