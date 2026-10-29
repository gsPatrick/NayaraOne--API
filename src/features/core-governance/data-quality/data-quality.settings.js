'use strict';

/**
 * Parâmetros de dados mestres do bloco de governança (aba Governança em /painel/configuracoes). Padrão = valor inicial do catálogo
 * (Maturacao/demandas/parametros.csv). `governanca.dados.dominios` (P9-EF-005): lista dos domínios de dados da empresa.
 */
const DOMAINS_KEY = 'governanca.dados.dominios';
const DEFAULT_DOMAINS = 'PESSOAS,IMOVEIS,FORNECEDORES,CRM,FINANCEIRO,CONTRATOS,COMISSOES,OBRAS,ESTOQUE,CORRESPONDENTE,FISCAL';
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

const DATA_QUALITY_SETTING_DEFAULTS = Object.freeze({ [DOMAINS_KEY]: DEFAULT_DOMAINS });

/** "A, b" -> ['A','B'] (maiúsculas, sem vazios nem repetidos); código fora do formato é ignorado; vazio volta ao padrão. */
function parseDomains(text) {
  const list = [...new Set(String(typeof text === 'string' ? text : '').split(',').map((v) => v.trim().toUpperCase()).filter((v) => CODE.test(v)))];
  return list.length ? list : DEFAULT_DOMAINS.split(',');
}

function validateDomains(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!items.length || items.some((v) => !CODE.test(v.toUpperCase()))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar domínios separados por vírgula (letras, números e _; até 40 caracteres, começando por letra).`, { key, value });
  }
}

const DATA_QUALITY_SETTINGS_SCHEMA = { [DOMAINS_KEY]: { type: 'string', validate: validateDomains } };

module.exports = { DOMAINS_KEY, DEFAULT_DOMAINS, DATA_QUALITY_SETTING_DEFAULTS, DATA_QUALITY_SETTINGS_SCHEMA, parseDomains };
