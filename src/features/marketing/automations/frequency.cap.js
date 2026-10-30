'use strict';

const { CAP_PARAM_KEYS, readLeadInt } = require('./leadParams');

/** O cap da versão referencia parâmetros da empresa (`maxParam`, `windowDaysParam`)? */
const hasParamRefs = (cap) => Boolean(cap) && typeof cap === 'object' && (cap.maxParam !== undefined || cap.windowDaysParam !== undefined);

/**
 * Cap da versão com os valores do parâmetro lidos na hora da avaliação (M9-D420: o limite de nutrição tem fonte única, o parâmetro; a versão publicada guarda só o nome dele
 * e nunca uma cópia do número). Cap com números fixos volta como veio. Nome fora da lista fechada vira cap sem valor (o cap global segue valendo).
 */
async function resolveVersionCap(cap, tenant, transaction) {
  if (!hasParamRefs(cap)) return cap;
  const read = (key) => (CAP_PARAM_KEYS.includes(key) ? readLeadInt(key, tenant, transaction) : null);
  return { ...cap, max: cap.maxParam === undefined ? cap.max : await read(cap.maxParam), windowDays: cap.windowDaysParam === undefined ? cap.windowDays : await read(cap.windowDaysParam) };
}

module.exports = { resolveVersionCap, hasParamRefs };
