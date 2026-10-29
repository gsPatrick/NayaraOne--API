'use strict';

const AppError = require('../../../../utils/AppError');
const { LIMITES, parseRoles } = require('./alerts.limits');

/**
 * Parâmetros dos alertas das integrações (M9-D224). Dicionário fail-closed de SETTINGS_SCHEMA; a leitura com os padrões está em
 * alerts.params.js. `notify_roles` é a lista de papéis (nomes de perfil) que recebem os avisos, separados por vírgula.
 */
const rolesSpec = {
  type: 'string',
  validate: (key, value) => {
    if (!parseRoles(value)) {
      throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a ${LIMITES.roles.max} nomes de papel separados por vírgula (cada um com ${LIMITES.roles.nameMin} a ${LIMITES.roles.nameMax} letras, números, espaço, _ ou -).`, 'SETTING_INVALID_VALUE', { key, value });
    }
  },
};

const ALERT_SETTINGS_SCHEMA = Object.freeze({
  // INT-P049: minutos antes de o mesmo alerta ser avisado de novo enquanto a condição continua.
  'integration.alert.repeat_min': { type: 'integer', min: LIMITES.repeatMin.min, max: LIMITES.repeatMin.max },
  // Papéis que recebem os avisos de integração (padrão: o administrador da empresa).
  'integration.alert.notify_roles': rolesSpec,
  // Minutos com o disjuntor aberto até a indisponibilidade virar alerta (livro: "circuito OPEN > 5 min").
  'integration.alert.circuit_open_min': { type: 'integer', min: LIMITES.circuitOpenMin.min, max: LIMITES.circuitOpenMin.max },
  // De quantos em quantos segundos as condições de alerta são avaliadas.
  'integration.alert.evaluate_interval_s': { type: 'integer', min: LIMITES.evaluateIntervalS.min, max: LIMITES.evaluateIntervalS.max },
});

module.exports = { ALERT_SETTINGS_SCHEMA };
