'use strict';

/**
 * M9-D612 (BI-001) — parâmetros do administrador para a garantia de somente leitura do BI (aba "BI e Centro de Comando" em
 * /painel/configuracoes). Mesmo padrão do projeto: dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) +
 * getSetting(chave, tenant, transaction, padrão). Arquivo sem dependências para não criar ciclo com settings.service.
 *
 * A transação READ ONLY dos GET de /analytics NÃO é configurável: é a garantia do livro (BI-001). O que o administrador
 * controla é a segunda camada, o role de banco sem privilégio de escrita.
 */
const READER_ROLE_NAME = 'nayara_analytics_reader';
const READER_ROLE_SETTING_KEY = 'analytics.leitura.role_somente_leitura';

const READ_ONLY_SETTING_DEFAULTS = Object.freeze({
  // Ligado: quando o ambiente tem o role (migration 9612), os GET de BI rodam com ele; sem o role, a guarda se desliga sozinha.
  [READER_ROLE_SETTING_KEY]: true,
});

const READ_ONLY_SETTINGS_SCHEMA = {
  [READER_ROLE_SETTING_KEY]: { type: 'boolean' },
};

module.exports = { READER_ROLE_NAME, READER_ROLE_SETTING_KEY, READ_ONLY_SETTING_DEFAULTS, READ_ONLY_SETTINGS_SCHEMA };
