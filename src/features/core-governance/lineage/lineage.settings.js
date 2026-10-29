'use strict';

/**
 * Parâmetros do lineage (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - governanca.lineage.kpis_criticos: KPIs executivos que a visão de cobertura da API cobra de lineage. `*` (padrão, o livro: "KPIs executivos") = todos os KPIs
 *    críticos da tabela de criticidade do BI; ou uma lista de códigos separados por vírgula. Estreitar só afeta a visão da API: o portão de CI cobra sempre todos.
 *  - governanca.lineage.dominios_adicionais: domínios responsáveis aceitos nos nós além dos de dados mestres (`governanca.dados.dominios`, M9-D804); padrão
 *    TECNOLOGIA, porque filas, integrações e a NAY não têm domínio de dados mestres.
 */
const CRITICAL_KPIS_KEY = 'governanca.lineage.kpis_criticos';
const EXTRA_DOMAINS_KEY = 'governanca.lineage.dominios_adicionais';
const LINEAGE_SETTING_DEFAULTS = Object.freeze({ [CRITICAL_KPIS_KEY]: '*', [EXTRA_DOMAINS_KEY]: 'TECNOLOGIA' });

const CODE_LIST = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
function validateCodeList(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!items.length || items.some((v) => !(v === '*' || CODE_LIST.test(v)))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser * ou uma lista de códigos separados por vírgula.`, { key, value });
  }
}
const LINEAGE_SETTINGS_SCHEMA = {
  [CRITICAL_KPIS_KEY]: { type: 'string', validate: validateCodeList },
  [EXTRA_DOMAINS_KEY]: { type: 'string', validate: validateCodeList },
};

/** "*" -> null (todos); "a, b" -> ['a','b']. */
function parseCriticalKpis(text) {
  const list = String(typeof text === 'string' ? text : '*').split(',').map((v) => v.trim()).filter(Boolean);
  return !list.length || list.includes('*') ? null : list;
}
const parseExtraDomains = (text) => [...new Set(String(typeof text === 'string' ? text : '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean))];

module.exports = { CRITICAL_KPIS_KEY, EXTRA_DOMAINS_KEY, LINEAGE_SETTING_DEFAULTS, LINEAGE_SETTINGS_SCHEMA, parseCriticalKpis, parseExtraDomains };
