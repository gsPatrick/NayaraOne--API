'use strict';

const { getSetting } = require('../../settings/settings.service');
const { IntegrationProvider } = require('../../../models');
/* Leitura da política do circuito (M9-D217): parâmetros da empresa, política do fornecedor e da connection. */
const { PADROES, RECHECK, CHAVES, mergeCircuitPolicy, valido } = require('./circuitPolicy');

/** Política da empresa (parâmetros `integration.circuit.*`); fora do limite volta ao padrão do livro. */
async function readCircuitParams(ctx, transaction) {
  const campos = Object.keys(PADROES);
  const valores = await Promise.all([
    ...campos.map((c) => getSetting(CHAVES[c], ctx, transaction, PADROES[c])),
    getSetting(RECHECK.key, ctx, transaction, RECHECK.padrao),
  ]);
  const recheck = valores[campos.length];
  return {
    global: Object.fromEntries(campos.map((c, i) => [c, valido(c, valores[i]) ? valores[i] : PADROES[c]])),
    recheckS: Number.isInteger(recheck) && recheck >= RECHECK.min && recheck <= RECHECK.max ? recheck : RECHECK.padrao,
  };
}

/** Política efetiva da connection: { ...failure_threshold, cooldown_s, half_open_max_calls, close_after_successes, recheck_s }. */
async function resolveCircuitPolicy(ctx, connection, transaction) {
  const [params, provider] = await Promise.all([
    readCircuitParams(ctx, transaction),
    IntegrationProvider.findByPk(connection.providerCode, { attributes: ['code', 'defaultPolicyJson'], transaction }),
  ]);
  const camada = mergeCircuitPolicy({
    global: params.global,
    provider: provider && provider.defaultPolicyJson && provider.defaultPolicyJson.circuit,
    connection: connection.policyJson && connection.policyJson.circuit,
  });
  return { ...camada, recheck_s: params.recheckS };
}

module.exports = { readCircuitParams, resolveCircuitPolicy };
