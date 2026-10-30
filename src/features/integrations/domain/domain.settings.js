'use strict';

/** Parâmetros da integridade do domínio (M9-D220): só o dicionário de SETTINGS_SCHEMA; a leitura está em domain.params.js. */
const DOMAIN_SETTINGS_SCHEMA = Object.freeze({
  // INT-P014: tempo máximo (ms) que uma ação do usuário espera o fornecedor na própria requisição; passou disso, a ação responde "aceito" e o resto acompanha por status (livro: 5000).
  'integration.sync_call_timeout_ms': { type: 'integer', min: 100, max: 120000 },
});

module.exports = { DOMAIN_SETTINGS_SCHEMA };
