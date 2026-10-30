'use strict';

const { DEFINITIONS, SOURCE_ENTITY_OF_LOADER } = require('./definitions');
const { typeInvalid, requiredField, channelNotAllowed, sourceNotEligible } = require('./errors');
const { reductionPercent, currentPriceOf } = require('./priceReduction');
const { readMinPhotos } = require('./types.settings');
const { readPropertyStatus } = require('./queries');
const { hasPostSaleConsent } = require('./consent');
const { contentInvalid } = require('../pipeline.errors');

/** Definição do tipo; tipo inexistente: 400 MKT_CONTENT_TYPE_INVALID. */
function getDefinition(type) {
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(DEFINITIONS, type)) {
    throw typeInvalid({ type: type === undefined ? null : String(type).slice(0, 60), allowed: Object.keys(DEFINITIONS) });
  }
  return DEFINITIONS[type];
}

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
const anyFilled = (source, rule) => rule.split('|').some((name) => !isBlank(source[name]));

/** Campos mínimos que faltam: { input: [...], facts: [...] } (cada regra "a|b" aparece inteira). */
function missingFields(def, input, facts, minPhotos) {
  const missing = { input: def.requiredFields.input.filter((rule) => !anyFilled(input, rule)), facts: def.requiredFields.facts.filter((rule) => !anyFilled(facts, rule)) };
  if (def.requiredFields.facts.includes('fotosAutorizadas') && !missing.facts.includes('fotosAutorizadas')
      && (facts.fotosAutorizadas || []).length < minPhotos) missing.facts.push('fotosAutorizadas');
  return missing;
}

function assertChannelsAllowed(def, channels) {
  const list = (Array.isArray(channels) ? channels : []).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  const notAllowed = [...new Set(list.filter((c) => !def.allowedChannels.includes(c)))];
  if (notAllowed.length > 0) throw channelNotAllowed({ type: def.type, channels: notAllowed, allowed: def.allowedChannels });
}

/** Regras próprias de cada tipo sobre a fonte (queda de preço, imóvel ativo). */
async function assertSourceEligible(def, input, facts, { tenant, transaction, decimals }) {
  if (def.type === 'PRICE_REDUCTION') {
    const result = reductionPercent(facts.precoAnterior, currentPriceOf(facts), decimals);
    if (!result.isReduction) throw sourceNotEligible({ type: def.type, reason: 'NOT_A_REDUCTION', precoAnterior: facts.precoAnterior, preco: currentPriceOf(facts) });
  }
  if (def.type === 'POST_SALE' && !(await hasPostSaleConsent(input.sourceEntityId, tenant, transaction))) {
    throw sourceNotEligible({ type: def.type, reason: 'NO_CONSENT' }); // pós-venda só com consentimento
  }
  if (def.type === 'NEW_PROPERTY') {
    const status = await readPropertyStatus(input.sourceEntityId, tenant, transaction);
    if (!status || status.publication !== 'PUBLISHED' || status.availability !== 'AVAILABLE') {
      throw sourceNotEligible({ type: def.type, reason: 'PROPERTY_NOT_ACTIVE', publication: status ? status.publication : null, availability: status ? status.availability : null });
    }
  }
}

/**
 * Confere a criação de um conteúdo do tipo: fonte do tipo certo (ou nenhuma, nos humanos), campos mínimos (422
 * MKT_CONTENT_REQUIRED_FIELD), regras da fonte (422 MKT_CONTENT_SOURCE_NOT_ELIGIBLE) e canais pretendidos (422
 * MKT_CONTENT_CHANNEL_NOT_ALLOWED). `facts` = fatos já projetados para o tipo.
 */
async function assertCreatable(def, input, facts, { tenant, transaction, decimals }) {
  const expected = SOURCE_ENTITY_OF_LOADER[def.sourceLoader];
  if (expected === null && input.sourceEntityType) throw contentInvalid('Este tipo de conteúdo não usa fonte de dados.', { type: def.type });
  const minPhotos = await readMinPhotos(tenant, transaction);
  const missing = missingFields(def, input, facts, minPhotos);
  if (expected && input.sourceEntityType !== expected) missing.input.unshift('sourceEntityType');
  if (missing.input.length > 0 || missing.facts.length > 0) throw requiredField({ type: def.type, missing, minPhotos: missing.facts.includes('fotosAutorizadas') ? minPhotos : undefined });
  await assertSourceEligible(def, input, facts, { tenant, transaction, decimals });
  if (input.channels !== undefined) assertChannelsAllowed(def, input.channels);
}

module.exports = { getDefinition, assertCreatable, assertChannelsAllowed, missingFields };
