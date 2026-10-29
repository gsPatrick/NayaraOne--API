'use strict';

const { CLASSES } = require('./dlp.constants');
const { govError } = require('../governance.errors');

/**
 * Parâmetros da aplicação de VIEW e COPY (M9-D825; catálogo em Maturacao/demandas/parametros.csv; aba Governança em /painel/configuracoes).
 *  - governanca.dlp.view.campos: o registro de campos sensíveis por tipo de recurso, "tipo: campo CLASSE, campo CLASSE; outro.tipo: ...". É a fonte até o registro
 *    de classificação (M9-D910) assumir pelo encaixe `view.fields.js#setFieldSource`; campo novo entra aqui (ou no registro) sem mudar código.
 *  - governanca.dlp.view.mascara_ultimos: quantos caracteres finais o valor mascarado ainda mostra (0 = máscara total; padrão 4, o `****1234` do livro).
 *  - governanca.dlp.view.auditoria_janela_min: a auditoria `dlp.view` é de uma linha por recurso e por janela (padrão 1 minuto).
 */
const FIELDS_KEY = 'governanca.dlp.view.campos';
const MASK_TAIL_KEY = 'governanca.dlp.view.mascara_ultimos';
const AUDIT_WINDOW_KEY = 'governanca.dlp.view.auditoria_janela_min';

const VIEW_SETTING_DEFAULTS = Object.freeze({
  [FIELDS_KEY]: [
    'people.person: taxIdNormalized RESTRICTED, extractedDataJson RESTRICTED, birthOrFoundationDate HIGH, valueNormalized HIGH, zipCode HIGH, street HIGH',
    'properties.property: registryNumber HIGH, registryOffice HIGH',
    'finance.bank_account: accountNumber RESTRICTED, pixKey RESTRICTED, agency HIGH',
    'legal.contract: totalValue HIGH',
    'files.file: storageKey HIGH',
  ].join('; '),
  [MASK_TAIL_KEY]: 4,
  [AUDIT_WINDOW_KEY]: 1,
});

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z0-9_.-]{0,79}$/;

/** "tipo: campo CLASSE, campo CLASSE; tipo2: ..." -> { tipo: { campo: 'CLASSE' } }; null se algum item estiver fora do formato. */
function parseFields(text) {
  const out = {};
  for (const block of String(text).split(';').map((b) => b.trim()).filter(Boolean)) {
    const at = block.indexOf(':');
    if (at < 1) return null;
    const type = block.slice(0, at).trim();
    if (!TYPE_NAME.test(type)) return null;
    out[type] = out[type] || {};
    for (const item of block.slice(at + 1).split(',').map((i) => i.trim()).filter(Boolean)) {
      const match = /^(\S+)\s+([A-Za-z]+)$/.exec(item);
      if (!match || !FIELD_NAME.test(match[1]) || !CLASSES.includes(match[2].toUpperCase())) return null;
      out[type][match[1]] = match[2].toUpperCase();
    }
  }
  return out;
}

function validateFields(key, value) {
  if (!parseFields(value)) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve seguir o formato "tipo: campo CLASSE, campo CLASSE; outro.tipo: campo CLASSE" (classes LOW, MEDIUM, HIGH ou RESTRICTED).`, { key, value });
  }
}

const VIEW_SETTINGS_SCHEMA = {
  [FIELDS_KEY]: { type: 'string', validate: validateFields },
  [MASK_TAIL_KEY]: { type: 'integer', min: 0, max: 8 },
  [AUDIT_WINDOW_KEY]: { type: 'integer', min: 1, max: 1440 },
};

/** Registro pronto; valor inválido cai no padrão do catálogo. */
const fieldsOf = (text) => parseFields(typeof text === 'string' ? text : '') || parseFields(VIEW_SETTING_DEFAULTS[FIELDS_KEY]);
const maskTailOf = (value) => (Number.isInteger(value) && value >= 0 && value <= 8 ? value : VIEW_SETTING_DEFAULTS[MASK_TAIL_KEY]);
const auditWindowOf = (value) => (Number.isInteger(value) && value >= 1 ? value : VIEW_SETTING_DEFAULTS[AUDIT_WINDOW_KEY]);

module.exports = {
  FIELDS_KEY, MASK_TAIL_KEY, AUDIT_WINDOW_KEY, VIEW_SETTING_DEFAULTS, VIEW_SETTINGS_SCHEMA, parseFields, fieldsOf, maskTailOf, auditWindowOf,
};
