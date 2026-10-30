'use strict';

const { getSetting } = require('../../settings/settings.service');
const { CODE_RE } = require('./registry.constants');
const { DRILL_SCENARIOS } = require('./release.constants');

/** Padrões do portão: os do livro (derrubar, 429, 401, timeout) e o fluxo manual como único fornecedor sem conta externa. */
const PADROES = Object.freeze({
  requireRotationSchedule: true,
  drillScenarios: Object.freeze(['provider-down', 'rate-limit', 'auth-failed', 'timeout']),
  noExternalAccountProviders: Object.freeze(['insurance-manual', 'financing-manual']),
});

const lista = (texto, valido, padrao) => {
  const itens = typeof texto === 'string' ? [...new Set(texto.split(',').map((x) => x.trim()))] : [];
  return itens.length && itens.every(valido) ? itens : [...padrao];
};

async function readReleaseParams(ctx, transaction) {
  const [rotacao, cenarios, semConta] = await Promise.all([
    getSetting('integration.release.require_rotation_schedule', ctx, transaction, PADROES.requireRotationSchedule),
    getSetting('integration.release.drill_scenarios', ctx, transaction, PADROES.drillScenarios.join(',')),
    getSetting('integration.release.no_external_account_providers', ctx, transaction, PADROES.noExternalAccountProviders.join(',')),
  ]);
  return {
    requireRotationSchedule: rotacao !== false,
    drillScenarios: lista(cenarios, (x) => DRILL_SCENARIOS.includes(x), PADROES.drillScenarios),
    noExternalAccountProviders: lista(semConta, (x) => CODE_RE.test(x), PADROES.noExternalAccountProviders),
  };
}

module.exports = { PADROES, readReleaseParams };
