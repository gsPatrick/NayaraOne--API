'use strict';

/**
 * Parâmetros do registro de classificação (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). As listas de palavras são as do livro
 * (a regra casa PALAVRA INTEIRA do nome da coluna, dividido por `_`) e valem na classificação inicial automática; o steward ajusta cada coluna depois pelo PUT.
 */
const RESTRICTED_KEY = 'governanca.dados.classificacao.palavras_restritas';
const HIGH_KEY = 'governanca.dados.classificacao.palavras_altas';
const PAGE_KEY = 'governanca.dados.classificacao.pagina_tamanho';
const DEFAULT_RESTRICTED = 'cpf, cnpj, rg, passport, bank, account, pix, password, secret, token, mfa';
const DEFAULT_HIGH = 'email, phone, birth, address, salary, income, name';

const CLASSIFICATION_SETTING_DEFAULTS = Object.freeze({ [RESTRICTED_KEY]: DEFAULT_RESTRICTED, [HIGH_KEY]: DEFAULT_HIGH, [PAGE_KEY]: 50 });
const WORDS = /^[a-z][a-z0-9]*$/;

/** "CPF, rg" -> ['cpf','rg'] (minúsculas, sem vazios nem repetidos); vazio ou inválido volta ao padrão. */
function parseWords(text, fallback) {
  const list = [...new Set(String(typeof text === 'string' ? text : '').split(',').map((word) => word.trim().toLowerCase()).filter((word) => WORDS.test(word)))];
  return list.length ? list : fallback.split(',').map((word) => word.trim());
}

function validateWords(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(',').map((word) => word.trim()).filter(Boolean);
  if (!items.length || items.some((word) => !WORDS.test(word.toLowerCase()))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar palavras (letras e números, sem espaço) separadas por vírgula.`, { key, value });
  }
}

const CLASSIFICATION_SETTINGS_SCHEMA = {
  [RESTRICTED_KEY]: { type: 'string', validate: validateWords },
  [HIGH_KEY]: { type: 'string', validate: validateWords },
  [PAGE_KEY]: { type: 'integer', min: 1, max: 200 },
};

module.exports = { RESTRICTED_KEY, HIGH_KEY, PAGE_KEY, DEFAULT_RESTRICTED, DEFAULT_HIGH, CLASSIFICATION_SETTING_DEFAULTS, CLASSIFICATION_SETTINGS_SCHEMA, parseWords };
