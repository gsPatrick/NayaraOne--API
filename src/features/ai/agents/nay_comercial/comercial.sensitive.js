'use strict';

// Livro do Marco 3 §12: "Não inferir atributo sensível do cliente" (dado pessoal sensível da LGPD, art. 5º, II). Guarda da SAÍDA da NAY
// Comercial: toda frase que fala de uma das categorias sensíveis sai da resposta (e, portanto, de qualquer recomendação ou rascunho montado
// a partir dela), no caminho de regra e no de modelo. O termo removido nunca é repetido: a resposta só diz que um trecho saiu e por quê.
// As palavras de cada categoria são parâmetros da empresa (comercial.sensitive.settings.js). Nada é gravado sobre o cliente: a NAY
// Comercial não tem tool de escrita no cadastro de pessoas.
const { getSetting } = require('../../../settings/settings.service');
const { splitSentences } = require('../../orchestrator/grounding/sentences');
const { semAcento } = require('../../orchestrator/numbers/decimalText');
const { termsOf } = require('../scope/scope.evaluate');
const { SENSITIVE_LABELS, SENSITIVE_SETTING_DEFAULTS, CATEGORY_KEYS } = require('./comercial.sensitive.settings');

const NOTICE = 'Removi um trecho que tratava de dado pessoal sensível do cliente: a NAY não infere nem registra esse tipo de informação (LGPD, art. 5º, II).';

const norm = (t) => semAcento(String(t || '')).replace(/\s+/g, ' ').trim();
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hits = (text, term) => new RegExp(`(?:^|[^a-z0-9])${escape(term)}`).test(text);

/** { categoria: [termos] } da empresa (valor inválido ou vazio volta ao padrão). */
async function readSensitiveTerms(tenant, transaction) {
  const out = {};
  for (const [category, key] of CATEGORY_KEYS) out[category] = termsOf(await getSetting(key, tenant, transaction, SENSITIVE_SETTING_DEFAULTS[key]), SENSITIVE_SETTING_DEFAULTS[key]);
  return out;
}

/** Categorias sensíveis de que o texto fala (vazio = nenhuma). */
function sensitiveCategoriesOf(text, terms) {
  const t = norm(text);
  return Object.entries(terms).filter(([, list]) => list.some((term) => hits(t, term))).map(([category]) => category);
}

/**
 * Remove as frases com atributo sensível. Devolve { text, removed: [{ category, label }], changed }. Com remoção, o aviso entra no fim
 * (uma vez). Função pura sobre o texto e os termos.
 */
function stripSensitive(text, terms, { notice = true } = {}) {
  const source = String(text || '');
  const kept = [];
  const removed = [];
  for (const sentence of splitSentences(source)) {
    const categories = sensitiveCategoriesOf(sentence, terms);
    if (categories.length) categories.forEach((category) => removed.push({ category, label: SENSITIVE_LABELS[category] }));
    else kept.push(sentence);
  }
  if (!removed.length) return { text: source, removed, changed: false };
  const body = kept.join(/\n/.test(source) ? '\n' : ' ');
  return { text: notice ? [body, NOTICE].filter(Boolean).join(/\n/.test(source) ? '\n' : ' ') : body, removed, changed: true };
}

/** Categorias distintas (para a explicação estruturada). */
const distinctCategories = (removed) => [...new Map(removed.map((r) => [r.category, r])).values()];

module.exports = { readSensitiveTerms, sensitiveCategoriesOf, stripSensitive, distinctCategories, NOTICE };
