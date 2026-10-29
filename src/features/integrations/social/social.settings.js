'use strict';

/** Parâmetros das redes sociais (M9-D239): só o dicionário de SETTINGS_SCHEMA; a leitura está em social.params.js. */
const SOCIAL_SETTINGS_SCHEMA = Object.freeze({
  // INT-P086: dias para trás em que o motor procura, na lista de posts recentes da conta, um post igual ao que deu timeout (texto/hash).
  'integration.social.post_dedup_window_days': { type: 'integer', min: 1, max: 90 },
  // INT-P087: política do tenant para publicação automática (sem uma pessoa mandando publicar). Desligada por padrão; ligada, ainda exige
  // aprovação específica do conteúdo ou regra pré-aprovada auditada, e o kill switch do Marketing sobrepõe tudo.
  'integration.social.auto_publish_enabled': { type: 'boolean' },
});

module.exports = { SOCIAL_SETTINGS_SCHEMA };
