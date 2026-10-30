'use strict';

// Dados de partida de feature flags para o contract test (M9-D842, não é teste): o probe de kill switch que o exemplo cita ao criar a chave. Banco descartável.
const { registerProbe } = require('../../../src/features/core-governance/feature-flags/kill-switch/probes/registry');

const PROBE = 'qa.m9d842.contrato_probe';
const run = async () => ({ pass: true, evidence: { origem: 'contract test' } });

/** Registra (uma vez) o probe do contrato e entrega o nome dele às variáveis dos exemplos seguintes. */
async function killSwitchProbe() {
  registerProbe({ name: PROBE, version: '1', description: 'Probe do contract test da M9-D842.', run });
  return { killSwitchProbe: PROBE };
}

module.exports = { killSwitchProbe };
