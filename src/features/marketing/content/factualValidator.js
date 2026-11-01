'use strict';

const { Doc } = require('./factual/text');
const { checkArea } = require('./factual/area');
const { checkPrice } = require('./factual/price');
const { checkCounts } = require('./factual/counts');
const { checkAddress } = require('./factual/address');
const { checkFeatures } = require('./factual/features');
const { checkUnknown } = require('./factual/unknown');
const { checkInjection } = require('./factual/injection');
const { FACTUAL_SETTING_DEFAULTS, TOLERANCE_KEY, DICTIONARY_KEY, parseDictionary, DEFAULT_DICTIONARY, parseTerms, DEFAULT_LEGAL_REFS } = require('./factual/settings');

/**
 * M9-D407 — validateAgainstFacts(text, facts, options) -> { ok, findings[] }. Determinístico e sem IA: extrai do texto preço, área,
 * quantidades, endereço, características e números soltos e confere cada um com o PublicPropertyReadModel (`facts`). Dado citado que
 * o cadastro não tem, ou que diverge dele, é BLOCK. Cada extrator consome o trecho que explicou; o que sobra com número é
 * UNKNOWN_CLAIM. Os textos do cadastro são DADO: ordem escrita neles vira INJECTION_SUSPECT e nunca é obedecida.
 * options (vêm dos parâmetros da empresa, lidos por readFactualConfig; na falta valem os padrões do catálogo de parâmetros):
 * { toleranciaAreaM2, featureGroups: Map(característica -> termos), telefonesEmpresa: ['7133334444'], referenciasLegais: ['decreto', 'lei'], contentDate: Date|{day,month,year} }.
 */
function resolveOptions(options) {
  const given = options && typeof options === 'object' ? options : {};
  return {
    toleranciaAreaM2: Number.isFinite(given.toleranciaAreaM2) ? given.toleranciaAreaM2 : FACTUAL_SETTING_DEFAULTS[TOLERANCE_KEY],
    featureGroups: given.featureGroups instanceof Map ? given.featureGroups : parseDictionary(FACTUAL_SETTING_DEFAULTS[DICTIONARY_KEY] || DEFAULT_DICTIONARY),
    telefonesEmpresa: Array.isArray(given.telefonesEmpresa) ? given.telefonesEmpresa : [],
    referenciasLegais: Array.isArray(given.referenciasLegais) ? given.referenciasLegais : parseTerms(DEFAULT_LEGAL_REFS),
    contentDate: given.contentDate || null,
  };
}

function validateAgainstFacts(text, facts, options) {
  const safeFacts = facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {};
  const opts = resolveOptions(options);
  const doc = new Doc(typeof text === 'string' ? text : '');
  const findings = [
    ...checkArea(doc, safeFacts, opts),
    ...checkPrice(doc, safeFacts),
    ...checkCounts(doc, safeFacts),
    ...checkAddress(doc, safeFacts),
    ...checkFeatures(doc, safeFacts, opts),
    ...checkUnknown(doc, safeFacts, opts),
    ...checkInjection(safeFacts),
  ];
  return { ok: findings.length === 0, findings };
}

module.exports = { validateAgainstFacts, resolveOptions };
