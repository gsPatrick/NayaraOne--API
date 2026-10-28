'use strict';

/**
 * Parâmetros do Marketing que o administrador configura em /painel/configuracoes (aba Marketing). Mesmo padrão do projeto:
 * dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de MARKETING_SETTINGS_SCHEMA) + getSetting(chave,
 * tenant, transaction, padrão). O padrão é o valor inicial de Maturacao/demandas/parametros.csv. Cada demanda do bloco C
 * acrescenta as suas chaves neste arquivo, somente as que algum código realmente lê.
 */
const MASS_WITHOUT_APPROVAL_KEY = 'marketing.mass.max_recipients_sem_aprovacao';
const MASS_ABSOLUTE_KEY = 'marketing.mass.max_recipients_absoluto';
const AUTO_UPDATE_ON_SOURCE_CHANGE_KEY = 'marketing.conteudo.atualizacao_automatica_fonte';
const PROFILES_ASSISTANT_KEY = 'marketing.permissoes.perfis_assistente';
const PROFILES_MANAGER_KEY = 'marketing.permissoes.perfis_gerente';
const PROFILES_DIRECTOR_KEY = 'marketing.permissoes.perfis_diretoria';

const MARKETING_SETTING_DEFAULTS = Object.freeze({
  [MASS_WITHOUT_APPROVAL_KEY]: 50,
  [MASS_ABSOLUTE_KEY]: 5000,
  [AUTO_UPDATE_ON_SOURCE_CHANGE_KEY]: true,
  [PROFILES_ASSISTANT_KEY]: 'ASSISTENTE DE MARKETING',
  [PROFILES_MANAGER_KEY]: 'GERENTE DE MARKETING',
  [PROFILES_DIRECTOR_KEY]: 'DIRETORIA',
});

const MARKETING_SETTINGS_SCHEMA = {
  [MASS_WITHOUT_APPROVAL_KEY]: { type: 'integer', min: 1, max: 100000 },
  [MASS_ABSOLUTE_KEY]: { type: 'integer', min: 1, max: 1000000 },
  [AUTO_UPDATE_ON_SOURCE_CHANGE_KEY]: { type: 'boolean' },
  [PROFILES_ASSISTANT_KEY]: { type: 'string' },
  [PROFILES_MANAGER_KEY]: { type: 'string' },
  [PROFILES_DIRECTOR_KEY]: { type: 'string' },
};

/** "A, b" -> ['A','B'] (maiúsculas, sem vazios); texto vazio ou inválido volta ao padrão. */
function parseNameList(text, fallback) {
  const source = typeof text === 'string' && text.trim() ? text : fallback;
  return String(source).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
}

module.exports = {
  MASS_WITHOUT_APPROVAL_KEY,
  MASS_ABSOLUTE_KEY,
  AUTO_UPDATE_ON_SOURCE_CHANGE_KEY,
  PROFILES_ASSISTANT_KEY,
  PROFILES_MANAGER_KEY,
  PROFILES_DIRECTOR_KEY,
  MARKETING_SETTING_DEFAULTS,
  MARKETING_SETTINGS_SCHEMA,
  parseNameList,
};
