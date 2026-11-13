'use strict';

/**
 * Parâmetros das ações do operador (M9-D250), dicionário fail-closed do SETTINGS_SCHEMA. A leitura com os padrões está em actions.params.js.
 * `integration.admin.mfa_on_prod_test_connection` já existe no dicionário da M9-D200 e passa a ser lido aqui.
 */
const ACTIONS_SETTINGS_SCHEMA = Object.freeze({
  // Tempo máximo do teste de conexão (livro: 10 s); passou disso o teste responde ok:false.
  'integration.admin.test_connection_timeout_ms': { type: 'integer', min: 1000, max: 120000 },
  // Tentativas a mais que o retry humano concede a um envio da fila morta (livro: +3) e a um evento de webhook.
  'integration.retry.human_extra_attempts': { type: 'integer', min: 1, max: 20 },
  // Exigir MFA recente para girar a credencial de uma connection em qualquer ambiente (em produção a regra de mudar conexão em produção já vale).
  // parametros.csv exige_mfa_para_alterar = sim: desligar esta exigência só com MFA recente de quem altera (settings/settingMfa.js).
  'integration.admin.mfa_on_secret_rotation': { type: 'boolean', requiresMfa: true },
});

module.exports = { ACTIONS_SETTINGS_SCHEMA };
